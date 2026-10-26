import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createProductionController } from '../../../plugin-src/host/channels/matrix/production.mjs';
import { MatrixImageInboxStore } from '../../../src/channels/matrix/matrix-image-inbox.mjs';

const BOT_A = 'matrix_image_bot_a';
const BOT_B = 'matrix_image_bot_b';
const ROOM = '!production-images:example.org';
const SENDER = '@alice:example.org';
const botConfig = (botId, extra = {}) => ({
  botId, name: botId, homeserver: 'https://matrix.example.org',
  userId: `@${botId}:example.org`, e2eeMode: 'off', ...extra,
});
const reference = (name, extra = {}) => ({
  roomId: ROOM, eventId: `$${name}:example.org`, senderId: SENDER,
  threadId: null, ts: 1_800_000_000_000, name: `${name}.png`, ...extra,
});
const pendingIds = (inbox) => inbox.pending({ roomId: ROOM, senderId: SENDER, threadId: null }).map((entry) => entry.eventId);

async function productionFixture(t, bots = [botConfig(BOT_A), botConfig(BOT_B)]) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-matrix-production-images-'));
  const contexts = [];
  const inboxes = new Set();
  const lifecycle = [];
  let current;
  t.after(async () => {
    for (const context of [...contexts].reverse()) await close(context);
    for (const inbox of inboxes) await inbox.flush();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const forbidden = () => assert.fail('production wiring tests must not use credentials, a real Harness, or network');
  const credentials = { get: forbidden, set: forbidden, remove: forbidden, delete: forbidden };
  const ctx = {
    credentials,
    typertGateway: { invoke: forbidden, stream: forbidden },
    logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
  };

  async function close(context) {
    if (context.closed) return;
    context.closed = true;
    await context.production.close();
  }

  async function open() {
    const context = { runtimeOptions: [], controllerOptions: null, closed: false };
    class ConfigStore {
      async load() { return this; }
      list() { return structuredClone(bots); }
    }
    class Harness {
      constructor(options) {
        assert.equal(options.autostart, false);
        lifecycle.push({ op: 'harness-created', context });
      }
      ensureRunning = forbidden;
      ask = forbidden;
      stopManagedProcess() { lifecycle.push({ op: 'harness-stopped', context }); }
    }
    class Runtime {
      constructor(options) {
        this.options = options;
        context.runtimeOptions.push(options);
        if (options.imageInbox) inboxes.add(options.imageInbox);
      }
    }
    class Controller {
      constructor(options) {
        assert.equal(options.credentials, credentials);
        context.controllerOptions = options;
      }
      async close() { lifecycle.push({ op: 'controller-closed', context }); }
    }
    const createConnectionSupervisor = (options) => {
      assert.equal(options.channel, 'matrix');
      return {
        ready: Promise.resolve(),
        start() { lifecycle.push({ op: 'supervisor-started', context }); return this; },
        async close() { lifecycle.push({ op: 'supervisor-closed', context }); },
      };
    };
    context.production = await createProductionController(ctx, {
      dataDir: directory,
      dshHome: join(directory, 'dsh-home'),
      workspace: directory,
      harnessBaseUrl: 'https://harness.invalid', // Parser input only: Harness is an inert stub.
    }, {
      ConfigStore, HarnessClient: Harness, Runtime, Controller, createConnectionSupervisor,
      // Avoid the process-global inbound-TTL runtime and its background sweeper.
      inboundTtl: { stagingRetention: forbidden, trackStaged: forbidden },
    });
    contexts.push(context);
    current = context;
    await context.production.ready;
    return context;
  }

  const f = {
    directory, lifecycle,
    get current() { return current; },
    imagePath: (botId) => join(directory, 'bots', botId, 'matrix-images.json'),
    async runtime(botId, extra = {}) {
      const config = { ...bots.find((bot) => bot.botId === botId), ...extra };
      assert.equal(config.botId, botId, 'the requested bot belongs to this fixture');
      return current.controllerOptions.createRuntime({
        botId, config, accessToken: 'fixture-only-no-real-credentials',
      });
    },
    async deleteState(botId) { await current.controllerOptions.deleteState({ botId }); },
    async restart() { await close(current); return open(); },
    async close() { await close(current); },
  };
  await open();
  return f;
}

test('Matrix production injects a real persistent image inbox, sharing only within the same bot', async (t) => {
  const f = await productionFixture(t);
  const first = await f.runtime(BOT_A);
  const rebuilt = await f.runtime(BOT_A);
  const other = await f.runtime(BOT_B);
  const aInbox = first.options.imageInbox;
  const bInbox = other.options.imageInbox;
  assert.ok(aInbox instanceof MatrixImageInboxStore, 'production must inject the real store, not a fixture-supplied replacement');
  assert.ok(bInbox instanceof MatrixImageInboxStore);
  assert.equal(rebuilt.options.imageInbox, aInbox, 'reconstructing one bot runtime reuses its loaded store');
  assert.notEqual(bInbox, aInbox, 'different bots must never share an inbox instance');
  const entry = reference('shared-event-id');
  await aInbox.record(entry);
  assert.deepEqual(pendingIds(rebuilt.options.imageInbox), [entry.eventId]);
  assert.deepEqual(pendingIds(bInbox), []);
  // Even the same Matrix room/event identity is independent in the other bot.
  await bInbox.record({ ...entry, name: 'other-bot.png' });
  await aInbox.markConsumed({ roomId: ROOM, eventIds: [entry.eventId] });
  assert.deepEqual(pendingIds(aInbox), []);
  assert.deepEqual(pendingIds(bInbox), [entry.eventId]);
  const aDocument = JSON.parse(await readFile(f.imagePath(BOT_A), 'utf8'));
  const bDocument = JSON.parse(await readFile(f.imagePath(BOT_B), 'utf8'));
  assert.equal(aDocument.entries[0].consumed, true);
  assert.equal(bDocument.entries[0].consumed, false);
  assert.equal(bDocument.entries[0].name, 'other-bot.png');
});

test('Matrix production passes each bot imageHistoryLimit into real inbox retention', async (t) => {
  const f = await productionFixture(t, [botConfig(BOT_A, { imageHistoryLimit: 2 }), botConfig(BOT_B, { imageHistoryLimit: 3 })]);
  const a = (await f.runtime(BOT_A)).options.imageInbox;
  const b = (await f.runtime(BOT_B)).options.imageInbox;
  const entries = Array.from({ length: 4 }, (_, index) => reference(`retention-${index}`));
  for (const entry of entries) {
    await a.record(entry);
    await b.record(entry);
  }
  assert.deepEqual(pendingIds(a), entries.slice(-2).map((entry) => entry.eventId));
  assert.deepEqual(pendingIds(b), entries.slice(-3).map((entry) => entry.eventId));
  assert.equal(a.get({ roomId: ROOM, eventId: entries[1].eventId }), null);
  assert.ok(b.get({ roomId: ROOM, eventId: entries[1].eventId }));
  assert.equal(JSON.parse(await readFile(f.imagePath(BOT_A), 'utf8')).entries.length, 2);
  assert.equal(JSON.parse(await readFile(f.imagePath(BOT_B), 'utf8')).entries.length, 3);
});

test('closing and recreating the production controller restores image references and consumption from disk', async (t) => {
  const f = await productionFixture(t);
  const original = (await f.runtime(BOT_A)).options.imageInbox;
  const pending = reference('controller-restart-pending');
  const consumed = reference('controller-restart-consumed');
  await original.record(pending);
  await original.record(consumed);
  await original.markConsumed({ roomId: ROOM, eventIds: [consumed.eventId] });
  const previousContext = f.current;
  await f.restart();
  assert.notEqual(f.current, previousContext);
  assert.deepEqual(f.lifecycle.filter((entry) => entry.context === previousContext).map((entry) => entry.op), [
    'harness-created', 'supervisor-started', 'supervisor-closed', 'controller-closed', 'harness-stopped',
  ]);
  const recovered = (await f.runtime(BOT_A)).options.imageInbox;
  assert.notEqual(recovered, original, 'a fresh production controller owns a newly loaded inbox instance');
  assert.ok(recovered instanceof MatrixImageInboxStore);
  assert.deepEqual(pendingIds(recovered), [pending.eventId]);
  assert.equal(recovered.get({ roomId: ROOM, eventId: consumed.eventId }).consumed, true);
  assert.equal((await f.runtime(BOT_A)).options.imageInbox, recovered);
  await recovered.record(reference('controller-restart-new'));
  const disk = await new MatrixImageInboxStore(f.imagePath(BOT_A)).load();
  assert.deepEqual(pendingIds(disk), [pending.eventId, '$controller-restart-new:example.org']);
});

test('production close reports a real inbox flush failure but still stops the managed Harness', async (t) => {
  const f = await productionFixture(t);
  const inbox = (await f.runtime(BOT_A)).options.imageInbox;
  await inbox.record(reference('close-flush-failure'));
  const context = f.current;
  const flush = inbox.flush.bind(inbox);
  const failure = new Error('fixture image inbox flush failure');
  let flushCalls = 0;
  inbox.flush = async () => {
    flushCalls += 1;
    await flush();
    f.lifecycle.push({ op: 'inbox-flush-failed', context });
    throw failure;
  };
  try {
    await assert.rejects(f.close(), (error) => error === failure, 'close must not swallow the failed persistence barrier');
    assert.equal(flushCalls, 1);
    assert.deepEqual(f.lifecycle.filter((entry) => entry.context === context).map((entry) => entry.op), [
      'harness-created', 'supervisor-started', 'supervisor-closed', 'controller-closed', 'inbox-flush-failed', 'harness-stopped',
    ]);
    assert.ok((await readFile(f.imagePath(BOT_A), 'utf8')).includes('$close-flush-failure:example.org'));
  } finally {
    // Restore the instance-local fault before the fixture's final store barrier.
    inbox.flush = flush;
  }
});

test('deleteState removes only that bot image file, evicts its cached inbox, and preserves other bot data', async (t) => {
  const f = await productionFixture(t);
  const a = (await f.runtime(BOT_A)).options.imageInbox;
  const b = (await f.runtime(BOT_B)).options.imageInbox;
  await a.record(reference('delete-a'));
  await b.record(reference('keep-b'));
  const otherMarker = join(f.directory, 'bots', BOT_B, 'unrelated.json');
  await writeFile(otherMarker, '{"keep":"other bot data"}\n');
  const otherImageBefore = await readFile(f.imagePath(BOT_B));
  const otherMarkerBefore = await readFile(otherMarker);
  await f.deleteState(BOT_A);
  await assert.rejects(readFile(f.imagePath(BOT_A)), { code: 'ENOENT' });
  assert.deepEqual(await readFile(f.imagePath(BOT_B)), otherImageBefore);
  assert.deepEqual(await readFile(otherMarker), otherMarkerBefore);
  assert.deepEqual(pendingIds(b), ['$keep-b:example.org']);
  const recreated = (await f.runtime(BOT_A)).options.imageInbox;
  assert.notEqual(recreated, a, 'deleteState must evict the store, not just unlink its backing file');
  assert.deepEqual(pendingIds(recreated), []);
  await recreated.record(reference('delete-a-new'));
  assert.deepEqual(JSON.parse(await readFile(f.imagePath(BOT_A), 'utf8')).entries.map((entry) => entry.eventId), ['$delete-a-new:example.org']);
  assert.equal((await f.runtime(BOT_B)).options.imageInbox, b);
  await f.deleteState(BOT_A);
  await f.deleteState(BOT_A); // Missing files and an absent cache entry are idempotent.
});

test('deleteState also removes a recovered bot image file before that controller creates any runtime', async (t) => {
  const f = await productionFixture(t);
  await (await f.runtime(BOT_A)).options.imageInbox.record(reference('delete-unloaded-a'));
  await (await f.runtime(BOT_B)).options.imageInbox.record(reference('keep-unloaded-b'));
  const otherBefore = await readFile(f.imagePath(BOT_B));
  await f.restart();
  assert.deepEqual(f.current.runtimeOptions, []);
  await f.deleteState(BOT_A);
  await assert.rejects(readFile(f.imagePath(BOT_A)), { code: 'ENOENT' });
  assert.deepEqual(await readFile(f.imagePath(BOT_B)), otherBefore);
  const empty = (await f.runtime(BOT_A)).options.imageInbox;
  assert.deepEqual(pendingIds(empty), []);
  const other = (await f.runtime(BOT_B)).options.imageInbox;
  assert.deepEqual(pendingIds(other), ['$keep-unloaded-b:example.org']);
});
