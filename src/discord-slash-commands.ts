/**
 * Discord application commands (slash commands) + modals for capturing
 * per-provider secrets WITHOUT the value ever being a public chat message.
 *
 * Why this exists:
 *   The legacy `/edstem-key sk_xxx` flow lives in `provider-key-handler.ts`
 *   and requires the user to type their secret as a regular Discord message.
 *   Bots cannot delete user messages in DMs (Discord platform limitation —
 *   `MANAGE_MESSAGES` is guild-only). So the secret persists in chat history
 *   no matter what the bot does after.
 *
 *   Discord modals (interaction type 9) solve this cleanly: the user types
 *   `/edstem-key` (no parameter), Discord opens a private modal prompting
 *   for the value, the value is delivered to us via an interaction payload,
 *   and Discord NEVER renders it as a message. There is nothing to delete.
 *
 * Wiring:
 *   - `registerSlashCommands(appId, botToken)` — call once at daemon
 *     startup. PUTs the command list to Discord (idempotent).
 *   - `handleApplicationCommand(interaction, botToken)` — invoked from
 *     chat-sdk-bridge's GATEWAY_INTERACTION_CREATE handler when
 *     interaction.type === 2. Responds with an ephemeral modal.
 *   - `handleModalSubmit(interaction, botToken)` — invoked when
 *     interaction.type === 5 AND custom_id matches our naming. Stores
 *     the value via ChatCSE's agent_token-authed credentials endpoint;
 *     responds ephemerally.
 *
 * Hard requirements (preserved from M4):
 *   - The plaintext value MUST NOT appear in any log line.
 *   - The plaintext value MUST NOT be written to any session messages_in.
 *   - On HTTP failure the user gets actionable text WITHOUT the value
 *     echoed back.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { log } from './log.js';

const DISCORD_API = 'https://discord.com/api/v10';

/**
 * Slug of the provider this slash command targets. Aligned with the
 * server-side `ALLOWED_PROVIDERS` set in ChatCSE's `provider_credentials.py`.
 */
type Provider = 'edstem' | 'canvas' | 'gradescope';
const PROVIDERS: Provider[] = ['edstem', 'canvas', 'gradescope'];

const COMMAND_NAME: Record<Provider, string> = {
  edstem: 'edstem-key',
  canvas: 'canvas-key',
  gradescope: 'gradescope-key',
};

const COMMAND_DESCRIPTION: Record<Provider, string> = {
  edstem: 'Save your Edstem API token (entered in a private prompt)',
  canvas: 'Save your Canvas API token (entered in a private prompt)',
  gradescope:
    'Save your Gradescope local password (entered in a private prompt) — see /docs for the SSO setup',
};

const MODAL_LABEL: Record<Provider, string> = {
  edstem: 'Edstem API token',
  canvas: 'Canvas API token',
  gradescope: 'Gradescope email:password',
};

const MODAL_PLACEHOLDER: Record<Provider, string> = {
  edstem: 'paste the token from edstem.org/us/settings/api-tokens',
  canvas: 'paste the token from Canvas → Account → Settings',
  gradescope: 'youremail@school.edu:your-gradescope-local-password',
};

const MODAL_CUSTOM_ID_PREFIX = 'pkey:';
const MODAL_FIELD_ID = 'value';

// ---------------------------------------------------------------------------
// /connect — Composio OAuth link generator (the "click within 30 min" pattern)
//
// The bot already auto-surfaces an OAuth link when the agent calls a Composio
// tool that hits "no connected account". But Composio's link tokens expire
// in ~30 min, and students often see the URL, get distracted, and come back
// past expiry. `/connect <app>` gives them a one-step, on-demand way to ask
// for a fresh link without going through a tool failure first — and the
// reply tells them prominently to click NOW.
// ---------------------------------------------------------------------------

const CONNECT_COMMAND_NAME = 'connect';

// Composio toolkit slugs we expose. Aligned with the auth_configs created
// in the M3 Composio bootstrap (see backend/docs/auth.md). Each entry's
// `value` is the Composio toolkit slug (used in API calls); `name` is what
// Discord shows in the slash command UI.
const TOOLKIT_CHOICES: Array<{ name: string; value: string }> = [
  { name: 'Gmail', value: 'gmail' },
  { name: 'Google Calendar', value: 'googlecalendar' },
  { name: 'Google Drive', value: 'googledrive' },
  { name: 'Google Docs', value: 'googledocs' },
  { name: 'Google Sheets', value: 'googlesheets' },
  { name: 'Google Slides', value: 'googleslides' },
  { name: 'Notion', value: 'notion' },
  { name: 'Todoist', value: 'todoist' },
];
const TOOLKIT_SLUGS = new Set(TOOLKIT_CHOICES.map((c) => c.value));

