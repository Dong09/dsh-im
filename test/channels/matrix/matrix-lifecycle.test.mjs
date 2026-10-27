import assert from 'node:assert/strict';
import test from 'node:test';
import { MatrixRuntime } from '../../../src/channels/matrix/matrix-runtime.mjs';
import { MatrixApiError } from '../../../src/channels/matrix/matrix-api.mjs';

const ROOM = '!lifecycle:example.org';
const BOT = '@bot:example.org';
const identity = { user_id: BOT, device_id: 'DEVICE' };
const turn = () => new Promise(setImmediate);
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(t, options = {}) {
  const calls = [];
  const pending = new Set();
  const polls = [];
  const pollEntered = deferred();
  const warned = deferred();
  const sessions = new Map();
  const seen = new Set();
  const value = {};
  const writes = [];
  let creations = 0;
  const api = {
    async whoami(args) { calls.push({ op: 'whoami', args }); return options.whoami ? options.whoami(args) : identity; },
    async sync(args = {}) {
      calls.push({ op: 'sync', args });
      if (options.sync) return options.sync(args);
      if (args.timeout === 0) return options.initial ?? { next_batch: 'b0' };
      const waiter = deferred();
      const onAbort = () => waiter.reject(args.signal.reason);
      pending.add(waiter);
      polls.push({ ...waiter, signal: args.signal });
      if (args.signal?.aborted) onAbort();
      else args.signal?.addEventListener('abort', onAbort, { once: true });
      pollEntered.resolve();
      try { return await waiter.promise; }
      finally { pending.delete(waiter); args.signal?.removeEventListener('abort', onAbort); }
    },
    async getAccountData() { return {}; },
    async sendEvent(roomId, type, content, opts) {
      calls.push({ op: 'send', roomId, type, content, opts });
      return options.sendEvent ? options.sendEvent(roomId, type, content, opts) : { event_id: `$sent-${calls.length}:example.org` };
    },
    async setTyping() {},
    async joinRoom(roomId, args) { return options.joinRoom?.(roomId, args) ?? { room_id: roomId }; },
    async listRelations(...args) { return options.relations ? options.relations(...args) : { events: [] }; },
    async redactEvent() {},
  };
  const sidecar = {
    dmRooms: () => [], joinedRooms: () => [], dmRoomByUser: () => ({}),
    isDeclined: () => false, declinedRooms: () => [],
    async apply(patch) { writes.push({ ...patch }); await options.apply?.(patch); Object.assign(value, patch); },
  };
  const state = {
    snapshot: () => ({ seenMessageIds: [...seen] }),
    hasSeen: (id) => seen.has(id), markSeen: async (id) => { seen.add(id); },
    unmarkSeen: async (id) => seen.delete(id),
    sessionFor: (key) => sessions.get(key) ?? null,
    setSession: async (key, id) => { sessions.set(key, id); },
    clearSession: async (key) => { sessions.delete(key); },
  };
  const runtime = new MatrixRuntime({
    config: { homeserver: 'https://matrix.example.org', userId: BOT,
      e2eeMode: 'off', coalesceWindowMs: 0, autoSteerSameSender: false,
      visibleContextEnabled: false, reactions: false, ...options.config },
    accessToken: 'fixture', state, sidecar,
    createApi: () => { creations += 1; return api; },
    harness: { sessionExists: async () => false, createSession: async () => 'session',
      ask: options.ask ?? (async () => 'answer') },
    logger: { info() {}, warn(...args) { warned.resolve(args); }, error() {} },
    cryptoStore: options.cryptoStore,
    createCrypto: options.createCrypto,
  });
  t.after(async () => {
    options.cleanup?.();
    for (const waiter of pending) waiter.reject(new DOMException('Fixture cleanup', 'AbortError'));
    await runtime.stop();
  });
  return { runtime, api, calls, pending, polls, pollEntered, warned, writes, value,
    get creations() { return creations; } };
}

test('matrix lifecycle concurrent starts share one identity verification', { timeout: 5_000 }, async (t) => {
  const entered = deferred(), gate = deferred();
  const f = fixture(t, { whoami: () => { entered.resolve(); return gate.promise; }, cleanup: () => gate.resolve(identity) });
  const first = f.runtime.start();
  await entered.promise;
  const second = f.runtime.start();
  gate.resolve(identity);
  await Promise.all([first, second]);
  assert.equal(f.creations, 1);
});

