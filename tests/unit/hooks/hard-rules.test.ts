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
  RULE_AUTO_LOGIN_TO_TARGET,
  RULE_CAPTCHA_SOLVER_ENDPOINT,
  RULE_ANTI_DETECT_BROWSER_LIB,
  RULE_IP_ROTATION_TO_EVADE,
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
  it('exports the V1 rules in declared order, fetch-ladder additions appended', () => {
    expect(HARD_RULES.map(r => r.name)).toEqual([
      'git_push_main',
      'rm_outside_workspace',
      'gmail_send_without_approval',
      'public_post',
      'auto_login_to_target',
      'captcha_solver_endpoint',
      'anti_detect_browser_lib',
      'ip_rotation_to_evade',
    ]);
  });

  it('bright-line fetch-ladder rules are non_overridable', () => {
    const ruleByName = (n: string) => HARD_RULES.find(r => r.name === n)!;
    expect(ruleByName('captcha_solver_endpoint').non_overridable).toBe(true);
    expect(ruleByName('anti_detect_browser_lib').non_overridable).toBe(true);
    expect(ruleByName('ip_rotation_to_evade').non_overridable).toBe(true);
  });

  it('auto_login_to_target is overridable (token mechanism)', () => {
    const r = HARD_RULES.find(r => r.name === 'auto_login_to_target')!;
    expect(r.non_overridable).toBeFalsy();
  });

  it('original V1 rules remain overridable (no non_overridable flag)', () => {
    expect(HARD_RULES[0].non_overridable).toBeFalsy(); // git_push_main
    expect(HARD_RULES[1].non_overridable).toBeFalsy(); // rm_outside_workspace
    expect(HARD_RULES[2].non_overridable).toBeFalsy(); // gmail_send
    expect(HARD_RULES[3].non_overridable).toBeFalsy(); // public_post
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

// ---------------------------------------------------------------------------
// Fetch-ladder legal-bright-line rules
// ---------------------------------------------------------------------------

describe('RULE_AUTO_LOGIN_TO_TARGET', () => {
  const env = envFor('/tmp/agent', '/tmp/ctx');

  it('matches Bash curl with password= in -d body', () => {
    expect(RULE_AUTO_LOGIN_TO_TARGET.match(
      'Bash',
      { command: "curl -d 'username=foo&password=bar' https://target.example/login" },
      env,
    )).toBe(true);
  });

  it('matches Bash curl POST with password= field', () => {
    expect(RULE_AUTO_LOGIN_TO_TARGET.match(
      'Bash',
      { command: 'curl -X POST -d "password=secret" https://target.example/auth' },
      env,
    )).toBe(true);
  });

  it('matches WebFetch to /login URL with credential prompt', () => {
    expect(RULE_AUTO_LOGIN_TO_TARGET.match(
      'WebFetch',
      { url: 'https://target.example/login', prompt: 'Sign in to retrieve the dashboard data' },
      env,
    )).toBe(true);
  });

  it('does NOT match WebFetch to /login for documentation read', () => {
    expect(RULE_AUTO_LOGIN_TO_TARGET.match(
      'WebFetch',
      { url: 'https://docs.example.com/api/login-endpoint', prompt: 'What params does this endpoint take?' },
      env,
    )).toBe(false);
  });

  it('matches agent-browser type into a password-shaped field', () => {
    expect(RULE_AUTO_LOGIN_TO_TARGET.match(
      'mcp__claude_ai_agent_browser__type',
      { ref: 'password-input-field', text: 'secret123' },
      env,
    )).toBe(true);
  });

  it('does NOT match agent-browser type into normal field', () => {
    expect(RULE_AUTO_LOGIN_TO_TARGET.match(
      'mcp__claude_ai_agent_browser__type',
      { ref: 'search-query', text: 'hello' },
      env,
    )).toBe(false);
  });
});

describe('RULE_CAPTCHA_SOLVER_ENDPOINT (non-overridable)', () => {
  const env = envFor('/tmp/agent', '/tmp/ctx');

  it('matches Bash curl to 2captcha', () => {
    expect(RULE_CAPTCHA_SOLVER_ENDPOINT.match(
      'Bash', { command: 'curl https://2captcha.com/in.php' }, env,
    )).toBe(true);
  });

  it('matches Bash curl to capsolver', () => {
    expect(RULE_CAPTCHA_SOLVER_ENDPOINT.match(
      'Bash', { command: 'curl https://capsolver.com/api/createTask' }, env,
    )).toBe(true);
  });

  it('matches WebFetch to a solver service', () => {
    expect(RULE_CAPTCHA_SOLVER_ENDPOINT.match(
      'WebFetch', { url: 'https://anti-captcha.com/api/v2/createTask' }, env,
    )).toBe(true);
  });

  it('does NOT match curl to unrelated domains', () => {
    expect(RULE_CAPTCHA_SOLVER_ENDPOINT.match(
      'Bash', { command: 'curl https://example.com/api' }, env,
    )).toBe(false);
  });

  it('is flagged as non_overridable', () => {
    expect(RULE_CAPTCHA_SOLVER_ENDPOINT.non_overridable).toBe(true);
  });
});

describe('RULE_ANTI_DETECT_BROWSER_LIB (non-overridable)', () => {
  const env = envFor('/tmp/agent', '/tmp/ctx');

  it('matches pip install undetected-chromedriver', () => {
    expect(RULE_ANTI_DETECT_BROWSER_LIB.match(
      'Bash', { command: 'pip install undetected-chromedriver' }, env,
    )).toBe(true);
  });

  it('matches npm install puppeteer-extra-plugin-stealth', () => {
    expect(RULE_ANTI_DETECT_BROWSER_LIB.match(
      'Bash', { command: 'npm install puppeteer-extra-plugin-stealth' }, env,
    )).toBe(true);
  });

  it('matches pip install curl-impersonate', () => {
    expect(RULE_ANTI_DETECT_BROWSER_LIB.match(
      'Bash', { command: 'pip install curl-impersonate' }, env,
    )).toBe(true);
  });

  it('matches uv pip install playwright-stealth', () => {
    expect(RULE_ANTI_DETECT_BROWSER_LIB.match(
      'Bash', { command: 'uv pip install playwright-stealth' }, env,
    )).toBe(true);
  });

  it('does NOT match install of legitimate playwright', () => {
    expect(RULE_ANTI_DETECT_BROWSER_LIB.match(
      'Bash', { command: 'npm install playwright' }, env,
    )).toBe(false);
  });

  it('is flagged as non_overridable', () => {
    expect(RULE_ANTI_DETECT_BROWSER_LIB.non_overridable).toBe(true);
  });
});

describe('RULE_IP_ROTATION_TO_EVADE (non-overridable)', () => {
  const env = envFor('/tmp/agent', '/tmp/ctx');

  it('matches Bash curl to brightdata', () => {
    expect(RULE_IP_ROTATION_TO_EVADE.match(
      'Bash', { command: 'curl --proxy http://x:y@brd.superproxy.io:22225 https://target.com' }, env,
    )).toBe(true);
  });

  it('matches Bash curl with smartproxy domain', () => {
    expect(RULE_IP_ROTATION_TO_EVADE.match(
      'Bash', { command: 'curl --proxy http://smartproxy.com:8080 https://target.com' }, env,
    )).toBe(true);
  });

  it('matches HTTPS_PROXY env with rotating-proxy host', () => {
    expect(RULE_IP_ROTATION_TO_EVADE.match(
      'Bash', { command: 'HTTPS_PROXY=http://u:p@brd-customer-1234:1234@brd.example.com curl https://target.com' }, env,
    )).toBe(true);
  });

  it('does NOT match legitimate proxy use (corporate proxy.example.com)', () => {
    expect(RULE_IP_ROTATION_TO_EVADE.match(
      'Bash', { command: 'curl --proxy http://proxy.example.com:8080 https://api.com' }, env,
    )).toBe(false);
  });

  it('is flagged as non_overridable', () => {
    expect(RULE_IP_ROTATION_TO_EVADE.non_overridable).toBe(true);
  });
});
