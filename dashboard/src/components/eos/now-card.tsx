'use client';

import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { IconTarget, IconEdit, IconCheck, IconX } from '@tabler/icons-react';
import type { EosNow } from '@/lib/data/eos';
import type { Task } from '@/lib/types';

interface NowCardProps {
  now: EosNow | null;
  openTasks: Task[];
}

/**
 * NOW card — Zone 1 of the EOS whiteboard.
 * The biggest thing on the page. David's one current focus.
 *
 * Auto-populate rule (V1 default per boss GO): if `now` is null, derive
 * from the highest-priority in-progress task. David can override inline.
 */
export function NowCard({ now, openTasks }: NowCardProps) {
  const [editing, setEditing] = useState(false);

  // Auto-derive when nothing is set yet.
  const displayNow: EosNow | null = now ?? deriveFromOpenTasks(openTasks);

  return (
    <Card className="border-2 border-primary/40 bg-gradient-to-b from-primary/5 to-transparent">
      <CardContent className="pt-8 pb-8">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="text-xs font-semibold uppercase tracking-widest text-primary/80 mb-3 flex items-center gap-2">
              <IconTarget className="w-4 h-4" />
              Now
            </div>
            {editing ? (
              <NowEditor
                initial={displayNow}
                onSaved={() => setEditing(false)}
                onCancel={() => setEditing(false)}
              />
            ) : displayNow ? (
              <>
                <div className="text-3xl font-bold leading-tight text-foreground mb-2">
                  {displayNow.title}
                </div>
                {displayNow.next_action && (
                  <div className="text-lg text-muted-foreground">
                    Next: <span className="text-foreground/90">{displayNow.next_action}</span>
                  </div>
                )}
                {now === null && displayNow.from_task_id && (
                  <div className="text-xs text-muted-foreground/70 mt-2">
                    Auto-derived from {displayNow.from_task_id.slice(0, 20)}… (override anytime)
                  </div>
                )}
              </>
            ) : (
              <div className="text-xl text-muted-foreground italic">
                Nothing set. What&apos;s the ONE thing right now?
              </div>
            )}
          </div>
          {!editing && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setEditing(true)}
              aria-label="Edit NOW"
            >
              <IconEdit className="w-5 h-5" />
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function NowEditor({
  initial,
  onSaved,
  onCancel,
}: {
  initial: EosNow | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [nextAction, setNextAction] = useState(initial?.next_action ?? '');
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!title.trim()) return;
    setSaving(true);
    try {
      const res = await fetch('/api/eos/now', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), next_action: nextAction.trim() }),
      });
      if (res.ok) {
        // Refresh the page so server-side render pulls the new state.
        window.location.reload();
      } else {
        setSaving(false);
      }
    } catch {
      setSaving(false);
    }
    onSaved();
  }

  return (
    <div className="space-y-3">
      <Input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="The one thing"
        className="text-2xl font-semibold h-12"
        onKeyDown={(e) => {
          if (e.key === 'Enter') save();
          if (e.key === 'Escape') onCancel();
        }}
        disabled={saving}
      />
      <Input
        value={nextAction}
        onChange={(e) => setNextAction(e.target.value)}
        placeholder="Next concrete step (optional)"
        className="text-base"
        onKeyDown={(e) => {
          if (e.key === 'Enter') save();
          if (e.key === 'Escape') onCancel();
        }}
        disabled={saving}
      />
      <div className="flex gap-2">
        <Button size="sm" onClick={save} disabled={saving || !title.trim()}>
          <IconCheck className="w-4 h-4 mr-1" />
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
          <IconX className="w-4 h-4 mr-1" />
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * Auto-derive rule (V1): pick the highest-priority in_progress task; if
 * none in_progress, pick the highest-priority open/pending task. Priority
 * order: critical > urgent > high > normal > low.
 */
function deriveFromOpenTasks(openTasks: Task[]): EosNow | null {
  if (!openTasks.length) return null;
  const priorityRank: Record<string, number> = { critical: 0, urgent: 1, high: 2, normal: 3, low: 4 };
  const rank = (t: Task) => priorityRank[t.priority ?? 'normal'] ?? 3;
  const inProgress = openTasks.filter((t) => t.status === 'in_progress');
  const pool = inProgress.length > 0 ? inProgress : openTasks;
  const best = [...pool].sort((a, b) => rank(a) - rank(b))[0];
  if (!best) return null;
  return {
    title: best.title,
    next_action: '',
    set_at: new Date().toISOString(),
    set_by: 'auto',
    from_task_id: best.id,
  };
}