test('matrix lifecycle stop aborts identity startup and waits for its late result', { timeout: 5_000 }, async (t) => {
  const entered = deferred(), gate = deferred();
  let signal;
  const f = fixture(t, { whoami: (args) => { signal = args?.signal; entered.resolve(); return gate.promise; }, cleanup: () => gate.resolve(identity) });
  const starting = f.runtime.start().catch((error) => error);
  await entered.promise;
  let stopped = false;
  const stopping = f.runtime.stop().then(() => { stopped = true; });
  await turn();
  assert.equal(stopped, false, 'stop must wait for the admitted startup task');
  assert.equal(signal.aborted, true);
  gate.resolve(identity);
  await stopping;
  assert.equal((await starting).name, 'AbortError');
  assert.equal(f.calls.filter((call) => call.op === 'sync').length, 0);
  await assert.rejects(f.runtime.sendProactiveText({ kind: 'room', route: { roomId: ROOM } }, 'late'));
});

test('matrix lifecycle initial sync cannot write a cursor after stop returns', { timeout: 5_000 }, async (t) => {
  const entered = deferred(), gate = deferred();
  const f = fixture(t, { sync: () => { entered.resolve(); return gate.promise; }, cleanup: () => gate.resolve({ next_batch: 'late' }) });
  const starting = f.runtime.start().catch((error) => error);
  await entered.promise;
  let stopped = false;
  const stopping = f.runtime.stop().then(() => { stopped = true; });
  await turn();
  assert.equal(stopped, false);
  gate.resolve({ next_batch: 'late' });
  await stopping;
  await starting;
  assert.deepEqual(f.writes, []);
  assert.equal(f.runtime.status.ready, false);
});

test('matrix lifecycle crypto finishing during stop is released exactly once', { timeout: 5_000 }, async (t) => {
  const entered = deferred(), gate = deferred();
  let stops = 0;
  const engine = {
    setPendingMessageHandler() {}, getStats: () => ({}),
    async start() { entered.resolve(); await gate.promise; },
    async stop() { stops += 1; },
  };
  const f = fixture(t, { config: { e2eeMode: 'optional' },
    cryptoStore: { load: async () => {}, bootstrap() {}, apply() {} }, createCrypto: () => engine,
    cleanup: () => gate.resolve() });
  const starting = f.runtime.start().catch((error) => error);
  await entered.promise;
  let stopped = false;
  const stopping = f.runtime.stop().then(() => { stopped = true; });
  await turn();
  assert.equal(stopped, false);
  gate.resolve();
  await stopping;
  await starting;
  await f.runtime.stop();
  assert.equal(stops, 1);
  assert.equal(f.runtime.status.e2eeActive, false);
});

test('matrix lifecycle stop cancels and drains a blocked incremental poll', { timeout: 5_000 }, async (t) => {
  const f = fixture(t);
  await f.runtime.start();
  await f.pollEntered.promise;
  await Promise.all([f.runtime.stop(), f.runtime.stop()]);
  assert.equal(f.polls[0].signal?.aborted, true);
  assert.equal(f.pending.size, 0);
  assert.equal(f.runtime.status.connectionState, 'idle');
});

test('matrix lifecycle stop waits for a cursor write already in progress', { timeout: 5_000 }, async (t) => {
  const entered = deferred(), gate = deferred();
  const order = [];
  const f = fixture(t, { apply: async (patch) => {
    if (patch.nextBatch !== 'b1') return;
    entered.resolve();
    await gate.promise;
    order.push('write-finished');
  }, cleanup: () => gate.resolve() });
  await f.runtime.start();
  await f.pollEntered.promise;
  f.polls[0].resolve({ next_batch: 'b1' });
  await entered.promise;
  const stopping = f.runtime.stop().then(() => order.push('stopped'));
  await turn();
  assert.deepEqual(order, []);
  gate.resolve();
  await stopping;
  assert.deepEqual(order, ['write-finished', 'stopped']);
});

test('matrix lifecycle stop waits for an admitted room send and preserves its known remote result', { timeout: 5_000 }, async (t) => {
  const entered = deferred(), gate = deferred();
  let signal;
  const f = fixture(t, { sendEvent: (_room, _type, _content, options) => {
    signal = options?.signal; entered.resolve(); return gate.promise;
  }, cleanup: () => gate.resolve({ event_id: '$committed:example.org' }) });
  await f.runtime.start();
  const sending = f.runtime.sendProactiveText({ kind: 'room', route: { roomId: ROOM } }, 'hello');
  await entered.promise;
  let stopped = false;
  const stopping = f.runtime.stop().then(() => { stopped = true; });
  await turn();
  assert.equal(stopped, false);
  assert.equal(signal.aborted, true);
  gate.resolve({ event_id: '$committed:example.org' });
  await stopping;
  assert.deepEqual(await sending, { providerMessageIds: ['$committed:example.org'] });
});

