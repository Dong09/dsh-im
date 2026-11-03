import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HarnessClient, HarnessRpcError } from '../src/channels/shared/harness-client.mjs';
import { ImagePromptError, promptContentForMessage } from '../src/channels/shared/image-prompt.mjs';
import { stageInboundFiles } from '../src/channels/shared/inbound-file.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

async function fixture(t, { afterStage, onPrompt } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-image-reconcile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prompts = [];
  let stages = 0;
  const client = new HarnessClient({
    baseUrl: 'http://127.0.0.1:3080', workspace: root,
    fileIngressExecutor: async ({ files, workspace, signal }) => {
      stages++;
      const batch = await stageInboundFiles({ files }, { workspace, signal });
      await afterStage?.(batch);
      return batch;
    },
  });
  client.ensureRunning = async () => true;
  client.rpc = async (method, payload, _timeout, options) => {
    if (method === 'workspace.list') return { items: [], archivedSessionIds: [] };
    if (method === 'session.list') return { items: [{ sessionId: 's', cwd: root }] };
    if (method === 'session.prompt') {
      prompts.push({ ...payload, rpcId: options.rpcId });
      await onPrompt?.(payload.content, prompts.length);
      return {};
    }
    assert.equal(method, 'session.history');
    if (!prompts.length) return { events: [] };
    return { events: [
      { event: { seq: 1, type: 'turn/start', data: { turn: 1 } } },
      { event: { seq: 2, type: 'user/message', data: { turn: 1, source: { rpcId: prompts[0].rpcId } } } },
      { event: { seq: 3, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'done' }] } } } },
      { event: { seq: 4, type: 'turn/end', data: { turn: 1, reason: 'completed' } } },
    ] };
  };
  return { client, prompts, stages: () => stages };
}

function sources() {
  const loads = [0, 0];
  return { loads, images: ['removed.png', 'retained.png'].map((name, index) => ({ name,
    load: async () => { loads[index]++; return PNG; },
  })) };
}

