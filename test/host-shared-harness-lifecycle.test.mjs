import assert from 'node:assert/strict';
import test from 'node:test';
import { Context, Service } from '@deepseek-ai/cordis';

import { modernHarnessApi } from '../plugin-src/host/modern-harness-api.mjs';
import { harnessPeer } from '../plugin-src/host/harness-peer.mjs';
import { HarnessClient } from '../src/channels/shared/harness-client.mjs';

// The shared adapter and its lifecycle are real. Only the external Host gateway
// and Connection peer are local substitutes; no network or files are involved.
function fixture(t, { withPeer = false } = {}) {
  const root = new Context();
  const records = [];
  const calls = [];
  const peers = [];
  const fibers = [];
  const connection = withPeer ? {
    createPeer(options) {
      const lifetime = new AbortController();
      const peer = {
        ...options,
        signal: lifetime.signal,
        disposals: 0,
        async dispose() {
          peer.disposals += 1;
          lifetime.abort(new DOMException('Fixture peer disposed', 'AbortError'));
        },
      };
      peers.push(peer);
      return peer;
    },
  } : {};
  const gateway = {
    async *stream(request) {
      if (withPeer) assert.equal(request.peer?.signal.aborted, false, 'gateway streams require a live shared peer');
      calls.push(request);
      assert.equal(`${request.namespace}/${request.method}`, 'session/follow');
      yield { type: 'snapshot', cursor: records.at(-1)?.event.seq ?? -1,
        records: [...records], hasMore: false };
    },
    async invoke(request) {
      if (withPeer) assert.equal(request.peer?.signal.aborted, false, 'gateway unary calls require a live shared peer');
      calls.push(request);
      assert.equal(`${request.namespace}/${request.method}`, 'session/page');
      const { throughSeq } = request.args.request;
      return { records: records.filter(({ event }) => event.seq <= throughSeq), hasMore: false };
    },
  };
  root.provide('connection', connection);
  root.provide('typertGateway', gateway);
  t.after(async () => {
    for (const fiber of fibers.toReversed()) await fiber.dispose();
  });
  return {
    root, peers, calls,
    async mount({ peerOnly = false } = {}) {
      let resource;
      const fiber = root.plugin({
        name: `shared-harness-consumer-${fibers.length}`,
        inject: ['connection', 'typertGateway'],
        apply(ctx) {
          resource = peerOnly ? harnessPeer(ctx) : modernHarnessApi(ctx);
          // Repeated acquisition by one consumer must not leave an extra lease.
          assert.equal(peerOnly ? harnessPeer(ctx) : modernHarnessApi(ctx), resource);
        },
      });
      fibers.push(fiber);
      await fiber.await();
      return { fiber, resource };
    },
    append(type, data) {
      const event = { seq: records.length, time: Date.now(), type, data };
      records.push({ type: 'event', event });
      root.emit('session/event', { id: 'session' }, event);
      return event;
    },
    async history(api, rpcId = 'history') {
      const response = await api.sessions.history({ rpcId, payload: { sessionId: 'session' } });
      assert.equal(response.result.ok, true);
      return response.result.value.events.map(({ event }) => event);
    },
  };
}

test('shared Host adapter keeps the surviving consumer history cursor after the first channel unloads', async (t) => {
  const f = fixture(t);
  const first = await f.mount();
  const second = await f.mount();
  assert.equal(first.resource, second.resource);
  assert.deepEqual(await f.history(second.resource), []);

  await first.fiber.dispose();
  f.append('turn/start', { turn: 1 });
  f.append('user/message', { turn: 1, source: { rpcId: 'matrix-prompt' } });
  f.append('assistant/message', { turn: 1, step: 0,
    message: { content: [{ type: 'text', text: 'COMPLETED FINAL' }] } });
  f.append('turn/end', { turn: 1, reason: { kind: 'completed' } });

  const events = await f.history(second.resource, 'after-first-unload');
  assert.deepEqual(events.map(event => event.type), [
    'turn/start', 'user/message', 'assistant/message', 'turn/end',
  ]);
  assert.equal(events[2].data.message.content[0].text, 'COMPLETED FINAL');
  assert.equal(events[3].data.reason.kind, 'completed');
  assert.equal(f.calls.at(-1).args.request.throughSeq, 3);
});

test('shared Host adapter leaves the surviving consumer mux subscribed after the first channel unloads', async (t) => {
  const f = fixture(t);
  const first = await f.mount();
  const second = await f.mount();
  const lifetime = new AbortController();
  const mux = second.resource.events.mux({ rpcId: 'matrix-mux', payload: {} }, lifetime.signal);
  try {
    const pending = mux.next();
    await first.fiber.dispose();
    const event = f.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    const frame = await pending;
    assert.equal(frame.done, false, 'another channel unloading must not close the Matrix mux');
    assert.equal(frame.value.payload.type, 'session/event');
    assert.deepEqual(frame.value.payload.event, event);
  } finally {
    lifetime.abort();
    await mux.return();
  }
});

