/**
 * Bridge — Relay (Cowork response → agent inbox)
 *
 * Tails the OneDrive `completed/` dir for new BridgeResponseMetadata files.
 * For each new file: signs + writes a lightweight notification message into
 * the requesting agent's standard inbox dir. cortextOS's fast-checker poll
 * loop then delivers the message to the agent's PTY in <2s.
 *
 * The full response body STAYS in OneDrive completed/<id>.json (audit
 * trail). The inbox notification carries:
 *   - the original request_id
 *   - the status (success / partial / failed)
 *   - a one-line description
 *   - the OneDrive path to the full body
 *
 * Idempotency: relay state tracked in <ctxRoot>/state/atlas/bridge-relay-state.json.
 * Each tick reads the state, finds completed/ files not yet relayed (by id),
 * relays them, updates state. Safe to run on any cadence; missed ticks just
 * catch up on the next run.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { sendMessage } from '../bus/message.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import type { BusPaths, Priority } from '../types/index.js';
import type { BridgePaths, BridgeRequest, BridgeResponseMetadata } from './types.js';

const RELAY_STATE_FILENAME = 'bridge-relay-state.json';
const RELAY_STATE_VERSION = 1;

interface RelayState {
  version: number;
  relayed_ids: string[];
  last_tick_at: string;
}

function loadRelayState(stateDir: string): RelayState {
  const path = join(stateDir, RELAY_STATE_FILENAME);
  if (!existsSync(path)) {
    return { version: RELAY_STATE_VERSION, relayed_ids: [], last_tick_at: '' };
  }
  try {
    const parsed: RelayState = JSON.parse(readFileSync(path, 'utf-8'));
    if (parsed.version !== RELAY_STATE_VERSION) {
      return { version: RELAY_STATE_VERSION, relayed_ids: [], last_tick_at: '' };
    }
    return parsed;
  } catch {
    return { version: RELAY_STATE_VERSION, relayed_ids: [], last_tick_at: '' };
  }
}

function saveRelayState(stateDir: string, state: RelayState): void {
  ensureDir(stateDir);
  atomicWriteSync(join(stateDir, RELAY_STATE_FILENAME), JSON.stringify(state, null, 2));
}

/**
 * Reads a completed/<id>.json file as a wrapped { request, response } object.
 * Cowork-side format per atlas's protocol spec:
 *   {
 *     "request": <original BridgeRequest body>,
 *     "response": <BridgeResponseMetadata + result-type-specific payload>
 *   }
 * Returns null on parse / shape error — caller skips the file (janitor will
 * surface persistent shape errors later).
 */
interface CompletedFile {
  request: BridgeRequest;
  response: BridgeResponseMetadata & { result?: unknown };
}

function parseCompletedFile(path: string): CompletedFile | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (!parsed.request?.id || !parsed.response?.request_id) return null;
    if (parsed.request.id !== parsed.response.request_id) return null;
    return parsed as CompletedFile;
  } catch {
    return null;
  }
}

function buildNotificationText(file: CompletedFile, oneDrivePath: string): string {
  // Wire format: ```bridge-meta\n<json>\n``` followed by human-readable body.
  // Agents that know the format parse the block; agents that don't see it as
  // a normal multi-line message.
  const meta = {
    request_id: file.response.request_id,
    status: file.response.status,
    cowork_session_id: file.response.cowork_session_id,
    completed_at: file.response.completed_at,
    full_result_path: oneDrivePath,
    ...(file.response.error ? { error: file.response.error } : {}),
    ...(file.response.retryable !== undefined ? { retryable: file.response.retryable } : {}),
  };
  const metaBlock = '```bridge-meta\n' + JSON.stringify(meta, null, 2) + '\n```';
  const summary = file.response.status === 'success'
    ? `Bridge request "${file.request.description}" completed successfully. Full result at: ${oneDrivePath}`
    : `Bridge request "${file.request.description}" returned status=${file.response.status}` +
      (file.response.error ? ` — ${file.response.error}` : '') +
      ` (full payload: ${oneDrivePath})`;
  return `${metaBlock}\n\n${summary}`;
}

/**
 * Priority mapping: success → normal, partial → normal, failed → high
 * (failure should surface faster than success since it likely needs action).
 */
function priorityFor(status: BridgeResponseMetadata['status']): Priority {
  return status === 'failed' ? 'high' : 'normal';
}

export interface RelayTickResult {
  scanned: number;
  relayed: number;
  skipped_malformed: number;
  skipped_already_relayed: number;
  failures: Array<{ id: string; reason: string }>;
}

/**
 * One relay tick. Idempotent: re-running sees previously-relayed ids in
 * state and skips them.
 *
 * @param bridgePaths resolved bridge paths (default: OneDrive cowork-tasks/)
 * @param busPaths cortextOS bus paths (needed for sendMessage signing key + inbox dir)
 * @param stateDir directory where relay-state.json lives (typically <ctxRoot>/state/atlas/)
 */
export function relayTick(
  bridgePaths: BridgePaths,
  busPaths: BusPaths,
  stateDir: string,
): RelayTickResult {
  const result: RelayTickResult = {
    scanned: 0,
    relayed: 0,
    skipped_malformed: 0,
    skipped_already_relayed: 0,
    failures: [],
  };

  if (!existsSync(bridgePaths.processed)) {
    // OneDrive completed/ dir doesn't exist yet — Cowork hasn't run, nothing to relay.
    return result;
  }

  const state = loadRelayState(stateDir);
  const seen = new Set(state.relayed_ids);

  let entries: string[];
  try {
    entries = readdirSync(bridgePaths.processed).filter(f => f.endsWith('.json') && !f.startsWith('.'));
  } catch {
    return result;
  }

  for (const file of entries) {
    result.scanned++;
    const fullPath = join(bridgePaths.processed, file);

    let stat;
    try {
      stat = statSync(fullPath);
      if (!stat.isFile()) continue;
    } catch {
      continue;
    }

    const parsed = parseCompletedFile(fullPath);
    if (!parsed) {
      result.skipped_malformed++;
      continue;
    }

    if (seen.has(parsed.request.id)) {
      result.skipped_already_relayed++;
      continue;
    }

    // Only relay agent_inbox-destined responses (V1 supports only this type).
    if (parsed.request.result_destination.type !== 'agent_inbox') {
      result.failures.push({
        id: parsed.request.id,
        reason: `Unsupported result_destination.type='${parsed.request.result_destination.type}' (V1 supports only agent_inbox)`,
      });
      continue;
    }
    const targetAgent = parsed.request.result_destination.agent;
    if (!targetAgent) {
      result.failures.push({ id: parsed.request.id, reason: 'result_destination.agent missing' });
      continue;
    }

    try {
      const text = buildNotificationText(parsed, fullPath);
      sendMessage(
        busPaths,
        'cowork-bridge',
        targetAgent,
        priorityFor(parsed.response.status),
        text,
        // reply_to: link back to the bridge request id so agents can correlate
        parsed.request.id,
      );
      seen.add(parsed.request.id);
      result.relayed++;
    } catch (err) {
      result.failures.push({ id: parsed.request.id, reason: (err as Error).message });
    }
  }

  state.relayed_ids = Array.from(seen);
  state.last_tick_at = new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z');
  saveRelayState(stateDir, state);

  return result;
}
