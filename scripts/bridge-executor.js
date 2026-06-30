#!/usr/bin/env node
/**
 * Bridge executor entrypoint — thin pm2-launchable wrapper around
 * src/bridge/local-executor.ts runExecutor().
 *
 * Reads ctxRoot from env CTX_ROOT (matches the daemon's env contract).
 * Reads optional CHROME_PROFILE + AGENT_BROWSER_BIN + EXECUTOR_POLL_MS overrides
 * from env so pm2's env block controls behavior without code changes.
 */

const { runExecutor } = require('../dist/bridge/local-executor.js');

const ctxRoot = process.env.CTX_ROOT || '/Users/davidmohamed/.cortextos/default';
const pollMs = process.env.EXECUTOR_POLL_MS ? parseInt(process.env.EXECUTOR_POLL_MS, 10) : undefined;
const chromeProfile = process.env.CHROME_PROFILE;
const agentBrowserBin = process.env.AGENT_BROWSER_BIN;

runExecutor({
  ctxRoot,
  pollIntervalMs: pollMs,
  chromeProfile,
  agentBrowserBin,
  log: (line) => console.log(`[bridge-executor] ${new Date().toISOString()} ${line}`),
}).catch((err) => {
  console.error('[bridge-executor] FATAL:', err.message);
  process.exit(1);
});
