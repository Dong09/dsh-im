import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { createImHostPlugin } from '../plugin-src/host/index.mjs';
import { createDeliveryService } from '../plugin-src/host/delivery-service.mjs';
import { createDeliveryAdapter } from '../plugin-src/host/delivery-adapter.mjs';
import { installScheduleRelay } from '../plugin-src/host/schedule-relay.mjs';
import { RelayStore } from '../plugin-src/host/schedule-relay-store.mjs';
import { installSessionSyncCoordinator } from '../plugin-src/host/session-sync-coordinator.mjs';
import { getDeliverySyncSettingsStore } from '../src/channels/shared/delivery-sync-settings-store.mjs';
import { OutboundArtifactRegistry, isManagedOutboundArtifact } from '../src/channels/shared/semantic/artifact.mjs';

const channels = ['Feishu', 'Weixin', 'Dingtalk', 'Wecom', 'WecomApp', 'Qq', 'Slack', 'Telegram', 'Discord', 'Whatsapp', 'IMessage', 'Email', 'Matrix', 'Office'];
const botId = 'matrix_one', roomId = '!one:example.org';

async function fixture(t, { kind = 'room', status = 'sent', textStatus = 'sent', scheduleReplies = true,
  deliverModelAnswers = true, mirrorUserInput = true, initFailure = false, holdSettings = false,
  holdArtifact = false, holdText = false, saved = 'none', priorState = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'schedule-sync-coexistence-'));
  const config = { dshHome: root, matrix: { scheduleReplies } };
  const settings = getDeliverySyncSettingsStore(config);
  await settings.set({ deliverModelAnswers, mirrorUserInput, modelIcon: '', inputIcon: '' });
  const ctx = new Context();
  for (const [name, value] of [['connection', { fetch: { register: () => () => {} } }], ['credentials', {}],
    ['typertGateway', { stream() {} }], ['sessionController', {}], ['workspaceController', {}]]) ctx.provide(name, value);
  const registry = new OutboundArtifactRegistry();
  const key = kind === 'thread' ? `group:room:${roomId}$$root` : `group:room:${roomId}`;
  const target = { targetId: 'saved', kind, route: { roomId, ...(kind === 'thread' ? { threadId: '$root' } : {}) } };
  const session = { id: 'one', header: { id: 'one', cwd: root } };
  let binding = session.id;
  const scheduled = [], mirrored = [], notices = [];
  const artifactGate = Promise.withResolvers(), textGate = Promise.withResolvers();
  const artifactEntered = Promise.withResolvers(), textEntered = Promise.withResolvers();
  if (!holdArtifact) artifactGate.resolve();
  if (!holdText) textGate.resolve();
  const im = createDeliveryService({ logger: { warn() {} } });
  im.registerAdapter(createDeliveryAdapter({
    channel: 'matrix',
    workspaces: { has: id => id === botId, listBotIds: () => [botId],
      listDeliveryTargets: () => saved === 'none' ? [] : [target],
      listSessionSyncTargets: () => ['enabled', 'deleted', 'unmatched'].includes(saved)
        ? [{ botId, targetId: 'saved', conversationKey: saved === 'unmatched' ? 'group:room:!other:example.org' : key }] : [],
      deliveryTargetFor: () => saved === 'deleted' ? null : target,
      listDsBotBindings: () => [] },
    stateFor: async () => ({ snapshot: () => ({ sessions: binding ? { [key]: binding } : {} }) }),
    coreController: {
      describeDeliveryAccount: id => ({ version: 1, botId: id, channel: 'matrix', connected: true,
        capabilities: ['scheduled-part-delivery'], account: { fingerprint: 'a'.repeat(64) } }),
      async sendScheduledPart(id, destination, part) {
        assert.equal(part.kind, 'artifact', 'custom relay never sends a final answer');
        scheduled.push({ id, target: destination, part });
        artifactEntered.resolve(); await artifactGate.promise;
        // Operational notices are distinct from final answers and never prove artifact success.
        if (status === 'failed') notices.push('Attachment delivery failed');
        return { deliveryOutcome: status, providerMessageIds: status === 'sent' ? [`$artifact${scheduled.length}`] : [],
          ...(status === 'sent' ? {} : { reason: status === 'unknown' ? 'send-result-unknown' : 'delivery-failed' }),
          artifacts: [{ artifactId: part.artifact.artifactId, outcome: status }] };
      },
      async sendProactiveText(id, destination, text) {
        mirrored.push({ id, target: destination, text });
        textEntered.resolve(); await textGate.promise;
        if (textStatus === 'unknown') throw Object.assign(new Error('lost receipt'), { code: 'matrix-delivery-uncertain' });
        if (textStatus === 'failed') throw Object.assign(new Error('provider refused'), { code: 'delivery-failed' });
        return { sent: true };
      },
    },
  }));
  let relay, sync;
  const gate = Promise.withResolvers(), settingsRead = Promise.withResolvers();
  if (!holdSettings) gate.resolve();
  const statePath = join(root, 'integrations', 'dsh-matrix', 'schedule-replies.json');
  if (priorState) {
    await mkdir(join(root, 'integrations', 'dsh-matrix'), { recursive: true });
    await writeFile(statePath, JSON.stringify(priorState));
  }
  const internals = {
    ...Object.fromEntries(channels.map(channel => [`apply${channel}`, async () => {}])),
    createDeliveryService: () => im,
    installHostLanguage: () => null, installInjectedContext: () => {}, installUpdateRpc: () => {},
    installDeliveryRpc: () => {}, installInboundTtlRpc: () => {}, installDeliverySyncRpc: () => {}, installSidebarSettingsRpc: () => {},
    installScheduleRelay: async (scope, service, options) => {
      if (initFailure) throw new Error('fixture-init-failure');
      return relay = await installScheduleRelay(scope, service, { ...options, registry });
    },
    installSessionSyncCoordinator: (scope, service, options) => sync = installSessionSyncCoordinator(scope, service, {
      ...options, logger: { warn() {} }, loadSettings: async () => {
        settingsRead.resolve(); await gate.promise; return settings.get();
      },
    }),
  };
  const host = ctx.plugin(createImHostPlugin(internals), config);
  t.after(async () => {
    gate.resolve(); artifactGate.resolve(); textGate.resolve();
    await host.dispose(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true });
  });
  await host.await();
  async function begin(turn = 1, source = { kind: 'schedule' }, { claim = true, mixed = false } = {}) {
    ctx.emit('session/event', session, { type: 'turn/start', data: { turn } });
    const message = { id: `input:${turn}`, source, content: [{ type: 'text', text: 'input' }] };
    if (claim) ctx.emit('agent/inbox/claimed', { agent: { session }, message, turn });
    if (mixed) ctx.emit('agent/inbox/claimed', { agent: { session }, message: { id: `mixed:${turn}`, source: { kind: 'user', rpcId: 'web' } }, turn });
    await ctx.waterfall('agent/pre-step', { agent: { session }, turn, signal: new AbortController().signal }, async () => ({ kind: 'enter' }));
    ctx.emit('session/event', session, { type: 'user/message', surfaceOp: 'append', data: message });
  }
  async function stage(name = 'existing.png') {
    await writeFile(join(root, name), 'original bytes');
    const artifact = await registry.stage({ path: name }, { agent: { session }, callId: `return:${name}` });
    assert.ok(registry.commit(artifact)); return artifact;
  }
  function finish(turn = 1, text = 'final answer') {
    if (text) ctx.emit('session/event', session, { type: 'assistant/message', surfaceOp: 'append', data: { turn, message: { content: [{ type: 'text', text }] } } });
    ctx.emit('session/event', session, { type: 'turn/end', data: { turn, reason: 'completed' } });
  }
  async function idle() { await relay?.whenIdle(); await sync.whenIdle(); }
  return { root, session, registry, begin, stage, finish, idle, scheduled, mirrored, notices, im, settings,
    settingsRead: settingsRead.promise, releaseSettings: () => gate.resolve(), relay: () => relay,
    artifactEntered: artifactEntered.promise, textEntered: textEntered.promise,
    releaseArtifact: () => artifactGate.resolve(), releaseText: () => textGate.resolve(),
    rebind: (id) => { binding = id; }, disk: async () => JSON.parse(await readFile(statePath, 'utf8')) };
}

