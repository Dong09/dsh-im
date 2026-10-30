import test from 'node:test';
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
  const calls = [];
  const account = { homeserver: 'https://matrix.example.org', userId: '@bot:example.org', deviceId: 'DEVICE', fingerprint: 'a'.repeat(64) };
  const runtime = runtimeStub({
    describeDeliveryAccount: () => ({ ...account }),
    sendProactiveImage() {}, sendProactiveFile() {},
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
  return { ...fx, runtime, account, calls, sessions, adapter, service, target, authorization,
    send: (text) => service.sendScheduledPart(fx.identity.botId, target, { kind: 'text', text }, { authorization }) };
}

test('Matrix scheduled old-session route stays in its original thread after a room switches Session', async (t) => {
  const f = await frozenControllerDelivery(t);
  f.sessions['room:!old:example.org$$old-thread:example.org'] = 'new-session';
  deepStrictEqual(await f.send('old scheduled result'), { deliveryOutcome: 'sent', providerMessageIds: ['$frozen-1:example.org'] });
  deepStrictEqual(f.calls, [{ target: f.target, text: 'old scheduled result' }]);
});

test('Matrix scheduled parts reject removed account changed identity and replacement registration without retargeting', async (t) => {
  for (const change of ['removed', 'account', 'registration', 'configured-device']) {
    const f = await frozenControllerDelivery(t);
    await f.send('first part');
    if (change === 'removed') await f.controller.deleteBot(f.identity.botId);
    if (change === 'account') f.account.fingerprint = 'b'.repeat(64);
    if (change === 'registration') f.service.registerAdapter(f.adapter);
    if (change === 'configured-device') await f.configStore.save({ ...f.configStore.get(f.identity.botId), deviceId: 'REPLACED' });
    await rejects(f.send('never reroute'), { code: { removed: 'unknown-bot', account: 'account-changed',
      registration: 'capability-unavailable', 'configured-device': 'account-changed' }[change] });
    equal(f.calls.length, 1, change);
    deepStrictEqual(f.calls[0].target, f.target);
  }
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
