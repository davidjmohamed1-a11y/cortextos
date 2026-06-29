/**
 * liveness-probe.ts — framework-level liveness signal for agents.
 *
 * Status: V1 build per Group C C5, spec source
 *   orgs/personal/agents/forge/specs/watchdog-liveness-probe-2026-06-29.md
 *
 * The existing fast-checker watchdog (src/daemon/fast-checker.ts:108-117) fires
 * every 50 min and writes `[watchdog] <agent> alive` to the heartbeat REGARDLESS
 * of whether the agent's Claude Code process is actually responsive. This was
 * exactly the gap that hid Oracle's 14h+ OAuth-wall hang on 2026-06-19 — the
 * watchdog said "alive" (true at the process level) while the PTY was wedged.
 *
 * This module adds a real progress signal: stdout-activity probe paired with
 * heartbeat-freshness check + pid-alive check. Writes the result to
 * `<ctxRoot>/state/<agent>/liveness.json` so sentinel + dashboards can consume
 * a structured liveness signal independent of the agent's own heartbeat.
 *
 * Key design decisions:
 * - SEPARATE FILE from heartbeat.json. Heartbeat is rewritten wholesale on
 *   every updateHeartbeat call (would wipe any liveness metadata we tried to
 *   embed there). Liveness gets its own file the watchdog owns.
 * - Pure read-only probe — never writes to PTY, never sends prompts, no
 *   conversation pollution. The on-demand active probe is a separate path
 *   (cortextos bus probe-agent --active) and even then is gated behind an
 *   explicit flag with a pollution warning.
 * - Fails OPEN on internal error — returns level='unknown' rather than
 *   throwing. Same principle as hook-hard-rule-gate: favor signal-presence
 *   over total absence when the probe itself is broken.
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';

/**
 * Possible liveness states. Documented at the type level so consumers can
 * branch precisely (sentinel needs to distinguish 'wedged' from 'idle').
 */
export type LivenessLevel =
  /** Process alive AND stdout active within freshness window. Normal state. */
  | 'healthy'
  /** Process alive but stdout silent for >freshness window. Could be genuinely
   *  idle (event-driven agent waiting) OR wedged. Caller decides based on
   *  context (e.g. sentinel checks if heartbeat is also stale → wedged). */
  | 'stale_stdout'
  /** Process alive but heartbeat self-report stale >N hours. Indicates the
   *  agent's own cron-driven heartbeat isn't firing — strong wedge signal. */
  | 'stale_heartbeat'
  /** Both stdout AND heartbeat stale + process alive + agent reports running.
   *  Classic Oracle-style hang. */
  | 'wedged'
  /** Process not alive (or pid file shows a dead pid). agent-manager's crash
   *  recovery should kick in; if we see this here, something's wrong. */
  | 'dead'
  /** Probe couldn't determine — usually means no log file yet, no heartbeat
   *  yet, or filesystem error reading the probe inputs. Not actionable on its
   *  own. */
  | 'unknown';

export interface LivenessResult {
  /** Stable enum the consumer branches on. */
  level: LivenessLevel;
  /** Human-readable explanation of why this level was chosen. */
  reason: string;
  /** Milliseconds since the agent's stdout.log was last touched. null if log
   *  does not exist yet. */
  stdout_age_ms: number | null;
  /** Milliseconds since the agent's heartbeat.json's last_heartbeat field. null
   *  if heartbeat does not exist yet. */
  heartbeat_age_ms: number | null;
  /** Whether the PTY process is alive. null when we have no pid to probe. */
  pid_alive: boolean | null;
  /** ISO 8601 timestamp of when this probe was computed. */
  probed_at: string;
}

/**
 * Thresholds (in ms). Tuned conservatively to minimize false-positive 'wedged'
 * declarations:
 * - STDOUT_STALE: 30 min. Generous — most agents emit boot output + heartbeat
 *   call stderr at least every 4h cron. 30 min is the floor where "this is
 *   suspicious enough to flag" lives.
 * - HEARTBEAT_STALE: 6h. Roughly 1.5x the standard 4h heartbeat cron, so a
 *   single skipped heartbeat doesn't trigger.
 */
export const STDOUT_STALE_MS = 30 * 60 * 1000;
export const HEARTBEAT_STALE_MS = 6 * 60 * 60 * 1000;

/**
 * Inputs the probe needs. Caller (fast-checker watchdog or CLI) provides paths
 * + optional pid (when running inside the daemon process, the AgentProcess
 * exposes its own PTY pid).
 */
export interface ProbeInput {
  agentName: string;
  ctxRoot: string;
  /** PTY pid, when known. null = skip pid_alive check (return null in result). */
  ptyPid?: number | null;
}

