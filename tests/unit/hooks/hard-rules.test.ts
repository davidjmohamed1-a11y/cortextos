import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, openSync, readSync, closeSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  HARD_RULES,
  RULE_GIT_PUSH_MAIN,
  RULE_RM_OUTSIDE_WORKSPACE,
  RULE_GMAIL_SEND_WITHOUT_APPROVAL,
  RULE_PUBLIC_POST,
  approvalDirFor,
  findFreshApprovalToken,
  consumeApprovalToken,
  APPROVAL_TOKEN_MAX_AGE_MS,
  type HardRuleEnv,
} from '../../../src/hooks/hard-rules.js';

const envFor = (agentDir: string, ctxRoot: string): HardRuleEnv => ({
  agentDir,
  agentName: 'testagent',
  ctxRoot,
});

describe('hard-rules — denylist composition', () => {
  it('exports the 4 MVP rules in declared order', () => {
    expect(HARD_RULES.map(r => r.name)).toEqual([
      'git_push_main',
      'rm_outside_workspace',
      'gmail_send_without_approval',
      'public_post',
    ]);
  });
});

describe('RULE_GIT_PUSH_MAIN', () => {
  const env = envFor('/tmp/agent', '/tmp/ctx');

  it('matches bare `git push`', () => {
    expect(RULE_GIT_PUSH_MAIN.match('Bash', { command: 'git push' }, env)).toBe(true);
  });
  it('matches `git push origin main`', () => {
    expect(RULE_GIT_PUSH_MAIN.match('Bash', { command: 'git push origin main' }, env)).toBe(true);
  });
  it('matches `git push -u origin main`', () => {
    expect(RULE_GIT_PUSH_MAIN.match('Bash', { command: 'git push -u origin main' }, env)).toBe(true);
  });
  it('matches `git push --force origin master`', () => {
    expect(RULE_GIT_PUSH_MAIN.match('Bash', { command: 'git push --force origin master' }, env)).toBe(true);
  });
  it('does NOT match push to feature branch', () => {
    expect(RULE_GIT_PUSH_MAIN.match('Bash', { command: 'git push origin feature/foo' }, env)).toBe(false);
  });
  it('does NOT match non-Bash tools', () => {
    expect(RULE_GIT_PUSH_MAIN.match('Edit', { command: 'git push origin main' }, env)).toBe(false);
  });
});

describe('RULE_RM_OUTSIDE_WORKSPACE', () => {
  const agentDir = '/tmp/agent';
  const env = envFor(agentDir, '/tmp/ctx');

  it('matches `rm -rf` outside workspace', () => {
    expect(RULE_RM_OUTSIDE_WORKSPACE.match('Bash', { command: 'rm -rf /Users/foo/data' }, env)).toBe(true);
  });
  it('matches `rm -r` outside workspace', () => {
    expect(RULE_RM_OUTSIDE_WORKSPACE.match('Bash', { command: 'rm -r /tmp/somewhere-else' }, env)).toBe(true);
  });
  it('does NOT match `rm -rf` inside agentDir (absolute path)', () => {
    expect(RULE_RM_OUTSIDE_WORKSPACE.match('Bash', { command: 'rm -rf /tmp/agent/subdir' }, env)).toBe(false);
  });
  it('does NOT match `rm -rf relative-path` inside agentDir (treated as relative)', () => {
    expect(RULE_RM_OUTSIDE_WORKSPACE.match('Bash', { command: 'rm -rf build/dist' }, env)).toBe(false);
  });
  it('matches `rm` with command substitution (cannot statically resolve → block)', () => {
    expect(RULE_RM_OUTSIDE_WORKSPACE.match('Bash', { command: 'rm -rf $(echo /tmp)' }, env)).toBe(true);
  });
  it('matches `rm` with glob (cannot statically resolve → block)', () => {
    expect(RULE_RM_OUTSIDE_WORKSPACE.match('Bash', { command: 'rm -rf /tmp/agent/*' }, env)).toBe(true);
  });
  it('does NOT match non-destructive rm (single file, no -r)', () => {
    expect(RULE_RM_OUTSIDE_WORKSPACE.match('Bash', { command: 'rm /tmp/agent/onefile' }, env)).toBe(false);
  });
  it('does NOT match non-Bash tools', () => {
    expect(RULE_RM_OUTSIDE_WORKSPACE.match('Edit', { command: 'rm -rf /' }, env)).toBe(false);
  });
});

