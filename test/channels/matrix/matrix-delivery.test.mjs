import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OutboundArtifactRegistry, releaseOutboundArtifact } from '../../../src/channels/shared/semantic/artifact.mjs';
import { deepStrictEqual, equal, ok, rejects, throws } from 'node:assert';
import { createDeliveryAdapter } from '../../../plugin-src/host/delivery-adapter.mjs';
import { createDeliveryService } from '../../../plugin-src/host/delivery-service.mjs';
import { controllerFixture, runtimeStub } from './fixtures/controller-fixture.mjs';

import {
  deliverySuggestionFromConversationKey,
  deliverySuggestionsFromSessions,
  privateConversationKeyMatchesTarget,
  privateDeliverySuggestionFromConversationKey,
  resolvePrivateConversationKey,
} from '../../../plugin-src/host/delivery-suggestions.mjs';
import {
  normalizeDeliveryTarget,
  supportsDeliveryChannel,
} from '../../../plugin-src/host/delivery-adapter.mjs';

test('matrix conversation keys yield stable delivery routes in both directions', () => {
  deepStrictEqual(supportsDeliveryChannel('matrix'), true);
  deepStrictEqual(deliverySuggestionFromConversationKey('matrix', 'dm:@Alice:Example.org'),
    { kind: 'dm', route: { userId: '@Alice:Example.org' } });
  deepStrictEqual(deliverySuggestionFromConversationKey('matrix', 'room:!roomA:example.org'),
    { kind: 'room', route: { roomId: '!roomA:example.org' } });
  deepStrictEqual(
    deliverySuggestionFromConversationKey('matrix', 'room:!roomA:example.org$$thread1:example.org'),
    { kind: 'thread', route: { roomId: '!roomA:example.org', threadId: '$thread1:example.org' } },
  );
  deepStrictEqual(deliverySuggestionFromConversationKey('matrix', 'group:nope'), null);
  deepStrictEqual(deliverySuggestionFromConversationKey('matrix', 'room:not-a-room'), null);
});

test('private delivery helpers keep dm keys and reject room keys', () => {
  deepStrictEqual(privateDeliverySuggestionFromConversationKey('matrix', 'dm:@u:example.org'),
    { kind: 'dm', route: { userId: '@u:example.org' } });
  deepStrictEqual(privateDeliverySuggestionFromConversationKey('matrix', 'room:!r:example.org'), null);
  deepStrictEqual(
    privateConversationKeyMatchesTarget('matrix', 'dm:@u:example.org',
      { kind: 'dm', route: { userId: '@u:example.org' } }),
    true,
  );
  deepStrictEqual(
    resolvePrivateConversationKey('matrix',
      { 'dm:@u:example.org': 'sess-1', 'room:!r:example.org': 'sess-2' },
      { kind: 'dm', route: { userId: '@u:example.org' } }),
    'dm:@u:example.org',
  );
  deepStrictEqual(
    resolvePrivateConversationKey('matrix', { 'dm:@u:example.org': '' },
      { kind: 'dm', route: { userId: '@u:example.org' } }),
    null,
    'sessions without a live session id are not deliverable',
  );
  deepStrictEqual(
    deliverySuggestionsFromSessions('matrix', {
      'dm:@u:example.org': 's1',
      'room:!r:example.org': 's2',
      'room:!r:example.org$$threadA:x': 's3',
      'thread:bogus': 'ignored',
    }),
    [
      { kind: 'dm', route: { userId: '@u:example.org' } },
      { kind: 'room', route: { roomId: '!r:example.org' } },
      { kind: 'thread', route: { roomId: '!r:example.org', threadId: '$threadA:x' } },
    ],
  );
});