test('matrix lifecycle stop drains an invitation without recording its late join response', { timeout: 5_000 }, async (t) => {
  const entered = deferred(), gate = deferred();
  const invited = '!invited:example.org';
  const f = fixture(t, {
    config: { autoJoinInvites: 'all' },
    initial: { next_batch: 'b0', rooms: { invite: { [invited]: { invite_state: { events: [
      { type: 'm.room.member', sender: '@alice:example.org', content: { membership: 'invite' } },
    ] } } } } },
    joinRoom: () => { entered.resolve(); return gate.promise; },
    cleanup: () => gate.resolve({ room_id: invited }),
  });
  await f.runtime.start();
  await entered.promise;
  let stopped = false;
  const stopping = f.runtime.stop().then(() => { stopped = true; });
  await turn();
  assert.equal(stopped, false);
  gate.resolve({ room_id: invited });
  await stopping;
  assert.equal(f.writes.some((patch) => patch.joinedRooms?.includes(invited)), false);
});

test('matrix lifecycle transient poll failure reports degradation and recovers on the next successful batch', { timeout: 5_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let polls = 0;
  const blocked = deferred();
  const f = fixture(t, { sync: async ({ timeout, signal }) => {
    if (timeout === 0) return { next_batch: 'b0' };
    polls += 1;
    if (polls === 1) throw new MatrixApiError('network unavailable', { code: 'network' });
    if (polls === 2) return { next_batch: 'recovered' };
    if (signal?.aborted) throw signal.reason;
    signal?.addEventListener('abort', () => blocked.reject(signal.reason), { once: true });
    return blocked.promise;
  }, cleanup: () => blocked.resolve({}) });
  await f.runtime.start();
  await f.warned.promise;
  assert.equal(f.runtime.status.ready, false);
  assert.equal(f.runtime.status.connectionState, 'connecting');
  assert.ok(f.runtime.status.lastError);
  t.mock.timers.tick(5_000);
  await turn();
  assert.equal(f.value.nextBatch, 'recovered');
  assert.equal(f.runtime.status.ready, true);
  assert.equal(f.runtime.status.connectionState, 'connected');
  assert.equal(f.runtime.status.lastError, null);
});

test('matrix lifecycle permanent poll failure clears readiness without privately recreating a connection', { timeout: 5_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { sync: async ({ timeout }) => {
    if (timeout === 0) return { next_batch: 'b0' };
    throw new MatrixApiError('token revoked', { code: 'matrix-auth', permanent: true, status: 401 });
  } });
  await f.runtime.start();
  await f.warned.promise;
  assert.equal(f.runtime.status.ready, false);
  assert.equal(f.runtime.status.connectionState, 'failed');
  t.mock.timers.tick(30_000);
  await turn();
  assert.equal(f.creations, 1);
  assert.equal(f.runtime.status.connectionState, 'failed');
});

test('matrix lifecycle reaction timeout cannot release a still-running native removal during stop', { timeout: 10_000 }, async (t) => {
  const entered = deferred(), gate = deferred();
  const f = fixture(t, { config: { reactions: true },
    relations: () => { entered.resolve(); return gate.promise; },
    cleanup: () => gate.resolve({ events: [] }),
  });
  await f.runtime.start();
  await f.pollEntered.promise;
  f.polls[0].resolve({ next_batch: 'reaction', rooms: { join: { [ROOM]: { timeline: { events: [{
    event_id: '$reaction-source:example.org', type: 'm.room.message', sender: '@alice:example.org', origin_server_ts: Date.now(),
    content: { msgtype: 'm.text', body: 'hello <@bot:example.org>' },
  }] } } } } });
  await entered.promise;
  let stopped = false;
  const stopping = f.runtime.stop().then(() => { stopped = true; });
  await f.warned.promise;
  await turn();
  assert.equal(stopped, false, 'the status reaction timeout is not completion of the underlying native request');
  gate.resolve({ events: [] });
  await stopping;
});

test('matrix lifecycle stop aborts an admitted Bridge ask before releasing its send dependencies', { timeout: 5_000 }, async (t) => {
  const entered = deferred(), answer = deferred();
  let aborted = false;
  const f = fixture(t, { ask: async (_id, _text, { signal }) => {
    entered.resolve();
    signal?.addEventListener('abort', () => { aborted = true; answer.reject(signal.reason); }, { once: true });
    return answer.promise;
  }, cleanup: () => answer.resolve('FINAL') });
  await f.runtime.start();
  await f.pollEntered.promise;
  f.polls[0].resolve({ next_batch: 'question', rooms: { join: { [ROOM]: { timeline: { events: [{
    event_id: '$question:example.org', type: 'm.room.message', sender: '@alice:example.org', origin_server_ts: Date.now(),
    content: { msgtype: 'm.text', body: 'hello <@bot:example.org>' },
  }] } } } } });
  await entered.promise;
  await f.runtime.stop();
  assert.equal(aborted, true);
  assert.equal(f.calls.some((call) => call.content?.body === 'FINAL' || call.content?.['m.new_content']?.body === 'FINAL'), false);
  assert.equal(f.pending.size, 0);
});
