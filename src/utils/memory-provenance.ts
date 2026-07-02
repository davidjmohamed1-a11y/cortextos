/**
 * Memory-write provenance validation.
 *
 * Every write to a fleet standing-memory path (agent MEMORY.md, dated
 * memory/YYYY-MM-DD.md, ~/.claude/projects/*&#47;memory/, extracted-
 * facts JSONL) must declare its origin. Three legitimate values:
 *
 *   david             — user directly told the agent (Telegram/Claude-desktop
 *                       authenticated sender path).
 *   agent-reasoning   — agent-synthesized from its own thinking or from
 *                       verified fleet state (extract-facts hook, agent-
 *                       authored insights, code-derived observations).
 *   web-or-bridge     — pulled from WebFetch, WebSearch, Claude inbound,
 *                       fetch-ladder result, or any external channel.
 *                       These must go to QUARANTINE, not standing memory.
 *
 * The threat model this closes: web-or-bridge content silently landing in
 * MEMORY.md becomes future-session prior-belief. Any hostile web page or
 * poisoned Claude inbound could plant "the org said this" statements into
 * standing instructions. Provenance tagging + the corresponding hard-rule
 * (memory_write_needs_provenance) prevents that.
 *
 * Convention: YAML frontmatter at the top of the file. Alternative for JSONL
 * lines: `source` field on each entry. Both surfaces are covered.
 *
 * Ship 2026-07-02 (build #2 per boss Fable-audit dispatch).
 */

export type MemoryProvenanceSource = 'david' | 'agent-reasoning' | 'web-or-bridge';

/** Result of validating provenance on a text blob. */
export interface ProvenanceCheck {
  valid: boolean;
  /** Extracted source when valid. */
  source?: MemoryProvenanceSource;
  /** Human-readable reason when !valid — surfaced in the hard-rule deny msg. */
  reason?: string;
}

const VALID_SOURCES: ReadonlyArray<MemoryProvenanceSource> = ['david', 'agent-reasoning', 'web-or-bridge'];

/**
 * Parse YAML frontmatter from a markdown-like body. Extremely narrow parser:
 * only supports the block-fence form (`---\n<lines>\n---`) at the start of
 * the string, and only extracts scalar `key: value` pairs. This is deliberate
 * — we validate provenance-tag presence, not general YAML.
 */
export function extractFrontmatter(body: string): Record<string, string> | null {
  if (!body) return null;
  const trimmed = body.trimStart();
  if (!trimmed.startsWith('---')) return null;
  const rest = trimmed.slice(3);
  const closeIdx = rest.indexOf('\n---');
  if (closeIdx === -1) return null;
  const fmBody = rest.slice(0, closeIdx);
  const out: Record<string, string> = {};
  for (const rawLine of fmBody.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const k = line.slice(0, colon).trim();
    let v = line.slice(colon + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

/**
 * Validate that a markdown-like text blob carries a valid provenance tag.
 * Returns { valid, source, reason }.
 *
 * A blob is valid when:
 *   1. It has YAML frontmatter at the top.
 *   2. Frontmatter includes a `source` key with one of the three known values.
 *
 * Anything else is invalid — including missing frontmatter, unknown source
 * value, empty source, or non-string source.
 */
export function validateProvenance(text: string): ProvenanceCheck {
  if (!text || typeof text !== 'string') {
    return { valid: false, reason: 'empty or non-string content' };
  }
  const fm = extractFrontmatter(text);
  if (!fm) {
    return { valid: false, reason: 'missing YAML frontmatter (start file with `---` fence including a `source:` line)' };
  }
  const src = fm.source;
  if (!src) {
    return { valid: false, reason: 'frontmatter present but missing required `source:` field' };
  }
  if (!(VALID_SOURCES as ReadonlyArray<string>).includes(src)) {
    return {
      valid: false,
      reason: `invalid source '${src}' — must be one of: ${VALID_SOURCES.join(', ')}`,
    };
  }
  return { valid: true, source: src as MemoryProvenanceSource };
}

/**
 * Validate a single JSONL memory line. Same three-source rule; the field is
 * `source` on the parsed object. Non-JSON lines are considered invalid.
 */
export function validateProvenanceJsonl(line: string): ProvenanceCheck {
  if (!line || typeof line !== 'string') {
    return { valid: false, reason: 'empty or non-string line' };
  }
  try {
    const parsed = JSON.parse(line);
    const src = parsed?.source;
    if (!src) {
      return { valid: false, reason: 'JSONL entry missing required `source` field' };
    }
    if (!(VALID_SOURCES as ReadonlyArray<string>).includes(src)) {
      return {
        valid: false,
        reason: `invalid source '${src}' — must be one of: ${VALID_SOURCES.join(', ')}`,
      };
    }
    return { valid: true, source: src as MemoryProvenanceSource };
  } catch {
    return { valid: false, reason: 'JSONL line is not valid JSON' };
  }
}

/**
 * Path patterns that represent STANDING memory — those the hard-rule enforces
 * provenance on. Callers pass file paths; matching is substring/glob-ish
 * because the hard-rule matcher runs on raw tool-input strings.
 *
 * NOTE: this list intentionally excludes runtime scratch paths like
 * `state/*` or `logs/*`. Those aren't standing memory.
 */
export const STANDING_MEMORY_PATH_SUFFIXES = [
  '/MEMORY.md',
  '/memory/',
  '/agents/', // agent MEMORY.md variants covered by /agents/*/MEMORY.md
] as const;

/**
 * Match test: does a Write/Edit target look like a standing-memory path?
 * True → the hard-rule needs to validate provenance on the write.
 */
export function isStandingMemoryPath(filePath: string): boolean {
  if (!filePath || typeof filePath !== 'string') return false;
  const norm = filePath.replace(/\\/g, '/');
  // Direct agent MEMORY.md matches (any dir suffix).
  if (norm.endsWith('/MEMORY.md') || norm === 'MEMORY.md') return true;
  // Daily agent memory: */memory/YYYY-MM-DD.md
  if (/\/memory\/\d{4}-\d{2}-\d{2}\.md$/.test(norm)) return true;
  // Long-term user memory used by Claude Code projects: ~/.claude/projects/*/memory/*.md
  if (norm.includes('/.claude/projects/') && norm.includes('/memory/') && norm.endsWith('.md')) return true;
  // Extracted-facts JSONL
  if (/\/memory\/facts\/\d{4}-\d{2}-\d{2}\.jsonl$/.test(norm)) return true;
  return false;
}

/**
 * Where quarantined web/bridge content lives. Never in standing memory.
 * David/boss reviews these + promotes via `cortextos bus promote-memory <id>`.
 */
export function quarantineDir(ctxRoot: string, agent: string, isoDate: string): string {
  return `${ctxRoot}/state/memory-quarantine/${agent}/${isoDate}`;
}
