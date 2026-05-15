/**
 * Slash-command handler for late-binding per-provider API keys.
 *
 * Intercepts messages of the form `/edstem-key <secret>`,
 * `/canvas-key <secret>`, `/gradescope-key <secret>` BEFORE they reach the
 * agent container. The secret is forwarded to ChatCSE's
 * `/api/agent/credentials/<provider>` endpoint, where it is encrypted at
 * rest and pulled by the relevant MCP server on next call.
 *
 * Hard requirements:
 *   - The plaintext value MUST NOT appear in any log line.
 *   - The plaintext value MUST NOT be written to the agent's session
 *     messages_in (i.e. it must be intercepted before writeSessionMessage).
 *   - On HTTP success the user gets a confirmation message; on failure they
 *     get an actionable error WITHOUT the value echoed back.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { log } from './log.js';

export type ProviderKeyResult = { handled: false } | { handled: true; replyText: string };

const SUPPORTED_PROVIDERS = new Set(['edstem-key', 'canvas-key', 'gradescope-key']);

// Allow alnum + a few separators commonly seen in API tokens. Must be at
// least 6 chars (cheap typo guard) and at most 4096 (matches backend limit).
const COMMAND_REGEX = /^\/([a-z]+-key)\s+(\S{6,4096})\s*$/i;

/**
 * Try to handle the message as a /<provider>-key command.
 *
 * Returns `{handled: false}` for normal messages — caller proceeds with the
 * usual session/agent dispatch. Returns `{handled: true, replyText}` for
 * recognized commands; caller should write `replyText` as the outbound
 * reply and SKIP writing the message to messages_in.
 */
export async function handleProviderKey(rawText: string): Promise<ProviderKeyResult> {
  const trimmed = rawText.trim();
  if (!trimmed.startsWith('/')) return { handled: false };
  const m = trimmed.match(COMMAND_REGEX);
  if (!m) return { handled: false };
  const command = m[1].toLowerCase();
  if (!SUPPORTED_PROVIDERS.has(command)) return { handled: false };
  const value = m[2];
  const provider = command.replace(/-key$/, '');

  log.info('Received provider-key command', { provider });

  let env: { token: string; baseUrl: string };
  try {
    env = readChatCSEEnv();
  } catch (err) {
    log.warn('provider-key: env read failed', { provider, err: (err as Error).message });
    return {
      handled: true,
      replyText:
        `I couldn't store your ${provider} key — the container is missing CHATCSE_AGENT_TOKEN ` +
        `or CHATCSE_BASE_URL in ~student-assistant/.env. Ask course staff to re-provision.\n\n` +
        `**Please delete your message above for security.**`,
    };
  }

  try {
    const resp = await fetch(`${env.baseUrl.replace(/\/$/, '')}/api/agent/credentials/${provider}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.token}`,
      },
      body: JSON.stringify({ value }),
    });
    if (!resp.ok) {
      const detail = await resp.text();
      log.warn('provider-key: ChatCSE rejected', { provider, status: resp.status });
      return {
        handled: true,
        replyText:
          `ChatCSE rejected the ${provider} key (HTTP ${resp.status}). ` +
          `${detail.slice(0, 240)}\n\n**Please delete your message above for security.**`,
      };
    }
    return {
      handled: true,
      replyText:
        `Got it — your ${provider} key is saved (encrypted at rest in ChatCSE). ` +
        `It will be used the next time the ${provider} MCP server is invoked.\n\n` +
        `**Please delete your message above for security.** ` +
        `Discord doesn't let me delete it for you yet, but the key is now safely stored ` +
        `server-side and never has to live in chat again.`,
    };
  } catch (err) {
    log.warn('provider-key: ChatCSE call failed', { provider, err: (err as Error).message });
    return {
      handled: true,
      replyText:
        `Couldn't reach ChatCSE to save your ${provider} key (${(err as Error).message}). ` +
        `Try again in a moment.\n\n**Please delete your message above for security.**`,
    };
  }
}

/**
 * Read CHATCSE_AGENT_TOKEN + CHATCSE_BASE_URL from ~student-assistant/.env.
 *
 * That file is the single source of truth for per-student secrets — written
 * by setup-student.sh at provisioning time, read by the bridge.mjs at
 * container startup, and now by this slash-command handler too.
 */
function readChatCSEEnv(): { token: string; baseUrl: string } {
  const envPath = process.env.STUDENT_ASSISTANT_ENV_PATH || path.join(os.homedir(), 'student-assistant', '.env');
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
  const token = map.CHATCSE_AGENT_TOKEN;
  // VIRTUAL_TA_URL points to ChatCSE's base — same host, MCP is at /mcp,
  // REST is at /api/*. Default to host.docker.internal:8000 for local dev.
  const baseUrl =
    map.CHATCSE_BASE_URL || map.VIRTUAL_TA_URL?.replace(/:8001$/, ':8000') || 'http://host.docker.internal:8000';
  if (!token) {
    throw new Error('CHATCSE_AGENT_TOKEN missing');
  }
  return { token, baseUrl };
}
