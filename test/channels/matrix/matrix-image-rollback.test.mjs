import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { MatrixImageInboxStore } from '../../../src/channels/matrix/matrix-image-inbox.mjs';
import { RelayStore } from '../../../plugin-src/host/schedule-relay-store.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const target = { roomId: '!images:example.org', eventId: '$pending' };
const entries = [
  { ...target, senderId: '@alice:example.org', threadId: null, ts: 100, name: 'same.png', consumed: false },
  { ...target, eventId: '$consumed', senderId: '@alice:example.org', threadId: null, ts: 90, name: 'same.png', consumed: true },
];
const destination = { botId: 'matrix_test', kind: 'room', route: { roomId: '!output:example.org' } };
const artifact = { id: 'artifact:kept', kind: 'artifact', artifactId: 'kept', fileName: 'same.png',
  mediaType: 'image/png', size: 3, digest: 'a'.repeat(64) };
const scheduled = { version: 2, sessions: [{ sessionId: 'scheduled-session', destination, conflict: false,
  lastAttempt: { turn: 17, attemptId: 'kept-attempt', status: 'unknown',
    parts: [{ ...artifact, status: 'unknown', error: 'send-result-unknown' }] } }] };

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-image-rollback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

// This is only a compatibility assertion, not a frozen copy of an old writer.
// The optional rehearsal below runs the actual snapshotted pre-migration reader.
async function assertLegacyReadable(path) {
  const document = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(document.version, 1, 'the pre-migration reader rejects image v2');
  assert.deepEqual(Object.keys(document).sort(), ['entries', 'version']);
  for (const entry of document.entries) {
    assert.deepEqual(Object.keys(entry).sort(), ['consumed', 'eventId', 'name', 'roomId', 'senderId', 'threadId', 'ts']);
    assert.equal(typeof entry.consumed, 'boolean');
  }
  return document.entries;
}

async function rehearsal(t, { oldReader, Relay = RelayStore } = {}) {
  const root = await temporary(t);
  const imagePath = join(root, 'bots', 'test', 'matrix-images.json');
  const relayPath = join(root, 'integrations', 'dsh-matrix', 'schedule-replies.json');
  await mkdir(dirname(imagePath), { recursive: true });
  await mkdir(dirname(relayPath), { recursive: true });
  const legacyBytes = Buffer.from(`{ "version": 1, "entries": ${JSON.stringify(entries)} }\r\n`);
  const relayBytes = Buffer.from(`${JSON.stringify(scheduled, null, 2)}\n`);
  await writeFile(imagePath, legacyBytes);
  await writeFile(relayPath, relayBytes);
  const relayHash = digest(relayBytes);
  const assertRelayUntouched = async () => {
    const bytes = await readFile(relayPath);
    assert.deepEqual(bytes, relayBytes);
    assert.equal(digest(bytes), relayHash);
    const relay = await Relay.open(relayPath);
    try {
      assert.deepEqual(relay.get('scheduled-session'), scheduled.sessions[0]);
      assert.equal(await relay.attempt('scheduled-session', 17, [artifact]), null, 'high-water prevents replay');
      assert.equal(await relay.attempt('scheduled-session', 16, [artifact]), null, 'high-water cannot decrease');
      await assert.rejects(relay.attempt('scheduled-session', 18, [{ id: 'text', kind: 'text' }]), /invalid-part-manifest/);
    } finally { await relay.close(); }
    assert.deepEqual(await readFile(relayPath), relayBytes);
  };

  const migrated = await new MatrixImageInboxStore(imagePath).load();
  await migrated.invalidate(target);
  await migrated.record({ ...entries[0], eventId: '$after-migration' });
  await migrated.markConsumed({ roomId: target.roomId, eventIds: ['$after-migration'] });
  await migrated.barrier();
  assert.deepEqual(await readFile(`${imagePath}.v1.bak`), legacyBytes);
  assert.equal(JSON.parse(await readFile(imagePath, 'utf8')).version, 2);
  assert.equal((await new MatrixImageInboxStore(imagePath).load()).isInvalidated(target), true);
  await assert.rejects(assertLegacyReadable(imagePath));
  if (oldReader) await assert.rejects(new oldReader(imagePath).load(), /Invalid Matrix image inbox document/);
  await assertRelayUntouched();

  // All writers are now idle and discarded. Restore ONLY the image state in the
  // isolated tree, never the independent scheduled attachment state/high-water.
  await copyFile(`${imagePath}.v1.bak`, imagePath);
  assert.deepEqual(await readFile(imagePath), legacyBytes);
  assert.deepEqual(await assertLegacyReadable(imagePath), entries);
  if (oldReader) {
    const restored = await new oldReader(imagePath).load();
    assert.deepEqual(restored.get(target), entries[0]);
    assert.deepEqual(restored.get({ ...target, eventId: '$consumed' }), entries[1]);
    assert.deepEqual(restored.pending({ roomId: target.roomId, senderId: entries[0].senderId }), [entries[0]]);
    assert.equal(restored.get({ ...target, eventId: '$after-migration' }), null,
      'manual rollback explicitly loses post-backup consumption and invalidation progress');
    await restored.flush();
  }
  await assertRelayUntouched();
}

