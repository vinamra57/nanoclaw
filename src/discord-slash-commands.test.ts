/**
 * Tests for Discord slash-command + modal handlers.
 *
 * Discord's REST API is mocked with a global fetch stub. We assert on:
 *   - what we POST back to Discord (the modal payload shape, the ephemeral
 *     follow-up shape)
 *   - what we POST to ChatCSE (correct provider URL, bearer token from env)
 *   - the secret value never appears in any log line (matching M4's
 *     invariant for the message-based handler)
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  extractModalValue,
  handleApplicationCommand,
  handleConnectCommand,
  handleModalSubmit,
  registerSlashCommands,
} from './discord-slash-commands.js';

function makeFakeEnv(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modal-test-'));
  const envPath = path.join(dir, '.env');
  fs.writeFileSync(envPath, content, { mode: 0o600 });
  return envPath;
}

const SECRET = 'hGWOcB.L182I0NxkODB9Aj58FEURAW3lpFd8GEJirOnHzNr';

describe('extractModalValue', () => {
  it('returns the TextInput value at components[0].components[0]', () => {
    const data = {
      components: [
        {
          type: 1,
          components: [{ type: 4, custom_id: 'value', value: SECRET }],
        },
      ],
    };
    expect(extractModalValue(data)).toBe(SECRET);
  });

  it('returns null when components is missing', () => {
    expect(extractModalValue({})).toBeNull();
    expect(extractModalValue({ components: [] })).toBeNull();
  });

  it('returns null when no field has custom_id "value"', () => {
    const data = {
      components: [
        {
          type: 1,
          components: [{ type: 4, custom_id: 'other', value: 'x' }],
        },
      ],
    };
    expect(extractModalValue(data)).toBeNull();
  });
});

describe('registerSlashCommands', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('PUTs the command list to applications/{appId}/commands', async () => {
    let capturedUrl = '';
    let capturedBody: any = null;
    let capturedAuth = '';
    globalThis.fetch = vi.fn(async (url, init) => {
      capturedUrl = url.toString();
      capturedBody = JSON.parse(init?.body as string);
      capturedAuth = (init?.headers as Record<string, string>)?.Authorization || '';
      return new Response('[]', { status: 200 });
    }) as any;

    const n = await registerSlashCommands('app-123', 'bot-token-abc');
    expect(n).toBe(4);
    expect(capturedUrl).toBe('https://discord.com/api/v10/applications/app-123/commands');
    expect(capturedAuth).toBe('Bot bot-token-abc');
    const names = capturedBody.map((c: any) => c.name).sort();
    expect(names).toEqual(['canvas-key', 'connect', 'edstem-key', 'gradescope-key']);
    // CRITICAL: the *-key commands must NOT have an `options` field — Discord
    // renders option values in chat history, which would defeat the modal's
    // whole point. /connect's option is fine (it's a fixed toolkit name, not a secret).
    for (const cmd of capturedBody) {
      if (cmd.name.endsWith('-key')) {
        expect(cmd.options).toBeUndefined();
      }
    }
    // /connect's app option must use the closed `choices` list (no free text).
    const connect = capturedBody.find((c: any) => c.name === 'connect');
    expect(connect.options[0].name).toBe('app');
    expect(connect.options[0].required).toBe(true);
    expect(connect.options[0].choices.length).toBeGreaterThan(0);
  });

  it('returns 0 when appId or botToken is missing', async () => {
    expect(await registerSlashCommands('', 'token')).toBe(0);
    expect(await registerSlashCommands('app', '')).toBe(0);
  });

  it('returns 0 (does not throw) on Discord API failure', async () => {
    globalThis.fetch = vi.fn(async () => new Response('forbidden', { status: 403 })) as any;
    expect(await registerSlashCommands('app', 'bot')).toBe(0);
  });
});

describe('handleApplicationCommand', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it.each(['edstem-key', 'canvas-key', 'gradescope-key'])('responds with a modal for /%s', async (cmdName) => {
    let capturedUrl = '';
    let capturedBody: any = null;
    globalThis.fetch = vi.fn(async (url, init) => {
      capturedUrl = url.toString();
      capturedBody = JSON.parse(init?.body as string);
      return new Response(null, { status: 204 });
    }) as any;
    const interaction = {
      id: 'iid-1',
      token: 'itok-1',
      data: { name: cmdName },
    };
    const handled = await handleApplicationCommand(interaction);
    expect(handled).toBe(true);
    expect(capturedUrl).toBe('https://discord.com/api/v10/interactions/iid-1/itok-1/callback');
    // type 9 = MODAL response
    expect(capturedBody.type).toBe(9);
    expect(capturedBody.data.title).toBeTruthy();
    expect(capturedBody.data.custom_id).toMatch(/^pkey:/);
    // Modal contains a single SHORT TextInput (style: 1)
    const inner = capturedBody.data.components[0].components[0];
    expect(inner.type).toBe(4);
    expect(inner.style).toBe(1);
    expect(inner.required).toBe(true);
  });

  it('returns false for unknown slash commands', async () => {
    const interaction = { id: 'x', token: 'y', data: { name: 'unrelated' } };
    expect(await handleApplicationCommand(interaction)).toBe(false);
  });
});

describe('handleModalSubmit', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    delete process.env.STUDENT_ASSISTANT_ENV_PATH;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.STUDENT_ASSISTANT_ENV_PATH;
  });

  it('posts the value to ChatCSE with the agent token, then ephemeral acks', async () => {
    process.env.STUDENT_ASSISTANT_ENV_PATH = makeFakeEnv(
      `CHATCSE_AGENT_TOKEN=fake-token\nCHATCSE_BASE_URL=http://localhost:8000\n`,
    );
    const calls: Array<{ url: string; body: string | null; method: string }> = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      calls.push({
        url: url.toString(),
        body: (init?.body as string) || null,
        method: init?.method || 'GET',
      });
      // Defer + ChatCSE both succeed; PATCH (ephemeral edit) too.
      return new Response('{"provider":"edstem"}', {
        status: url.toString().includes('/api/agent/') ? 201 : 204,
      });
    }) as any;

    const interaction = {
      id: 'iid-2',
      token: 'itok-2',
      data: {
        custom_id: 'pkey:edstem',
        components: [
          {
            type: 1,
            components: [{ type: 4, custom_id: 'value', value: SECRET }],
          },
        ],
      },
    };
    const handled = await handleModalSubmit(interaction, 'app-123');
    expect(handled).toBe(true);

    // First call: defer ephemeral
    expect(calls[0].url).toContain('/interactions/iid-2/itok-2/callback');
    const deferBody = JSON.parse(calls[0].body!);
    expect(deferBody.type).toBe(5);
    expect(deferBody.data.flags).toBe(64);

    // Second call: POST to ChatCSE
    const chatcseCall = calls.find((c) => c.url.includes('/api/agent/credentials/'));
    expect(chatcseCall).toBeTruthy();
    expect(chatcseCall!.url).toBe('http://localhost:8000/api/agent/credentials/edstem');
    expect(JSON.parse(chatcseCall!.body!).value).toBe(SECRET);

    // Third call: edit the deferred reply (ephemeral)
    const editCall = calls.find(
      (c) => c.method === 'PATCH' && c.url.includes('/webhooks/app-123/itok-2/messages/@original'),
    );
    expect(editCall).toBeTruthy();
    const editBody = JSON.parse(editCall!.body!);
    expect(editBody.flags).toBe(64);
    expect(editBody.content).not.toContain(SECRET);
    expect(editBody.content.toLowerCase()).toContain('edstem');
  });

  it('refuses cleanly when CHATCSE_AGENT_TOKEN is missing — never echoes the value', async () => {
    process.env.STUDENT_ASSISTANT_ENV_PATH = makeFakeEnv(`CHATCSE_BASE_URL=http://localhost:8000\n`);
    const calls: any[] = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      calls.push({ url: url.toString(), body: init?.body, method: init?.method });
      return new Response(null, { status: 204 });
    }) as any;

    const interaction = {
      id: 'iid-3',
      token: 'itok-3',
      data: {
        custom_id: 'pkey:canvas',
        components: [{ type: 1, components: [{ type: 4, custom_id: 'value', value: SECRET }] }],
      },
    };
    const handled = await handleModalSubmit(interaction, 'app-123');
    expect(handled).toBe(true);
    // ChatCSE was NOT called; the only Discord calls are defer + ephemeral edit
    expect(calls.find((c) => c.url.includes('/api/agent/'))).toBeUndefined();
    const editCall = calls.find((c) => c.method === 'PATCH');
    expect(editCall).toBeTruthy();
    expect(editCall!.body).not.toContain(SECRET);
    expect(editCall!.body).toMatch(/CHATCSE_AGENT_TOKEN/);
  });

  it('returns false for non-pkey modals (lets caller fall through)', async () => {
    const interaction = { id: 'x', token: 'y', data: { custom_id: 'something-else' } };
    expect(await handleModalSubmit(interaction, 'app')).toBe(false);
  });

  it('surfaces ChatCSE 4xx without echoing the secret', async () => {
    process.env.STUDENT_ASSISTANT_ENV_PATH = makeFakeEnv(
      `CHATCSE_AGENT_TOKEN=fake\nCHATCSE_BASE_URL=http://localhost:8000\n`,
    );
    const calls: any[] = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      calls.push({ url: url.toString(), body: init?.body, method: init?.method });
      if (url.toString().includes('/api/agent/')) {
        return new Response('bad request', { status: 400 });
      }
      return new Response(null, { status: 204 });
    }) as any;

    const interaction = {
      id: 'iid-4',
      token: 'itok-4',
      data: {
        custom_id: 'pkey:gradescope',
        components: [
          {
            type: 1,
            components: [{ type: 4, custom_id: 'value', value: SECRET }],
          },
        ],
      },
    };
    await handleModalSubmit(interaction, 'app-123');
    const editCall = calls.find((c) => c.method === 'PATCH');
    expect(editCall).toBeTruthy();
    expect(editCall!.body).not.toContain(SECRET);
    expect(editCall!.body).toContain('400');
  });
});

describe('handleConnectCommand', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    delete process.env.STUDENT_ASSISTANT_ENV_PATH;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.STUDENT_ASSISTANT_ENV_PATH;
  });

  function buildInteraction(toolkit: string) {
    return {
      id: 'iid-c',
      token: 'itok-c',
      data: {
        name: 'connect',
        options: [{ name: 'app', value: toolkit }],
      },
    };
  }

  it('rejects unknown toolkit choices ephemerally', async () => {
    const calls: any[] = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      calls.push({ url: url.toString(), body: init?.body });
      return new Response(null, { status: 204 });
    }) as any;
    const handled = await handleConnectCommand(buildInteraction('not-a-real-toolkit'), 'app-123');
    expect(handled).toBe(true);
    // Single ephemeral immediate response, no defer
    expect(calls.length).toBe(1);
    const body = JSON.parse(calls[0].body);
    expect(body.data.flags).toBe(64); // ephemeral
    expect(body.data.content).toMatch(/unknown app/i);
  });

  it('happy path: fetches auth_configs, posts /link, edits initial reply with URL', async () => {
    process.env.STUDENT_ASSISTANT_ENV_PATH = makeFakeEnv(`COMPOSIO_API_KEY=ak_live_test\nCOMPOSIO_USER_ID=8\n`);
    const calls: Array<{ url: string; body: string | null; method: string }> = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      const u = url.toString();
      calls.push({
        url: u,
        body: (init?.body as string) || null,
        method: init?.method || 'GET',
      });
      // Defer ephemeral
      if (u.includes('/interactions/iid-c/itok-c/callback')) {
        return new Response(null, { status: 204 });
      }
      // No existing connection
      if (u.includes('/connected_accounts?')) {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }
      // auth_configs lookup
      if (u.includes('/auth_configs')) {
        return new Response(
          JSON.stringify({
            items: [{ id: 'ac_test_gmail', toolkit: { slug: 'gmail' } }],
          }),
          { status: 200 },
        );
      }
      // /link
      if (u.includes('/connected_accounts/link')) {
        return new Response(
          JSON.stringify({
            redirect_url: 'https://connect.composio.dev/link/lk_xyz',
          }),
          { status: 201 },
        );
      }
      // PATCH @original
      return new Response(null, { status: 204 });
    }) as any;

    const handled = await handleConnectCommand(buildInteraction('gmail'), 'app-123');
    expect(handled).toBe(true);

    // Verify the PATCH includes the URL + "click within 30 minutes"
    const editCall = calls.find(
      (c) => c.method === 'PATCH' && c.url.includes('/webhooks/app-123/itok-c/messages/@original'),
    );
    expect(editCall).toBeTruthy();
    const editBody = JSON.parse(editCall!.body!);
    expect(editBody.flags).toBe(64); // ephemeral
    expect(editBody.content).toContain('https://connect.composio.dev/link/lk_xyz');
    expect(editBody.content.toLowerCase()).toContain('click within 30');
    expect(editBody.content).toContain('gmail');
  });

  it('short-circuits when an ACTIVE connection already exists', async () => {
    process.env.STUDENT_ASSISTANT_ENV_PATH = makeFakeEnv(`COMPOSIO_API_KEY=ak_live_test\nCOMPOSIO_USER_ID=8\n`);
    const calls: any[] = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      const u = url.toString();
      calls.push({ url: u, body: init?.body, method: init?.method });
      if (u.includes('/connected_accounts?')) {
        return new Response(JSON.stringify({ items: [{ id: 'ca_existing', status: 'ACTIVE' }] }), { status: 200 });
      }
      return new Response(null, { status: 204 });
    }) as any;

    const handled = await handleConnectCommand(buildInteraction('googlecalendar'), 'app-123');
    expect(handled).toBe(true);

    // Should NOT have posted to /link
    expect(calls.find((c) => c.url.includes('/connected_accounts/link'))).toBeUndefined();
    // Should have edited initial with "already connected"
    const editCall = calls.find((c) => c.method === 'PATCH');
    expect(editCall).toBeTruthy();
    expect(editCall!.body.toLowerCase()).toContain('already connected');
  });

  it('refuses cleanly when COMPOSIO_API_KEY is missing', async () => {
    process.env.STUDENT_ASSISTANT_ENV_PATH = makeFakeEnv(`COMPOSIO_USER_ID=8\n`);
    const calls: any[] = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      calls.push({ url: url.toString(), body: init?.body, method: init?.method });
      return new Response(null, { status: 204 });
    }) as any;

    const handled = await handleConnectCommand(buildInteraction('gmail'), 'app-123');
    expect(handled).toBe(true);
    // Did not call Composio at all
    expect(calls.find((c) => c.url.includes('backend.composio.dev'))).toBeUndefined();
    // Edit message mentions the missing key
    const editCall = calls.find((c) => c.method === 'PATCH');
    expect(editCall).toBeTruthy();
    expect(editCall!.body).toContain('COMPOSIO_API_KEY');
  });
});

describe('handleApplicationCommand dispatch', () => {
  it('routes /connect to handleConnectCommand', async () => {
    // Reach via the public dispatcher; if /connect is unknown to it the
    // call returns false (falls through). We just need the routing to
    // work — we don't replay full happy path here (covered above).
    process.env.STUDENT_ASSISTANT_ENV_PATH = '/nonexistent';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 204 })) as any;
    try {
      const handled = await handleApplicationCommand(
        {
          id: 'x',
          token: 'y',
          data: { name: 'connect', options: [{ name: 'app', value: 'gmail' }] },
        },
        'app-id',
      );
      // The handler will fail to read the env file and return true after
      // ephemeral-erroring — that's the contract: handled=true means we
      // acknowledged Discord's interaction one way or another.
      expect(handled).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
