import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeliveryAdapter } from '../plugin-src/host/delivery-adapter.mjs';
import { createDeliveryService } from '../plugin-src/host/delivery-service.mjs';

function fixture() {
  const state = { sessions: {
    'group:room:!one:example.org': 'session-one',
    'group:room:!two:example.org$$root': 'session-two',
    'direct:dm:@alice:example.org': 'session-dm',
    'group:room:!empty:example.org': '',
    'group:room:!invalid:example.org': { secret: 'not-a-session' },
    'group:bad-key': 'session-invalid',
  }, accessToken: 'secret-never-exported' };
  const adapter = createDeliveryAdapter({
    channel: 'matrix',
    workspaces: { has: (id) => id === 'matrix_one', listBotIds: () => ['matrix_one'] },
    coreController: {},
    stateFor: async () => ({ snapshot: () => structuredClone(state) }),
  });
  const service = createDeliveryService();
  const dispose = service.registerAdapter(adapter);
  return { service, adapter, state, dispose };
}

const EXPECTED = [
  { sessionId: 'session-one', kind: 'room', route: { roomId: '!one:example.org' } },
  { sessionId: 'session-two', kind: 'thread', route: { roomId: '!two:example.org', threadId: '$root' } },
  { sessionId: 'session-dm', kind: 'dm', route: { userId: '@alice:example.org' } },
];

test('conversation binding query exposes current Session destinations without saved targets or secrets', async () => {
  const { service } = fixture();
  assert.equal(typeof service.listConversationBindings, 'function');
  const result = await service.listConversationBindings('matrix_one');
  assert.deepEqual(result, { botId: 'matrix_one', channel: 'matrix', bindings: EXPECTED });
  assert.equal(JSON.stringify(result).includes('secret'), false);
  result.bindings[0].route.roomId = '!changed:example.org';
  assert.deepEqual((await service.listConversationBindings('matrix_one')).bindings, EXPECTED);
});

test('conversation binding query follows new Session bindings and retains ambiguous candidates for the consumer', async () => {
  const { service, state } = fixture();
  assert.equal(typeof service.listConversationBindings, 'function');
  state.sessions['group:room:!one:example.org'] = 'session-new';
  state.sessions['group:room:!other:example.org'] = 'session-new';
  const { bindings } = await service.listConversationBindings('matrix_one');
  assert.deepEqual(bindings.filter((entry) => entry.sessionId === 'session-new'), [
    { sessionId: 'session-new', kind: 'room', route: { roomId: '!one:example.org' } },
    { sessionId: 'session-new', kind: 'room', route: { roomId: '!other:example.org' } },
  ]);
});

test('conversation binding reads fail visibly and cannot outlive their adapter registration', async () => {
  const { service, adapter, dispose } = fixture();
  assert.equal(typeof service.listConversationBindings, 'function');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const entered = Promise.withResolvers();
  dispose();
  const base = { ...adapter, listConversationBindings: async () => { entered.resolve(); await gate; return EXPECTED; } };
  const stop = service.registerAdapter(base);
  const pending = service.listConversationBindings('matrix_one');
  await entered.promise;
  stop();
  release();
  await assert.rejects(pending, { code: 'capability-unavailable' });
  service.registerAdapter({ ...adapter, listConversationBindings: async () => { throw new Error('private disk path'); } });
  await assert.rejects(service.listConversationBindings('matrix_one'), (error) => error.code === 'delivery-failed' && !error.message.includes('private'));
  await assert.rejects(service.listConversationBindings('../bad'), { code: 'bad-request' });
  await assert.rejects(service.listConversationBindings('unknown'), { code: 'unknown-bot' });
});
