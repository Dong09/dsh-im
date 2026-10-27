import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MatrixRuntime } from '../../../src/channels/matrix/matrix-runtime.mjs';
import { MatrixSidecarStore } from '../../../src/channels/matrix/matrix-config-store.mjs';
import { MatrixImageInboxStore } from '../../../src/channels/matrix/matrix-image-inbox.mjs';
import { loadDeferredImages } from '../../helpers/deferred-images.mjs';
import { ImagePromptError } from '../../../src/channels/shared/image-prompt.mjs';

const BOT = '@bot:example.org';
const ALICE = '@alice:example.org';
const BOB = '@bob:example.org';
const ROOM = '!images:example.org';
const OTHER_ROOM = '!other-images:example.org';
const THREAD = '$thread:example.org';
const OTHER_THREAD = '$other-thread:example.org';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

// Every wait has an observable producer. The timer only bounds a broken contract;
// it never makes the assertion true, and no polling/sleep advances the fixture.
function journal() {
  const entries = [];
  const listeners = new Set();
  return {
    entries,
    push(entry) {
      entries.push(entry);
      for (const listener of [...listeners]) listener();
    },
    wait(predicate, label, after = 0) {
      const find = () => entries.slice(after).find(predicate);
      const existing = find();
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error(`Never observed ${label}; operations: ${entries.slice(after).map((entry) => entry.op).join(', ')}; details: ${JSON.stringify(entries.slice(-8), (_key, value) => value instanceof Error ? { message: value.message, stack: value.stack } : value)}`));
        }, 15_000);
        const check = () => {
          const result = find();
          if (!result) return;
          clearTimeout(timer);
          listeners.delete(check);
          resolve(result);
        };
        listeners.add(check);
      });
    },
  };
}

function event(id, { sender = ALICE, body = '这是什么？', ts = Date.now(), mention = false, threadId = null, replyTo = null, image = false } = {}) {
  const relates = {
    ...(threadId ? { rel_type: 'm.thread', event_id: threadId } : {}),
    ...(replyTo ? { 'm.in_reply_to': { event_id: replyTo } } : {}),
    ...(threadId && !replyTo ? { is_falling_back: true, 'm.in_reply_to': { event_id: threadId } } : {}),
  };
  return {
    type: 'm.room.message',
    event_id: `$${id}:example.org`,
    sender,
    origin_server_ts: ts,
    content: {
      msgtype: image ? 'm.image' : 'm.text',
      body: mention && !image ? `${BOT} ${body}` : body,
      ...(image ? { url: `mxc://media.example.org/${id}`, info: { mimetype: 'image/png', size: PNG.length } } : {}),
      ...(mention ? { 'm.mentions': { user_ids: [BOT] } } : {}),
      ...(Object.keys(relates).length ? { 'm.relates_to': relates } : {}),
    },
  };
}
const image = (id, options = {}) => event(id, { body: `${id}.png`, ...options, image: true });
const question = (id, options = {}) => event(id, { ...options, mention: true });
const imagesOf = (prompt) => Array.isArray(prompt) ? prompt.filter((part) => part.type === 'image') : [];
const textOf = (prompt) => typeof prompt === 'string' ? prompt : prompt.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
const remoteKey = (roomId, eventId) => `${roomId}|${eventId}`;

function fakeApi(log, remoteEvents, media, faults) {
  let poll = null;
  let syncCalls = 0;
  const api = {
    whoami: async () => ({ user_id: BOT, device_id: 'IMAGE_TEST_DEVICE' }),
    sync: async ({ signal } = {}) => {
      signal?.throwIfAborted();
      const call = ++syncCalls;
      if (call === 1) return { next_batch: 'initial', rooms: { join: {} } };
      const pending = Promise.withResolvers();
      const onAbort = () => pending.reject(signal.reason);
      poll = pending;
      signal?.addEventListener('abort', onAbort, { once: true });
      log.push({ op: 'sync-ready', api, call });
      try { return await pending.promise; }
      finally {
        signal?.removeEventListener('abort', onAbort);
        if (poll === pending) poll = null;
      }
    },
    async push(roomId, events) {
      await log.wait((entry) => entry.op === 'sync-ready' && entry.api === api && entry.call === syncCalls, 'an outstanding sync request');
      assert.ok(poll, 'a batch is delivered only to an owned outstanding sync request');
      for (const entry of events) remoteEvents.set(remoteKey(roomId, entry.event_id), structuredClone(entry));
      const nextPoll = syncCalls + 1;
      const pending = poll;
      poll = null;
      pending.resolve({ next_batch: `batch-${nextPoll}`, rooms: { join: { [roomId]: { timeline: { events } } } } });
      // The next long poll is not issued until every event in this batch has
      // passed the runtime's timeline handler, including silent inbox records.
      await log.wait((entry) => entry.op === 'sync-ready' && entry.api === api && entry.call === nextPoll, 'the delivered timeline batch to finish');
    },
    close() {
      poll?.resolve({ next_batch: 'closed' });
      poll = null;
    },
    getAccountData: async () => ({}),
    setAccountData: async () => ({}),
    getJoinedMemberCount: async () => 3,
    getRoomStateEvent: async () => null,
    getRoomMemberDisplayName: async () => null,
    listRelations: async () => ({ events: [] }),
    setTyping: async (roomId) => { log.push({ op: 'typing', roomId }); return {}; },
    sendReceipt: async () => ({}),
    redactEvent: async () => ({}),
    async getEvent(roomId, eventId) {
      log.push({ op: 'getEvent', roomId, eventId });
      if (faults.getEvent) return faults.getEvent(roomId, eventId);
      return structuredClone(remoteEvents.get(remoteKey(roomId, eventId)) ?? null);
    },
    async downloadContent(uri, options) {
      log.push({ op: 'download', uri, options });
      if (faults.download) return faults.download(uri, options);
      assert.ok(media.has(uri), `test owns the requested media: ${uri}`);
      return media.get(uri);
    },
    async sendEvent(roomId, type, content) {
      const entry = { op: 'send', roomId, type, content: structuredClone(content) };
      const body = content['m.new_content']?.body ?? content.body ?? '';
      if (faults.send && type === 'm.room.message') await faults.send(body);
      log.push(entry);
      return { event_id: `$sent-${log.entries.length}:example.org` };
    },
  };
  return api;
}

