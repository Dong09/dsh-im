import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { createImHostPlugin } from '../plugin-src/host/index.mjs';
import { createDeliveryService } from '../plugin-src/host/delivery-service.mjs';
import { createDeliveryAdapter } from '../plugin-src/host/delivery-adapter.mjs';
import { installScheduleRelay } from '../plugin-src/host/schedule-relay.mjs';
import { installSessionSyncCoordinator, createSessionSyncCoordinator } from '../plugin-src/host/session-sync-coordinator.mjs';
import { getDeliverySyncSettingsStore } from '../src/channels/shared/delivery-sync-settings-store.mjs';
import { OutboundArtifactRegistry, isManagedOutboundArtifact } from '../src/channels/shared/semantic/artifact.mjs';

const channels = ['Feishu', 'Weixin', 'Dingtalk', 'Wecom', 'WecomApp', 'Qq', 'Slack', 'Telegram', 'Discord', 'Whatsapp', 'IMessage', 'Email', 'Matrix', 'Office'];
const botId = 'matrix_one';
const roomId = '!one:example.org';

async function fixture(t, { kind = 'room', status = 'sent', scheduleReplies = true, initFailure = false, holdSettings = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'schedule-sync-coexistence-'));
  const config = { dshHome: root, matrix: { scheduleReplies } };
  await getDeliverySyncSettingsStore(config).set({ deliverModelAnswers: true, mirrorUserInput: true, modelIcon: '', inputIcon: '' });
  const ctx = new Context();
  for (const [name, value] of [['connection', { fetch: { register: () => () => {} } }], ['credentials', {}],
    ['typertGateway', { stream() {} }], ['sessionController', {}], ['workspaceController', {}]]) ctx.provide(name, value);
  const registry = new OutboundArtifactRegistry();
  const key = kind === 'thread' ? `group:room:${roomId}$$root` : `group:room:${roomId}`;
  const session = { id: 'one', header: { id: 'one', cwd: root } };
  const scheduled = [], mirrored = [];
  const im = createDeliveryService({ logger: { warn() {} } });
  im.registerAdapter(createDeliveryAdapter({
    channel: 'matrix',
    workspaces: { has: id => id === botId, listBotIds: () => [botId], listDeliveryTargets: () => [], listSessionSyncTargets: () => [], listDsBotBindings: () => [] },
    stateFor: async () => ({ snapshot: () => ({ sessions: { [key]: session.id } }) }),
    coreController: {
      describeDeliveryAccount: id => ({ version: 1, botId: id, channel: 'matrix', connected: true,
        capabilities: ['scheduled-part-delivery'], account: { fingerprint: 'a'.repeat(64) } }),
      async sendScheduledPart(id, target, part) {
        scheduled.push({ id, target, part });
        return { deliveryOutcome: status, providerMessageIds: status === 'sent' ? [`$part${scheduled.length}`] : [],
          ...(status === 'sent' ? {} : { reason: status === 'unknown' ? 'send-result-unknown' : 'delivery-failed' }),
          ...(part.kind === 'artifact' ? { artifacts: [{ artifactId: part.artifact.artifactId, outcome: status }] } : {}) };
      },
      async sendProactiveText(id, target, text) { mirrored.push({ id, target, text }); return { sent: true }; },
    },
  }));
  let relay, sync;
  const gate = Promise.withResolvers();
  const settingsRead = Promise.withResolvers();
  if (!holdSettings) gate.resolve();
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
        settingsRead.resolve(); await gate.promise; return getDeliverySyncSettingsStore(config).get();
      },
    }),
  };
  const host = ctx.plugin(createImHostPlugin(internals), config);
  t.after(async () => { gate.resolve(); await host.dispose(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); });
  await host.await();
  async function begin(turn = 1, source = { kind: 'schedule' }, { claim = true, mixed = false } = {}) {
    ctx.emit('session/event', session, { type: 'turn/start', data: { turn } });
    const message = { id: `input:${turn}`, source, content: [{ type: 'text', text: 'input' }] };
    if (claim) ctx.emit('agent/inbox/claimed', { agent: { session }, message, turn });
    if (mixed) ctx.emit('agent/inbox/claimed', { agent: { session }, message: { id: `mixed:${turn}`, source: { kind: 'user', rpcId: 'web' } }, turn });
    await ctx.waterfall('agent/pre-step', { agent: { session }, turn, signal: new AbortController().signal }, async () => ({ kind: 'enter' }));
    ctx.emit('session/event', session, { type: 'user/message', surfaceOp: 'append', data: message });
  }
  function finish(turn = 1) {
    ctx.emit('session/event', session, { type: 'assistant/message', surfaceOp: 'append', data: { turn, message: { content: [{ type: 'text', text: 'final answer' }] } } });
    const event = { type: 'turn/end', data: { turn, reason: 'completed' } };
    ctx.emit('session/event', session, event);
    return event;
  }
  async function idle() { await relay?.whenIdle(); await sync.whenIdle(); }
  return { root, session, registry, begin, finish, idle, scheduled, mirrored, settingsRead: settingsRead.promise,
    releaseSettings: () => gate.resolve(), relay: () => relay };
}

