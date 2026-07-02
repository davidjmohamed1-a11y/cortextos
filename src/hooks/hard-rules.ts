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
  /**
   * When true, the rule cannot be overridden by an approval token — block
   * always. Used for legal-bright-line rules where there is no operationally
   * sound override (e.g. CAPTCHA solver services, anti-detect libraries,
   * IP-rotation-to-evade tools). The blocking IS the legal protection.
   * Default: false (rule is overridable via approve-hard-rule).
   */
  non_overridable?: boolean;
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

// ---------------------------------------------------------------------------
// Fetch-ladder legal-bright-line additions (per spec
// orgs/personal/agents/forge/specs/fetch-ladder-2026-06-30.md):
//
//   5. auto_login_to_target — auto-login to scrape gated data (overridable
//      with explicit David go; rare)
//   6. captcha_solver_endpoint — NON-OVERRIDABLE (bright line)
//   7. anti_detect_browser_lib — NON-OVERRIDABLE (bright line)
//   8. ip_rotation_to_evade — NON-OVERRIDABLE (bright line)
//
// Sources:
//   - Van Buren 2021 (SCOTUS) "gates-up-or-down"
//   - hiQ v LinkedIn ($500K breach-of-contract judgment for logged-in scrape)
// ---------------------------------------------------------------------------

/**
 * Fetch-ladder rule 5: auto-login to a target whose response we're then
 * scraping. Crossing a login wall converts weak browsewrap ToS into
 * enforceable clickwrap + opens CFAA exposure.
 *
 * Overridable — David can grant approval for specific operational needs
 * (e.g. agent logging into its OWN authenticated service), but routing is
 * to [HUMAN] by default.
 *
 * Matches:
 *   - Bash navigation to login/signin/auth endpoints followed by credential
 *     submission patterns
 *   - WebFetch POST to common auth endpoints with credential payloads
 *   - agent-browser tool calls that type into password-shaped fields
 */
