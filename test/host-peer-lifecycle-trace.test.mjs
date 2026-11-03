import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { harnessPeer } from '../plugin-src/host/harness-peer.mjs';
import { modernHarnessApi } from '../plugin-src/host/modern-harness-api.mjs';
import { sharedHostResource } from '../plugin-src/host/shared-host-resource.mjs';
import { peerLifecycleObserver, traceAbortedPeerCall } from '../plugin-src/host/peer-lifecycle-trace.mjs';

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-peer-trace-test-'));
  assert.equal(dirname(directory), resolve(tmpdir()));
  const previous = process.env.DSH_IM_PEER_TRACE_FILE;
  const path = join(directory, 'trace.ndjson');
  process.env.DSH_IM_PEER_TRACE_FILE = path;
  t.after(async () => {
    if (previous === undefined) delete process.env.DSH_IM_PEER_TRACE_FILE;
    else process.env.DSH_IM_PEER_TRACE_FILE = previous;
    assert.equal(dirname(directory), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { directory, path, lines: async () => (await readFile(path, 'utf8')).trim().split('\n').map(JSON.parse) };
}

function fixture() {
  const lifetime = new AbortController();
  let disposeTask;
  const peer = { id: '12345678-1234-1234-1234-123456789012', signal: lifetime.signal,
    dispose() { lifetime.abort(new Error('SECRET_ABORT_MESSAGE')); return disposeTask ?? Promise.resolve(); } };
  const root = {};
  const contexts = [];
  function context() {
    const effects = [];
    const ctx = { root, fiber: { uid: contexts.length + 1 },
      connection: { createPeer: () => peer },
      on: () => () => {}, effect: setup => { effects.push(setup()); },
      typertGateway: {
        async invoke() { throw Object.assign(new Error('disposed'), { code: 'gateway/peer-disposed' }); },
        async *stream() { throw Object.assign(new Error('disposed'), { code: 'gateway/peer-disposed' }); },
      },
    };
    contexts.push(ctx);
    return { ctx, effects };
  }
  return { context, lifetime, peer, deferDisposal(task) { disposeTask = task; } };
}

test('Peer tracing is off without an absolute explicit output path', async (t) => {
  await setup(t);
  delete process.env.DSH_IM_PEER_TRACE_FILE;
  assert.equal(peerLifecycleObserver(), undefined);
  assert.doesNotThrow(() => traceAbortedPeerCall({ signal: { aborted: true } }, 'workspace', 'follow'));
  process.env.DSH_IM_PEER_TRACE_FILE = 'relative-trace.ndjson';
  assert.equal(peerLifecycleObserver(), undefined);
  if (process.platform === 'win32') {
    for (const path of ['\\\\server\\share\\trace.ndjson', '\\\\?\\C:\\trace.ndjson', 'C:trace.ndjson', 'C:\\trace.ndjson:stream', 'C:\\NUL']) {
      process.env.DSH_IM_PEER_TRACE_FILE = path;
      assert.equal(peerLifecycleObserver(), undefined, path);
    }
  }
});

test('trace preserves shared ownership, idempotent retain, and awaited disposal result', async (t) => {
  const output = await setup(t), f = fixture();
  const a = f.context(), b = f.context();
  assert.equal(harnessPeer(a.ctx), f.peer);
  assert.equal(harnessPeer(a.ctx), f.peer);
  assert.equal(harnessPeer(b.ctx), f.peer);
  assert.equal(a.effects.length, 1);
  await a.effects[0]();
  assert.equal(f.peer.signal.aborted, false);
  let finish;
  const task = new Promise(resolve => { finish = resolve; });
  f.deferDisposal(task);
  assert.equal(b.effects[0](), task, 'instrumentation must preserve the exact asynchronous disposer result');
  finish();
  await task;
  const records = await output.lines();
  assert.deepEqual(records.map(r => r.event), ['create', 'retain', 'reuse', 'retain', 'release', 'release', 'dispose', 'abort']);
  assert.deepEqual(records.filter(r => r.event === 'release').map(r => r.ownerCount), [1, 0]);
  assert.equal(records.at(-1).ownerCount, 0);
  assert.equal(new Set(records.map(r => r.peerId)).size, 1);
  assert.match(records[0].stack, /harness-peer/u);
  assert.match(records.at(-1).stack, /host-peer-lifecycle-trace/u);
  assert.doesNotMatch(await readFile(output.path, 'utf8'), /SECRET_ABORT_MESSAGE/u);
});

test('externally aborted Peer retains its owner evidence and logs rejected RPC without payload', async (t) => {
  const output = await setup(t), f = fixture(), a = f.context();
  const api = modernHarnessApi(a.ctx);
  const reason = new Error('SECRET_EXTERNAL_ABORT\n    at SECRET_MULTILINE_MESSAGE');
  reason.stack += '\n    at SECRET_CUSTOM_STACK';
  f.lifetime.abort(reason);
  const response = await api.workspace.list({ rpcId: 'SECRET_RPC_ID', payload: { prompt: 'SECRET_PROMPT', token: 'SECRET_TOKEN' } });
  assert.equal(response.result.ok, false);
  const records = await output.lines();
  const aborted = records.find(r => r.event === 'abort');
  assert.equal(aborted.ownerCount, 1);
  assert.equal(records.some(r => r.event === 'dispose'), false, 'external abort is distinct from shared-resource release');
  const call = records.find(r => r.event === 'call-with-aborted-peer');
  assert.equal(call.namespace, 'workspace');
  assert.equal(call.method, 'follow');
  assert.equal(call.peerId, aborted.peerId);
  assert.doesNotMatch(await readFile(output.path, 'utf8'), /SECRET_/u);
  for (const dispose of a.effects) await dispose();
});

test('unwritable trace target never breaks acquisition or release', async (t) => {
  const output = await setup(t);
  process.env.DSH_IM_PEER_TRACE_FILE = output.directory;
  const f = fixture(), a = f.context();
  assert.equal(harnessPeer(a.ctx), f.peer);
  await a.effects[0]();
  assert.equal(f.peer.signal.aborted, true);
});

test('trace stops at the bounded file limit without overwriting existing evidence', async (t) => {
  const output = await setup(t);
  await writeFile(output.path, Buffer.alloc(2 * 1024 * 1024, 32));
  const before = await stat(output.path);
  const f = fixture(), a = f.context();
  harnessPeer(a.ctx);
  await a.effects[0]();
  assert.equal((await stat(output.path)).size, before.size);
});

test('throwing stack formatting cannot escape RPC or abort diagnostics', async (t) => {
  await setup(t);
  const f = fixture(), a = f.context();
  harnessPeer(a.ctx); // Install the observer before the formatter becomes hostile.
  const previous = Error.prepareStackTrace;
  let escaped;
  try {
    Error.prepareStackTrace = () => { throw new Error('formatter failure'); };
    try {
      f.lifetime.abort(new Error('SECRET_ABORT'));
      traceAbortedPeerCall(f.peer, 'workspace', 'follow');
      peerLifecycleObserver()('retain', { value: f.peer, scope: a.ctx.root, ctx: a.ctx, ownerCount: 1 });
    } catch (error) { escaped = error; }
  } finally { Error.prepareStackTrace = previous; }
  assert.equal(escaped, undefined);
  await a.effects[0]();
});

test('a throwing observer cannot change release count or disposer identity', () => {
  const effects = [], resource = {}, task = Promise.resolve();
  const ctx = { root: {}, effect(setup) { effects.push(setup()); } };
  assert.equal(sharedHostResource(new WeakMap(), ctx, { create: () => resource,
    dispose: () => task, observe() { throw new Error('observer failure'); } }), resource);
  assert.equal(effects[0](), task);
});