// Cache: toolkit_slug → auth_config_id (lazily fetched from Composio).
let _authConfigCache: Map<string, string> | null = null;

// Discord interaction-response types we use.
const RESP_MODAL = 9;
const RESP_DEFERRED_EPHEMERAL = 5; // CHANNEL_MESSAGE_WITH_SOURCE deferred
const FLAG_EPHEMERAL = 64;

// ---------------------------------------------------------------------------
// Slash command registration
// ---------------------------------------------------------------------------

/**
 * Idempotently register the per-provider slash commands at the application
 * level. Discord upserts on (application_id, name); calling this on every
 * daemon start is fine.
 *
 * Returns the number of commands successfully registered. 0 on failure;
 * the caller logs but does not crash — the legacy message-based handler
 * is the fallback.
 */
export async function registerSlashCommands(
  appId: string,
  botToken: string,
): Promise<number> {
  if (!appId || !botToken) {
    log.warn('Slash command registration skipped — appId or botToken missing');
    return 0;
  }
  const commands: Array<Record<string, unknown>> = PROVIDERS.map((p) => ({
    name: COMMAND_NAME[p],
    description: COMMAND_DESCRIPTION[p],
    type: 1, // CHAT_INPUT
    contexts: [0, 1, 2], // GUILD, BOT_DM, PRIVATE_CHANNEL — work everywhere
    integration_types: [0, 1], // GUILD_INSTALL, USER_INSTALL
    // No `options` — we want the modal to capture the secret, not the
    // initial slash invocation. If we put the value as a string option,
    // Discord renders it in the chat history.
  }));
  // /connect — Composio OAuth on demand. Options are NOT secrets here
  // (just a toolkit name from a fixed choice list), so they're safe to
  // render in chat history.
  commands.push({
    name: CONNECT_COMMAND_NAME,
    description:
      'Connect a third-party app via OAuth (Gmail, Calendar, Drive, etc.)',
    type: 1,
    contexts: [0, 1, 2],
    integration_types: [0, 1],
    options: [
      {
        type: 3, // STRING
        name: 'app',
        description: 'Which app to connect',
        required: true,
        choices: TOOLKIT_CHOICES,
      },
    ],
  });
  try {
    const r = await fetch(
      `${DISCORD_API}/applications/${appId}/commands`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bot ${botToken}`,
        },
        body: JSON.stringify(commands),
      },
    );
    if (!r.ok) {
      log.warn('Slash command registration failed', {
        status: r.status,
        body: (await r.text()).slice(0, 240),
      });
      return 0;
    }
    log.info('Slash commands registered with Discord', {
      count: commands.length,
      names: commands.map((c) => c.name),
    });
    return commands.length;
  } catch (err) {
    log.warn('Slash command registration threw', { err: (err as Error).message });
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Slash command handler — type 2 → respond with modal
// ---------------------------------------------------------------------------

/**
 * Returns true if `interaction.data.name` matches one of our slash commands
 * AND we sent SOMETHING back to Discord. Returns false on misroute so the
 * caller can fall through to other handlers.
 *
 * Routes:
 *   /<provider>-key      → opens a modal for the secret value
 *   /connect <app>       → generates a Composio OAuth link and ephemerally
 *                          posts it back with a "click within 30 min" hint
 */
export async function handleApplicationCommand(
  interaction: Record<string, unknown>,
  appId?: string,
): Promise<boolean> {
  const data = (interaction.data as Record<string, unknown> | undefined) ?? {};
  const name = data.name as string | undefined;
  if (!name) return false;

  if (name === CONNECT_COMMAND_NAME) {
    return handleConnectCommand(interaction, appId ?? '');
  }

  const provider = PROVIDERS.find((p) => COMMAND_NAME[p] === name);
  if (!provider) return false;

  const interactionId = interaction.id as string;
  const interactionToken = interaction.token as string;

  log.info('Received provider-key slash command', { provider });

  // Modal payload — single short TextInput, ephemeral by design (Discord
  // renders modals to the invoking user only).
  const payload = {
    type: RESP_MODAL,
    data: {
      custom_id: `${MODAL_CUSTOM_ID_PREFIX}${provider}`,
      title: MODAL_LABEL[provider],
      components: [
        {
          type: 1, // ActionRow
          components: [
            {
              type: 4, // TextInput
              custom_id: MODAL_FIELD_ID,
              style: 1, // SHORT (single-line)
              label: MODAL_LABEL[provider],
              placeholder: MODAL_PLACEHOLDER[provider],
              required: true,
              min_length: 6,
              max_length: 4000,
            },
          ],
        },
      ],
    },
  };

  try {
    const r = await fetch(
      `${DISCORD_API}/interactions/${interactionId}/${interactionToken}/callback`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
    );
    if (!r.ok) {
      log.warn('Modal callback failed', {
        provider,
        status: r.status,
        body: (await r.text()).slice(0, 240),
      });
      return false;
    }
    return true;
  } catch (err) {
    log.warn('Modal callback threw', { provider, err: (err as Error).message });
    return false;
  }
}

// ---------------------------------------------------------------------------
// /connect handler — generates a Composio OAuth link on demand
// ---------------------------------------------------------------------------

/**
 * Handles `/connect <app>` interactions. Always returns true once it has
 * acknowledged the interaction (success or graceful error) — the caller
 * should not fall through.
 */
export async function handleConnectCommand(
  interaction: Record<string, unknown>,
  appId: string,
): Promise<boolean> {
  const data = (interaction.data as Record<string, unknown> | undefined) ?? {};
  const opts = (data.options as Array<Record<string, unknown>> | undefined) ?? [];
  const appOpt = opts.find((o) => o.name === 'app');
  const toolkit = (appOpt?.value as string | undefined) ?? '';
  const interactionId = interaction.id as string;
  const interactionToken = interaction.token as string;

  if (!toolkit || !TOOLKIT_SLUGS.has(toolkit)) {
    await respondEphemeral(
      interactionId,
      interactionToken,
      `Unknown app ${toolkit ? toolkit : '(none)'} — pick one from the dropdown.`,
    );
    return true;
  }

  log.info('Received /connect command', { toolkit });

  // Defer (5s budget) so we have time for two Composio API calls.
  await deferEphemeral(interactionId, interactionToken);

  let composio: { apiKey: string; userId: string };
  try {
    composio = readComposioEnv();
  } catch (err) {
    await editInitial(
      appId,
      interactionToken,
      `Couldn't issue a connect link — the container is missing COMPOSIO_API_KEY or COMPOSIO_USER_ID. Ask staff to re-provision. (${(err as Error).message})`,
    );
    return true;
  }

  // Already connected? Skip the link and tell the user.
  try {
    const existing = await fetch(
      `https://backend.composio.dev/api/v3/connected_accounts?user_ids=${encodeURIComponent(composio.userId)}&toolkit_slugs=${encodeURIComponent(toolkit)}&statuses=ACTIVE`,
      { headers: { 'x-api-key': composio.apiKey } },
    );
    if (existing.ok) {
      const j = (await existing.json()) as { items?: unknown[] };
      if ((j.items?.length ?? 0) > 0) {
        await editInitial(
          appId,
          interactionToken,
          `✅ You're already connected to **${toolkit}**. Just ask me anything that needs it (e.g. "what's on my calendar" for Calendar).`,
        );
        return true;
      }
    }
  } catch {
    // Non-fatal — fall through and try to issue a link anyway.
  }

  // Resolve auth_config_id (cached after first lookup).
  const authConfigId = await resolveAuthConfigId(toolkit, composio.apiKey);
  if (!authConfigId) {
    await editInitial(
      appId,
      interactionToken,
      `No Composio auth_config found for **${toolkit}**. Ask staff to create one in the Composio dashboard.`,
    );
    return true;
  }

  // Issue a fresh link.
  try {
    const r = await fetch(
      'https://backend.composio.dev/api/v3/connected_accounts/link',
      {
        method: 'POST',
        headers: {
          'x-api-key': composio.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          auth_config_id: authConfigId,
          user_id: composio.userId,
        }),
      },
    );
    if (!r.ok) {
      const detail = (await r.text()).slice(0, 240);
      await editInitial(
        appId,
        interactionToken,
        `Composio rejected the link request (HTTP ${r.status}): ${detail}`,
      );
      return true;
    }
    const j = (await r.json()) as { redirect_url?: string };
    const url = j.redirect_url ?? '';
    if (!url) {
      await editInitial(
        appId,
        interactionToken,
        `Composio returned no redirect_url. Try again or contact staff.`,
      );
      return true;
    }
    await editInitial(
      appId,
      interactionToken,
      [
        `👉 **Click within 30 minutes** to connect **${toolkit}**:`,
        '',
        url,
        '',
        `Once you sign in and approve, just ask me again — e.g. "what's on my calendar today" for Calendar.`,
      ].join('\n'),
    );
    return true;
  } catch (err) {
    await editInitial(
      appId,
      interactionToken,
      `Couldn't reach Composio (${(err as Error).message}). Try again in a moment.`,
    );
    return true;
  }
}

