import test from 'node:test';
import assert from 'node:assert/strict';
import { controllerFixture, runtimeStub } from './fixtures/controller-fixture.mjs';

const turn = () => new Promise(setImmediate);
function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}
const bindArgs = (accessToken) => ({ homeserver: 'https://matrix.example.org', accessToken });
const inspected = async () => ({ homeserver: 'https://matrix.example.org', userId: '@bot:example.org',
  platformId: 'matrix.example.org|@bot:example.org', deviceId: 'DEVICE', name: 'verified' });

// A dropped runtime result loses event bindings even though the provider accepted the message.
test('matrix send controller preserves the runtime proactive message IDs', async (t) => {
  const fixture = await controllerFixture(t);
  await fixture.controller.initialize();
  const result = await fixture.controller.sendProactiveText(fixture.identity.botId,
    { kind: 'room', route: { roomId: '!r:example.org' } }, 'hello');
  assert.deepEqual(result, { providerMessageIds: ['$controller-send:example.org'] });
});

test('matrix controller unreadable rollback snapshots never authorize credential replacement', async (t) => {
  const f = await controllerFixture(t, { inspectCredentials: inspected });
  f.credentials.resolve = async () => { throw new Error('credential store unavailable'); };
  await assert.rejects(f.controller.bindCredentials(bindArgs('new-token')), (error) => error.code === 'matrix-credentials-unavailable');
  assert.equal(f.secrets.get(f.identity.tokenRef), 'fixture-token');
  assert.equal(f.runtimes.length, 0);
});

test('matrix controller rebinding preserves configured room policy and encryption mode', async (t) => {
  const f = await controllerFixture(t, { inspectCredentials: inspected });
  await f.configStore.save({ ...f.configStore.get(f.identity.botId), e2eeMode: 'off', allowedRooms: ['!private:example.org'] });
  await f.controller.bindCredentials(bindArgs('new-token'));
  const saved = f.configStore.get(f.identity.botId);
  assert.equal(saved.e2eeMode, 'off');
  assert.deepEqual(saved.allowedRooms, ['!private:example.org']);
});

test('matrix controller serializes credential writes and rollback with the later binding', async (t) => {
  const entered = deferred(), gate = deferred();
  let first, second;
  const f = await controllerFixture(t, { inspectCredentials: inspected,
    cleanup: async () => { gate.resolve(); await first; await second; } });
  const set = f.credentials.set;
  f.credentials.set = async (ref, value) => {
    if (value === 'token-A') { entered.resolve(); await gate.promise; throw new Error('first write failed'); }
    return set(ref, value);
  };
  first = f.controller.bindCredentials(bindArgs('token-A')).catch((error) => error);
  await entered.promise;
  second = f.controller.bindCredentials(bindArgs('token-B')).catch((error) => error);
  await turn();
  assert.equal(f.secrets.get(f.identity.tokenRef), 'fixture-token', 'the later bind cannot mutate credentials before the first rollback');
  gate.resolve();
  assert.ok(await first instanceof Error);
  assert.equal((await second).botId, f.identity.botId);
  assert.equal(f.secrets.get(f.identity.tokenRef), 'token-B');
  assert.equal(f.controller.status().ready, true);
});

test('matrix controller retains a runtime whose first poll is already retrying when startup resolves', async (t) => {
  const runtime = runtimeStub({ async start() { Object.assign(this.status, { ready: false, connectionState: 'connecting', harnessReachable: false }); } });
  const f = await controllerFixture(t, { createRuntime: () => runtime });
  await f.controller.initialize();
  await f.controller.initialize();
  assert.equal(f.runtimes.length, 1);
  assert.equal(runtime.stops, 0);
  assert.equal(f.controller.status().ready, false);
});

test('matrix controller close drains a paused factory and never starts its late runtime', async (t) => {
  const entered = deferred(), gate = deferred();
  const runtime = runtimeStub();
  let initializing, closing;
  const f = await controllerFixture(t, {
    createRuntime: async () => { entered.resolve(); return gate.promise; },
    cleanup: async () => { gate.resolve(runtime); await initializing; await closing; },
  });
  initializing = f.controller.initialize();
  await entered.promise;
  let closed = false;
  closing = f.controller.close().then(() => { closed = true; });
  await turn();
  assert.equal(closed, false);
  gate.resolve(runtime);
  await Promise.all([initializing, closing]);
  assert.equal(runtime.starts, 0);
  assert.equal(runtime.stops, 1);
  assert.equal(f.controller.status().ready, false);
});

test('matrix controller repeated close waits for the same resource drain', async (t) => {
  const gate = deferred();
  const runtime = runtimeStub({ async stop() { this.stops += 1; await gate.promise; this.status.ready = false; } });
  let first, second;
  const f = await controllerFixture(t, { createRuntime: () => runtime,
    cleanup: async () => { gate.resolve(); await first; await second; } });
  await f.controller.initialize();
  let closed = 0;
  first = f.controller.close().then(() => { closed += 1; });
  second = f.controller.close().then(() => { closed += 1; });
  await turn();
  assert.equal(closed, 0);
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(runtime.stops, 1);
});

