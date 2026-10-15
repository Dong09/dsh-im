import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { BotWorkspaceStore } from '../src/channels/shared/bot-workspace-store.mjs';
import { conversationDirectoryName } from '../src/channels/shared/conversation-directory-ensure.mjs';
import { validateConversationDirectory } from '../src/channels/shared/conversation-directory.mjs';

test('conversation directory names are stable, bounded, and distinguish sanitized keys', () => {
  const config = { enabled: true };
  const first = conversationDirectoryName('p2p:a:b', config);
  assert.equal(first, conversationDirectoryName('p2p:a:b', config));
  assert.notEqual(first, conversationDirectoryName('p2p:a-b', config));
  assert.ok(first.length <= 100);
  assert.ok(conversationDirectoryName('x'.repeat(200), config).length <= 100);
  assert.throws(() => validateConversationDirectory({ enabled: true, prefix: '../' }), {
    code: 'conversation-directory-invalid',
  });
});

test('conversation directory settings persist and new sessions follow the selected strategy', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-im-conversation-dir-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'workspaces.json');
  const store = await new BotWorkspaceStore(path, { defaultWorkspace: root }).load();
  await store.ensure('bot_one');
  await store.setConversationDirectory(null, { enabled: true });

  const first = await store.prepareConversationDirectory('bot_one', 'p2p:alice');
  assert.equal(dirname(first.workspace), root);
  assert.equal((await stat(first.workspace)).isDirectory(), true);
  const repeated = await store.prepareConversationDirectory('bot_one', 'p2p:alice', { explicitNew: true });
  assert.equal(repeated.workspace, first.workspace);
  assert.equal(store.conversationWorkspaceFor('bot_one', 'p2p:alice'), first.workspace);
  await assert.rejects(store.setWorkspace('bot_one', root), { code: 'workspace-manual-edit-disabled' });

  await store.setConversationDirectory('bot_one', { enabled: true, strategy: 'per-session' });
  const next = await store.prepareConversationDirectory('bot_one', 'p2p:alice', { explicitNew: true });
  const later = await store.prepareConversationDirectory('bot_one', 'p2p:alice', { explicitNew: true });
  assert.notEqual(next.workspace, first.workspace);
  assert.notEqual(later.workspace, next.workspace);
  assert.equal(dirname(next.workspace), root);
  assert.equal(dirname(later.workspace), root);

  const reloaded = await new BotWorkspaceStore(path, { defaultWorkspace: root }).load();
  assert.equal(reloaded.conversationDirectoryFor('bot_one').strategy, 'per-session');
  assert.equal(reloaded.conversationWorkspaceFor('bot_one', 'p2p:alice'), later.workspace);
});
