/**
 * CLI for the memory-quarantine channel — build #2 (Fable audit 2026-07-02).
 *
 * Web/bridge-derived content cannot land in standing memory directly (per the
 * hard-rule memory_write_needs_provenance + the design principle: nothing
 * external auto-promotes to prior-belief). Instead, agents call
 * `cortextos bus save-memory-quarantine` to stash the content in a review
 * queue at:
 *   <ctxRoot>/state/memory-quarantine/<agent>/<YYYY-MM-DD>/<id>.md
 *
 * David or boss reviews the queue and promotes valid items via
 * `cortextos bus promote-memory <id>` (this strips the quarantined flag +
 * moves the content to the standing-memory target).
 *
 * Three commands mounted on the `bus` command tree:
 *   save-memory-quarantine  — agents call this to stash web/bridge content
 *   list-quarantine         — operator lists pending review items
 *   promote-memory          — operator promotes an item to standing memory
 */

import { Command } from 'commander';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';

import { resolveEnv } from '../utils/env.js';
import { validateProvenance, quarantineDir } from '../utils/memory-provenance.js';

export function registerMemoryQuarantineCommands(parent: Command): void {
  parent
    .command('save-memory-quarantine')
    .description('Stash web/bridge-derived content into the memory-quarantine review queue. Never writes to standing memory directly. Requires --origin describing where the content came from (URL, bridge sender, etc.).')
    .argument('<agent>', "Agent whose quarantine dir this lands in (e.g. atlas, forge — usually $CTX_AGENT_NAME)")
    .requiredOption('--text <text>', 'The memory content to quarantine (frontmatter-plus-body; source: web-or-bridge line will be added if missing)')
    .requiredOption('--origin <origin>', 'Provenance origin: URL for WebFetch, sender for bridge, etc.')
    .option('--summary <summary>', 'One-line summary shown in list-quarantine (defaults to first 80 chars of --text)')
    .action((agent: string, opts: { text: string; origin: string; summary?: string }) => {
      const { ctxRoot } = resolveEnv();
      const today = new Date().toISOString().slice(0, 10);
      const dir = quarantineDir(ctxRoot, agent, today);
      mkdirSync(dir, { recursive: true });
      const id = `q-${Date.now()}-${randomBytes(3).toString('hex')}`;

      // Compose the file: enforce source=web-or-bridge in frontmatter regardless
      // of whether the caller included one. Add origin + quarantined markers.
      let body = opts.text;
      const existing = validateProvenance(body);
      if (existing.valid && existing.source !== 'web-or-bridge') {
        console.error(
          `save-memory-quarantine: refusing to quarantine content tagged source=${existing.source}. ` +
          `Quarantine is for web-or-bridge content only. If this content is source=david or ` +
          `source=agent-reasoning, write it directly to the standing-memory path (it will pass the ` +
          `memory_write_needs_provenance hard-rule).`,
        );
        process.exit(2);
      }

      const summary = opts.summary || body.replace(/---[\s\S]*?---\s*/, '').split('\n')[0].slice(0, 80);
      const stamped = `---
source: web-or-bridge
origin: ${opts.origin}
quarantined_at: ${new Date().toISOString()}
quarantined_by_agent: ${agent}
id: ${id}
summary: ${JSON.stringify(summary)}
---

${body.replace(/^---[\s\S]*?---\s*/, '')}`;

      const filePath = join(dir, `${id}.md`);
      writeFileSync(filePath, stamped, { mode: 0o600 });
      console.log(`save-memory-quarantine: OK → ${filePath}`);
    });

  parent
    .command('list-quarantine')
    .description('List pending memory-quarantine review items. Shows id + agent + origin + summary for each.')
    .option('--agent <agent>', 'Filter to one agent')
    .option('--since <YYYY-MM-DD>', 'Only show items from this date forward (default: last 30 days)')
    .option('--format <fmt>', 'json | text', 'text')
    .action((opts: { agent?: string; since?: string; format: string }) => {
      const { ctxRoot } = resolveEnv();
      const root = join(ctxRoot, 'state', 'memory-quarantine');
      if (!existsSync(root)) {
        if (opts.format === 'json') console.log('[]');
        else console.log('(no quarantine dir yet)');
        return;
      }
      const cutoff = opts.since || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const agents = opts.agent ? [opts.agent] : readdirSafe(root);
      const entries: Array<{ id: string; agent: string; date: string; path: string; origin: string; summary: string }> = [];

      for (const agent of agents) {
        const agentDir = join(root, agent);
        if (!existsSync(agentDir)) continue;
        const dates = readdirSafe(agentDir).filter((d) => d >= cutoff).sort();
        for (const date of dates) {
          const dayDir = join(agentDir, date);
          for (const f of readdirSafe(dayDir)) {
            if (!f.endsWith('.md')) continue;
            const full = join(dayDir, f);
            try {
              const meta = parseQuarantineMeta(readFileSync(full, 'utf-8'));
              entries.push({
                id: meta.id ?? f.replace(/\.md$/, ''),
                agent,
                date,
                path: full,
                origin: meta.origin ?? '(missing)',
                summary: meta.summary ?? '',
              });
            } catch {
              /* skip malformed */
            }
          }
        }
      }

      if (opts.format === 'json') {
        console.log(JSON.stringify(entries, null, 2));
        return;
      }
      if (entries.length === 0) {
        console.log('(no quarantine entries in the window)');
        return;
      }
      console.log(`${entries.length} quarantine entr${entries.length === 1 ? 'y' : 'ies'}:`);
      for (const e of entries) {
        console.log(`  ${e.id}  agent=${e.agent}  date=${e.date}`);
        console.log(`    origin: ${e.origin}`);
        console.log(`    summary: ${e.summary}`);
        console.log(`    path: ${e.path}`);
      }
    });

  parent
    .command('promote-memory')
    .description('Promote a quarantined memory entry to a standing-memory path. Strips the quarantined markers + rewrites the source tag per --new-source.')
    .argument('<id>', 'Quarantine entry id (from list-quarantine)')
    .requiredOption('--to <path>', 'Absolute path to the standing-memory target (e.g. /path/to/agents/forge/MEMORY.md)')
    .option('--new-source <src>', 'source: to write on the promoted entry (david | agent-reasoning). Defaults to agent-reasoning.', 'agent-reasoning')
    .option('--append', 'Append to target instead of overwriting (default false → the promoted content REPLACES the file)')
    .action((id: string, opts: { to: string; newSource: string; append?: boolean }) => {
      const { ctxRoot } = resolveEnv();
      const source = opts.newSource;
      if (source !== 'david' && source !== 'agent-reasoning') {
        console.error(`promote-memory: --new-source must be one of: david | agent-reasoning (got '${source}'). Web-or-bridge content never promotes as-is; it must be re-authored under a legit source by the promoter.`);
        process.exit(2);
      }

      const found = findQuarantineById(join(ctxRoot, 'state', 'memory-quarantine'), id);
      if (!found) {
        console.error(`promote-memory: no quarantine entry with id ${id} — run \`cortextos bus list-quarantine\` to check`);
        process.exit(2);
      }
      const raw = readFileSync(found, 'utf-8');
      const body = raw.replace(/^---[\s\S]*?---\s*/, '');
      const promoted = `---
source: ${source}
promoted_from_quarantine: ${id}
promoted_at: ${new Date().toISOString()}
---

${body}`;

      // Ensure target dir exists
      const targetDir = opts.to.split('/').slice(0, -1).join('/');
      if (targetDir) mkdirSync(targetDir, { recursive: true });

      if (opts.append && existsSync(opts.to)) {
        writeFileSync(opts.to, readFileSync(opts.to, 'utf-8') + '\n\n' + promoted, { mode: 0o600 });
      } else {
        writeFileSync(opts.to, promoted, { mode: 0o600 });
      }

      // Move the quarantine file into a `promoted/` sibling so it's not re-promoted.
      const promotedDir = join(found, '..', 'promoted');
      mkdirSync(promotedDir, { recursive: true });
      const dest = join(promotedDir, id + '.md');
      renameSync(found, dest);
      console.log(`promote-memory: ${id} → ${opts.to} (source=${source}); source archived at ${dest}`);
    });
}

function readdirSafe(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

function parseQuarantineMeta(text: string): Record<string, string> {
  const m = text.match(/^---([\s\S]*?)---/);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const k = line.slice(0, idx).trim();
    let v = line.slice(idx + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

function findQuarantineById(root: string, id: string): string | null {
  if (!existsSync(root)) return null;
  for (const agent of readdirSafe(root)) {
    const agentDir = join(root, agent);
    for (const date of readdirSafe(agentDir)) {
      const candidate = join(agentDir, date, id + '.md');
      if (existsSync(candidate)) {
        try {
          const s = statSync(candidate);
          if (s.isFile()) return candidate;
        } catch { /* skip */ }
      }
    }
  }
  return null;
}
