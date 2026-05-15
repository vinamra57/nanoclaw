/**
 * Normalize a Discord DM platform_id from `@me:<user_id>` to
 * `discord:@me:<dm_channel_id>` — the format the daemon's adapter
 * actually emits for inbound DMs.
 *
 * Why:
 *   - The chat-sdk-bridge passes `channelIdFromThreadId(thread.id)` as
 *     `platformId` on inbound. For Discord DMs the channel encoding is
 *     `discord:@me:<dm_channel_id>` (numeric DM channel id, not user id).
 *   - ChatCSE's spawn-assistant only knows the student's user_id (from
 *     Discord OAuth), not their DM channel id. Without normalization,
 *     wirings written as `@me:<user_id>` never match the inbound lookup
 *     and the student falls into the sender-approval flow.
 *
 * Strategy:
 *   - If `platform_id` already looks like `discord:@me:...`, leave it.
 *   - If it looks like `@me:<user_id>`, call Discord's REST API to open
 *     a DM channel with that user (idempotent — Discord returns the
 *     existing channel if one exists) and rewrite to the canonical form.
 *   - On Discord API failure, leave the user_id form in place and log;
 *     the welcome-DM retry loop will still drive the conversation when
 *     the student first DMs the bot manually.
 */

import { log } from './log.js';
import { readEnvFile } from './env.js';

const DISCORD_API = 'https://discord.com/api/v10';

function getBotToken(): string | null {
  const env = readEnvFile(['DISCORD_BOT_TOKEN']);
  return env.DISCORD_BOT_TOKEN || process.env.DISCORD_BOT_TOKEN || null;
}

/** Returns the DM channel id, or null on failure. */
async function openDmChannel(userId: string): Promise<string | null> {
  const token = getBotToken();
  if (!token) return null;
  try {
    const r = await fetch(`${DISCORD_API}/users/@me/channels`, {
      method: 'POST',
      headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient_id: userId }),
    });
    if (!r.ok) {
      log.warn('open DM channel failed', { userId, status: r.status });
      return null;
    }
    const data = (await r.json()) as { id?: string };
    return data.id ?? null;
  } catch (err) {
    log.warn('open DM channel error', { userId, err: String(err) });
    return null;
  }
}

/**
 * Normalize a Discord platform_id to the daemon's inbound shape.
 *
 * @param channelType  must be "discord"; otherwise the input is returned as-is.
 * @param platformId   `@me:<user_id>` (from ChatCSE) or already-canonical.
 */
export async function normalizeDiscordPlatformId(
  channelType: string,
  platformId: string,
): Promise<string> {
  if (channelType !== 'discord') return platformId;
  if (platformId.startsWith('discord:')) return platformId;
  const userMatch = platformId.match(/^@me:(\d{17,20})$/);
  if (!userMatch) return platformId;
  const userId = userMatch[1];
  const channelId = await openDmChannel(userId);
  if (!channelId) return platformId;
  return `discord:@me:${channelId}`;
}
