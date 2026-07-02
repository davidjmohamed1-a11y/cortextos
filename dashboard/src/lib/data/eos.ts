// cortextOS Dashboard — EOS whiteboard data layer.
//
// State file: <ctxRoot>/state/eos/now.json
// Shape:
//   { title: string, next_action: string, set_at: string (ISO), set_by: string }
//
// Ships 2026-07-02 (dashboard V1 per boss GO). Reads/writes are best-effort;
// caller gets a well-typed null when the state is unset. Writes atomic via
// tempfile+rename so partial writes never surface to reads.

import fs from 'fs/promises';
import path from 'path';
import { CTX_ROOT } from '@/lib/config';

export interface EosNow {
  title: string;
  next_action: string;
  set_at: string;
  set_by: string;
  /** Task id the NOW derived from, if auto-populated. */
  from_task_id?: string;
}

function nowFilePath(): string {
  return path.join(CTX_ROOT, 'state', 'eos', 'now.json');
}

/**
 * Read the current NOW card state. Returns null if unset (empty state).
 * Never throws — caller shows the empty inline editor when null.
 */
export async function getEosNow(): Promise<EosNow | null> {
  try {
    const raw = await fs.readFile(nowFilePath(), 'utf-8');
    const parsed = JSON.parse(raw) as EosNow;
    if (typeof parsed?.title !== 'string' || !parsed.title.trim()) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Persist a new NOW. Atomic via tempfile+rename. Ensures the parent dir
 * exists on first call.
 */
export async function setEosNow(input: Omit<EosNow, 'set_at'>): Promise<EosNow> {
  const target = nowFilePath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  const payload: EosNow = {
    ...input,
    set_at: new Date().toISOString(),
  };
  const tmp = target + '.tmp.' + Math.random().toString(16).slice(2);
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
  await fs.rename(tmp, target);
  return payload;
}

/**
 * Get the schedule for today (if the user maintains a schedule file).
 * V1: reads <ctxRoot>/state/eos/schedule.json when it exists; returns empty
 * array otherwise. V2 will wire to a real calendar source.
 */
export interface ScheduleEntry {
  title: string;
  start: string;  // ISO or "HH:MM" for V1
  end?: string;
  slot: 'morning' | 'midday' | 'evening';
  notes?: string;
}

export async function getScheduleForToday(): Promise<ScheduleEntry[]> {
  const p = path.join(CTX_ROOT, 'state', 'eos', 'schedule.json');
  try {
    const raw = await fs.readFile(p, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e) => e && typeof e.title === 'string' && ['morning', 'midday', 'evening'].includes(e.slot));
  } catch {
    return [];
  }
}
