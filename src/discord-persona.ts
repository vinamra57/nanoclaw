/**
 * Discord webhook impersonation for per-student personas.
 *
 * In multi-tenant deployments where one shared Discord bot fronts many
 * student agents, replies in **guild channels** can be sent through a
 * channel webhook with the agent_group's display name + avatar so the
 * message shows up as "Vinamra's agent" / "Alice's agent" instead of
 * the bot's own identity.
 *
 * Limitations:
 *   * DMs: Discord does NOT support webhooks in DM channels. Outbound
 *     to `@me:<user_id>` falls through to the regular bot identity —
 *     there is no platform-level workaround.
 *   * Files: webhook execute supports attachments via multipart form
 *     uploads; this module supports both text-only (JSON) and
 *     multipart paths.
 *   * Permissions: the bot needs the **Manage Webhooks** scope on the
 *     guild. Without it, webhook creation 403s and we silently fall
 *     back to the regular bot send.
 *
 * Webhook lifecycle:
 *   * One webhook per channel, named `NANOCLAW_WEBHOOK_NAME` (default
 *     "NanoClaw Persona"). On first send we list existing webhooks on
 *     the channel; if ours exists we reuse it (cached in-memory),
 *     otherwise we create one. Webhooks have unlimited TTL.
 *   * The cache is per-process — a daemon restart re-discovers
 *     webhooks on the next send. That's a single Discord API call per
 *     channel, amortized fine.
 */
import { log } from './log.js';

const DISCORD_API = 'https://discord.com/api/v10';
const WEBHOOK_NAME = process.env.NANOCLAW_WEBHOOK_NAME || 'NanoClaw Persona';

interface WebhookCred {
  id: string;
  token: string;
}

const webhookCache = new Map<string, WebhookCred>();
// Negative cache — channels we've confirmed we can't get a webhook for
// (no perms, etc.). 5-minute entries so a perms grant takes effect
// quickly.
const negativeCache = new Map<string, number>();
const NEGATIVE_TTL_MS = 5 * 60 * 1000;

function isNegativelyCached(channelId: string): boolean {
  const t = negativeCache.get(channelId);
  if (!t) return false;
  if (Date.now() - t > NEGATIVE_TTL_MS) {
    negativeCache.delete(channelId);
    return false;
  }
  return true;
}

function markNegative(channelId: string): void {
  negativeCache.set(channelId, Date.now());
}

interface DiscordWebhook {
  id: string;
  token?: string;
  name?: string;
  channel_id?: string;
}

async function discordApi<T>(
  path: string,
  init: { method: string; body?: unknown },
  botToken: string,
): Promise<T | null> {
  const headers: Record<string, string> = {
    Authorization: `Bot ${botToken}`,
    'User-Agent': 'NanoClaw (https://github.com/qwibitai/nanoclaw, 1.0)',
  };
  let body: string | undefined;
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.body);
  }
  let resp: Response;
  try {
    resp = await fetch(`${DISCORD_API}${path}`, {
      method: init.method,
      headers,
      body,
    });
  } catch (err) {
    log.warn('discord-persona: network error', { path, err });
    return null;
  }
  if (resp.status === 204) return null;
  if (!resp.ok) {
    const txt = (await resp.text().catch(() => '')).slice(0, 200);
    log.warn('discord-persona: discord api returned non-2xx', {
      path,
      status: resp.status,
      body: txt,
    });
    return null;
  }
  try {
    return (await resp.json()) as T;
  } catch {
    return null;
  }
}