for (const kind of ['room', 'thread']) for (const status of ['sent', 'unknown', 'failed']) {
  test(`actual Host ${kind}: official final text and independent ${status} artifact with delayed settings`, { timeout: 10_000 }, async t => {
    const f = await fixture(t, { kind, status, holdSettings: true });
    await f.begin(); const artifact = await f.stage(); f.finish();
    await f.settingsRead; await f.relay().whenIdle();
    assert.equal(f.scheduled.length, 1, 'artifact does not wait for official text');
    assert.equal(f.scheduled[0].part.artifact, artifact);
    f.releaseSettings(); await f.idle();
    assert.deepEqual(f.mirrored.map(x => x.text), ['final answer']);
    assert.equal(isManagedOutboundArtifact(artifact), false);
    const attempt = (await f.disk()).sessions[0].lastAttempt;
    assert.deepEqual(attempt.parts.map(x => x.kind), ['artifact']);
    assert.equal(attempt.status, status, 'status describes only artifacts, never official text');
    f.finish(); await f.idle();
    assert.equal(f.scheduled.length, 1); assert.equal(f.mirrored.length, 1);
  });
}

for (const side of ['Text', 'Artifact']) test(`delayed ${side.toLowerCase()} send does not block the other delivery owner`, { timeout: 10_000 }, async t => {
  const f = await fixture(t, { [`hold${side}`]: true });
  await f.begin(); await f.stage(); f.finish();
  await Promise.all([f.artifactEntered, f.textEntered]);
  if (side === 'Text') await f.relay().whenIdle();
  f[`release${side}`](); await f.idle();
  assert.equal(f.scheduled.length, 1); assert.equal(f.mirrored.length, 1);
});

