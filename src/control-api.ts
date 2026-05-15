/**
 * Control API for external orchestrators (ChatCSE) to manage agent_groups
 * + Discord routing without holding a CLI session on the host.
 *
 * Endpoints:
 *
 *   POST /api/agent-groups
 *     body: {
 *       name: string,                              // human label
 *       folder?: string,                           // override folder name
 *       container_config?: object,                 // full container.json
 *       agent_provider?: string,                   // default null
 *     }
 *     response 200: {
 *       agent_group_id: string,
 *       folder: string,
 *       created: boolean
 *     }
 *
 *     Idempotent on `folder`: if a folder with that name already exists,
 *     returns its agent_group_id with `created: false`. This matches the
 *     contract callers want for retries.
 *
 *   POST /api/agent-groups/wirings
 *     body: {
 *       channel_type: "discord",
 *       platform_id: "@me:<discord_user_id>",
 *       agent_group_id: "ag-...",
 *       name?: string,           // human label for the messaging_group
 *       engage_mode?: "pattern" | "mention" | "mention-sticky",
 *       engage_pattern?: string, // default "." (match-all)
 *       session_mode?: "shared" | "per-thread" | "agent-shared",
 *       sender_scope?: "all" | "known",
 *       is_group?: boolean,
 *     }
 *     response 200: { messaging_group_id, messaging_group_agent_id, created: boolean }
 *
 * Auth: Bearer token in `Authorization` header. The expected token comes
 * from `NANOCLAW_CONTROL_TOKEN` env at server start. If the env var is
 * unset, every `/api/*` request returns 503 ("control plane disabled") —
 * fail-closed so a misconfigured deployment can't silently accept
 * anonymous mutations.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { createAgentGroup, getAgentGroup, getAgentGroupByFolder } from './db/agent-groups.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from './db/messaging-groups.js';
import { normalizeDiscordPlatformId } from './discord-platform-id.js';
import { readEnvFile } from './env.js';
import { initGroupFilesystem } from './group-init.js';
import { log } from './log.js';
import { scheduleWelcomeDM } from './welcome-dm.js';
import type {
  AgentGroup,
  EngageMode,
  IgnoredMessagePolicy,
  MessagingGroup,
  MessagingGroupAgent,
  SenderScope,
  UnknownSenderPolicy,
} from './types.js';

const ALLOWED_ENGAGE_MODES: ReadonlyArray<EngageMode> = ['pattern', 'mention', 'mention-sticky'];
const ALLOWED_SESSION_MODES: ReadonlyArray<MessagingGroupAgent['session_mode']> = [
  'shared',
  'per-thread',
  'agent-shared',
];
const ALLOWED_SENDER_SCOPES: ReadonlyArray<SenderScope> = ['all', 'known'];

function unauthorized(reason: string): Response {
  return new Response(JSON.stringify({ error: reason }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

function badRequest(reason: string): Response {
  return new Response(JSON.stringify({ error: reason }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  });
}

function ok(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Constant-time-ish bearer-token comparison. Node has no built-in for
// strings; we drop to byte buffers and use crypto.timingSafeEqual when
// lengths match. Mismatch on length is OK to short-circuit because the
// length itself isn't a meaningful secret here.
async function isAuthorized(req: Request, expected: string): Promise<boolean> {
  const auth = req.headers.get('authorization') || '';
  if (!auth.toLowerCase().startsWith('bearer ')) return false;
  const provided = auth.slice(7).trim();
  if (provided.length !== expected.length) return false;
  const { timingSafeEqual } = await import('crypto');
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

interface WiringBody {
  channel_type: unknown;
  platform_id: unknown;
  agent_group_id: unknown;
  name?: unknown;
  engage_mode?: unknown;
  engage_pattern?: unknown;
  session_mode?: unknown;
  sender_scope?: unknown;
  ignored_message_policy?: unknown;
  is_group?: unknown;
  unknown_sender_policy?: unknown;
}

function nowIso(): string {
  return new Date().toISOString();
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function handleAgentGroupWiring(req: Request): Promise<Response> {
  let body: WiringBody;
  try {
    body = (await req.json()) as WiringBody;
  } catch {
    return badRequest('invalid JSON body');
  }

  if (!isNonEmptyString(body.channel_type)) return badRequest('channel_type is required');
  if (!isNonEmptyString(body.platform_id)) return badRequest('platform_id is required');
  if (!isNonEmptyString(body.agent_group_id)) return badRequest('agent_group_id is required');

  const channelType = body.channel_type;
  // For Discord DMs callers pass `@me:<user_id>` (the only thing OAuth
  // surfaces). The adapter's inbound routing keys on
  // `discord:@me:<dm_channel_id>` — rewrite here so the wiring matches.
  const platformId = await normalizeDiscordPlatformId(channelType, body.platform_id);
  const agentGroupId = body.agent_group_id;

  // Optional fields with defaults that match the most common student-DM
  // wiring: pattern engage on "." (match all), shared session, all senders.
  const engageMode: EngageMode = ALLOWED_ENGAGE_MODES.includes(body.engage_mode as EngageMode)
    ? (body.engage_mode as EngageMode)
    : 'pattern';
  const enginePattern = isNonEmptyString(body.engage_pattern) ? body.engage_pattern : '.';
  const sessionMode: MessagingGroupAgent['session_mode'] = ALLOWED_SESSION_MODES.includes(
    body.session_mode as MessagingGroupAgent['session_mode'],
  )
    ? (body.session_mode as MessagingGroupAgent['session_mode'])
    : 'shared';
  const senderScope: SenderScope = ALLOWED_SENDER_SCOPES.includes(body.sender_scope as SenderScope)
    ? (body.sender_scope as SenderScope)
    : 'all';
  const ignoredPolicy: IgnoredMessagePolicy = body.ignored_message_policy === 'accumulate' ? 'accumulate' : 'drop';
  const isGroup = body.is_group === true ? 1 : 0;
  const unknownSenderPolicy: UnknownSenderPolicy =
    body.unknown_sender_policy === 'strict' || body.unknown_sender_policy === 'public'
      ? body.unknown_sender_policy
      : 'public'; // student DMs: permissive — the user_id IS the auth.

  // Find or create the messaging_group keyed on (channel_type, platform_id).
  let mg: MessagingGroup | undefined = getMessagingGroupByPlatform(channelType, platformId);
  let mgCreated = false;
  if (!mg) {
    const mgId = newId('mg');
    mg = {
      id: mgId,
      channel_type: channelType,
      platform_id: platformId,
      name: isNonEmptyString(body.name) ? body.name : null,
      is_group: isGroup,
      unknown_sender_policy: unknownSenderPolicy,
      denied_at: null,
      created_at: nowIso(),
    };
    createMessagingGroup(mg);
    mgCreated = true;
  }

  // Find or create the messaging_group_agent wiring.
  const existingMga = getMessagingGroupAgentByPair(mg.id, agentGroupId);
  let mga: MessagingGroupAgent;
  let mgaCreated = false;
  if (existingMga) {
    mga = existingMga;
  } else {
    const mgaId = newId('mga');
    mga = {
      id: mgaId,
      messaging_group_id: mg.id,
      agent_group_id: agentGroupId,
      engage_mode: engageMode,
      engage_pattern: enginePattern,
      sender_scope: senderScope,
      ignored_message_policy: ignoredPolicy,
      session_mode: sessionMode,
      priority: 0,
      created_at: nowIso(),
    };
    createMessagingGroupAgent(mga);
    mgaCreated = true;
  }

  log.info('Control API: agent-group wiring', {
    messagingGroupId: mg.id,
    messagingGroupAgentId: mga.id,
    channelType,
    // platform_id can contain a Discord user ID — leave un-redacted because
    // it's already a public identifier on Discord, but namespace the log key
    // so external redaction filters don't have to special-case it.
    platformId,
    agentGroupId,
    mgCreated,
    mgaCreated,
  });

  return ok({
    messaging_group_id: mg.id,
    messaging_group_agent_id: mga.id,
    created: mgCreated || mgaCreated,
  });
}

interface CreateAgentGroupBody {
  name: unknown;
  folder?: unknown;
  container_config?: unknown;
  agent_provider?: unknown;
}

// Allowed folder character set: lowercase letters, digits, hyphen.
// Anything else gets normalized away to keep filesystem paths sane.
function normalizeFolder(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

async function handleCreateAgentGroup(req: Request): Promise<Response> {
  let body: CreateAgentGroupBody;
  try {
    body = (await req.json()) as CreateAgentGroupBody;
  } catch {
    return badRequest('invalid JSON body');
  }

  if (!isNonEmptyString(body.name)) return badRequest('name is required');

  // Folder name: explicit override > normalized name. Always validated
  // against path traversal below regardless of source.
  const requestedFolder = isNonEmptyString(body.folder) ? normalizeFolder(body.folder) : normalizeFolder(body.name);
  if (!requestedFolder) {
    return badRequest('folder name resolved to empty after normalization');
  }

  // Idempotency: if a row already has this folder, return its id.
  const existing = getAgentGroupByFolder(requestedFolder);
  if (existing) {
    return ok({
      agent_group_id: existing.id,
      folder: existing.folder,
      created: false,
    });
  }

  // Path-traversal guard — same shape as create-agent.ts.
  const groupPath = path.join(GROUPS_DIR, requestedFolder);
  const resolvedPath = path.resolve(groupPath);
  const resolvedGroupsDir = path.resolve(GROUPS_DIR);
  if (!resolvedPath.startsWith(resolvedGroupsDir + path.sep) && resolvedPath !== resolvedGroupsDir) {
    log.error('control-api: folder path traversal attempt', {
      folder: requestedFolder,
      resolvedPath,
    });
    return badRequest('invalid folder path');
  }

  const agentGroupId = newId('ag');
  const now = nowIso();
  const newGroup: AgentGroup = {
    id: agentGroupId,
    name: body.name,
    folder: requestedFolder,
    agent_provider: isNonEmptyString(body.agent_provider) ? body.agent_provider : null,
    created_at: now,
  };
  createAgentGroup(newGroup);
  initGroupFilesystem(newGroup);

  // If the caller supplied a full container.json, overwrite the default
  // template that initGroupFilesystem just wrote. We trust the caller (it's
  // already authenticated via the control token) but JSON-validate to keep
  // a malformed payload from breaking later container spawns.
  if (body.container_config !== undefined) {
    if (typeof body.container_config !== 'object' || body.container_config === null) {
      return badRequest('container_config must be a JSON object');
    }
    const containerJsonPath = path.join(resolvedPath, 'container.json');
    try {
      fs.writeFileSync(containerJsonPath, JSON.stringify(body.container_config, null, 2) + '\n');
    } catch (err) {
      log.error('control-api: failed to write container.json', {
        agentGroupId,
        folder: requestedFolder,
        err,
      });
      return new Response(JSON.stringify({ error: 'failed to persist container_config' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  log.info('control-api: agent_group created', {
    agentGroupId,
    folder: requestedFolder,
    name: body.name,
    hadContainerConfig: body.container_config !== undefined,
  });

  return ok({
    agent_group_id: agentGroupId,
    folder: requestedFolder,
    created: true,
  });
}

async function handleWelcomeDM(req: Request): Promise<Response> {
  let body: { channel_type?: string; user_id?: string; name?: string };
  try {
    body = (await req.json()) as {
      channel_type?: string;
      user_id?: string;
      name?: string;
    };
  } catch {
    return badRequest('invalid JSON body');
  }
  if (body.channel_type !== 'discord') {
    return badRequest('only channel_type=discord is supported today');
  }
  if (!body.user_id || !body.name) {
    return badRequest('user_id and name are required');
  }
  // Fire-and-forget; the retry loop owns the 403-until-mutual-guild window.
  scheduleWelcomeDM(body.user_id, body.name);
  return ok({ scheduled: true });
}

export async function handleControlRequest(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith('/api/')) return null;

  // readEnvFile() doesn't populate process.env, so read .env directly here.
  // process.env still wins so a shell export overrides .env (deploy/ops).
  const envFile = readEnvFile(['NANOCLAW_CONTROL_TOKEN']);
  const expected = (process.env.NANOCLAW_CONTROL_TOKEN || envFile.NANOCLAW_CONTROL_TOKEN || '').trim();
  if (!expected) {
    return new Response(JSON.stringify({ error: 'control plane disabled' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (!(await isAuthorized(req, expected))) {
    return unauthorized('invalid bearer token');
  }

  if (url.pathname === '/api/agent-groups' && req.method === 'POST') {
    return handleCreateAgentGroup(req);
  }
  if (url.pathname === '/api/agent-groups/wirings' && req.method === 'POST') {
    return handleAgentGroupWiring(req);
  }
  if (url.pathname === '/api/dm/welcome' && req.method === 'POST') {
    return handleWelcomeDM(req);
  }

  return new Response(JSON.stringify({ error: 'unknown control endpoint' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Used by tests + admin tooling to surface agent_group existence checks.
export { getAgentGroup };
