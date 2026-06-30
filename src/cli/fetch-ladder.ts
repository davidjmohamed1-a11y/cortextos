/**
 * CLI commands for the fetch-ladder subsystem.
 *
 * Mounted onto the `bus` command tree (see registerFetchLadderCommands).
 * Operator-facing — surfaces are read-only-by-default + explicit forget for
 * cache override. Agents typically call `fetchUrl()` programmatically; this
 * CLI exists for human smoke-testing + per-domain cache management.
 */

import { Command } from 'commander';

import { fetchUrl } from '../fetch-ladder/index.js';
import {
  loadSitePolicy,
  listSitePolicies,
  forgetSitePolicy,
  registrableDomain,
} from '../fetch-ladder/site-policy.js';
import { resolveEnv } from '../utils/env.js';

export function registerFetchLadderCommands(parent: Command): void {
  parent
    .command('fetch-url')
    .description('Fetch a URL through the legal fetch ladder (rungs 0-4). Returns the first rung that succeeds + full attempt history.')
    .argument('<url>', 'URL to fetch (http or https)')
    .option('--format <fmt>', 'Output format: text | json', 'text')
    .option('--force', 'Re-evaluate from rung 0 even if a best_rung is cached')
    .action(async (url: string, opts: { format: string; force?: boolean }) => {
      const { ctxRoot } = resolveEnv();
      const result = await fetchUrl(url, { ctxRoot, force: opts.force });
      if (opts.format === 'json') {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      // Text format
      console.log(`URL:        ${result.url}`);
      console.log(`Success:    ${result.success ? 'YES' : 'NO'}`);
      if (result.success && result.rung_succeeded !== undefined) {
        console.log(`Rung used:  ${result.rung_succeeded} (${rungName(result.rung_succeeded)})`);
      }
      if (result.do_not_attempt) {
        console.log(`Status:     do_not_attempt (legal hard-stop)`);
      }
      if (result.needs_human_gate) {
        console.log(`Status:     needs_human_gate (Phase 2 rung 6 required)`);
      }
      console.log('');
      console.log('Attempts:');
      for (const a of result.attempts) {
        const tick = a.ok ? '✓' : '✗';
        const reason = a.fail_reason ? ` [${a.fail_reason}]` : '';
        console.log(`  ${tick} rung ${a.rung} (${rungName(a.rung)})${reason}  ${a.detail ?? ''}`);
      }
      if (result.success && result.content) {
        console.log('');
        console.log('Content (first 500 bytes):');
        console.log(result.content.slice(0, 500));
        if (result.content.length > 500) console.log(`... (+${result.content.length - 500} more bytes)`);
      }
      if (result.facts && Object.keys(result.facts).length > 0) {
        console.log('');
        console.log('Facts:');
        console.log(JSON.stringify(result.facts, null, 2));
      }
      process.exit(result.success ? 0 : 1);
    });

  const sp = parent
    .command('site-policy')
    .description('Inspect or manage the per-domain fetch-ladder policy cache.');

  sp.command('list')
    .description('List all domains with a cached policy entry.')
    .option('--format <fmt>', 'Output format: text | json', 'text')
    .action((opts: { format: string }) => {
      const { ctxRoot } = resolveEnv();
      const domains = listSitePolicies(ctxRoot);
      if (opts.format === 'json') {
        console.log(JSON.stringify(domains, null, 2));
        return;
      }
      if (domains.length === 0) {
        console.log('(no site-policy entries cached yet)');
        return;
      }
      console.log(`${domains.length} cached site-policy ${domains.length === 1 ? 'entry' : 'entries'}:`);
      for (const d of domains) console.log(`  - ${d}`);
    });

  sp.command('show')
    .description('Show the cached policy for a domain (input can be a full URL or bare domain).')
    .argument('<domain-or-url>', 'Domain (notion.so) or URL (https://notion.so/page)')
    .option('--format <fmt>', 'Output format: text | json', 'text')
    .action((domainOrUrl: string, opts: { format: string }) => {
      const { ctxRoot } = resolveEnv();
      const domain = resolveDomainArg(domainOrUrl);
      const policy = loadSitePolicy(ctxRoot, domain);
      if (opts.format === 'json') {
        console.log(JSON.stringify(policy, null, 2));
        return;
      }
      console.log(`Domain:           ${policy.domain || '(none cached — empty default)'}`);
      console.log(`Updated:          ${policy.updated_at}`);
      console.log(`TTL hours:        ${policy.ttl_hours}`);
      console.log(`Best rung:        ${policy.best_rung ?? '(none)'}`);
      console.log(`Blocked rungs:    ${policy.blocked_rungs.join(', ') || '(none)'}`);
      console.log(`do_not_attempt:   ${policy.do_not_attempt ? 'YES (hard legal stop)' : 'no'}`);
      console.log(`needs_human_gate: ${policy.needs_human_gate ? 'YES (Phase 2 rung 6)' : 'no'}`);
      if (policy.robots) {
        console.log(`Robots:           allowed=${policy.robots.allowed}, fetched=${policy.robots.fetched_at}`);
        if (policy.robots.sitemap) console.log(`Robots sitemap:   ${policy.robots.sitemap}`);
      }
      if (policy.api) {
        console.log(`API:              ${policy.api.exists ? 'available' : 'none'}, base=${policy.api.base ?? ''}, auth_env=${policy.api.auth_env ?? ''}`);
      }
      if (policy.last_success) {
        console.log(`Last success:     rung ${policy.last_success.rung} @ ${policy.last_success.at}`);
      }
      if (policy.last_fail) {
        console.log(`Last failure:     rung ${policy.last_fail.rung} @ ${policy.last_fail.at}  (${policy.last_fail.reason})`);
      }
    });

  sp.command('forget')
    .description('Drop the cached policy for a domain. Use when a site has materially changed (new API, lifted ToS, etc.).')
    .argument('<domain-or-url>', 'Domain or URL')
    .action((domainOrUrl: string) => {
      const { ctxRoot } = resolveEnv();
      const domain = resolveDomainArg(domainOrUrl);
      const removed = forgetSitePolicy(ctxRoot, domain);
      if (removed) {
        console.log(`Dropped policy for ${domain}.`);
      } else {
        console.log(`No policy cached for ${domain}.`);
        process.exit(1);
      }
    });
}

function rungName(r: number): string {
  switch (r) {
    case 0: return 'robots/ToS';
    case 1: return 'official-api';
    case 2: return 'structured-data';
    case 3: return 'search-api';
    case 4: return 'archive';
    case 5: return 'real-browser (Phase 2)';
    case 6: return 'human-gate (Phase 2)';
    default: return 'unknown';
  }
}

function resolveDomainArg(arg: string): string {
  if (arg.includes('://')) {
    try {
      const u = new URL(arg);
      return registrableDomain(u.hostname);
    } catch {
      return registrableDomain(arg);
    }
  }
  return registrableDomain(arg);
}