// ---------------------------------------------------------------------------
// Modal submit handler — type 5 → POST to ChatCSE, ephemeral ack
// ---------------------------------------------------------------------------

/**
 * Returns true if `interaction.data.custom_id` matches our naming and the
 * value was forwarded to ChatCSE (success or graceful failure). Returns
 * false if the modal isn't ours so the caller can ignore.
 */
export async function handleModalSubmit(
  interaction: Record<string, unknown>,
  appId: string,
): Promise<boolean> {
  const data = (interaction.data as Record<string, unknown> | undefined) ?? {};
  const customId = data.custom_id as string | undefined;
  if (!customId?.startsWith(MODAL_CUSTOM_ID_PREFIX)) return false;
  const provider = customId.slice(MODAL_CUSTOM_ID_PREFIX.length) as Provider;
  if (!PROVIDERS.includes(provider)) return false;

  const interactionId = interaction.id as string;
  const interactionToken = interaction.token as string;

  log.info('Received provider-key modal submit', { provider });

  const value = extractModalValue(data);
  if (!value) {
    await respondEphemeral(
      interactionId,
      interactionToken,
      `No value submitted for ${provider}.`,
    );
    return true;
  }

  // Defer (5s budget) so we can do the POST and reply ephemerally.
  await deferEphemeral(interactionId, interactionToken);

  let chatcseEnv: { token: string; baseUrl: string };
  try {
    chatcseEnv = readChatCSEEnv();
  } catch (err) {
    log.warn('Modal submit: env read failed', {
      provider,
      err: (err as Error).message,
    });
    await editInitial(
      appId,
      interactionToken,
      `Couldn't store your ${provider} key — the container is missing CHATCSE_AGENT_TOKEN. Ask staff to re-provision.`,
    );
    return true;
  }

  try {
    const r = await fetch(
      `${chatcseEnv.baseUrl.replace(/\/$/, '')}/api/agent/credentials/${provider}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${chatcseEnv.token}`,
        },
        body: JSON.stringify({ value }),
      },
    );
    if (!r.ok) {
      const detail = (await r.text()).slice(0, 240);
      log.warn('Modal submit: ChatCSE rejected', { provider, status: r.status });
      await editInitial(
        appId,
        interactionToken,
        `ChatCSE rejected the ${provider} key (HTTP ${r.status}): ${detail}`,
      );
      return true;
    }
    await editInitial(
      appId,
      interactionToken,
      `✅ Your ${provider} key is saved (encrypted at rest in ChatCSE). It will be used the next time the ${provider} MCP server is invoked. Nothing was posted to chat history.`,
    );
    return true;
  } catch (err) {
    log.warn('Modal submit: ChatCSE call failed', {
      provider,
      err: (err as Error).message,
    });
    await editInitial(
      appId,
      interactionToken,
      `Couldn't reach ChatCSE to save your ${provider} key (${(err as Error).message}). Try again in a moment.`,
    );
    return true;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the user-supplied text from a Discord modal-submit payload.
 * Modal submits arrive as: `data.components[0].components[0].value` per
 * Discord's interactions docs. Defensive against missing fields.
 */
export function extractModalValue(
  data: Record<string, unknown>,
): string | null {
  const rows = data.components as Array<Record<string, unknown>> | undefined;
  if (!rows || rows.length === 0) return null;
  for (const row of rows) {
    const inner = row.components as Array<Record<string, unknown>> | undefined;
    if (!inner) continue;
    for (const comp of inner) {
      if (comp.custom_id === MODAL_FIELD_ID && typeof comp.value === 'string') {
        return comp.value as string;
      }
    }
  }
  return null;
}

async function deferEphemeral(
  interactionId: string,
  interactionToken: string,
): Promise<void> {
  try {
    await fetch(
      `${DISCORD_API}/interactions/${interactionId}/${interactionToken}/callback`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: RESP_DEFERRED_EPHEMERAL,
          data: { flags: FLAG_EPHEMERAL },
        }),
      },
    );
  } catch (err) {
    log.warn('Failed to defer interaction', { err: (err as Error).message });
  }
}

