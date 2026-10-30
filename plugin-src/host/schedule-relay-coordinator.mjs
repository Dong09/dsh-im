import { destination, destinationIdentity } from './schedule-relay-store.mjs';
import { isMatrixEventId } from '../../src/channels/matrix/matrix-identifiers.mjs';
import { outboundArtifactRegistry, releaseOutboundArtifact } from '../../src/channels/shared/semantic/artifact.mjs';

const textOf = (message) => (message?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n').trim();
const sessionIdOf = (session) => typeof session === 'string' ? session : session?.id ?? session?.header?.id ?? session?.sessionId;
const keyOf = (sessionId, turn) => `${sessionId}\u0000${turn}`;
const errorCode = (error, fallback = 'send-result-unknown') => /^[a-z][a-z0-9-]{0,79}$/.test(error?.code ?? '') ? error.code : fallback;
const DEFINITE_FAILURES = new Set(['unknown-bot', 'bot-not-connected', 'target-rejected', 'invalid-target', 'account-changed',
  'capability-unavailable', 'provider-unavailable', 'target-changed', 'binding-conflict', 'unbound-session', 'account-unverified', 'delivery-failed']);

/** Only known producer/form pairs are automatic; text and arbitrary snapshots never grant trust. */
export function isAutomaticRelayInput(source) {
  return (['runtime-context', 'time-context'].includes(source?.kind) && source.form === 'snapshot')
    || (source?.kind === 'skill-catalog' && source.form === 'catalog')
    || (source?.kind === 'plugin:dsh-im' && ['snapshot', 'notice'].includes(source.form));
}

function partResult(receipt) {
  const ids = [...new Set((receipt?.providerMessageIds ?? []).filter(isMatrixEventId))];
  const status = receipt?.deliveryOutcome === 'sent' && ids.length > 0 ? 'sent'
    : receipt?.deliveryOutcome === 'failed' ? 'failed' : 'unknown';
  const result = { status, providerMessageIds: ids };
  if (status !== 'sent') result.error = errorCode({ code: receipt?.reason ?? receipt?.errorCode }, status === 'failed' ? 'delivery-failed' : 'send-result-unknown');
  if (receipt?.failureNotice) {
    const notice = partResult(receipt.failureNotice);
    result.notice = { status: notice.status, providerMessageIds: notice.providerMessageIds,
      ...(notice.error ? { error: notice.error } : {}) };
  }
  return result;
}

/**
 * Synchronous per-(Session,turn) admission is separate from per-Session delivery.
 * No provider closure writes checkpoints: local persistence cannot trigger image fallback.
 */
export function createScheduleRelay({ im, store, registry = outboundArtifactRegistry, logger = console, sendTimeoutMs = 60_000 }) {
  for (const method of ['listBots', 'listConversationBindings', 'authorizeScheduledTarget', 'sendScheduledPart']) {
    if (typeof im?.[method] !== 'function') throw new Error(`dsh-im capability unavailable: ${method}`);
  }
  if (!Number.isSafeInteger(sendTimeoutMs) || sendTimeoutMs < 1 || sendTimeoutMs > 2_147_483_647) throw new Error('invalid-send-timeout');
  const turns = new Map();
  const current = new Map();
  const ended = new Map();
  const tails = new Map();
  const preparations = new Set();
  const jobs = new Set();
  let closed = false;
  let closing;
  const warn = (sessionId, code) => logger.warn?.(`[schedule-im-relay] Session ${sessionId}: ${code}`);
  const closeLease = (state) => { state.lease?.close(); state.lease = null; };
  const reject = (state, code) => {
    state.rejected = code;
    closeLease(state);
    if (state.scheduled) warn(state.sessionId, code);
  };

  const captureBindings = async (onlySession) => {
    const bySession = new Map();
    for (const bot of await im.listBots()) {
      if (closed) return null;
      if (bot.channel !== 'matrix') continue;
      const result = await im.listConversationBindings(bot.botId);
      if (closed) return null;
      if (result.botId !== bot.botId || result.channel !== 'matrix' || !Array.isArray(result.bindings)) throw new Error('invalid-binding-response');
      for (const binding of result.bindings) {
        if (!['room', 'thread'].includes(binding.kind) || (onlySession && binding.sessionId !== onlySession)) continue;
        const route = destination({ botId: bot.botId, ...binding });
        const list = bySession.get(binding.sessionId) ?? [];
        list.push(route);
        bySession.set(binding.sessionId, list);
      }
    }
    for (const [sessionId, candidates] of bySession) {
      if (closed) return null;
      const record = await store.remember(sessionId, candidates);
      if (record.conflict) warn(sessionId, 'binding-conflict');
    }
    return onlySession ? store.get(onlySession) : undefined;
  };

  const stateFor = (sessionId, turn) => {
    if (closed || typeof sessionId !== 'string' || !sessionId || !Number.isSafeInteger(turn) || turn < 0
      || (ended.get(sessionId) ?? -1) >= turn) return null;
    const key = keyOf(sessionId, turn);
    let state = turns.get(key);
    if (!state) {
      state = { sessionId, turn, scheduled: false, mixed: false, claimed: new Set(), generation: 0,
        text: '', lease: null, route: null, authorization: null, rejected: null, ended: false, signal: null, onAbort: null };
      turns.set(key, state);
    }
    current.set(sessionId, key);
    return state;
  };

  const observeClaim = (session, message, turn) => {
    const state = stateFor(sessionIdOf(session), turn);
    if (!state) return;
    registry.observeClaimedMessage(session, message, turn);
    const id = message?.id;
    if (id && state.claimed.has(id)) return;
    if (id) state.claimed.add(id);
    state.generation += 1;
    if (message?.source?.kind === 'schedule') state.scheduled = true;
    else if (!isAutomaticRelayInput(message?.source)) {
      state.mixed = true;
      reject(state, 'mixed-input');
    }
    // Mixed is sticky even when schedule is the last message claimed.
    if (state.scheduled && state.mixed) reject(state, 'mixed-input');
  };

  const prepare = async ({ agent, turn, signal }) => {
    const sessionId = sessionIdOf(agent?.session);
    const state = turns.get(keyOf(sessionId, turn));
    if (closed || !state || !state.scheduled || state.ended || state.mixed || state.rejected || signal?.aborted) {
      if (state && signal?.aborted) reject(state, 'cancelled');
      return;
    }
    const generation = state.generation;
    const valid = () => !closed && !state.ended && !state.mixed && !state.rejected && !signal?.aborted
      && turns.get(keyOf(sessionId, turn)) === state && current.get(sessionId) === keyOf(sessionId, turn)
      && state.generation === generation;
    try {
      const record = await captureBindings(sessionId);
      if (!valid()) return;
      if (!record || record.conflict) { reject(state, record ? 'binding-conflict' : 'unbound-session'); return; }
      const route = destination(record.destination);
      if (state.route && destinationIdentity(route) !== destinationIdentity(state.route)) { reject(state, 'target-changed'); return; }
      const authorization = state.authorization ?? await im.authorizeScheduledTarget(route.botId, { kind: route.kind, route: route.route }, { signal });
      if (!valid()) return;
      if (!state.lease) {
        state.lease = registry.openTurnConsumer(sessionId, turn);
        if (!state.lease) { reject(state, 'consumer-conflict'); return; }
      }
      if (!state.lease.active) { reject(state, 'consumer-conflict'); return; }
      state.route = Object.freeze({ ...route, route: Object.freeze(route.route) });
      state.authorization = authorization;
      if (state.signal !== signal) {
        state.signal?.removeEventListener('abort', state.onAbort);
        state.signal = signal;
        state.onAbort = () => reject(state, 'cancelled');
        signal?.addEventListener('abort', state.onAbort, { once: true });
      }
    } catch (error) { reject(state, errorCode(error, 'route-authorization-failed')); }
  };

  const preStep = (payload) => {
    const task = prepare(payload);
    preparations.add(task);
    void task.finally(() => preparations.delete(task));
    return task;
  };

  const deliver = async (job) => {
    let attempt;
    try {
      if (closed || job.controller.signal.aborted) return;
      const record = await captureBindings(job.sessionId);
      if (closed || job.controller.signal.aborted) return;
      if (!record || record.conflict || destinationIdentity(record.destination) !== destinationIdentity(job.route)) {
        warn(job.sessionId, record?.conflict ? 'binding-conflict' : 'target-changed'); return;
      }
      attempt = await store.attempt(job.sessionId, job.turn, job.manifest, { expectedDestination: job.route });
      if (!attempt) return;
      for (const part of job.parts) {
        if (closed || job.controller.signal.aborted) {
          await store.skipPending(job.sessionId, job.turn, attempt.attemptId, 'cancelled'); break;
        }
        const latest = await captureBindings(job.sessionId);
        if (closed || job.controller.signal.aborted || !latest || latest.conflict
          || destinationIdentity(latest.destination) !== destinationIdentity(job.route)) {
          await store.skipPending(job.sessionId, job.turn, attempt.attemptId, latest?.conflict ? 'binding-conflict' : 'cancelled'); break;
        }
        // This write must settle before upload/send. Any checkpoint failure exits
        // this loop; it is deliberately outside the provider's fallback handler.
        await store.startPart(job.sessionId, job.turn, attempt.attemptId, part.id);
        if (closed || job.controller.signal.aborted) {
          await store.finishPart(job.sessionId, job.turn, attempt.attemptId, part.id, {
            status: 'failed', error: 'cancelled', providerMessageIds: [],
          });
          await store.skipPending(job.sessionId, job.turn, attempt.attemptId, 'cancelled');
          break;
        }
        let result;
        try {
          const receipt = await im.sendScheduledPart(job.route.botId, { kind: job.route.kind, route: job.route.route }, part.value, {
            authorization: job.authorization, format: 'markdown', signal: job.controller.signal,
          });
          result = partResult(receipt);
        } catch (error) {
          const code = errorCode(error);
          result = { status: DEFINITE_FAILURES.has(code) ? 'failed' : 'unknown', error: code, providerMessageIds: [] };
        }
        if (result.status !== 'sent') warn(job.sessionId, result.error);
        // A failed terminal write retains durable sending and stops every later part.
        await store.finishPart(job.sessionId, job.turn, attempt.attemptId, part.id, result);
        if (DEFINITE_FAILURES.has(result.error) && result.error !== 'delivery-failed') {
          await store.skipPending(job.sessionId, job.turn, attempt.attemptId, result.error); break;
        }
      }
    } catch (error) { warn(job.sessionId, errorCode(error, 'relay-checkpoint-failed')); }
    finally {
      clearTimeout(job.timer);
      for (const artifact of job.artifacts) releaseOutboundArtifact(artifact);
      jobs.delete(job);
    }
  };

  const queueJob = (job) => {
    jobs.add(job);
    const task = (tails.get(job.sessionId) ?? Promise.resolve()).then(() => deliver(job));
    const tail = task.catch((error) => warn(job.sessionId, errorCode(error, 'relay-event-failed')))
      .finally(() => { if (tails.get(job.sessionId) === tail) tails.delete(job.sessionId); });
    tails.set(job.sessionId, tail);
    return tail;
  };

  const complete = (state, reason) => {
    state.ended = true;
    ended.set(state.sessionId, Math.max(ended.get(state.sessionId) ?? -1, state.turn));
    turns.delete(keyOf(state.sessionId, state.turn));
    if (current.get(state.sessionId) === keyOf(state.sessionId, state.turn)) current.delete(state.sessionId);
    state.signal?.removeEventListener('abort', state.onAbort);
    let artifacts = [];
    try {
      if (closed || reason !== 'completed' || !state.scheduled || state.mixed || state.rejected
        || state.signal?.aborted || !state.lease?.active || !state.route || !state.authorization) return Promise.resolve();
      // Keep genuine WeakMap-backed artifact identities across the hand-off.
      artifacts = state.lease.take();
      if (!state.text && artifacts.length === 0) return Promise.resolve();
      const parts = [];
      if (state.text) parts.push({ id: 'text', value: Object.freeze({ kind: 'text', text: state.text }) });
      const seen = new Set();
      for (const artifact of artifacts) {
        if (seen.has(artifact.artifactId)) continue;
        seen.add(artifact.artifactId);
        parts.push({ id: `artifact:${artifact.artifactId}`, value: Object.freeze({ kind: 'artifact', artifact }) });
      }
      const manifest = parts.map(({ id, value }) => value.kind === 'text' ? { id, kind: 'text' } : {
        id, kind: 'artifact', artifactId: value.artifact.artifactId, fileName: value.artifact.fileName,
        mediaType: value.artifact.mediaType, size: value.artifact.size, digest: value.artifact.digest,
      });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(Object.assign(new Error('send-result-unknown'), { code: 'send-result-unknown' })), sendTimeoutMs);
      timer.unref?.();
      const job = Object.freeze({ sessionId: state.sessionId, turn: state.turn, route: state.route, authorization: state.authorization,
        text: state.text, parts: Object.freeze(parts), manifest: Object.freeze(manifest), artifacts: Object.freeze(artifacts), controller, timer });
      const result = queueJob(job);
      artifacts = [];
      return result;
    } finally {
      closeLease(state);
      for (const artifact of artifacts) releaseOutboundArtifact(artifact);
    }
  };

  const observeEvent = (session, event) => {
    const sessionId = sessionIdOf(session);
    if (closed || !sessionId || !event) return Promise.resolve();
    // Both observers are synchronous; duplicate registry observations are idempotent.
    registry.observeSessionEvent(typeof session === 'string' ? { id: session } : session, event, { logger });
    if (event.type === 'turn/start') { stateFor(sessionId, event.data?.turn); return Promise.resolve(); }
    const key = event.data?.turn === undefined ? current.get(sessionId) : keyOf(sessionId, event.data.turn);
    const state = turns.get(key);
    if (!state) return Promise.resolve();
    if (event.type === 'user/message' && event.surfaceOp === 'append') {
      // Durable metadata never opens authority. It may only fail closed if an
      // unclaimed real input appeared after pre-step (including a later step).
      if (!isAutomaticRelayInput(event.data?.source) && event.data?.source?.kind !== 'schedule'
        && !state.claimed.has(event.data?.id)) { state.mixed = true; reject(state, 'mixed-input'); }
    } else if (event.type === 'assistant/message' && event.surfaceOp === 'append' && event.data?.interrupted !== true) {
      state.text = textOf(event.data?.message);
    } else if (event.type === 'turn/end') {
      const reason = typeof event.data?.reason === 'string' ? event.data.reason : event.data?.reason?.kind;
      return complete(state, reason);
    }
    return Promise.resolve();
  };

  const disposeSession = (session) => {
    const sessionId = sessionIdOf(session);
    for (const [key, state] of turns) if (state.sessionId === sessionId) {
      reject(state, 'session-disposed'); state.ended = true; turns.delete(key);
    }
    current.delete(sessionId);
    for (const job of jobs) if (job.sessionId === sessionId) job.controller.abort(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
  };

  return Object.freeze({
    captureBindings, observeClaim, observeEvent, preStep, disposeSession,
    // Kept for callers that await delivery completion, not for authorization.
    enqueue: observeEvent,
    async whenIdle() { while (tails.size || preparations.size) await Promise.all([...tails.values(), ...preparations]); },
    close() {
      if (closing) return closing;
      closed = true;
      for (const state of turns.values()) reject(state, 'cancelled');
      turns.clear(); current.clear();
      for (const job of jobs) job.controller.abort(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
      closing = (async () => {
        while (tails.size || preparations.size) await Promise.all([...tails.values(), ...preparations]);
      })();
      return closing;
    },
  });
}
