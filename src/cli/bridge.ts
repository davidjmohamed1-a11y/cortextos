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

export function registerBridgeCommands(busCommand: Command): void {
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
        });
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
}
