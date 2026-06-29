import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  appendCommsArchive,
  searchCommsArchive,
  COMMS_ARCHIVE_SCHEMA_VERSION,
} from '../../../src/bus/comms-archive.js';

describe('appendCommsArchive — schema + file layout', () => {
  it('writes a single JSONL line with the V1 schema', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'commsarchive-'));
    try {
      appendCommsArchive({
        ctxRoot: tmp,
        agent: 'forge',
        direction: 'outbound',
        channel: 'agent_bus',
        sender: 'forge',
        recipient: 'boss-personal',
        text: 'hello world',
        msg_id: 'msg-123',
      });
      const month = new Date().toISOString().slice(0, 7);
      const file = join(tmp, 'analytics', 'comms', month, 'forge.jsonl');
      expect(existsSync(file)).toBe(true);
      const lines = readFileSync(file, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(1);
      const entry = JSON.parse(lines[0]);
      expect(entry.version).toBe(COMMS_ARCHIVE_SCHEMA_VERSION);
      expect(entry.agent).toBe('forge');
      expect(entry.direction).toBe('outbound');
      expect(entry.channel).toBe('agent_bus');
      expect(entry.sender).toBe('forge');
      expect(entry.recipient).toBe('boss-personal');
      expect(entry.text).toBe('hello world');
      expect(entry.msg_id).toBe('msg-123');
      expect(entry.reply_to).toBe('');
      expect(entry.metadata).toEqual({});
      expect(entry.id).toMatch(/^\d+-[a-f0-9]{6}$/);
      expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('appends multiple entries to the same agent+month file', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'commsarchive-'));
    try {
      for (let i = 0; i < 3; i++) {
        appendCommsArchive({
          ctxRoot: tmp,
          agent: 'forge',
          direction: 'outbound',
          channel: 'agent_bus',
          sender: 'forge',
          recipient: 'atlas',
          text: `msg ${i}`,
        });
      }
      const month = new Date().toISOString().slice(0, 7);
      const file = join(tmp, 'analytics', 'comms', month, 'forge.jsonl');
      const lines = readFileSync(file, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(3);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('separates per-agent files (one file per perspective)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'commsarchive-'));
    try {
      appendCommsArchive({
        ctxRoot: tmp, agent: 'forge', direction: 'outbound', channel: 'agent_bus',
        sender: 'forge', recipient: 'atlas', text: 'A',
      });
      appendCommsArchive({
        ctxRoot: tmp, agent: 'atlas', direction: 'inbound', channel: 'agent_bus',
        sender: 'forge', recipient: 'atlas', text: 'A',
      });
      const month = new Date().toISOString().slice(0, 7);
      const dir = join(tmp, 'analytics', 'comms', month);
      const files = readdirSync(dir).sort();
      expect(files).toEqual(['atlas.jsonl', 'forge.jsonl']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('does NOT throw on filesystem error (best-effort)', () => {
    // ctxRoot is a nonexistent path with no parents — ensureDir should still
    // try to mkdir -p; this just confirms no throw escapes the function.
    expect(() => appendCommsArchive({
      ctxRoot: '/dev/null/cannot-write-here',
      agent: 'forge',
      direction: 'outbound',
      channel: 'agent_bus',
      sender: 'forge',
      recipient: 'x',
      text: 'should fail silently',
    })).not.toThrow();
  });

  it('preserves custom metadata', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'commsarchive-'));
    try {
      appendCommsArchive({
        ctxRoot: tmp, agent: 'kai', direction: 'inbound', channel: 'telegram',
        sender: 'chat-12345', recipient: 'kai', text: 'voice msg',
        metadata: { voice_file_path: '/tmp/voice.ogg', duration_s: 17 },
      });
      const month = new Date().toISOString().slice(0, 7);
      const file = join(tmp, 'analytics', 'comms', month, 'kai.jsonl');
      const entry = JSON.parse(readFileSync(file, 'utf-8').trim());
      expect(entry.metadata.voice_file_path).toBe('/tmp/voice.ogg');
      expect(entry.metadata.duration_s).toBe(17);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('searchCommsArchive', () => {
  it('returns empty array when archive root is absent', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'commssearch-'));
    try {
      const results = searchCommsArchive({ ctxRoot: tmp });
      expect(results).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns all entries when no filters set', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'commssearch-'));
    try {
      for (let i = 0; i < 5; i++) {
        appendCommsArchive({
          ctxRoot: tmp, agent: 'forge', direction: 'outbound', channel: 'agent_bus',
          sender: 'forge', recipient: 'atlas', text: `msg ${i}`,
        });
      }
      const results = searchCommsArchive({ ctxRoot: tmp });
      expect(results).toHaveLength(5);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('filters by agent', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'commssearch-'));
    try {
      appendCommsArchive({
        ctxRoot: tmp, agent: 'forge', direction: 'outbound', channel: 'agent_bus',
        sender: 'forge', recipient: 'atlas', text: 'from forge',
      });
      appendCommsArchive({
        ctxRoot: tmp, agent: 'atlas', direction: 'outbound', channel: 'agent_bus',
        sender: 'atlas', recipient: 'forge', text: 'from atlas',
      });
      expect(searchCommsArchive({ ctxRoot: tmp, agent: 'forge' })).toHaveLength(1);
      expect(searchCommsArchive({ ctxRoot: tmp, agent: 'atlas' })).toHaveLength(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('filters by channel', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'commssearch-'));
    try {
      appendCommsArchive({
        ctxRoot: tmp, agent: 'forge', direction: 'outbound', channel: 'agent_bus',
        sender: 'forge', recipient: 'x', text: 'bus msg',
      });
      appendCommsArchive({
        ctxRoot: tmp, agent: 'forge', direction: 'outbound', channel: 'telegram',
        sender: 'forge', recipient: 'chat-1', text: 'tg msg',
      });
      const busOnly = searchCommsArchive({ ctxRoot: tmp, channel: 'agent_bus' });
      expect(busOnly).toHaveLength(1);
      expect(busOnly[0].channel).toBe('agent_bus');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('filters by direction', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'commssearch-'));
    try {
      appendCommsArchive({ ctxRoot: tmp, agent: 'forge', direction: 'outbound', channel: 'agent_bus', sender: 'forge', recipient: 'a', text: 'out' });
      appendCommsArchive({ ctxRoot: tmp, agent: 'forge', direction: 'inbound', channel: 'agent_bus', sender: 'b', recipient: 'forge', text: 'in' });
      expect(searchCommsArchive({ ctxRoot: tmp, direction: 'outbound' })).toHaveLength(1);
      expect(searchCommsArchive({ ctxRoot: tmp, direction: 'inbound' })).toHaveLength(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('filters by query (case-insensitive)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'commssearch-'));
    try {
      appendCommsArchive({ ctxRoot: tmp, agent: 'kai', direction: 'outbound', channel: 'telegram', sender: 'kai', recipient: 'c', text: 'Re: Nick Coffee draft' });
      appendCommsArchive({ ctxRoot: tmp, agent: 'kai', direction: 'outbound', channel: 'telegram', sender: 'kai', recipient: 'c', text: 'Re: Mark Suppa intro' });
      const r = searchCommsArchive({ ctxRoot: tmp, query: 'nick' });
      expect(r).toHaveLength(1);
      expect(r[0].text).toContain('Nick Coffee');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('respects limit', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'commssearch-'));
    try {
      for (let i = 0; i < 10; i++) {
        appendCommsArchive({ ctxRoot: tmp, agent: 'forge', direction: 'outbound', channel: 'agent_bus', sender: 'forge', recipient: 'x', text: `${i}` });
      }
      expect(searchCommsArchive({ ctxRoot: tmp, limit: 3 })).toHaveLength(3);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('skips malformed JSONL lines silently', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'commssearch-'));
    try {
      appendCommsArchive({ ctxRoot: tmp, agent: 'forge', direction: 'outbound', channel: 'agent_bus', sender: 'forge', recipient: 'a', text: 'good' });
      // Inject a malformed line directly
      const month = new Date().toISOString().slice(0, 7);
      const file = join(tmp, 'analytics', 'comms', month, 'forge.jsonl');
      require('fs').appendFileSync(file, '{ not valid json\n');
      const results = searchCommsArchive({ ctxRoot: tmp });
      expect(results).toHaveLength(1);
      expect(results[0].text).toBe('good');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
