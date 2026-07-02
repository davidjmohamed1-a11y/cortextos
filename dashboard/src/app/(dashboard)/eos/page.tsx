/**
 * /eos — the ADHD-first EOS whiteboard view.
 *
 * 4 zones + streak (top-right subtle):
 *   1. NOW card (biggest, always visible)
 *   2. Today lane (Morning / Midday / Evening / Rocks)
 *   3. Strategy zone (Matrix + Projects, COLLAPSED by default)
 *   4. Fleet strip (heartbeat + 1-tap approve/reject on pending)
 *
 * Server-side render, revalidates every 5s so it stays fresh without
 * client-side polling churn.
 *
 * Spec: orgs/personal/agents/forge/specs/dashboard-eos-whiteboard-2026-07-02.md
 */
import { NowCard } from '@/components/eos/now-card';
import { TodayLane } from '@/components/eos/today-lane';
import { StrategyZone } from '@/components/eos/strategy-zone';
import { FleetStrip } from '@/components/eos/fleet-strip';
import { CompletionStreak } from '@/components/eos/completion-streak';

import { getEosNow } from '@/lib/data/eos';
import { getCompletionStreak } from '@/lib/data/streaks';
import { getTasks } from '@/lib/data/tasks';
import { getGoals } from '@/lib/data/goals';
import { getAllHeartbeats } from '@/lib/data/heartbeats';
import { getPendingApprovals } from '@/lib/data/approvals';
import { discoverAgents } from '@/lib/data/agents';

export const dynamic = 'force-dynamic';
export const revalidate = 5;

export default async function EosPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const orgParam = typeof params.org === 'string' ? params.org : '';

  // Pull everything we need in parallel — the dashboard's existing pattern.
  const [now, streak, tasks, goals, heartbeats, pendingApprovals, agents] = await Promise.all([
    getEosNow(),
    getCompletionStreak(orgParam),
    getTasks(orgParam ? { org: orgParam } : undefined),
    getGoals(orgParam),
    getAllHeartbeats(),
    getPendingApprovals(orgParam),
    discoverAgents(orgParam),
  ]);

  return (
    <div className="flex flex-col gap-6 pb-24">
      {/* Streak badge — subtle, top-right */}
      <div className="flex justify-end -mb-2">
        <CompletionStreak streak={streak} />
      </div>

      {/* Zone 1 — NOW card (biggest, always visible) */}
      <NowCard now={now} openTasks={tasks.filter((t) => t.status !== 'completed')} />

      {/* Zone 2 — Today lane */}
      <TodayLane tasks={tasks} goals={goals} />

      {/* Zone 3 — Strategy zone (COLLAPSED by default) */}
      <StrategyZone tasks={tasks} />

      {/* Zone 4 — Fleet strip (bottom, always visible) */}
      <FleetStrip agents={agents} heartbeats={heartbeats} pendingApprovals={pendingApprovals} />
    </div>
  );
}
