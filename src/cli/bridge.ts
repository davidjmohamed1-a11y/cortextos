/**
 * CLI commands for the agent ↔ Cowork bridge.
 *
 * Mounted onto the bus command in src/cli/bus.ts via registerBridgeCommands.
 *
 * Commands:
 *   bus bridge-request <type> <description> --to <agent> [--context <json>]
 *   bus bridge-status <id>
 *   bus bridge-list [--status <state>]
 *   bus bridge-relay-tick
 *   bus bridge-janitor
 */

import { Command } from 'commander';
import { join } from 'path';
import { resolveEnv } from '../utils/env.js';
import { resolvePaths } from '../utils/paths.js';
import {
  resolveBridgePaths,
  writeBridgeRequest,
  getBridgeStatus,
  listBridgeRequests,
  relayTick,
  sweepBridge,
  V1_ALLOWED_REQUEST_TYPES,
  type BridgeRequestType,
} from '../bridge/index.js';
import { inboundRelayTick } from '../bridge/inbound-relay.js';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { generateBridgeKey, bridgeKeyPath, loadBridgeKey } from '../bridge/signing.js';
import { loadDomainAllowlist, allowlistFilePath, V1_DEFAULT_DOMAIN_ALLOWLIST } from '../bridge/security.js';
import {
  approvalTokenPath,
  rejectMarkerPath,
  pendingApprovalSidecarPath,
  loadSensitiveDomains,
  V1_DEFAULT_SENSITIVE_DOMAINS,
  sensitiveDomainsFilePath,
} from '../bridge/sensitivity.js';

