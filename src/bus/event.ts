import { appendFileSync } from 'fs';
import { join } from 'path';
import type { EventCategory, EventSeverity, BusPaths } from '../types/index.js';
import { ensureDir } from '../utils/atomic.js';
import { randomString } from '../utils/random.js';
import { validateEventCategory, validateEventSeverity, isValidJson } from '../utils/validate.js';
import { refreshHeartbeatTimestamp } from './heartbeat.js';

/**
 * Log a structured event. Appends JSONL line to daily event file.
 * Identical to bash log-event.sh format.
 *
 * Events are stored at: {analyticsDir}/events/{agent}/{YYYY-MM-DD}.jsonl
 *
 * Side-effect: if this agent has an existing heartbeat.json, refresh its
 * `last_heartbeat` timestamp. Activity is liveness — if the agent is
 * logging events, it is by definition alive, so the stale-heartbeat
 * monitor should not page on it. Other fields (status, mode, etc.) are
 * preserved from the last explicit update-heartbeat call. Best-effort:
 * a failing heartbeat refresh never blocks the event write itself.
 * If no heartbeat file exists yet we do nothing — the first
 * update-heartbeat call creates it with full field values.
 */
export function logEvent(
  paths: BusPaths,
  agentName: string,
  org: string,
  category: EventCategory,
  eventName: string,
  severity: EventSeverity,
  metadata?: Record<string, unknown> | string,
): void {
  validateEventCategory(category);
  validateEventSeverity(severity);

  // Parse metadata if it's a string
  let meta: Record<string, unknown> = {};
  if (typeof metadata === 'string') {
    if (isValidJson(metadata)) {
      meta = JSON.parse(metadata);
    }
  } else if (metadata) {
    meta = metadata;
  }

  const epoch = Math.floor(Date.now() / 1000);
  const rand = randomString(5);
  const eventId = `${epoch}-${agentName}-${rand}`;
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const eventsDir = join(paths.analyticsDir, 'events', agentName);
  ensureDir(eventsDir);

  const eventLine = JSON.stringify({
    id: eventId,
    agent: agentName,
    org,
    timestamp,
    category,
    event: eventName,
    severity,
    metadata: meta,
  });

  appendFileSync(join(eventsDir, `${today}.jsonl`), eventLine + '\n', 'utf-8');

  // Refresh heartbeat timestamp as a side-effect. See doc comment above.
  refreshHeartbeatTimestamp(paths.stateDir, timestamp);
}
