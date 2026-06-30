/**
 * hook-hard-rule-gate.ts — Framework-level hard-rule enforcement.
 *
 * Runs as a PreToolUse hook. For each tool call, checks against HARD_RULES.
 * If a rule matches:
 *   1. Look for a fresh approval token for that rule.
 *   2. If token exists → consume it (delete file) + allow.
 *   3. If no token → DENY with a clear message that includes the override path.
 *
 * If NO rule matches → allow silently (default-allow on non-match).
 *
 * Logs every block via `cortextos bus log-event` so the activity feed reflects
 * gated actions. Operator (boss-personal or David) grants approval via:
 *   `cortextos bus approve-hard-rule <rule-name> [--reason <reason>]`
 * which writes a token file at <ctxRoot>/approvals/granted/<rule-name>/<id>.json.
 *
 * Spec source: orgs/personal/agents/forge/specs/hard-rule-enforcement-hooks-2026-06-29.md
 */

import { execFile } from 'child_process';
import { resolve } from 'path';
import {
  readStdin,
  parseHookInput,
  loadEnv,
  outputDecision,
} from './index';
import {
  HARD_RULES,
  findFreshApprovalToken,
  consumeApprovalToken,
  type HardRuleEnv,
} from './hard-rules';

/**
 * Fire-and-forget log event. Best-effort — failures don't block the hook decision.
 */
function logBlockedEvent(ruleName: string, toolName: string, agentName: string): void {
  try {
    execFile(
      'cortextos',
      [
        'bus', 'log-event', 'action', 'hard_rule_blocked', 'warn',
        '--meta', JSON.stringify({ rule: ruleName, tool: toolName, agent: agentName }),
      ],
      () => { /* ignore — best effort */ },
    );
  } catch {
    // execFile threw synchronously (rare); swallow to avoid blocking the deny path
  }
}

function logApprovalConsumed(ruleName: string, toolName: string, agentName: string, tokenPath: string): void {
  try {
    execFile(
      'cortextos',
      [
        'bus', 'log-event', 'action', 'hard_rule_approval_consumed', 'info',
        '--meta', JSON.stringify({ rule: ruleName, tool: toolName, agent: agentName, token: tokenPath }),
      ],
      () => { /* ignore */ },
    );
  } catch { /* swallow */ }
}

async function main(): Promise<void> {
  const input = await readStdin();
  const { tool_name, tool_input } = parseHookInput(input);

  // Skip rule evaluation entirely for the meta tools the other hooks own.
  // (Same defensive skip pattern hook-permission-telegram uses.)
  if (tool_name === 'ExitPlanMode' || tool_name === 'AskUserQuestion') {
    outputDecision('allow');
    return;
  }

  const env = loadEnv();
  const ruleEnv: HardRuleEnv = {
    agentDir: process.env.CTX_AGENT_DIR ? resolve(process.env.CTX_AGENT_DIR) : process.cwd(),
    agentName: env.agentName,
    ctxRoot: env.ctxRoot,
  };

  // Find the first rule that matches (order matters per HARD_RULES declaration).
  for (const rule of HARD_RULES) {
    let matched: boolean;
    try {
      matched = rule.match(tool_name, tool_input, ruleEnv);
    } catch {
      // A rule matcher threw — fail OPEN per the spec's "favor agent-progress
      // over agent-blocking when the gate itself is broken" principle. The
      // alternative (fail closed) risks halting the whole agent on a buggy
      // matcher. Log so the breakage is visible.
      logBlockedEvent(`${rule.name}_matcher_error`, tool_name, env.agentName);
      continue;
    }
    if (!matched) continue;

    // Non-overridable rules (e.g. CAPTCHA solver, anti-detect, IP-rotation):
    // legal bright lines with no override path. Block always.
    if (rule.non_overridable) {
      logBlockedEvent(rule.name, tool_name, env.agentName);
      outputDecision('deny', `BLOCKED by hard rule '${rule.name}' (non-overridable): ${rule.reason}`);
      return;
    }

    // Rule fired. Check for an approval token.
    const token = findFreshApprovalToken(ruleEnv, rule.name);
    if (token) {
      consumeApprovalToken(token);
      logApprovalConsumed(rule.name, tool_name, env.agentName, token);
      outputDecision('allow', `Hard rule '${rule.name}' approved via token (consumed).`);
      return;
    }

    // No approval — DENY with the rule's reason.
    logBlockedEvent(rule.name, tool_name, env.agentName);
    outputDecision('deny', `BLOCKED by hard rule '${rule.name}': ${rule.reason}`);
    return;
  }

  // No rule matched → allow silently.
  outputDecision('allow');
}

main().catch((err) => {
  // Hook itself failed catastrophically. Fail OPEN (allow) per spec rationale
  // — favor agent progress over halting the whole agent on a buggy gate.
  // Log the error so the breakage is visible.
  try {
    process.stderr.write(`[hook-hard-rule-gate] internal error: ${err.message}\n`);
  } catch { /* ignore */ }
  outputDecision('allow');
});
