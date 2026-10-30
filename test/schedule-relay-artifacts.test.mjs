import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createScheduleRelay } from '../plugin-src/host/schedule-relay-coordinator.mjs';
import { RelayStore } from '../plugin-src/host/schedule-relay-store.mjs';
import { OutboundArtifactRegistry, isManagedOutboundArtifact, materializeOutboundArtifact, releaseOutboundArtifact } from '../src/channels/shared/semantic/artifact.mjs';
import { deliverOutboundArtifacts } from '../src/channels/shared/semantic/artifact-delivery.mjs';

const ROOM = { botId: 'matrix_one', kind: 'room', route: { roomId: '!one:example.org' } };
const THREAD = { botId: 'matrix_one', kind: 'thread', route: { roomId: `!${'a'.repeat(43)}`, threadId: '$root' } };
const sent = (id = '$sent') => ({ deliveryOutcome: 'sent', providerMessageIds: [id] });
const failed = () => ({ deliveryOutcome: 'failed', providerMessageIds: [], errorCode: 'delivery-failed' });
const end = (turn = 1, reason = 'completed') => ({ type: 'turn/end', data: { turn, reason } });

async function fixture(t, routes = [{ sessionId: 'one', ...ROOM }]) {
  const root = await mkdtemp(join(tmpdir(), 'relay-artifacts-'));
  const path = join(root, 'state.json');
  const store = await RelayStore.open(path);
  const registry = new OutboundArtifactRegistry();
  const calls = [], warnings = [], artifacts = [], native = [];
  let bindings = routes;
  let load = async () => bindings;
  let send = async (botId, target, part, options) => {
    if (part.kind === 'text') return sent('$text');
    const result = await deliverOutboundArtifacts({
      artifacts: [part.artifact], channelKey: 'matrix', signal: options.signal,
      sendImage: async (file) => { native.push({ kind: 'image', target, file }); return sent('$image'); },
      sendFile: async (file) => { native.push({ kind: 'file', target, file }); return sent('$file'); },
    });
    const artifactResult = result.receipt?.artifacts.find((entry) => entry.artifactId === part.artifact.artifactId);
    const deliveryOutcome = artifactResult?.outcome === 'sent' && result.receipt.providerMessageIds.length ? 'sent'
      : artifactResult?.outcome === 'unknown' || artifactResult?.outcome === 'sent' ? 'unknown' : 'failed';
    return { ...result.receipt, deliveryOutcome };
  };
  const im = {
    async listBots() { return [{ botId: 'matrix_one', channel: 'matrix' }]; },
    async listConversationBindings(botId) { return { botId, channel: 'matrix', bindings: (await load()).map(({ botId: _id, ...entry }) => entry) }; },
    async authorizeScheduledTarget() { return Object.freeze({ account: 'original' }); },
    async sendScheduledPart(...args) {
      calls.push(args);
      const persisted = JSON.parse(await readFile(path, 'utf8')).sessions.find((entry) => entry.sessionId === (args[2].artifact?.origin.sessionId ?? 'one'));
      const partId = args[2].kind === 'text' ? 'text' : `artifact:${args[2].artifact.artifactId}`;
      assert.equal(persisted.lastAttempt.parts.find((part) => part.id === partId)?.status, 'sending');
      return send(...args);
    },
  };
  const relay = createScheduleRelay({ im, store, registry, logger: { warn: (value) => warnings.push(value) } });
  t.after(async () => { await relay.close(); await store.close(); await rm(root, { recursive: true, force: true }); });
  const session = (id = 'one') => ({ id, header: { id, cwd: root } });
  function claim(source = { kind: 'schedule' }, turn = 1, id = 'one') {
    const message = { id: `${id}:${turn}:${source.kind}:${source.rpcId ?? ''}`, source, content: [{ type: 'text', text: 'Time sampled: pretend automatic context' }] };
    relay.observeClaim(session(id), message, turn);
    return message;
  }
  async function begin({ id = 'one', turn = 1, sources = [{ kind: 'schedule' }], signal = new AbortController().signal } = {}) {
    relay.observeEvent(session(id), { type: 'turn/start', data: { turn } });
    const messages = sources.map((source) => claim(source, turn, id));
    await relay.preStep({ agent: { session: session(id) }, turn, signal });
    for (const message of messages) relay.observeEvent(session(id), { type: 'user/message', surfaceOp: 'append', data: message });
  }
  async function stage(name = 'existing.png', { id = 'one', commit = true, bytes = Buffer.from('original generated image bytes') } = {}) {
    await writeFile(join(root, name), bytes);
    const artifact = await registry.stage({ path: name }, { agent: { session: session(id) }, callId: name, signal: new AbortController().signal });
    artifacts.push(artifact);
    if (commit) assert.ok(registry.commit(artifact));
    return artifact;
  }
  function answer(text = '', turn = 1, id = 'one') {
    return relay.observeEvent(session(id), { type: 'assistant/message', surfaceOp: 'append', data: { turn, message: { content: [{ type: 'text', text }] } } });
  }
  return { root, path, store, registry, relay, im, calls, native, warnings, artifacts, session, claim, begin, stage, answer,
    setSend(value) { send = value; }, setLoad(value) { load = value; }, setBindings(value) { bindings = value; } };
}

