import { describe, it, expect } from 'vitest';

import {
  extractFrontmatter,
  validateProvenance,
  validateProvenanceJsonl,
  isStandingMemoryPath,
  quarantineDir,
} from '../../../src/utils/memory-provenance.js';

describe('extractFrontmatter', () => {
  it('returns null when body has no frontmatter fence', () => {
    expect(extractFrontmatter('just a plain body')).toBeNull();
  });
  it('returns null when opening fence has no closer', () => {
    expect(extractFrontmatter('---\nsource: david\nnever-closed')).toBeNull();
  });
  it('parses simple key:value pairs', () => {
    const fm = extractFrontmatter('---\nsource: david\nauthor: forge\n---\nbody here');
    expect(fm).toEqual({ source: 'david', author: 'forge' });
  });
  it('strips single + double quotes from values', () => {
    const fm = extractFrontmatter(`---\nsource: "david"\nnotes: 'a note'\n---\n`);
    expect(fm?.source).toBe('david');
    expect(fm?.notes).toBe('a note');
  });
  it('ignores comment lines inside frontmatter', () => {
    const fm = extractFrontmatter('---\n# a comment\nsource: david\n---\n');
    expect(fm).toEqual({ source: 'david' });
  });
  it('leading whitespace before the opening fence is OK', () => {
    const fm = extractFrontmatter('\n\n---\nsource: david\n---\n');
    expect(fm?.source).toBe('david');
  });
});

describe('validateProvenance', () => {
  it('rejects empty or non-string', () => {
    expect(validateProvenance('').valid).toBe(false);
    expect(validateProvenance(null as any).valid).toBe(false);
    expect(validateProvenance(undefined as any).valid).toBe(false);
  });
  it('rejects body with no frontmatter', () => {
    const r = validateProvenance('Just a memory note without any tag.');
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/frontmatter/);
  });
  it('rejects frontmatter without source field', () => {
    const r = validateProvenance('---\nauthor: forge\n---\nbody');
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/source/);
  });
  it('rejects invalid source values', () => {
    for (const bad of ['gossip', 'random', 'DAVID', 'user', '']) {
      const r = validateProvenance(`---\nsource: ${bad}\n---\nbody`);
      expect(r.valid).toBe(false);
    }
  });
  it('accepts source=david', () => {
    const r = validateProvenance('---\nsource: david\n---\nDavid told me X.');
    expect(r.valid).toBe(true);
    expect(r.source).toBe('david');
  });
  it('accepts source=agent-reasoning', () => {
    const r = validateProvenance('---\nsource: agent-reasoning\n---\nInferred from code X.');
    expect(r.valid).toBe(true);
    expect(r.source).toBe('agent-reasoning');
  });
  it('accepts source=web-or-bridge', () => {
    const r = validateProvenance('---\nsource: web-or-bridge\norigin_url: https://example.com\n---\nQuoted from web.');
    expect(r.valid).toBe(true);
    expect(r.source).toBe('web-or-bridge');
  });
});

describe('validateProvenanceJsonl', () => {
  it('rejects non-JSON lines', () => {
    expect(validateProvenanceJsonl('not-json').valid).toBe(false);
  });
  it('rejects lines missing source', () => {
    const r = validateProvenanceJsonl(JSON.stringify({ ts: '2026-07-02', summary: 'X' }));
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/source/);
  });
  it('accepts valid source values', () => {
    for (const s of ['david', 'agent-reasoning', 'web-or-bridge']) {
      const r = validateProvenanceJsonl(JSON.stringify({ ts: '2026-07-02', source: s, summary: 'Y' }));
      expect(r.valid).toBe(true);
      expect(r.source).toBe(s);
    }
  });
  it('rejects unknown source values', () => {
    const r = validateProvenanceJsonl(JSON.stringify({ source: 'gossip', summary: 'X' }));
    expect(r.valid).toBe(false);
  });
});

describe('isStandingMemoryPath', () => {
  it('matches agent MEMORY.md', () => {
    expect(isStandingMemoryPath('/framework/orgs/personal/agents/forge/MEMORY.md')).toBe(true);
  });
  it('matches root MEMORY.md', () => {
    expect(isStandingMemoryPath('MEMORY.md')).toBe(true);
  });
  it('matches dated agent memory', () => {
    expect(isStandingMemoryPath('/orgs/personal/agents/forge/memory/2026-07-02.md')).toBe(true);
  });
  it('matches Claude Code project memory', () => {
    expect(isStandingMemoryPath('/Users/dave/.claude/projects/-Users-dave-cortextos/memory/facts.md')).toBe(true);
  });
  it('matches extracted-facts JSONL', () => {
    expect(isStandingMemoryPath('/orgs/personal/agents/forge/memory/facts/2026-07-02.jsonl')).toBe(true);
  });
  it('does NOT match logs / state / other runtime paths', () => {
    expect(isStandingMemoryPath('/state/telegram-offset')).toBe(false);
    expect(isStandingMemoryPath('/logs/atlas/stdout.log')).toBe(false);
    expect(isStandingMemoryPath('/orgs/personal/tasks/task_123.json')).toBe(false);
  });
  it('does NOT match arbitrary .md files', () => {
    expect(isStandingMemoryPath('/notes/some-note.md')).toBe(false);
    expect(isStandingMemoryPath('README.md')).toBe(false);
  });
});

describe('quarantineDir', () => {
  it('composes the expected path', () => {
    const d = quarantineDir('/root', 'atlas', '2026-07-02');
    expect(d).toBe('/root/state/memory-quarantine/atlas/2026-07-02');
  });
});