for (const mode of ['disabled', 'init-failure', 'unclaimed', 'mixed']) {
  test(`official answer remains available when attachment relay is ${mode}`, { timeout: 10_000 }, async t => {
    const f = await fixture(t, { scheduleReplies: mode !== 'disabled', initFailure: mode === 'init-failure' });
    await f.begin(1, { kind: 'schedule' }, { claim: mode !== 'unclaimed', mixed: mode === 'mixed' });
    f.finish(); await f.idle();
    assert.equal(f.scheduled.length, 0); assert.deepEqual(f.mirrored.map(x => x.text), ['final answer']);
  });
}

test('no artifacts create no custom attempt; ordinary Web still mirrors its input and answer', async t => {
  const f = await fixture(t);
  await f.begin(); f.finish(); await f.idle();
  assert.equal((await f.disk()).sessions[0].lastAttempt, undefined);
  await f.begin(2, { kind: 'user', rpcId: 'web' }); f.finish(2); await f.idle();
  assert.equal(f.scheduled.length, 0);
  assert.deepEqual(f.mirrored.map(x => x.text), ['final answer', 'input', 'final answer']);
});

test('empty final text still sends ordered attachments and no fabricated answer', async t => {
  const f = await fixture(t);
  await f.begin(); const a = await f.stage('a.png'), b = await f.stage('b.txt'); f.finish(1, ''); await f.idle();
  assert.deepEqual(f.scheduled.map(x => x.part.artifact), [a, b]); assert.equal(f.mirrored.length, 0);
});

