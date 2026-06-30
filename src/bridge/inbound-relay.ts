/**
 * Bridge — Inbound Relay (Claude → fleet)
 *
 * Tails the OneDrive `from-claude/pending/` dir for new InboundMessage files
 * written by Claude. For each new file:
 *   1. Parse + verify HMAC signature (M2 reuse, separate canonical fmt).
 *      Verification failure → move to from-claude/blocked/.
 *   2. Run hard-rule matchers on `kind === 'request'` only (action-shaped).
 *      `message`/`challenge`/`fact` bypass — those are CONTENT (red-team
 *      dissent must not be gated, design call).
 *      Hard-rule match (any) → move to from-claude/blocked/.
 *   3. Classify sensitivity (M3 reuse, adapted shape). Conservative default
 *      = sensitive. Sensitive → write sidecar, notify boss-personal, move to
 *      from-claude/pending-approval/.
 *   4. Routine + approved → sendMessage to the target agent's inbox + move to
 *      from-claude/processed/.
 *
 * One-writer guarantee: acquires advisory file-lock on the inbound state
 * file. Operator-initiated CLI tick + daemon tick cannot collide.
 *
 * Rate limit: process max INBOUND_TICK_MAX_PROCESSED files per tick to avoid
 * inbox-spam DOS if Claude side accidentally writes a flood.
 *
 * Spec: orgs/personal/agents/forge/specs/claude-fleet-phase-a-2026-06-30.md
 */

import { existsSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { sendMessage } from '../bus/message.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { acquireFileLock, releaseFileLock } from '../utils/file-lock.js';
import { loadBridgeKey, verifyInboundMessage } from './signing.js';
import {
  approvalTokenPath,
  checkApprovalDecision,
  loadSensitiveDomains,
  pendingApprovalSidecarPath,
  rejectMarkerPath,
} from './sensitivity.js';
import { HARD_RULES, type HardRuleEnv } from '../hooks/hard-rules.js';
import type { BridgePaths, InboundMessage } from './types.js';
import { V1_INBOUND_KINDS } from './types.js';
import type { BusPaths, Priority } from '../types/index.js';

const INBOUND_STATE_FILENAME = 'bridge-inbound-relay-state.json';
const INBOUND_STATE_VERSION = 1;
const INBOUND_TICK_MAX_PROCESSED = 50;

interface InboundState {
  version: number;
  delivered_ids: string[];
  last_tick_at: string;
}

function loadInboundState(stateDir: string): InboundState {
  const path = join(stateDir, INBOUND_STATE_FILENAME);
  if (!existsSync(path)) {
    return { version: INBOUND_STATE_VERSION, delivered_ids: [], last_tick_at: '' };
  }
  try {
    const parsed: InboundState = JSON.parse(readFileSync(path, 'utf-8'));
    if (parsed.version !== INBOUND_STATE_VERSION) {
      return { version: INBOUND_STATE_VERSION, delivered_ids: [], last_tick_at: '' };
    }
    return parsed;
  } catch {
    return { version: INBOUND_STATE_VERSION, delivered_ids: [], last_tick_at: '' };
  }
}

function saveInboundState(stateDir: string, state: InboundState): void {
  ensureDir(stateDir);
  atomicWriteSync(join(stateDir, INBOUND_STATE_FILENAME), JSON.stringify(state, null, 2));
}

export interface InboundRelayTickResult {
  scanned: number;
  /** Routine messages successfully delivered to a fleet inbox. */
  delivered: number;
  /** Sensitive messages newly held for David approval (sidecar written). */
  newly_pending_approval: number;
  /** Sensitive messages still awaiting David. */
  still_pending_approval: number;
  /** Pending-approval messages David approved this tick → delivered. */
  approved_and_delivered: number;
  /** Pending-approval messages David rejected this tick → moved to blocked/. */
  rejected: number;
  /** Hard-rule match → moved to blocked/. */
  hard_rule_blocked: number;
  /** Signature verification failure → moved to blocked/. */
  signature_failed: number;
  /** Malformed JSON or schema → moved to blocked/. */
  parse_failed: number;
  /** Rate-limit deferred (will re-process next tick). */
  deferred_rate_limit: number;
  failures: Array<{ id: string; reason: string }>;
}

export interface InboundRelayTickArgs {
  bridgePaths: BridgePaths;
  busPaths: BusPaths;
  /** Where the inbound state file lives. Typically <ctxRoot>/state/atlas/. */
  stateDir: string;
  /** cortextOS root for M3 sensitivity-domain + approval-token lookups. */
  ctxRoot: string;
  /** Override the max files processed per tick (testing). */
  maxPerTick?: number;
  /** Inject log fn (tests). */
  log?: (line: string) => void;
  /** Inject Date.now (testing). */
  now?: () => Date;
}

/**
 * One inbound relay tick. See module header for behavior.
 */
export function inboundRelayTick(args: InboundRelayTickArgs): InboundRelayTickResult {
  const { bridgePaths, busPaths, stateDir, ctxRoot } = args;
  const nowFn = args.now ?? (() => new Date());
  const maxPerTick = args.maxPerTick ?? INBOUND_TICK_MAX_PROCESSED;
  const log = args.log ?? (() => { /* silent */ });

  const result: InboundRelayTickResult = {
    scanned: 0,
    delivered: 0,
    newly_pending_approval: 0,
    still_pending_approval: 0,
    approved_and_delivered: 0,
    rejected: 0,
    hard_rule_blocked: 0,
    signature_failed: 0,
    parse_failed: 0,
    deferred_rate_limit: 0,
    failures: [],
  };

  // Nothing to do if inbound dirs don't exist yet.
  if (!existsSync(bridgePaths.from_claude_pending) && !existsSync(bridgePaths.from_claude_pending_approval)) {
    return result;
  }

  // Single-writer enforcement.
  ensureDir(stateDir);
  const lockTargetPath = join(stateDir, INBOUND_STATE_FILENAME);
  let lockHandle;
  try {
    lockHandle = acquireFileLock(lockTargetPath, { timeoutMs: 5_000 });
  } catch (err) {
    result.failures.push({ id: '(lock)', reason: `inbound relay lock contention: ${(err as Error).message}` });
    return result;
  }

  // Ensure destination dirs exist.
  ensureDir(bridgePaths.from_claude_processed);
  ensureDir(bridgePaths.from_claude_blocked);
  ensureDir(bridgePaths.from_claude_pending_approval);

  const state = loadInboundState(stateDir);
  const delivered = new Set(state.delivered_ids);

  // ---------- Phase 1: process pending-approval/ (decisions David made) ----
  if (existsSync(bridgePaths.from_claude_pending_approval)) {
    const approvalEntries = readdirSafely(bridgePaths.from_claude_pending_approval)
      .filter((f) => f.endsWith('.json') && !f.endsWith('.pending-approval.json'));
    for (const file of approvalEntries) {
      const fullPath = join(bridgePaths.from_claude_pending_approval, file);
      const parsed = parseInboundFile(fullPath);
      if (!parsed) {
        result.parse_failed++;
        moveTo(fullPath, bridgePaths.from_claude_blocked, file, log);
        continue;
      }
      const decision = checkApprovalDecision(ctxRoot, parsed.id);
      if (decision.status === 'pending') {
        result.still_pending_approval++;
        continue;
      }
      if (decision.status === 'rejected') {
        result.rejected++;
        // Move message + clean sidecar + reject marker.
        moveTo(fullPath, bridgePaths.from_claude_blocked, file, log);
        cleanSidecar(bridgePaths.from_claude_pending_approval, parsed.id);
        try {
          const marker = rejectMarkerPath(ctxRoot, parsed.id);
          if (existsSync(marker)) unlinkSync(marker);
        } catch { /* ignore */ }
        continue;
      }
      // approved → deliver + consume token + move
      try {
        deliverInboundMessage(busPaths, parsed);
        delivered.add(parsed.id);
        result.approved_and_delivered++;
        if (decision.tokenPath) {
          try { unlinkSync(decision.tokenPath); } catch { /* ignore */ }
        }
        cleanSidecar(bridgePaths.from_claude_pending_approval, parsed.id);
        moveTo(fullPath, bridgePaths.from_claude_processed, file, log);
      } catch (err) {
        result.failures.push({ id: parsed.id, reason: `approved-deliver failed: ${(err as Error).message}` });
      }
    }
  }

  // ---------- Phase 2: process pending/ (fresh messages) -------------------
  const ruleEnv: HardRuleEnv = {
    agentDir: ctxRoot,
    agentName: 'claude',
    ctxRoot,
  };
  const sensitiveDomains = loadSensitiveDomains(ctxRoot);
  const bridgeKey = loadBridgeKey(ctxRoot);

  if (existsSync(bridgePaths.from_claude_pending)) {
    const pendingEntries = readdirSafely(bridgePaths.from_claude_pending)
      .filter((f) => f.endsWith('.json') && !f.startsWith('.'));

    let processed = 0;
    for (const file of pendingEntries) {
      if (processed >= maxPerTick) {
        result.deferred_rate_limit++;
        continue;
      }
      result.scanned++;
      processed++;
      const fullPath = join(bridgePaths.from_claude_pending, file);

      const parsed = parseInboundFile(fullPath);
      if (!parsed) {
        result.parse_failed++;
        moveTo(fullPath, bridgePaths.from_claude_blocked, file, log);
        continue;
      }

      // FS-authoritative dedup pre-check: if a file with this id is already
      // in processed/ OR blocked/, skip this duplicate.
      if (existsSync(join(bridgePaths.from_claude_processed, file))
       || existsSync(join(bridgePaths.from_claude_blocked, file))) {
        // OneDrive sync occasionally double-delivers. Just discard the dupe.
        try { unlinkSync(fullPath); } catch { /* ignore */ }
        continue;
      }

      // M2: signature verification.
      if (!bridgeKey) {
        result.signature_failed++;
        moveTo(fullPath, bridgePaths.from_claude_blocked, file, log,
          { reason: 'M2: bridge signing key not present on this host — cannot verify inbound message' });
        continue;
      }
      if (!verifyInboundMessage(parsed, bridgeKey)) {
        result.signature_failed++;
        moveTo(fullPath, bridgePaths.from_claude_blocked, file, log,
          { reason: 'M2: inbound signature missing or invalid' });
        continue;
      }

      // Hard-rule pass (only on kind=request — content kinds bypass).
      if (parsed.kind === 'request') {
        const blockedRule = matchHardRule(parsed, ruleEnv);
        if (blockedRule) {
          result.hard_rule_blocked++;
          moveTo(fullPath, bridgePaths.from_claude_blocked, file, log,
            { reason: `hard-rule '${blockedRule}' fired on inbound request (V1: no override path for inbound)` });
          continue;
        }
      }

      // M3-equivalent sensitivity classification (adapted).
      const sensitive = classifyInboundSensitivity(parsed, sensitiveDomains);
      if (sensitive.sensitive) {
        try {
          // Write sidecar + notify boss-personal + move to pending-approval/.
          const newPath = join(bridgePaths.from_claude_pending_approval, file);
          renameSync(fullPath, newPath);
          atomicWriteSync(
            pendingApprovalSidecarPath(bridgePaths.from_claude_pending_approval, parsed.id),
            JSON.stringify({
              id: parsed.id,
              from: parsed.from,
              to_agent: parsed.to_agent,
              kind: parsed.kind,
              sensitivity_reason: sensitive.reason,
              detected_at: nowFn().toISOString(),
              priority: parsed.priority,
              text_preview: parsed.text.slice(0, 200),
              context_preview: parsed.context,
            }, null, 2),
          );
          try {
            sendMessage(
              busPaths,
              'claude-fleet-bridge',
              'boss-personal',
              'high',
              `Inbound message from Claude pending David approval (M3 gate).\n\n` +
              `ID:        ${parsed.id}\n` +
              `To agent:  ${parsed.to_agent}\n` +
              `Kind:      ${parsed.kind}\n` +
              `Reason:    ${sensitive.reason}\n\n` +
              `Preview:   ${parsed.text.slice(0, 300)}${parsed.text.length > 300 ? '…' : ''}\n\n` +
              `Approve: cortextos bus bridge-approve-relay ${parsed.id}\n` +
              `Reject:  cortextos bus bridge-reject-relay ${parsed.id}`,
              parsed.id,
            );
          } catch { /* best-effort notification */ }
          result.newly_pending_approval++;
        } catch (err) {
          result.failures.push({ id: parsed.id, reason: `gate-move failed: ${(err as Error).message}` });
        }
        continue;
      }

      // Routine: deliver + move to processed/.
      try {
        deliverInboundMessage(busPaths, parsed);
        delivered.add(parsed.id);
        result.delivered++;
        moveTo(fullPath, bridgePaths.from_claude_processed, file, log);
      } catch (err) {
        result.failures.push({ id: parsed.id, reason: `routine deliver failed: ${(err as Error).message}` });
      }
    }
  }

  state.delivered_ids = Array.from(delivered);
  state.last_tick_at = nowFn().toISOString();
  saveInboundState(stateDir, state);

  releaseFileLock(lockHandle);
  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readdirSafely(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function parseInboundFile(path: string): InboundMessage | null {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return null;
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as InboundMessage;
    // Defensive shape validation.
    if (parsed.schema_version !== 1) return null;
    if (typeof parsed.id !== 'string' || !parsed.id) return null;
    if (parsed.from !== 'claude') return null;
    if (typeof parsed.to_agent !== 'string' || !parsed.to_agent) return null;
    if (!V1_INBOUND_KINDS.includes(parsed.kind)) return null;
    if (!['urgent', 'high', 'normal', 'low'].includes(parsed.priority)) return null;
    if (typeof parsed.text !== 'string') return null;
    if (typeof parsed.created_at !== 'string') return null;
    if (typeof parsed.sig !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

function moveTo(
  src: string,
  destDir: string,
  filename: string,
  log: (line: string) => void,
  extra?: { reason?: string },
): void {
  try {
    ensureDir(destDir);
    const destPath = join(destDir, filename);
    renameSync(src, destPath);
    if (extra?.reason) {
      // Drop a sidecar reason file so post-mortems show WHY a file was blocked.
      try {
        atomicWriteSync(`${destPath}.reason.txt`, extra.reason);
      } catch { /* best-effort */ }
    }
  } catch (err) {
    log(`moveTo failed: ${src} → ${destDir}/${filename}: ${(err as Error).message}`);
  }
}

function cleanSidecar(approvalDir: string, id: string): void {
  const sidecar = pendingApprovalSidecarPath(approvalDir, id);
  if (existsSync(sidecar)) {
    try { unlinkSync(sidecar); } catch { /* ignore */ }
  }
}

/**
 * Build a synthetic hard-rule tool-call shape for an inbound request, then
 * scan the existing HARD_RULES for any matcher hit. Returns the matched
 * rule name, or null if no match.
 *
 * Synthetic tool_name: `mcp__claude_inbound__request`. The matchers inspect
 * tool_input — for our purposes that's the inbound message's kind, text, and
 * context. The matchers won't get false positives on routine content unless
 * the content literally invokes a hard-rule-named pattern (e.g. a curl POST
 * to a CAPTCHA-solver URL in the text field).
 */
function matchHardRule(msg: InboundMessage, env: HardRuleEnv): string | null {
  // Most hard-rule matchers branch on a specific toolName (Bash, WebFetch,
  // an MCP prefix). We probe each rule against several synthetic shapes so an
  // inbound request that embeds a Bash-style command OR a WebFetch-style URL
  // gets caught by the matcher that knows that shape.
  const command = typeof (msg.context as any)?.command === 'string'
    ? (msg.context as any).command
    : msg.text;
  const url = typeof (msg.context as any)?.url === 'string' ? (msg.context as any).url : '';

  const probes: Array<{ toolName: string; toolInput: any }> = [
    {
      toolName: 'mcp__claude_inbound__request',
      toolInput: { kind: msg.kind, to_agent: msg.to_agent, text: msg.text, context: msg.context ?? {}, command, url },
    },
    // Bash synthetic — catches captcha-solver / IP-rotation / anti-detect /
    // git-push-main / rm patterns embedded in the request payload.
    { toolName: 'Bash', toolInput: { command } },
    // WebFetch synthetic — catches auto-login and other URL-targeted matchers.
    { toolName: 'WebFetch', toolInput: { url, prompt: msg.text } },
  ];

  for (const rule of HARD_RULES) {
    for (const probe of probes) {
      let matched: boolean;
      try {
        matched = rule.match(probe.toolName, probe.toolInput, env);
      } catch {
        return `${rule.name} (matcher error)`;
      }
      if (matched) return rule.name;
    }
  }
  return null;
}

/**
 * Classify an inbound message as sensitive or routine.
 *
 * Sensitivity triggers (V1):
 *   - Claude self-declared sensitive_hint === true
 *   - Claude self-declared sensitive_hint missing (conservative default = sensitive)
 *     EXCEPT for kind=challenge/fact (red-team content must flow freely)
 *   - kind=request AND context.url matches a sensitive-domain entry
 *   - to_agent='kai' AND kind='request' (kai = draft-only by policy; any inbound request is sensitive)
 */
function classifyInboundSensitivity(
  msg: InboundMessage,
  sensitiveDomains: ReadonlyArray<string>,
): { sensitive: boolean; reason: string } {
  // kai = draft-only; inbound REQUESTS to kai always sensitive.
  if (msg.to_agent === 'kai' && msg.kind === 'request') {
    return { sensitive: true, reason: 'inbound request to kai (draft-only by policy)' };
  }
  // Claude self-declared sensitive
  if (msg.sensitive_hint === true) {
    return { sensitive: true, reason: 'Claude self-declared sensitive_hint=true' };
  }
  // URL-in-context sensitivity (request kind only — challenges/facts can carry URLs without gating)
  if (msg.kind === 'request') {
    const url = typeof (msg.context as any)?.url === 'string' ? (msg.context as any).url as string : '';
    if (url) {
      try {
        const host = new URL(url).hostname.toLowerCase();
        for (const s of sensitiveDomains) {
          const lower = s.toLowerCase();
          if (host === lower || host.endsWith('.' + lower)) {
            return { sensitive: true, reason: `inbound request targets sensitive domain '${host}'` };
          }
        }
      } catch {
        // Unparseable URL on a request → defensive sensitive.
        return { sensitive: true, reason: 'inbound request context.url unparseable (defensive)' };
      }
    }
  }
  // Conservative default for REQUEST kind without self-declared hint: sensitive.
  // (Better one extra David-approval prompt than one missed escalation.)
  if (msg.kind === 'request' && msg.sensitive_hint === undefined) {
    return { sensitive: true, reason: 'inbound request kind with no sensitive_hint (V1 conservative default)' };
  }
  return { sensitive: false, reason: 'routine — message/challenge/fact OR explicitly sensitive_hint=false' };
}

function deliverInboundMessage(busPaths: BusPaths, msg: InboundMessage): void {
  sendMessage(
    busPaths,
    'claude',
    msg.to_agent,
    msg.priority as Priority,
    formatInboundDelivery(msg),
    msg.id, // reply_to so the recipient can correlate back to the inbound id
  );
}

function formatInboundDelivery(msg: InboundMessage): string {
  const header = `[INBOUND FROM CLAUDE — kind=${msg.kind}, id=${msg.id}]`;
  const ctxLine = msg.context ? `\nContext: ${JSON.stringify(msg.context)}` : '';
  return `${header}\n\n${msg.text}${ctxLine}`;
}