export function registerBridgeCommands(busCommand: Command): void {
  busCommand
    .command('generate-bridge-key')
    .description('Generate the bridge HMAC signing key at <ctxRoot>/config/bridge-signing-key (mode 0600). Run ONCE at install time. Refuses to overwrite an existing key without --force (rotation invalidates in-flight bridge requests + requires Cowork listener restart).')
    .option('--force', 'Overwrite an existing key (rotation). Will invalidate in-flight bridge requests + require Cowork listener restart to pick up the new key.', false)
    .action((opts: { force: boolean }) => {
      const env = resolveEnv();
      try {
        const path = generateBridgeKey(env.ctxRoot, opts.force);
        console.log(`Bridge signing key written to ${path} (mode 0600).`);
        console.log(opts.force ? 'ROTATED — restart Cowork listener so it picks up the new key.' : 'INITIAL — Cowork listener picks up this key on next read.');
      } catch (err) {
        console.error(String((err as Error).message ?? err));
        process.exit(1);
      }
    });

  busCommand
    .command('bridge-allowlist')
    .description('Manage the M1 bridge domain allowlist. Subcommands: list, add <domain>, remove <domain>')
    .argument('<action>', 'list, add, or remove')
    .argument('[domain]', 'Domain (required for add/remove)')
    .action((action: string, domain: string | undefined) => {
      const env = resolveEnv();
      const fs = require('fs');
      const path = allowlistFilePath(env.ctxRoot);
      const current = Array.from(loadDomainAllowlist(env.ctxRoot));
      if (action === 'list') {
        console.log('Bridge domain allowlist (M1):');
        for (const d of current) console.log(`  - ${d}`);
        console.log(`(source: ${fs.existsSync(path) ? path : 'V1 defaults — write to ' + path + ' to override'})`);
        return;
      }
      if (!domain) {
        console.error(`Domain argument required for action '${action}'.`);
        process.exit(1);
      }
      if (action === 'add') {
        if (current.includes(domain)) {
          console.log(`Domain '${domain}' already in allowlist; no change.`);
          return;
        }
        current.push(domain);
        const dir = require('path').dirname(path);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path, JSON.stringify(current, null, 2));
        console.log(`Added '${domain}'. Allowlist now: ${current.join(', ')}. Source: ${path}`);
        return;
      }
      if (action === 'remove') {
        const next = current.filter(d => d !== domain);
        if (next.length === current.length) {
          console.log(`Domain '${domain}' not in allowlist; no change.`);
          return;
        }
        fs.writeFileSync(path, JSON.stringify(next, null, 2));
        console.log(`Removed '${domain}'. Allowlist now: ${next.join(', ')}. Source: ${path}`);
        return;
      }
      console.error(`Unknown action '${action}'. Use list, add, or remove.`);
      process.exit(1);
    });

  busCommand
    .command('bridge-approve-relay')
    .description('M3: grant David approval for a sensitive bridge response so the next relay tick delivers it to the requesting agent. Writes a one-shot token that the relay consumes on next tick.')
    .argument('<request-id>', 'Bridge request id (e.g. bridge-1750000000-boss-personal-abc123)')
    .option('--reason <reason>', 'Optional reason logged in the approval token + activity feed')
    .action((requestId: string, opts: { reason?: string }) => {
      const env = resolveEnv();
      const fs = require('fs');
      const p = approvalTokenPath(env.ctxRoot, requestId);
      const dir = require('path').dirname(p);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(p, JSON.stringify({
        request_id: requestId,
        approved_by: env.agentName,
        approved_at: new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z'),
        reason: opts.reason || '(none)',
      }, null, 2));
      try { fs.chmodSync(p, 0o600); } catch { /* best-effort */ }
      console.log(`Approval token written to ${p}. Next relay tick will deliver the response.`);
    });

  busCommand
    .command('bridge-reject-relay')
    .description('M3: reject a sensitive bridge response. Relay moves the response to failed/, sends a brief rejection notification to the requesting agent.')
    .argument('<request-id>', 'Bridge request id')
    .requiredOption('--reason <reason>', 'Reason for rejection (logged + included in the requester-side notification)')
    .action((requestId: string, opts: { reason: string }) => {
      const env = resolveEnv();
      const fs = require('fs');
      const p = rejectMarkerPath(env.ctxRoot, requestId);
      const dir = require('path').dirname(p);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(p, JSON.stringify({
        request_id: requestId,
        rejected_by: env.agentName,
        rejected_at: new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z'),
        reason: opts.reason,
      }, null, 2));
      try { fs.chmodSync(p, 0o600); } catch { /* best-effort */ }
      console.log(`Reject marker written to ${p}. Next relay tick will move the response to failed/.`);
    });

  busCommand
    .command('bridge-pending-approvals')
    .description('M3: list bridge responses waiting on David approval (sidecar files in completed/).')
    .action(() => {
      const env = resolveEnv();
      const bridgePaths = resolveBridgePaths(env.ctxRoot);
      const fs = require('fs');
      if (!fs.existsSync(bridgePaths.processed)) {
        console.log('No pending approvals (completed/ dir does not exist yet).');
        return;
      }
      const sidecars = fs.readdirSync(bridgePaths.processed).filter((f: string) => f.endsWith('.pending-approval.json'));
      if (sidecars.length === 0) {
        console.log('No pending approvals.');
        return;
      }
      console.log(`${sidecars.length} pending approval(s):`);
      for (const file of sidecars) {
        try {
          const data = JSON.parse(fs.readFileSync(require('path').join(bridgePaths.processed, file), 'utf-8'));
          console.log(`  - ${data.request_id} (${data.from_agent} → ${data.recipient_agent}) detected ${data.detected_at}`);
          console.log(`    reason: ${data.sensitivity_reason}`);
          console.log(`    description: ${data.description}`);
          console.log(`    approve: cortextos bus bridge-approve-relay ${data.request_id}`);
          console.log(`    reject:  cortextos bus bridge-reject-relay ${data.request_id} --reason "<why>"`);
          console.log('');
        } catch { /* skip malformed sidecar */ }
      }
    });

  busCommand
    .command('bridge-sensitive-domains')
    .description('M3: manage the sensitive-domain list. Subcommands: list, add <domain>, remove <domain>')
    .argument('<action>', 'list, add, or remove')
    .argument('[domain]', 'Domain (required for add/remove)')
    .action((action: string, domain: string | undefined) => {
      const env = resolveEnv();
      const fs = require('fs');
      const path = sensitiveDomainsFilePath(env.ctxRoot);
      const current = Array.from(loadSensitiveDomains(env.ctxRoot));
      if (action === 'list') {
        console.log('Bridge sensitive domains (M3 — responses from these gate for David approval before relay):');
        for (const d of current) console.log(`  - ${d}`);
        console.log(`(source: ${fs.existsSync(path) ? path : 'V1 defaults — write to ' + path + ' to override'})`);
        return;
      }
      if (!domain) {
        console.error(`Domain argument required for action '${action}'.`);
        process.exit(1);
      }
      if (action === 'add') {
        if (current.includes(domain)) {
          console.log(`Domain '${domain}' already in sensitive list; no change.`);
          return;
        }
        current.push(domain);
        const dir = require('path').dirname(path);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path, JSON.stringify(current, null, 2));
        console.log(`Added '${domain}'. Sensitive list now: ${current.join(', ')}.`);
        return;
      }
      if (action === 'remove') {
        const next = current.filter(d => d !== domain);
        if (next.length === current.length) {
          console.log(`Domain '${domain}' not in sensitive list; no change.`);
          return;
        }
        fs.writeFileSync(path, JSON.stringify(next, null, 2));
        console.log(`Removed '${domain}'. Sensitive list now: ${next.join(', ')}.`);
        return;
      }
      console.error(`Unknown action '${action}'. Use list, add, or remove.`);
      process.exit(1);
    });

  busCommand
    .command('bridge-key-status')
    .description('Check whether the bridge signing key is provisioned. Pure read-only; never echoes the key value.')
    .action(() => {
      const env = resolveEnv();
      const path = bridgeKeyPath(env.ctxRoot);
      const key = loadBridgeKey(env.ctxRoot);
      if (key) {
        console.log(`Bridge signing key present at ${path} (${key.length} chars). Bridge requests can be queued.`);
      } else {
        console.log(`Bridge signing key NOT FOUND at ${path}. Run \`cortextos bus generate-bridge-key\` to provision.`);
        process.exit(1);
      }
    });

  busCommand
    .command('bridge-request')
    .description('Queue a task for the agent↔Cowork bridge. Cowork picks up on next scheduled run.')
    .argument('<type>', `Request type (one of: ${V1_ALLOWED_REQUEST_TYPES.join(', ')})`)
    .argument('<description>', 'Plain-English description of the work')
    .requiredOption('--to <agent>', 'Agent that should receive the response in their inbox')
    .option('--context <json>', 'JSON-encoded context payload (request-type-specific schema)', '{}')
    .option('--expected-by <iso8601>', 'Optional SLA deadline')
    .action((type: string, description: string, opts: { to: string; context: string; expectedBy?: string }) => {
      const env = resolveEnv();
      let context: Record<string, unknown>;
      try {
        context = JSON.parse(opts.context);
      } catch (err) {
        console.error(`Invalid --context JSON: ${(err as Error).message}`);
        process.exit(1);
      }
      const bridgePaths = resolveBridgePaths(env.ctxRoot);
      try {
        const id = writeBridgeRequest(bridgePaths, {
          fromAgent: env.agentName,
          requestType: type as BridgeRequestType,
          description,
          context,
          resultDestination: {
            type: 'agent_inbox',
            agent: opts.to,
            ...(opts.expectedBy ? { expected_by: opts.expectedBy } : {}),
          },
        }, env.ctxRoot);
        console.log(id);
      } catch (err) {
        console.error(String((err as Error).message ?? err));
        process.exit(1);
      }
    });

  busCommand
    .command('bridge-status')
    .description('Inspect state of a bridge request by id.')
    .argument('<id>', 'Bridge request id (e.g. bridge-1750000000-boss-personal-abc123)')
    .action((id: string) => {
      const env = resolveEnv();
      const bridgePaths = resolveBridgePaths(env.ctxRoot);
      const status = getBridgeStatus(bridgePaths, id);
      console.log(status);
    });

  busCommand
    .command('bridge-list')
    .description('List all bridge requests across all states (queued / in_progress / completed / failed).')
    .option('--status <state>', 'Filter to a single state')
    .option('--format <fmt>', 'json | table (default table)', 'table')
    .action((opts: { status?: string; format: string }) => {
      const env = resolveEnv();
      const bridgePaths = resolveBridgePaths(env.ctxRoot);
      let summaries = listBridgeRequests(bridgePaths);
      if (opts.status) {
        summaries = summaries.filter(s => s.status === opts.status);
      }
      if (opts.format === 'json') {
        console.log(JSON.stringify(summaries, null, 2));
        return;
      }
      if (summaries.length === 0) {
        console.log('No bridge requests.');
        return;
      }
      console.log('ID                                            STATUS         FROM            TYPE                CREATED                  DESC');
      for (const s of summaries) {
        const id = s.id.padEnd(46);
        const status = s.status.padEnd(14);
        const from = s.fromAgent.padEnd(15);
        const type = s.requestType.padEnd(20);
        const created = s.createdAt.padEnd(25);
        const desc = s.description.length > 60 ? s.description.slice(0, 57) + '...' : s.description;
        console.log(`${id} ${status} ${from} ${type} ${created} ${desc}`);
      }
    });

  busCommand
    .command('bridge-relay-tick')
    .description('Run one relay tick: scan OneDrive completed/, write signed inbox notifications to requesting agents. Idempotent — safe on any cadence.')
    .option('--format <fmt>', 'json | text (default text)', 'text')
    .action((opts: { format: string }) => {
      const env = resolveEnv();
      const bridgePaths = resolveBridgePaths(env.ctxRoot);
      const busPaths = resolvePaths(env.agentName, env.instanceId, env.org);
      // Relay state lives under the running agent's state dir (typically atlas).
      const stateDir = join(env.ctxRoot, 'state', env.agentName);
      const result = relayTick(bridgePaths, busPaths, stateDir);
      if (opts.format === 'json') {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`Bridge relay tick: scanned=${result.scanned} relayed=${result.relayed} skipped_malformed=${result.skipped_malformed} skipped_already_relayed=${result.skipped_already_relayed} failures=${result.failures.length}`);
      for (const f of result.failures) {
        console.log(`  FAIL ${f.id}: ${f.reason}`);
      }
    });

  busCommand
    .command('bridge-janitor')
    .description('Sweep stale bridge requests + retention housekeeping. Run on 4h cron.')
    .option('--stale-after <duration>', 'Mark pending/ entries older than this as failed (e.g. 24h, 12h, 90m)', '24h')
    .option('--format <fmt>', 'json | text', 'text')
    .action((opts: { staleAfter: string; format: string }) => {
      const env = resolveEnv();
      const bridgePaths = resolveBridgePaths(env.ctxRoot);
      const result = sweepBridge(bridgePaths, { staleAfter: opts.staleAfter });
      if (opts.format === 'json') {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(
        `Bridge janitor: timed_out=${result.timed_out} ` +
        `retained_completed=${result.retained_completed} retained_failed=${result.retained_failed} ` +
        `deleted_completed=${result.deleted_completed} deleted_failed=${result.deleted_failed} ` +
        `errors=${result.errors.length}`,
      );
      for (const e of result.errors) {
        console.log(`  ERR ${e.file}: ${e.reason}`);
      }
    });

  // ---------- Phase A: inbound bridge commands ---------------------------

  busCommand
    .command('bridge-inbound-tick')
    .description('Run one inbound-relay tick: scan from-claude/pending/, verify signatures, classify, deliver routine OR gate sensitive. Idempotent. One-writer-locked.')
    .option('--format <fmt>', 'json | text (default text)', 'text')
    .option('--max-per-tick <n>', 'Override max files processed per tick (default 50)', (v) => parseInt(v, 10))
    .action((opts: { format: string; maxPerTick?: number }) => {
      const env = resolveEnv();
      const bridgePaths = resolveBridgePaths(env.ctxRoot);
      const busPaths = resolvePaths(env.agentName, env.instanceId, env.org);
      const stateDir = join(env.ctxRoot, 'state', env.agentName);
      const result = inboundRelayTick({
        bridgePaths, busPaths, stateDir,
        ctxRoot: env.ctxRoot,
        maxPerTick: opts.maxPerTick,
      });
      if (opts.format === 'json') {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(
        `Inbound bridge tick: scanned=${result.scanned} delivered=${result.delivered} ` +
        `pending_approval(new=${result.newly_pending_approval}/still=${result.still_pending_approval}) ` +
        `approved_delivered=${result.approved_and_delivered} rejected=${result.rejected} ` +
        `hard_rule_blocked=${result.hard_rule_blocked} signature_failed=${result.signature_failed} ` +
        `parse_failed=${result.parse_failed} deferred=${result.deferred_rate_limit} ` +
        `failures=${result.failures.length}`,
      );
      for (const f of result.failures) {
        console.log(`  FAIL ${f.id}: ${f.reason}`);
      }
    });

  busCommand
    .command('bridge-inbound-list')
    .description('List inbound message files in a from-claude/ subdir.')
    .argument('[state]', 'pending | pending-approval | processed | blocked (default pending)', 'pending')
    .option('--format <fmt>', 'json | text', 'text')
    .action((state: string, opts: { format: string }) => {
      const env = resolveEnv();
      const bridgePaths = resolveBridgePaths(env.ctxRoot);
      const dirMap: Record<string, string> = {
        'pending': bridgePaths.from_claude_pending,
        'pending-approval': bridgePaths.from_claude_pending_approval,
        'processed': bridgePaths.from_claude_processed,
        'blocked': bridgePaths.from_claude_blocked,
      };
      const dir = dirMap[state];
      if (!dir) {
        console.error(`Unknown state '${state}'. Use: pending | pending-approval | processed | blocked`);
        process.exit(2);
      }
      if (!existsSync(dir)) {
        if (opts.format === 'json') console.log('[]');
        else console.log(`(no entries — directory does not exist yet)`);
        return;
      }
      const files = readdirSync(dir)
        .filter((f) => f.endsWith('.json') && !f.endsWith('.pending-approval.json'))
        .sort();
      if (opts.format === 'json') {
        const entries = files.map((f) => {
          try {
            return { file: f, content: JSON.parse(readFileSync(join(dir, f), 'utf-8')) };
          } catch {
            return { file: f, content: null, error: 'parse failed' };
          }
        });
        console.log(JSON.stringify(entries, null, 2));
        return;
      }
      if (files.length === 0) {
        console.log(`(no entries in from-claude/${state}/)`);
        return;
      }
      console.log(`${files.length} entr${files.length === 1 ? 'y' : 'ies'} in from-claude/${state}/:`);
      for (const f of files) {
        try {
          const m = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
          console.log(`  ${m.id || f}  kind=${m.kind ?? '?'}  to=${m.to_agent ?? '?'}  ${(m.text ?? '').slice(0, 80)}`);
        } catch {
          console.log(`  ${f}  (unparseable)`);
        }
      }
    });

  busCommand
    .command('bridge-inbound-dry-run')
    .description('Classify-only preview of an inbound message file (no delivery, no movement).')
    .argument('<file>', 'Path to an InboundMessage JSON file')
    .action((file: string) => {
      if (!existsSync(file)) {
        console.error(`File not found: ${file}`);
        process.exit(2);
      }
      let parsed: any;
      try {
        parsed = JSON.parse(readFileSync(file, 'utf-8'));
      } catch (err) {
        console.error(`Parse failed: ${(err as Error).message}`);
        process.exit(2);
      }
      console.log(`InboundMessage dry-run:`);
      console.log(`  id:               ${parsed.id}`);
      console.log(`  from:             ${parsed.from}`);
      console.log(`  to_agent:         ${parsed.to_agent}`);
      console.log(`  kind:             ${parsed.kind}`);
      console.log(`  priority:         ${parsed.priority}`);
      console.log(`  sensitive_hint:   ${parsed.sensitive_hint === undefined ? '(unset → conservative default)' : parsed.sensitive_hint}`);
      console.log(`  sig present:      ${typeof parsed.sig === 'string' && parsed.sig.length > 0}`);
      console.log(`  text preview:     ${(parsed.text ?? '').slice(0, 120)}`);
      console.log(`  context:          ${JSON.stringify(parsed.context ?? {})}`);
      console.log(`(Note: actual signature verification + tier classification runs at relay-tick time, against the host's bridge signing key.)`);
    });
}
