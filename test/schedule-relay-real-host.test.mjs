import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { access, copyFile, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const fixturePath = fileURLToPath(new URL('./fixtures/schedule-relay-sequence.json', import.meta.url));
const pluginPath = fileURLToPath(new URL('./fixtures/schedule-relay-real-host-plugin.mjs', import.meta.url));
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const CHECKOUT_ENV = 'DSH_SCHEDULE_RELAY_DSH_CHECKOUT';

async function isCheckout(path) {
  try {
    await access(join(path, 'apps', 'cli', 'src', 'bin.ts'));
    await access(join(path, 'packages', 'core', 'agent-loop', 'src', 'agent.ts'));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function findCheckout() {
  const configured = process.env[CHECKOUT_ENV] ?? process.env.DSH_CHECKOUT;
  if (configured) {
    const path = resolve(configured);
    assert.ok(await isCheckout(path), `${CHECKOUT_ENV} must name an actual DSH checkout: ${path}`);
    return path;
  }
  for (let ancestor = resolve(projectRoot);;) {
    for (const candidate of [ancestor, join(ancestor, 'deepseek-harness')]) {
      if (await isCheckout(candidate)) return candidate;
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) return null;
    ancestor = parent;
  }
}

function isolatedEnv(root, scenario) {
  const env = { ...process.env };
  // Never load the current GUI's home/profile/credentials or any model/proxy keys.
  for (const key of Object.keys(env)) {
    if (/^(DSH_|DEEPSEEK_|OPENAI_|ANTHROPIC_|GOOGLE_|GEMINI_)/i.test(key)
      || /^(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i.test(key)) delete env[key];
  }
  return { ...env, DSH_HOME: join(root, '.dsh'), DSH_AGENTS_HOME: join(root, '.agents'),
    DSH_TELEMETRY_DISABLED: '1', DSH_PERMISSION_MODE: 'danger-full-access',
    DSH_SCHEDULE_RELAY_CASE: scenario.id, DSH_SCHEDULE_RELAY_RESULT: join(root, '.result.json'),
    TZ: 'Asia/Shanghai' };
}

function patch() {
  const disabled = ['headless-startup', 'headless-runner', 'session-title-llm', 'llm-deepseek',
    'llm-deepseek-account', 'llm-pi-ai', 'web-search-deepseek', 'web-deepseek-api', 'agent-instructions', 'skill-filesystem'];
  const entries = [
    ['connection', '@deepseek-ai/dsh-client-connection'],
    ['file-upload', '@deepseek-ai/dsh-client-file-upload'],
    ['workspace', '@deepseek-ai/dsh-workspace'],
    ['workspace-controller', '@deepseek-ai/dsh-api-workspace-controller'],
    ['file-reference-local', '@deepseek-ai/dsh-file-reference-local'],
    ['session-controller', '@deepseek-ai/dsh-api-session-controller'],
    ['schedule', '@deepseek-ai/dsh-schedule'],
    ['time-context', '@deepseek-ai/dsh-time-context'],
    ['schedule-relay-real-host-fixture', pathToFileURL(pluginPath).href],
    ['schedule-relay-profile-audit', new URL('./fixtures/schedule-relay-profile-audit.mjs', import.meta.url).href],
  ];
  return [
    '# Supported headless profile plus real Host services, with external model/platform substitutes only.',
    ...disabled.flatMap(id => [`- id: ${id}`, '  disabled: true']),
    '- id: credentials', '  disabled: false',
    '- id: agent-default-model', '  config:', '    provider: schedule-relay-scripted', '    model: existing-file-fixture',
    '- id: session-persistence-jsonl', '  config:', '    root: ./.sessions', '    compression: none',
    '- insert:', ...entries.flatMap(([id, name]) => [`    - id: ${id}`, `      name: ${JSON.stringify(name)}`]), '',
  ].join('\n');
}

async function runHost(t, checkout, scenario) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-im-real-host-'));
  assert.equal(dirname(root), resolve(tmpdir()));
  assert.ok(basename(root).startsWith('dsh-im-real-host-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = scenario.mediaType.startsWith('image/') ? Buffer.from(fixture.imageBase64, 'base64') : Buffer.from(fixture.fileText);
  await writeFile(join(root, scenario.fileName), bytes);
  const overlay = join(root, '.schedule-relay.patch.yml');
  await writeFile(overlay, patch());
  const env = isolatedEnv(root, scenario);
  const mode = process.env.DSH_EXAMPLE_MODE ?? 'src';
  assert.ok(['src', 'lib'].includes(mode), 'DSH_EXAMPLE_MODE must be src or lib');
  const bin = join(checkout, 'apps', 'cli', mode, mode === 'src' ? 'bin.ts' : 'bin.js');
  await access(bin);
  // This external-plugin regression deliberately covers the supported source
  // launch and cross-checkout module resolution. Built CI may select lib mode.
  // No inline app tree or package-bin escape launches a second Harness.
  const requireFromCheckout = createRequire(join(checkout, 'package.json'));
  const args = mode === 'src'
    ? ['--import', pathToFileURL(requireFromCheckout.resolve('tsx/esm')).href, bin]
    : [bin];
  if (mode === 'src') env.TSX_TSCONFIG_PATH = join(checkout, 'tsconfig.json');
  env.DSH_SCHEDULE_RELAY_LLM_MODULE = pathToFileURL(join(checkout, 'packages', 'llm', 'llm', mode, mode === 'src' ? 'index.ts' : 'index.js')).href;
  args.push('--profile', 'headless', '--patch', overlay);
  const stdout = await open(join(root, '.stdout.log'), 'w');
  const stderr = await open(join(root, '.stderr.log'), 'w');
  let outcome;
  try {
    outcome = await new Promise((resolveExit) => {
      const child = spawn(process.execPath, args, { cwd: root, env, windowsHide: true,
        // Files, not captured named-pipe stdio: also works in confined Windows hosts.
        stdio: ['ignore', stdout.fd, stderr.fd], signal: AbortSignal.timeout(90_000), killSignal: 'SIGKILL' });
      let failure;
      child.once('error', error => { failure = error.stack; });
      child.once('close', (code, signal) => resolveExit({ code, signal, ...(failure ? { error: failure } : {}) }));
    });
  } finally { await stdout.close(); await stderr.close(); }
  const logs = `stdout:\n${await readFile(join(root, '.stdout.log'), 'utf8')}\nstderr:\n${await readFile(join(root, '.stderr.log'), 'utf8')}`;
  if (process.env.DSH_SCHEDULE_RELAY_EVIDENCE_DIR) {
    const evidenceDir = resolve(process.env.DSH_SCHEDULE_RELAY_EVIDENCE_DIR);
    await mkdir(evidenceDir, { recursive: true });
    try { await copyFile(env.DSH_SCHEDULE_RELAY_RESULT, join(evidenceDir, `${scenario.id}.json`)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await writeFile(join(evidenceDir, `${scenario.id}.launch.txt`), [process.execPath, ...args].map(JSON.stringify).join(' ') + '\n' + logs);
  }
  assert.deepEqual(outcome, { code: 0, signal: null }, logs);
  const result = JSON.parse(await readFile(env.DSH_SCHEDULE_RELAY_RESULT, 'utf8'));
  assert.equal(result.error, undefined, `${result.error ?? ''}\n${logs}`);
  return { result, bytes, mode };
}

const checkout = await findCheckout();
for (const scenario of fixture.cases) {
  test(`real dsh Host: ${scenario.id} preserves first-step ownership, existing bytes and exact destination`, {
    timeout: 105_000,
    skip: checkout === null ? `External installation has no DSH checkout; set ${CHECKOUT_ENV} (this environment must run, not skip).` : false,
  }, async (t) => {
    const { result, bytes, mode } = await runHost(t, checkout, scenario);
    assert.equal(result.requests.length, 2, 'one tool request and one final answer; no delivery repair model call');
    assert.equal(result.imageCalls, 0);
    assert.equal(result.requests.every(request => request.purpose === null), true);
    assert.equal(result.toolResults.length, 1);
    assert.notEqual(result.toolResults[0].isError, true);
    const registered = result.toolResults[0].value;
    assert.equal(registered.fileName, scenario.fileName);
    assert.equal(registered.size, bytes.length);
    assert.match(result.toolResults[0].content.map(part => part.text ?? '').join('\n'), /Registered .*has not been sent yet/);
    assert.deepEqual(result.snapshots, [{ artifactId: registered.artifactId, source: 'managed-temp',
      origin: { sessionId: `session-schedule-relay-${scenario.id}`, turn: 1, callId: 'first-return-file' },
      fileName: scenario.fileName, size: bytes.length, digest: createHash('sha256').update(bytes).digest('hex'), liveBefore: true, liveAfter: false }]);
    const calls = result.events.filter(event => event.type === 'tool/call');
    assert.deepEqual(calls.map(event => event.data.name), ['dsh_im_return_file']);
    assert.equal(calls[0].data.callId, 'first-return-file');
    assert.equal(result.originalAfterBase64, bytes.toString('base64'), 'original is not rewritten');
    assert.deepEqual(result.workspaceFiles, [scenario.fileName], 'no renamed delivery copy or regenerated source appears in workspace');
    const expectedTarget = { kind: scenario.kind, route: { roomId: scenario.roomId,
      ...(scenario.threadId ? { threadId: scenario.threadId } : {}) } };
    assert.equal(result.sends.length, 2, 'exactly one final text and one registered artifact');
    assert.deepEqual(result.sends.map(send => send.target), [expectedTarget, expectedTarget]);
    assert.deepEqual(result.sends.map(send => send.botId), ['matrix_fixture', 'matrix_fixture']);
    const files = result.sends.filter(send => send.kind !== 'text');
    assert.equal(files.length, 1);
    assert.deepEqual(files[0], { kind: scenario.mediaType.startsWith('image/') ? 'image' : 'file',
      botId: 'matrix_fixture', target: expectedTarget, fileName: scenario.fileName, mediaType: scenario.mediaType,
      bytesBase64: bytes.toString('base64'), providerMessageIds: [scenario.eventId] });
    assert.equal(result.activeAfterEnd, false);
    const completed = result.events.filter(event => event.type === 'turn/end');
    assert.equal(completed.length, 1);
    assert.equal(completed[0].data.reason.kind, 'completed');
    const inputs = result.events.filter(event => event.type === 'user/message' && event.surfaceOp === 'append');
    assert.ok(inputs.some(event => event.data.source.kind === 'runtime-context' && event.data.source.form === 'snapshot'));
    assert.ok(inputs.some(event => event.data.source.kind === 'time-context' && event.data.source.form === 'snapshot'));
    const firstRequest = result.requests[0];
    const loggedRuntime = inputs.find(event => event.data.source.kind === 'runtime-context').data;
    const requestedRuntime = firstRequest.messages.find(message => message.source?.kind === 'runtime-context');
    assert.deepEqual(requestedRuntime.content, loggedRuntime.content, 'first-request guidance is durable, not an unlogged prompt injection');
    assert.ok(loggedRuntime.source.sections.some(section => section.name === 'dsh-im:return-file' && section.text.includes('call dsh_im_return_file')));
    const runtime = firstRequest.messages.filter(message => message.role === 'user')
      .flatMap(message => message.content.filter(part => part.type === 'text').map(part => part.text)).join('\n');
    assert.match(runtime, /call dsh_im_return_file with its path/);
    assert.match(runtime, /do not recreate or rename a file solely for delivery/);
    assert.match(runtime, /Time sampled while preparing turn 1, step 1:/);
    const record = result.checkpoint.sessions.find(({ sessionId }) => sessionId === `session-schedule-relay-${scenario.id}`);
    if (scenario.input === 'schedule') {
      assert.deepEqual(inputs.map(event => event.data.source.kind).filter(kind => fixture.coreInputKinds.includes(kind)),
        fixture.coreInputKinds, 'native schedule, runtime refresh and time snapshot preserve the real first-request sequence');
      assert.equal(result.claims.length, 1, 'only the native schedule wakes this turn');
      assert.equal(result.claims[0].source.kind, 'schedule');
      assert.equal(Object.hasOwn(result.claims[0].source, 'rpcId'), false);
      assert.ok(inputs.some(event => event.data.id === result.claims[0].id && event.data.source.kind === 'schedule'));
      const trace = result.trace;
      const claim = trace.findIndex(entry => entry.kind === 'inbox:claim');
      const assemble = trace.findIndex(entry => entry.kind === 'prompt:assemble');
      const preStep = trace.findIndex(entry => entry.kind === 'pre-step:begin');
      const prepared = trace.findIndex(entry => entry.kind === 'pre-step:complete');
      const refreshed = trace.findIndex((entry, index) => index > prepared && entry.kind === 'context:evaluate');
      const request = trace.findIndex(entry => entry.kind === 'model:request');
      assert.ok(claim >= 0 && claim < assemble && assemble < preStep && preStep < prepared && prepared < refreshed && refreshed < request,
        JSON.stringify(trace, null, 2));
      assert.equal(trace[claim].active, false, 'claim does not asynchronously fake early ownership');
      assert.equal(trace[assemble].active, false, 'initial assembly genuinely precedes lease creation');
      assert.equal(trace[preStep].active, false);
      assert.equal(trace[prepared].active, true, 'awaited pre-step opens the real lease');
      assert.equal(trace[refreshed].active, true, 'real Host refresh reevaluates registered context after pre-step');
      assert.equal(trace[request].active, true);
      const initialGuidance = result.assemblies[0].find(context => context.name === 'dsh-im:return-file');
      assert.ok(initialGuidance, 'empty context registration must survive initial assembly for later refresh');
      assert.equal(initialGuidance.text, '');
      assert.deepEqual(result.sends.map(send => send.kind), ['text', scenario.mediaType.startsWith('image/') ? 'image' : 'file']);
      assert.equal(record.lastAttempt.status, 'sent');
      assert.deepEqual(record.lastAttempt.parts.map(part => ({ kind: part.kind, status: part.status, ids: part.providerMessageIds })), [
        { kind: 'text', status: 'sent', ids: [scenario.textEventId] },
        { kind: 'artifact', status: 'sent', ids: [scenario.eventId] },
      ]);
      assert.equal(result.warnings.length, 0, JSON.stringify(result.warnings));
    } else {
      assert.equal(result.claims[0].source.kind, 'user');
      assert.equal(typeof result.claims[0].source.rpcId, 'string');
      assert.equal(record.lastAttempt, undefined, 'ordinary IM consumer sends once; relay must not duplicate it');
      assert.equal(result.trace.filter(entry => entry.kind === 'platform:authorize').length, 0);
    }
    t.diagnostic(`DSH ${mode} profile=headless case=${scenario.id}: ${result.requests.length} model calls, ${result.imageCalls} image-generation calls, ${result.sends.map(send => `${send.kind}:${send.providerMessageIds.join(',')}`).join(' ')}; managed snapshot retained/released; first-request guidance and exact receipts asserted`);
  });
}
