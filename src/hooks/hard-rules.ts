/**
 * Hard-rule denylist for cortextOS agents.
 *
 * These rules are enforced at the framework level (PreToolUse hook) — the
 * agent cannot bypass them via reasoning, hallucination, or prompt injection.
 * They complement (do not replace) the agent-side GUARDRAILS.md interpretation
 * layer and the existing always_ask/never_ask permission flow.
 *
 * MVP rules (per Group C C4 build, David standing priority on the
 * credential/destructive hard-stop):
 *   1. git push to main / master
 *   2. rm -rf (or destructive rm) targeting paths outside the agent's workspace
 *   3. gmail.send via MCP without an explicit approval token
 *   4. Any public-post / external publish (LinkedIn, Twitter, public web)
 *
 * Each rule includes an OVERRIDE mechanism: an approval-token file at
 *   <ctxRoot>/approvals/granted/<rule-name>/<token-id>.json
 * Existence + age <5min = approval consumed → allow. After consumption the
 * token file is deleted so subsequent attempts re-prompt.
 */

import { existsSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';

export interface HardRule {
  /** Unique rule name. Used in approval-token paths + log messages. */
  name: string;
  /** Human-readable explanation surfaced to the agent in the deny message. */
  reason: string;
  /** Pure predicate. Returns true when the tool call MATCHES the rule (i.e. should be gated). */
  match: (toolName: string, toolInput: any, env: HardRuleEnv) => boolean;
}

export interface HardRuleEnv {
  /** Resolved absolute path of the agent's workspace dir (CTX_AGENT_DIR). */
  agentDir: string;
  /** Agent name (from CTX_AGENT_NAME). */
  agentName: string;
  /** Cortextos root (~/.cortextos/default by default). */
  ctxRoot: string;
}

/**
 * Approval-token freshness window. Tokens older than this are treated as
 * expired (the rule re-fires). Prevents stale grants from sitting around.
 */
export const APPROVAL_TOKEN_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Resolve the dir where approval tokens for a given rule live.
 * Tokens are dropped here by `cortextos bus approve-hard-rule <rule-name>`
 * (or by the existing create-approval/update-approval flow integration).
 */
export function approvalDirFor(env: HardRuleEnv, ruleName: string): string {
  return join(env.ctxRoot, 'approvals', 'granted', ruleName);
}

/**
 * Look for a non-expired approval token for the given rule. Returns the
 * filename of the first matching token, or null if none. Tokens older than
 * APPROVAL_TOKEN_MAX_AGE_MS are silently ignored (and could be cleaned by a
 * future janitor).
 */
export function findFreshApprovalToken(env: HardRuleEnv, ruleName: string): string | null {
  const dir = approvalDirFor(env, ruleName);
  if (!existsSync(dir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('.'));
  } catch {
    return null;
  }
  const now = Date.now();
  for (const file of entries) {
    const fullPath = join(dir, file);
    try {
      const stat = statSync(fullPath);
      if (now - stat.mtimeMs <= APPROVAL_TOKEN_MAX_AGE_MS) {
        return fullPath;
      }
    } catch {
      // stat failed — skip this file
    }
  }
  return null;
}

/**
 * Delete a consumed approval token. Errors are swallowed — the rule already
 * allowed the action; cleanup is best-effort.
 */
export function consumeApprovalToken(tokenPath: string): void {
  try {
    unlinkSync(tokenPath);
  } catch {
    // Token already gone or unwritable. Either way the gate already allowed.
  }
}

// ---------------------------------------------------------------------------
// Rule definitions (MVP V1)
// ---------------------------------------------------------------------------

/**
 * MVP rule 1: git push to main / master.
 *
 * Matches any Bash invocation containing `git push` (with or without args)
 * whose target branch is `main` or `master`. Catches the most common forms:
 *   git push
 *   git push origin main
 *   git push -u origin main
 *   git push --force origin master
 *
 * Does NOT match:
 *   git push origin feature/foo (non-main branch)
 *   git push david main (when david is the operator's personal fork — but
 *     this is a known limitation; conservative ruling is to gate)
 *
 * Actually, push to ANY remote of main/master is blocked. Personal forks
 * count too — David's explicit-go pattern applies to those equally.
 */
export const RULE_GIT_PUSH_MAIN: HardRule = {
  name: 'git_push_main',
  reason: "git push to main/master requires David's explicit go (no agent has standing authority to publish to main). Request approval via `cortextos bus approve-hard-rule git_push_main` after explicit user confirmation.",
  match: (toolName, toolInput) => {
    if (toolName !== 'Bash') return false;
    const cmd: string = toolInput?.command || '';
    // Match `git push` followed by anything, ending with `main` or `master`
    // as the last argument (or as the only branch ref). Conservative: any
    // `git push ... main` or `git push ... master`.
    return /\bgit\s+push\b.*\b(main|master)\b\s*$/.test(cmd)
        || /\bgit\s+push\s*$/.test(cmd);  // bare `git push` uses upstream default
  },
};

/**
 * MVP rule 2: destructive rm targeting paths outside the agent's workspace.
 *
 * Matches:
 *   rm -rf <anything>
 *   rm -r <anything>
 *   rm -f <multiple files>
 *
 * Allows when ALL targets are inside CTX_AGENT_DIR. Denies otherwise.
 *
 * Limitation: cannot fully parse complex shell pipelines, command substitution,
 * or env-var-expanded paths. Conservative: if we can't confidently determine
 * all targets are inside the workspace, deny.
 */
export const RULE_RM_OUTSIDE_WORKSPACE: HardRule = {
  name: 'rm_outside_workspace',
  reason: "Destructive `rm` outside the agent's workspace requires approval. The framework cannot infer intent; if the deletion is intentional, request approval via `cortextos bus approve-hard-rule rm_outside_workspace`.",
  match: (toolName, toolInput, env) => {
    if (toolName !== 'Bash') return false;
    const cmd: string = toolInput?.command || '';
    // Match any rm with -r or -rf, or rm with multiple file args.
    const isDestructive = /\brm\s+(-[a-z]*[rRf][a-z]*\b|--recursive\b|--force\b)/.test(cmd)
                       || /\brm\s+[^\s|;&]+\s+[^\s|;&]+/.test(cmd);
    if (!isDestructive) return false;

    // Extract candidate path args from the rm portion of the command. This is
    // intentionally conservative: any command-substitution / env-var / pipeline
    // we can't resolve = "outside workspace = block".
    const rmMatch = cmd.match(/\brm\s+([^|;&]+)/);
    if (!rmMatch) return true; // can't parse → block
    const args = rmMatch[1].split(/\s+/).filter(a => a && !a.startsWith('-'));
    if (args.length === 0) return true; // weird → block

    // If any arg contains $, `, or *, can't statically verify → block.
    const hasUnresolvable = args.some(a => /[\$`\*]/.test(a));
    if (hasUnresolvable) return true;

    // If any arg is not inside agentDir (as a path prefix), block.
    const allInside = args.every(a => {
      // Resolve relative paths against agentDir; absolute paths used as-is.
      const resolved = a.startsWith('/') ? a : join(env.agentDir, a);
      return resolved === env.agentDir || resolved.startsWith(env.agentDir + '/');
    });
    return !allInside;
  },
};

/**
 * MVP rule 3: gmail.send via MCP without an explicit approval token.
 *
 * Matches any tool call to an MCP Gmail tool that sends a message:
 *   mcp__claude_ai_Gmail__send_message  (legacy name)
 *   mcp__claude_ai_Gmail__send_email
 *   mcp__claude_ai_Gmail__send_draft
 *   any tool name starting with mcp__*Gmail*__send_
 *
 * Allows the read/draft/label tools (those are kai's normal workflow).
 *
 * Note: kai NEVER sends per her IDENTITY.md — drafts only. This rule is
 * defense-in-depth: even if her reasoning ever slips and she tries to send,
 * the framework blocks.
 */
export const RULE_GMAIL_SEND_WITHOUT_APPROVAL: HardRule = {
  name: 'gmail_send_without_approval',
  reason: "Sending email via Gmail MCP requires explicit David approval. Kai's standing policy is draft-only. Request approval via `cortextos bus approve-hard-rule gmail_send_without_approval` ONLY when David has confirmed the send out-of-band.",
  match: (toolName) => {
    // Match any Gmail send-* tool.
    return /^mcp__.*[Gg]mail.*__(send_|create_and_send)/.test(toolName);
  },
};

/**
 * MVP rule 4: public-post / external publish.
 *
 * Matches any tool call that publishes to a public surface (LinkedIn,
 * Twitter/X, public blog, public Notion page share, etc.). This is broader
 * than a single MCP tool — we match by tool-name patterns + by tool-input
 * patterns (e.g. Notion page share that sets public_url to true).
 */
export const RULE_PUBLIC_POST: HardRule = {
  name: 'public_post',
  reason: "Posting to a public surface requires explicit David approval. No agent has standing authority to publish externally. Request approval via `cortextos bus approve-hard-rule public_post` ONLY when David has confirmed the publish out-of-band.",
  match: (toolName, toolInput) => {
    // Direct MCP tools that publish externally
    if (/^mcp__.*(linkedin|twitter|x_com|mastodon|threads|bluesky).*__post/i.test(toolName)) {
      return true;
    }
    // Notion page share with public=true
    if (/^mcp__.*Notion.*__update_page_permissions/.test(toolName)) {
      const perm = (toolInput?.permissions || toolInput?.access || '').toString().toLowerCase();
      if (perm.includes('public') || toolInput?.is_public === true) return true;
    }
    // WebFetch POST to any social platform endpoint (catches sneaky bash-curl paths)
    if (toolName === 'Bash') {
      const cmd: string = toolInput?.command || '';
      if (/curl.*-X\s*POST.*\b(api\.linkedin|api\.twitter|api\.x|api\.threads)/i.test(cmd)) {
        return true;
      }
    }
    return false;
  },
};

/**
 * The MVP denylist (V1, per boss-personal C4 approval 2026-06-29).
 *
 * Order matters: first matching rule wins. Add new rules at the END so
 * existing matches stay stable.
 */
export const HARD_RULES: ReadonlyArray<HardRule> = [
  RULE_GIT_PUSH_MAIN,
  RULE_RM_OUTSIDE_WORKSPACE,
  RULE_GMAIL_SEND_WITHOUT_APPROVAL,
  RULE_PUBLIC_POST,
];