test('isolated image migration and manual byte restoration leave scheduled v2 manifests and high-water unchanged', async (t) => {
  await rehearsal(t);
});

const baseline = process.env.DSH_IMAGE_REFERENCE_BASELINE;
test('actual simplified baseline reader and code bundle survive an isolated image-only rollback', {
  skip: baseline ? false : 'optional: set DSH_IMAGE_REFERENCE_BASELINE to the saved baseline files directory',
}, async (t) => {
  const root = await temporary(t);
  const paths = [
    'src/channels/matrix/matrix-image-inbox.mjs',
    'src/channels/matrix/matrix-identifiers.mjs',
    'plugin-src/host/schedule-relay-store.mjs',
    'plugin-src/host/schedule-relay-coordinator.mjs',
    'lib/index.js',
  ];
  const hashes = new Map();
  for (const relative of paths) {
    const bytes = await readFile(join(baseline, relative));
    hashes.set(relative, digest(bytes));
    await mkdir(dirname(join(root, relative)), { recursive: true });
    await writeFile(join(root, relative), bytes);
  }
  const coordinator = await readFile(join(root, paths[3]), 'utf8');
  assert.match(coordinator, /Attachment-only relay: official Session sync owns final text independently/);
  assert.doesNotMatch(coordinator, /state\.text|completedDestinations/);
  assert.match(coordinator, /id, kind: 'artifact', artifactId:/, 'simplified relay creates artifact-only manifests');
  const { MatrixImageInboxStore: OldReader } = await import(pathToFileURL(join(root, paths[0])).href);
  const { RelayStore: OldRelay } = await import(pathToFileURL(join(root, paths[2])).href);
  await rehearsal(t, { oldReader: OldReader, Relay: OldRelay });

  // Rehearse a code-only delta in a temporary deployment tree, then restore the
  // snapshotted inbox. Relay sources and bundle come from the simplified working
  // tree baseline, not git HEAD (which still contained the retired text sender).
  await copyFile(join(repository, paths[0]), join(root, paths[0]));
  assert.notEqual(digest(await readFile(join(root, paths[0]))), hashes.get(paths[0]));
  await copyFile(join(baseline, paths[0]), join(root, paths[0]));
  for (const relative of paths) {
    assert.equal(digest(await readFile(join(root, relative))), hashes.get(relative), relative);
  }
  const { MatrixImageInboxStore: RestoredReader } = await import(`${pathToFileURL(join(root, paths[0])).href}?restored`);
  const state = join(root, 'restored-reader-check.json');
  await writeFile(state, JSON.stringify({ version: 1, entries }));
  assert.deepEqual((await new RestoredReader(state).load()).get(target), entries[0]);
  t.diagnostic(`simplified baseline bundle SHA-256: ${hashes.get('lib/index.js')}`);
});