for (const fallback of [false, true]) {
  test(`Harness rechecks ${fallback ? 'nonvision fallback manifests' : 'late staged images'} by identity`, async (t) => {
    const { images, loads } = sources();
    let removed = false;
    const f = await fixture(t, {
      afterStage: (batch) => {
        if (!fallback && batch.files.some((file) => file.mediaType?.startsWith('image/'))) removed = true;
      },
      onPrompt: (_content, attempt) => {
        if (fallback && attempt === 1) {
          removed = true;
          throw new HarnessRpcError('session.prompt', { code: 'attachment-error',
            details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' } });
        }
      },
    });
    const seen = [];
    assert.equal(await f.client.ask('s', 'base question', { images,
      files: [{ name: 'unrelated.txt', data: Buffer.from('keep') }],
      reconcileImages: async (current) => {
        seen.push(current);
        assert.ok(current.every((source) => images.includes(source)));
        return removed ? current.filter((source) => source !== images[0]) : current;
      },
    }), 'done');
    assert.deepEqual(loads, [1, 1]);
    assert.equal(f.prompts.length, fallback ? 2 : 1);
    const content = f.prompts.at(-1).content;
    assert.equal(content.filter((part) => part.type === 'image').length, fallback ? 0 : 1);
    const serialized = JSON.stringify(content);
    assert.ok(!serialized.includes('removed.png'));
    assert.ok(serialized.includes('unrelated.txt'));
    assert.ok(serialized.includes('base question'));
    if (fallback) {
      assert.ok(serialized.includes('retained.png'));
      assert.equal(f.prompts[0].rpcId, f.prompts[1].rpcId);
    }
    assert.ok(seen.length >= 2);
  });
}

test('Harness bounded staging retry caches successes, authorizes only removed loader failure', async (t) => {
  const { images, loads } = sources();
  let removed = false;
  images[1].load = async () => { loads[1]++; removed = true; throw new ImagePromptError('redacted', 'redacted', 'safe'); };
  const f = await fixture(t);
  assert.equal(await f.client.ask('s', 'base', { images,
    reconcileImages: async (current) => current.filter((source) => !removed || source !== images[1]),
  }), 'done');
  assert.deepEqual(loads, [1, 1]);
  assert.equal(f.stages(), 2);
  assert.equal(f.prompts.length, 1);
});

test('Harness propagates callback rejection and rejects empty subset without submitting', async (t) => {
  for (const empty of [false, true]) {
    let staged = false;
    const failure = new ImagePromptError('all-invalid', 'all invalid', 'safe');
    const f = await fixture(t, { afterStage: () => { staged = true; } });
    await assert.rejects(f.client.ask('s', 'base', { images: sources().images,
      reconcileImages: async (current) => {
        if (!staged) return current;
        if (empty) return [];
        throw failure;
      },
    }), empty ? { code: 'no-effective-images' }
      : (error) => error instanceof ImagePromptError && error.code === failure.code
        && error.userMessage === failure.userMessage);
    assert.equal(f.prompts.length, 0);
  }
});

test('Harness keeps valid loader failures atomic with and without no-op reconciliation', async (t) => {
  for (const enabled of [false, true]) {
    const { images, loads } = sources();
    images[1].load = async () => { loads[1]++; throw new Error('temporary download failure'); };
    const f = await fixture(t);
    await assert.rejects(f.client.ask('s', 'base', { images,
      ...(enabled ? { reconcileImages: async (current) => current } : {}),
    }), { code: 'image-download-failed' });
    assert.equal(f.prompts.length, 0);
    assert.deepEqual(loads, [1, 1]);
  }
});

test('promptContentForMessage maps final blocks and retries only authorized removed sources', async () => {
  const { images, loads } = sources();
  let removed = false;
  images[1].load = async () => { loads[1]++; removed = true; throw new Error('gone'); };
  const content = await promptContentForMessage({ content: 'base', images,
    reconcileImages: async (current) => current.filter((source) => !removed || source !== images[1]),
  });
  assert.deepEqual(loads, [1, 1]);
  assert.deepEqual(content.map((part) => part.name ?? part.text), ['base', 'removed.png']);

  const late = sources();
  const assembled = await promptContentForMessage({ content: 'base', images: late.images }, {
    reconcileImages: async (current) => late.loads[1] ? [late.images[1]] : current,
  });
  assert.deepEqual(assembled.map((part) => part.name ?? part.text), ['base', 'retained.png']);
});

test('prompt reconciliation cannot swallow valid transient failures, limits, abort or foreign identities', async () => {
  const broken = { load: async () => { throw new Error('temporary'); } };
  await assert.rejects(promptContentForMessage({ images: [broken], reconcileImages: async (s) => s }),
    { code: 'image-download-failed' });
  await assert.rejects(promptContentForMessage({ images: [{ data: PNG }], reconcileImages: async () => [] }),
    { code: 'no-effective-images' });
  await assert.rejects(promptContentForMessage({ images: [{ data: PNG }], reconcileImages: async () => [{ data: PNG }] }),
    /subset/);
  await assert.rejects(promptContentForMessage({ images: [{ data: PNG }], reconcileImages: async (s) => s },
    { maxImageBytes: 1 }), { code: 'image-too-large' });
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(promptContentForMessage({ images: [broken], reconcileImages: async () => [] },
    { signal: controller.signal }), /cancelled/);
});

test('reconciliation refreshes the helper aggregate budget without duplicate loads', async () => {
  const { images, loads } = sources();
  let removeFirst = false;
  const originalLoad = images[0].load;
  images[0].load = async () => { const value = await originalLoad(); removeFirst = true; return value; };
  const content = await promptContentForMessage({ images,
    reconcileImages: async (current) => current.filter((source) => !removeFirst || source !== images[0]),
  }, { maxTotalImageBytes: PNG.length });
  assert.deepEqual(content.filter((part) => part.type === 'image').map((part) => part.name), ['retained.png']);
  assert.deepEqual(loads, [1, 1]);
  await assert.rejects(promptContentForMessage({ images: sources().images,
    reconcileImages: async (current) => current,
  }, { maxTotalImageBytes: PNG.length }), { code: 'images-too-large' });
});

test('all-invalid reconciliation during nonvision fallback never submits text-only analysis', async (t) => {
  let rejected = false;
  const f = await fixture(t, { onPrompt: () => {
    rejected = true;
    throw new HarnessRpcError('session.prompt', { code: 'attachment-error',
      details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' } });
  } });
  await assert.rejects(f.client.ask('s', 'base', { images: sources().images,
    reconcileImages: async (current) => rejected ? [] : current,
  }), { code: 'no-effective-images' });
  assert.equal(f.prompts.length, 1, 'only the rejected admission attempt occurred');
});

test('deferred image content never invokes reconciliation prematurely', async () => {
  const content = await promptContentForMessage({ images: [{ data: PNG }],
    reconcileImages: () => { throw new Error('premature'); },
  }, { deferImages: true });
  assert.equal(content.length, 1);
});