test('the delivery adapter enforces the matrix target grammar', async () => {
  deepStrictEqual(
    normalizeDeliveryTarget('matrix', { kind: 'room', route: { roomId: '!r:example.org:8448' } },
      { targetIdRequired: false }),
    { kind: 'room', route: { roomId: '!r:example.org:8448' } },
  );
  deepStrictEqual(
    normalizeDeliveryTarget('matrix', { kind: 'dm', route: { userId: '@bot:example.org' } },
      { targetIdRequired: false }),
    { kind: 'dm', route: { userId: '@bot:example.org' } },
  );
  deepStrictEqual(
    normalizeDeliveryTarget('matrix',
      { kind: 'thread', route: { roomId: '!r:example.org', threadId: '$thr:example.org' } },
      { targetIdRequired: false }),
    { kind: 'thread', route: { roomId: '!r:example.org', threadId: '$thr:example.org' } },
  );
  async function expectInvalidTarget(run, label) {
    let caught = null;
    try {
      await run();
    } catch (error) {
      caught = error;
    }
    ok(caught?.code === 'invalid-target', `${label}: got ${caught?.code ?? 'no error'}`);
  }
  const badCases = [
    [{ kind: 'dm', route: { userId: 'bot:example.org' } }, 'user id'],
    [{ kind: 'room', route: { roomId: 'r:example.org' } }, 'room id'],
    [{ kind: 'thread', route: { roomId: '!r:example.org', threadId: 'thr' } }, 'thread id'],
    [{ kind: 'space', route: { roomId: '!r:example.org' } }, 'unknown kind'],
  ];
  await Promise.all(badCases.map(([target, label]) => expectInvalidTarget(
    () => normalizeDeliveryTarget('matrix', target, { targetIdRequired: false }),
    `${label} must be rejected`,
  )));
});

async function frozenControllerDelivery(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-matrix-delivery-'));
  const registry = new OutboundArtifactRegistry();
  t.after(async () => { registry.clear(); await rm(directory, { recursive: true, force: true }); });
  const session = { header: { id: 'scheduled-session', cwd: directory }, events: [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { turn: 1, source: { rpcId: 'scheduled-rpc' } } },
  ] };
  t.after(registry.openConsumer('scheduled-session', 'scheduled-rpc'));
  for (const event of session.events) registry.observeSessionEvent(session, event);
  const bytes = Buffer.from([0, 2, 255]);
  await writeFile(join(directory, 'original.png'), bytes);
  const staged = await registry.stage({ path: 'original.png' }, { agent: { session }, callId: 'file' });
  registry.commit(staged);
  const next = await registry.stage({ path: 'original.png' }, { agent: { session }, callId: 'next-file' });
  registry.commit(next);
  const artifacts = registry.take('scheduled-session', 1);
  const artifact = artifacts[0];
  const ownedArtifacts = [...artifacts];
  t.after(() => ownedArtifacts.forEach(releaseOutboundArtifact));
  const calls = [];
  const account = { homeserver: 'https://matrix.example.org', userId: '@bot:example.org', deviceId: 'DEVICE', fingerprint: 'a'.repeat(64) };
  const runtime = runtimeStub({
    describeDeliveryAccount: () => ({ ...account }),
    async sendProactiveImage(target, file, options) {
      await options.beforeSend();
      calls.push({ target, fileName: file.fileName, bytes: file.bytes });
      return { providerMessageIds: [`$frozen-${calls.length}:example.org`] };
    },
    async sendProactiveFile() { throw new Error('unexpected file fallback'); },
    async sendProactiveText(target, text, options) {
      await options.beforeSend();
      calls.push({ target, text });
      return { providerMessageIds: [`$frozen-${calls.length}:example.org`] };
    },
  });
  const fx = await controllerFixture(t, { createRuntime: () => runtime });
  await fx.controller.initialize();
  const sessions = { 'room:!old:example.org$$old-thread:example.org': 'old-session' };
  const adapter = createDeliveryAdapter({ channel: 'matrix', coreController: fx.controller,
    workspaces: { has: (botId) => Boolean(fx.configStore.get(botId)), listBotIds: () => [fx.identity.botId] },
    stateFor: () => ({ snapshot: () => ({ sessions }) }) });
  const service = createDeliveryService();
  service.registerAdapter(adapter);
  const target = { kind: 'thread', route: { roomId: '!old:example.org', threadId: '$old-thread:example.org' } };
  const authorization = await service.authorizeScheduledTarget(fx.identity.botId, target);
  return { ...fx, runtime, account, calls, sessions, adapter, service, target, authorization, artifact, bytes,
    send: () => service.sendScheduledPart(fx.identity.botId, target, { kind: 'artifact', artifact: artifacts.shift() }, { authorization }) };
}

test('Matrix scheduled old-session route stays in its original thread after a room switches Session', async (t) => {
  const f = await frozenControllerDelivery(t);
  f.sessions['room:!old:example.org$$old-thread:example.org'] = 'new-session';
  const result = await f.send();
  equal(result.deliveryOutcome, 'sent');
  deepStrictEqual(result.providerMessageIds, ['$frozen-1:example.org']);
  deepStrictEqual(result.artifacts, [{ artifactId: f.artifact.artifactId, outcome: 'sent' }]);
  deepStrictEqual(f.calls, [{ target: f.target, fileName: 'original.png', bytes: f.bytes }]);
});