function released(f) { assert.ok(f.artifacts.every((artifact) => !isManagedOutboundArtifact(artifact)), 'all managed snapshots must be released'); }

test('durable schedule metadata alone never authorizes a consumer or delivery', async (t) => {
  const f = await fixture(t);
  f.relay.observeEvent(f.session(), { type: 'turn/start', data: { turn: 1 } });
  f.relay.observeEvent(f.session(), { type: 'user/message', surfaceOp: 'append', data: { source: { kind: 'schedule' } } });
  await f.relay.preStep({ agent: { session: f.session() }, turn: 1 });
  assert.equal(f.registry.hasActiveConsumer(f.session()), false);
  await f.answer('not trusted');
  await f.relay.observeEvent(f.session(), end());
  assert.equal(f.calls.length, 0);
});

test('real runtime/time/catalog/plugin claims allow first-step registration without rpcId', async (t) => {
  const f = await fixture(t, [{ sessionId: 'one', ...THREAD }]);
  await f.begin({ sources: [
    { kind: 'schedule' }, { kind: 'runtime-context', form: 'snapshot' }, { kind: 'time-context', form: 'snapshot' },
    { kind: 'skill-catalog', form: 'catalog' }, { kind: 'plugin:dsh-im', form: 'snapshot' }, { kind: 'plugin:dsh-im', form: 'notice' },
  ] });
  assert.equal(f.registry.hasActiveConsumer(f.session()), true);
  const artifact = await f.stage();
  assert.equal(artifact.origin.turn, 1);
  await f.relay.observeEvent(f.session(), end());
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][2].artifact, artifact, 'never clone the WeakMap-backed artifact');
  assert.deepEqual(f.native.map(({ kind, target, file }) => [kind, target, file.fileName, file.bytes.toString()]), [
    ['image', { kind: 'thread', route: THREAD.route }, 'existing.png', 'original generated image bytes'],
  ]);
  assert.equal(f.store.get('one').lastAttempt.status, 'sent');
  assert.ok(!f.warnings.some((value) => value.includes('mixed-input')));
  assert.equal((await readFile(join(f.root, 'existing.png'))).toString(), 'original generated image bytes');
  released(f);
});

for (const source of [{ kind: 'user' }, { kind: 'web' }, { kind: 'cli' }, { kind: 'rpc', rpcId: 'ordinary' },
  { kind: 'unknown', form: 'snapshot' }, { kind: 'time-context', form: 'notice' }, { kind: 'skill-catalog', form: 'snapshot' },
  { kind: 'plugin:other', form: 'notice' }]) {
  for (const humanFirst of [true, false]) test(`mixed ${source.kind}/${source.form ?? 'input'} stays rejected (${humanFirst ? 'human' : 'schedule'} first)`, async (t) => {
    const f = await fixture(t);
    const scheduled = { kind: 'schedule' };
    await f.begin({ sources: humanFirst ? [source, scheduled] : [scheduled, source] });
    assert.equal(f.registry.hasActiveConsumer(f.session()), false);
    f.claim(scheduled);
    await f.relay.preStep({ agent: { session: f.session() }, turn: 1 });
    await f.answer('private combined answer');
    await f.relay.observeEvent(f.session(), end());
    assert.equal(f.calls.length, 0);
    assert.ok(f.warnings.some((value) => value.includes('mixed-input')));
  });
}

