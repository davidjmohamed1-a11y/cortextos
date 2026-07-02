import { IconFlame } from '@tabler/icons-react';
import type { CompletionStreak as StreakData } from '@/lib/data/streaks';

interface Props {
  streak: StreakData;
}

/**
 * Subtle streak badge — top-right of the EOS whiteboard.
 *
 * Shows current streak with an accent color; empty state (streak=0) still
 * renders (nudge, not silence). Best-ever streak shown as a small subscript.
 */
export function CompletionStreak({ streak }: Props) {
  const active = streak.current > 0;
  return (
    <div
      className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium border ${
        active
          ? 'bg-amber-500/10 border-amber-500/40 text-amber-300'
          : 'bg-muted/30 border-border text-muted-foreground'
      }`}
      title={active ? `Best ever: ${streak.best} days` : "Complete a task today to start a streak"}
    >
      <IconFlame className={`w-4 h-4 ${active ? 'text-amber-400' : ''}`} />
      {active ? (
        <>
          <span className="tabular-nums">{streak.current}</span>
          <span className="text-xs text-muted-foreground">day streak</span>
          {streak.best > streak.current && (
            <span className="text-xs opacity-60 tabular-nums">/ best {streak.best}</span>
          )}
        </>
      ) : (
        <span>No streak yet</span>
      )}
    </div>
  );
}
