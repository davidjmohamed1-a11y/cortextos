/**
 * hook-state-verify.ts — UserPromptSubmit hook.
 *
 * Forces an orchestrator to invoke its state-verification skill when David's
 * prompt contains keywords suggesting verifiable external state is in play
 * (email, calendar, drive, drafts, etc.). The hook itself cannot read MCP —
 * MCP tools run inside the model turn, not in a shell hook — so the hook's
 * job is purely to NUDGE: it emits a system-reminder telling the agent to
 * run the state-verification skill BEFORE responding. The skill (which can
 * call MCP) does the actual prefetch.
 *
 * This is "Plan B" from the design discussion. "Plan A" was soft discipline
 * (boss remembers to verify). Plan A failed under speed pressure. The
 * forcing function injected by this hook + the prefetch skill = Plan B.
 *
 * Registered in settings.json under "UserPromptSubmit". Outputs JSON of the
 * form Claude Code expects to inject context:
 *   { hookSpecificOutput: { hookEventName: "UserPromptSubmit",
 *                           additionalContext: "<system-reminder text>" } }
 *
 * Fires fast. Best-effort. Always exits 0 — a hook crash must not block
 * David's prompt from reaching the agent.
 */

import { readFileSync } from 'fs';

// Keywords (case-insensitive, word boundaries) that indicate David is
// referencing OR expecting verifiable external state. The set is deliberately
// broad — false positives (extra skill invocation) are cheap; false negatives
// (missed nudge → boss asks "did you do X" about verifiable state) are the
// failure mode this hook exists to eliminate.
//
// Approved by boss-personal in the task spec. Extend via /tmp/.hook-state-verify-extras
// (one keyword per line) at runtime to widen coverage without a code change.
const KEYWORDS = [
  // External-state surfaces
  'email', 'gmail', 'inbox', 'sent', 'draft', 'reply',
  'calendar', 'schedule', 'meeting', 'appointment',
  'drive', 'sheet', 'spreadsheet', 'doc', 'document', 'tracker',
  // Action verbs that signal "I did something the system can verify"
  'did', 'applied', 'submitted', 'finished', 'done', 'ready',
  // State-change verbs
  'label', 'trash',
  // Outreach context
  'follow-up', 'followup', 'letter', 'status', 'resignation', 'application',
];

/**
 * Read all stdin into a single string (Claude Code pipes the UserPromptSubmit
 * payload here). Returns empty string on any error so we can fail open.
 */
function readStdinSync(): string {
  try {
    return readFileSync(0, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Extract the user's prompt text from the Claude Code UserPromptSubmit payload.
 * The schema is `{ prompt: string, session_id?: string, ... }`. We pull the
 * `prompt` field; if missing or non-string, we fall back to the raw JSON so
 * keyword detection still works on whatever structured fields are present.
 */
function extractPromptText(payload: string): string {
  if (!payload) return '';
  try {
    const parsed = JSON.parse(payload) as { prompt?: unknown };
    if (typeof parsed.prompt === 'string') return parsed.prompt;
  } catch { /* not JSON — fall through */ }
  return payload;
}

/**
 * Test whether the prompt contains any state-relevant keyword.
 * Case-insensitive, word-boundary aware so "drive" matches "drive" but not
 * "drove" or "deprive". Hyphens are treated as word characters so
 * "follow-up" matches as one token.
 */
export function promptTriggersStateCheck(prompt: string, extras: string[] = []): boolean {
  if (!prompt) return false;
  const haystack = prompt.toLowerCase();
  for (const kw of [...KEYWORDS, ...extras]) {
    // Word-boundary match. \b doesn't treat hyphen as a word char, so we
    // build a custom boundary that allows start/end-of-string or non-word-non-hyphen.
    // The trailing `s?` accepts a single plural-s so "drafts" matches "draft",
    // "sheets" matches "sheet", "applications" matches "application", etc. without
    // having to enumerate every plural in the keyword list. The trailing boundary
    // still applies AFTER the optional s, so "drafted" / "labeled" / "submission"
    // do not match — they have additional word characters after where s would be.
    const pattern = new RegExp(
      `(?:^|[^a-z0-9-])${escapeRegex(kw.toLowerCase())}s?(?:[^a-z0-9-]|$)`,
    );
    if (pattern.test(haystack)) return true;
  }
  return false;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Load optional extra keywords from /tmp/.hook-state-verify-extras (one per
 * line, # for comments). Lets operators widen the keyword set live without
 * rebuilding the hook. Missing file → empty list; unreadable → empty list.
 */
function loadExtras(): string[] {
  try {
    return readFileSync('/tmp/.hook-state-verify-extras', 'utf-8')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));
  } catch {
    return [];
  }
}

const SYSTEM_REMINDER = `[state-verification] David's prompt touches verifiable external state ` +
  `(email / drive / calendar / drafts / tracker). BEFORE composing your response, invoke the ` +
  `state-verification skill so you read CURRENT state and reference it explicitly. Do not ask ` +
  `"did you do X" when X is something you can verify by reading Gmail Sent, Drafts, Drive, or ` +
  `Calendar. The skill fires the four prefetch queries in parallel and dumps a STATE PREFETCH ` +
  `block into context — answer based on that block, not on memory of prior turns.`;

function emitInjection(text: string): void {
  // Claude Code UserPromptSubmit hook injection format. The `additionalContext`
  // string is appended to the user prompt the model sees, framed as a
  // system-reminder so it carries the same weight as built-in reminders.
  const out = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: text,
    },
  };
  process.stdout.write(JSON.stringify(out));
}

function main(): void {
  const payload = readStdinSync();
  const prompt = extractPromptText(payload);
  const extras = loadExtras();
  if (promptTriggersStateCheck(prompt, extras)) {
    emitInjection(SYSTEM_REMINDER);
  }
  // Always exit 0 — never block a user prompt because of hook failure.
  process.exit(0);
}

// Skip when imported for testing (unit tests call promptTriggersStateCheck directly).
if (require.main === module) {
  try { main(); } catch { process.exit(0); }
}
