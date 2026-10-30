import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { RelayStore } from './schedule-relay-store.mjs';
import { createScheduleRelay } from './schedule-relay-coordinator.mjs';

/** Install Matrix scheduled replies as part of the dsh-im Host lifecycle. */
export async function installScheduleRelay(ctx, deliveryService, { dshHome, sendTimeoutMs = 60_000, logger = console, registry } = {}) {
  if (!Number.isSafeInteger(sendTimeoutMs) || sendTimeoutMs < 1 || sendTimeoutMs > 2_147_483_647) {
    throw new Error('scheduleReplyTimeoutMs must be an integer between 1 and 2147483647');
  }
  const home = resolve(dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'));
  const store = await RelayStore.open(join(home, 'integrations', 'dsh-matrix', 'schedule-replies.json'));
  let relay;
  try {
    relay = createScheduleRelay({ im: deliveryService, store, logger, sendTimeoutMs, registry });
  } catch (error) {
    await store.close();
    throw error;
  }
  let closeInstallation;
  await ctx.effect(async () => {
    const stops = [
      ctx.on('session/event', (session, event) => { void relay.observeEvent(session, event); }, { global: true }),
      ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
        relay.observeClaim(agent?.session, message, turn);
      }, { global: true }),
      ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next();
        if (decision?.kind === 'enter') await relay.preStep(payload);
        else relay.disposeSession(payload.agent?.session);
        return decision;
      }, { global: true }),
      ctx.on('session/disposed', (session) => relay.disposeSession(session), { global: true }),
    ];
    let closing;
    const close = () => (closing ??= (async () => {
      for (const stop of stops) stop();
      await relay.close();
      await store.close();
    })());
    closeInstallation = close;
    try { await relay.captureBindings(); }
    catch (error) { await close(); throw error; }
    return close;
  }, 'dsh-im.schedule-replies()');
  // The channel's beforeClose uses this same disposer, so hooks and admission
  // stop before adapters disappear, and the store outlives every accepted job.
  return Object.freeze({ ...relay, close: () => closeInstallation() });
}
