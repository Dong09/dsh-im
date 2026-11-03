import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { MatrixRuntime } from '../src/channels/matrix/matrix-runtime.mjs';
import { MatrixSidecarStore } from '../src/channels/matrix/matrix-config-store.mjs';
import { MatrixImageInboxStore } from '../src/channels/matrix/matrix-image-inbox.mjs';
import { HarnessClient } from '../src/channels/shared/harness-client.mjs';
import { stageInboundFiles } from '../src/channels/shared/inbound-file.mjs';
import { outboundArtifactRegistry as registry, isManagedOutboundArtifact } from '../src/channels/shared/semantic/artifact.mjs';
import { createDeliveryService } from '../plugin-src/host/delivery-service.mjs';
import { createDeliveryAdapter } from '../plugin-src/host/delivery-adapter.mjs';
import { createScheduleRelay } from '../plugin-src/host/schedule-relay-coordinator.mjs';
import { RelayStore } from '../plugin-src/host/schedule-relay-store.mjs';
import { createSessionSyncCoordinator, isImOwnedInput } from '../plugin-src/host/session-sync-coordinator.mjs';

const BOT = '@bot:example.org', ALICE = '@alice:example.org';
const ROOM = '!images:example.org', SCHEDULE_ROOM = '!scheduled:example.org';
const ORIGIN = 'http://127.0.0.1:3080';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const logger = { info() {}, debug() {}, warn() {}, error() {} };

