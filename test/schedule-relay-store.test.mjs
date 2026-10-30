import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { destination, RelayStore } from '../plugin-src/host/schedule-relay-store.mjs';
import { createScheduleRelay } from '../plugin-src/host/schedule-relay-coordinator.mjs';
import { installScheduleRelay } from '../plugin-src/host/schedule-relay.mjs';
const DEST = { botId: 'matrix_one', kind: 'room', route: { roomId: '!one:example.org' } };
const filePart = (artifactId) => ({ id: `artifact:${artifactId}`, kind: 'artifact', artifactId,
  fileName: 'same.png', mediaType: 'image/png', size: 3, digest: 'a'.repeat(64) });

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-im-schedule-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('scheduled-reply routes accept canonical legacy and v12 room IDs and survive reload', async (t) => {
  const root = await temporary(t);
  const path = join(root, 'state.json');
  const v12 = { ...DEST, route: { roomId: `!${'a'.repeat(43)}` } };
  const thread = { ...v12, kind: 'thread', route: { ...v12.route, threadId: '$thread' } };
  assert.deepEqual(destination(v12), v12);
  assert.deepEqual(destination(thread), thread);
  const store = await RelayStore.open(path);
  await store.remember('legacy', [DEST]);
  await store.remember('v12', [v12]);
  await store.remember('thread', [thread]);
  await store.close();
  const restored = await RelayStore.open(path);
  try {
    assert.deepEqual(restored.get('legacy').destination, DEST);
    assert.deepEqual(restored.get('v12').destination, v12);
    assert.deepEqual(restored.get('thread').destination, thread);
  } finally { await restored.close(); }
});

test('scheduled-reply routes reject aliases malformed hashes and malformed thread events', () => {
  for (const roomId of ['#alias:example.org', `!${'a'.repeat(42)}`, '!bad room:example.org', '!bad:']) {
    assert.throws(() => destination({ ...DEST, route: { roomId } }), /invalid-destination/);
  }
  assert.throws(() => destination({ ...DEST, kind: 'thread', route: { ...DEST.route, threadId: '$bad event' } }), /invalid-destination/);
});

test('corrupt or duplicate persisted Sessions refuse startup instead of forgetting attempted sends', async (t) => {
  const root = await temporary(t);
  const path = join(root, 'state.json');
  await writeFile(path, '{bad json');
  await assert.rejects(RelayStore.open(path));
  const entry = { sessionId: 'one', destination: DEST, conflict: false };
  await writeFile(path, JSON.stringify({ version: 1, sessions: [entry, entry] }));
  await assert.rejects(RelayStore.open(path), /invalid-relay-state/);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).sessions.length, 2);
});

test('a failed checkpoint write does not publish sending or call the platform', async (t) => {
  const root = await temporary(t);
  const path = join(root, 'state.json');
  const store = await RelayStore.open(path);
  t.after(() => store.close());
  await store.remember('one', [DEST]);
  const saved = join(root, 'state.saved.json');
  assert.equal(path, join(root, 'state.json'));
  await rename(path, saved);
  await mkdir(path);
  let sends = 0;
  const warnings = [];
  const relay = createScheduleRelay({
    store,
    im: { listBots: async () => [], listConversationBindings: async () => ({}), authorizeScheduledTarget: async () => ({}),
      sendScheduledPart: async () => { sends += 1; return { deliveryOutcome: 'sent', providerMessageIds: ['$sent'] }; } },
    logger: { warn: (text) => warnings.push(text) },
  });
  try {
    await relay.enqueue('one', { type: 'turn/start', data: { turn: 1 } });
    relay.observeClaim({ id: 'one' }, { id: 'schedule-one', source: { kind: 'schedule' } }, 1);
    await relay.preStep({ agent: { session: { id: 'one' } }, turn: 1 });
    await relay.enqueue('one', { type: 'user/message', surfaceOp: 'append', data: { source: { kind: 'schedule' } } });
    await relay.enqueue('one', { type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, message: { content: [{ type: 'text', text: 'must not send' }] } } });
    await relay.enqueue('one', { type: 'turn/end', data: { turn: 1, reason: 'completed' } });
    assert.equal(sends, 0);
    assert.equal(store.get('one').lastAttempt, undefined);
    assert.ok(warnings.length > 0);
  } finally {
    await relay.close();
    assert.equal(path, join(root, 'state.json'));
    await rm(path, { recursive: true });
    await rename(saved, path);
  }
});

test('built-in installation rejects invalid timeouts and missing delivery capabilities', async (t) => {
  const root = await temporary(t);
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await assert.rejects(installScheduleRelay(ctx, {}, { dshHome: root, sendTimeoutMs: 0 }), /scheduleReplyTimeoutMs/);
  await assert.rejects(installScheduleRelay(ctx, {}, { dshHome: root }), /capability unavailable/);
});

