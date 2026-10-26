import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConversationStateStore } from '../../../src/channels/shared/conversation-state-store.mjs';
import { TextHarnessBridge } from '../../../src/channels/shared/text-harness-bridge.mjs';

const logger = { warn() {}, error() {} };
const target = { roomId: '!room:example.org' };
const key = 'group:room:!room:example.org';

async function temporary(run) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-media-queue-recovery-'));
  try {
    await run(join(directory, 'state.json'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function queued(messageId, extra = {}) {
  return {
    id: `${key}\u0000${messageId}`, key, messageId, kind: 'group',
    text: `task ${messageId}`, senderId: '@alice:example.org', target,
    submitted: false, ...extra,
  };
}

function message(messageId, extra = {}) {
  return {
    kind: 'group', conversationId: 'room:!room:example.org', messageId,
    senderId: '@alice:example.org', content: `task ${messageId}`,
    addressed: true, replyTarget: target, ...extra,
  };
}

function bridgeFor(state, { ask, send, signal } = {}) {
  return new TextHarnessBridge({
    descriptor: { key: 'matrix', label: 'Matrix' },
    state, signal, logger,
    bot: { async sendText(destination, text) {
      send?.(destination, text);
      return { providerMessageIds: ['$answer:example.org'], deliveryOutcome: 'sent' };
    } },
    harness: {
      ensureRunning: async () => true,
      sessionExists: async () => true,
      createSession: async () => 'media-recovery-session',
      ask: ask ?? (async () => 'answer'),
    },
  });
}

test('pending state preserves only requiresMedia:true across write, patch and reload', async () => {
  await temporary(async (path) => {
    const state = await new ConversationStateStore(path).load();
    for (const [index, flag] of [true, false, undefined, null, 'true', 1].entries()) {
      await state.putPendingMessage(queued(`entry-${index}`, { requiresMedia: flag }));
    }
    await state.patchPendingMessage(queued('entry-0').id, { submitted: true });
    const reloaded = await new ConversationStateStore(path).load();
    const entries = reloaded.pendingMessages();
    assert.equal(entries[0].requiresMedia, true);
    assert.equal(entries[0].submitted, true);
    for (const entry of entries.slice(1)) {
      assert.equal(Object.hasOwn(entry, 'requiresMedia'), false, 'plain/legacy entries retain their old shape');
    }
    const disk = JSON.parse(await readFile(path, 'utf8')).pendingMessages;
    assert.equal(disk[0].requiresMedia, true);
    for (const entry of disk.slice(1)) assert.equal(Object.hasOwn(entry, 'requiresMedia'), false);
  });
});

test('queued images, files and reply references persist a safety marker without persisting loaders or bytes', async () => {
  await temporary(async (path) => {
    const state = await new ConversationStateStore(path).load();
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const recorded = Promise.withResolvers();
    const controller = new AbortController();
    let sourceLoads = 0;
    const mediaLoad = async () => { sourceLoads += 1; throw new Error('must remain queued'); };
    const put = state.putPendingMessage.bind(state);
    state.putPendingMessage = async (entry) => {
      await put(entry);
      if (entry.messageId === 'plain-queued') recorded.resolve();
    };
    const bridge = bridgeFor(state, { signal: controller.signal, ask: async () => {
      entered.resolve();
      await release.promise;
      controller.signal.throwIfAborted();
      return 'answer';
    } });
    const tasks = [];
    try {
      await bridge.recoverPendingMessages();
      tasks.push(bridge.accept(message('active')));
      await entered.promise;
      tasks.push(bridge.accept(message('image-queued', { images: [{ name: 'private.png', load: mediaLoad }] })));
      tasks.push(bridge.accept(message('file-queued', { files: [{ name: 'private.txt', load: mediaLoad }] })));
      tasks.push(bridge.accept(message('reply-queued', { replyTo: { messageId: '$original', load: mediaLoad } })));
      tasks.push(bridge.accept(message('plain-queued')));
      await recorded.promise;
      const diskText = await readFile(path, 'utf8');
      const entries = JSON.parse(diskText).pendingMessages;
      for (const id of ['image-queued', 'file-queued', 'reply-queued']) {
        const entry = entries.find((candidate) => candidate.messageId === id);
        assert.equal(entry.submitted, false);
        assert.equal(entry.requiresMedia, true);
      }
      assert.equal(Object.hasOwn(entries.find((entry) => entry.messageId === 'plain-queued'), 'requiresMedia'), false);
      assert.equal(sourceLoads, 0, 'recording queued media never calls its loaders');
      assert.doesNotMatch(diskText, /private\.png|private\.txt|must remain queued|"images"|"files"|"replyTo"/);
    } finally {
      controller.abort(new Error('test cleanup stops blocked turns'));
      release.resolve();
      await Promise.allSettled(tasks);
      await bridge.waitForIdle();
    }
  });
});

test('an empty-caption queued image persists an internal sentinel and restart never submits it to the model', async () => {
  await temporary(async (path) => {
    const state = await new ConversationStateStore(path).load();
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const recorded = Promise.withResolvers();
    const controller = new AbortController();
    let downloads = 0;
    const put = state.putPendingMessage.bind(state);
    state.putPendingMessage = async (entry) => {
      await put(entry);
      if (entry.messageId === 'empty-caption-image') recorded.resolve();
    };
    const original = bridgeFor(state, { signal: controller.signal, ask: async () => {
      entered.resolve();
      await release.promise;
      controller.signal.throwIfAborted();
      return 'answer';
    } });
    const tasks = [];
    try {
      await original.recoverPendingMessages();
      tasks.push(original.accept(message('active')));
      await entered.promise;
      tasks.push(original.accept(message('empty-caption-image', {
        content: '', mentioned: true,
        images: [{ name: 'original.png', load: async () => { downloads += 1; throw new Error('must not download'); } }],
      })));
      await recorded.promise;
      const persisted = await readFile(path, 'utf8');
      const entry = JSON.parse(persisted).pendingMessages.find((candidate) => candidate.messageId === 'empty-caption-image');
      assert.equal(entry.text, '[media]');
      assert.equal(entry.requiresMedia, true);
      assert.equal(entry.submitted, false);
      assert.equal(downloads, 0);

      // Snapshot the crash-time file to a separate path so the still-live test
      // owner cannot race the restarted store's writes or recovery removals.
      const restartedPath = `${path}.restarted`;
      await writeFile(restartedPath, persisted, 'utf8');
      const reopened = await new ConversationStateStore(restartedPath).load();
      const notices = [];
      let asks = 0;
      const restarted = bridgeFor(reopened, {
        ask: async () => { asks += 1; return 'unexpected text-only answer'; },
        send: (_destination, text) => notices.push(text),
      });
      await restarted.recoverPendingMessages();
      await restarted.waitForIdle();
      assert.equal(asks, 0, 'neither the sentinel nor its image-free request reaches the model');
      assert.equal(downloads, 0);
      assert.equal(notices.length, 2, 'both the submitted turn and the unsubmitted image are reported');
      for (const notice of notices) assert.match(notice, /重启|restart/i);
      assert.deepEqual(reopened.pendingMessages(), []);
    } finally {
      controller.abort(new Error('test cleanup stops blocked turns'));
      release.resolve();
      await Promise.allSettled(tasks);
      await original.waitForIdle();
    }
  });
});

test('restart reports unsubmitted media instead of replaying an image-free task, while plain queued text still replays', async () => {
  await temporary(async (path) => {
    const state = await new ConversationStateStore(path).load();
    for (const id of ['image', 'file', 'reply']) {
      await state.putPendingMessage(queued(id, { requiresMedia: true }));
    }
    await state.putPendingMessage(queued('submitted', { submitted: true }));
    await state.putPendingMessage(queued('plain'));
    const reopened = await new ConversationStateStore(path).load();
    const asks = [];
    const sends = [];
    const bridge = bridgeFor(reopened, {
      ask: async (_sessionId, content, options) => { asks.push({ content, options }); return 'answer'; },
      send: (destination, text) => sends.push({ destination, text }),
    });
    await bridge.recoverPendingMessages();
    await bridge.waitForIdle();
    assert.equal(asks.length, 1, 'none of the interrupted media requests may reach the model as plain text');
    assert.match(JSON.stringify(asks[0].content), /task plain/);
    assert.doesNotMatch(JSON.stringify(asks[0].content), /task image|task file|task reply|task submitted/);
    const notices = sends.filter((entry) => /重启|restart/i.test(entry.text));
    assert.equal(notices.length, 4);
    for (const entry of notices) {
      assert.deepEqual(entry.destination, target);
      assert.match(entry.text, /重新发送|resend/i);
    }
    assert.deepEqual(reopened.pendingMessages(), []);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).pendingMessages ?? [], []);
    await bridge.recoverPendingMessages();
    assert.equal(asks.length, 1, 'recovery is idempotent');
    assert.equal(sends.filter((entry) => /重启|restart/i.test(entry.text)).length, 4);
  });
});