for (const mode of ['failed', 'unknown', 'disabled']) test(`official text ${mode} cannot authorize custom text fallback or discard artifacts`, async t => {
  const f = await fixture(t, { textStatus: mode, deliverModelAnswers: mode !== 'disabled' });
  await f.begin(); await f.stage(); f.finish(); await f.idle();
  assert.deepEqual(f.scheduled.map(x => x.part.kind), ['artifact']);
  assert.equal(f.mirrored.length, mode === 'disabled' ? 0 : mode === 'failed' ? 2 : 1,
    'only the official sender may try its existing markdown-to-plain fallback after a definite refusal');
  assert.equal((await f.disk()).sessions[0].lastAttempt.status, 'sent');
});

test('artifact failure notice is neither a final answer nor an artifact success', async t => {
  const f = await fixture(t, { status: 'failed' });
  await f.begin(); await f.stage(); f.finish(); await f.idle();
  assert.deepEqual(f.notices, ['Attachment delivery failed']);
  assert.deepEqual(f.mirrored.map(x => x.text), ['final answer']);
  assert.equal((await f.disk()).sessions[0].lastAttempt.status, 'failed');
});

test('successful native artifact with failed final checkpoint never replays or consumes remaining snapshots', async t => {
  const original = RelayStore.prototype.finishPart;
  RelayStore.prototype.finishPart = async () => { throw new Error('checkpoint-unavailable'); };
  t.after(() => { RelayStore.prototype.finishPart = original; });
  const f = await fixture(t);
  await f.begin(); const a = await f.stage('a.png'), b = await f.stage('b.png'); f.finish(); await f.idle();
  assert.equal(f.scheduled.length, 1); assert.deepEqual(f.mirrored.map(x => x.text), ['final answer']);
  const attempt = (await f.disk()).sessions[0].lastAttempt;
  assert.deepEqual(attempt.parts.map(x => x.status), ['sending', 'pending']);
  assert.equal(isManagedOutboundArtifact(a), false); assert.equal(isManagedOutboundArtifact(b), false);
  f.finish(); await f.idle(); assert.equal(f.scheduled.length, 1);
});

for (const kind of ['room', 'thread']) for (const saved of ['enabled', 'disabled', 'unmatched', 'deleted']) {
  test(`Host wrapper preserves explicit ${kind} text scope and saved-target policy: ${saved}`, async t => {
    const f = await fixture(t, { kind, saved });
    assert.deepEqual(await f.im.listSessionSyncTargets('one'), [], 'interactive enumeration remains private-only');
    assert.equal((await f.im.listSessionSyncTargets('one', { privateOnly: false })).length, saved === 'enabled' ? 1 : 0);
    await f.begin(); f.finish(); await f.idle();
    assert.equal(f.mirrored.length, saved === 'enabled' ? 1 : 0, 'saved policy never falls back to bypass disabled or unmatched targets');
    await f.settings.set({ mirrorUserInput: false, deliverModelAnswers: false });
    assert.deepEqual(await f.im.listSessionSyncTargets('one'), []);
    assert.deepEqual(await f.im.listSessionSyncTargets('one', { privateOnly: false }), []);
  });
}

for (const rebind of [null, 'new-session']) test(`old Session attachment destination survives /new or rebinding (${rebind}) without fabricating text`, async t => {
  const f = await fixture(t);
  f.rebind(rebind); // captureBindings at installation has already frozen the old attachment destination.
  await f.begin(); await f.stage(); f.finish(); await f.idle();
  assert.equal(f.scheduled.length, 1); assert.equal(f.scheduled[0].target.route.roomId, roomId);
  assert.deepEqual(f.mirrored, []);
  const state = await f.disk();
  const restarted = await fixture(t, { priorState: state }); restarted.rebind(null);
  await restarted.begin(); await restarted.stage(); restarted.finish(); await restarted.idle();
  assert.equal(restarted.scheduled.length, 0, 'reopened v2 high-water mark prevents historical replay');
  assert.equal((await restarted.disk()).sessions[0].lastAttempt.attemptId, state.sessions[0].lastAttempt.attemptId);
});
