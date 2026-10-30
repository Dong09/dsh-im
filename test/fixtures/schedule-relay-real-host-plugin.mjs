import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// The selected checkout owns DSH; the plugin package gains no DSH runtime dependency.
const { LlmAdapter, ToolCallId } = await import(process.env.DSH_SCHEDULE_RELAY_LLM_MODULE);
import {
  OUTBOUND_ARTIFACT_TOOL,
  installOutboundArtifactTool,
  isManagedOutboundArtifact,
  outboundArtifactRegistry as registry,
} from '../../src/channels/shared/semantic/artifact.mjs';
import { deliverOutboundArtifacts } from '../../src/channels/shared/semantic/artifact-delivery.mjs';
import { HarnessClient } from '../../src/channels/shared/harness-client.mjs';
import { modernHarnessApi } from '../../plugin-src/host/modern-harness-api.mjs';
import { installScheduleRelay } from '../../plugin-src/host/schedule-relay.mjs';

export const name = 'schedule-relay-real-host-fixture';
export const inject = ['llm', 'agents', 'sessions', 'tools', 'systemPrompt', 'schedule', 'sessionController', 'connection'];

/** A scripted external model; the Agent, inbox, prompt assembly, tools and Session remain real. */
class ScriptedModel extends LlmAdapter {
  constructor(state) { super(); this.state = state; }

