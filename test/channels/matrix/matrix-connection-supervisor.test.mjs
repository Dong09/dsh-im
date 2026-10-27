import assert from 'node:assert/strict';
import test from 'node:test';
import { TokenConnectionSupervisor } from '../../../plugin-src/host/channels/shared/connection-supervisor.mjs';
import { deriveMatrixBotIdentity } from '../../../src/channels/matrix/matrix-config-store.mjs';
import { controllerFixture } from './fixtures/controller-fixture.mjs';

function clockFixture() {
  const timers = [];
  let scheduled;
  return {
    timers,
    setTimeout(callback, delay) {
      const timer = { callback, delay, canceled: false, fired: false, unref() {} };
      timers.push(timer);
      scheduled?.();
      scheduled = null;
      return timer;
    },
    clearTimeout(timer) { timer.canceled = true; },
    async fire() {
      const timer = timers.find((item) => !item.fired && !item.canceled);
      assert.ok(timer, 'a reconciliation has an owned pending timer');
      const nextSchedule = new Promise((resolve) => { scheduled = resolve; });
      timer.fired = true;
      timer.callback();
      await nextSchedule;
      await new Promise(setImmediate);
    },
  };
}

async function fixture(t) {
  let supervisor;
  const f = await controllerFixture(t, { cleanup: () => supervisor?.close() });
  const clock = clockFixture();
  supervisor = new TokenConnectionSupervisor({
    channel: 'matrix', controller: f.controller, harness: { ensureRunning: async () => true },
    retryDelaysMs: [123], healthyIntervalMs: 9876,
    setTimeoutImpl: (callback, delay) => clock.setTimeout(callback, delay),
    clearTimeoutImpl: (timer) => clock.clearTimeout(timer),
    logger: { info() {}, warn() {}, error() {} },
  });
  return { ...f, clock, supervisor };
}

test('matrix supervisor retries a missing-credential bot instead of scheduling the healthy interval', async (t) => {
  const f = await fixture(t);
  f.secrets.delete(f.identity.tokenRef);
  f.supervisor.start();
  await f.clock.fire();
  assert.equal(f.clock.timers.at(-1).delay, 123);
  assert.equal(f.controller.status().totals.configured, 1);
  assert.equal(f.controller.status().totals.connected, 0);
  assert.equal(f.controller.status().ready, false);
});

test('matrix supervisor counts configured missing bots when one other bot is connected', async (t) => {
  const f = await fixture(t);
  const userId = '@missing:example.org';
  await f.configStore.save({ ...f.config, ...deriveMatrixBotIdentity({ homeserver: f.config.homeserver, userId }),
    userId, platformId: `matrix.example.org|${userId}` });
  f.supervisor.start();
  await f.clock.fire();
  const status = f.controller.status();
  assert.equal(status.totals.configured, 2);
  assert.equal(status.totals.connected, 1);
  assert.equal(status.totals.bots, 2);
  assert.equal(status.totals.ready, 1);
  assert.equal(status.ready, false);
  assert.equal(f.clock.timers.at(-1).delay, 123);
});

test('matrix supervisor replaces a permanent failure once but retains an active temporary retry loop', async (t) => {
  const f = await fixture(t);
  f.supervisor.start();
  await f.clock.fire();
  assert.equal(f.runtimes.length, 1);
  Object.assign(f.runtimes[0].status, { ready: false, connectionState: 'failed', harnessReachable: false });
  await f.clock.fire();
  assert.equal(f.runtimes.length, 2);
  assert.equal(f.runtimes[0].stops, 1);
  Object.assign(f.runtimes[1].status, { ready: false, connectionState: 'connecting', harnessReachable: false });
  await f.clock.fire();
  assert.equal(f.runtimes.length, 2);
  assert.equal(f.runtimes[1].stops, 0);
  assert.equal(f.clock.timers.at(-1).delay, 123);
  assert.equal(f.controller.status().ready, false);
});