async function findOrCreateWebhook(channelId: string, botToken: string): Promise<WebhookCred | null> {
  const cached = webhookCache.get(channelId);
  if (cached) return cached;
  if (isNegativelyCached(channelId)) return null;

  // Look for an existing one we own.
  const existing = await discordApi<DiscordWebhook[]>(`/channels/${channelId}/webhooks`, { method: 'GET' }, botToken);
  if (Array.isArray(existing)) {
    for (const wh of existing) {
      if (wh.name === WEBHOOK_NAME && wh.token) {
        const cred = { id: wh.id, token: wh.token };
        webhookCache.set(channelId, cred);
        return cred;
      }
    }
  } else {
    // GET failed (likely 403 — bot lacks Manage Webhooks). Don't keep
    // hitting the API on every message; cache the failure.
    markNegative(channelId);
    return null;
  }

  // Create a fresh one.
  const created = await discordApi<DiscordWebhook>(
    `/channels/${channelId}/webhooks`,
    { method: 'POST', body: { name: WEBHOOK_NAME } },
    botToken,
  );
  if (created?.id && created?.token) {
    const cred = { id: created.id, token: created.token };
    webhookCache.set(channelId, cred);
    return cred;
  }
  markNegative(channelId);
  return null;
}

export interface PersonaSendInput {
  channelId: string;
  threadId: string | null;
  text: string;
  username: string;
  avatarUrl?: string;
  files?: Array<{ name: string; data: Buffer; contentType?: string }>;
}

/** Send a message through a channel webhook. Returns the platform message
 *  id on success, or null if the webhook path was unavailable (caller
 *  should fall back to the regular bot send). */
export async function deliverViaWebhook(input: PersonaSendInput): Promise<string | null> {
  const botToken = (process.env.DISCORD_BOT_TOKEN || '').trim();
  if (!botToken) return null;

  const cred = await findOrCreateWebhook(input.channelId, botToken);
  if (!cred) return null;

  const params = new URLSearchParams({ wait: 'true' });
  if (input.threadId) params.set('thread_id', input.threadId);
  const execUrl = `${DISCORD_API}/webhooks/${cred.id}/${cred.token}?${params.toString()}`;

  let resp: Response;
  try {
    if (input.files && input.files.length > 0) {
      // Multipart upload — Discord requires `payload_json` + `files[N]`.
      const form = new FormData();
      const payload: Record<string, unknown> = {
        content: input.text || ' ', // empty content not allowed alongside files unless we send a placeholder
        username: input.username,
        attachments: input.files.map((f, i) => ({ id: i, filename: f.name })),
      };
      if (input.avatarUrl) payload.avatar_url = input.avatarUrl;
      form.append('payload_json', JSON.stringify(payload));
      input.files.forEach((f, i) => {
        const blob = new Blob([new Uint8Array(f.data)], {
          type: f.contentType || 'application/octet-stream',
        });
        form.append(`files[${i}]`, blob, f.name);
      });
      resp = await fetch(execUrl, { method: 'POST', body: form });
    } else {
      const payload: Record<string, unknown> = {
        content: input.text,
        username: input.username,
      };
      if (input.avatarUrl) payload.avatar_url = input.avatarUrl;
      resp = await fetch(execUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    }
  } catch (err) {
    log.warn('discord-persona: webhook execute network error', {
      channelId: input.channelId,
      err,
    });
    return null;
  }

  if (resp.status === 404) {
    // Webhook was deleted server-side — invalidate cache + fail-soft so
    // caller falls back to the bot send (next message will try again
    // and re-create).
    webhookCache.delete(input.channelId);
    return null;
  }
  if (!resp.ok) {
    const txt = (await resp.text().catch(() => '')).slice(0, 200);
    log.warn('discord-persona: webhook execute non-2xx', {
      channelId: input.channelId,
      status: resp.status,
      body: txt,
    });
    return null;
  }
  try {
    const data = (await resp.json()) as { id?: string };
    return data.id ?? null;
  } catch {
    return null;
  }
}

// Test hook: callers can clear the cache (between tests). Production code
// has no reason to call this — the cache is correctness-safe (we just
// re-discover on the next send if a webhook was deleted out-of-band).
export function _resetCachesForTest(): void {
  webhookCache.clear();
  negativeCache.clear();
}
