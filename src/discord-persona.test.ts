/**
 * Tests for the Discord webhook persona helper.
 *
 * Mocks the global `fetch` so no network calls escape — verifies:
 *   * webhook list-then-create flow on first send (caches the cred)
 *   * cached cred reused on subsequent sends (no extra list/create)
 *   * 404 on execute drops cache so the next send rediscovers
 *   * permission failure (GET 403) negative-caches the channel for 5min
 *   * no DISCORD_BOT_TOKEN → returns null without touching the network
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetCachesForTest, deliverViaWebhook } from './discord-persona.js';

vi.mock('./log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const realFetch = global.fetch;
beforeEach(() => {
  _resetCachesForTest();
  process.env.DISCORD_BOT_TOKEN = 'test-bot-token';
});
afterEach(() => {
  global.fetch = realFetch;
  delete process.env.DISCORD_BOT_TOKEN;
});

function mockFetchSequence(responses: Array<{ status: number; json?: unknown; text?: string }>): {
  fetchMock: ReturnType<typeof vi.fn>;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  let i = 0;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = responses[i++] ?? { status: 500 };
    return new Response(r.json !== undefined ? JSON.stringify(r.json) : (r.text ?? ''), {
      status: r.status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return { fetchMock, calls };
}

describe('deliverViaWebhook', () => {
  it('returns null when DISCORD_BOT_TOKEN is unset', async () => {
    delete process.env.DISCORD_BOT_TOKEN;
    const id = await deliverViaWebhook({
      channelId: 'chan-1',
      threadId: null,
      text: 'hi',
      username: "Vinamra's agent",
    });
    expect(id).toBeNull();
  });

  it('lists then creates a webhook on first send, executes, and caches', async () => {
    const { calls } = mockFetchSequence([
      // 1. list webhooks → empty
      { status: 200, json: [] },
      // 2. create webhook → returns id+token
      { status: 200, json: { id: 'wh-1', token: 'wht-1', name: 'NanoClaw Persona' } },
      // 3. execute webhook → returns msg id
      { status: 200, json: { id: 'msg-1' } },
    ]);

    const id = await deliverViaWebhook({
      channelId: 'chan-X',
      threadId: null,
      text: 'hello world',
      username: "Vinamra's agent",
    });

    expect(id).toBe('msg-1');
    expect(calls.length).toBe(3);
    expect(calls[0].url).toContain('/channels/chan-X/webhooks');
    expect(calls[0].init?.method).toBe('GET');
    expect(calls[1].url).toContain('/channels/chan-X/webhooks');
    expect(calls[1].init?.method).toBe('POST');
    expect(calls[2].url).toContain('/webhooks/wh-1/wht-1');

    // Auth header carries Bot prefix.
    const auth = (calls[0].init?.headers as Record<string, string>)?.['Authorization'];
    expect(auth).toBe('Bot test-bot-token');
  });

  it('reuses an existing webhook with our name (no create)', async () => {
    const { calls } = mockFetchSequence([
      // 1. list webhooks → returns ours
      {
        status: 200,
        json: [{ id: 'wh-existing', token: 'wht-existing', name: 'NanoClaw Persona' }],
      },
      // 2. execute webhook
      { status: 200, json: { id: 'msg-2' } },
    ]);

    const id = await deliverViaWebhook({
      channelId: 'chan-Y',
      threadId: null,
      text: 'reuse',
      username: "Alice's agent",
    });

    expect(id).toBe('msg-2');
    expect(calls.length).toBe(2);
    expect(calls[1].url).toContain('/webhooks/wh-existing/wht-existing');
  });

  it('caches the cred — second send hits only the execute endpoint', async () => {
    const { calls } = mockFetchSequence([
      { status: 200, json: [] },
      { status: 200, json: { id: 'wh-1', token: 'wht-1' } },
      { status: 200, json: { id: 'msg-1' } },
      { status: 200, json: { id: 'msg-2' } },
    ]);

    const args = {
      channelId: 'chan-cached',
      threadId: null,
      username: "X's agent",
    };
    await deliverViaWebhook({ ...args, text: 'first' });
    await deliverViaWebhook({ ...args, text: 'second' });

    expect(calls.length).toBe(4);
    expect(calls[2].url).toContain('/webhooks/wh-1/wht-1');
    expect(calls[3].url).toContain('/webhooks/wh-1/wht-1');
  });

  it('drops cache on 404 from execute and returns null', async () => {
    mockFetchSequence([
      { status: 200, json: [{ id: 'wh', token: 'wht', name: 'NanoClaw Persona' }] },
      { status: 404, text: 'gone' },
    ]);
    const id = await deliverViaWebhook({
      channelId: 'chan-deleted',
      threadId: null,
      text: 'x',
      username: "X's agent",
    });
    expect(id).toBeNull();
  });

  it('negative-caches when listing webhooks 403s', async () => {
    const { calls } = mockFetchSequence([
      { status: 403, text: 'no perms' },
      // Subsequent calls should never happen due to negative cache.
    ]);
    const id = await deliverViaWebhook({
      channelId: 'chan-noperms',
      threadId: null,
      text: 'x',
      username: 'persona',
    });
    expect(id).toBeNull();
    expect(calls.length).toBe(1);

    // Second call shouldn't even make the GET — negative cache holds.
    const id2 = await deliverViaWebhook({
      channelId: 'chan-noperms',
      threadId: null,
      text: 'y',
      username: 'persona',
    });
    expect(id2).toBeNull();
    expect(calls.length).toBe(1);
  });

  it('appends thread_id query param when set', async () => {
    const { calls } = mockFetchSequence([
      { status: 200, json: [{ id: 'wh', token: 'wht', name: 'NanoClaw Persona' }] },
      { status: 200, json: { id: 'msg-thread' } },
    ]);
    await deliverViaWebhook({
      channelId: 'chan-thread',
      threadId: 'thr-123',
      text: 'in a thread',
      username: 'persona',
    });
    expect(calls[1].url).toContain('thread_id=thr-123');
    expect(calls[1].url).toContain('wait=true');
  });

  it('uses multipart when files are attached', async () => {
    const { calls } = mockFetchSequence([
      { status: 200, json: [{ id: 'wh', token: 'wht', name: 'NanoClaw Persona' }] },
      { status: 200, json: { id: 'msg-with-file' } },
    ]);
    const id = await deliverViaWebhook({
      channelId: 'chan-file',
      threadId: null,
      text: 'see attached',
      username: 'persona',
      files: [{ name: 'slide.png', data: Buffer.from('fake-png-bytes') }],
    });
    expect(id).toBe('msg-with-file');
    // Multipart bodies are FormData — the init.body for the execute call
    // should be a FormData instance, not a string.
    const execCall = calls[1].init?.body;
    expect(execCall).toBeInstanceOf(FormData);
  });
});
