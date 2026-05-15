/**
 * Welcome DM — send the bot's introduction message to a freshly-spawned
 * student. Discord won't deliver a bot DM until the student shares at
 * least one guild with the bot, so we retry on 403/404 over the next
 * ~2 minutes while waiting for the mutual-guild record to propagate
 * after they click the server invite.
 *
 * Triggered by ChatCSE's `POST /api/dm/welcome` after a spawn-assistant
 * call succeeds. The endpoint accepts the request, kicks off the retry
 * loop in the background, and returns 200 immediately — the caller
 * doesn't wait the full retry window.
 */

import { log } from './log.js';
import { readEnvFile } from './env.js';

const DISCORD_API = 'https://discord.com/api/v10';

// Delays between attempts, in seconds. Roughly 2 minutes total — long
// enough for most click-the-invite-and-accept journeys; short enough
// that an abandoned browser tab doesn't keep this loop alive forever.
const RETRY_DELAYS_SECONDS = [3, 5, 8, 13, 21, 34, 34];

function welcomeText(name: string): string {
  return [
    `Hi ${name}! I'm your Studentclaw agent.`,
    '',
    "I can help with your courses: ask me about lectures, search Ed/Canvas/Gradescope, look at your GitHub repos, and more. Try asking me anything course-related to get started.",
  ].join('\n');
}

function getBotToken(): string | null {
  const env = readEnvFile(['DISCORD_BOT_TOKEN']);
  return env.DISCORD_BOT_TOKEN || process.env.DISCORD_BOT_TOKEN || null;
}

async function attemptDM(userId: string, text: string): Promise<{ ok: boolean; status: number }> {
  const token = getBotToken();
  if (!token) return { ok: false, status: 500 };

  // Open (or get) the bot's DM channel with this user.
  const openRes = await fetch(`${DISCORD_API}/users/@me/channels`, {
    method: 'POST',
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient_id: userId }),
  });
  if (!openRes.ok) {
    return { ok: false, status: openRes.status };
  }
  const dm = (await openRes.json()) as { id: string };

  // Post the message.
  const postRes = await fetch(`${DISCORD_API}/channels/${dm.id}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: text }),
  });
  return { ok: postRes.ok, status: postRes.status };
}

/** Schedule a welcome DM with retry on 403/404. Returns immediately. */
export function scheduleWelcomeDM(userId: string, name: string): void {
  if (!userId || !name) return;
  const text = welcomeText(name);

  (async () => {
    // First try — instant. Usually 403s because mutual guild hasn't
    // been recorded yet (Discord's HTTP-layer membership check is
    // separate from gateway READY).
    const first = await attemptDM(userId, text);
    if (first.ok) {
      log.info('welcome-dm: delivered on first try', { userId });
      return;
    }

    for (let i = 0; i < RETRY_DELAYS_SECONDS.length; i++) {
      const delay = RETRY_DELAYS_SECONDS[i];
      await new Promise((r) => setTimeout(r, delay * 1000));
      const r = await attemptDM(userId, text);
      if (r.ok) {
        log.info('welcome-dm: delivered after retry', { userId, attempt: i + 2 });
        return;
      }
    }
    log.warn('welcome-dm: gave up — student will need to initiate', { userId });
  })().catch((err) => {
    log.warn('welcome-dm: unhandled error', { userId, err: String(err) });
  });
}
