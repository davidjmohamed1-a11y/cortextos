'use client';

import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { IconChevronRight, IconChevronDown, IconLayout2, IconFolders } from '@tabler/icons-react';
import type { Task } from '@/lib/types';

interface Props {
  tasks: Task[];
}

/**
 * Zone 3 — Strategy. COLLAPSED by default (progressive disclosure).
 * Two toggles: Matrix (Eisenhower 2×2) | Projects (per-project lanes).
 */
export function StrategyZone({ tasks }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [mode, setMode] = useState<'matrix' | 'projects'>('matrix');

  const open = tasks.filter((t) => t.status !== 'completed');

  return (
    <Card>
      <CardContent className="pt-4">
        <button
          type="button"
          className="w-full flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? <IconChevronDown className="w-4 h-4" /> : <IconChevronRight className="w-4 h-4" />}
          Strategy
          <span className="ml-2 text-muted-foreground/60 normal-case font-normal">
            ({open.length} open · click to {expanded ? 'collapse' : 'expand'})
          </span>
        </button>

        {expanded && (
          <div className="mt-4">
            <div className="flex gap-2 mb-4">
              <Button
                variant={mode === 'matrix' ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setMode('matrix')}
              >
                <IconLayout2 className="w-4 h-4 mr-1" />
                Matrix
              </Button>
              <Button
                variant={mode === 'projects' ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setMode('projects')}
              >
                <IconFolders className="w-4 h-4 mr-1" />
                Projects
              </Button>
            </div>
            {mode === 'matrix' ? <MatrixView tasks={open} /> : <ProjectsView tasks={open} />}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function MatrixView({ tasks }: { tasks: Task[] }) {
  // Eisenhower: urgent × important.
  // Heuristic (V1): urgent = priority in {critical, urgent}; important = priority in {critical, urgent, high} OR has a project.
  const urgent = (t: Task) => t.priority === 'critical' || t.priority === 'urgent';
  const important = (t: Task) => urgent(t) || t.priority === 'high' || !!t.project;

  const q1 = tasks.filter((t) => urgent(t) && important(t));
  const q2 = tasks.filter((t) => !urgent(t) && important(t));
  const q3 = tasks.filter((t) => urgent(t) && !important(t));
  const q4 = tasks.filter((t) => !urgent(t) && !important(t));

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <Quadrant title="Do Now" subtitle="Urgent + Important" accent="text-red-400" items={q1} />
      <Quadrant title="Schedule" subtitle="Important, not Urgent" accent="text-blue-400" items={q2} />
      <Quadrant title="Delegate" subtitle="Urgent, not Important" accent="text-yellow-400" items={q3} />
      <Quadrant title="Drop / Batch" subtitle="Neither" accent="text-muted-foreground" items={q4} />
    </div>
  );
}

function Quadrant({
  title,
  subtitle,
  accent,
  items,
}: {
  title: string;
  subtitle: string;
  accent: string;
  items: Task[];
}) {
  return (
    <div className="rounded-lg border border-border p-3 bg-muted/10">
      <div className={`text-sm font-semibold mb-0.5 ${accent}`}>{title}</div>
      <div className="text-xs text-muted-foreground/70 mb-2">{subtitle}</div>
      {items.length === 0 ? (
        <div className="text-xs text-muted-foreground/50 italic">Empty</div>
      ) : (
        <ul className="space-y-1">
          {items.slice(0, 5).map((t) => (
            <li key={t.id} className="text-sm truncate">
              {t.title}
            </li>
          ))}
          {items.length > 5 && (
            <li className="text-xs text-muted-foreground/60">+ {items.length - 5} more</li>
          )}
        </ul>
      )}
    </div>
  );
}

function ProjectsView({ tasks }: { tasks: Task[] }) {
  // Group by project. Tasks with no project go into "(unassigned)".
  const byProject = new Map<string, Task[]>();
  for (const t of tasks) {
    const p = t.project?.trim() || '(unassigned)';
    if (!byProject.has(p)) byProject.set(p, []);
    byProject.get(p)!.push(t);
  }
  const rows = Array.from(byProject.entries()).sort((a, b) => b[1].length - a[1].length);

  if (rows.length === 0) {
    return <div className="text-sm text-muted-foreground/50 italic">No projects</div>;
  }

  return (
    <div className="space-y-3">
      {rows.map(([project, items]) => (
        <div key={project} className="rounded-lg border border-border p-3 bg-muted/10">
          <div className="text-sm font-semibold text-foreground mb-2 flex items-center gap-2">
            {project}
            <span className="text-xs text-muted-foreground/60 font-normal">({items.length})</span>
          </div>
          <ul className="space-y-1">
            {items.slice(0, 4).map((t) => (
              <li key={t.id} className="text-sm truncate flex items-center gap-2">
                <PriorityDot priority={t.priority ?? 'normal'} />
                <span>{t.title}</span>
              </li>
            ))}
            {items.length > 4 && (
              <li className="text-xs text-muted-foreground/60">+ {items.length - 4} more</li>
            )}
          </ul>
        </div>
      ))}
    </div>
  );
}

function PriorityDot({ priority }: { priority: string }) {
  const color = priority === 'critical' ? 'bg-red-500' :
                priority === 'urgent' ? 'bg-orange-500' :
                priority === 'high' ? 'bg-yellow-500' :
                priority === 'low' ? 'bg-slate-500' : 'bg-blue-500';
  return <span className={`inline-block w-1.5 h-1.5 rounded-full ${color}`} aria-label={priority} />;
}
