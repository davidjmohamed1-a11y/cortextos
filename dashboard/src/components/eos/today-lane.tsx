import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { IconSun, IconSunFilled, IconMoon, IconMountain } from '@tabler/icons-react';
import type { Task, GoalsData } from '@/lib/types';

interface TodayLaneProps {
  tasks: Task[];
  goals: GoalsData;
}

/**
 * Zone 2 — Today lane. Morning / Midday / Evening / Rocks.
 * Client-side day-bucket derivation from task shape (no calendar wired in V1).
 */
export function TodayLane({ tasks, goals }: TodayLaneProps) {
  const openToday = tasks.filter((t) => t.status !== 'completed');

  const priorityRank: Record<string, number> = { critical: 0, urgent: 1, high: 2, normal: 3, low: 4 };
  const byPri = (a: Task, b: Task) =>
    (priorityRank[a.priority ?? 'normal'] ?? 3) - (priorityRank[b.priority ?? 'normal'] ?? 3);

  const morning = openToday.filter(isMorningTask).sort(byPri).slice(0, 6);
  const midday = openToday.filter(isMiddayTask).sort(byPri).slice(0, 6);
  const evening = openToday.filter(isEveningTask).sort(byPri).slice(0, 6);
  const activeGoals = (goals?.goals ?? []).slice(0, 5);

  return (
    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
      <LaneColumn
        icon={<IconSun className="w-4 h-4" />}
        title="Morning"
        subtitle="Deep-work + urgent"
        items={morning}
      />
      <LaneColumn
        icon={<IconSunFilled className="w-4 h-4" />}
        title="Midday"
        subtitle="Meetings + comms"
        items={midday}
      />
      <LaneColumn
        icon={<IconMoon className="w-4 h-4" />}
        title="Evening"
        subtitle="Review + admin"
        items={evening}
      />
      <RocksColumn goals={activeGoals} />
    </div>
  );
}

function LaneColumn({
  icon,
  title,
  subtitle,
  items,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  items: Task[];
}) {
  return (
    <Card>
      <CardContent className="pt-4">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">
          {icon}
          {title}
        </div>
        <div className="text-xs text-muted-foreground/60 mb-3">{subtitle}</div>
        {items.length === 0 ? (
          <div className="text-sm text-muted-foreground/50 italic">Nothing scheduled</div>
        ) : (
          <ul className="space-y-2">
            {items.map((t) => (
              <li key={t.id} className="text-sm leading-snug">
                <PriorityDot priority={t.priority ?? 'normal'} />
                <span className="ml-2">{t.title}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function RocksColumn({ goals }: { goals: Array<{ id: string; title: string; progress?: number; status?: string }> }) {
  return (
    <Card>
      <CardContent className="pt-4">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">
          <IconMountain className="w-4 h-4" />
          Rocks
        </div>
        <div className="text-xs text-muted-foreground/60 mb-3">This-quarter goals</div>
        {goals.length === 0 ? (
          <div className="text-sm text-muted-foreground/50 italic">No active rocks</div>
        ) : (
          <ul className="space-y-3">
            {goals.map((g) => (
              <li key={g.id} className="text-sm leading-snug">
                <div className="mb-1">{g.title}</div>
                <Progress value={Math.max(0, Math.min(100, g.progress ?? 0))} className="h-1.5" />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function PriorityDot({ priority }: { priority: string }) {
  const color = priority === 'critical' ? 'bg-red-500' :
                priority === 'urgent' ? 'bg-orange-500' :
                priority === 'high' ? 'bg-yellow-500' :
                priority === 'low' ? 'bg-slate-500' : 'bg-blue-500';
  return <span className={`inline-block w-2 h-2 rounded-full align-middle ${color}`} aria-label={priority} />;
}

// Simple V1 slot heuristic — priority-based, no due-time parsing.
// The bus doesn't have a "time-of-day" field. V2 will wire the schedule
// file + calendar. For V1, high-priority goes morning, human-tasks midday,
// admin-tagged evening; everything else is a fallback in Morning.
function isMorningTask(t: Task): boolean {
  const pri = t.priority ?? 'normal';
  const isDeepish = pri === 'critical' || pri === 'urgent' || pri === 'high';
  return isDeepish && !isEveningTask(t);
}
function isMiddayTask(t: Task): boolean {
  const title = (t.title ?? '').toLowerCase();
  return /call|meet|zoom|standup|touchbase|1-?on-?1|sync/.test(title);
}
function isEveningTask(t: Task): boolean {
  const title = (t.title ?? '').toLowerCase();
  return /admin|inbox|review|log|report|end-?of-?day|eod/.test(title);
}