async function editInitial(
  appId: string,
  interactionToken: string,
  content: string,
): Promise<void> {
  try {
    await fetch(
      `${DISCORD_API}/webhooks/${appId}/${interactionToken}/messages/@original`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, flags: FLAG_EPHEMERAL }),
      },
    );
  } catch (err) {
    log.warn('Failed to edit interaction reply', {
      err: (err as Error).message,
    });
  }
}

async function respondEphemeral(
  interactionId: string,
  interactionToken: string,
  content: string,
): Promise<void> {
  try {
    await fetch(
      `${DISCORD_API}/interactions/${interactionId}/${interactionToken}/callback`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 4,
          data: { content, flags: FLAG_EPHEMERAL },
        }),
      },
    );
  } catch (err) {
    log.warn('Failed to send ephemeral response', {
      err: (err as Error).message,
    });
  }
}

/**
 * Reads `~/student-assistant/.env` for Composio credentials. Same source
 * of truth as the in-container composio-bridge.
 */
function readComposioEnv(): { apiKey: string; userId: string } {
  const env = readEnvFile();
  const apiKey = env.COMPOSIO_API_KEY;
  const userId = env.COMPOSIO_USER_ID;
  if (!apiKey) throw new Error('COMPOSIO_API_KEY missing');
  if (!userId) throw new Error('COMPOSIO_USER_ID missing');
  return { apiKey, userId };
}