test('later-step human claim revokes staged and committed files and cannot reopen', async (t) => {
  const f = await fixture(t);
  await f.begin();
  const committed = await f.stage('committed.png');
  const pending = await f.stage('pending.txt', { commit: false });
  f.claim({ kind: 'user' });
  assert.equal(f.registry.hasActiveConsumer(f.session()), false);
  assert.equal(f.registry.commit(pending), null);
  f.claim({ kind: 'schedule' });
  await f.relay.preStep({ agent: { session: f.session() }, turn: 1 });
  await f.relay.observeEvent(f.session(), end());
  assert.equal(f.calls.length, 0);
  assert.equal(isManagedOutboundArtifact(committed), false);
  released(f);
});

test('future unclaimed ordinary RPC does not suppress this scheduled turn', async (t) => {
  const f = await fixture(t);
  const closeOrdinary = f.registry.openConsumer('one', 'future-rpc');
  t.after(closeOrdinary);
  await f.begin();
  await f.stage();
  await f.relay.observeEvent(f.session(), end());
  assert.equal(f.native.length, 1);
  released(f);
});

for (const routes of [[], [{ sessionId: 'one', botId: 'matrix_one', kind: 'dm', route: { userId: '@u:example.org' } }],
  [{ sessionId: 'one', ...ROOM }, { sessionId: 'one', ...THREAD }]]) {
  test(`ineligible ${routes.length ? routes[0].kind + (routes.length > 1 ? ' conflict' : '') : 'unbound'} route opens no lease`, async (t) => {
    const f = await fixture(t, routes);
    await f.begin();
    assert.equal(f.registry.hasActiveConsumer(f.session()), false);
    await f.answer('not authorized');
    await f.relay.observeEvent(f.session(), end());
    assert.equal(f.calls.length, 0);
  });
}

test('non-Matrix bindings never open scheduled artifact authority', async (t) => {
  const f = await fixture(t);
  f.im.listBots = async () => [{ botId: 'matrix_one', channel: 'feishu' }];
  await f.begin();
  assert.equal(f.registry.hasActiveConsumer(f.session()), false);
  await f.answer('other channel');
  await f.relay.observeEvent(f.session(), end());
  assert.equal(f.calls.length, 0);
});

test('text then real image and file preserve ordering and independent receipts', async (t) => {
  const f = await fixture(t);
  await f.begin();
  const image = await f.stage();
  const file = await f.stage('report.txt');
  await f.answer('final answer');
  await f.relay.observeEvent(f.session(), end());
  assert.deepEqual(f.calls.map((call) => call[2].kind === 'text' ? call[2].text : call[2].artifact), ['final answer', image, file]);
  assert.deepEqual(f.native.map((entry) => entry.kind), ['image', 'file']);
  assert.deepEqual(f.store.get('one').lastAttempt.parts.map((part) => [part.status, part.providerMessageIds]), [['sent', ['$text']], ['sent', ['$image']], ['sent', ['$file']]]);
  released(f);
});

test('no products and failed staged tool output never create delivery jobs', async (t) => {
  const f = await fixture(t);
  await f.begin();
  const artifact = await f.stage('tool-failed.png', { commit: false });
  f.registry.release(artifact);
  await f.relay.observeEvent(f.session(), end());
  assert.equal(f.calls.length, 0);
  assert.equal(f.store.get('one').lastAttempt, undefined);
  released(f);
});

for (const reason of ['error', 'blocked', 'aborted']) test(`${reason} turn closes only its own lease without delivery`, async (t) => {
  const f = await fixture(t);
  await f.begin();
  await f.stage();
  await f.answer('partial');
  await f.relay.observeEvent(f.session(), end(1, reason));
  assert.equal(f.calls.length, 0);
  assert.equal(f.registry.hasActiveConsumer(f.session()), false);
  released(f);
});

test('text failure continues to independently confirmed attachments', async (t) => {
  const f = await fixture(t);
  await f.begin();
  await f.stage();
  await f.answer('text fails');
  f.setSend(async (_bot, _target, part) => part.kind === 'text' ? failed() : sent('$image'));
  await f.relay.observeEvent(f.session(), end());
  assert.deepEqual(f.store.get('one').lastAttempt.parts.map((part) => part.status), ['failed', 'sent']);
  assert.equal(f.store.get('one').lastAttempt.status, 'failed');
  released(f);
});

