/**
 * Tests for the late-binding provider-key slash-command handler.
 *
 * Critical invariants:
 *   - Non-matching messages MUST return {handled: false}.
 *   - On any path that returns {handled: true}, the plaintext value MUST NOT
 *     appear in `replyText` (that would just leak it back to the same chat).
 *   - The handler must POST to ChatCSE with the value, but never log it.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleProviderKey } from './provider-key-handler.js';

// Helper: build a temp ~student-assistant/.env so the handler reads our values.
function makeFakeEnv(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkey-test-'));
  const envPath = path.join(dir, '.env');
  fs.writeFileSync(envPath, content, { mode: 0o600 });
  return envPath;
}

const SECRET = 'hGWOcB.L182I0NxkODB9Aj58FEURAW3lpFd8GEJirOnHzNr';

describe('handleProviderKey', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.STUDENT_ASSISTANT_ENV_PATH;
  });

  it('returns handled=false for plain chat text', async () => {
    expect(await handleProviderKey('hello world')).toEqual({ handled: false });
    expect(await handleProviderKey('what is paxos')).toEqual({ handled: false });
  });

  it('returns handled=false for unknown slash commands', async () => {
    expect(await handleProviderKey('/help')).toEqual({ handled: false });
    expect(await handleProviderKey('/unknown-cmd foo')).toEqual({ handled: false });
    expect(await handleProviderKey('/edstem-key')).toEqual({ handled: false }); // missing value
    expect(await handleProviderKey('/edstem-key abc')).toEqual({ handled: false }); // <6 chars
  });

  it('handles /edstem-key happy path and never echoes the secret', async () => {
    process.env.STUDENT_ASSISTANT_ENV_PATH = makeFakeEnv(
      `CHATCSE_AGENT_TOKEN=fake-token\nCHATCSE_BASE_URL=http://localhost:8000\n`
    );
    let capturedBody: any = null;
    let capturedAuth: string | null = null;
    globalThis.fetch = vi.fn(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string);
      capturedAuth = (init?.headers as Record<string, string>)?.Authorization || null;
      return new Response(JSON.stringify({ provider: 'edstem' }), { status: 201 });
    }) as any;

    const result = await handleProviderKey(`/edstem-key ${SECRET}`);
    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.replyText).not.toContain(SECRET);
      expect(result.replyText.toLowerCase()).toContain('edstem');
      expect(result.replyText.toLowerCase()).toContain('please delete');
    }
    expect(capturedBody?.value).toBe(SECRET);
    expect(capturedAuth).toBe('Bearer fake-token');
  });

  it('surfaces ChatCSE 4xx without echoing the secret', async () => {
    process.env.STUDENT_ASSISTANT_ENV_PATH = makeFakeEnv(
      `CHATCSE_AGENT_TOKEN=fake-token\nCHATCSE_BASE_URL=http://localhost:8000\n`
    );
    globalThis.fetch = vi.fn(async () => new Response('something broke', { status: 400 })) as any;

    const result = await handleProviderKey(`/edstem-key ${SECRET}`);
    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.replyText).not.toContain(SECRET);
      expect(result.replyText).toContain('400');
    }
  });

  it('surfaces network failure without echoing the secret', async () => {
    process.env.STUDENT_ASSISTANT_ENV_PATH = makeFakeEnv(
      `CHATCSE_AGENT_TOKEN=fake-token\nCHATCSE_BASE_URL=http://localhost:8000\n`
    );
    globalThis.fetch = vi.fn(async () => {
      throw new Error('connection refused');
    }) as any;

    const result = await handleProviderKey(`/edstem-key ${SECRET}`);
    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.replyText).not.toContain(SECRET);
      expect(result.replyText).toContain('connection refused');
    }
  });

  it('refuses gracefully when CHATCSE_AGENT_TOKEN is missing', async () => {
    process.env.STUDENT_ASSISTANT_ENV_PATH = makeFakeEnv(
      `CHATCSE_BASE_URL=http://localhost:8000\n`
    );
    const result = await handleProviderKey(`/edstem-key ${SECRET}`);
    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.replyText).not.toContain(SECRET);
      expect(result.replyText).toMatch(/CHATCSE_AGENT_TOKEN/);
    }
  });

  it('falls back to deriving CHATCSE base URL from VIRTUAL_TA_URL', async () => {
    process.env.STUDENT_ASSISTANT_ENV_PATH = makeFakeEnv(
      `CHATCSE_AGENT_TOKEN=fake\nVIRTUAL_TA_URL=http://host.docker.internal:8001\n`
    );
    let capturedUrl = '';
    globalThis.fetch = vi.fn(async (url) => {
      capturedUrl = url.toString();
      return new Response('{}', { status: 201 });
    }) as any;

    await handleProviderKey(`/edstem-key ${SECRET}`);
    // VIRTUAL_TA_URL is :8001 (MCP); REST is on :8000.
    expect(capturedUrl).toBe(
      'http://host.docker.internal:8000/api/agent/credentials/edstem'
    );
  });

  it.each([
    ['/canvas-key', 'canvas'],
    ['/gradescope-key', 'gradescope'],
  ])('handles %s by routing to /api/agent/credentials/%s', async (cmd, slug) => {
    process.env.STUDENT_ASSISTANT_ENV_PATH = makeFakeEnv(
      `CHATCSE_AGENT_TOKEN=fake\nCHATCSE_BASE_URL=http://localhost:8000\n`
    );
    let capturedUrl = '';
    globalThis.fetch = vi.fn(async (url) => {
      capturedUrl = url.toString();
      return new Response('{}', { status: 201 });
    }) as any;
    const result = await handleProviderKey(`${cmd} ${SECRET}`);
    expect(result.handled).toBe(true);
    expect(capturedUrl).toBe(`http://localhost:8000/api/agent/credentials/${slug}`);
  });

  it('case-insensitive matches the slash command', async () => {
    process.env.STUDENT_ASSISTANT_ENV_PATH = makeFakeEnv(
      `CHATCSE_AGENT_TOKEN=fake\nCHATCSE_BASE_URL=http://localhost:8000\n`
    );
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 201 })) as any;
    const result = await handleProviderKey(`/EdStem-Key ${SECRET}`);
    expect(result.handled).toBe(true);
  });
});
