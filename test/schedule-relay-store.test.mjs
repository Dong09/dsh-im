import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { destination, RelayStore } from '../plugin-src/host/schedule-relay-store.mjs';
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

test('a failed checkpoint write does not publish attachment intent', async (t) => {
  const root = await temporary(t);
  const path = join(root, 'state.json');
  const store = await RelayStore.open(path);
  t.after(() => store.close());
  await store.remember('one', [DEST]);
  const saved = join(root, 'state.saved.json');
  assert.equal(path, join(root, 'state.json'));
  await rename(path, saved);
  await mkdir(path);
  try {
    await assert.rejects(store.attempt('one', 1, [filePart('a')]));
    assert.equal(store.get('one').lastAttempt, undefined);
  } finally {
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
  const manifest = [filePart('a'), filePart('b')];
  const first = await store.attempt('one', 1, manifest);
  manifest[0].fileName = 'modified.png';
  assert.equal(store.get('one').lastAttempt.parts[0].fileName, 'same.png');
  for (const [partId, status, ids] of [['artifact:a', 'sent', ['$image']], ['artifact:b', 'failed', []]]) {
    await store.startPart('one', 1, first.attemptId, partId);
    await store.finishPart('one', 1, first.attemptId, partId, { status, providerMessageIds: ids });
  }
  assert.equal(store.get('one').lastAttempt.status, 'failed');
  assert.deepEqual(store.get('one').lastAttempt.parts.map((p) => p.providerMessageIds), [['$image'], []]);
  const next = await store.attempt('one', 2, [filePart('next')]);
  await assert.rejects(store.finishPart('one', 1, first.attemptId, 'artifact:a', { status: 'sent', providerMessageIds: ['$late'] }), /checkpoint-changed/);
  await assert.rejects(store.startPart('one', 2, first.attemptId, 'artifact:a'), /checkpoint-changed/);
  assert.equal(store.get('one').lastAttempt.attemptId, next.attemptId);
  assert.equal(await store.attempt('one', 1, [filePart('new')]), null);
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
    const original = JSON.stringify(document, null, 2).replaceAll('\n', '\r\n');
    await writeFile(path, original);
    const store = await RelayStore.open(path);
    assert.equal(await store.attempt('one', 8, [filePart('new')]), null);
    assert.equal(await readFile(path, 'utf8'), original, 'read alone never migrates');
    await store.remember('new', [DEST]);
    assert.deepEqual(await readFile(`${path}.v1.bak`), Buffer.from(original), 'backup preserves every original byte');
    assert.equal(JSON.parse(await readFile(path, 'utf8')).version, 2);
    await store.close();
    const restored = await RelayStore.open(path);
    try {
      assert.equal(restored.get('one').lastAttempt.status, status);
      assert.equal(restored.get('thread').conflict, true);
      assert.deepEqual(restored.get('thread').destination, v12);
      assert.equal(await restored.attempt('one', 7, [filePart('new')]), null);
      assert.equal(await restored.attempt('thread', 10, [filePart('new')]), null);
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
  await assert.rejects(store.attempt('one', 1, [filePart('new')]));
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

test('new attempts require explicit nonempty artifact-only manifests without changing durable state', async (t) => {
  const path = join(await temporary(t), 'state.json');
  const store = await RelayStore.open(path);
  t.after(() => store.close());
  await store.remember('one', [DEST]);
  const original = await readFile(path, 'utf8');
  for (const manifest of [undefined, null, {}, [], Array(1), [undefined], [{ id: 'text', kind: 'text' }],
    [filePart('a'), { id: 'text', kind: 'text' }]]) {
    await assert.rejects(store.attempt('one', 1, manifest), /invalid-part-manifest/);
    assert.equal(store.get('one').lastAttempt, undefined);
    assert.equal(await readFile(path, 'utf8'), original);
  }
  assert.equal('finish' in store, false, 'historical compatibility exposes no legacy result writer');
});

for (const status of ['pending', 'sending', 'sent', 'failed', 'unknown', 'skipped']) {
  for (const kind of ['text', 'mixed', 'artifact']) test(`historical v2 ${kind}/${status} reads and round-trips without replay or lowering high water`, async (t) => {
    const path = join(await temporary(t), 'state.json');
    const part = (manifest) => ({ ...manifest, status, ...(status === 'sent' ? { providerMessageIds: ['$historical'] } : {}) });
    const parts = [...(kind !== 'artifact' ? [part({ id: 'text', kind: 'text' })] : []),
      ...(kind !== 'text' ? [part(filePart('old'))] : [])];
    const attemptStatus = status === 'pending' ? 'sending' : status === 'skipped' ? 'failed' : status;
    const lastAttempt = { turn: 8, attemptId: 'historical', status: attemptStatus, parts };
    const entry = { sessionId: 'one', destination: DEST, conflict: false, lastAttempt };
    const original = JSON.stringify({ version: 2, sessions: [entry] });
    await writeFile(path, original);
    const store = await RelayStore.open(path);
    assert.deepEqual(store.get('one'), entry);
    assert.equal(await store.attempt('one', 8, [filePart('new')]), null);
    assert.equal(await store.attempt('one', 7, [filePart('new')]), null);
    assert.equal(await readFile(path, 'utf8'), original, 'reading and stale attempts do not rewrite history');
    await store.remember('other', [DEST]);
    await store.close();
    const restored = await RelayStore.open(path);
    try { assert.deepEqual(restored.get('one'), entry); }
    finally { await restored.close(); }
  });
}
