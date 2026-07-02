'use client';

import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { IconCheck, IconX, IconLoader2 } from '@tabler/icons-react';
import type { AgentSummary, Heartbeat, Approval } from '@/lib/types';

interface FleetStripProps {
  agents: AgentSummary[];
  heartbeats: Heartbeat[];
  pendingApprovals: Approval[];
}

/**
 * Zone 4 — Fleet strip (bottom, always visible).
 * One chip per agent: name, heartbeat dot, pending-approvals badge.
 * Inline Approve/Reject buttons for each pending approval — 1-tap via
 * the existing /api/approvals/[id] PATCH endpoint.
 */
export function FleetStrip({ agents, heartbeats, pendingApprovals }: FleetStripProps) {
  const hbByAgent = new Map(heartbeats.map((h) => [h.agent, h]));
  const approvalsByAgent = new Map<string, Approval[]>();
  for (const a of pendingApprovals) {
    const key = a.agent ?? '(unassigned)';
    if (!approvalsByAgent.has(key)) approvalsByAgent.set(key, []);
    approvalsByAgent.get(key)!.push(a);
  }

  return (
    <Card className="sticky bottom-0 bg-card/95 backdrop-blur">
      <CardContent className="pt-3 pb-3">
        <div className="flex items-center gap-4 overflow-x-auto">
          {agents.map((agent) => {
            const hb = hbByAgent.get(agent.name);
            const pending = approvalsByAgent.get(agent.name) ?? [];
            return (
              <AgentChip
                key={agent.name}
                agent={agent}
                heartbeat={hb ?? null}
                pending={pending}
              />
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function AgentChip({
  agent,
  heartbeat,
  pending,
}: {
  agent: AgentSummary;
  heartbeat: Heartbeat | null;
  pending: Approval[];
}) {
  const [expanded, setExpanded] = useState(false);
  const status = healthDot(heartbeat);

  return (
    <div className="flex-none">
      <button
        type="button"
        onClick={() => pending.length > 0 && setExpanded((v) => !v)}
        className={`flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-muted/20 hover:bg-muted/40 transition-colors ${
          pending.length > 0 ? 'cursor-pointer' : 'cursor-default'
        }`}
      >
        <span className="text-lg" aria-hidden>🔹</span>
        <span className="text-sm font-medium">{agent.name}</span>
        <span
          className={`inline-block w-2 h-2 rounded-full ${status.color}`}
          aria-label={status.label}
          title={status.label}
        />
        {pending.length > 0 && (
          <span className="ml-1 text-xs font-semibold px-1.5 py-0.5 rounded-full bg-red-500/20 text-red-300 border border-red-500/40">
            {pending.length}
          </span>
        )}
      </button>

      {expanded && pending.length > 0 && (
        <div className="absolute mt-2 bg-popover border border-border rounded-lg shadow-lg p-2 space-y-2 z-10 min-w-72">
          {pending.map((a) => (
            <ApprovalRow key={a.id} approval={a} onDone={() => setExpanded(false)} />
          ))}
        </div>
      )}
    </div>
  );
}

function ApprovalRow({ approval, onDone }: { approval: Approval; onDone: () => void }) {
  const [busy, setBusy] = useState<null | 'approve' | 'reject'>(null);

  async function act(action: 'approve' | 'reject') {
    setBusy(action);
    try {
      const res = await fetch(`/api/approvals/${approval.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (res.ok) {
        onDone();
        window.location.reload();
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="text-sm space-y-2 p-2">
      <div className="font-medium leading-tight">{approval.title ?? approval.description ?? approval.category}</div>
      {approval.description && (
        <div className="text-xs text-muted-foreground line-clamp-2">{approval.description}</div>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={() => act('approve')}
          disabled={busy !== null}
          className="bg-green-600 hover:bg-green-700"
        >
          {busy === 'approve' ? <IconLoader2 className="w-4 h-4 animate-spin" /> : <IconCheck className="w-4 h-4 mr-1" />}
          Approve
        </Button>
        <Button
          size="sm"
          variant="destructive"
          onClick={() => act('reject')}
          disabled={busy !== null}
        >
          {busy === 'reject' ? <IconLoader2 className="w-4 h-4 animate-spin" /> : <IconX className="w-4 h-4 mr-1" />}
          Reject
        </Button>
      </div>
    </div>
  );
}

function healthDot(hb: Heartbeat | null): { color: string; label: string } {
  if (!hb) return { color: 'bg-slate-500', label: 'no heartbeat' };
  const ts = hb.last_heartbeat;
  if (!ts) return { color: 'bg-slate-500', label: 'no timestamp' };
  const ageMin = (Date.now() - new Date(ts).getTime()) / 60000;
  if (ageMin > 1440) return { color: 'bg-red-500', label: 'down' };
  if (ageMin > 300) return { color: 'bg-yellow-500', label: 'stale' };
  return { color: 'bg-green-500', label: 'healthy' };
}
