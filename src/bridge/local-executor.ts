/**
 * Bridge local executor (d) — agent-browser-driven local executor.
 *
 * Status: V1 build per Group C (d) pivot. David-approved 2026-06-29 after the
 * Cowork autonomous-browser-select blocker. Spec source:
 *   orgs/personal/agents/forge/specs/cowork-bridge-security-mitigations-2026-06-29.md
 *
 * Why this exists: Cowork's scheduled-run constraints (browser-select prompt,
 * cloud sandbox, scheduling-driven latency) make it a fragile executor for
 * the bridge's actual purpose — GUI work without an API. agent-browser is
 * already installed (v0.27.0), runs locally, no sandbox, no browser-select
 * prompt, and reuses every existing security primitive (M1+M2+M3) unchanged.
 *
 * Architecture:
 *   1. Poll bridge pending/ on a configurable interval (default 30s).
 *   2. For each .json file: parse + M2 sig-verify + M1 allowlist re-check.
 *      Verified → move to in-progress/, execute. Failed → move to failed/
 *      with structured error.
 *   3. Dispatch based on request_type:
 *        settings_audit  → agent-browser open + snapshot + extract requested fields
 *        screenshot_report → agent-browser open + screenshot
 *      (extend allowlist + dispatch when new types are approved)
 *   4. Write completed/<id>.json in the EXACT same wrapped {request, response}
 *      shape Cowork would. The cortextOS-side relay watcher (with M3 gate)
 *      sees no difference and routes results to requesting agents unchanged.
 *
 * Idempotency: relies on bridge dir state-machine (in-progress/ marks claimed,
 * completed/ marks done, failed/ marks errored). Re-spawn-safe — a fresh
 * executor picks up wherever a crashed one left off.
 *
 * Process model: pm2-managed alongside cortextos-daemon. Auto-restart on
 * crash. Logs to pm2's standard log files.
 */

