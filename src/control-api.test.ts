/**
 * Tests for the control-api: covers auth (missing token, wrong token,
 * fail-closed when env unset), idempotency, and basic schema validation.
 *
 * The handler is exercised at the Web API boundary (`Request → Response`)
 * to keep the test independent of the http server plumbing in
 * webhook-server.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeDb,
  initTestDb,
  runMigrations,
  createAgentGroup,
  getMessagingGroupByPlatform,
  getMessagingGroupAgentByPair,
} from './db/index.js';

vi.mock('./log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const TOKEN = 'test-control-token-' + Math.random().toString(36).slice(2);

function now(): string {
  return new Date().toISOString();
}

function makeReq(opts: {
  method?: string;
  path?: string;
  auth?: string | null;
  body?: unknown;
}): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.auth !== null && opts.auth !== undefined) {
    headers['Authorization'] = opts.auth;
  }
  return new Request(`http://test.local${opts.path || '/api/agent-groups/wirings'}`, {
    method: opts.method || 'POST',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({
    id: 'ag-test',
    name: 'Test',
    folder: 'test',
    agent_provider: null,
    created_at: now(),
  });
  process.env.NANOCLAW_CONTROL_TOKEN = TOKEN;
});

afterEach(() => {
  closeDb();
  delete process.env.NANOCLAW_CONTROL_TOKEN;
});

describe('control-api auth', () => {
  it('returns 503 when NANOCLAW_CONTROL_TOKEN is not set (fail-closed)', async () => {
    delete process.env.NANOCLAW_CONTROL_TOKEN;
    const { handleControlRequest } = await import('./control-api.js');
    const res = await handleControlRequest(
      makeReq({
        auth: `Bearer anything`,
        body: { channel_type: 'discord', platform_id: '@me:1', agent_group_id: 'ag-test' },
      }),
    );
    expect(res?.status).toBe(503);
  });

  it('returns 401 when no Authorization header', async () => {
    const { handleControlRequest } = await import('./control-api.js');
    const res = await handleControlRequest(
      makeReq({
        auth: null,
        body: { channel_type: 'discord', platform_id: '@me:1', agent_group_id: 'ag-test' },
      }),
    );
    expect(res?.status).toBe(401);
  });

  it('returns 401 when token mismatches', async () => {
    const { handleControlRequest } = await import('./control-api.js');
    const res = await handleControlRequest(
      makeReq({
        auth: 'Bearer wrong-token',
        body: { channel_type: 'discord', platform_id: '@me:1', agent_group_id: 'ag-test' },
      }),
    );
    expect(res?.status).toBe(401);
  });

  it('returns null for non-/api paths so caller falls through', async () => {
    const { handleControlRequest } = await import('./control-api.js');
    const res = await handleControlRequest(
      makeReq({ path: '/webhook/discord', auth: `Bearer ${TOKEN}` }),
    );
    expect(res).toBeNull();
  });
});

describe('control-api wiring endpoint', () => {
  it('creates messaging_group + messaging_group_agent on first POST', async () => {
    const { handleControlRequest } = await import('./control-api.js');
    const res = await handleControlRequest(
      makeReq({
        auth: `Bearer ${TOKEN}`,
        body: {
          channel_type: 'discord',
          platform_id: '@me:111',
          agent_group_id: 'ag-test',
          name: 'Test DM',
        },
      }),
    );
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as { messaging_group_id: string; created: boolean };
    expect(body.created).toBe(true);
    const mg = getMessagingGroupByPlatform('discord', '@me:111');
    expect(mg).toBeDefined();
    expect(mg?.id).toBe(body.messaging_group_id);
    const mga = getMessagingGroupAgentByPair(mg!.id, 'ag-test');
    expect(mga).toBeDefined();
    expect(mga?.engage_mode).toBe('pattern');
    expect(mga?.engage_pattern).toBe('.');
    expect(mga?.session_mode).toBe('shared');
  });

  it('is idempotent — second POST with same triple returns existing IDs and created:false', async () => {
    const { handleControlRequest } = await import('./control-api.js');
    const body = {
      channel_type: 'discord',
      platform_id: '@me:222',
      agent_group_id: 'ag-test',
    };
    const res1 = await handleControlRequest(makeReq({ auth: `Bearer ${TOKEN}`, body }));
    const j1 = (await res1!.json()) as { messaging_group_id: string; created: boolean };
    expect(j1.created).toBe(true);

    const res2 = await handleControlRequest(makeReq({ auth: `Bearer ${TOKEN}`, body }));
    const j2 = (await res2!.json()) as { messaging_group_id: string; created: boolean };
    expect(j2.created).toBe(false);
    expect(j2.messaging_group_id).toBe(j1.messaging_group_id);
  });

  it('rejects missing required fields with 400', async () => {
    const { handleControlRequest } = await import('./control-api.js');
    for (const bad of [
      {},
      { channel_type: 'discord' },
      { channel_type: 'discord', platform_id: '@me:333' },
    ]) {
      const res = await handleControlRequest(makeReq({ auth: `Bearer ${TOKEN}`, body: bad }));
      expect(res?.status).toBe(400);
    }
  });

  it('respects optional engage_mode + session_mode overrides', async () => {
    const { handleControlRequest } = await import('./control-api.js');
    const res = await handleControlRequest(
      makeReq({
        auth: `Bearer ${TOKEN}`,
        body: {
          channel_type: 'discord',
          platform_id: '@me:444',
          agent_group_id: 'ag-test',
          engage_mode: 'mention',
          session_mode: 'per-thread',
        },
      }),
    );
    expect(res?.status).toBe(200);
    const mg = getMessagingGroupByPlatform('discord', '@me:444');
    const mga = getMessagingGroupAgentByPair(mg!.id, 'ag-test');
    expect(mga?.engage_mode).toBe('mention');
    expect(mga?.session_mode).toBe('per-thread');
  });

  it('falls back to safe defaults on garbage engage_mode', async () => {
    const { handleControlRequest } = await import('./control-api.js');
    const res = await handleControlRequest(
      makeReq({
        auth: `Bearer ${TOKEN}`,
        body: {
          channel_type: 'discord',
          platform_id: '@me:555',
          agent_group_id: 'ag-test',
          engage_mode: 'totally-bogus',
        },
      }),
    );
    expect(res?.status).toBe(200);
    const mg = getMessagingGroupByPlatform('discord', '@me:555');
    const mga = getMessagingGroupAgentByPair(mg!.id, 'ag-test');
    expect(mga?.engage_mode).toBe('pattern');
  });

  it('returns 404 for unknown control endpoint', async () => {
    const { handleControlRequest } = await import('./control-api.js');
    const res = await handleControlRequest(
      makeReq({ method: 'GET', path: '/api/totally-unknown', auth: `Bearer ${TOKEN}` }),
    );
    expect(res?.status).toBe(404);
  });

  it('rejects malformed JSON body with 400', async () => {
    const { handleControlRequest } = await import('./control-api.js');
    const req = new Request('http://test.local/api/agent-groups/wirings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: '{ not json',
    });
    const res = await handleControlRequest(req);
    expect(res?.status).toBe(400);
  });
});