test('matrix controller close cancels startup before waiting for its transition', async (t) => {
  const entered = deferred(), canceled = deferred();
  const runtime = runtimeStub({
    async start() { entered.resolve(); await canceled.promise; throw new DOMException('stopped', 'AbortError'); },
    async stop() { this.stops += 1; canceled.resolve(); },
  });
  const f = await controllerFixture(t, { createRuntime: () => runtime, cleanup: () => canceled.resolve() });
  const initializing = f.controller.initialize();
  await entered.promise;
  await f.controller.close();
  await initializing;
  assert.equal(f.controller.status().ready, false);
});

test('matrix controller inspection completing after close cannot record credentials', async (t) => {
  const entered = deferred(), gate = deferred();
  let binding;
  const f = await controllerFixture(t, { inspectCredentials: async () => { entered.resolve(); return gate.promise; },
    cleanup: async () => { gate.resolve(await inspected()); await binding; } });
  binding = f.controller.bindCredentials(bindArgs('late-token')).catch((error) => error);
  await entered.promise;
  await f.controller.close();
  gate.resolve(await inspected());
  assert.equal((await binding).code, 'matrix-controller-closed');
  assert.equal(f.secrets.get(f.identity.tokenRef), 'fixture-token');
  assert.equal(f.runtimes.length, 0);
});

test('matrix controller queues deletion behind an admitted credential transaction', async (t) => {
  const entered = deferred(), gate = deferred();
  let binding, deletion;
  const f = await controllerFixture(t, { inspectCredentials: inspected,
    cleanup: async () => { gate.resolve(); await binding; await deletion; } });
  const set = f.credentials.set;
  f.credentials.set = async (ref, value) => {
    if (value === 'new-token') { entered.resolve(); await gate.promise; }
    await set(ref, value);
  };
  binding = f.controller.bindCredentials(bindArgs('new-token'));
  await entered.promise;
  deletion = f.controller.deleteBot(f.identity.botId);
  await turn();
  assert.ok(f.configStore.get(f.identity.botId));
  gate.resolve();
  await binding;
  assert.equal(await deletion, true);
  assert.equal(f.configStore.get(f.identity.botId), null);
  assert.equal(f.secrets.has(f.identity.tokenRef), false);
});

test('matrix controller failed stop cannot authorize deleting live credential or key state', async (t) => {
  let stateDeletes = 0, stopFailed = false;
  const runtime = runtimeStub({ async stop() {
    if (!stopFailed) { stopFailed = true; throw new Error('still stopping'); }
    this.status.ready = false;
  } });
  const f = await controllerFixture(t, { createRuntime: () => runtime, deleteState: async () => { stateDeletes += 1; } });
  await f.controller.initialize();
  await assert.rejects(f.controller.deleteBot(f.identity.botId), (error) => error.code === 'matrix-cleanup-failed' && error.removed === false);
  assert.equal(stateDeletes, 0);
  assert.ok(f.configStore.get(f.identity.botId));
  assert.equal(f.secrets.get(f.identity.tokenRef), 'fixture-token');
});

test('matrix controller partial deletion attempts every cleanup and reports removed configuration', async (t) => {
  const attempts = [];
  const f = await controllerFixture(t, { deleteState: async () => { attempts.push('state'); throw new Error('state delete failed'); } });
  const unset = f.credentials.unset;
  f.credentials.unset = async (ref) => {
    attempts.push(ref);
    if (ref === f.identity.passwordRef) throw new Error('password delete failed');
    await unset(ref);
  };
  await assert.rejects(f.controller.deleteBot(f.identity.botId), (error) => {
    assert.equal(error.code, 'matrix-cleanup-failed');
    assert.equal(error.removed, true);
    assert.ok(error.cause instanceof AggregateError);
    return true;
  });
  assert.deepEqual(attempts, ['state', f.identity.tokenRef, f.identity.passwordRef]);
  assert.equal(f.configStore.get(f.identity.botId), null);
  assert.equal(f.secrets.has(f.identity.tokenRef), false);
});

test('matrix controller failed credential restoration is visible and prevents automatic reuse', async (t) => {
  const f = await controllerFixture(t, { inspectCredentials: inspected });
  await f.controller.initialize();
  const set = f.credentials.set, unset = f.credentials.unset;
  let firstUnset = true;
  f.credentials.set = async (ref, value) => {
    if (value === 'fixture-token') throw new Error('rollback write failed');
    await set(ref, value);
  };
  f.credentials.unset = async (ref) => {
    if (firstUnset) { firstUnset = false; throw new Error('credential update failed'); }
    await unset(ref);
  };
  await assert.rejects(f.controller.bindCredentials(bindArgs('new-token')), (error) => error.code === 'matrix-bind-rollback-failed');
  assert.equal(f.controller.status().ready, false);
  await f.controller.initialize();
  assert.equal(f.runtimes.length, 1, 'the supervisor cannot revive untrusted credential state');
  assert.equal(f.controller.status().bots[0].lastError.code, 'matrix-bind-rollback-failed');
});

test('matrix controller refuses replacement when the old runtime failed to stop', async (t) => {
  let failed = false;
  const runtime = runtimeStub({ async stop() {
    this.stops += 1;
    if (!failed) { failed = true; throw new Error('stop failed'); }
    this.status.ready = false;
  } });
  const f = await controllerFixture(t, { createRuntime: () => runtime });
  await f.controller.initialize();
  await assert.rejects(f.controller.reconnectBot(f.identity.botId), /stop failed/);
  assert.equal(f.runtimes.length, 1);
  assert.equal(f.controller.status().ready, false);
});
