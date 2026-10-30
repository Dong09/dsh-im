import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  OUTBOUND_ARTIFACT_TOOL,
  OutboundArtifactRegistry,
  createOutboundArtifactTool,
  isManagedOutboundArtifact,
  materializeOutboundArtifact,
  outboundArtifactRegistry,
  releaseOutboundArtifact,
} from '../src/channels/shared/semantic/artifact.mjs';
import { HarnessClient } from '../src/channels/shared/harness-client.mjs';

const SESSION_ID = 'session-copy-race';
const RPC_ID = 'rpc-copy-race';
const TURN = 7;

const races = [
  ['the tool execution is aborted', ({ controller }) => {
    controller.abort(new DOMException('File return cancelled', 'AbortError'));
  }, { name: 'AbortError' }],
  ['the consumer is released', ({ releaseConsumer }) => releaseConsumer()],
  ['the session is disposed', ({ registry, session }) => registry.disposeSession(session)],
  ['the registry is cleared', ({ registry }) => registry.clear()],
  ['the turn ends with a stale session snapshot', ({ registry, session }) => {
    registry.observeSessionEvent(session, { type: 'turn/end', data: { turn: TURN } });
  }],
  ['a new turn starts', ({ registry, session }) => {
    registry.openConsumer(SESSION_ID, 'rpc-next-turn');
    registry.observeSessionEvent(session, { type: 'turn/start', data: { turn: TURN + 1 } });
    registry.observeSessionEvent(session, {
      type: 'user/message',
      data: { turn: TURN + 1, source: { rpcId: 'rpc-next-turn' } },
    });
  }],
  ['another consumer replaces the same session, turn and request', ({ registry, session }) => {
    registry.openConsumer(SESSION_ID, RPC_ID);
    registry.observeSessionEvent(session, {
      type: 'user/message',
      data: { turn: TURN, source: { rpcId: RPC_ID } },
    });
  }],
];