test('Matrix scheduled parts reject removed account changed identity and replacement registration without retargeting', async (t) => {
  for (const change of ['removed', 'account', 'registration', 'configured-device']) {
    const f = await frozenControllerDelivery(t);
    await f.send();
    if (change === 'removed') await f.controller.deleteBot(f.identity.botId);
    if (change === 'account') f.account.fingerprint = 'b'.repeat(64);
    if (change === 'registration') f.service.registerAdapter(f.adapter);
    if (change === 'configured-device') await f.configStore.save({ ...f.configStore.get(f.identity.botId), deviceId: 'REPLACED' });
    await rejects(f.send(), { code: { removed: 'unknown-bot', account: 'account-changed',
      registration: 'capability-unavailable', 'configured-device': 'account-changed' }[change] });
    equal(f.calls.length, 1, change);
    deepStrictEqual(f.calls[0].target, f.target);
  }
});

test('Matrix controller rejects text paths URLs bytes and forged artifacts before any native side effect', async (t) => {
  const f = await frozenControllerDelivery(t);
  for (const part of [
    { kind: 'text', text: 'valid text is rejected' },
    { kind: 'artifact', path: 'original.png' },
    { kind: 'artifact', artifact: { ...f.artifact } },
    { kind: 'artifact', artifact: { path: 'original.png' } },
    { kind: 'artifact', artifact: 'https://example.org/image.png' },
    { kind: 'artifact', artifact: Buffer.from([1]) },
    { kind: 'artifact', artifact: f.artifact, path: 'extra' },
  ]) {
    await rejects(f.controller.sendScheduledPart(f.identity.botId, f.target, part,
      { expectedFingerprint: f.account.fingerprint }), { code: 'bad-request' });
  }
  deepStrictEqual(f.calls, []);
  equal((await f.send()).deliveryOutcome, 'sent', 'rejected requests did not consume the real artifact');
});

test('Matrix scheduled account discovery rejects unverified runtime identities and incomplete media capability', async (t) => {
  const f = await frozenControllerDelivery(t);
  f.account.userId = '@someone-else:example.org';
  await rejects(f.service.authorizeScheduledTarget(f.identity.botId, f.target), { code: 'account-changed' });
  equal(f.calls.length, 0);
  f.account.userId = '@bot:example.org';
  f.runtime.sendProactiveImage = undefined;
  await rejects(f.service.authorizeScheduledTarget(f.identity.botId, f.target), { code: 'capability-unavailable' });
});

const V12_ROOM = '!KplB3ESm99I-4PaRdWxDUKr0Sia5nRhRtykpfs1VloM';

test('matrix protocol suggestions retain v12 room and thread routes', () => {
  deepStrictEqual(deliverySuggestionFromConversationKey('matrix', `room:${V12_ROOM}`),
    { kind: 'room', route: { roomId: V12_ROOM } });
  deepStrictEqual(deliverySuggestionFromConversationKey('matrix', `room:${V12_ROOM}$$thr:example.org`),
    { kind: 'thread', route: { roomId: V12_ROOM, threadId: '$thr:example.org' } });
});

test('matrix protocol proactive targets accept v12 and legacy rooms', () => {
  for (const roomId of [V12_ROOM, '!r:example.org:8448']) {
    const room = { kind: 'room', route: { roomId } };
    const thread = { kind: 'thread', route: { roomId, threadId: '$thr:example.org' } };
    deepStrictEqual(normalizeDeliveryTarget('matrix', room, { targetIdRequired: false }), room);
    deepStrictEqual(normalizeDeliveryTarget('matrix', thread, { targetIdRequired: false }), thread);
  }
});

test('matrix protocol suggestions reject aliases and malformed room or thread identifiers', () => {
  for (const key of ['room:#alias:example.org', 'room:!short', `room:${V12_ROOM}$`,
    `room:${V12_ROOM}$$thr:example.org trailing`]) {
    deepStrictEqual(deliverySuggestionFromConversationKey('matrix', key), null, key);
  }
});

test('matrix protocol target validation checks the entire thread and user identifier', () => {
  for (const target of [
    { kind: 'room', route: { roomId: '#alias:example.org' } },
    { kind: 'room', route: { roomId: '!short' } },
    { kind: 'thread', route: { roomId: '!r:example.org', threadId: '$thr:example.org trailing' } },
    { kind: 'dm', route: { userId: '@bad@user:example.org' } },
  ]) {
    throws(() => normalizeDeliveryTarget('matrix', target, { targetIdRequired: false }),
      (error) => error.code === 'invalid-target');
  }
});
