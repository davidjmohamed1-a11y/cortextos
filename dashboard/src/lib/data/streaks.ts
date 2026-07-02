// cortextOS Dashboard — Completion-streak helper.
//
// Reads task.completed_at timestamps, groups by UTC day, and returns
// current streak + all-time best. 24h grace on misses (per boss spec
// 2026-07-02: streak-recovery from a hard day matters more than pure
// clock accuracy).

import { db } from '@/lib/db';

export interface CompletionStreak {
  current: number;
  best: number;
  today_count: number;
  last_completion_date?: string;  // YYYY-MM-DD
}

function isoDate(ts: number | string): string {
  const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
  return d.toISOString().slice(0, 10);
}

/**
 * Compute streak from all completed tasks in the DB. Optional `org` filter
 * scopes to a single org; empty/undefined = fleet-wide.
 *
 * 24h grace rule: if the most-recent completion was TODAY or YESTERDAY, the
 * streak counts up through today. Older gap = streak reset.
 */
export async function getCompletionStreak(org?: string): Promise<CompletionStreak> {
  try {
    const where = org ? 'WHERE org = ? AND completed_at IS NOT NULL' : 'WHERE completed_at IS NOT NULL';
    const params = org ? [org] : [];
    const rows = db
      .prepare(`SELECT completed_at FROM tasks ${where} ORDER BY completed_at DESC`)
      .all(...params) as Array<{ completed_at: string | number }>;

    if (rows.length === 0) return { current: 0, best: 0, today_count: 0 };

    const daysSet = new Set<string>();
    const dayCounts = new Map<string, number>();
    for (const r of rows) {
      const d = isoDate(r.completed_at);
      daysSet.add(d);
      dayCounts.set(d, (dayCounts.get(d) ?? 0) + 1);
    }
    const days = Array.from(daysSet).sort().reverse(); // newest first

    // Today + yesterday markers.
    const today = isoDate(Date.now());
    const yesterday = isoDate(Date.now() - 24 * 60 * 60 * 1000);

    // Current streak from most-recent day, walking backwards.
    let current = 0;
    if (days[0] === today || days[0] === yesterday) {
      // Grace: start counting from today either way, walking back through days.
      let cursor = new Date();
      if (days[0] === yesterday) {
        cursor.setUTCDate(cursor.getUTCDate() - 1); // start streak count from yesterday
      }
      while (true) {
        const cursorIso = isoDate(cursor.getTime());
        if (daysSet.has(cursorIso)) {
          current += 1;
          cursor.setUTCDate(cursor.getUTCDate() - 1);
        } else {
          break;
        }
      }
    }

    // Best streak: walk the sorted days looking for longest consecutive run.
    let best = 0;
    let runLen = 0;
    let prevDate: Date | null = null;
    for (const d of Array.from(daysSet).sort()) {
      const dt = new Date(d + 'T00:00:00.000Z');
      if (prevDate && dt.getTime() - prevDate.getTime() === 24 * 60 * 60 * 1000) {
        runLen += 1;
      } else {
        runLen = 1;
      }
      if (runLen > best) best = runLen;
      prevDate = dt;
    }

    return {
      current,
      best,
      today_count: dayCounts.get(today) ?? 0,
      last_completion_date: days[0],
    };
  } catch (err) {
    console.error('[data/streaks] getCompletionStreak error:', err);
    return { current: 0, best: 0, today_count: 0 };
  }
}
