/**
 * NanoClaw — main entry point.
 *
 * Thin orchestrator: init DB, run migrations, start channel adapters,
 * start delivery polls, start sweep, handle shutdown.
 */
import path from 'path';

import { DATA_DIR } from './config.js';
import { enforceStartupBackoff, resetCircuitBreaker } from './circuit-breaker.js';
import { migrateGroupsToClaudeLocal } from './claude-md-compose.js';
import { initDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { ensureContainerRuntimeRunning, cleanupOrphans } from './container-runtime.js';
import { startActiveDeliveryPoll, startSweepDeliveryPoll, setDeliveryAdapter, stopDeliveryPolls } from './delivery.js';
import { startHostSweep, stopHostSweep } from './host-sweep.js';
import { routeInbound } from './router.js';
import { log } from './log.js';

// Response + shutdown registries live in response-registry.ts to break the
// circular import cycle: src/index.ts imports src/modules/index.js for side
// effects, and the modules call registerResponseHandler/onShutdown at top
// level — which would hit a TDZ error if the arrays lived here. Re-exported
// here so existing callers see the same surface.
import {
  registerResponseHandler,
  getResponseHandlers,
  onShutdown,
  getShutdownCallbacks,
  type ResponsePayload,
  type ResponseHandler,
} from './response-registry.js';
export { registerResponseHandler, onShutdown };
export type { ResponsePayload, ResponseHandler };

async function dispatchResponse(payload: ResponsePayload): Promise<void> {
  for (const handler of getResponseHandlers()) {
    try {
      const claimed = await handler(payload);
      if (claimed) return;
    } catch (err) {
      log.error('Response handler threw', { questionId: payload.questionId, err });
    }
  }
  log.warn('Unclaimed response', { questionId: payload.questionId, value: payload.value });
}

// Channel barrel — each enabled channel self-registers on import.
// Channel skills uncomment lines in channels/index.ts to enable them.
import './channels/index.js';

// Modules barrel — default modules (typing, mount-security) ship here; skills
// append registry-based modules. Imported for side effects (registrations).
import './modules/index.js';

import type { ChannelAdapter, ChannelSetup } from './channels/adapter.js';
import { initChannelAdapters, teardownChannelAdapters, getChannelAdapter } from './channels/channel-registry.js';

async function main(): Promise<void> {
  log.info('NanoClaw starting');

  // 0a. Single-instance lock — if another NanoClaw is running for this
  // DATA_DIR, refuse to start. Two host processes share container DBs but
  // each has its own in-process activeContainers / wakePromises maps, so
  // every wake spawns a fresh container per process — N hosts → N
  // containers per inbound message. The session DB is the only shared
  // state, so we lock by PID file inside DATA_DIR.
  const fs = await import('fs');
  const pidFile = path.join(DATA_DIR, 'nanoclaw.pid');
  if (fs.existsSync(pidFile)) {
    const oldPidStr = fs.readFileSync(pidFile, 'utf-8').trim();
    const oldPid = Number.parseInt(oldPidStr, 10);
    if (Number.isFinite(oldPid)) {
      try {
        // Signal 0 = check if process exists without sending a real signal.
        process.kill(oldPid, 0);
        log.error(
          `Another NanoClaw instance is running (pid=${oldPid}). Refusing to start. ` +
            `Stop it first or remove ${pidFile} if it is stale.`,
        );
        process.exit(1);
      } catch {
        // ESRCH — process is dead, fall through and overwrite the file.
        log.warn('Stale PID file found, overwriting', { pidFile, oldPid });
      }
    }
  }
  fs.writeFileSync(pidFile, String(process.pid));
  // Best-effort cleanup on any exit. Not foolproof (SIGKILL leaves it),
  // but the staleness check above handles that case on next startup.
  const removePidFile = () => {
    try {
      const current = fs.readFileSync(pidFile, 'utf-8').trim();
      if (current === String(process.pid)) fs.unlinkSync(pidFile);
    } catch {
      // ignore
    }
  };
  process.on('exit', removePidFile);
  process.on('SIGINT', () => {
    removePidFile();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    removePidFile();
    process.exit(143);
  });

  // 0b. Circuit breaker — backoff on rapid restarts
  await enforceStartupBackoff();

  // 1. Init central DB
  const dbPath = path.join(DATA_DIR, 'v2.db');
  const db = initDb(dbPath);
  runMigrations(db);
  log.info('Central DB ready', { path: dbPath });

  // 1b. One-time filesystem cutover — idempotent, no-op after first run.
  migrateGroupsToClaudeLocal();

  // 2. Container runtime
  ensureContainerRuntimeRunning();
  cleanupOrphans();

  // 3. Channel adapters
  await initChannelAdapters((adapter: ChannelAdapter): ChannelSetup => {
    return {
      onInbound(platformId, threadId, message) {
        routeInbound({
          channelType: adapter.channelType,
          platformId,
          threadId,
          message: {
            id: message.id,
            kind: message.kind,
            content: JSON.stringify(message.content),
            timestamp: message.timestamp,
            isMention: message.isMention,
            isGroup: message.isGroup,
          },
        }).catch((err) => {
          log.error('Failed to route inbound message', { channelType: adapter.channelType, err });
        });
      },
      onInboundEvent(event) {
        routeInbound(event).catch((err) => {
          log.error('Failed to route inbound event', {
            sourceAdapter: adapter.channelType,
            targetChannelType: event.channelType,
            err,
          });
        });
      },
      onMetadata(platformId, name, isGroup) {
        log.info('Channel metadata discovered', {
          channelType: adapter.channelType,
          platformId,
          name,
          isGroup,
        });
      },
      onAction(questionId, selectedOption, userId) {
        dispatchResponse({
          questionId,
          value: selectedOption,
          userId,
          channelType: adapter.channelType,
          // platformId/threadId aren't surfaced by the current onAction
          // signature — registered handlers look them up from the
          // pending_question / pending_approval row.
          platformId: '',
          threadId: null,
        }).catch((err) => {
          log.error('Failed to handle question response', { questionId, err });
        });
      },
    };
  });

  // 4. Delivery adapter bridge — dispatches to channel adapters.
  //
  // Persona-impersonation hook: when delivering to a Discord guild
  // channel and the agent_group has a name (= "Vinamra", "Alice", …),
  // route through a per-channel webhook so the message displays as
  // "Vinamra's agent" instead of the shared bot's identity. The webhook
  // path no-ops cleanly for DMs (Discord doesn't allow DM webhooks) and
  // for any channel where the bot lacks Manage Webhooks. Falls back to
  // the regular adapter.deliver() in all "can't" cases.
  const deliveryAdapter = {
    async deliver(
      channelType: string,
      platformId: string,
      threadId: string | null,
      kind: string,
      content: string,
      files?: import('./channels/adapter.js').OutboundFile[],
    ): Promise<string | undefined> {
      const adapter = getChannelAdapter(channelType);
      if (!adapter) {
        log.warn('No adapter for channel type', { channelType });
        return;
      }
      // Persona path — Discord guild channels only, opt-in via env so it
      // stays off until the operator grants the bot Manage Webhooks.
      if (
        channelType === 'discord' &&
        platformId &&
        !platformId.startsWith('@me:') &&
        process.env.NANOCLAW_PERSONA_ENABLED === '1' &&
        kind === 'chat'
      ) {
        try {
          const parsed = JSON.parse(content) as { text?: string };
          const text = parsed.text;
          if (text) {
            const { getMessagingGroupByPlatform } = await import(
              './db/messaging-groups.js'
            );
            const { getAgentGroup } = await import('./db/agent-groups.js');
            const { deliverViaWebhook } = await import('./discord-persona.js');
            const mg = getMessagingGroupByPlatform('discord', platformId);
            if (mg && mg.is_group !== 0) {
              // Find the wired agent_group's name to use as the persona.
              // Multi-agent channels use the first wired agent's name —
              // good enough; per-message persona resolution would need
              // session context that this layer doesn't have.
              const { getMessagingGroupAgents } = await import(
                './db/messaging-groups.js'
              );
              const agents = getMessagingGroupAgents(mg.id);
              const ag = agents.length > 0 ? getAgentGroup(agents[0].agent_group_id) : null;
              if (ag?.name) {
                const username = `${ag.name}'s agent`.slice(0, 80);
                const fileBufs = (files ?? []).map((f) => ({
                  name: f.filename,
                  data: f.data,
                }));
                const id = await deliverViaWebhook({
                  channelId: platformId,
                  threadId,
                  text,
                  username,
                  files: fileBufs.length > 0 ? fileBufs : undefined,
                });
                if (id) return id;
                // Webhook path failed — log once and fall through to bot send.
                log.debug('discord-persona: webhook send unavailable, using bot identity', {
                  channelId: platformId,
                });
              }
            }
          }
        } catch (err) {
          log.warn('discord-persona: pre-deliver hook threw, falling back', { err });
        }
      }
      return adapter.deliver(platformId, threadId, { kind, content: JSON.parse(content), files });
    },
    async setTyping(channelType: string, platformId: string, threadId: string | null): Promise<void> {
      const adapter = getChannelAdapter(channelType);
      await adapter?.setTyping?.(platformId, threadId);
    },
  };
  setDeliveryAdapter(deliveryAdapter);

  // 5. Start delivery polls
  startActiveDeliveryPoll();
  startSweepDeliveryPoll();
  log.info('Delivery polls started');

  // 6. Start host sweep
  startHostSweep();
  log.info('Host sweep started');

  log.info('NanoClaw running');
}

/** Graceful shutdown. */
async function shutdown(signal: string): Promise<void> {
  log.info('Shutdown signal received', { signal });
  for (const cb of getShutdownCallbacks()) {
    try {
      await cb();
    } catch (err) {
      log.error('Shutdown callback threw', { err });
    }
  }
  stopDeliveryPolls();
  stopHostSweep();
  try {
    await teardownChannelAdapters();
  } finally {
    // Always reset on graceful shutdown — even if teardown threw, we got here
    // via SIGTERM/SIGINT, not a crash, so the next start shouldn't be counted
    // as one.
    resetCircuitBreaker();
    process.exit(0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((err) => {
  log.fatal('Startup failed', { err });
  process.exit(1);
});
