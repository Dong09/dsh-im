import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MatrixImageInboxStore } from '../../../src/channels/matrix/matrix-image-inbox.mjs';

const ROOM = '!room:example.org';
const SENDER = '@alice:example.org';
const scope = { roomId: ROOM, senderId: SENDER };
const image = (eventId, extra = {}) => ({
  ...scope, eventId, ts: 100, name: `${eventId}.png`, ...extra,
});
const ids = (entries) => entries.map((entry) => entry.eventId);
const persisted = (entry) => ({ threadId: null, ...entry, consumed: false });

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-matrix-image-inbox-'));
  const path = join(directory, 'inbox.json');
  try {
    await run({ directory, path });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function readDocument(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

test('images sent before a mention stay pending; multi-image queries do not consume them', async () => {
  await fixture(async ({ path }) => {
    const store = await new MatrixImageInboxStore(path).load();
    assert.equal(store.get({ roomId: ROOM, eventId: '$absent' }), null);
    await store.record(image('$one'));
    await store.record(image('$two', { ts: 110 }));
    const query = { ...scope, beforeTs: 120, sinceTs: 90 };
    assert.deepEqual(ids(store.pending(query)), ['$one', '$two']);
    assert.deepEqual(ids(store.pending(query)), ['$one', '$two'], 'a failed or unprocessed turn can retry');
    assert.equal(await store.markConsumed({ roomId: ROOM, eventIds: ['$one', '$two'] }), 2);
    assert.deepEqual(store.pending(query), []);
    assert.equal(store.get({ roomId: ROOM, eventId: '$one' }).consumed, true,
      'explicit replies may retrieve a consumed image');
    await store.flush();
  });
});

test('pending isolates exact sender, room, mainline and thread with inclusive time bounds', async () => {
  await fixture(async ({ path }) => {
    const store = await new MatrixImageInboxStore(path).load();
    await store.record(image('$start', { ts: 100 }));
    await store.record(image('$end', { ts: 200 }));
    await store.record(image('$past', { ts: 99 }));
    await store.record(image('$future', { ts: 201 }));
    await store.record(image('$bob', { senderId: '@bob:example.org' }));
    await store.record(image('$elsewhere', { roomId: '!other:example.org' }));
    await store.record(image('$thread-a', { threadId: '$a' }));
    await store.record(image('$thread-b', { threadId: '$b' }));
    await store.record(image('$case-sensitive', { senderId: '@Alice:example.org' }));
    const query = { ...scope, sinceTs: 100, beforeTs: 200 };
    assert.deepEqual(ids(store.pending(query)), ['$start', '$end']);
    assert.deepEqual(ids(store.pending({ ...query, threadId: null })), ['$start', '$end']);
    assert.deepEqual(ids(store.pending({ ...query, threadId: '$a' })), ['$thread-a']);
    assert.deepEqual(ids(store.pending({ ...query, threadId: '$b' })), ['$thread-b']);
    assert.deepEqual(ids(store.pending({ ...query, senderId: '@bob:example.org' })), ['$bob']);
    assert.deepEqual(ids(store.pending({ ...query, roomId: '!other:example.org' })), ['$elsewhere']);
    assert.deepEqual(store.pending({ ...scope, sinceTs: 200, beforeTs: 100 }), []);
    assert.equal(store.get({ roomId: '!other:example.org', eventId: '$start' }), null);
    assert.throws(() => store.pending({ roomId: ROOM }), /senderId/, 'omission cannot widen scope');
  });
});

test('arrival order, not timestamp order, is stable across restart', async () => {
  await fixture(async ({ path }) => {
    const store = await new MatrixImageInboxStore(path).load();
    await store.record(image('$arrived-first', { ts: 300 }));
    await store.record(image('$arrived-second', { ts: 100 }));
    await store.record(image('$same-ts', { ts: 100 }));
    const expected = ['$arrived-first', '$arrived-second', '$same-ts'];
    assert.deepEqual(ids(store.pending(scope)), expected);
    const restarted = await new MatrixImageInboxStore(path).load();
    assert.deepEqual(ids(restarted.pending(scope)), expected);
  });
});

test('replayed room/event references are idempotent and do not reset consumed state or metadata', async () => {
  await fixture(async ({ path }) => {
    const store = await new MatrixImageInboxStore(path).load();
    const original = await store.record(image('$shared'));
    await store.record(image('$next'));
    assert.deepEqual(await store.record(image('$shared', { name: 'changed', ts: 1, threadId: '$changed' })), original);
    assert.deepEqual(ids(store.pending(scope)), ['$shared', '$next']);
    assert.equal(await store.markConsumed({ roomId: ROOM, eventIds: ['$shared', '$shared', '$missing'] }), 1);
    const replay = await store.record(image('$shared'));
    assert.equal(replay.consumed, true);
    assert.equal(await store.markConsumed({ roomId: ROOM, eventIds: ['$shared'] }), 0);
    assert.equal(await store.markConsumed({ roomId: ROOM, eventIds: [] }), 0);
    await store.record(image('$shared', { roomId: '!other:example.org' }));
    assert.equal(store.get({ roomId: '!other:example.org', eventId: '$shared' }).consumed, false);
    assert.deepEqual(ids(store.pending(scope)), ['$next']);
  });
});

test('record and consumption are durable before resolving and survive a restart', async () => {
  await fixture(async ({ path }) => {
    const store = await new MatrixImageInboxStore(path).load();
    const recording = store.record(image('$one'));
    assert.equal(store.get({ roomId: ROOM, eventId: '$one' }), null, 'uncommitted state is not visible');
    const one = await recording;
    assert.deepEqual((await readDocument(path)).entries, [one]);
    await store.record(image('$two'));
    const consuming = store.markConsumed({ roomId: ROOM, eventIds: ['$one'] });
    assert.equal(store.get({ roomId: ROOM, eventId: '$one' }).consumed, false);
    await consuming;
    assert.equal((await readDocument(path)).entries[0].consumed, true);
    const restarted = await new MatrixImageInboxStore(path).load();
    assert.deepEqual(ids(restarted.pending(scope)), ['$two']);
    assert.equal(restarted.get({ roomId: ROOM, eventId: '$one' }).consumed, true);
    assert.equal(await restarted.markConsumed({ roomId: ROOM, eventIds: ['$one'] }), 0);
  });
});

test('only reference metadata is persisted; returned objects cannot mutate the inbox', async () => {
  await fixture(async ({ path }) => {
    const store = await new MatrixImageInboxStore(path).load();
    const recorded = await store.record(image('$one', {
      bytes: Buffer.from('private image bytes'), key: 'private-key', accessToken: 'private-token',
      content: { file: { key: 'private-encryption-key' } }, consumed: true,
    }));
    assert.deepEqual(recorded, persisted(image('$one')));
    recorded.consumed = true;
    store.get({ roomId: ROOM, eventId: '$one' }).name = 'mutated';
    store.pending(scope)[0].threadId = '$mutated';
    assert.deepEqual(store.get({ roomId: ROOM, eventId: '$one' }), persisted(image('$one')));
    const text = await readFile(path, 'utf8');
    assert.doesNotMatch(text, /private-|private image|accessToken|"content"|"bytes"|"key"/);
    assert.deepEqual(Object.keys((await readDocument(path)).entries[0]).sort(),
      ['consumed', 'eventId', 'name', 'roomId', 'senderId', 'threadId', 'ts']);
  });
});

test('concurrent record, duplicate, consumption, load and flush operations serialize without lost updates', async () => {
  await fixture(async ({ path }) => {
    const store = new MatrixImageInboxStore(path);
    const loading = store.load();
    const first = store.record(image('$one'));
    const duplicate = store.record(image('$one', { name: 'ignored replay' }));
    const second = store.record(image('$two'));
    const consuming = store.markConsumed({ roomId: ROOM, eventIds: ['$one'] });
    const third = store.record(image('$three'));
    const flushing = store.flush();
    const results = await Promise.all([loading, first, duplicate, second, consuming, third, flushing]);
    assert.deepEqual(results[1], results[2]);
    assert.equal(results[4], 1);
    assert.deepEqual(ids(store.pending(scope)), ['$two', '$three']);
    const restarted = await new MatrixImageInboxStore(path).load();
    assert.deepEqual(ids(restarted.pending(scope)), ['$two', '$three']);
    assert.deepEqual(ids((await readDocument(path)).entries), ['$one', '$two', '$three']);
  });
});

test('retention is global FIFO, including consumed entries, and duplicate replay does not refresh arrival', async () => {
  await fixture(async ({ path }) => {
    const store = await new MatrixImageInboxStore(path, { limit: 3 }).load();
    await store.record(image('$old'));
    await store.record(image('$consumed'));
    await store.markConsumed({ roomId: ROOM, eventIds: ['$consumed'] });
    await store.record(image('$other-room', { roomId: '!other:example.org' }));
    await store.record(image('$old', { ts: 1000 }));
    await store.record(image('$new', { ts: 1 }));
    assert.equal(store.get({ roomId: ROOM, eventId: '$old' }), null);
    assert.equal(store.get({ roomId: ROOM, eventId: '$consumed' }).consumed, true);
    assert.deepEqual(ids((await readDocument(path)).entries), ['$consumed', '$other-room', '$new']);
    const restarted = await new MatrixImageInboxStore(path, { limit: 3 }).load();
    assert.deepEqual(ids(restarted.pending(scope)), ['$new']);
  });
});

test('default retention is 2000 globally and load durably trims a reduced limit', async () => {
  await fixture(async ({ path }) => {
    const entries = Array.from({ length: 2001 }, (_, index) => persisted(image(`$${index}`)));
    await writeFile(path, JSON.stringify({ version: 1, entries }), 'utf8');
    const store = await new MatrixImageInboxStore(path).load();
    assert.equal(store.pending(scope).length, 2000);
    assert.equal(store.get({ roomId: ROOM, eventId: '$0' }), null);
    assert.equal((await readDocument(path)).entries.length, 2000);
    const reduced = await new MatrixImageInboxStore(path, { limit: 2 }).load();
    assert.deepEqual(ids(reduced.pending(scope)), ['$1999', '$2000']);
    assert.deepEqual(ids((await readDocument(path)).entries), ['$1999', '$2000']);
  });
});

test('malformed JSON, invalid schema, duplicate references and invalid metadata fail loudly without overwriting disk', async () => {
  await fixture(async ({ path }) => {
    const valid = persisted(image('$one'));
    const invalidDocuments = [
      '{broken JSON', 'null', '[]', '{}',
      JSON.stringify({ version: 2, entries: [] }),
      JSON.stringify({ version: 1, entries: {} }),
      JSON.stringify({ version: 1, entries: [null] }),
      JSON.stringify({ version: 1, entries: [valid, valid] }),
      ...[
        { ...valid, roomId: '' }, { ...valid, senderId: null }, { ...valid, eventId: 1 },
        { ...valid, threadId: '' }, { ...valid, ts: -1 }, { ...valid, ts: 1.5 },
        { ...valid, ts: '100' }, { ...valid, name: null }, { ...valid, consumed: 'false' },
        { ...valid, key: 'must-not-be-accepted' },
        Object.fromEntries(Object.entries(valid).filter(([key]) => key !== 'consumed')),
      ].map((entry) => JSON.stringify({ version: 1, entries: [entry] })),
    ];
    for (const text of invalidDocuments) {
      await writeFile(path, text, 'utf8');
      const store = new MatrixImageInboxStore(path);
      await assert.rejects(store.load(), undefined, text);
      await assert.rejects(store.flush(), undefined, 'flush also exposes the failed load');
      assert.equal(await readFile(path, 'utf8'), text);
    }
  });
});

test('a failed reload preserves the last committed memory and missing files alone initialize empty', async () => {
  await fixture(async ({ path }) => {
    const store = await new MatrixImageInboxStore(path).load();
    assert.deepEqual(store.pending(scope), []);
    await store.record(image('$one'));
    await writeFile(path, '{broken', 'utf8');
    await assert.rejects(store.load(), SyntaxError);
    assert.deepEqual(ids(store.pending(scope)), ['$one']);
    await assert.rejects(store.flush(), SyntaxError);
  });
});

test('read errors other than missing files are reported by load and flush', async () => {
  await fixture(async ({ path }) => {
    await mkdir(path);
    const store = new MatrixImageInboxStore(path);
    await assert.rejects(store.load());
    await assert.rejects(store.flush());
  });
});

test('failed atomic consumption leaves memory and durable records unconsumed; retry recovers the queue', async () => {
  await fixture(async ({ directory, path }) => {
    const store = await new MatrixImageInboxStore(path).load();
    await store.record(image('$one'));
    const backup = join(directory, 'committed.json');
    const original = await readFile(path, 'utf8');
    await rename(path, backup);
    await mkdir(path); // Deterministically block destination rename on all platforms.
    await assert.rejects(store.markConsumed({ roomId: ROOM, eventIds: ['$one'] }));
    assert.equal(store.get({ roomId: ROOM, eventId: '$one' }).consumed, false);
    assert.deepEqual(ids(store.pending(scope)), ['$one']);
    assert.equal(await readFile(backup, 'utf8'), original);
    assert.deepEqual((await readdir(directory)).sort(), ['committed.json', 'inbox.json'],
      'failed rename cleans its unique temporary file');
    await rm(path, { recursive: true });
    await rename(backup, path);
    await store.record(image('$two'));
    await assert.rejects(store.flush(), undefined, 'later successful writes must not hide the failure');
    assert.equal(await store.markConsumed({ roomId: ROOM, eventIds: ['$one'] }), 1);
    await store.flush();
    const restarted = await new MatrixImageInboxStore(path).load();
    assert.deepEqual(ids(restarted.pending(scope)), ['$two']);
    assert.equal(restarted.get({ roomId: ROOM, eventId: '$one' }).consumed, true);
  });
});

test('failed new record cannot evict old state, and a parent-directory write failure is loud', async () => {
  await fixture(async ({ directory, path }) => {
    const store = await new MatrixImageInboxStore(path, { limit: 1 }).load();
    await store.record(image('$old'));
    const backup = join(directory, 'committed.json');
    await rename(path, backup);
    await mkdir(path);
    await assert.rejects(store.record(image('$new')));
    assert.equal(store.get({ roomId: ROOM, eventId: '$new' }), null);
    assert.deepEqual(ids(store.pending(scope)), ['$old']);
    await assert.rejects(store.flush());

    const blocker = join(directory, 'not-a-directory');
    await writeFile(blocker, 'block mkdir', 'utf8');
    const blocked = new MatrixImageInboxStore(join(blocker, 'inbox.json'));
    await assert.rejects(blocked.record(image('$new')));
    assert.equal(blocked.get({ roomId: ROOM, eventId: '$new' }), null);
    await assert.rejects(blocked.flush());
  });
});

test('invalid API inputs fail explicitly rather than widening scope or writing broken records', async () => {
  await fixture(async ({ path }) => {
    for (const limit of [0, -1, 1.5, Infinity, '2']) {
      assert.throws(() => new MatrixImageInboxStore(path, { limit }), /limit/);
    }
    assert.throws(() => new MatrixImageInboxStore(''), /file path/);
    const store = await new MatrixImageInboxStore(path).load();
    for (const patch of [{ roomId: '' }, { eventId: '' }, { senderId: '' }, { ts: NaN }, { threadId: '' }, { name: null }]) {
      await assert.rejects(store.record(image('$invalid', patch)), TypeError);
    }
    assert.throws(() => store.get({ roomId: ROOM }), /eventId/);
    assert.throws(() => store.pending({ ...scope, beforeTs: NaN }), /beforeTs/);
    assert.throws(() => store.pending({ ...scope, sinceTs: -1 }), /sinceTs/);
    await assert.rejects(store.markConsumed({ roomId: ROOM, eventIds: '$one' }), /eventIds/);
    await assert.rejects(store.markConsumed({ roomId: ROOM, eventIds: [null] }), /eventId/);
    assert.deepEqual(store.pending(scope), []);
    await store.flush();
  });
});