for (const receipts of [
  [sent('$text'), sent('$a'), failed()],
  [failed(), { deliveryOutcome: 'unknown', providerMessageIds: [] }, failed()],
  [sent('$text'), { ...failed(), failureNotice: sent('$notice') }, sent('$b')],
  [sent('$text'), { ...failed(), failureNotice: failed() }, sent('$b')],
  [sent('$text'), { sent: true, deliveryOutcome: 'sent', providerMessageIds: ['invalid-id'] }, sent('$b')],
]) test(`aggregate preserves required part outcomes: ${JSON.stringify(receipts)}`, async (t) => {
  const f = await fixture(t);
  await f.begin(); await f.stage('a.png'); await f.stage('b.txt'); await f.answer('answer');
  let index = 0;
  f.setSend(async () => receipts[index++]);
  await f.relay.observeEvent(f.session(), end());
  const attempt = f.store.get('one').lastAttempt;
  assert.equal(attempt.status, receipts.some((receipt) => receipt.deliveryOutcome === 'unknown' || receipt.providerMessageIds?.includes('invalid-id')) ? 'unknown' : 'failed');
  assert.equal(attempt.parts.length, 3);
  assert.equal(attempt.parts[1].notice?.status, receipts[1].failureNotice?.deliveryOutcome);
  assert.notEqual(attempt.status, 'sent');
  released(f);
});

for (const checkpoint of ['attempt', 'startPart']) test(`${checkpoint} failure precedes every native side effect and releases all snapshots`, async (t) => {
  const f = await fixture(t);
  await f.begin(); await f.stage(); await f.stage('later.txt');
  f.store[checkpoint] = async () => { throw new Error('injected checkpoint failure'); };
  await f.relay.observeEvent(f.session(), end());
  assert.equal(f.calls.length, 0);
  assert.equal(f.native.length, 0);
  assert.ok(f.warnings.some((value) => value.includes('relay-checkpoint-failed')));
  await f.relay.observeEvent(f.session(), end());
  assert.equal(f.calls.length, 0);
  released(f);
});

test('one explicit image rejection allows exactly one file fallback, not a second delivery round', async (t) => {
  const f = await fixture(t);
  const native = [];
  await f.begin();
  const artifact = await f.stage();
  f.setSend(async (_bot, _target, part, { signal }) => {
    assert.equal(part.artifact, artifact);
    const result = await deliverOutboundArtifacts({
      artifacts: [artifact], channelKey: 'matrix', signal,
      sendImage: async () => { native.push('image'); throw Object.assign(new Error('explicit rejection'), { code: 'artifact-provider-rejected' }); },
      sendFile: async () => { native.push('file'); return sent('$fallback'); },
    });
    assert.deepEqual(result.receipt.artifacts, [{ artifactId: artifact.artifactId, outcome: 'sent' }]);
    return { ...result.receipt, deliveryOutcome: 'sent' };
  });
  await f.relay.observeEvent(f.session(), end());
  await f.relay.observeEvent(f.session(), end());
  assert.deepEqual(native, ['image', 'file']);
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.get('one').lastAttempt.status, 'sent');
  released(f);
});

test('P0: native image success followed by finishPart failure never falls back, advances or replays', async (t) => {
  const f = await fixture(t);
  await f.begin();
  await f.stage('original.png'); await f.stage('later.txt');
  f.store.finishPart = async () => { throw new Error('disk failed after image success'); };
  await f.relay.observeEvent(f.session(), end());
  assert.equal(f.native.filter((entry) => entry.kind === 'image').length, 1);
  assert.equal(f.native.filter((entry) => entry.kind === 'file').length, 0);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.store.get('one').lastAttempt.parts.map((part) => part.status), ['sending', 'pending']);
  const disk = JSON.parse(await readFile(f.path, 'utf8'));
  assert.deepEqual(disk.sessions[0].lastAttempt.parts.map((part) => part.status), ['sending', 'pending']);
  released(f);
  await f.relay.observeEvent(f.session(), end());
  await f.begin();
  await f.answer('historical replay');
  await f.relay.observeEvent(f.session(), end());
  assert.equal(f.calls.length, 1);
});