/**
 * Map a Composio toolkit slug → its auth_config_id, fetching from
 * Composio's REST API on first miss and caching for the process lifetime.
 *
 * Returns null if the toolkit has no Composio-managed auth_config in this
 * project (e.g. `googleforms` — Composio doesn't manage credentials for it).
 */
async function resolveAuthConfigId(
  toolkit: string,
  apiKey: string,
): Promise<string | null> {
  if (!_authConfigCache) {
    _authConfigCache = new Map();
    try {
      const r = await fetch(
        'https://backend.composio.dev/api/v3/auth_configs?limit=200',
        { headers: { 'x-api-key': apiKey } },
      );
      if (r.ok) {
        const j = (await r.json()) as { items?: Array<Record<string, unknown>> };
        for (const item of j.items ?? []) {
          const slug = (item.toolkit as Record<string, unknown> | undefined)?.slug as
            | string
            | undefined;
          const id = item.id as string | undefined;
          if (slug && id) _authConfigCache.set(slug, id);
        }
      } else {
        log.warn('Composio auth_configs lookup failed', { status: r.status });
      }
    } catch (err) {
      log.warn('Composio auth_configs lookup threw', {
        err: (err as Error).message,
      });
    }
  }
  return _authConfigCache.get(toolkit) ?? null;
}

/**
 * Reads `~/student-assistant/.env` (or whatever
 * `STUDENT_ASSISTANT_ENV_PATH` points at, useful for tests) into a flat
 * key→value map. Both `readChatCSEEnv` and `readComposioEnv` go through
 * this so the modal/connect flows stay aligned with the in-container
 * bridges that read the same file.
 */
function readEnvFile(): Record<string, string> {
  const envPath =
    process.env.STUDENT_ASSISTANT_ENV_PATH ||
    path.join(os.homedir(), 'student-assistant', '.env');
  let raw: string;
  try {
    raw = fs.readFileSync(envPath, 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${envPath}: ${(err as Error).message}`);
  }
  const map: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i <= 0 || line.startsWith('#')) continue;
    const k = line.slice(0, i).trim();
    const v = line
      .slice(i + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    map[k] = v;
  }
  return map;
}

function readChatCSEEnv(): { token: string; baseUrl: string } {
  const env = readEnvFile();
  const token = env.CHATCSE_AGENT_TOKEN;
  const baseUrl =
    env.CHATCSE_BASE_URL ||
    env.VIRTUAL_TA_URL?.replace(/:8001$/, ':8000') ||
    'http://host.docker.internal:8000';
  if (!token) throw new Error('CHATCSE_AGENT_TOKEN missing');
  return { token, baseUrl };
}