async function fixture(t, { config = {}, onAsk } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-matrix-image-association-'));
  const inboxPath = join(directory, 'image-inbox.json');
  const log = journal();
  const remoteEvents = new Map();
  const media = new Map();
  const faults = {};
  const prompts = [];
  const askCalls = [];
  const inputErrors = [];
  const steerCalls = [];
  const releases = [];
  const runtimes = [];
  const baseTs = Date.now();
  let current;
  t.after(async () => {
    // Release test-owned barriers even if an assertion failed while a turn was
    // held. Then drain the bridge before removing any store-owned files.
    for (const release of releases) release();
    for (const context of [...runtimes].reverse()) await stop(context);
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  async function stop(context) {
    if (context.stopped) return;
    context.stopped = true;
    await context.runtime.stop();
    context.api.close();
    await context.inbox.flush();
  }

  async function open() {
    const inbox = await new MatrixImageInboxStore(inboxPath, { limit: 100 }).load();
    const markConsumed = inbox.markConsumed.bind(inbox);
    inbox.markConsumed = async (...args) => {
      const result = await markConsumed(...args);
      log.push({ op: 'consumed', args });
      return result;
    };
    const sidecar = await new MatrixSidecarStore(join(directory, 'matrix.json')).load();
    const api = fakeApi(log, remoteEvents, media, faults);
    const seen = new Set();
    const sessions = new Map();
    const pending = new Map();
    const state = {
      hasSeen: (id) => seen.has(id),
      markSeen: async (id) => { seen.add(id); log.push({ op: 'seen', id }); },
      unmarkSeen: async (id) => seen.delete(id),
      sessionFor: (key) => sessions.get(key) ?? null,
      getSession: (key) => sessions.get(key) ?? null,
      setSession: async (key, id) => sessions.set(key, id),
      clearSession: async (key) => sessions.delete(key),
      snapshot: () => ({ seenMessageIds: [...seen], sessions: Object.fromEntries(sessions) }),
      pendingMessages: () => [...pending.values()],
      putPendingMessage: async (entry) => { pending.set(entry.id, entry); log.push({ op: 'queued', messageId: entry.messageId }); },
      patchPendingMessage: async (id, patch) => { Object.assign(pending.get(id) ?? {}, patch); },
      removePendingMessage: async (id) => {
        const entry = pending.get(id);
        pending.delete(id);
        log.push({ op: 'settled', messageId: entry?.messageId });
      },
    };
    const harness = {
      ensureRunning: async () => true,
      sessionExists: async () => true,
      createSession: async () => `sess-image-${runtimes.length}`,
      stopManagedProcess: () => undefined,
      async ask(sessionId, prompt, options = {}) {
        askCalls.push({ sessionId, prompt, options });
        // The shipping HarnessClient consumes options.images lazily too. Do not
        // record a model submission until every source has actually loaded.
        let loaded;
        try {
          loaded = await loadDeferredImages(prompt, options);
        } catch (error) {
          inputErrors.push(error);
          throw error;
        }
        prompts.push(loaded);
        const index = prompts.length;
        log.push({ op: 'model-prompt', index, prompt: loaded });
        if (onAsk) return await onAsk({ sessionId, prompt: loaded, options, index });
        return `分析完成-${index}`;
      },
      async steerActiveTurn(...args) {
        steerCalls.push(args);
        log.push({ op: 'steer' });
        return true;
      },
    };
    const runtime = new MatrixRuntime({
      config: {
        botId: `matrix_${'b'.repeat(24)}`, homeserver: 'https://matrix.example.org', userId: BOT,
        e2eeMode: 'off', reactions: false, coalesceWindowMs: 0,
        ...config,
      },
      accessToken: 'fixture-only-not-a-real-token',
      harness, state, sidecar, imageInbox: inbox,
      accessPolicy: {
        getSettings: () => ({
          direct: { mode: 'open', open: { defaultCanExecuteCommands: true, commandPermissionOverrides: [] }, allowlist: { users: [] } },
          group: { mode: 'open', open: { defaultCanExecuteCommands: true, commandPermissionOverrides: [] }, allowlist: { users: [] } },
        }),
      },
      logger: { info() {}, debug() {}, warn(...args) { log.push({ op: 'warn', args }); }, error(...args) { log.push({ op: 'error', args }); } },
      createApi: () => api,
      isKnownCommand: (name) => name === 'help',
    });
    current = { runtime, api, inbox, state, stopped: false };
    runtimes.push(current);
    await runtime.start();
    await log.wait((entry) => entry.op === 'sync-ready' && entry.api === api, 'runtime initial sync readiness');
    return current;
  }

  const f = {
    directory, inboxPath, log, prompts, askCalls, inputErrors, steerCalls, faults, baseTs,
    get runtime() { return current.runtime; },
    get inbox() { return current.inbox; },
    get api() { return current.api; },
    register(roomId, entry) {
      remoteEvents.set(remoteKey(roomId, entry.event_id), structuredClone(entry));
      if (entry.content.msgtype === 'm.image') {
        // Distinct, valid-signature PNG payloads make image identity observable,
        // rather than merely asserting that the model received N image parts.
        media.set(entry.content.url, Buffer.concat([PNG, Buffer.from(entry.event_id)]));
      }
      return entry;
    },
    async emit(entries, roomId = ROOM) {
      for (const entry of entries) f.register(roomId, entry);
      await current.api.push(roomId, entries);
    },
    async seed(entry, roomId = ROOM) {
      f.register(roomId, entry);
      await current.inbox.record({ roomId, eventId: entry.event_id, senderId: entry.sender,
        threadId: entry.content['m.relates_to']?.rel_type === 'm.thread' ? entry.content['m.relates_to'].event_id : null,
        ts: entry.origin_server_ts, name: entry.content.body });
      await current.inbox.flush();
    },
    async restart() {
      await stop(current);
      return open();
    },
    barrier() {
      const gate = Promise.withResolvers();
      releases.push(gate.resolve);
      return gate;
    },
    async answer(index, after = 0) {
      return log.wait((entry) => entry.op === 'send' && entry.type === 'm.room.message'
        && (entry.content['m.new_content']?.body ?? entry.content.body) === `分析完成-${index}`, `answer ${index}`, after);
    },
    async consumed(entry, after = 0) {
      return log.wait((record) => record.op === 'consumed' && record.args.some((arg) => arg?.eventIds?.includes(entry.event_id)), `consumption of ${entry.event_id}`, after);
    },
    async settled(entry, after = 0) {
      return log.wait((record) => record.op === 'settled' && record.messageId === entry.event_id, `turn completion of ${entry.event_id}`, after);
    },
    assertImages(index, expected) {
      assert.deepEqual(imagesOf(prompts[index - 1]).map((part) => part.data), expected.map((entry) => media.get(entry.content.url).toString('base64')));
    },
    downloads() { return log.entries.filter((entry) => entry.op === 'download').map((entry) => entry.uri); },
    lookups() { return log.entries.filter((entry) => entry.op === 'getEvent'); },
    sends() { return log.entries.filter((entry) => entry.op === 'send' && entry.type === 'm.room.message'); },
  };
  await open();
  return f;
}

test('an unmentioned group image is a durable reference only: no download, lookup, typing response, or model turn', async (t) => {
  const f = await fixture(t);
  const photo = image('silent', { ts: f.baseTs });
  await f.emit([photo]);
  await f.inbox.flush();
  assert.equal(f.prompts.length, 0);
  assert.equal(f.askCalls.length, 0);
  assert.deepEqual(f.lookups(), []);
  assert.deepEqual(f.downloads(), []);
  assert.deepEqual(f.sends(), []);
  assert.equal(f.log.entries.some((entry) => entry.op === 'typing'), false);
  const persisted = await readFile(f.inboxPath, 'utf8');
  assert.ok(persisted.includes(photo.event_id), 'the unmentioned image survives without an in-memory event cache');
  assert.ok(persisted.includes(ALICE));
  assert.ok(!persisted.includes(PNG.toString('base64')), 'the inbox persists references, not media bytes');
});

test('a failed inbox record releases event deduplication so replaying the same image can persist and analyze it', async (t) => {
  const f = await fixture(t);
  const photo = image('record-replay', { ts: f.baseTs });
  const record = f.inbox.record.bind(f.inbox);
  let attempts = 0;
  f.inbox.record = async (...args) => {
    attempts += 1;
    if (attempts === 1) throw new Error('fixture durable record failure');
    return await record(...args);
  };
  // The real sync loop owns a five-second error backoff. Advance its clock only
  // after observing the failed write, rather than waiting five wall-clock seconds
  // or treating elapsed time as evidence that the runtime handled the event.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const delivered = f.emit([photo]);
    await f.log.wait((entry) => entry.op === 'warn'
      && entry.args.some((arg) => String(arg).includes('sync loop error; retrying')), 'sync retry after the failed durable record');
    assert.equal(attempts, 1);
    assert.equal(f.inbox.get({ roomId: ROOM, eventId: photo.event_id }), null);
    assert.equal(f.askCalls.length, 0);
    assert.deepEqual(f.downloads(), []);
    t.mock.timers.tick(5_000);
    await delivered;
  } finally {
    t.mock.timers.reset();
  }
  // Same identity and payload: a new id would not exercise ring.forget().
  await f.emit([photo]);
  assert.equal(attempts, 2);
  await f.inbox.flush();
  assert.equal(f.inbox.get({ roomId: ROOM, eventId: photo.event_id }).consumed, false);
  assert.ok((await readFile(f.inboxPath, 'utf8')).includes(photo.event_id));
  await f.emit([question('record-replay-ask', { ts: f.baseTs + 1 })]);
  await f.answer(1);
  await f.consumed(photo);
  f.assertImages(1, [photo]);
});

test('an image that itself mentions the bot still reaches the model as an image', async (t) => {
  const f = await fixture(t);
  const photo = image('mentioned-image', { mention: true, ts: f.baseTs });
  await f.emit([photo]);
  await f.answer(1);
  f.assertImages(1, [photo]);
  assert.deepEqual(f.downloads(), [photo.content.url]);
});

test('one image followed by a separate text mention is loaded lazily and consumed only once', async (t) => {
  const f = await fixture(t);
  const photo = image('single', { ts: f.baseTs });
  await f.emit([photo]);
  assert.deepEqual(f.downloads(), []);
  assert.deepEqual(f.lookups(), []);
  const ask = question('single-ask', { body: '解释刚才的图片', ts: f.baseTs + 1 });
  await f.emit([ask]);
  await f.answer(1);
  await f.consumed(photo);
  f.assertImages(1, [photo]);
  assert.match(textOf(f.prompts[0]), /解释刚才的图片/);
  assert.ok(f.lookups().some((entry) => entry.roomId === ROOM && entry.eventId === photo.event_id));
  const next = question('single-next', { ts: f.baseTs + 2 });
  await f.emit([next]);
  await f.answer(2);
  f.assertImages(2, []);
  assert.deepEqual(f.downloads(), [photo.content.url]);
});

test('several unmentioned image messages become one ordered multi-image prompt, not just the last image', async (t) => {
  const f = await fixture(t);
  const photos = [0, 1, 2].map((offset) => image(`multi-${offset}`, { ts: f.baseTs + offset }));
  for (const photo of photos) await f.emit([photo]);
  assert.equal(f.askCalls.length, 0);
  assert.deepEqual(f.downloads(), []);
  await f.emit([question('multi-ask', { body: '对比这三张图片', ts: f.baseTs + 3 })]);
  await f.answer(1);
  for (const photo of photos) await f.consumed(photo);
  assert.equal(f.prompts.length, 1);
  f.assertImages(1, photos);
  assert.deepEqual(f.downloads(), photos.map((photo) => photo.content.url));
});

test('interleaved senders each receive only their own pending images', async (t) => {
  const f = await fixture(t);
  const a1 = image('alice-1', { ts: f.baseTs });
  const b1 = image('bob-1', { sender: BOB, ts: f.baseTs + 1 });
  const a2 = image('alice-2', { ts: f.baseTs + 2 });
  await f.emit([a1, b1, a2]);
  await f.emit([question('alice-ask', { ts: f.baseTs + 3 })]);
  await f.answer(1);
  await f.consumed(a1);
  await f.consumed(a2);
  f.assertImages(1, [a1, a2]);
  await f.emit([question('bob-ask', { sender: BOB, ts: f.baseTs + 4 })]);
  await f.answer(2);
  await f.consumed(b1);
  f.assertImages(2, [b1]);
});

test('an explicit reply selects exactly that image, including another sender\'s consumed image, and leaves unrelated pending images untouched', async (t) => {
  const f = await fixture(t);
  const target = image('reply-target', { sender: BOB, ts: f.baseTs });
  await f.emit([target]);
  await f.emit([question('bob-consume', { sender: BOB, ts: f.baseTs + 1 })]);
  await f.answer(1);
  await f.consumed(target);
  const pending = image('alice-pending', { ts: f.baseTs + 2 });
  const otherPending = image('bob-pending', { sender: BOB, ts: f.baseTs + 3 });
  await f.emit([pending, otherPending]);
  await f.emit([question('precise-reply', { body: '只解释引用的那一张', replyTo: target.event_id, ts: f.baseTs + 4 })]);
  await f.answer(2);
  f.assertImages(2, [target]);
  assert.deepEqual(f.downloads(), [target.content.url, target.content.url]);
  await f.emit([question('alice-after-reply', { ts: f.baseTs + 5 })]);
  await f.answer(3);
  await f.consumed(pending);
  f.assertImages(3, [pending]);
  await f.emit([question('bob-after-reply', { sender: BOB, ts: f.baseTs + 6 })]);
  await f.answer(4);
  await f.consumed(otherPending);
  f.assertImages(4, [otherPending]);
});

test('an explicit image reply can resolve a historical event absent from the inbox without attaching current pending images', async (t) => {
  const f = await fixture(t);
  const old = image('historical-reply', { sender: BOB, ts: f.baseTs - 3_600_000 });
  f.register(ROOM, old); // Homeserver history, never delivered to this runtime.
  const pending = image('historical-unrelated', { ts: f.baseTs });
  await f.emit([pending]);
  await f.emit([question('historical-ask', { replyTo: old.event_id, ts: f.baseTs + 1 })]);
  await f.answer(1);
  f.assertImages(1, [old]);
  assert.ok(f.lookups().some((entry) => entry.eventId === old.event_id && entry.roomId === ROOM));
  assert.deepEqual(f.downloads(), [old.content.url]);
  await f.emit([question('historical-next', { ts: f.baseTs + 2 })]);
  await f.answer(2);
  await f.consumed(pending);
  f.assertImages(2, [pending]);
});

test('an explicit reply to a text message does not attach or consume unrelated pending images', async (t) => {
  const f = await fixture(t);
  const text = event('explicit-text-target', { sender: BOB, body: '这是文字，不是图片', ts: f.baseTs });
  f.register(ROOM, text);
  const pending = image('explicit-text-pending', { ts: f.baseTs + 1 });
  await f.emit([pending]);
  const reply = question('explicit-text-ask', { body: '请解释引用的文字', replyTo: text.event_id, ts: f.baseTs + 2 });
  await f.emit([reply]);
  await f.answer(1);
  await f.settled(reply);
  f.assertImages(1, []);
  assert.match(textOf(f.prompts[0]), /请解释引用的文字/);
  assert.ok(f.lookups().some((entry) => entry.roomId === ROOM && entry.eventId === text.event_id));
  assert.deepEqual(f.downloads(), []);
  assert.equal(f.inbox.get({ roomId: ROOM, eventId: pending.event_id }).consumed, false);
  await f.emit([question('explicit-text-next', { ts: f.baseTs + 3 })]);
  await f.answer(2);
  await f.consumed(pending);
  f.assertImages(2, [pending]);
});

test('an unavailable explicit reply target reports an image error instead of stealing unrelated pending images', async (t) => {
  const f = await fixture(t);
  const pending = image('explicit-missing-pending', { ts: f.baseTs });
  const missingId = '$explicit-missing-target:example.org';
  await f.emit([pending]);
  const reply = question('explicit-missing-ask', { replyTo: missingId, ts: f.baseTs + 1 });
  await f.emit([reply]);
  await f.settled(reply);
  assert.equal(f.prompts.length, 0, 'a missing exact target cannot fall back to a different image or a text-only analysis');
  assert.equal(f.inputErrors.length, 1);
  assert.ok(f.inputErrors[0] instanceof ImagePromptError);
  assert.ok(f.sends().some((entry) => /图片|image/i.test(entry.content['m.new_content']?.body ?? entry.content.body ?? '')));
  assert.ok(f.lookups().some((entry) => entry.roomId === ROOM && entry.eventId === missingId));
  assert.deepEqual(f.downloads(), []);
  assert.equal(f.inbox.get({ roomId: ROOM, eventId: pending.event_id }).consumed, false);
  assert.equal(f.log.entries.some((entry) => entry.op === 'consumed'), false);
  await f.emit([question('explicit-missing-next', { ts: f.baseTs + 2 })]);
  await f.answer(1);
  await f.consumed(pending);
  f.assertImages(1, [pending]);
});

test('automatic association never crosses a room or thread, including the main timeline', async (t) => {
  const f = await fixture(t);
  const main = image('scope-main', { ts: f.baseTs });
  const threaded = image('scope-thread', { threadId: THREAD, ts: f.baseTs + 1 });
  const otherThread = image('scope-other-thread', { threadId: OTHER_THREAD, ts: f.baseTs + 2 });
  const otherRoom = image('scope-other-room', { ts: f.baseTs + 3 });
  await f.emit([main, threaded, otherThread]);
  await f.emit([otherRoom], OTHER_ROOM);
  const cases = [
    { room: ROOM, threadId: null, expected: main },
    { room: ROOM, threadId: THREAD, expected: threaded },
    { room: OTHER_ROOM, threadId: null, expected: otherRoom },
    { room: ROOM, threadId: OTHER_THREAD, expected: otherThread },
  ];
  for (const [offset, row] of cases.entries()) {
    await f.emit([question(`scope-ask-${offset}`, { threadId: row.threadId, ts: f.baseTs + 4 + offset })], row.room);
    const answer = await f.answer(offset + 1);
    await f.consumed(row.expected);
    assert.equal(answer.roomId, row.room);
    f.assertImages(offset + 1, [row.expected]);
  }
});

test('the default association window is ten minutes and a configured window overrides it', async (t) => {
  for (const [name, config, insideAge, outsideAge] of [
    ['default', {}, 9 * 60_000, 11 * 60_000],
    ['configured', { imageAssociationWindowMs: 30_000 }, 20_000, 40_000],
  ]) {
    await t.test(name, async (t) => {
      const f = await fixture(t, { config });
      const old = image(`window-${name}-old`, { ts: f.baseTs - outsideAge });
      const recent = image(`window-${name}-recent`, { ts: f.baseTs - insideAge });
      // Recovered references predate this runtime's startup clock guard. Seed
      // them through the real durable store; event timestamps are the clock
      // input, so the test never waits for wall-clock expiry.
      await f.seed(old);
      await f.seed(recent);
      await f.emit([question(`window-${name}-ask`, { ts: f.baseTs })]);
      await f.answer(1);
      await f.consumed(recent);
      f.assertImages(1, [recent]);
      assert.deepEqual(f.downloads(), [recent.content.url]);
    });
  }
});

test('ordinary chatter and a mentioned command do not consume pending image references', async (t) => {
  const f = await fixture(t);
  const photo = image('command-pending', { ts: f.baseTs });
  await f.emit([photo, event('unmentioned-chatter', { ts: f.baseTs + 1 })]);
  assert.equal(f.askCalls.length, 0);
  const beforeCommand = f.log.entries.length;
  await f.emit([question('mentioned-command', { body: '/help', ts: f.baseTs + 2 })]);
  await f.log.wait((entry) => entry.op === 'send' && entry.type === 'm.room.message', 'the command reply', beforeCommand);
  assert.equal(f.askCalls.length, 0);
  assert.deepEqual(f.downloads(), []);
  await f.emit([question('after-command', { ts: f.baseTs + 3 })]);
  await f.answer(1);
  await f.consumed(photo);
  f.assertImages(1, [photo]);
});

test('lookup/download failures produce an image-specific user error, submit no model prompt, and retain pending images for retry', async (t) => {
  const failures = [
    ['getEvent throws', 'getEvent', () => { throw new Error('fixture lookup failure'); }],
    ['getEvent missing', 'getEvent', () => null],
    ['download throws', 'download', () => { throw new Error('fixture download failure'); }],
    ['download empty', 'download', () => null],
    ['invalid image bytes', 'download', () => Buffer.from('not an image')],
  ];
  for (const [name, operation, fail] of failures) {
    await t.test(name, async (t) => {
      const f = await fixture(t);
      const photos = [image('retry-first', { ts: f.baseTs }), image('retry-second', { ts: f.baseTs + 1 })];
      await f.emit(photos);
      f.faults[operation] = fail;
      const failed = question('retry-failed', { ts: f.baseTs + 2 });
      const start = f.log.entries.length;
      await f.emit([failed]);
      const notice = await f.log.wait((entry) => entry.op === 'send' && entry.type === 'm.room.message'
        && /图片|image/i.test(entry.content['m.new_content']?.body ?? entry.content.body ?? ''), 'an image-specific failure notice', start);
      assert.ok(notice.content.body || notice.content['m.new_content']?.body);
      await f.settled(failed, start);
      assert.equal(f.prompts.length, 0, 'a failed lazy source must never become an image-free model submission');
      assert.equal(f.inputErrors.length, 1);
      assert.ok(f.inputErrors[0] instanceof ImagePromptError, 'image failures preserve their typed user-facing diagnostic');
      assert.equal(f.log.entries.filter((entry) => entry.op === 'consumed').length, 0);
      delete f.faults[operation];
      await f.emit([question('retry-success', { ts: f.baseTs + 3 })]);
      await f.answer(1);
      for (const photo of photos) await f.consumed(photo);
      f.assertImages(1, photos);
    });
  }
});

test('a later image download failure rejects the whole multi-image submission and retries every pending image', async (t) => {
  const f = await fixture(t);
  const photos = [image('partial-good', { ts: f.baseTs }), image('partial-bad', { ts: f.baseTs + 1 })];
  await f.emit(photos);
  f.faults.download = (uri) => {
    if (uri === photos[1].content.url) throw new Error('fixture second image failure');
    assert.equal(uri, photos[0].content.url);
    return Buffer.concat([PNG, Buffer.from(photos[0].event_id)]);
  };
  const failed = question('partial-failed', { ts: f.baseTs + 2 });
  await f.emit([failed]);
  await f.settled(failed);
  assert.deepEqual(f.downloads(), photos.map((photo) => photo.content.url), 'the first image really loaded before the second failed');
  assert.equal(f.prompts.length, 0, 'neither a partial-image nor a text-only prompt may be submitted');
  assert.ok(f.inputErrors[0] instanceof ImagePromptError);
  assert.equal(f.log.entries.some((entry) => entry.op === 'consumed'), false);
  delete f.faults.download;
  await f.emit([question('partial-retry', { ts: f.baseTs + 3 })]);
  await f.answer(1);
  for (const photo of photos) await f.consumed(photo);
  f.assertImages(1, photos);
  assert.deepEqual(f.downloads(), [...photos, ...photos].map((photo) => photo.content.url));
});

test('a failed final answer delivery does not consume images even though the model answered successfully', async (t) => {
  const f = await fixture(t);
  const photo = image('delivery-retry', { ts: f.baseTs });
  await f.emit([photo]);
  f.faults.send = (body) => {
    // Reject both the final edit and the bridge's fallback send, not the error
    // notice. A send call alone is not evidence that the answer was delivered.
    if (body.includes('分析完成-1')) throw new Error('fixture final delivery failure');
  };
  const failed = question('delivery-failed', { ts: f.baseTs + 1 });
  await f.emit([failed]);
  await f.settled(failed);
  assert.equal(f.prompts.length, 1);
  assert.equal(f.log.entries.some((entry) => entry.op === 'consumed'), false);
  assert.equal(f.sends().some((entry) => (entry.content['m.new_content']?.body ?? entry.content.body).includes('分析完成-1')), false);
  delete f.faults.send;
  await f.emit([question('delivery-retry-ask', { ts: f.baseTs + 2 })]);
  await f.answer(2);
  await f.consumed(photo);
  f.assertImages(1, [photo]);
  f.assertImages(2, [photo]);
});

test('a failed consumption write preserves the delivered answer, reports an operational notice, and leaves images retryable', async (t) => {
  const f = await fixture(t);
  const photo = image('consume-write-retry', { ts: f.baseTs });
  await f.emit([photo]);
  const markConsumed = f.inbox.markConsumed.bind(f.inbox);
  let attempts = 0;
  f.inbox.markConsumed = async (...args) => {
    attempts += 1;
    if (attempts === 1) throw new Error('fixture consumption persistence failure');
    return await markConsumed(...args);
  };
  const first = question('consume-write-first', { ts: f.baseTs + 1 });
  await f.emit([first]);
  await f.answer(1);
  const notice = await f.log.wait((entry) => entry.op === 'send' && entry.type === 'm.room.message'
    && /图片处理状态保存失败/.test(entry.content['m.new_content']?.body ?? entry.content.body ?? ''), 'an operational image-consumption persistence notice');
  await f.settled(first);
  assert.equal(notice.roomId, ROOM);
  assert.equal(notice.content.msgtype, 'm.notice', 'the persistence warning is operational feedback, not a second model answer');
  assert.match(f.runtime.status.lastError, /图片处理状态保存失败/);
  assert.equal(attempts, 1);
  assert.equal(f.prompts.length, 1, 'a post-delivery persistence failure must not discard the successful model answer');
  f.assertImages(1, [photo]);
  assert.equal(f.inbox.get({ roomId: ROOM, eventId: photo.event_id }).consumed, false);
  assert.deepEqual(f.inbox.pending({ roomId: ROOM, senderId: ALICE, threadId: null }).map((entry) => entry.eventId), [photo.event_id]);
  assert.equal(f.log.entries.some((entry) => entry.op === 'consumed'), false);
  await f.emit([question('consume-write-next', { ts: f.baseTs + 2 })]);
  await f.answer(2);
  await f.consumed(photo);
  assert.equal(attempts, 2);
  f.assertImages(2, [photo]);
  assert.deepEqual(f.downloads(), [photo.content.url, photo.content.url]);
  assert.equal(f.inbox.get({ roomId: ROOM, eventId: photo.event_id }).consumed, true);
});

test('a failed model turn does not consume successfully downloaded images', async (t) => {
  const f = await fixture(t, { onAsk: ({ index }) => {
    if (index === 1) throw new Error('fixture model failure');
    return `分析完成-${index}`;
  } });
  const photo = image('model-retry', { ts: f.baseTs });
  await f.emit([photo]);
  const failed = question('model-failed', { ts: f.baseTs + 1 });
  await f.emit([failed]);
  await f.settled(failed);
  assert.equal(f.log.entries.filter((entry) => entry.op === 'consumed').length, 0);
  await f.emit([question('model-retry-ask', { ts: f.baseTs + 2 })]);
  await f.answer(2);
  await f.consumed(photo);
  f.assertImages(1, [photo]);
  f.assertImages(2, [photo]);
});

test('restarting with a new inbox and runtime recovers references and fetches the original image only on a later mention', async (t) => {
  const f = await fixture(t);
  const photos = [image('restart-1', { ts: f.baseTs }), image('restart-2', { ts: f.baseTs + 1 })];
  await f.emit(photos);
  await f.inbox.flush();
  const previousInbox = f.inbox;
  const previousRuntime = f.runtime;
  await f.restart();
  assert.notEqual(f.inbox, previousInbox);
  assert.notEqual(f.runtime, previousRuntime);
  assert.deepEqual(f.downloads(), []);
  assert.deepEqual(f.lookups(), []);
  assert.equal(f.askCalls.length, 0);
  await f.emit([question('restart-ask', { ts: f.baseTs + 2 })]);
  await f.answer(1);
  for (const photo of photos) await f.consumed(photo);
  f.assertImages(1, photos);
  for (const photo of photos) assert.ok(f.lookups().some((entry) => entry.roomId === ROOM && entry.eventId === photo.event_id));
  // Consumption is durable too, not merely a transient runtime cache.
  await f.inbox.flush();
  await f.restart();
  await f.emit([question('restart-after-consumption', { ts: f.baseTs + 3 })]);
  await f.answer(2);
  f.assertImages(2, []);
  assert.deepEqual(f.downloads(), photos.map((photo) => photo.content.url));
});

test('a same-sender image follow-up during an active text turn queues its media instead of being swallowed by text steering', async (t) => {
  let firstTurn;
  const f = await fixture(t, { onAsk: async ({ index }) => {
    if (index === 1) await firstTurn.promise;
    return `分析完成-${index}`;
  } });
  firstTurn = f.barrier();
  await f.emit([question('active-start', { body: '先回答这个文字问题', ts: f.baseTs })]);
  await f.log.wait((entry) => entry.op === 'model-prompt' && entry.index === 1, 'the first active model turn');
  const photo = image('active-photo', { ts: f.baseTs + 1 });
  await f.emit([photo]);
  const followup = question('active-image-followup', { body: '然后看看这张图', ts: f.baseTs + 2 });
  await f.emit([followup]);
  await f.log.wait((entry) => entry.op === 'queued' && entry.messageId === followup.event_id, 'the media-bearing follow-up to join the queue');
  assert.deepEqual(f.steerCalls, [], 'an associated image is already media-bearing when the bridge decides whether to steer');
  assert.equal(f.prompts.length, 1, 'the second turn cannot overtake the held first turn');
  firstTurn.resolve();
  await f.answer(2);
  await f.consumed(photo);
  f.assertImages(1, []);
  f.assertImages(2, [photo]);
});

test('a mention queued while the first lazy image download is failing retries that image instead of submitting text alone', async (t) => {
  const f = await fixture(t);
  const photo = image('queued-download-retry', { ts: f.baseTs });
  const firstDownload = f.barrier();
  let attempts = 0;
  f.faults.download = async (uri) => {
    assert.equal(uri, photo.content.url);
    attempts += 1;
    if (attempts === 1) {
      await firstDownload.promise;
      throw new Error('fixture held first image download failed');
    }
    return Buffer.concat([PNG, Buffer.from(photo.event_id)]);
  };
  await f.emit([photo]);
  const first = question('queued-download-first', { body: '第一次分析这张图', ts: f.baseTs + 1 });
  await f.emit([first]);
  await f.log.wait((entry) => entry.op === 'download' && entry.uri === photo.content.url, 'the first lazy image download to enter its failure barrier');
  const second = question('queued-download-second', { body: '第二次请重试这张图', ts: f.baseTs + 2 });
  await f.emit([second]);
  await f.log.wait((entry) => entry.op === 'queued' && entry.messageId === second.event_id, 'the second mention to queue before the first image download fails');
  assert.equal(attempts, 1);
  assert.equal(f.prompts.length, 0, 'the held download has not submitted any model input');
  assert.deepEqual(f.steerCalls, [], 'the second mention must retain its image identity at intake');
  firstDownload.resolve();
  await f.settled(first);
  await f.answer(1);
  await f.consumed(photo);
  assert.equal(attempts, 2, 'the already-queued second mention really retries the failed original image');
  assert.equal(f.inputErrors.length, 1);
  assert.ok(f.inputErrors[0] instanceof ImagePromptError);
  assert.equal(f.prompts.length, 1);
  assert.match(textOf(f.prompts[0]), /第二次请重试这张图/);
  f.assertImages(1, [photo]);
  assert.deepEqual(f.downloads(), [photo.content.url, photo.content.url]);
});

test('an in-flight image is not automatically attached twice before its successful answer consumes it', async (t) => {
  let firstTurn;
  const f = await fixture(t, { config: { autoSteerSameSender: false }, onAsk: async ({ index }) => {
    if (index === 1) await firstTurn.promise;
    return `分析完成-${index}`;
  } });
  firstTurn = f.barrier();
  const photo = image('reserved-image', { ts: f.baseTs });
  await f.emit([photo]);
  await f.emit([question('reserved-first', { ts: f.baseTs + 1 })]);
  await f.log.wait((entry) => entry.op === 'model-prompt' && entry.index === 1, 'the image-bearing model turn');
  const second = question('reserved-second', { ts: f.baseTs + 2 });
  await f.emit([second]);
  await f.log.wait((entry) => entry.op === 'queued' && entry.messageId === second.event_id, 'the second mention to queue before the first image answer finishes');
  firstTurn.resolve();
  await f.answer(2);
  await f.consumed(photo);
  f.assertImages(1, [photo]);
  f.assertImages(2, []);
  assert.deepEqual(f.downloads(), [photo.content.url]);
});