import { existsSync, readdirSync, readFileSync, renameSync, statSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import {
  resolveBridgePaths,
  type BridgePaths,
  type BridgeRequest,
  type BridgeResponseMetadata,
} from './index.js';
import { loadBridgeKey, verifyRequest } from './signing.js';
import { isUrlAllowed } from './security.js';

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const EXECUTOR_SESSION_ID = `local-executor-${Date.now()}`;

interface ExecutorOptions {
  ctxRoot: string;
  bridgePaths?: BridgePaths;
  pollIntervalMs?: number;
  /**
   * Override the agent-browser CLI path. Defaults to whatever's on PATH.
   * Useful for tests + deterministic pm2 env.
   */
  agentBrowserBin?: string;
  /** Override Chrome profile path (passed to agent-browser via --profile). */
  chromeProfile?: string;
  /** Set true when running under tests to skip the spawn loop after one tick. */
  oneShot?: boolean;
  log?: (line: string) => void;
}

interface ExecutorTickResult {
  scanned: number;
  executed: number;
  signature_failed: number;
  allowlist_failed: number;
  parse_failed: number;
  execution_errors: number;
}

/**
 * Run one polling tick. Pure-ish — returns the counts; never throws.
 */
export function executorTick(opts: ExecutorOptions): ExecutorTickResult {
  const log = opts.log ?? ((line: string) => console.log(`[bridge-executor] ${line}`));
  const bridgePaths = opts.bridgePaths ?? resolveBridgePaths(opts.ctxRoot);
  const result: ExecutorTickResult = {
    scanned: 0,
    executed: 0,
    signature_failed: 0,
    allowlist_failed: 0,
    parse_failed: 0,
    execution_errors: 0,
  };

  if (!existsSync(bridgePaths.outbound)) {
    return result;
  }

  let entries: string[];
  try {
    entries = readdirSync(bridgePaths.outbound).filter(f => f.endsWith('.json') && !f.startsWith('.'));
  } catch {
    return result;
  }

  const key = loadBridgeKey(opts.ctxRoot);

  for (const file of entries) {
    result.scanned++;
    const srcPath = join(bridgePaths.outbound, file);

    // M2: sig verify before any execute path
    let request: BridgeRequest;
    try {
      const raw = readFileSync(srcPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (!parsed.id || !parsed.from_agent || !parsed.request_type) {
        result.parse_failed++;
        moveToFailed(srcPath, bridgePaths, file, {
          request: parsed,
          response: failedResponse(parsed?.id, 'executor parse: missing required fields'),
        }, log);
        continue;
      }
      request = parsed as BridgeRequest;
    } catch (err) {
      result.parse_failed++;
      // Best effort move — if even reading the file fails, leave it for janitor.
      log(`parse failed for ${file}: ${(err as Error).message}`);
      continue;
    }

    if (!key) {
      result.signature_failed++;
      moveToFailed(srcPath, bridgePaths, file, {
        request,
        response: failedResponse(request.id, 'executor M2: bridge signing key not present on this Mini — run cortextos bus generate-bridge-key once'),
      }, log);
      continue;
    }
    if (!verifyRequest(request, key)) {
      result.signature_failed++;
      moveToFailed(srcPath, bridgePaths, file, {
        request,
        response: failedResponse(request.id, 'executor M2: signature verification failed — request rejected before any execution'),
      }, log);
      continue;
    }

    // M1: allowlist re-check (defense-in-depth; outbound.ts already gated at queue-time)
    const ctxUrl = typeof request.context?.url === 'string' ? (request.context.url as string) : undefined;
    if (ctxUrl && !isUrlAllowed(ctxUrl, opts.ctxRoot)) {
      result.allowlist_failed++;
      moveToFailed(srcPath, bridgePaths, file, {
        request,
        response: failedResponse(request.id, `executor M1: URL '${ctxUrl}' not in allowlist — rejected before execution`),
      }, log);
      continue;
    }

    // Move to in-progress before executing (single rename = atomic claim)
    const inProgressPath = join(bridgePaths.processing, file);
    try {
      ensureDir(bridgePaths.processing);
      renameSync(srcPath, inProgressPath);
    } catch (err) {
      // Race with another executor instance or fs issue — skip this file
      log(`move-to-in-progress failed for ${file}: ${(err as Error).message}`);
      continue;
    }

    // Dispatch + write response
    try {
      const response = dispatchToAgentBrowser(request, opts);
      const completedPath = join(bridgePaths.processed, file);
      ensureDir(bridgePaths.processed);
      atomicWriteSync(completedPath, JSON.stringify({ request, response }, null, 2));
      // Remove the in-progress copy (we've written to completed/)
      try { require('fs').unlinkSync(inProgressPath); } catch { /* best-effort */ }
      result.executed++;
      log(`executed ${request.id} (${request.request_type})`);
    } catch (err) {
      result.execution_errors++;
      const errMsg = (err as Error).message ?? String(err);
      moveToFailed(inProgressPath, bridgePaths, file, {
        request,
        response: failedResponse(request.id, `executor execution error: ${errMsg}`),
      }, log);
    }
  }

  return result;
}

function failedResponse(requestId: string, error: string): BridgeResponseMetadata {
  return {
    request_id: requestId,
    cowork_session_id: EXECUTOR_SESSION_ID,
    status: 'failed',
    completed_at: new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z'),
    error,
    retryable: false,
  };
}

function moveToFailed(
  srcPath: string,
  bridgePaths: BridgePaths,
  file: string,
  wrapper: { request: any; response: BridgeResponseMetadata },
  log: (line: string) => void,
): void {
  try {
    ensureDir(bridgePaths.failed);
    // Write the wrapped (request, response) shape so the relay sees it as a
    // standard failure-response, NOT a bare request — matches the cowork
    // protocol so M3 + relay process it normally.
    atomicWriteSync(join(bridgePaths.failed, file), JSON.stringify(wrapper, null, 2));
    // Remove the original (the wrapped version supersedes it).
    try { require('fs').unlinkSync(srcPath); } catch { /* file may already be gone */ }
    log(`moved to failed/: ${file} (${wrapper.response.error})`);
  } catch (err) {
    log(`moveToFailed itself failed for ${file}: ${(err as Error).message}`);
  }
}

/**
 * Dispatch a single verified request to agent-browser. Each request_type has
 * its own command sequence; widening the allowlist requires extending this
 * function AND updating V1_ALLOWED_REQUEST_TYPES in types.ts.
 */
function dispatchToAgentBrowser(req: BridgeRequest, opts: ExecutorOptions): BridgeResponseMetadata & { result?: unknown } {
  const agentBrowser = opts.agentBrowserBin ?? 'agent-browser';
  const ctxUrl = typeof req.context?.url === 'string' ? (req.context.url as string) : '';

  const baseResp = {
    request_id: req.id,
    cowork_session_id: EXECUTOR_SESSION_ID,
    completed_at: new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z'),
  };

  if (req.request_type === 'screenshot_report') {
    if (!ctxUrl) throw new Error('screenshot_report requires context.url');
    // Step 1: open the URL
    runAgentBrowser(agentBrowser, ['open', ctxUrl], opts);
    // Step 2: snapshot to get page title + structured info before screenshot
    const snapshot = runAgentBrowser(agentBrowser, ['snapshot', '-i', '-c'], opts);
    // Step 3: capture screenshot to a deterministic path under <ctxRoot>/state/bridge-screenshots/
    const ssDir = join(opts.ctxRoot, 'state', 'bridge-screenshots');
    ensureDir(ssDir);
    const ssPath = join(ssDir, `${req.id}.png`);
    runAgentBrowser(agentBrowser, ['screenshot', ssPath], opts);
    const titleMatch = snapshot.match(/title[:=]\s*["']?([^"'\n]+)["']?/i);
    return {
      ...baseResp,
      status: 'success',
      result: {
        screenshot_path: ssPath,
        page_title: titleMatch?.[1]?.trim() ?? '',
        url_visited: ctxUrl,
      },
    };
  }

  if (req.request_type === 'settings_audit') {
    if (!ctxUrl) throw new Error('settings_audit requires context.url');
    runAgentBrowser(agentBrowser, ['open', ctxUrl], opts);
    const snapshot = runAgentBrowser(agentBrowser, ['snapshot', '-i', '-c'], opts);
    const fieldsToExtract = Array.isArray(req.context?.fields_to_extract)
      ? (req.context.fields_to_extract as string[])
      : [];
    const extracted_fields: Record<string, string> = {};
    if (fieldsToExtract.length === 0) {
      // No specific fields → return the whole snapshot as 'page_snapshot'
      extracted_fields['page_snapshot'] = snapshot;
    } else {
      // Per-field: use `get text <selector>` style — V1 conservative.
      // We can't auto-derive selectors; surface the snapshot and let the
      // requesting agent extract from there.
      extracted_fields['page_snapshot'] = snapshot;
      for (const f of fieldsToExtract) {
        extracted_fields[f] = `(field-extraction is V1.5; requesting agent should parse '${f}' from page_snapshot)`;
      }
    }
    return {
      ...baseResp,
      status: 'success',
      result: {
        url_visited: ctxUrl,
        extracted_fields,
      },
    };
  }

  throw new Error(`Unknown request_type '${req.request_type}' — extend dispatchToAgentBrowser to handle it.`);
}

function runAgentBrowser(bin: string, args: string[], opts: ExecutorOptions): string {
  const fullArgs = opts.chromeProfile ? ['--profile', opts.chromeProfile, ...args] : args;
  const result = spawnSync(bin, fullArgs, { encoding: 'utf-8', timeout: 60_000 });
  if (result.error) throw new Error(`agent-browser spawn failed: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`agent-browser ${args[0]} exit=${result.status} stderr=${result.stderr?.slice(0, 200)}`);
  }
  return result.stdout ?? '';
}

/**
 * Long-running entrypoint — polls forever at pollIntervalMs cadence. Used by
 * the pm2-managed bridge-executor process. Tests use executorTick directly.
 */
export async function runExecutor(opts: ExecutorOptions): Promise<void> {
  const log = opts.log ?? ((line: string) => console.log(`[bridge-executor] ${line}`));
  const interval = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  log(`starting (session=${EXECUTOR_SESSION_ID}, interval=${interval}ms, ctxRoot=${opts.ctxRoot})`);

  while (true) {
    try {
      const r = executorTick(opts);
      if (r.scanned > 0) {
        log(`tick: scanned=${r.scanned} executed=${r.executed} sig_fail=${r.signature_failed} allow_fail=${r.allowlist_failed} parse_fail=${r.parse_failed} exec_err=${r.execution_errors}`);
      }
    } catch (err) {
      log(`tick threw (will retry next interval): ${(err as Error).message}`);
    }
    if (opts.oneShot) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