test('last shared Host adapter consumer release rejects old health and history calls', async (t) => {
  const f = fixture(t);
  const first = await f.mount();
  const second = await f.mount();
  const client = new HarnessClient({ apiProxy: second.resource, interactionScope: f.root,
    workspace: '/workspace', autostart: false });
  assert.equal(await client.health(), true);
  await first.fiber.dispose();
  await second.fiber.dispose();

  await assert.rejects(client.health(), (error) => {
    assert.equal(error.code, 'harness-rpc-rejected');
    assert.equal(error.cause?.code, 'harness-adapter-disposed');
    return true;
  }, 'a disposed adapter must not report a healthy Host');
  await assert.rejects(client.readSessionHistory('session'), { code: 'harness-adapter-disposed' });
  assert.throws(() => second.resource.events.mux({ rpcId: 'disposed-mux', payload: {} }, new AbortController().signal),
    (error) => error.failure?.code === 'harness-adapter-disposed');
  await assert.rejects(second.resource.respond({ rpcId: 'disposed-reply', result: { ok: true, value: {} } }),
    (error) => error.failure?.code === 'harness-adapter-disposed');
});

test('a new consumer after the final release gets a fresh adapter and complete history', async (t) => {
  const f = fixture(t);
  const first = await f.mount();
  const second = await f.mount();
  await first.fiber.dispose();
  await second.fiber.dispose();
  f.append('turn/end', { turn: 1, reason: { kind: 'completed' } });

  const reloaded = await f.mount();
  assert.notEqual(reloaded.resource, first.resource);
  assert.deepEqual((await f.history(reloaded.resource)).map(event => event.type), ['turn/end']);
});

test('shared adapter and direct command consumers retain the same live peer independently', async (t) => {
  const f = fixture(t, { withPeer: true });
  const command = await f.mount({ peerOnly: true });
  const adapter = await f.mount();
  assert.equal(f.peers.length, 1);
  assert.deepEqual(await f.history(adapter.resource), []);
  assert.equal(f.calls.at(-1).peer, command.resource);

  await command.fiber.dispose();
  assert.equal(command.resource.signal.aborted, false);
  f.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  assert.deepEqual((await f.history(adapter.resource)).map(event => event.type), ['turn/end']);
  assert.equal(f.calls.at(-1).peer, command.resource);
  await adapter.fiber.dispose();
  assert.equal(command.resource.signal.aborted, true);
  assert.equal(command.resource.disposals, 1);
});

// Match the Host Connection contract: reading a Cordis Service binds this.ctx
// to that reader, and createPeer installs an automatically reader-owned lifetime.
// A plain root.provide({ createPeer() {} }) substitute cannot expose this edge.
class ReaderOwnedConnection extends Service {
  constructor(ctx) {
    super(ctx, 'connection');
  }

  createPeer(options) {
    const lifetime = new AbortController();
    const peer = { ...options, signal: lifetime.signal, disposals: 0 };
    peer.dispose = this.ctx.effect(() => () => {
      peer.disposals += 1;
      lifetime.abort(new DOMException('Reader-owned peer disposed', 'AbortError'));
    }, 'fixture: reader-owned Peer lifetime');
    return peer;
  }
}

test('shared peer survives the first reader unloading with a real Cordis Service owner', async (t) => {
  const root = new Context();
  t.after(() => root.fiber.dispose());
  const provider = root.plugin(ctx => { new ReaderOwnedConnection(ctx); });
  await provider.await();
  let firstPeer;
  let secondPeer;
  const first = root.plugin({
    name: 'reader-owned-peer-first', inject: ['connection'],
    apply(ctx) { firstPeer = harnessPeer(ctx); },
  });
  await first.await();
  const second = root.plugin({
    name: 'reader-owned-peer-second', inject: ['connection'],
    apply(ctx) { secondPeer = harnessPeer(ctx); },
  });
  await second.await();
  assert.equal(firstPeer, secondPeer);
  assert.equal(secondPeer.signal.aborted, false);

  await first.dispose();
  assert.equal(secondPeer.signal.aborted, false,
    'the Connection must create the shared Peer under a shared owner, not its first reader');
  assert.equal(secondPeer.disposals, 0);
  await second.dispose();
  assert.equal(secondPeer.signal.aborted, true);
  assert.equal(secondPeer.disposals, 1);
});

test('shared Harness peer stays alive until its last consumer and is replaced on reload', async (t) => {
  const f = fixture(t, { withPeer: true });
  const first = await f.mount({ peerOnly: true });
  const second = await f.mount({ peerOnly: true });
  assert.equal(first.resource, second.resource);
  assert.equal(f.peers.length, 1);

  await first.fiber.dispose();
  assert.equal(second.resource.signal.aborted, false, 'the first channel cannot dispose a peer still used by another channel');
  assert.equal(second.resource.disposals, 0);
  await second.fiber.dispose();
  assert.equal(second.resource.signal.aborted, true);
  assert.equal(second.resource.disposals, 1, 'repeated per-context lookups must not leak leases or double-dispose');

  const reloaded = await f.mount({ peerOnly: true });
  assert.notEqual(reloaded.resource, second.resource);
  assert.equal(reloaded.resource.signal.aborted, false);
  assert.equal(f.peers.length, 2);
});
