import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { createImHostPlugin } from '../plugin-src/host/index.mjs';
import { createDeliveryService } from '../plugin-src/host/delivery-service.mjs';
import { createDeliveryAdapter } from '../plugin-src/host/delivery-adapter.mjs';
import { installProductionChannel } from '../plugin-src/host/channels/shared/startup.mjs';
import { installScheduleRelay } from '../plugin-src/host/schedule-relay.mjs';
import { OutboundArtifactRegistry, isManagedOutboundArtifact } from '../src/channels/shared/semantic/artifact.mjs';

const channelNames = ['Feishu', 'Weixin', 'Dingtalk', 'Wecom', 'WecomApp', 'Qq', 'Slack', 'Telegram', 'Discord', 'Whatsapp', 'IMessage', 'Email', 'Matrix', 'Office'];
function internals(service) {
  return {
    ...Object.fromEntries(channelNames.map((channel) => [`apply${channel}`, async () => {}])),
    createDeliveryService: () => service,
    installHostLanguage: () => null,
    installInjectedContext: () => {},
    installSessionSyncCoordinator: () => {},
    installUpdateRpc: () => {},
    installDeliveryRpc: () => {},
    installInboundTtlRpc: () => {},
    installSidebarSettingsRpc: () => {},
  };
}

async function emitTurn(ctx, turn, text, sessionId = 'one') {
  const session = { id: sessionId };
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn } });
  const messages = [
    { id: `${sessionId}:${turn}:schedule`, source: { kind: 'schedule' } },
    { id: `${sessionId}:${turn}:runtime`, source: { kind: 'runtime-context', form: 'snapshot' } },
    { id: `${sessionId}:${turn}:time`, source: { kind: 'time-context', form: 'snapshot' } },
  ];
  for (const message of messages) ctx.emit('agent/inbox/claimed', { agent: { session }, message, turn });
  const decision = { kind: 'enter' };
  assert.equal(await ctx.waterfall('agent/pre-step', { agent: { session }, turn, signal: new AbortController().signal }, async () => decision), decision);
  for (const message of messages) ctx.emit('session/event', session, { type: 'user/message', surfaceOp: 'append', data: message });
  ctx.emit('session/event', session, { type: 'assistant/message', surfaceOp: 'append', data: { turn, message: { content: [{ type: 'text', text }] } } });
  ctx.emit('session/event', session, { type: 'turn/end', data: { turn, reason: 'completed' } });
}
const account = (botId) => ({ version: 1, botId, channel: 'matrix', connected: true,
  capabilities: ['scheduled-part-delivery'], account: { fingerprint: 'a'.repeat(64) } });
const receipt = (id = '$sent') => ({ deliveryOutcome: 'sent', providerMessageIds: [id] });

test('dsh-im automatically installs its built-in schedule reply coordinator after channels start', async () => {
  const calls = [];
  const service = {};
  const host = createImHostPlugin({
    ...internals(service),
    installScheduleRelay: async (_ctx, im, options) => calls.push({ im, options }),
  });
  await host.apply({ on: () => () => {}, effect: () => () => {}, logger: { error() {} } }, { dshHome: 'test-home' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].im, service);
  assert.equal(calls[0].options.dshHome, 'test-home');
});

test('built-in scheduled replies can be disabled and never bind a remote Harness', async () => {
  for (const matrix of [{ scheduleReplies: false }, { harnessBaseUrl: 'https://remote.example' }]) {
    let installs = 0;
    const host = createImHostPlugin({ ...internals({}), installScheduleRelay: async () => { installs += 1; } });
    await host.apply({ on: () => () => {}, effect: () => () => {}, logger: { error() {} } }, { matrix });
    assert.equal(installs, 0);
  }
});

test('a scheduled-reply initialization failure is visible without disabling ordinary chat', async () => {
  const errors = [];
  const host = createImHostPlugin({
    ...internals({}),
    installScheduleRelay: async () => { throw new Error('state-unavailable'); },
  });
  await host.apply({ on: () => () => {}, effect: () => () => {}, logger: { error: (...args) => errors.push(args) } });
  assert.ok(errors.some(([text]) => text.includes('failed to activate Matrix scheduled replies')));
});

