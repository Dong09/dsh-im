import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

async function fixture(t, { scheduled = false } = {}) {
  const workspace = await fs.mkdtemp(join(tmpdir(), 'dsh-im-recovery-test-'));
  const api = await import(`../src/channels/shared/semantic/artifact.mjs?${t.name}`);
  const registry = new api.OutboundArtifactRegistry();
  const session = {
    header: { id: 'recovery-session', cwd: workspace },
    events: [{ type: 'turn/start', data: { turn: 1 } }],
  };
  let lease;
  let close;
  if (scheduled) {
    registry.observeSessionEvent(session, session.events[0]);
    lease = registry.openTurnConsumer(session.header.id, 1);
    close = () => lease.close();
  } else {
    close = registry.openConsumer(session.header.id, 'recovery-rpc');
    registry.observeClaimedMessage(session, { source: { rpcId: 'recovery-rpc' } }, 1);
  }
  await fs.writeFile(join(workspace, 'result.txt'), 'recover without restarting');
  const directories = new Set();
  const mkdtemp = fs.mkdtemp;
  t.mock.method(fs, 'mkdtemp', async (...args) => {
    const directory = await mkdtemp(...args);
    directories.add(directory);
    return directory;
  });
  syncBuiltinESMExports();
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    close();
    registry.clear();
    await fs.rm(workspace, { recursive: true, force: true });
    for (const directory of directories) await fs.rm(directory, { recursive: true, force: true });
  });
  return {
    api, registry, session, workspace, lease, close, directories,
    async send(signal) {
      const artifact = await registry.stage({ path: 'result.txt' }, { agent: { session }, signal });
      try {
        const file = await api.materializeOutboundArtifact(artifact);
        assert.equal(file.bytes.toString(), 'recover without restarting');
      } finally {
        registry.release(artifact);
      }
    },
  };
}

test('file snapshots recover after repeated directory cleanup, including concurrent sends', async (t) => {
  const fx = await fixture(t);
  await fx.send();
  for (let round = 0; round < 2; round += 1) {
    for (const directory of fx.directories) await fs.rm(directory, { recursive: true, force: true });
    await Promise.all(Array.from({ length: 4 }, () => fx.send()));
  }
});

test('file snapshots recover when the directory disappears just before copying', async (t) => {
  const fx = await fixture(t);
  const copyFile = fs.copyFile;
  let copies = 0;
  t.mock.method(fs, 'copyFile', async (...args) => {
    if (++copies === 1) await fs.rm(dirname(args[1]), { recursive: true });
    return copyFile(...args);
  });
  syncBuiltinESMExports();
  await fx.send();
  assert.equal(copies, 2);
});

test('a failed initial temporary directory creation can be retried', async (t) => {
  const fx = await fixture(t);
  const mkdtemp = fs.mkdtemp;
  let attempts = 0;
  t.mock.method(fs, 'mkdtemp', (...args) => {
    if (++attempts === 1) return Promise.reject(Object.assign(new Error('temporary failure'), { code: 'EACCES' }));
    return mkdtemp(...args);
  });
  syncBuiltinESMExports();
  await assert.rejects(fx.send(), { code: 'artifact-unavailable' });
  await fx.send();
  assert.equal(attempts, 2);
});

for (const [code, expectedCopies] of [['ENOENT', 2], ['EACCES', 1]]) {
  test(`snapshot ${code} failures do not retry indefinitely or lose their cause`, async (t) => {
    const fx = await fixture(t);
    const cause = Object.assign(new Error('copy failed'), { code });
    let copies = 0;
    t.mock.method(fs, 'copyFile', async () => { copies += 1; throw cause; });
    syncBuiltinESMExports();
    await assert.rejects(fx.send(), (error) => error.code === 'artifact-unavailable' && error.cause === cause);
    assert.equal(copies, expectedCopies);
  });
}

test('snapshot recovery respects cancellation before retrying', async (t) => {
  const fx = await fixture(t);
  const controller = new AbortController();
  let copies = 0;
  t.mock.method(fs, 'copyFile', async () => {
    copies += 1;
    controller.abort();
    throw Object.assign(new Error('directory gone'), { code: 'ENOENT' });
  });
  syncBuiltinESMExports();
  await assert.rejects(fx.send(controller.signal), { name: 'AbortError' });
  assert.equal(copies, 1);
});

function observeSnapshots(t) {
  const copies = [];
  const deletions = [];
  const copyFile = fs.copyFile;
  const unlink = fs.unlink;
  t.mock.method(fs, 'copyFile', async (...args) => {
    await copyFile(...args);
    copies.push(args[1]);
  });
  t.mock.method(fs, 'unlink', (...args) => {
    const deletion = unlink(...args);
    deletions.push(deletion.catch(() => undefined));
    return deletion;
  });
  syncBuiltinESMExports();
  return { copies, deletions };
}

test('a scheduled native tool failure deletes its real staged snapshot and never becomes sendable', async (t) => {
  const fx = await fixture(t, { scheduled: true });
  const observed = observeSnapshots(t);
  const tool = fx.api.createOutboundArtifactTool({ registry: fx.registry });
  const stage = fx.registry.stage.bind(fx.registry);
  let artifact;
  t.mock.method(fx.registry, 'stage', async (...args) => { artifact = await stage(...args); return artifact; });
  const exec = { name: fx.api.OUTBOUND_ARTIFACT_TOOL, agent: { session: fx.session }, callId: 'failed-native' };
  await tool.definition.execute({ path: 'result.txt' }, exec);
  assert.equal(fx.api.isManagedOutboundArtifact(artifact), true);
  assert.equal(observed.copies.length, 1);
  tool.onResult(exec, { isError: true });
  await Promise.all(observed.deletions);
  assert.equal(fx.api.isManagedOutboundArtifact(artifact), false);
  assert.deepEqual(fx.lease.take(), []);
  await assert.rejects(fs.stat(observed.copies[0]), { code: 'ENOENT' });
  await assert.rejects(fx.api.materializeOutboundArtifact(artifact), { code: 'artifact-invalid' });
  assert.equal(await fs.readFile(join(fx.workspace, 'result.txt'), 'utf8'), 'recover without restarting');
});