// These tests run sequentially because the copyFile hook updates a built-in ESM
// binding. It pauses after a real copy, so cleanup must remove an actual file.
for (const [name, invalidateConsumer, expectedError = { code: 'artifact-consumer-required' }] of races) {
  test(`a pending file snapshot is removed when ${name}`, async (t) => {
    const workspace = await fs.mkdtemp(join(tmpdir(), 'dsh-im-consumer-race-'));
    const sourcePath = join(workspace, 'result.txt');
    const content = Buffer.from('Keep the original result file intact.\n');
    const registry = new OutboundArtifactRegistry();
    const controller = new AbortController();
    const session = {
      header: { id: SESSION_ID, cwd: workspace },
      events: [
        { type: 'turn/start', data: { turn: TURN } },
        { type: 'user/message', data: { turn: TURN, source: { rpcId: RPC_ID } } },
      ],
    };
    const releaseConsumer = registry.openConsumer(SESSION_ID, RPC_ID);
    for (const event of session.events) registry.observeSessionEvent(session, event);
    await fs.writeFile(sourcePath, content);

    const copied = Promise.withResolvers();
    const resume = Promise.withResolvers();
    const copyFile = fs.copyFile;
    let snapshotPath;
    let staging;
    const copyMock = t.mock.method(fs, 'copyFile', async (...args) => {
      await copyFile(...args);
      snapshotPath = args[1];
      copied.resolve();
      await resume.promise;
    });
    syncBuiltinESMExports();

    try {
      staging = registry.stage({ path: 'result.txt' }, {
        agent: { session },
        callId: 'call-copy-race',
        signal: controller.signal,
      });
      await Promise.race([
        copied.promise,
        staging.then(() => assert.fail('stage completed before its snapshot copy was paused')),
      ]);
      assert.notEqual(snapshotPath, sourcePath);
      assert.deepEqual(await fs.readFile(snapshotPath), content);

      invalidateConsumer({ registry, session, releaseConsumer, controller });
      resume.resolve();

      await assert.rejects(staging, expectedError);
      await assert.rejects(fs.stat(snapshotPath), { code: 'ENOENT' });
      assert.deepEqual(await fs.readFile(sourcePath), content);
      assert.deepEqual(registry.take(SESSION_ID, TURN), []);
      assert.deepEqual(registry.take(SESSION_ID, TURN + 1), []);
    } finally {
      resume.resolve();
      await staging?.catch(() => undefined);
      copyMock.mock.restore();
      syncBuiltinESMExports();
      releaseConsumer();
      registry.clear();
      if (snapshotPath) await fs.rm(snapshotPath, { force: true });
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
}

async function scheduledFixture(t, { observe = true } = {}) {
  const workspace = await fs.mkdtemp(join(tmpdir(), 'dsh-im-turn-consumer-'));
  const registry = new OutboundArtifactRegistry();
  const session = {
    header: { id: SESSION_ID, cwd: workspace },
    events: [
      { type: 'turn/start', data: { turn: TURN } },
      { type: 'user/message', data: {
        turn: TURN,
        source: { kind: 'schedule', scheduleId: 'native-schedule' },
        message: { id: 'scheduled-input' },
      } },
    ],
  };
  const source = session.events[1].data.source;
  await fs.writeFile(join(workspace, 'original image.png'), 'original image bytes');
  if (observe) for (const event of session.events) registry.observeSessionEvent(session, event);
  t.after(async () => {
    registry.clear();
    await fs.rm(workspace, { recursive: true, force: true });
  });
  const append = (type, data) => {
    const event = { type, data };
    session.events.push(event);
    registry.observeSessionEvent(session, event);
  };
  const exec = (callId = 'scheduled-file', overrides = {}) => ({
    name: OUTBOUND_ARTIFACT_TOOL,
    agent: { session },
    callId,
    token: Symbol(callId),
    ...overrides,
  });
  const stage = () => registry.stage({ path: 'original image.png' }, exec());
  const commit = async () => {
    const artifact = await stage();
    assert.ok(registry.commit(artifact));
    return artifact;
  };
  const claimRpc = (rpcId) => registry.observeClaimedMessage(session, { source: { rpcId } }, TURN);
  return { workspace, registry, session, source, append, exec, stage, commit, claimRpc };
}

async function assertSnapshot(artifact, expected = 'original image bytes') {
  assert.equal(isManagedOutboundArtifact(artifact), true);
  const file = await materializeOutboundArtifact(artifact);
  assert.equal(file.fileName, 'original image.png');
  assert.equal(file.bytes.toString(), expected);
}

test('an observed native schedule registers without an rpcId and retains files through turn/end', async (t) => {
  const fx = await scheduledFixture(t);
  const sourceBefore = structuredClone(fx.source);
  const lease = fx.registry.openTurnConsumer(SESSION_ID, TURN);
  assert.ok(lease);
  assert.equal(Object.isFrozen(lease), true);
  assert.deepEqual(Object.keys(lease).sort(), ['active', 'close', 'take']);
  assert.equal(lease.active, true);
  assert.equal(fx.registry.hasActiveConsumer(fx.session), true);
  const tool = createOutboundArtifactTool({ registry: fx.registry });
  assert.deepEqual(Object.keys(tool.definition.parameters.properties), ['path']);
  const exec = fx.exec();
  const result = await tool.definition.execute({ path: 'original image.png' }, exec);
  assert.equal(result.fileName, 'original image.png');
  assert.deepEqual(lease.take(), [], 'stage alone is not successful registration');
  tool.onResult(exec, { isError: false });
  assert.deepEqual(fx.registry.take(SESSION_ID, TURN), [], 'legacy RPC take cannot borrow a lease');
  assert.deepEqual(fx.registry.take(SESSION_ID, TURN, { promptRpcId: RPC_ID }), []);
  fx.registry.discard(SESSION_ID, TURN, { promptRpcId: RPC_ID });

  fx.append('turn/end', { turn: TURN, reason: { kind: 'completed' } });
  assert.equal(fx.registry.hasActiveConsumer(fx.session), false);
  assert.equal(lease.active, true, 'turn/end retains the lease until handoff');
  const [artifact] = lease.take();
  assert.equal(artifact.artifactId, result.artifactId);
  assert.deepEqual(artifact.origin, { sessionId: SESSION_ID, turn: TURN, callId: exec.callId });
  assert.equal(Object.hasOwn(artifact.origin, 'rpcId'), false);
  assert.deepEqual(fx.source, sourceBefore, 'authorization must not forge an RPC source');
  lease.close();
  lease.close();
  assert.equal(lease.active, false);
  assert.deepEqual(lease.take(), []);
  await assertSnapshot(artifact);
  releaseOutboundArtifact(artifact);
  assert.equal(isManagedOutboundArtifact(artifact), false);
  assert.equal(await fs.readFile(join(fx.workspace, 'original image.png'), 'utf8'), 'original image bytes');
});

test('turn leases require the observed current turn and reject duplicate, ended and disposed admission', async (t) => {
  const fx = await scheduledFixture(t, { observe: false });
  assert.equal(fx.registry.openTurnConsumer(SESSION_ID, TURN), null, 'a Session snapshot alone is not admission');
  fx.registry.observeSessionEvent(fx.session, fx.session.events[0]);
  for (const [sessionId, turn] of [
    ['', TURN], [SESSION_ID, -1], [SESSION_ID, 1.5], ['other-session', TURN],
    [SESSION_ID, TURN - 1], [SESSION_ID, TURN + 1],
  ]) assert.equal(fx.registry.openTurnConsumer(sessionId, turn), null);
  const lease = fx.registry.openTurnConsumer(SESSION_ID, TURN);
  assert.ok(lease);
  assert.equal(fx.registry.openTurnConsumer(SESSION_ID, TURN), null);
  fx.append('turn/end', { turn: TURN });
  assert.equal(fx.registry.openTurnConsumer(SESSION_ID, TURN), null);
  lease.close();
  assert.equal(fx.registry.openTurnConsumer(SESSION_ID, TURN), null);
  fx.append('turn/start', { turn: TURN + 1 });
  const next = fx.registry.openTurnConsumer(SESSION_ID, TURN + 1);
  assert.ok(next);
  fx.registry.disposeSession(fx.session);
  assert.equal(next.active, false);
  // Even a stale event/claim continuation after disposal cannot resurrect it.
  fx.registry.observeSessionEvent(fx.session, { type: 'turn/start', data: { turn: TURN + 1 } });
  fx.registry.observeClaimedMessage(fx.session, { source: { rpcId: RPC_ID } }, TURN + 1);
  assert.equal(fx.registry.openTurnConsumer(SESSION_ID, TURN + 1), null);
});

test('a scheduled lease never replaces an ordinary owner and pending RPCs keep their queue semantics', async (t) => {
  const fx = await scheduledFixture(t);
  const closeFirst = fx.registry.openConsumer(SESSION_ID, 'ordinary-first');
  const closeQueued = fx.registry.openConsumer(SESSION_ID, 'ordinary-queued');
  fx.claimRpc('ordinary-first');
  const artifact = await fx.commit();
  assert.equal(fx.registry.openTurnConsumer(SESSION_ID, TURN), null);
  closeQueued();
  assert.deepEqual(fx.registry.take(SESSION_ID, TURN, { promptRpcId: 'ordinary-queued' }), []);
  assert.deepEqual(fx.registry.take(SESSION_ID, TURN, { promptRpcId: 'ordinary-first' }), [artifact]);
  closeFirst();
  await assertSnapshot(artifact);
  releaseOutboundArtifact(artifact);
});

test('only a real ordinary claim revokes a schedule and isolates late commit, take, discard and close', async (t) => {
  const fx = await scheduledFixture(t);
  const lease = fx.registry.openTurnConsumer(SESSION_ID, TURN);
  const closeRpc = fx.registry.openConsumer(SESSION_ID, RPC_ID);
  const committed = await fx.commit();
  const staged = await fx.stage();
  assert.equal(lease.active, true, 'an unclaimed future ordinary RPC does not revoke the current schedule');
  fx.claimRpc(RPC_ID);
  assert.equal(lease.active, false);
  assert.equal(isManagedOutboundArtifact(staged), false);
  assert.equal(isManagedOutboundArtifact(committed), false);
  const ordinary = await fx.commit();

  assert.equal(fx.registry.commit(staged), null);
  assert.deepEqual(lease.take(), []);
  lease.close();
  lease.close();
  fx.registry.release(staged);
  fx.registry.discard(SESSION_ID, TURN, { promptRpcId: 'not-the-owner' });
  assert.deepEqual(fx.registry.take(SESSION_ID, TURN, { promptRpcId: 'not-the-owner' }), []);
  assert.deepEqual(fx.registry.take(SESSION_ID, TURN, { promptRpcId: RPC_ID }), [ordinary]);
  closeRpc();
  await assertSnapshot(ordinary);
  releaseOutboundArtifact(ordinary);
  for (const old of [staged, committed]) {
    await assert.rejects(materializeOutboundArtifact(old), { code: 'artifact-invalid' });
  }
});

test('lease take is bound to its original session and turn while independent turns remain live', async (t) => {
  const fx = await scheduledFixture(t);
  const first = fx.registry.openTurnConsumer(SESSION_ID, TURN);
  const firstArtifact = await fx.commit();
  fx.append('turn/end', { turn: TURN });
  fx.append('turn/start', { turn: TURN + 1 });
  const next = fx.registry.openTurnConsumer(SESSION_ID, TURN + 1);
  const nextArtifact = await fx.commit();
  const otherSession = { header: { id: 'other-session', cwd: fx.workspace } };
  fx.registry.observeSessionEvent(otherSession, { type: 'turn/start', data: { turn: TURN } });
  const other = fx.registry.openTurnConsumer('other-session', TURN);
  const otherArtifact = await fx.registry.stage({ path: 'original image.png' }, {
    agent: { session: otherSession }, callId: 'other-file',
  });
  fx.registry.commit(otherArtifact);

  assert.deepEqual(first.take.call(other, { sessionId: 'other-session', turn: TURN + 1 }), [firstArtifact]);
  first.close();
  assert.equal(next.active, true);
  assert.equal(other.active, true);
  assert.deepEqual(first.take(), []);
  assert.deepEqual(next.take({ sessionId: SESSION_ID, turn: TURN }), [nextArtifact]);
  assert.deepEqual(other.take(), [otherArtifact]);
  next.close();
  other.close();
  for (const artifact of [firstArtifact, nextArtifact, otherArtifact]) {
    await assertSnapshot(artifact);
    releaseOutboundArtifact(artifact);
  }
});

test('closing a lease is idempotent and releases both staged and committed unclaimed snapshots', async (t) => {
  const fx = await scheduledFixture(t);
  const lease = fx.registry.openTurnConsumer(SESSION_ID, TURN);
  const staged = await fx.stage();
  const committed = await fx.commit();
  lease.close();
  lease.close();
  assert.equal(lease.active, false);
  assert.equal(fx.registry.commit(staged), null);
  assert.deepEqual(lease.take(), []);
  assert.equal(fx.registry.hasActiveConsumer(fx.session), false);
  for (const artifact of [staged, committed]) {
    assert.equal(isManagedOutboundArtifact(artifact), false);
    await assert.rejects(materializeOutboundArtifact(artifact), { code: 'artifact-invalid' });
  }
});

test('a revoked lease claim signal and close cannot release a successor owner in the same turn', async (t) => {
  const fx = await scheduledFixture(t);
  const lease = fx.registry.openTurnConsumer(SESSION_ID, TURN);
  const old = await fx.commit();
  const controller = new AbortController();
  assert.deepEqual(lease.take({ signal: controller.signal }), [old]);
  const closeRpc = fx.registry.openConsumer(SESSION_ID, RPC_ID);
  fx.claimRpc(RPC_ID);
  const ordinary = await fx.commit();
  assert.deepEqual(fx.registry.take(SESSION_ID, TURN, { promptRpcId: RPC_ID }), [ordinary]);
  lease.close();
  controller.abort();
  assert.equal(isManagedOutboundArtifact(old), false);
  await assertSnapshot(ordinary);
  closeRpc();
  releaseOutboundArtifact(ordinary);
});

for (const reusePromptId of [false, true]) {
  test(`old ordinary cleanup is isolated from a replacement ${reusePromptId ? 'with the same prompt id' : 'with a different prompt id'}`, async (t) => {
    const fx = await scheduledFixture(t);
    const closeFirst = fx.registry.openConsumer(SESSION_ID, RPC_ID);
    fx.claimRpc(RPC_ID);
    const staged = await fx.stage();
    const rpcId = reusePromptId ? RPC_ID : 'replacement-rpc';
    const closeNext = fx.registry.openConsumer(SESSION_ID, rpcId);
    fx.claimRpc(rpcId);
    const replacement = await fx.commit();
    closeFirst();
    assert.equal(fx.registry.commit(staged), null);
    if (!reusePromptId) {
      fx.registry.discard(SESSION_ID, TURN, { promptRpcId: RPC_ID });
      assert.deepEqual(fx.registry.take(SESSION_ID, TURN, { promptRpcId: RPC_ID }), []);
    }
    assert.deepEqual(fx.registry.take(SESSION_ID, TURN, { promptRpcId: rpcId }), [replacement]);
    closeNext();
    await assertSnapshot(replacement);
    releaseOutboundArtifact(replacement);
  });
}

const scheduleRaces = [
  ['lease close', ({ lease }) => lease.close()],
  ['ordinary input takeover', ({ registry, claimRpc }) => {
    registry.openConsumer(SESSION_ID, RPC_ID);
    claimRpc(RPC_ID);
  }],
  ['session disposal', ({ registry, session }) => registry.disposeSession(session)],
  ['registry shutdown', ({ registry }) => registry.clear()],
  ['turn end', ({ append }) => append('turn/end', { turn: TURN })],
  ['next turn', ({ append }) => append('turn/start', { turn: TURN + 1 })],
  ['tool cancellation', ({ controller }) => controller.abort(), { name: 'AbortError' }],
];

for (const [name, revoke, expected = { code: 'artifact-consumer-required' }] of scheduleRaces) {
  test(`a real schedule snapshot paused after copying leaves no file after ${name}`, async (t) => {
    const fx = await scheduledFixture(t);
    const lease = fx.registry.openTurnConsumer(SESSION_ID, TURN);
    const controller = new AbortController();
    const copied = Promise.withResolvers();
    const resume = Promise.withResolvers();
    const originalCopy = fs.copyFile;
    let snapshotPath;
    let staging;
    const mock = t.mock.method(fs, 'copyFile', async (...args) => {
      await originalCopy(...args);
      snapshotPath = args[1];
      copied.resolve();
      await resume.promise;
    });
    syncBuiltinESMExports();
    try {
      staging = fx.registry.stage({ path: 'original image.png' }, fx.exec('copy-revoked', { signal: controller.signal }));
      await copied.promise;
      assert.equal(await fs.readFile(snapshotPath, 'utf8'), 'original image bytes');
      revoke({ ...fx, lease, controller });
      resume.resolve();
      await assert.rejects(staging, expected);
      await assert.rejects(fs.stat(snapshotPath), { code: 'ENOENT' });
      assert.deepEqual(lease.take(), []);
      assert.deepEqual(fx.registry.take(SESSION_ID, TURN, { promptRpcId: RPC_ID }), []);
      assert.equal(await fs.readFile(join(fx.workspace, 'original image.png'), 'utf8'), 'original image bytes');
    } finally {
      resume.resolve();
      await staging?.catch(() => undefined);
      mock.mock.restore();
      syncBuiltinESMExports();
      lease.close();
      if (snapshotPath) await fs.rm(snapshotPath, { force: true });
    }
  });
}

test('a late ordinary user event for an older turn cannot take over the current scheduled owner', async (t) => {
  const fx = await scheduledFixture(t);
  t.after(fx.registry.openConsumer(SESSION_ID, RPC_ID));
  fx.append('turn/start', { turn: TURN + 1 });
  const lease = fx.registry.openTurnConsumer(SESSION_ID, TURN + 1);
  const artifact = await fx.commit();
  fx.registry.observeSessionEvent(fx.session, {
    type: 'user/message', data: { turn: TURN, source: { rpcId: RPC_ID } },
  });
  assert.equal(lease.active, true);
  assert.deepEqual(fx.registry.take(SESSION_ID, TURN + 1, { promptRpcId: RPC_ID }), []);
  assert.deepEqual(lease.take(), [artifact]);
  lease.close();
  await assertSnapshot(artifact);
  releaseOutboundArtifact(artifact);
});

for (const takeover of [false, true]) {
  test(`HarnessClient ${takeover ? 'cannot take or discard a successor RPC owner' : 'takes files with its exact promptRpcId'}`, async (t) => {
    outboundArtifactRegistry.clear();
    t.after(() => outboundArtifactRegistry.clear());
    const workspace = await fs.mkdtemp(join(tmpdir(), 'dsh-im-client-owner-'));
    t.after(() => fs.rm(workspace, { recursive: true, force: true }));
    await fs.writeFile(join(workspace, 'result.txt'), 'ordinary result');
    const session = { header: { id: 'client-owner-session', cwd: workspace }, events: [] };
    const client = new HarnessClient({ apiProxy: {}, workspace });
    client.ensureRunning = async () => undefined;
    let promptRpcId;
    let original;
    let successor;
    const take = outboundArtifactRegistry.take.bind(outboundArtifactRegistry);
    const discard = outboundArtifactRegistry.discard.bind(outboundArtifactRegistry);
    const takeCalls = [];
    const discardCalls = [];
    t.mock.method(outboundArtifactRegistry, 'take', (...args) => { takeCalls.push(args); return take(...args); });
    t.mock.method(outboundArtifactRegistry, 'discard', (...args) => { discardCalls.push(args); return discard(...args); });
    const append = (type, data) => {
      const event = { type, data, seq: session.events.length + 1 };
      session.events.push(event);
      outboundArtifactRegistry.observeSessionEvent(session, event);
    };
    const register = async () => {
      const artifact = await outboundArtifactRegistry.stage({ path: 'result.txt' }, { agent: { session } });
      outboundArtifactRegistry.commit(artifact);
      return artifact;
    };
    client.rpc = async (method, _payload, _timeoutMs, options) => {
      if (method === 'workspace.list') return { items: [], archivedSessionIds: [] };
      if (method === 'session.history') return { events: session.events.map((event) => ({ event })) };
      assert.equal(method, 'session.prompt');
      promptRpcId = options.rpcId;
      append('turn/start', { turn: 1 });
      append('user/message', { turn: 1, source: { rpcId: promptRpcId } });
      original = await register();
      if (takeover) {
        t.after(outboundArtifactRegistry.openConsumer(session.header.id, 'successor-rpc'));
        append('user/message', { turn: 1, source: { rpcId: 'successor-rpc' } });
        await fs.writeFile(join(workspace, 'result.txt'), 'successor bytes');
        successor = await register();
      }
      append('assistant/message', { turn: 1, step: 0, message: { content: [{ type: 'text', text: 'done' }] } });
      append('turn/end', { turn: 1, reason: { kind: 'completed' } });
      return {};
    };
    const delivered = [];
    assert.equal(await client.ask(session.header.id, 'return result', {
      onArtifact: async (artifact) => { delivered.push(artifact); },
    }), 'done');
    assert.equal(takeCalls.length, 1);
    assert.deepEqual(takeCalls[0], [session.header.id, 1, { promptRpcId, signal: undefined }]);
    assert.deepEqual(discardCalls, [[session.header.id, 1, { promptRpcId }]]);
    if (takeover) {
      assert.deepEqual(delivered, []);
      assert.equal(isManagedOutboundArtifact(original), false);
      assert.deepEqual(take(session.header.id, 1, { promptRpcId: 'successor-rpc' }), [successor]);
      assert.equal((await materializeOutboundArtifact(successor)).bytes.toString(), 'successor bytes');
      releaseOutboundArtifact(successor);
    } else {
      assert.deepEqual(delivered, [original]);
      assert.equal((await materializeOutboundArtifact(original)).bytes.toString(), 'ordinary result');
      releaseOutboundArtifact(original);
    }
  });
}