test('a second bot with a v12 room never disables legacy-room scheduled replies', { timeout: 10_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-im-mixed-room-ids-'));
  const ctx = new Context();
  t.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); });
  ctx.provide('connection', { fetch: { register: () => () => {} } });
  ctx.provide('credentials', {});
  ctx.provide('typertGateway', { stream() {} });
  ctx.provide('sessionController', {});
  ctx.provide('workspaceController', {});
  const routes = new Map([
    ['matrix_one', { roomId: '!legacy:example.org', sessionId: 'one' }],
    ['matrix_two', { roomId: `!${'a'.repeat(43)}`, sessionId: 'two' }],
  ]);
  const delivered = [];
  const sent = Promise.withResolvers();
  const im = createDeliveryService();
  im.registerAdapter(createDeliveryAdapter({
    channel: 'matrix', workspaces: { has: (id) => routes.has(id), listBotIds: () => [...routes.keys()] },
    stateFor: async (id) => ({ snapshot: () => ({ sessions: { [`group:room:${routes.get(id).roomId}`]: routes.get(id).sessionId } }) }),
    coreController: { describeDeliveryAccount: account, async sendScheduledPart(botId, target, part) {
      assert.equal(part.kind, 'text');
      delivered.push({ botId, roomId: target.route.roomId, text: part.text });
      if (delivered.length === 2) sent.resolve();
      return receipt(`$sent${delivered.length}`);
    } },
  }));
  const host = ctx.plugin(createImHostPlugin(internals(im)), { dshHome: root });
  await host.await();
  const state = JSON.parse(await readFile(join(root, 'integrations', 'dsh-matrix', 'schedule-replies.json'), 'utf8'));
  assert.equal(state.sessions.length, 2);
  await emitTurn(ctx, 1, 'legacy reminder', 'one');
  await emitTurn(ctx, 1, 'v12 reminder', 'two');
  await sent.promise;
  await host.dispose();
  assert.deepEqual(delivered.sort((a, b) => a.botId.localeCompare(b.botId)), [
    { botId: 'matrix_one', roomId: routes.get('matrix_one').roomId, text: 'legacy reminder' },
    { botId: 'matrix_two', roomId: routes.get('matrix_two').roomId, text: 'v12 reminder' },
  ]);
});

test('Matrix startup rollback does not wait for a post-activation consumer', async (t) => {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  ctx.provide('connection', { fetch: { register: () => () => {} } });
  let drains = 0;
  let closes = 0;
  await installProductionChannel(ctx, {
    beforeClose: async () => { drains += 1; throw new Error('consumer-not-started'); },
  }, {
    channel: 'matrix', rpcChannel: '/relay-rollback-test',
    createProduction: async () => ({ controller: {}, close: async () => { closes += 1; } }),
    createHandler: () => { throw new Error('startup-handler-failure'); },
    reportStartupError: () => ({ code: 'expected-startup-failure' }),
  });
  assert.equal(drains, 0);
  assert.equal(closes, 1);
});

test('Matrix channel shutdown drains accepted replies before withdrawing its adapter', { timeout: 10_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-im-relay-provider-'));
  const ctx = new Context();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const drainEntered = Promise.withResolvers();
  const providerClosed = Promise.withResolvers();
  let closed = false;
  let sent = 0;
  t.after(async () => { release.resolve(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); });
  ctx.provide('connection', { fetch: { register: () => () => {} } });
  ctx.provide('credentials', {});
  ctx.provide('typertGateway', { stream() {} });
  ctx.provide('sessionController', {});
  ctx.provide('workspaceController', {});
  const im = createDeliveryService();
  const adapter = createDeliveryAdapter({
    channel: 'matrix', workspaces: { has: (id) => id === 'matrix_one', listBotIds: () => ['matrix_one'] },
    stateFor: async () => ({ snapshot: () => ({ sessions: { 'group:room:!one:example.org': 'one' } }) }),
    coreController: { describeDeliveryAccount: account, async sendScheduledPart() { entered.resolve(); await release.promise; assert.equal(closed, false); sent += 1; return receipt(); } },
  });
  const options = internals(im);
  options.applyMatrix = (scope, config) => installProductionChannel(scope, {
    ...config,
    beforeClose: async () => { drainEntered.resolve(); await config.beforeClose?.(); },
  }, {
    channel: 'matrix', rpcChannel: '/relay-provider-test',
    createProduction: async () => ({ controller: {}, deliveryAdapter: adapter, close: async () => { closed = true; providerClosed.resolve(); } }),
    createHandler: () => async () => ({ ok: true }),
  });
  const host = ctx.plugin(createImHostPlugin(options), { dshHome: root });
  await host.await();
  await emitTurn(ctx, 1, 'must finish before Matrix shutdown');
  await entered.promise;
  const closing = host.dispose();
  try {
    const drainFirst = await Promise.race([drainEntered.promise.then(() => true), providerClosed.promise.then(() => false)]);
    assert.equal(drainFirst, true, 'channel close must await the relay drain hook');
    assert.equal(closed, false);
  } finally {
    release.resolve();
    await closing;
  }
  assert.equal(sent, 1);
  assert.equal(closed, true);
});