for (const status of ['sending', 'unknown', 'failed', 'sent']) test(`restart never replays persisted ${status} attempt`, async (t) => {
  const f = await fixture(t);
  await f.relay.captureBindings();
  const attempt = await f.store.attempt('one', 1);
  await f.store.startPart('one', 1, attempt.attemptId, 'text');
  if (status !== 'sending') await f.store.finishPart('one', 1, attempt.attemptId, 'text', { status, providerMessageIds: status === 'sent' ? ['$previous'] : [] });
  await f.relay.close(); await f.store.close();
  const restored = await RelayStore.open(f.path);
  const registry = new OutboundArtifactRegistry();
  const relay = createScheduleRelay({ im: f.im, store: restored, registry });
  t.after(async () => { await relay.close(); await restored.close(); });
  const session = f.session();
  relay.observeEvent(session, { type: 'turn/start', data: { turn: 1 } });
  relay.observeClaim(session, { id: 'replayed', source: { kind: 'schedule' } }, 1);
  await relay.preStep({ agent: { session }, turn: 1 });
  relay.observeEvent(session, { type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, message: { content: [{ type: 'text', text: 'old answer' }] } } });
  await relay.observeEvent(session, end());
  assert.equal(f.calls.length, 0);
  assert.equal(restored.get('one').lastAttempt.status, status);
});

test('next turn generates artifacts without waiting for previous turn send tail', async (t) => {
  const f = await fixture(t);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(() => release.resolve());
  f.setSend(async (_bot, _target, part) => { if (part.artifact.origin.turn === 1) { entered.resolve(); await release.promise; } return sent(`$turn${part.artifact.origin.turn}`); });
  await f.begin(); const first = await f.stage('first.png');
  const delivering = f.relay.observeEvent(f.session(), end());
  await entered.promise;
  await f.begin({ turn: 2 });
  const second = await f.stage('second.png');
  assert.equal(second.origin.turn, 2);
  assert.equal(isManagedOutboundArtifact(first), true);
  assert.equal(f.calls.length, 1);
  const deliveringSecond = f.relay.observeEvent(f.session(), end(2));
  release.resolve();
  await Promise.all([delivering, deliveringSecond]);
  assert.deepEqual(f.calls.map((call) => call[2].artifact), [first, second]);
  released(f);
});

for (const interruption of ['mixed', 'abort', 'dispose', 'close']) test(`route refresh ${interruption} prevents late lease admission`, async (t) => {
  const f = await fixture(t);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(() => release.resolve());
  f.setLoad(async () => { entered.resolve(); await release.promise; return [{ sessionId: 'one', ...ROOM }]; });
  f.relay.observeEvent(f.session(), { type: 'turn/start', data: { turn: 1 } });
  f.claim();
  const controller = new AbortController();
  const preparing = f.relay.preStep({ agent: { session: f.session() }, turn: 1, signal: controller.signal });
  await entered.promise;
  let closing;
  if (interruption === 'mixed') f.claim({ kind: 'user' });
  if (interruption === 'abort') controller.abort();
  if (interruption === 'dispose') f.relay.disposeSession(f.session());
  if (interruption === 'close') closing = f.relay.close();
  release.resolve();
  await preparing; await closing;
  assert.equal(f.registry.hasActiveConsumer(f.session()), false);
  await f.answer('late answer'); await f.relay.observeEvent(f.session(), end());
  assert.equal(f.calls.length, 0);
});

test('binding conflict after text prevents the next artifact and never retargets', async (t) => {
  const f = await fixture(t);
  await f.begin(); await f.stage(); await f.answer('text');
  f.setSend(async () => { f.setBindings([{ sessionId: 'one', ...THREAD }]); return sent('$text'); });
  await f.relay.observeEvent(f.session(), end());
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0][1], { kind: 'room', route: ROOM.route });
  assert.deepEqual(f.store.get('one').lastAttempt.parts.map((part) => part.status), ['sent', 'skipped']);
  released(f);
});

