import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import * as storeModule from '../plugin-src/host/schedule-relay-store.mjs';
import * as relayModule from '../plugin-src/host/schedule-relay-coordinator.mjs';
import { OutboundArtifactRegistry } from '../src/channels/shared/semantic/artifact.mjs';
const DEST = { botId: 'matrix_one', kind: 'room', route: { roomId: '!one:example.org' } };
const OTHER = { botId: 'matrix_one', kind: 'room', route: { roomId: '!other:example.org' } };
const THREAD = { botId: 'matrix_one', kind: 'thread', route: { roomId: '!two:example.org', threadId: '$root' } };

async function fixture(t, initial = [{ sessionId: 'one', ...DEST }]) {
  assert.equal(typeof storeModule.RelayStore?.open, 'function');
  assert.equal(typeof relayModule.createScheduleRelay, 'function');
  const root = await mkdtemp(join(tmpdir(), 'schedule-im-relay-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'state.json');
  const store = await storeModule.RelayStore.open(path);
  let bindings = initial;
  const sends = [];
  const warnings = [];
  let send = async (...args) => { sends.push(args); return { sent: true }; };
  const im = {
    async listBots() { return [{ botId: 'matrix_one', channel: 'matrix' }, { botId: 'not-matrix', channel: 'feishu' }]; },
    async listConversationBindings(botId) {
      assert.equal(botId, 'matrix_one');
      return { botId, channel: 'matrix', bindings: bindings.map(({ botId: _botId, ...entry }) => entry) };
    },
    async authorizeScheduledTarget() { return Object.freeze({}); },
    async sendScheduledPart(botId, target, part, options) {
      const result = await send(botId, target, part.text, options);
      return result?.sent === true ? { deliveryOutcome: 'sent', providerMessageIds: ['$sent'] } : result;
    },
  };
  const registry = new OutboundArtifactRegistry();
  const relay = relayModule.createScheduleRelay({ im, store, registry, logger: { warn: (text) => warnings.push(text) } });
  t.after(async () => { await relay.close(); await store.close(); });
  await relay.captureBindings();
  return { relay, store, path, im, sends, warnings, setBindings(value) { bindings = value; }, setSend(value) { send = value; } };
}

function input(kind = 'schedule') {
  return { type: 'user/message', surfaceOp: 'append', data: { source: { kind }, content: [{ type: 'text', text: 'internal reminder prompt' }] } };
}
function answer(text, turn = 1) {
  return { type: 'assistant/message', surfaceOp: 'append', data: { turn, message: { role: 'assistant', content: [{ type: 'text', text }] } } };
}
async function claim(relay, sessionId = 'one', kind = 'schedule', number = 1) {
  const event = input(kind);
  event.data.id = `${sessionId}:${number}:${kind}`;
  const session = { id: sessionId };
  relay.observeClaim(session, event.data, number);
  await relay.preStep({ agent: { session }, turn: number, signal: new AbortController().signal });
  await relay.observeEvent(session, event);
}
async function turn(relay, sessionId = 'one', { number = 1, kind = 'schedule', text = 'hello room', reason = 'completed' } = {}) {
  await relay.observeEvent(sessionId, { type: 'turn/start', data: { turn: number } });
  await claim(relay, sessionId, kind, number);
  await relay.enqueue(sessionId, answer(text, number));
  await relay.enqueue(sessionId, { type: 'turn/end', data: { turn: number, reason: { kind: reason } } });
}

test('a schedule final answer reaches its Matrix room without saved targets or Session sync', async (t) => {
  const f = await fixture(t);
  await turn(f.relay);
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0][0], 'matrix_one');
  assert.deepEqual(f.sends[0][1], { kind: 'room', route: DEST.route });
  assert.equal(f.sends[0][2], 'hello room');
  assert.equal(f.sends[0][3].format, 'markdown');
  assert.equal(f.store.get('one').lastAttempt.status, 'sent');
});

test('different rooms and threads keep separate destinations and only the final answer is sent', async (t) => {
  const f = await fixture(t, [{ sessionId: 'one', ...DEST }, { sessionId: 'two', ...THREAD }]);
  await f.relay.enqueue('two', { type: 'turn/start', data: { turn: 1 } });
  await claim(f.relay, 'two');
  await f.relay.enqueue('two', answer('intermediate tool explanation'));
  await f.relay.enqueue('two', answer('final thread answer'));
  await f.relay.enqueue('two', { type: 'turn/end', data: { turn: 1, reason: 'completed' } });
  await turn(f.relay);
  assert.deepEqual(f.sends.map((entry) => [entry[1], entry[2]]), [
    [{ kind: 'thread', route: THREAD.route }, 'final thread answer'],
    [{ kind: 'room', route: DEST.route }, 'hello room'],
  ]);
});

