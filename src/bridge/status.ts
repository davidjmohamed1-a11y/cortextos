/**
 * Bridge — Status (state inspection)
 *
 * Pure read-only. Determines bridge request state by which dir holds the file.
 * Never moves or deletes files. Safe to call from multiple agents concurrently.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import type { BridgePaths, BridgeRequest, BridgeStatus } from './types.js';

/**
 * State machine: which dir holds <id>.json determines the status.
 *
 *   pending/<id>.json       → 'queued'
 *   in-progress/<id>.json   → 'in_progress'
 *   completed/<id>.json     → 'completed'
 *   failed/<id>.json        → 'failed'
 *   (none of the above)     → 'unknown' (could be timed-out + janitor-cleaned, or never existed)
 */
export function getBridgeStatus(paths: BridgePaths, requestId: string): BridgeStatus {
  const filename = `${requestId}.json`;
  if (existsSync(join(paths.outbound, filename))) return 'queued';
  if (existsSync(join(paths.processing, filename))) return 'in_progress';
  if (existsSync(join(paths.processed, filename))) return 'completed';
  if (existsSync(join(paths.failed, filename))) return 'failed';
  return 'unknown';
}

export interface BridgeRequestSummary {
  id: string;
  fromAgent: string;
  status: BridgeStatus;
  createdAt: string;
  description: string;
  requestType: string;
}

/**
 * List all bridge requests across all states. Best-effort: a malformed JSON
 * file is skipped silently rather than throwing (the alternative — failing
 * the whole list call because one Cowork-side file is corrupt — would hide
 * every other healthy request).
 */
export function listBridgeRequests(paths: BridgePaths): BridgeRequestSummary[] {
  const summaries: BridgeRequestSummary[] = [];
  const dirs: Array<[string, BridgeStatus]> = [
    [paths.outbound, 'queued'],
    [paths.processing, 'in_progress'],
    [paths.processed, 'completed'],
    [paths.failed, 'failed'],
  ];
  for (const [dir, status] of dirs) {
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('.'));
    } catch {
      continue;
    }
    for (const file of entries) {
      const fullPath = join(dir, file);
      try {
        const stat = statSync(fullPath);
        if (!stat.isFile()) continue;
        const req: BridgeRequest = JSON.parse(readFileSync(fullPath, 'utf-8'));
        summaries.push({
          id: req.id,
          fromAgent: req.from_agent,
          status,
          createdAt: req.created_at,
          description: req.description,
          requestType: req.request_type,
        });
      } catch {
        // Malformed file — skip. Janitor will eventually surface it via stale sweep.
      }
    }
  }
  // Sort by createdAt descending (newest first) for readable CLI output.
  summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return summaries;
}