for (const kind of ['room', 'thread']) for (const status of ['sent', 'unknown', 'failed']) {
  test(`actual Host ${kind} scheduled ${status} is not delivered twice when official answer sync is enabled`, { timeout: 10_000 }, async t => {
    const f = await fixture(t, { kind, status, holdSettings: true });
    await f.begin();
    await writeFile(join(f.root, 'existing.png'), 'original bytes');
    const artifact = await f.registry.stage({ path: 'existing.png' }, { agent: { session: f.session }, callId: 'return-existing' });
    assert.ok(f.registry.commit(artifact));
    const event = f.finish();
    await f.settingsRead;
    await f.relay().whenIdle(); // Generic mirror deliberately runs after native jobs have finished.
    const owner = f.relay().deliveryDestinationFor('one', 1, event);
    assert.equal(owner.botId, botId);
    assert.equal(owner.kind, kind);
    assert.equal(f.relay().deliveryDestinationFor('one', 1, structuredClone(event)), null, 'metadata cannot forge a relay receipt');
    assert.equal(f.relay().deliveryDestinationFor('other', 1, event), null);
    assert.equal(f.relay().deliveryDestinationFor('one', 2, event), null);
    f.releaseSettings();
    await f.idle();
    assert.deepEqual(f.scheduled.map(x => x.part.kind), ['text', 'artifact']);
    assert.equal(f.scheduled[1].part.artifact, artifact);
    assert.equal(isManagedOutboundArtifact(artifact), false);
    assert.deepEqual(f.mirrored, [], 'sent, failed and unknown relay results never become implicit mirror retries');
  });
}

for (const mode of ['disabled', 'init-failure', 'unclaimed', 'mixed']) {
  test(`official answer sync remains available when schedule relay is ${mode}`, { timeout: 10_000 }, async t => {
    const f = await fixture(t, { scheduleReplies: mode !== 'disabled', initFailure: mode === 'init-failure' });
    await f.begin(1, { kind: 'schedule' }, { claim: mode !== 'unclaimed', mixed: mode === 'mixed' });
    f.finish(); await f.idle();
    assert.equal(f.scheduled.length, 0);
    assert.deepEqual(f.mirrored.map(x => x.text), ['final answer']);
  });
}

test('ordinary Matrix Web input and answer still follow the official sync switches', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  await f.begin(1, { kind: 'user', rpcId: 'web' }); f.finish(); await f.idle();
  assert.equal(f.scheduled.length, 0);
  assert.deepEqual(f.mirrored.map(x => x.text), ['input', 'final answer']);
});

test('saved-target fanout excludes only the accepted exact Matrix destination before rendering or sending', async () => {
  const owner = { botId, kind: 'thread', route: { roomId, threadId: '$root' } };
  const targets = [
    { channel: 'matrix', botId, targetId: 'same' }, { channel: 'matrix', botId, targetId: 'other-thread' },
    { channel: 'matrix', botId, targetId: 'room' }, { channel: 'telegram', botId: 'telegram_one', targetId: 'other-channel' },
  ];
  const sends = [];
  const coordinator = createSessionSyncCoordinator({
    loadSettings: async () => ({ mirrorUserInput: false, deliverModelAnswers: true, modelIcon: '', inputIcon: '' }),
    resolveAnswerDestination: () => owner,
    deliveryService: {
      listSessionSyncTargets: async () => targets,
      listTargets: async () => ({ targets: [
        { targetId: 'same', kind: 'thread', route: owner.route },
        { targetId: 'other-thread', kind: 'thread', route: { roomId, threadId: '$other' } },
        { targetId: 'room', kind: 'room', route: { roomId } },
      ] }),
      async deliverSessionText() { assert.fail('saved targets must not fall back to a binding'); },
      async sendSessionSyncText(...args) { sends.push(args); return { sent: true }; },
    },
  });
  await coordinator.enqueue('one', { type: 'turn/start', data: { turn: 1 } });
  await coordinator.enqueue('one', { type: 'user/message', surfaceOp: 'append', data: { source: { kind: 'schedule' } } });
  await coordinator.enqueue('one', { type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, message: { content: [{ type: 'text', text: 'final answer' }] } } });
  await coordinator.enqueue('one', { type: 'turn/end', data: { turn: 1, reason: 'completed' } });
  assert.deepEqual(sends.map(x => x[1]), ['other-thread', 'room', 'other-channel']);
  coordinator.close();
});

test('saved Matrix sync checks the actual resolved destination immediately before a native send', async () => {
  const sends = [];
  let target = { targetId: 'saved', kind: 'thread', route: { roomId, threadId: '$root' } };
  const key = `group:room:${roomId}$$root`;
  const adapter = createDeliveryAdapter({
    channel: 'matrix', workspaces: {
      has: () => true, listBotIds: () => [botId],
      listSessionSyncTargets: () => [{ botId, targetId: 'saved', conversationKey: key }],
      deliveryTargetFor: () => target,
    },
    stateFor: async () => ({ snapshot: () => ({ sessions: { [key]: 'one' } }) }),
    coreController: { async sendProactiveText(...args) { sends.push(args); return { sent: true }; } },
  });
  const owner = { botId, kind: 'thread', route: { roomId, threadId: '$root' } };
  assert.deepEqual(await adapter.sendSessionSyncText(botId, 'saved', 'one', 'answer', { excludedDestination: owner }),
    { sent: false, reason: 'externally-owned' });
  assert.equal(sends.length, 0);
  // The same native destination is still available when no relay accepted it.
  assert.deepEqual(await adapter.sendSessionSyncText(botId, 'saved', 'one', 'answer'), { sent: true });
  assert.equal(sends.length, 1);
});

test('DS Bot-only binding fallback applies relay exclusion after its actual destination lookup', async () => {
  const im = createDeliveryService();
  let lookups = 0;
  im.describeConversation = async () => null;
  im.describeViaDsBot = async () => {
    lookups += 1;
    return { channel: 'matrix', botId, conversationKey: `group:room:${roomId}` };
  };
  im.send = async () => { assert.fail('an accepted relay destination must not be sent again'); };
  assert.deepEqual(await im.deliverSessionText('one', 'answer', {
    excludedDestination: { botId, kind: 'room', route: { roomId } },
  }), { sent: false, reason: 'externally-owned' });
  assert.equal(lookups, 1);
});
