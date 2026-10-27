import test from 'node:test';
import { deepStrictEqual, ok, throws } from 'node:assert';

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