  async *stream(options) {
    const state = this.state;
    const call = state.requests.length + 1;
    state.trace.push({ kind: 'model:request', call, active: registry.hasActiveConsumer(state.agent.session) });
    state.requests.push({ purpose: options.purpose ?? null, messages: options.messages, tools: options.tools.map(({ name }) => name) });
    assert.equal(options.purpose, undefined, 'no title/compaction/auxiliary model calls are allowed');
    assert.ok(call <= 2, 'delivery must not add model calls');
    if (call === 1) {
      const args = JSON.stringify({ path: state.scenario.fileName });
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id: ToolCallId('first-return-file'), name: OUTBOUND_ARTIFACT_TOOL, argumentsDelta: args };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('first-return-file'), name: OUTBOUND_ARTIFACT_TOOL, arguments: args } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    assert.equal(state.toolResults.length, 1, 'the first tool call must settle before the final response');
    assert.notEqual(state.toolResults[0].isError, true, 'first return-file must succeed');
    const text = 'The existing file is queued for delivery after this turn.';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

function targetFor(scenario) {
  return { kind: scenario.kind, route: {
    roomId: scenario.roomId,
    ...(scenario.threadId ? { threadId: scenario.threadId } : {}),
  } };
}

/** Install ordinary plugin contributions through a supported dsh profile patch. */
export async function apply(ctx) {
  assert.equal(typeof ctx.systemPrompt.refreshContext, 'function', 'UNSUPPORTED_HOST_REFRESH_CONTEXT: pause implementation');
  const fixture = JSON.parse(await readFile(fileURLToPath(new URL('./schedule-relay-sequence.json', import.meta.url)), 'utf8'));
  const scenario = fixture.cases.find(({ id }) => id === process.env.DSH_SCHEDULE_RELAY_CASE);
  assert.ok(scenario, 'known schedule relay fixture case is required');
  const state = { scenario, trace: [], events: [], requests: [], claims: [], assemblies: [], toolResults: [], sends: [], snapshots: [], warnings: [], imageCalls: 0, agent: null };
  const expectedTarget = targetFor(scenario);
  const authorization = Object.freeze({ fixture: scenario.id });
  const expectedBytes = scenario.mediaType.startsWith('image/') ? Buffer.from(fixture.imageBase64, 'base64') : Buffer.from(fixture.fileText);
  const botId = 'matrix_fixture';
  const sessionId = `session-schedule-relay-${scenario.id}`;
  let relay;

  const recordFile = (channel) => async (file) => {
    assert.equal(file.fileName, scenario.fileName);
    assert.equal(file.mediaType, scenario.mediaType);
    assert.deepEqual(file.bytes, expectedBytes);
    state.trace.push({ kind: 'platform:artifact', channel });
    state.sends.push({ kind: channel, botId, target: expectedTarget, fileName: file.fileName,
      mediaType: file.mediaType, bytesBase64: Buffer.from(file.bytes).toString('base64'), providerMessageIds: [scenario.eventId] });
    return { providerMessageIds: [scenario.eventId] };
  };
  const deliverArtifact = async (artifact) => {
    assert.equal(artifact.origin.sessionId, sessionId);
    assert.equal(artifact.origin.turn, 1);
    assert.equal(artifact.origin.callId, 'first-return-file');
    assert.equal(isManagedOutboundArtifact(artifact), true, 'handoff must retain the original live WeakMap-backed snapshot');
    const snapshot = { artifactId: artifact.artifactId, source: artifact.source, origin: artifact.origin,
      fileName: artifact.fileName, size: artifact.size, digest: artifact.digest, liveBefore: true };
    state.snapshots.push(snapshot);
    const result = await deliverOutboundArtifacts({ artifacts: [artifact], channelKey: 'matrix',
      sendImage: recordFile('image'), sendFile: recordFile('file') });
    assert.equal(result.artifactsSent, 1);
    const outcome = result.receipt.artifacts.find(item => item.artifactId === artifact.artifactId)?.outcome;
    assert.equal(outcome, 'sent', 'the shared sender must confirm this exact artifact');
    snapshot.liveAfter = isManagedOutboundArtifact(artifact);
    assert.equal(snapshot.liveAfter, false, 'the shared sender releases the consumed snapshot');
    return { ...result.receipt, deliveryOutcome: outcome };
  };
  const recordText = (text) => {
    state.trace.push({ kind: 'platform:text' });
    state.sends.push({ kind: 'text', botId, target: expectedTarget, text, providerMessageIds: [scenario.textEventId] });
    return { deliveryOutcome: 'sent', providerMessageIds: [scenario.textEventId] };
  };
  const im = {
    async listBots() { return [{ botId, channel: 'matrix' }]; },
    async listConversationBindings(id) {
      assert.equal(id, botId);
      state.trace.push({ kind: 'bindings:read', active: state.agent ? registry.hasActiveConsumer(state.agent.session) : false });
      return { botId, channel: 'matrix', bindings: [{ sessionId, ...expectedTarget }] };
    },
    async authorizeScheduledTarget(id, target, { signal }) {
      signal.throwIfAborted();
      assert.equal(id, botId);
      assert.deepEqual(target, expectedTarget);
      state.trace.push({ kind: 'platform:authorize' });
      return authorization;
    },
    async sendScheduledPart(id, target, part, options) {
      options.signal.throwIfAborted();
      assert.equal(scenario.input, 'schedule', 'ordinary IM must not use the scheduled sender');
      assert.equal(id, botId);
      assert.deepEqual(target, expectedTarget);
      assert.equal(options.authorization, authorization);
      return part.kind === 'text' ? recordText(part.text) : deliverArtifact(part.artifact);
    },
  };

  ctx.llm.registerAdapter(['schedule-relay-scripted'], new ScriptedModel(state));
  assert.equal(installOutboundArtifactTool(ctx, { registry }), true);
  relay = await installScheduleRelay(ctx, im, { dshHome: process.env.DSH_HOME, registry,
    logger: { warn: (message) => state.warnings.push(message) } });
  ctx.tools.register({ name: 'codex_image_generate', description: 'External generation sentinel; never needed for an existing file.',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object', properties: {} }, render: () => [] },
    execute() { state.imageCalls += 1; throw new Error('fixture must not regenerate an existing image'); } });
  ctx.systemPrompt.context({ name: 'schedule-relay:ordering-probe', order: 116, text: ({ agent }) => {
    if (agent?.id === sessionId) state.trace.push({ kind: 'context:evaluate', active: registry.hasActiveConsumer(agent.session) });
    return 'Schedule relay integration fixture runtime context.';
  } });
  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    if (agent.id !== sessionId) return;
    state.trace.push({ kind: 'inbox:claim', source: message.source, turn, active: registry.hasActiveConsumer(agent.session) });
    state.claims.push({ id: message.id, source: message.source, turn });
  }, { global: true });
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const result = await next();
    if (context.agent?.id === sessionId) {
      state.trace.push({ kind: 'prompt:assemble', active: registry.hasActiveConsumer(context.agent.session) });
      state.assemblies.push(result.contexts);
    }
    return result;
  }, { global: true });
  // Observe the real waterfall; no authority is created or core event emitted here.
  ctx.on('agent/pre-step', async (payload, next) => {
    if (payload.agent.id !== sessionId) return next();
    state.trace.push({ kind: 'pre-step:begin', step: payload.step, active: registry.hasActiveConsumer(payload.agent.session) });
    const decision = await next();
    state.trace.push({ kind: 'pre-step:complete', step: payload.step, active: registry.hasActiveConsumer(payload.agent.session), decision: decision.kind });
    return decision;
  }, { global: true, prepend: true });
  ctx.on('tools/result', (exec, result) => {
    if (exec.agent?.id === sessionId && exec.name === OUTBOUND_ARTIFACT_TOOL) {
      state.trace.push({ kind: 'tool:result', isError: result.isError === true });
      state.toolResults.push(result);
    }
  }, { global: true });
  const completed = Promise.withResolvers();
  ctx.on('session/event', (session, event) => {
    if (session.id !== sessionId) return;
    state.events.push(event);
    if (event.type === 'turn/end') { state.trace.push({ kind: 'turn:end', reason: event.data.reason }); completed.resolve(); }
  }, { global: true });

  const run = async () => {
    await ctx.get('loader').await();
    const handle = await ctx.agents.create({ sessionId, meta: { cwd: process.cwd() },
      agentOptions: { provider: 'schedule-relay-scripted', model: 'existing-file-fixture' } });
    state.agent = handle.agent;
    try {
      assert.deepEqual(await readFile(join(process.cwd(), scenario.fileName)), expectedBytes, 'original must exist before scheduling');
      if (scenario.input === 'schedule') {
        // Native scheduler owns the timer and constructs the no-rpcId input.
        // Await its actual turn/end, never a test delay or synthetic Session event.
        const record = await ctx.schedule.create(sessionId, { title: 'Deliver existing fixture',
          prompt: `Return the existing file ${scenario.fileName} to its original Matrix conversation. Do not regenerate or rename it.`, after_seconds: 1 });
        state.scheduleId = record.id;
        await completed.promise;
        await handle.agent.whenIdle();
        await relay.whenIdle();
      } else {
        // The real ordinary IM client opens its own RPC consumer; this fixture
        // never opens either a scheduled lease or an RPC consumer by hand.
        const client = new HarnessClient({ apiProxy: modernHarnessApi(ctx), interactionScope: ctx.root, workspace: process.cwd() });
        const answer = await client.ask(sessionId, `Return ${scenario.fileName}.`, { timeoutMs: 15_000, onArtifact: deliverArtifact });
        recordText(answer);
        await relay.whenIdle();
      }
      await ctx.sessions.flush(handle.agent.session);
      state.originalAfterBase64 = (await readFile(join(process.cwd(), scenario.fileName))).toString('base64');
      state.workspaceFiles = (await readdir(process.cwd())).filter((name) => !name.startsWith('.')).sort();
      state.checkpoint = JSON.parse(await readFile(join(process.env.DSH_HOME, 'integrations', 'dsh-matrix', 'schedule-replies.json'), 'utf8'));
      state.activeAfterEnd = registry.hasActiveConsumer(handle.agent.session);
      await writeFile(process.env.DSH_SCHEDULE_RELAY_RESULT, JSON.stringify(state, (key, value) => key === 'agent' ? undefined : value, 2));
    } finally { await handle.dispose(); }
  };
  const ready = ctx.get('appReady');
  assert.ok(ready, 'supported dsh launcher must supply appReady');
  ctx.effect(() => ready.onReady(() => {
    void run().then(() => ctx.get('appExit')(0), async (error) => {
      await writeFile(process.env.DSH_SCHEDULE_RELAY_RESULT, JSON.stringify({ error: error.stack, ...state },
        (key, value) => key === 'agent' ? undefined : value, 2));
      console.error(error);
      ctx.get('appExit')(1);
    });
  }));
}
