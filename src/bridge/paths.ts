/**
 * Bridge — Path resolution
 *
 * Status: PARTIAL IMPLEMENTATION. Path helpers are safe to ship even in
 * scaffold mode — they're pure compute, no IO. Future modules import these
 * to know where to read/write.
 */

import { join } from 'path';
import { homedir } from 'os';
import type { BridgePaths } from './types.js';

/**
 * Default bridge root: OneDrive `cowork-tasks/` dir.
 *
 * Chosen by atlas's protocol spec (research-2026-06-19-agent-cowork-bridge.md)
 * because David's existing finance-sync-mid-month Cowork session ALREADY writes
 * to this OneDrive path daily — meaning Cowork's sandbox-write permission to
 * OneDrive is EMPIRICALLY PROVEN. This eliminates forge's prior 10-min
 * sandbox-test gate (replaced by atlas's already-existing evidence).
 *
 * The path itself is the macOS OneDrive sync mount; on the file-system side
 * it's just a normal dir, so all the same atomic-write + ensureDir patterns
 * work. The OneDrive sync handles cross-device propagation transparently.
 *
 * Subdir naming follows atlas's spec: pending/ → in-progress/ → completed/ →
 * failed/ (note the hyphen in `in-progress`, matching atlas; differs from
 * forge's earlier feasibility-doc draft of `processing/`).
 */
export const DEFAULT_BRIDGE_ROOT = join(
  homedir(),
  'Library', 'CloudStorage', 'OneDrive-Personal', 'cowork-tasks',
);

/**
 * Resolve all bridge dir paths.
 * Pure function — no fs access. Caller uses ensureDir() before write.
 *
 * Default layout (atlas's spec):
 *   ~/Library/CloudStorage/OneDrive-Personal/cowork-tasks/
 *     ├── pending/      (cortextOS writes requests; Cowork reads)
 *     ├── in-progress/  (Cowork moves claimed requests here)
 *     ├── completed/    (Cowork moves successful results here)
 *     └── failed/       (Cowork or janitor moves failed/timeout here)
 *
 * `ctxRoot` is still accepted for API compatibility but is IGNORED in the
 * default path. Pass rootOverride to use a non-OneDrive location (tests,
 * sandbox runs).
 */
export function resolveBridgePaths(_ctxRoot: string, rootOverride?: string): BridgePaths {
  const root = rootOverride || DEFAULT_BRIDGE_ROOT;
  return {
    root,
    outbound: join(root, 'pending'),
    processing: join(root, 'in-progress'),
    processed: join(root, 'completed'),
    failed: join(root, 'failed'),
  };
}