test('the actual dsh-im Host replies without a second plugin and drains the reply on unload', { timeout: 10_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-im-built-in-relay-'));
  const ctx = new Context();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.after(async () => { release.resolve(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); });
  ctx.provide('connection', { fetch: { register: () => () => {} } });
  ctx.provide('credentials', {});
  ctx.provide('typertGateway', { stream() {} });
  ctx.provide('sessionController', {});
  ctx.provide('workspaceController', {});
  const sends = [];
  const im = createDeliveryService();
  im.registerAdapter(createDeliveryAdapter({
    channel: 'matrix',
    workspaces: { has: (id) => id === 'matrix_one', listBotIds: () => ['matrix_one'] },
    stateFor: async () => ({ snapshot: () => ({ sessions: { 'group:room:!one:example.org': 'one' } }) }),
    coreController: { describeDeliveryAccount: account, async sendScheduledPart(botId, target, part) {
      entered.resolve(); await release.promise; sends.push({ botId, target, text: part.text }); return receipt();
    } },
  }));
  const host = ctx.plugin(createImHostPlugin(internals(im)), { dshHome: root });
  await host.await();
  await emitTurn(ctx, 1, 'built-in reminder reply');
  await entered.promise;
  let disposed = false;
  const closing = host.dispose().then(() => { disposed = true; });
  await Promise.resolve();
  assert.equal(disposed, false);
  release.resolve();
  await closing;
  assert.equal(sends.length, 1);
  assert.equal(sends[0].text, 'built-in reminder reply');
  assert.equal(sends[0].target.route.roomId, '!one:example.org');
  const path = join(root, 'integrations', 'dsh-matrix', 'schedule-replies.json');
  const before = await readFile(path, 'utf8');
  await emitTurn(ctx, 2, 'must not send after unload');
  assert.equal(await readFile(path, 'utf8'), before);
  assert.equal(sends.length, 1);
});

async function installedRelayFixture(t, { send, describeAccount = account } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'relay-host-admission-'));
  const ctx = new Context();
  const registry = new OutboundArtifactRegistry();
  const calls = [];
  const im = createDeliveryService();
  let owned = true;
  const unregister = im.registerAdapter(createDeliveryAdapter({
    channel: 'matrix', workspaces: { has: () => owned, listBotIds: () => owned ? ['matrix_one'] : [] },
    stateFor: async () => ({ snapshot: () => ({ sessions: { 'group:room:!one:example.org': 'one' } }) }),
    coreController: { describeDeliveryAccount: describeAccount, async sendScheduledPart(...args) {
      calls.push(args);
      return send ? send(...args) : receipt();
    } },
  }));
  const relay = await installScheduleRelay(ctx, im, { dshHome: root, registry, logger: { warn() {} } });
  t.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); });
  const session = { id: 'one', header: { id: 'one', cwd: root } };
  async function begin(turn = 1, decision = { kind: 'enter' }) {
    ctx.emit('session/event', session, { type: 'turn/start', data: { turn } });
    const message = { id: `schedule:${turn}`, source: { kind: 'schedule' } };
    ctx.emit('agent/inbox/claimed', { agent: { session }, turn, message });
    assert.equal(await ctx.waterfall('agent/pre-step', { agent: { session }, turn, signal: new AbortController().signal }, async () => decision), decision);
    ctx.emit('session/event', session, { type: 'user/message', surfaceOp: 'append', data: message });
  }
  async function stage(name) {
    await writeFile(join(root, name), name);
    const artifact = await registry.stage({ path: name }, { agent: { session }, callId: name });
    assert.ok(registry.commit(artifact));
    return artifact;
  }
  function finish(turn = 1, text = 'answer') {
    ctx.emit('session/event', session, { type: 'assistant/message', surfaceOp: 'append', data: { turn, message: { content: [{ type: 'text', text }] } } });
    ctx.emit('session/event', session, { type: 'turn/end', data: { turn, reason: 'completed' } });
  }
  return { ctx, root, relay, registry, im, calls, session, begin, stage, finish, unregister, removeAccount() { owned = false; } };
}