function readHeartbeatAge(ctxRoot: string, agentName: string): number | null {
  const path = join(ctxRoot, 'state', agentName, 'heartbeat.json');
  if (!existsSync(path)) return null;
  try {
    const hb = JSON.parse(readFileSync(path, 'utf-8'));
    const ts = hb.last_heartbeat || hb.timestamp;
    if (!ts) return null;
    const parsed = Date.parse(ts);
    if (Number.isNaN(parsed)) return null;
    return Date.now() - parsed;
  } catch {
    return null;
  }
}

function readStdoutAge(ctxRoot: string, agentName: string): number | null {
  const path = join(ctxRoot, 'logs', agentName, 'stdout.log');
  if (!existsSync(path)) return null;
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function checkPidAlive(pid: number | null | undefined): boolean | null {
  if (pid === null || pid === undefined) return null;
  try {
    // process.kill(pid, 0) is the standard non-destructive liveness check:
    // throws ESRCH if no process exists with that pid, returns true otherwise.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pure function — given the input signals, decide the liveness level.
 * Extracted so unit tests can exercise every level without filesystem fixtures.
 */
export function decideLiveness(args: {
  stdout_age_ms: number | null;
  heartbeat_age_ms: number | null;
  pid_alive: boolean | null;
}): { level: LivenessLevel; reason: string } {
  const { stdout_age_ms, heartbeat_age_ms, pid_alive } = args;

  // Dead trumps everything else: if the pid is dead and we have evidence the
  // agent SHOULD be running (heartbeat suggests recent), flag dead.
  if (pid_alive === false) {
    return { level: 'dead', reason: 'PTY process pid not alive' };
  }

  const stdoutFresh = stdout_age_ms !== null && stdout_age_ms < STDOUT_STALE_MS;
  const heartbeatFresh = heartbeat_age_ms !== null && heartbeat_age_ms < HEARTBEAT_STALE_MS;
  const stdoutStale = stdout_age_ms !== null && stdout_age_ms >= STDOUT_STALE_MS;
  const heartbeatStale = heartbeat_age_ms !== null && heartbeat_age_ms >= HEARTBEAT_STALE_MS;

  if (stdoutStale && heartbeatStale) {
    return {
      level: 'wedged',
      reason: `stdout silent ${Math.round((stdout_age_ms ?? 0) / 60000)} min + heartbeat stale ${Math.round((heartbeat_age_ms ?? 0) / 60000)} min + pid alive — classic wedge signal`,
    };
  }

  if (heartbeatStale) {
    return {
      level: 'stale_heartbeat',
      reason: `agent's self-reported heartbeat stale by ${Math.round((heartbeat_age_ms ?? 0) / 60000)} min`,
    };
  }

  if (stdoutStale) {
    return {
      level: 'stale_stdout',
      reason: `stdout silent for ${Math.round((stdout_age_ms ?? 0) / 60000)} min — could be idle or wedged; consult heartbeat freshness + pending-prompts before escalating`,
    };
  }

  if (stdoutFresh || heartbeatFresh) {
    return { level: 'healthy', reason: 'stdout and/or heartbeat fresh within window' };
  }

  return {
    level: 'unknown',
    reason: 'no stdout log + no heartbeat yet (agent may be in first-boot bootstrap)',
  };
}

/**
 * Run the probe. Pure read-only — never writes to PTY, never sends prompts.
 * Returns LivenessResult; never throws.
 */
export function probeAgentLiveness(input: ProbeInput): LivenessResult {
  const probed_at = new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z');
  try {
    const stdout_age_ms = readStdoutAge(input.ctxRoot, input.agentName);
    const heartbeat_age_ms = readHeartbeatAge(input.ctxRoot, input.agentName);
    const pid_alive = checkPidAlive(input.ptyPid ?? null);
    const { level, reason } = decideLiveness({ stdout_age_ms, heartbeat_age_ms, pid_alive });
    return { level, reason, stdout_age_ms, heartbeat_age_ms, pid_alive, probed_at };
  } catch (err) {
    // Fail OPEN — return 'unknown' rather than throwing. Same principle as
    // hook-hard-rule-gate.
    return {
      level: 'unknown',
      reason: `probe internal error: ${(err as Error).message}`,
      stdout_age_ms: null,
      heartbeat_age_ms: null,
      pid_alive: null,
      probed_at,
    };
  }
}

/**
 * Write a probe result to <ctxRoot>/state/<agent>/liveness.json. Atomic.
 * Separate from heartbeat.json (which agents own + rewrite wholesale on every
 * update-heartbeat call). The watchdog owns this file.
 */
export function writeLivenessResult(input: ProbeInput, result: LivenessResult): void {
  const stateDir = join(input.ctxRoot, 'state', input.agentName);
  ensureDir(stateDir);
  atomicWriteSync(join(stateDir, 'liveness.json'), JSON.stringify(result, null, 2));
}
