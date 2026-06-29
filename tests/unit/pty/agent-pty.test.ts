import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, openSync, readSync, closeSync, statSync as realStatSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';

// fs.existsSync + fs.readFileSync are mocked at module level (see vi.mock
// below) so the test callers can't use them to verify real filesystem state.
// Use statSync (not mocked) as an existence probe, and openSync/readSync
// (not mocked) to read file contents.
function existsReal(p: string): boolean {
  try { realStatSync(p); return true; } catch { return false; }
}
function readReal(p: string): string {
  const size = realStatSync(p).size;
  const fd = openSync(p, 'r');
  try {
    const buf = Buffer.alloc(size);
    readSync(fd, buf, 0, size, 0);
    return buf.toString('utf-8');
  } finally {
    closeSync(fd);
  }
}

// node-pty is native; stub it so constructing AgentPTY never touches it.
vi.mock('node-pty', () => ({ spawn: vi.fn() }));

// existsSync=false → the local/*.md system-prompt block is skipped in buildClaudeArgs.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([]),
  };
});

const { AgentPTY } = await import('../../../src/pty/agent-pty.js');

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/test-ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'alice',
  agentDir: '/tmp/fw/orgs/acme/agents/alice',
  org: 'acme',
  projectRoot: '/tmp/fw',
} as any;

function argsFor(config: any): string[] {
  const pty = new AgentPTY(mockEnv, config);
  return (pty as unknown as { buildClaudeArgs(m: 'fresh' | 'continue', p: string): string[] })
    .buildClaudeArgs('fresh', 'PROMPT');
}

// Helpers for the CLAUDE_CONFIG_DIR isolation suite. These call the private
// methods on a real AgentPTY instance via the cast pattern already used above.
type ConfigDirHelpers = {
  resolveClaudeConfigDir(): string | null;
  ensureConfigDirReady(dir: string, apiKey: string | undefined): void;
};
function helpersFor(envOverrides: Record<string, unknown>, config: any): ConfigDirHelpers {
  const pty = new AgentPTY({ ...mockEnv, ...envOverrides } as any, config);
  return pty as unknown as ConfigDirHelpers;
}

describe('AgentPTY claude_config_dir resolution', () => {
  it('returns null when the field is absent (legacy shared ~/.claude)', () => {
    expect(helpersFor({}, {}).resolveClaudeConfigDir()).toBeNull();
  });

  it('returns null when the field is explicit "shared"', () => {
    expect(helpersFor({}, { claude_config_dir: 'shared' }).resolveClaudeConfigDir()).toBeNull();
  });

  it('returns <agentDir>/.claude-config when "isolated"', () => {
    expect(helpersFor({}, { claude_config_dir: 'isolated' }).resolveClaudeConfigDir())
      .toBe('/tmp/fw/orgs/acme/agents/alice/.claude-config');
  });

  it('returns the literal path for any other string (escape hatch)', () => {
    expect(helpersFor({}, { claude_config_dir: '/custom/path' }).resolveClaudeConfigDir())
      .toBe('/custom/path');
  });

  it('falls back to null + warns when "isolated" but agentDir is missing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const h = helpersFor({ agentDir: undefined as any }, { claude_config_dir: 'isolated' });
      expect(h.resolveClaudeConfigDir()).toBeNull();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('AgentPTY ensureConfigDirReady', () => {
  // These tests touch the real filesystem (tmpdir), bypassing the fs mock
  // above via the *real* fs imports at top of file. ensureConfigDirReady uses
  // the mocked fs, so the helpers below verify state after.
  it('creates the dir and writes pre-approved settings.json when ANTHROPIC_API_KEY is set', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cortextos-cfgdir-'));
    try {
      // Un-mock fs for this specific call by spawning a fresh instance + using
      // the actual node fs underneath. The mock only stubs the module's
      // existsSync/readFileSync/readdirSync — mkdirSync/writeFileSync/statSync
      // are passed through via the vi.mock '...actual' spread.
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const h = helpersFor({ agentDir: tmp }, { claude_config_dir: 'isolated' });
        const dir = join(tmp, '.claude-config');
        h.ensureConfigDirReady(dir, 'sk-ant-fake-key-for-test');

        expect(existsReal(dir)).toBe(true);
        const settingsPath = join(dir, 'settings.json');
        expect(existsReal(settingsPath)).toBe(true);

        const parsed = JSON.parse(readReal(settingsPath, 'utf-8'));
        const expectedHash = createHash('sha256').update('sk-ant-fake-key-for-test').digest('hex');
        expect(parsed.customApiKeyResponses.approved).toEqual([expectedHash]);
        expect(parsed.customApiKeyResponses.rejected).toEqual([]);

        // Startup logline includes path + byte count
        expect(log).toHaveBeenCalledWith(expect.stringMatching(/CLAUDE_CONFIG_DIR=.+settings\.json bytes=\d+/));
      } finally {
        log.mockRestore();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('creates the dir but skips settings.json when no API key is in play (OAuth fallback path)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cortextos-cfgdir-'));
    try {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const h = helpersFor({ agentDir: tmp }, { claude_config_dir: 'isolated' });
        const dir = join(tmp, '.claude-config');
        h.ensureConfigDirReady(dir, undefined);

        expect(existsReal(dir)).toBe(true);
        expect(existsReal(join(dir, 'settings.json'))).toBe(false);
        expect(log).toHaveBeenCalledWith(expect.stringContaining('settings.json bytes=0'));
      } finally {
        log.mockRestore();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // Note: an "does NOT overwrite an existing settings.json" test would
  // exercise the `!existsSync(settingsPath)` guard, but this file's fs mock
  // forces existsSync to always return false — so the guard cannot be
  // exercised here. The guard's source is reviewed at agent-pty.ts in
  // ensureConfigDirReady; an integration test (real filesystem, no mock)
  // would be the right home for that assertion.

  it('sets restrictive perms on the dir (0700) and settings.json (0600)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cortextos-cfgdir-'));
    try {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const h = helpersFor({ agentDir: tmp }, { claude_config_dir: 'isolated' });
        const dir = join(tmp, '.claude-config');
        h.ensureConfigDirReady(dir, 'sk-ant-fake');

        const dirMode = realStatSync(dir).mode & 0o777;
        const fileMode = realStatSync(join(dir, 'settings.json')).mode & 0o777;
        expect(dirMode).toBe(0o700);
        expect(fileMode).toBe(0o600);
      } finally {
        log.mockRestore();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('AgentPTY --dangerously-skip-permissions toggle', () => {
  it('includes the flag by default (back-compat: skip stays ON)', () => {
    expect(argsFor({})).toContain('--dangerously-skip-permissions');
  });

  it('includes the flag when dangerously_skip_permissions is explicitly true', () => {
    expect(argsFor({ dangerously_skip_permissions: true })).toContain('--dangerously-skip-permissions');
  });

  it('does NOT include the flag when dangerously_skip_permissions is false (permission gate engaged)', () => {
    expect(argsFor({ dangerously_skip_permissions: false })).not.toContain('--dangerously-skip-permissions');
  });

  it('includes the flag when dangerously_skip_permissions is explicitly undefined (treated as default)', () => {
    expect(argsFor({ dangerously_skip_permissions: undefined })).toContain('--dangerously-skip-permissions');
  });

  it('fails safe (keeps the flag) and warns on a non-boolean value, e.g. the string "false"', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // A typo'd string must NOT silently disable the skip flag.
      expect(argsFor({ dangerously_skip_permissions: 'false' as any })).toContain('--dangerously-skip-permissions');
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