test('a scheduled snapshot keeps original bytes and filename after the original is changed then removed', async (t) => {
  const fx = await fixture(t, { scheduled: true });
  const artifact = await fx.registry.stage({ path: 'result.txt' }, { agent: { session: fx.session } });
  fx.registry.commit(artifact);
  const source = join(fx.workspace, 'result.txt');
  assert.deepEqual(await fs.readdir(fx.workspace), ['result.txt'], 'registration does not rename or copy into the workspace');
  await fs.writeFile(source, 'new contents not registered');
  await fs.unlink(source);
  fx.registry.observeSessionEvent(fx.session, { type: 'turn/end', data: { turn: 1 } });
  assert.deepEqual(fx.lease.take(), [artifact]);
  fx.lease.close();
  const file = await fx.api.materializeOutboundArtifact(artifact);
  assert.equal(file.fileName, 'result.txt');
  assert.equal(file.bytes.toString(), 'recover without restarting');
  fx.api.releaseOutboundArtifact(artifact);
  assert.deepEqual(await fs.readdir(fx.workspace), [], 'sending never recreates a missing source');
});

for (const invalidation of ['removed', 'resized', 'same-size-changed']) {
  test(`a ${invalidation} managed scheduled snapshot fails materialization and is released`, async (t) => {
    const fx = await fixture(t, { scheduled: true });
    const observed = observeSnapshots(t);
    const artifact = await fx.registry.stage({ path: 'result.txt' }, { agent: { session: fx.session } });
    fx.registry.commit(artifact);
    assert.deepEqual(fx.lease.take(), [artifact]);
    assert.equal(observed.copies.length, 1);
    const snapshotPath = observed.copies[0];
    if (invalidation === 'removed') await fs.unlink(snapshotPath);
    else await fs.writeFile(snapshotPath, invalidation === 'resized' ? 'short' : 'x'.repeat(artifact.size));
    await assert.rejects(fx.api.materializeOutboundArtifact(artifact), { code: 'artifact-invalid' });
    await Promise.all(observed.deletions);
    assert.equal(fx.api.isManagedOutboundArtifact(artifact), false);
    assert.deepEqual(fx.lease.take(), []);
    await assert.rejects(fs.stat(snapshotPath), { code: 'ENOENT' });
    assert.equal(await fs.readFile(join(fx.workspace, 'result.txt'), 'utf8'), 'recover without restarting');
  });
}

test('a source removed before copying fails without re-generating it or leaving a scheduled snapshot', async (t) => {
  const fx = await fixture(t, { scheduled: true });
  const copyFile = fs.copyFile;
  const paths = [];
  t.mock.method(fs, 'copyFile', async (...args) => {
    paths.push(args[1]);
    if (paths.length === 1) await fs.unlink(args[0]);
    await copyFile(...args);
  });
  syncBuiltinESMExports();
  await assert.rejects(fx.registry.stage({ path: 'result.txt' }, { agent: { session: fx.session } }), { code: 'artifact-unavailable' });
  assert.equal(paths.length, 2, 'the existing bounded ENOENT directory recovery is preserved');
  for (const path of paths) await assert.rejects(fs.stat(path), { code: 'ENOENT' });
  assert.deepEqual(fx.lease.take(), []);
  assert.deepEqual(await fs.readdir(fx.workspace), []);
});

test('a paused schedule copy cannot remove or commit into the ordinary owner that finishes first', async (t) => {
  const fx = await fixture(t, { scheduled: true });
  const copied = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const copyFile = fs.copyFile;
  const paths = [];
  let staging;
  t.mock.method(fs, 'copyFile', async (...args) => {
    await copyFile(...args);
    paths.push(args[1]);
    if (paths.length === 1) {
      copied.resolve();
      await resume.promise;
    }
  });
  syncBuiltinESMExports();
  try {
    staging = fx.registry.stage({ path: 'result.txt' }, { agent: { session: fx.session } });
    await copied.promise;
    const closeRpc = fx.registry.openConsumer(fx.session.header.id, 'ordinary-rpc');
    t.after(closeRpc);
    fx.registry.observeClaimedMessage(fx.session, { source: { rpcId: 'ordinary-rpc' } }, 1);
    assert.equal(fx.lease.active, false);
    await fs.writeFile(join(fx.workspace, 'result.txt'), 'ordinary owner bytes');
    const ordinary = await fx.registry.stage({ path: 'result.txt' }, { agent: { session: fx.session } });
    fx.registry.commit(ordinary);
    resume.resolve();
    await assert.rejects(staging, { code: 'artifact-consumer-required' });
    await assert.rejects(fs.stat(paths[0]), { code: 'ENOENT' });
    fx.lease.close();
    assert.deepEqual(fx.lease.take(), []);
    assert.deepEqual(fx.registry.take(fx.session.header.id, 1, { promptRpcId: 'ordinary-rpc' }), [ordinary]);
    const file = await fx.api.materializeOutboundArtifact(ordinary);
    assert.equal(file.bytes.toString(), 'ordinary owner bytes');
    fx.api.releaseOutboundArtifact(ordinary);
  } finally {
    resume.resolve();
    await staging?.catch(() => undefined);
  }
});
