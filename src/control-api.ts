/**
 * Control API for external orchestrators (ChatCSE) to register Discord
 * user → agent_group wirings without holding a CLI session on the host.
 *
 * Single endpoint today:
 *   POST /api/agent-groups/wirings
 *     body:
 *       {
 *         channel_type: "discord",
 *         platform_id: "@me:<discord_user_id>",
 *         agent_group_id: "ag-...",
 *         name?: string,           // human label for the messaging_group
 *         engage_mode?: "pattern" | "mention" | "mention-sticky",
 *         engage_pattern?: string, // default "." (match-all)
 *         session_mode?: "shared" | "per-thread" | "agent-shared",
 *         sender_scope?: "all" | "members",
 *         is_group?: boolean,
 *       }
 *     response 200: { messaging_group_id, messaging_group_agent_id, created: boolean }
 *
 * Auth: Bearer token in `Authorization` header. The expected token comes
 * from `NANOCLAW_CONTROL_TOKEN` env at server start. If the env var is
 * unset, the endpoint returns 503 ("control plane disabled") — fail-closed
 * so a misconfigured deployment can't silently accept anonymous wirings.
 *
 * Idempotent: re-posting the same (channel_type, platform_id, agent_group_id)
 * triple returns the existing IDs with `created: false` instead of creating
 * a duplicate row. This matches the contract callers want for retries
 * (ChatCSE re-attempts on transient daemon downtime).
 */
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from './db/messaging-groups.js';
import { log } from './log.js';
import type {
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
  const platformId = body.platform_id;
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
  const ignoredPolicy: IgnoredMessagePolicy =
    body.ignored_message_policy === 'accumulate' ? 'accumulate' : 'drop';
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

export async function handleControlRequest(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith('/api/')) return null;

  const expected = (process.env.NANOCLAW_CONTROL_TOKEN || '').trim();
  if (!expected) {
    return new Response(JSON.stringify({ error: 'control plane disabled' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (!(await isAuthorized(req, expected))) {
    return unauthorized('invalid bearer token');
  }

  if (url.pathname === '/api/agent-groups/wirings' && req.method === 'POST') {
    return handleAgentGroupWiring(req);
  }

  return new Response(JSON.stringify({ error: 'unknown control endpoint' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
}