test('Host synchronous claims and awaited pre-step authorize next turn while previous delivery tail is suspended', { timeout: 10_000 }, async (t) => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(() => release.resolve());
  const f = await installedRelayFixture(t, { send: async (_bot, _target, part) => {
    if (part.kind === 'text') { entered.resolve(); await release.promise; return receipt('$first-text'); }
    return { ...receipt(`$image${part.artifact.origin.turn}`), artifacts: [{ artifactId: part.artifact.artifactId, outcome: 'sent' }] };
  } });
  await f.begin(1);
  assert.equal(f.registry.hasActiveConsumer(f.session), true);
  const first = await f.stage('first.png');
  f.finish(1);
  await entered.promise;
  await f.begin(2);
  assert.equal(f.registry.hasActiveConsumer(f.session), true, 'turn/start and claim must not wait for the delivery tail');
  const second = await f.stage('second.png');
  assert.equal(second.origin.turn, 2);
  assert.equal(isManagedOutboundArtifact(first), true);
  f.finish(2, '');
  release.resolve();
  await f.relay.whenIdle();
  assert.deepEqual(f.calls.map((call) => call[2].kind === 'text' ? call[2].text : call[2].artifact), ['answer', first, second]);
  assert.equal(isManagedOutboundArtifact(first), false);
  assert.equal(isManagedOutboundArtifact(second), false);
});

test('Host pre-step keeps the next waterfall veto and does not grant a lease', async (t) => {
  const f = await installedRelayFixture(t);
  const decision = { kind: 'blocked', reason: 'test veto' };
  await f.begin(1, decision);
  assert.equal(f.registry.hasActiveConsumer(f.session), false);
  f.finish();
  await f.relay.whenIdle();
  assert.equal(f.calls.length, 0);
});

for (const change of ['delete-account', 'replace-account', 'withdraw-adapter']) test(`Host ${change} between parts prevents every later native side effect`, async (t) => {
  let fingerprint = 'a'.repeat(64);
  let f;
  f = await installedRelayFixture(t, {
    describeAccount: (botId) => ({ ...account(botId), account: { fingerprint } }),
    send: async (_bot, _target, part) => {
      assert.equal(part.kind, 'text');
      if (change === 'delete-account') f.removeAccount();
      if (change === 'replace-account') fingerprint = 'b'.repeat(64);
      if (change === 'withdraw-adapter') f.unregister();
      return receipt('$text-before-change');
    },
  });
  await f.begin();
  const artifact = await f.stage('must-not-retarget.png');
  f.finish();
  await f.relay.whenIdle();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0][1], { kind: 'room', route: { roomId: '!one:example.org' } });
  const disk = JSON.parse(await readFile(join(f.root, 'integrations', 'dsh-matrix', 'schedule-replies.json'), 'utf8'));
  assert.deepEqual(disk.sessions[0].lastAttempt.parts.map((part) => part.status), ['sent', 'failed']);
  assert.equal(disk.sessions[0].lastAttempt.parts[1].error, {
    'delete-account': 'unknown-bot', 'replace-account': 'account-changed', 'withdraw-adapter': 'capability-unavailable',
  }[change]);
  assert.equal(disk.sessions[0].lastAttempt.status, 'failed');
  assert.equal(isManagedOutboundArtifact(artifact), false);
});