// Timers only diagnose a missing producer; no sleep or polling advances tests.
function journal() {
  const entries = [], listeners = new Set();
  return { entries,
    push(entry) { entries.push(entry); for (const check of [...listeners]) check(); },
    wait(predicate, label) {
      const current = entries.find(predicate);
      if (current) return Promise.resolve(current);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { listeners.delete(check); reject(new Error(`Missing ${label}: ${entries.map(x => x.op).join(', ')}`)); }, 10_000);
        const check = () => { const found = entries.find(predicate); if (!found) return;
          clearTimeout(timer); listeners.delete(check); resolve(found); };
        listeners.add(check);
      });
    },
  };
}
function image(id) {
  return { type: 'm.room.message', event_id: `$${id}:example.org`, sender: ALICE,
    origin_server_ts: Date.now(), content: { msgtype: 'm.image', body: `${id}.png`,
      url: `mxc://media.example.org/${id}`, info: { mimetype: 'image/png', size: PNG.length } } };
}
function question(id) {
  return { type: 'm.room.message', event_id: `$${id}:example.org`, sender: ALICE,
    origin_server_ts: Date.now(), content: { msgtype: 'm.text', body: `${BOT} analyze`,
      'm.mentions': { user_ids: [BOT] } } };
}
function redaction(entry) {
  return { type: 'm.room.redaction', event_id: `$redact-${entry.event_id.slice(1)}`,
    room_id: ROOM, sender: '@admin:example.org', content: { redacts: entry.event_id } };
}
function recalled(entry) {
  return { ...entry, room_id: ROOM, content: {}, unsigned: { redacted_because: redaction(entry) } };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'matrix-image-schedule-isolation-'));
  const inboxPath = join(root, 'matrix-images.json');
  const relayPath = join(root, 'integrations', 'dsh-matrix', 'schedule-replies.json');
  const log = journal(), remote = new Map(), prompts = [], scheduled = [], mirrored = [], uploads = [];
  const modelGate = Promise.withResolvers(), artifactGate = Promise.withResolvers();
  const inbound = { id: `input-${root.split(/[\\/]/).at(-1)}`, header: { cwd: root } };
  const scheduledSession = { id: `schedule-${root.split(/[\\/]/).at(-1)}`, header: { cwd: root } };
  inbound.header.id = inbound.id;
  scheduledSession.header.id = scheduledSession.id;
  const botId = 'matrix_isolation';
  const key = `group:room:${SCHEDULE_ROOM}`;
  let inbox = await new MatrixImageInboxStore(inboxPath).load();
  let relayStore, relay, runtime, stopped = false, closed = false, seq = 0, queryFailure = false;
  let history = [], poll, syncCount = 0;
  const seen = new Set(), sessions = new Map(), pending = new Map();
  const state = {
    hasSeen: id => seen.has(id), markSeen: async id => seen.add(id), unmarkSeen: async id => seen.delete(id),
    sessionFor: key => sessions.get(key) ?? null, getSession: key => sessions.get(key) ?? null,
    setSession: async (key, id) => sessions.set(key, id), clearSession: async key => sessions.delete(key),
    snapshot: () => ({ seenMessageIds: [...seen], sessions: Object.fromEntries(sessions) }),
    pendingMessages: () => [...pending.values()], putPendingMessage: async entry => pending.set(entry.id, entry),
    patchPendingMessage: async (id, patch) => Object.assign(pending.get(id) ?? {}, patch),
    removePendingMessage: async id => { const entry = pending.get(id); pending.delete(id); log.push({ op: 'settled', id: entry?.messageId }); },
  };
  const im = createDeliveryService({ logger });
  im.registerAdapter(createDeliveryAdapter({ channel: 'matrix',
    workspaces: { has: id => id === botId, listBotIds: () => [botId], listDeliveryTargets: () => [],
      listSessionSyncTargets: () => [], listDsBotBindings: () => [] },
    stateFor: async () => ({ snapshot: () => ({ sessions: { [key]: scheduledSession.id } }) }),
    coreController: {
      describeDeliveryAccount: id => ({ version: 1, botId: id, channel: 'matrix', connected: true,
        capabilities: ['scheduled-part-delivery'], account: { fingerprint: 'a'.repeat(64) } }),
      async sendScheduledPart(id, target, part) {
        assert.equal(part.kind, 'artifact', 'the simplified custom relay must never send final text');
        scheduled.push({ id, target, part }); log.push({ op: 'scheduled-entered' });
        await artifactGate.promise;
        return { deliveryOutcome: 'sent', providerMessageIds: ['$scheduled-artifact:example.org'],
          artifacts: [{ artifactId: part.artifact.artifactId, outcome: 'sent' }] };
      },
      async sendProactiveText(id, target, text) { mirrored.push({ id, target, text }); return { sent: true }; },
    },
  }));
  const sync = createSessionSyncCoordinator({ deliveryService: im, logger,
    loadSettings: async () => ({ deliverModelAnswers: true, mirrorUserInput: true, modelIcon: '', inputIcon: '' }) });
  async function openRelay() {
    relayStore = await RelayStore.open(relayPath);
    relay = createScheduleRelay({ im, store: relayStore, registry, logger });
    await relay.captureBindings();
  }
  await openRelay();
  function emit(session, event) {
    // These are the same real coordinator entry points used by Host event hooks.
    void relay.observeEvent(session, event);
    void sync.enqueue(session.id, event, isImOwnedInput(ORIGIN, event) ? 'im' : 'other');
  }
  const api = {
    whoami: async () => ({ user_id: BOT, device_id: 'ISOLATION_DEVICE' }),
    async sync({ signal } = {}) {
      if (++syncCount === 1) return { next_batch: 'initial', rooms: { join: {} } };
      const current = Promise.withResolvers(); poll = current;
      const abort = () => current.reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      log.push({ op: 'sync-ready', count: syncCount });
      try { return await current.promise; } finally { signal.removeEventListener('abort', abort); if (poll === current) poll = null; }
    },
    getAccountData: async () => ({}), setAccountData: async () => ({}), getJoinedMemberCount: async () => 3,
    getRoomStateEvent: async () => null, getRoomMemberDisplayName: async () => null,
    listRelations: async () => ({ events: [] }), setTyping: async () => ({}), sendReceipt: async () => ({}), redactEvent: async () => ({}),
    async getEvent(_room, id) { return structuredClone(remote.get(id) ?? null); },
    async getEventStrict(_room, id) {
      log.push({ op: 'lookup', id });
      if (queryFailure) throw Object.assign(new Error('fixture unavailable'), { status: 503 });
      return structuredClone(remote.get(id) ?? null);
    },
    async downloadContent(uri) { log.push({ op: 'download', uri }); return Buffer.concat([PNG, Buffer.from(uri)]); },
    async uploadMedia(bytes, options) { uploads.push({ bytes: Buffer.from(bytes), options }); return 'mxc://media.example.org/output'; },
    async sendEvent(roomId, type, content) {
      const sent = { op: 'send', roomId, type, content: structuredClone(content), id: `$sent-${++seq}:example.org` };
      log.push(sent); return { event_id: sent.id };
    },
  };
  const harness = new HarnessClient({ baseUrl: ORIGIN, workspace: root,
    fileIngressExecutor: ({ files, workspace, signal }) => stageInboundFiles({ files }, { workspace, signal }) });
  harness.ensureRunning = async () => true;
  harness.sessionExists = async () => true;
  harness.createSession = async () => inbound.id;
  harness.watchInteractions = async (_id, { signal, onOpen }) => {
    onOpen(); await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
  };
  harness.rpc = async (method, payload, _timeout, options) => {
    if (method === 'workspace.list') return { items: [], archivedSessionIds: [] };
    if (method === 'session.list') return { items: [{ sessionId: inbound.id, cwd: root }] };
    if (method === 'session.history') return { events: history.map(event => ({ event })) };
    assert.equal(method, 'session.prompt');
    prompts.push({ ...payload, rpcId: options.rpcId });
    const start = { seq: 1, type: 'turn/start', data: { turn: 1 } };
    const input = { seq: 2, type: 'user/message', surfaceOp: 'append', data: { id: `im:${options.rpcId}`, turn: 1,
      source: { kind: 'user', rpcId: options.rpcId }, message: { content: payload.content } } };
    history = [start, input]; emit(inbound, start); emit(inbound, input);
    log.push({ op: 'model-accepted' });
    void modelGate.promise.then(() => {
      const answer = { seq: 3, type: 'assistant/message', surfaceOp: 'append', data: { turn: 1,
        message: { content: [{ type: 'text', text: 'inbound final answer' }] } } };
      const end = { seq: 4, type: 'turn/end', data: { turn: 1, reason: 'completed' } };
      history.push(answer, end); emit(inbound, answer); emit(inbound, end);
    });
    return { accepted: true };
  };
  async function openRuntime() {
    const sidecar = await new MatrixSidecarStore(join(root, 'matrix.json')).load();
    runtime = new MatrixRuntime({ config: { botId, homeserver: 'https://matrix.example.org', userId: BOT,
      e2eeMode: 'off', reactions: false, coalesceWindowMs: 0 },
      accessToken: 'fixture-only', harness, state, sidecar, imageInbox: inbox, createApi: () => api, logger,
      accessPolicy: { getSettings: () => ({
        direct: { mode: 'open', open: { defaultCanExecuteCommands: true, commandPermissionOverrides: [] }, allowlist: { users: [] } },
        group: { mode: 'open', open: { defaultCanExecuteCommands: true, commandPermissionOverrides: [] }, allowlist: { users: [] } },
      }) },
    });
    await runtime.start(); await log.wait(x => x.op === 'sync-ready', 'initial sync');
  }
  await openRuntime();
  async function push(entries) {
    const count = syncCount;
    await log.wait(x => x.op === 'sync-ready' && x.count === count, 'owned sync request');
    for (const entry of entries) remote.set(entry.event_id, structuredClone(entry));
    assert.ok(poll); const current = poll; poll = null;
    current.resolve({ next_batch: `batch-${count}`, rooms: { join: { [ROOM]: { timeline: { events: entries } } } } });
    await log.wait(x => x.op === 'sync-ready' && x.count === count + 1, 'timeline completion');
  }
  async function stage(session, name) {
    await writeFile(join(root, name), PNG);
    const artifact = await registry.stage({ path: name }, { agent: { session }, callId: `return:${name}` });
    assert.ok(registry.commit(artifact), 'real output owner accepts the committed artifact'); return artifact;
  }
  async function beginSchedule(turn = 1) {
    emit(scheduledSession, { type: 'turn/start', data: { turn } });
    const message = { id: `schedule:${turn}`, source: { kind: 'schedule' }, content: [{ type: 'text', text: 'scheduled input' }] };
    relay.observeClaim(scheduledSession, message, turn);
    await relay.preStep({ agent: { session: scheduledSession }, turn, signal: new AbortController().signal });
    emit(scheduledSession, { type: 'user/message', surfaceOp: 'append', data: { ...message, turn } });
  }
  function finishSchedule(turn = 1) {
    emit(scheduledSession, { type: 'assistant/message', surfaceOp: 'append', data: { turn,
      message: { content: [{ type: 'text', text: 'scheduled final answer' }] } } });
    emit(scheduledSession, { type: 'turn/end', data: { turn, reason: 'completed' } });
  }
  async function stopRuntime() { if (!stopped) { stopped = true; await runtime.stop(); await inbox.flush(); } }
  async function close() {
    if (closed) return; closed = true; modelGate.resolve(); artifactGate.resolve();
    await stopRuntime(); await relay.whenIdle(); await sync.whenIdle(); sync.close(); await relay.close(); await relayStore.close();
  }
  t.after(async () => { await close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { root, inboxPath, relayPath, log, prompts, scheduled, mirrored, uploads, remote, inbound, scheduledSession,
    push, stage, beginSchedule, finishSchedule, stopRuntime, close,
    get inbox() { return inbox; }, get relayStore() { return relayStore; },
    setQueryFailure: value => { queryFailure = value; }, releaseModel: modelGate.resolve, releaseArtifact: artifactGate.resolve,
    idle: async () => { await relay.whenIdle(); await sync.whenIdle(); },
    settled: entry => log.wait(x => x.op === 'settled' && x.id === entry.event_id, 'inbound turn settlement'),
    async reopenRelay() { await relay.close(); await relayStore.close(); await openRelay(); },
  };
}

for (const failure of ['query', 'storage']) test(`inbound ${failure} failure cannot cancel another Session's scheduled artifact`, { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  await f.beginSchedule(); const output = await f.stage(f.scheduledSession, 'scheduled.png');
  f.finishSchedule(); await f.log.wait(x => x.op === 'scheduled-entered', 'scheduled native send');
  assert.equal(isManagedOutboundArtifact(output), true, 'scheduled owner remains live while native receipt is pending');
  const relayBeforeFailure = await readFile(f.relayPath);
  const a = image(`bad-${failure}`); await f.push([a]);
  let original;
  if (failure === 'query') f.setQueryFailure(true);
  else {
    f.remote.set(a.event_id, recalled(a));
    original = await readFile(f.inboxPath);
    await rm(f.inboxPath); await mkdir(f.inboxPath);
  }
  const q = question(`ask-${failure}`); await f.push([q]); await f.settled(q);
  assert.equal(f.prompts.length, 0, 'input failure stays atomic before model submission');
  const failures = f.log.entries.filter(x => x.op === 'send' && x.type === 'm.room.message');
  assert.ok(failures.length > 0, 'actual Matrix platform received the safe input failure diagnostic');
  assert.ok(failures.every(x => !x.content.body?.includes(a.event_id) && !x.content.body?.includes('fixture unavailable')));
  assert.equal(f.inbox.get({ roomId: ROOM, eventId: a.event_id }).consumed, false);
  assert.equal(f.inbox.get({ roomId: ROOM, eventId: a.event_id }).invalidated, false);
  assert.equal(isManagedOutboundArtifact(output), true, 'unrelated input failure did not release the scheduled owner');
  assert.deepEqual(await readFile(f.relayPath), relayBeforeFailure, 'inbound failure cannot rewrite scheduled sent/unknown state');
  if (failure === 'storage') {
    await rm(f.inboxPath, { recursive: true }); await writeFile(f.inboxPath, original);
    await f.inbox.invalidate({ roomId: ROOM, eventId: a.event_id });
    // flush reports the already observed failed operation once, even after repair.
    await f.inbox.flush().catch(() => {});
  }
  f.releaseArtifact(); await f.idle();
  assert.equal(f.scheduled.length, 1);
  assert.deepEqual(f.mirrored.map(x => x.text), ['scheduled final answer']);
  const disk = JSON.parse(await readFile(f.relayPath, 'utf8'));
  const attempt = disk.sessions.find(x => x.sessionId === f.scheduledSession.id).lastAttempt;
  assert.equal(attempt.status, 'sent');
  assert.deepEqual(attempt.parts.map(x => [x.kind, x.providerMessageIds]), [['artifact', ['$scheduled-artifact:example.org']]]);
  assert.equal(isManagedOutboundArtifact(output), false);
});

test('post-submit recall does not revoke the real Harness output owner or duplicate final text', { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const a = image('submitted'); await f.push([a]); const q = question('submitted-question'); await f.push([q]);
  await f.log.wait(x => x.op === 'model-accepted', 'actual Harness prompt');
  const output = await f.stage(f.inbound, 'inbound-output.png');
  await f.push([redaction(a)]);
  assert.equal(f.inbox.isInvalidated({ roomId: ROOM, eventId: a.event_id }), true);
  assert.equal(isManagedOutboundArtifact(output), true, 'input redaction cannot release accepted output authority');
  f.releaseModel(); await f.settled(q); await f.idle();
  assert.equal(f.prompts.length, 1);
  assert.equal(f.prompts[0].content.filter(x => x.type === 'image').length, 1);
  assert.equal(f.uploads.length, 1, 'actual Matrix outbound artifact path still uploads the committed file');
  assert.deepEqual(f.uploads[0].bytes, PNG);
  const messages = f.log.entries.filter(x => x.op === 'send' && x.type === 'm.room.message');
  assert.equal(messages.filter(x => x.content.msgtype === 'm.image' && x.content.body === 'inbound-output.png').length, 1);
  assert.equal(messages.filter(x => (x.content['m.new_content']?.body ?? x.content.body) === 'inbound final answer').length, 1);
  assert.deepEqual(f.mirrored, [], 'official sync observes the real IM-owned rpcId and does not resend its answer');
  assert.equal(f.scheduled.length, 0, 'ordinary IM output never enters the scheduled relay');
  assert.equal(isManagedOutboundArtifact(output), false);
  assert.equal(f.inbox.isInvalidated({ roomId: ROOM, eventId: a.event_id }), true,
    'successful authorized output cannot reverse inbound invalidation');
});

test('exclusion notice is not final text or consumption; shutdown/reopen keeps the two stores independent', { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  await f.beginSchedule(); await f.stage(f.scheduledSession, 'restart-scheduled.png'); f.finishSchedule();
  await f.log.wait(x => x.op === 'scheduled-entered', 'scheduled native send');
  const a = image('excluded'), b = image('retained'); await f.push([a, b]); f.remote.set(a.event_id, recalled(a));
  const q = question('notice-question'); await f.push([q]); await f.log.wait(x => x.op === 'model-accepted', 'valid subset submission');
  const notices = f.log.entries.filter(x => x.op === 'send' && x.content?.msgtype === 'm.notice' && x.content.body?.includes('已撤回'));
  assert.equal(notices.length, 1);
  assert.equal(f.inbox.get({ roomId: ROOM, eventId: a.event_id }).invalidated, true);
  assert.equal(f.inbox.get({ roomId: ROOM, eventId: b.event_id }).consumed, false, 'notice receipt cannot consume retained input');
  assert.equal(f.log.entries.filter(x => x.op === 'send' && x.content?.body === 'inbound final answer').length, 0);
  assert.equal(f.prompts.length, 1);
  assert.equal(f.prompts[0].content.filter(x => x.type === 'image').length, 1);
  assert.equal(f.prompts[0].content.find(x => x.type === 'image').data,
    Buffer.concat([PNG, Buffer.from(b.content.url)]).toString('base64'));
  f.releaseArtifact(); await f.idle();
  assert.deepEqual(f.mirrored.map(x => x.text), ['scheduled final answer']);
  assert.equal(f.inbox.get({ roomId: ROOM, eventId: b.event_id }).consumed, false);
  f.releaseModel(); await f.settled(q); await f.idle();
  assert.equal(f.inbox.get({ roomId: ROOM, eventId: b.event_id }).consumed, true);
  assert.equal(f.inbox.get({ roomId: ROOM, eventId: a.event_id }).consumed, false);
  assert.equal(f.log.entries.filter(x => x.op === 'send' && x.content?.msgtype === 'm.notice' && x.content.body?.includes('已撤回')).length, 1);
  assert.deepEqual(f.mirrored.map(x => x.text), ['scheduled final answer'], 'notice and inbound final are not extra official-sync answers');

  await f.stopRuntime();
  const inboxBytes = await readFile(f.inboxPath), relayBytes = await readFile(f.relayPath);
  assert.equal(JSON.parse(inboxBytes).version, 2);
  assert.equal(JSON.parse(relayBytes).version, 2);
  assert.ok(Array.isArray(JSON.parse(inboxBytes).entries));
  assert.ok(Array.isArray(JSON.parse(relayBytes).sessions));
  const reopenedInbox = await new MatrixImageInboxStore(f.inboxPath).load();
  assert.equal(reopenedInbox.get({ roomId: ROOM, eventId: a.event_id }).invalidated, true);
  assert.equal(reopenedInbox.get({ roomId: ROOM, eventId: b.event_id }).consumed, true);
  await reopenedInbox.flush();
  assert.deepEqual(await readFile(f.relayPath), relayBytes, 'reopening image state cannot rewrite scheduled high-water');
  await f.reopenRelay();
  assert.deepEqual(await readFile(f.inboxPath), inboxBytes, 'reopening scheduled state cannot rewrite image lifecycle');
  const before = JSON.parse(relayBytes).sessions.find(x => x.sessionId === f.scheduledSession.id).lastAttempt;
  await f.beginSchedule(); await f.stage(f.scheduledSession, 'replayed-scheduled.png'); f.finishSchedule(); await f.idle();
  assert.equal(f.scheduled.length, 1, 'persisted scheduled high-water prevents native artifact replay');
  const after = JSON.parse(await readFile(f.relayPath, 'utf8')).sessions.find(x => x.sessionId === f.scheduledSession.id).lastAttempt;
  assert.deepEqual(after, before);
  assert.deepEqual(await readFile(f.inboxPath), inboxBytes);
});