test('ordinary chats, failed turns, interrupted attempts, empty answers and unbound Sessions do not relay', async (t) => {
  const f = await fixture(t);
  await turn(f.relay, 'one', { number: 1, kind: 'user' });
  await turn(f.relay, 'one', { number: 2, reason: 'error' });
  await turn(f.relay, 'one', { number: 3, text: '   ' });
  await turn(f.relay, 'unbound', { number: 1 });
  await f.relay.enqueue('one', { type: 'turn/start', data: { turn: 4 } });
  await claim(f.relay, 'one', 'schedule', 4);
  await f.relay.enqueue('one', { ...answer('partial', 4), data: { ...answer('partial', 4).data, interrupted: true } });
  await f.relay.enqueue('one', { type: 'turn/end', data: { turn: 4, reason: 'completed' } });
  assert.deepEqual(f.sends, []);
});

test('a new Session for the same room does not remove the old Session reply route', async (t) => {
  const f = await fixture(t);
  f.setBindings([{ sessionId: 'new', ...DEST }]);
  await f.relay.captureBindings();
  await turn(f.relay, 'one');
  await turn(f.relay, 'new');
  assert.equal(f.sends.length, 2);
  assert.ok(f.sends.every((entry) => entry[1].route.roomId === '!one:example.org'));
});

test('one Session bound to different rooms is reported as a conflict rather than broadcast', async (t) => {
  const f = await fixture(t, [{ sessionId: 'one', ...DEST }, { sessionId: 'one', ...OTHER }]);
  await turn(f.relay);
  assert.deepEqual(f.sends, []);
  assert.equal(f.store.get('one').conflict, true);
  assert.ok(f.warnings.some((text) => text.includes('binding-conflict')));
});

test('restart retains old routes and does not repeat a previously attempted turn', async (t) => {
  const f = await fixture(t);
  await turn(f.relay);
  await f.relay.close();
  await f.store.close();
  const restored = await storeModule.RelayStore.open(f.path);
  const relay = relayModule.createScheduleRelay({ im: f.im, store: restored });
  t.after(async () => { await relay.close(); await restored.close(); });
  f.setBindings([]);
  await turn(relay);
  assert.equal(f.sends.length, 1);
  await turn(relay, 'one', { number: 2 });
  assert.equal(f.sends.length, 2);
});

test('sending is recorded before the platform call and unknown outcomes are not retried', async (t) => {
  const f = await fixture(t);
  f.setSend(async () => {
    const persisted = JSON.parse(await readFile(f.path, 'utf8'));
    assert.equal(persisted.sessions[0].lastAttempt.status, 'sending');
    throw Object.assign(new Error('provider secret detail'), { code: 'send-result-unknown' });
  });
  await turn(f.relay);
  assert.equal(f.store.get('one').lastAttempt.status, 'unknown');
  assert.ok(f.warnings.some((text) => text.includes('send-result-unknown')));
  assert.ok(f.warnings.every((text) => !text.includes('provider secret detail')));
  await turn(f.relay);
  assert.equal(f.store.get('one').lastAttempt.status, 'unknown');
});

test('a persisted sending state after a crash is not resent', async (t) => {
  const f = await fixture(t);
  await f.store.attempt('one', 1);
  await turn(f.relay);
  assert.deepEqual(f.sends, []);
});

test('close drains accepted sends, rejects new work, and does not lose an in-flight answer', async (t) => {
  const f = await fixture(t);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  f.setSend(async (...args) => { entered.resolve(); await release.promise; f.sends.push(args); return { sent: true }; });
  const sending = turn(f.relay);
  await entered.promise;
  let closed = false;
  const closing = f.relay.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  release.resolve();
  await sending;
  await closing;
  await turn(f.relay, 'one', { number: 2 });
  assert.equal(f.sends.length, 1);
});

test('automatic Host runtime context snapshots do not suppress the scheduled answer', async (t) => {
  const f = await fixture(t);
  await f.relay.enqueue('one', { type: 'turn/start', data: { turn: 1 } });
  const context = {
    type: 'user/message', surfaceOp: 'append',
    data: { source: { kind: 'runtime-context', form: 'snapshot', sections: [] }, content: [{ type: 'text', text: 'Host-only runtime information' }] },
  };
  await f.relay.enqueue('one', context);
  await claim(f.relay, 'one', 'schedule', 1);
  await f.relay.enqueue('one', answer('scheduled final answer'));
  await f.relay.enqueue('one', context);
  await f.relay.enqueue('one', { type: 'turn/end', data: { turn: 1, reason: 'completed' } });
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0][2], 'scheduled final answer');
  assert.ok(!f.warnings.some((text) => text.includes('mixed-input')));
});

test('a scheduled turn with a normal user input does not send a second ordinary-chat reply', async (t) => {
  const f = await fixture(t);
  await f.relay.enqueue('one', { type: 'turn/start', data: { turn: 1 } });
  await claim(f.relay, 'one', 'schedule', 1);
  await claim(f.relay, 'one', 'user');
  await f.relay.enqueue('one', answer('combined answer'));
  await f.relay.enqueue('one', { type: 'turn/end', data: { turn: 1, reason: 'completed' } });
  assert.deepEqual(f.sends, []);
  assert.ok(f.warnings.some((text) => text.includes('mixed-input')));
});