describe('RULE_GMAIL_SEND_WITHOUT_APPROVAL', () => {
  const env = envFor('/tmp/agent', '/tmp/ctx');

  it('matches mcp__claude_ai_Gmail__send_message', () => {
    expect(RULE_GMAIL_SEND_WITHOUT_APPROVAL.match('mcp__claude_ai_Gmail__send_message', {}, env)).toBe(true);
  });
  it('matches mcp__claude_ai_Gmail__send_email', () => {
    expect(RULE_GMAIL_SEND_WITHOUT_APPROVAL.match('mcp__claude_ai_Gmail__send_email', {}, env)).toBe(true);
  });
  it('matches mcp__custom_Gmail__create_and_send', () => {
    expect(RULE_GMAIL_SEND_WITHOUT_APPROVAL.match('mcp__custom_Gmail__create_and_send', {}, env)).toBe(true);
  });
  it('does NOT match read/draft/label gmail tools', () => {
    expect(RULE_GMAIL_SEND_WITHOUT_APPROVAL.match('mcp__claude_ai_Gmail__create_draft', {}, env)).toBe(false);
    expect(RULE_GMAIL_SEND_WITHOUT_APPROVAL.match('mcp__claude_ai_Gmail__label_message', {}, env)).toBe(false);
    expect(RULE_GMAIL_SEND_WITHOUT_APPROVAL.match('mcp__claude_ai_Gmail__search_threads', {}, env)).toBe(false);
  });
  it('does NOT match non-gmail tools', () => {
    expect(RULE_GMAIL_SEND_WITHOUT_APPROVAL.match('mcp__claude_ai_Calendly__create_event', {}, env)).toBe(false);
  });
});

describe('RULE_PUBLIC_POST', () => {
  const env = envFor('/tmp/agent', '/tmp/ctx');

  it('matches linkedin post MCP tool', () => {
    expect(RULE_PUBLIC_POST.match('mcp__some_linkedin_server__post_share', {}, env)).toBe(true);
  });
  it('matches twitter/x post MCP tool', () => {
    expect(RULE_PUBLIC_POST.match('mcp__x_com_server__post_tweet', {}, env)).toBe(true);
  });
  it('matches Notion page-permissions update with public=true', () => {
    expect(RULE_PUBLIC_POST.match(
      'mcp__claude_ai_Notion__update_page_permissions',
      { is_public: true },
      env,
    )).toBe(true);
  });
  it('matches Notion permissions with public string', () => {
    expect(RULE_PUBLIC_POST.match(
      'mcp__claude_ai_Notion__update_page_permissions',
      { permissions: 'public' },
      env,
    )).toBe(true);
  });
  it('matches bash curl POST to linkedin API', () => {
    expect(RULE_PUBLIC_POST.match(
      'Bash',
      { command: 'curl -X POST https://api.linkedin.com/v2/posts' },
      env,
    )).toBe(true);
  });
  it('does NOT match a regular GET to linkedin', () => {
    expect(RULE_PUBLIC_POST.match(
      'Bash',
      { command: 'curl https://www.linkedin.com/feed/' },
      env,
    )).toBe(false);
  });
  it('does NOT match unrelated MCP tools', () => {
    expect(RULE_PUBLIC_POST.match('mcp__claude_ai_Gmail__create_draft', {}, env)).toBe(false);
  });
});

describe('approval-token mechanism', () => {
  it('finds a fresh token when present', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'hardrules-'));
    try {
      const env = envFor('/tmp/agent', tmp);
      const dir = approvalDirFor(env, 'git_push_main');
      mkdirSync(dir, { recursive: true });
      const tokenPath = join(dir, '12345-abc.json');
      writeFileSync(tokenPath, JSON.stringify({ rule: 'git_push_main', granted_at: 'now', reason: 'test' }));

      const found = findFreshApprovalToken(env, 'git_push_main');
      expect(found).toBe(tokenPath);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns null when no tokens exist', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'hardrules-'));
    try {
      const env = envFor('/tmp/agent', tmp);
      expect(findFreshApprovalToken(env, 'git_push_main')).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('ignores tokens older than APPROVAL_TOKEN_MAX_AGE_MS', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'hardrules-'));
    try {
      const env = envFor('/tmp/agent', tmp);
      const dir = approvalDirFor(env, 'git_push_main');
      mkdirSync(dir, { recursive: true });
      const tokenPath = join(dir, 'old-token.json');
      writeFileSync(tokenPath, JSON.stringify({ rule: 'git_push_main' }));
      // Backdate mtime to 10 min ago (well past 5 min threshold)
      const tenMinAgo = Date.now() - (10 * 60 * 1000);
      require('fs').utimesSync(tokenPath, new Date(tenMinAgo), new Date(tenMinAgo));

      expect(findFreshApprovalToken(env, 'git_push_main')).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('consumes (deletes) a token successfully', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'hardrules-'));
    try {
      const env = envFor('/tmp/agent', tmp);
      const dir = approvalDirFor(env, 'public_post');
      mkdirSync(dir, { recursive: true });
      const tokenPath = join(dir, 'consume-me.json');
      writeFileSync(tokenPath, '{}');

      expect(findFreshApprovalToken(env, 'public_post')).toBe(tokenPath);
      consumeApprovalToken(tokenPath);

      // After consume the token is gone
      expect(findFreshApprovalToken(env, 'public_post')).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('consumeApprovalToken is no-op on missing file (safe)', () => {
    expect(() => consumeApprovalToken('/tmp/does/not/exist.json')).not.toThrow();
  });

  it('APPROVAL_TOKEN_MAX_AGE_MS is 5 minutes', () => {
    expect(APPROVAL_TOKEN_MAX_AGE_MS).toBe(5 * 60 * 1000);
  });
});
