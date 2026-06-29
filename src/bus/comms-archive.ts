/**
 * comms-archive.ts — durable structured archive of every message the fleet
 * sends or receives. Per-agent JSONL per month under
 *   <ctxRoot>/analytics/comms/<YYYY-MM>/<agent>.jsonl
 *
 * Status: V1 build per Group C C6 (David standing priority on the broader
 * Group C). Spec source:
 *   orgs/personal/agents/forge/specs/comms-archive-2026-06-29.md
 *
 * Design contract:
 * - One append per logical message (one inbound or one outbound).
 * - Schema CommsArchiveEntry; version field future-proofs schema drift.
 * - Atomic append (single fs.appendFileSync line) — concurrent-write safe at
 *   one-message granularity; we never edit existing lines.
 * - Append errors are LOGGED but NOT thrown — favor send-path liveness over
 *   archive correctness. Lost archive entries are recoverable via downstream
 *   sources (Telegram chat history, inbox file dirs, event logs); a thrown
 *   error would break the user-facing comms path.
 *
 * Hot-paths wired in this module's V1:
 *   - src/bus/message.ts sendMessage     → channel='agent_bus', direction='outbound'
 *   - src/bus/message.ts checkInbox      → channel='agent_bus', direction='inbound'
 *   - src/cli/bus.ts    send-telegram    → channel='telegram',  direction='outbound'
 *   - src/daemon/fast-checker.ts inbound → channel='telegram',  direction='inbound'
 */

import { appendFileSync, existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { ensureDir } from '../utils/atomic.js';

export const COMMS_ARCHIVE_SCHEMA_VERSION = 1;

/** Categories of comms surface. New surfaces add a new union member. */
export type CommsChannel = 'telegram' | 'agent_bus' | 'bridge' | 'cron' | 'system';

export interface CommsArchiveEntry {
  /** Schema version (start at 1; bump on any non-additive change). */
  version: number;
  /** Unique entry id (epoch-ms + 6 hex rand, distinct from msg_id which is service-specific). */
  id: string;
  /** Which agent's archive this entry belongs to (the perspective). */
  agent: string;
  /** Whether the agent sent or received this message. */
  direction: 'inbound' | 'outbound';
  /** Categorical channel for filtering. */
  channel: CommsChannel;
  /** Sender identifier (agent name, telegram chat id, 'system', etc.). */
  sender: string;
  /** Recipient identifier (agent name, telegram chat id, etc.). */
  recipient: string;
  /** ISO 8601 timestamp of when the message was sent/received. */
  timestamp: string;
  /** Message body, plain text. Long bodies are NOT truncated by the archive
   *  itself — search/display layers truncate at their own discretion. */
  text: string;
  /** Service-side message id when applicable (telegram message_id,
   *  inbox-message id, bridge request id). Empty string when none. */
  msg_id: string;
  /** Reply-target id, empty string when none. */
  reply_to: string;
  /** Free-form per-channel metadata (voice transcript path, attachment URLs,
   *  cron name, bridge request type, etc.). */
  metadata: Record<string, unknown>;
}

function ymOf(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function archiveDirFor(ctxRoot: string, yyyymm: string): string {
  return join(ctxRoot, 'analytics', 'comms', yyyymm);
}

function archiveFileFor(ctxRoot: string, yyyymm: string, agent: string): string {
  return join(archiveDirFor(ctxRoot, yyyymm), `${agent}.jsonl`);
}

export interface AppendArgs {
  ctxRoot: string;
  agent: string;
  direction: 'inbound' | 'outbound';
  channel: CommsChannel;
  sender: string;
  recipient: string;
  timestamp?: string;
  text: string;
  msg_id?: string;
  reply_to?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Append one message to the agent's archive. Fire-and-forget: errors are
 * swallowed with a single console.warn so the calling hot-path is never
 * broken by archive failure.
 */
export function appendCommsArchive(args: AppendArgs): void {
  try {
    const timestamp = args.timestamp || new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z');
    const entry: CommsArchiveEntry = {
      version: COMMS_ARCHIVE_SCHEMA_VERSION,
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      agent: args.agent,
      direction: args.direction,
      channel: args.channel,
      sender: args.sender,
      recipient: args.recipient,
      timestamp,
      text: args.text,
      msg_id: args.msg_id || '',
      reply_to: args.reply_to || '',
      metadata: args.metadata || {},
    };
    const yyyymm = ymOf(timestamp);
    ensureDir(archiveDirFor(args.ctxRoot, yyyymm));
    appendFileSync(archiveFileFor(args.ctxRoot, yyyymm, args.agent), JSON.stringify(entry) + '\n');
  } catch (err) {
    // Best-effort. Lost archive line is recoverable from downstream sources.
    console.warn(`[comms-archive] append failed for ${args.agent}: ${(err as Error).message}`);
  }
}

export interface SearchArgs {
  ctxRoot: string;
  /** Filter to entries for this agent (perspective). Unset = scan all agents. */
  agent?: string;
  /** Filter to one direction. */
  direction?: 'inbound' | 'outbound';
  /** Filter to one channel. */
  channel?: CommsChannel;
  /** Substring match against text. Case-insensitive. */
  query?: string;
  /** ISO date inclusive lower bound (e.g. '2026-06-29'). */
  from?: string;
  /** ISO date inclusive upper bound (e.g. '2026-06-29' = end of that day). */
  to?: string;
  /** Cap results. Default: no cap. */
  limit?: number;
}

/**
 * Search the comms archive. Loads matching month-files into memory + linear
 * scan. For our scale (~thousands of messages/month per agent) this is fine.
 * If we ever cross 100k+ a month, swap for an indexed backend.
 */
export function searchCommsArchive(args: SearchArgs): CommsArchiveEntry[] {
  const root = join(args.ctxRoot, 'analytics', 'comms');
  if (!existsSync(root)) return [];

  const fromMs = args.from ? Date.parse(args.from + 'T00:00:00Z') : -Infinity;
  const toMs = args.to ? Date.parse(args.to + 'T23:59:59Z') : Infinity;
  const queryLower = args.query?.toLowerCase();

  // Months to scan = those overlapping [from, to]. For simplicity, scan all
  // present months and filter — cheap at our scale.
  let months: string[];
  try {
    months = readdirSync(root).filter(m => /^\d{4}-\d{2}$/.test(m)).sort().reverse();
  } catch {
    return [];
  }

  const results: CommsArchiveEntry[] = [];
  for (const month of months) {
    const monthDir = join(root, month);
    let files: string[];
    try {
      files = readdirSync(monthDir).filter(f => f.endsWith('.jsonl'));
    } catch { continue; }
    for (const file of files) {
      const agent = file.replace(/\.jsonl$/, '');
      if (args.agent && agent !== args.agent) continue;
      let content: string;
      try {
        content = readFileSync(join(monthDir, file), 'utf-8');
      } catch { continue; }
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        let entry: CommsArchiveEntry;
        try {
          entry = JSON.parse(line);
        } catch { continue; }
        if (args.direction && entry.direction !== args.direction) continue;
        if (args.channel && entry.channel !== args.channel) continue;
        const ts = Date.parse(entry.timestamp);
        if (Number.isFinite(ts) && (ts < fromMs || ts > toMs)) continue;
        if (queryLower && !entry.text.toLowerCase().includes(queryLower)) continue;
        results.push(entry);
        if (args.limit && results.length >= args.limit) return results;
      }
    }
  }
  return results;
}