export const RULE_AUTO_LOGIN_TO_TARGET: HardRule = {
  name: 'auto_login_to_target',
  reason: "Auto-login to scrape gated data is a known legal bright line (hiQ v LinkedIn). Route to [HUMAN] by default. If the login is to an agent's OWN service (not a scrape target), request explicit approval via `cortextos bus approve-hard-rule auto_login_to_target`.",
  match: (toolName, toolInput) => {
    // Bash: pattern-match common cred-injection shapes
    if (toolName === 'Bash') {
      const cmd: string = toolInput?.command || '';
      // curl POST with password/passwd field
      if (/curl[^|&;]*-d\s+['"]?[^'"]*\b(password|passwd|pwd)=/i.test(cmd)) return true;
      // login form POST with username + password in body
      if (/curl[^|&;]*-X\s*POST[^|&;]*\bpassword=/i.test(cmd)) return true;
    }
    // WebFetch POST to known auth endpoint
    if (toolName === 'WebFetch') {
      const url: string = toolInput?.url || '';
      if (/\b(login|signin|sign-in|authenticate|oauth\/token)\b/i.test(url)) {
        const prompt: string = toolInput?.prompt || '';
        // Tighten: only block if it looks like cred submission, not docs/research
        if (/password|credential|sign in to|authenticate as/i.test(prompt)) return true;
      }
    }
    // agent-browser type-into-password — match by the field hint
    if (/^mcp__.*agent[-_]?browser.*__type/i.test(toolName)) {
      const ref: string = toolInput?.ref || '';
      if (/password|passwd|pwd/i.test(ref)) return true;
    }
    return false;
  },
};

/** Domains of known CAPTCHA-solver services. Bright-line forbidden. */
const CAPTCHA_SOLVER_DOMAINS = [
  '2captcha.com', 'anti-captcha.com', 'capsolver.com',
  'deathbycaptcha.com', 'capmonster.cloud', 'rucaptcha.com',
  'solvecaptcha.com', 'imagetyperz.com',
];

/**
 * Fetch-ladder rule 6: NON-OVERRIDABLE. Any HTTP call to a CAPTCHA-solver
 * service. Defeating an access control via a third-party solver is the
 * unresolved CFAA edge + bad-faith evidence in every relevant case.
 */
export const RULE_CAPTCHA_SOLVER_ENDPOINT: HardRule = {
  name: 'captcha_solver_endpoint',
  reason: "Calls to CAPTCHA-solver services (2Captcha, CapSolver, etc.) defeat an access control and are a legal bright line. There is no operationally sound use case in cortextOS — the escalation past a CAPTCHA is a HUMAN (Phase 2 rung 6), never a solver. This rule is non-overridable.",
  non_overridable: true,
  match: (toolName, toolInput) => {
    if (toolName === 'Bash') {
      const cmd: string = toolInput?.command || '';
      if (CAPTCHA_SOLVER_DOMAINS.some((d) => cmd.includes(d))) return true;
    }
    if (toolName === 'WebFetch') {
      const url: string = toolInput?.url || '';
      if (CAPTCHA_SOLVER_DOMAINS.some((d) => url.includes(d))) return true;
    }
    return false;
  },
};

/** Package names of known anti-detect / JA3-spoof libraries. */
const ANTI_DETECT_PACKAGES = [
  'undetected-chromedriver', 'undetected_chromedriver',
  'playwright-stealth', 'puppeteer-extra-plugin-stealth',
  'puppeteer-stealth',
  'curl-impersonate', 'curl_impersonate',
  'tls-client', 'tls_client',
  'selenium-stealth',
];

/**
 * Fetch-ladder rule 7: NON-OVERRIDABLE. Installation OR direct invocation of
 * known anti-detect / TLS-spoof libraries. These exist specifically to defeat
 * fingerprint detection — they are the technical control circumvention.
 *
 * Legal-clean alternative: rung 5 real Chrome profile — actually IS a real
 * browser, not a spoof. Phase 2.
 */
export const RULE_ANTI_DETECT_BROWSER_LIB: HardRule = {
  name: 'anti_detect_browser_lib',
  reason: "Anti-detect / TLS-spoof libraries (undetected-chromedriver, playwright-stealth, curl-impersonate, etc.) exist specifically to circumvent fingerprint-based access controls. The legal alternative is a REAL browser profile (Phase 2 rung 5), not a spoofed one. This rule is non-overridable.",
  non_overridable: true,
  match: (toolName, toolInput) => {
    if (toolName !== 'Bash') return false;
    const cmd: string = toolInput?.command || '';
    // Installation: npm/pip/poetry/uv add of these packages
    for (const pkg of ANTI_DETECT_PACKAGES) {
      const installRe = new RegExp(`\\b(npm\\s+(i|install|add)|pip\\s+install|pip3\\s+install|poetry\\s+add|uv\\s+(pip\\s+install|add))\\b[^|&;]*\\b${escapeRegex(pkg)}\\b`, 'i');
      if (installRe.test(cmd)) return true;
      // Direct invocation of the binary form (curl_impersonate ships a curl-impersonate-chrome binary)
      const invokeRe = new RegExp(`\\b${escapeRegex(pkg)}[-_][a-z0-9]+\\b`, 'i');
      if (invokeRe.test(cmd)) return true;
    }
    return false;
  },
};

/** Hostnames of rotating-proxy services typically used for IP-evasion. */
const IP_ROTATION_DOMAINS = [
  'brightdata.com', 'brd.superproxy.io', 'luminati.io', 'lum-superproxy.io', 'zproxy.lum-superproxy.io',
  'smartproxy.com', 'oxylabs.io', 'oxylabs.com',
  'soax.com', 'iproyal.com', 'netnut.io',
  'rayobyte.com', 'proxyrack.com',
];

/**
 * Fetch-ladder rule 8: NON-OVERRIDABLE. Use of rotating-proxy services
 * intended to evade IP-based access blocks. Using a residential proxy to
 * scrape a site that has blocked your home IP is the textbook bright line.
 *
 * Legal-clean alternative: respect 429/403, back off, escalate to rung 4
 * (archive) or Phase 2 rung 6 (human-gate). Never burn through proxy IPs.
 */
export const RULE_IP_ROTATION_TO_EVADE: HardRule = {
  name: 'ip_rotation_to_evade',
  reason: "Rotating-proxy / IP-evasion services (Bright Data, Smartproxy, Oxylabs, etc.) bypass IP-based access controls — a bright legal line. Respect 429/403 + back off + escalate via rung 4 (archive) or Phase 2 rung 6 (human-gate) instead. This rule is non-overridable.",
  non_overridable: true,
  match: (toolName, toolInput) => {
    if (toolName === 'Bash') {
      const cmd: string = toolInput?.command || '';
      if (IP_ROTATION_DOMAINS.some((d) => cmd.includes(d))) return true;
      // Common proxy-env-var patterns
      if (/\b(HTTP|HTTPS|ALL)_PROXY=https?:\/\/[^@\s]+@(brd|residential|rotating)/i.test(cmd)) return true;
    }
    if (toolName === 'WebFetch') {
      const url: string = toolInput?.url || '';
      if (IP_ROTATION_DOMAINS.some((d) => url.includes(d))) return true;
    }
    return false;
  },
};

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Memory-provenance addition — build #2 (Fable audit 2026-07-02).
//
// Closes the lethal-trifecta gap: web-or-bridge content silently landing in
// standing memory becomes future-session prior-belief. Every write to a
// standing-memory path (agent MEMORY.md, dated memory files, Claude Code
// project memory, extracted-facts JSONL) must carry an explicit provenance
// tag. Web/bridge-sourced content must go to quarantine — never standing
// memory directly, even with an approval token.
//
// Overridable (via approve-hard-rule) when source is missing OR source=
// david/agent-reasoning. Overriding a missing-source write is the escape
// hatch for legit content the agent forgot to tag.
//
// NON-overridable when source=web-or-bridge on a standing-memory path.
// That's the bright line: external content NEVER auto-promotes to standing
// instructions. It goes to state/memory-quarantine/ and requires David or
// boss to explicitly promote it via `cortextos bus promote-memory <id>`.
// ---------------------------------------------------------------------------

import {
  isStandingMemoryPath,
  validateProvenance,
  validateProvenanceJsonl,
} from '../utils/memory-provenance.js';

/**
 * Extract the content being written from a Write/Edit tool_input. Handles both
 * shapes:
 *   Write: { file_path, content }
 *   Edit:  { file_path, new_string, ... } — we validate the FULL post-edit
 *          content when the caller passes it, otherwise validate new_string
 *          as a proxy (partial edits with no source tag in new_string still
 *          fail the check when the target file has no existing frontmatter
 *          — which is the whole point).
 */
function memoryWriteContent(toolName: string, toolInput: any): string | null {
  if (toolName === 'Write') {
    return typeof toolInput?.content === 'string' ? toolInput.content : null;
  }
  if (toolName === 'Edit') {
    // For Edit we can't see the full post-edit state without reading the file
    // (which would slow the hook). Instead we validate new_string — a valid
    // provenance-tagged replacement content will pass; a bare replacement will
    // fail. Agents who need to preserve existing valid frontmatter should use
    // Write with the full content, or an Edit that includes the frontmatter
    // fence in new_string. Documented in the memory-provenance skill.
    return typeof toolInput?.new_string === 'string' ? toolInput.new_string : null;
  }
  return null;
}

export const RULE_MEMORY_WRITE_NEEDS_PROVENANCE: HardRule = {
  name: 'memory_write_needs_provenance',
  reason: "Writes to standing-memory paths must carry a provenance tag (`source: david | agent-reasoning | web-or-bridge` in YAML frontmatter). Web/bridge-sourced content must go to quarantine via `cortextos bus save-memory-quarantine ...` — NEVER standing memory directly, since anything landing there becomes future-session prior-belief. If this is legit david/agent-reasoning content you forgot to tag, add the frontmatter and re-try; if David has explicitly greenlit an override, request approval via `cortextos bus approve-hard-rule memory_write_needs_provenance`.",
  match: (toolName, toolInput) => {
    if (toolName !== 'Write' && toolName !== 'Edit') return false;
    const filePath = toolInput?.file_path;
    if (typeof filePath !== 'string' || !isStandingMemoryPath(filePath)) return false;
    const content = memoryWriteContent(toolName, toolInput);
    if (content == null) return true; // no content to validate → deny
    const check = filePath.endsWith('.jsonl')
      ? validateProvenanceJsonl(content.trim().split('\n').at(-1) || '')
      : validateProvenance(content);
    return !check.valid;
  },
  // Overridable for missing-tag or david/agent-reasoning sources. The web-or-
  // bridge bright line is enforced by the wrapper CLI (save-memory-quarantine
  // rejects standing paths outright) + operator convention. Making the whole
  // rule non-overridable would block legit "forgot to tag" writes.
};

/**
 * The full denylist. ORDER MATTERS — first matching rule wins. Existing
 * rules (V1, slots 1-4) come first; fetch-ladder additions (slots 5-8)
 * middle; memory-provenance (slot 9) appends at the end.
 */
export const HARD_RULES: ReadonlyArray<HardRule> = [
  RULE_GIT_PUSH_MAIN,
  RULE_RM_OUTSIDE_WORKSPACE,
  RULE_GMAIL_SEND_WITHOUT_APPROVAL,
  RULE_PUBLIC_POST,
  RULE_AUTO_LOGIN_TO_TARGET,
  RULE_CAPTCHA_SOLVER_ENDPOINT,
  RULE_ANTI_DETECT_BROWSER_LIB,
  RULE_IP_ROTATION_TO_EVADE,
  RULE_MEMORY_WRITE_NEEDS_PROVENANCE,
];