test('v2 immutable manifests isolate equal filenames and late attempts, with independent receipts', async (t) => {
  const path = join(await temporary(t), 'state.json');
  const store = await RelayStore.open(path);
  t.after(() => store.close());
  await store.remember('one', [DEST]);
  const manifest = [{ id: 'text', kind: 'text' }, filePart('a'), filePart('b')];
  const first = await store.attempt('one', 1, manifest);
  manifest[1].fileName = 'modified.png';
  assert.equal(store.get('one').lastAttempt.parts[1].fileName, 'same.png');
  for (const [partId, status, ids] of [['text', 'sent', ['$text']], ['artifact:a', 'sent', ['$image']], ['artifact:b', 'failed', []]]) {
    await store.startPart('one', 1, first.attemptId, partId);
    await store.finishPart('one', 1, first.attemptId, partId, { status, providerMessageIds: ids });
  }
  assert.equal(store.get('one').lastAttempt.status, 'failed');
  assert.deepEqual(store.get('one').lastAttempt.parts.map((p) => p.providerMessageIds), [['$text'], ['$image'], []]);
  const next = await store.attempt('one', 2);
  await assert.rejects(store.finishPart('one', 1, first.attemptId, 'text', { status: 'sent', providerMessageIds: ['$late'] }), /checkpoint-changed/);
  await assert.rejects(store.startPart('one', 2, first.attemptId, 'text'), /checkpoint-changed/);
  assert.equal(store.get('one').lastAttempt.attemptId, next.attemptId);
  assert.equal(await store.attempt('one', 1), null);
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(saved.version, 2);
  assert.equal(saved.sessions[0].lastAttempt.parts[0].status, 'pending');
});

for (const status of ['sending', 'sent', 'failed', 'unknown']) {
  test(`v1 ${status} high-water survives backup, atomic v2 upgrade and reload`, async (t) => {
    const path = join(await temporary(t), 'state.json');
    const v12 = { ...DEST, kind: 'thread', route: { roomId: `!${'a'.repeat(43)}`, threadId: '$root' } };
    const document = { version: 1, sessions: [
      { sessionId: 'one', destination: DEST, conflict: false, lastAttempt: { turn: 8, status } },
      { sessionId: 'thread', destination: v12, conflict: true, lastAttempt: { turn: 9, status } },
    ] };
    const original = JSON.stringify(document, null, 2);
    await writeFile(path, original);
    const store = await RelayStore.open(path);
    assert.equal(await store.attempt('one', 8), null);
    assert.equal(await readFile(path, 'utf8'), original, 'read alone never migrates');
    await store.remember('new', [DEST]);
    assert.equal(await readFile(`${path}.v1.bak`, 'utf8'), original);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).version, 2);
    await store.close();
    const restored = await RelayStore.open(path);
    try {
      assert.equal(restored.get('one').lastAttempt.status, status);
      assert.equal(restored.get('thread').conflict, true);
      assert.deepEqual(restored.get('thread').destination, v12);
      assert.equal(await restored.attempt('one', 7), null);
      assert.equal(await restored.attempt('thread', 10), null);
    } finally { await restored.close(); }
  });
}

test('backup failure and future or corrupt v2 state preserve the original instead of resetting', async (t) => {
  const root = await temporary(t);
  const path = join(root, 'state.json');
  const source = JSON.stringify({ version: 1, sessions: [{ sessionId: 'one', destination: DEST, conflict: false }] });
  await writeFile(path, source);
  await mkdir(`${path}.v1.bak`);
  const store = await RelayStore.open(path);
  await assert.rejects(store.attempt('one', 1));
  assert.equal(store.get('one').lastAttempt, undefined);
  assert.equal(await readFile(path, 'utf8'), source);
  await store.close();
  for (const document of [{ version: 3, sessions: [] }, { version: 2, sessions: [{ sessionId: 'one', destination: DEST, conflict: false,
    lastAttempt: { turn: 1, attemptId: 'a', status: 'sent', parts: [{ id: 'text', kind: 'text', status: 'sent' }] } }] }]) {
    const bytes = JSON.stringify(document);
    await writeFile(path, bytes);
    await assert.rejects(RelayStore.open(path));
    assert.equal(await readFile(path, 'utf8'), bytes);
  }
});

test('part transitions reject duplicate dispatch, fake success and unsafe persisted data', async (t) => {
  const store = await RelayStore.open(join(await temporary(t), 'state.json'));
  t.after(() => store.close());
  await store.remember('one', [DEST]);
  await assert.rejects(store.attempt('one', 1, [filePart('a'), filePart('a')]), /manifest/);
  const attempt = await store.attempt('one', 1, [filePart('a'), filePart('b')]);
  await store.startPart('one', 1, attempt.attemptId, 'artifact:a');
  await assert.rejects(store.startPart('one', 1, attempt.attemptId, 'artifact:a'), /already-attempted/);
  await assert.rejects(store.finishPart('one', 1, attempt.attemptId, 'artifact:a', { status: 'sent', providerMessageIds: [] }), /invalid-delivery-result/);
  await store.finishPart('one', 1, attempt.attemptId, 'artifact:a', { status: 'unknown', providerMessageIds: [], notice: { status: 'sent', providerMessageIds: ['$notice'] } });
  await store.startPart('one', 1, attempt.attemptId, 'artifact:b');
  await store.finishPart('one', 1, attempt.attemptId, 'artifact:b', { status: 'failed', providerMessageIds: [] });
  assert.equal(store.get('one').lastAttempt.status, 'unknown');
  assert.throws(() => store.finishPart('one', 1, attempt.attemptId, 'artifact:b', { status: 'failed', error: '/secret/path' }), /invalid-delivery-result/);
});