for (const confirm of [true, false]) test(`close drains accepted provider ${confirm ? 'success' : 'uncertain abort'} and cancels later parts`, async (t) => {
  const f = await fixture(t);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(() => release.resolve());
  f.setSend(async (_bot, _target, _part, { signal }) => {
    entered.resolve(); await release.promise;
    assert.equal(signal.aborted, true);
    if (confirm) return sent('$accepted-before-close');
    throw Object.assign(new Error('no response'), { code: 'artifact-delivery-uncertain' });
  });
  await f.begin(); await f.stage(); await f.stage('later.txt');
  const delivering = f.relay.observeEvent(f.session(), end());
  await entered.promise;
  let settled = false;
  const closing = f.relay.close().then(() => { settled = true; });
  const duplicate = f.relay.close();
  await Promise.resolve();
  assert.equal(settled, false);
  release.resolve();
  await Promise.all([delivering, closing, duplicate]);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.store.get('one').lastAttempt.parts.map((part) => part.status), [confirm ? 'sent' : 'unknown', 'skipped']);
  assert.equal(f.store.get('one').lastAttempt.status, confirm ? 'failed' : 'unknown');
  released(f);
});

test('different Sessions using the same turn retain independent owners and exact thread routes', async (t) => {
  const f = await fixture(t, [{ sessionId: 'one', ...ROOM }, { sessionId: 'two', ...THREAD }]);
  await f.begin();
  const first = await f.stage('one.png');
  await f.begin({ id: 'two' });
  const second = await f.stage('two.png', { id: 'two' });
  assert.equal(first.origin.turn, second.origin.turn);
  await Promise.all([f.relay.observeEvent(f.session(), end()), f.relay.observeEvent(f.session('two'), end())]);
  assert.equal(f.calls.length, 2);
  const bySession = new Map(f.calls.map((call) => [call[2].artifact.origin.sessionId, call]));
  assert.equal(bySession.get('one')[2].artifact, first);
  assert.equal(bySession.get('two')[2].artifact, second);
  assert.deepEqual(bySession.get('one')[1], { kind: 'room', route: ROOM.route });
  assert.deepEqual(bySession.get('two')[1], { kind: 'thread', route: THREAD.route });
  assert.equal(f.store.get('one').lastAttempt.status, 'sent');
  assert.equal(f.store.get('two').lastAttempt.status, 'sent');
  released(f);
});

test('ordinary RPC takeover keeps its real files across old relay rejection and close', async (t) => {
  const f = await fixture(t);
  await f.begin();
  const stale = await f.stage('schedule-pending.png', { commit: false });
  const closeOrdinary = f.registry.openConsumer('one', 'ordinary-rpc');
  t.after(closeOrdinary);
  f.claim({ kind: 'rpc', rpcId: 'ordinary-rpc' });
  const ordinary = await f.stage('ordinary.txt');
  assert.equal(f.registry.commit(stale), null);
  f.registry.clear = () => assert.fail('relay cleanup must not clear the global registry');
  await f.relay.close();
  assert.equal(f.registry.hasActiveConsumer(f.session()), true);
  const taken = f.registry.take('one', 1, { promptRpcId: 'ordinary-rpc' });
  assert.deepEqual(taken, [ordinary]);
  assert.equal((await materializeOutboundArtifact(ordinary)).bytes.toString(), 'original generated image bytes');
  releaseOutboundArtifact(ordinary);
  assert.equal(f.calls.length, 0);
  released(f);
});

test('close waits for an accepted terminal checkpoint and records success before skipping remaining parts', async (t) => {
  const f = await fixture(t);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(() => release.resolve());
  const finish = f.store.finishPart.bind(f.store);
  f.store.finishPart = async (...args) => { entered.resolve(); await release.promise; return finish(...args); };
  await f.begin(); await f.stage(); await f.stage('later.txt');
  const delivering = f.relay.observeEvent(f.session(), end());
  await entered.promise;
  assert.equal(f.native.length, 1);
  let closed = false;
  const closing = f.relay.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  assert.deepEqual(f.store.get('one').lastAttempt.parts.map((part) => part.status), ['sending', 'pending']);
  release.resolve();
  await Promise.all([delivering, closing]);
  assert.equal(f.native.length, 1);
  assert.deepEqual(f.store.get('one').lastAttempt.parts.map((part) => [part.status, part.providerMessageIds ?? []]), [['sent', ['$image']], ['skipped', []]]);
  released(f);
});
