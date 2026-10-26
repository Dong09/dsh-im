import test from 'node:test';
import { deepStrictEqual, match, ok, rejects } from 'node:assert';
import { fetch as undiciFetch, MockAgent } from 'undici';

import { createMatrixImageSource } from '../../../src/channels/matrix/matrix-image-input.mjs';

import {
  MatrixApi,
  MatrixApiError,
  inspectMatrixCredentials,
  isMatrixEventId,
  isMatrixRoomId,
  isMatrixUserId,
  mxcToMatrixMediaUrl,
  performMatrixPasswordLogin,
  validateMatrixHomeserver,
} from '../../../src/channels/matrix/matrix-api.mjs';

const HOME = 'https://matrix.example.org';

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function recordingFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), ...init });
    return handler({ url: String(url), ...init }, calls.length - 1);
  };
  return { calls, fetchImpl };
}

function apiWith(handler, overrides = {}) {
  const { calls, fetchImpl } = recordingFetch(handler);
  const api = new MatrixApi({
    homeserver: HOME,
    accessToken: 'syt_secret',
    userId: '@bot:example.org',
    fetchImpl,
    ...overrides,
  });
  return { api, calls };
}

test('address validators accept the protocol forms and reject the rest', () => {
  deepStrictEqual(validateMatrixHomeserver('https://matrix.example.org///'), 'https://matrix.example.org');
  deepStrictEqual(validateMatrixHomeserver('http://localhost:8008'), 'http://localhost:8008');
  deepStrictEqual(validateMatrixHomeserver('ftp://matrix.example.org'), null);
  deepStrictEqual(validateMatrixHomeserver('https://user:pass@matrix.example.org'), null);
  deepStrictEqual(validateMatrixHomeserver('https://matrix.example.org/#room'), null);
  ok(isMatrixUserId('@bot:example.org') && isMatrixUserId('@bot:example.org:8448'));
  ok(!isMatrixUserId('bot:example.org') && !isMatrixUserId('@bot@x:y.org'));
  ok(isMatrixRoomId('!abc:example.org') && isMatrixRoomId('#alias:example.org'));
  ok(!isMatrixRoomId('abc:example.org'));
  ok(isMatrixEventId('$abc:example.org') && isMatrixEventId('$abc'));
  ok(!isMatrixEventId('abc'));
  const mediaUrl = mxcToMatrixMediaUrl(HOME, 'mxc://media.example.org/ABCDEF');
  deepStrictEqual(mediaUrl?.href,
    'https://matrix.example.org/_matrix/client/v1/media/download/media.example.org/ABCDEF');
  deepStrictEqual(mxcToMatrixMediaUrl(HOME, 'https://example.org/x.png'), null);
  deepStrictEqual(mxcToMatrixMediaUrl('not-a-url', 'mxc://a/b'), null);
});

test('room IDs accept v12 hash identifiers without relaxing legacy aliases', () => {
  const hash = 'KplB3ESm99I-4PaRdWxDUKr0Sia5nRhRtykpfs1VloM';
  ok(isMatrixRoomId(`!${hash}`), 'v12 rooms omit the homeserver suffix');
  ok(isMatrixRoomId('!0J0PZPrHJJ1xREtIG91W2cm0cL4eHGN22oIcuS8m6XI'));
  ok(isMatrixRoomId('!legacy:example.org:8448'));
  ok(isMatrixRoomId('#alias:example.org:8448'));
  for (const invalid of [null, '', '!', '!short', `#${hash}`, `!${hash}=`, `!${hash}/`, `!${hash} `, ` !${hash}`]) {
    ok(!isMatrixRoomId(invalid), `reject malformed room identifier: ${String(invalid)}`);
  }
});

test('authenticated calls carry the bearer, the user agent and typed failures', async () => {
  const { api, calls } = apiWith(() => jsonResponse({ user_id: '@bot:example.org' }));
  const identity = await api.whoami();
  deepStrictEqual(identity.user_id, '@bot:example.org');
  match(calls[0].url, /\/_matrix\/client\/v3\/account\/whoami$/u);
  deepStrictEqual(calls[0].headers.authorization, 'Bearer syt_secret');
  match(calls[0].headers['user-agent'], /^dsh-im\//u);
  const { api: denied } = apiWith(() =>
    jsonResponse({ errcode: 'm.unauthorized', error: 'Unrecognized access token' }, 401));
  await rejects(() => denied.whoami(), (error) => {
    ok(error instanceof MatrixApiError && error.code === 'matrix-auth' && error.permanent);
    ok(error.status === 401);
    ok(error.message.includes('m.unauthorized') && error.message.includes('Unrecognized'),
      'the provider error text rides along for dead-room matching and support');
    return true;
  });
});

test('event sends are PUT with a transaction id and receipts/reactions target the event path', async () => {
  const { api, calls } = apiWith(() => jsonResponse({ event_id: '$sent:example.org' }));
  const result = await api.sendEvent('!room:example.org', 'm.room.message',
    { msgtype: 'm.text', body: 'hi' }, { transactionId: 'txn-fixed1' });
  deepStrictEqual(result.event_id, '$sent:example.org');
  deepStrictEqual(calls[0].method, 'PUT');
  match(calls[0].url, /\/rooms\/!room%3Aexample\.org\/send\/m\.room\.message\/txn-fixed1$/u);
  deepStrictEqual(JSON.parse(calls[0].body), { msgtype: 'm.text', body: 'hi' });
  await api.sendReceipt('!room:example.org', '$evt:example.org');
  match(calls[1].url, /\/receipts\/m\.read\/%24evt%3Aexample\.org$/u);
  deepStrictEqual(calls[1].method, 'POST');
  await api.setTyping('!room:example.org', { typing: true, timeoutMs: 4_000 });
  match(calls[2].url, /\/typing\/%40bot%3Aexample\.org$/u);
  deepStrictEqual(JSON.parse(calls[2].body), { typing: true, timeout: 4_000 });
  await rejects(() => api.sendEvent('not-a-room', 'm.room.message', {}), TypeError);
});

test('rate limits retry exactly once with the reported delay and surface a persistent second wall', async () => {
  const { api, calls } = apiWith((call, index) =>
    index === 0
      ? jsonResponse({ errcode: 'm.limit_exceeded', error: 'slow down', retry_after_ms: 5 }, 429)
      : jsonResponse({ event_id: '$late:example.org' }));
  const sent = await api.sendEvent('!room:example.org', 'm.room.message', { body: 'again' });
  deepStrictEqual(sent.event_id, '$late:example.org');
  deepStrictEqual(calls.length, 2, 'one transparent retry is granted for m.limit_exceeded');
  const { api: stubborn } = apiWith(() =>
    jsonResponse({ errcode: 'm.limit_exceeded', error: 'slow down', retry_after_ms: 1 }, 429));
  await rejects(() => stubborn.sendEvent('!room:example.org', 'm.room.message', { body: 'x' }),
    (error) => error.code === 'matrix-rate-limited' && !error.permanent && error.retryAfterMs === 1);
});

test('state reads fold missing rooms to null and member counts count the joined list', async () => {
  const { api } = apiWith((call) => {
    if (call.url.includes('/state/')) return jsonResponse({ errcode: 'm.not.found' }, 404);
    return jsonResponse({ joined: ['@a:example.org', '@b:example.org'] });
  });
  deepStrictEqual(await api.getRoomStateEvent('!room:example.org', 'm.room.encryption'), null);
  deepStrictEqual(await api.getJoinedMemberCount('!room:example.org'), 2);
  const { api: broken } = apiWith(() => { throw new Error('connection reset'); });
  deepStrictEqual(await broken.getJoinedMemberCount('!room:example.org'), null,
    'membership probing is best-effort and never throws');
  deepStrictEqual(await broken.listRelations('!room:example.org', '$evt', 'm.reaction'), { events: [] });
});

test('media uploads post raw bytes and must answer with a content URI', async () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const { api, calls } = apiWith(() => jsonResponse({ content_uri: 'mxc://media.example.org/UP1' }));
  const uri = await api.uploadMedia(bytes, { filename: 'pic.png', mediaType: 'image/png' });
  deepStrictEqual(uri, 'mxc://media.example.org/UP1');
  deepStrictEqual(calls[0].method, 'POST');
  match(calls[0].url, /\/_matrix\/media\/v1\/upload\?filename=pic\.png$/u);
  deepStrictEqual(calls[0].headers['content-type'], 'image/png');
  ok(calls[0].body instanceof Uint8Array);
  const { api: silent } = apiWith(() => jsonResponse({}));
  await rejects(() => silent.uploadMedia(bytes, { mediaType: 'image/png' }),
    (error) => error.code === 'matrix-invalid');
  await rejects(() => api.uploadMedia(new Uint8Array(0), {}), TypeError);
});

test('media downloads stay on the configured homeserver and honor byte caps before buffering', async () => {
  const { api, calls } = apiWith((call) => {
    if (call.url.includes('/redirector/')) {
      return new Response(null, { status: 302, headers: { location: '/_matrix/client/v1/media/download/media.example.org/OK' } });
    }
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-length': '3' },
    });
  });
  deepStrictEqual(Array.from(await api.downloadContent('mxc://media.example.org/OK')), [1, 2, 3]);
  deepStrictEqual(calls[0].url, `${HOME}/_matrix/client/v1/media/download/media.example.org/OK`);
  deepStrictEqual(calls[0].headers.authorization, 'Bearer syt_secret');
  deepStrictEqual(new URL(calls[0].url).search, '', 'bearer credentials never enter the media URL');
  const { api: foreign } = apiWith((call) => {
    if (call.url.includes('LEAKTEST')) {
      return new Response(null, { status: 302, headers: { location: 'https://evil.example.org/leak' } });
    }
    return jsonResponse({ ok: true });
  });
  await rejects(() => foreign.downloadContent('mxc://media.example.org/LEAKTEST'),
    (error) => error.code === 'matrix-invalid' && error.permanent === true,
    'a redirect that leaves the homeserver is refused permanently');
  await rejects(() => foreign.downloadContent('https://matrix.example.org/sneak'),
    (error) => error.code === 'matrix-invalid',
    'only mxc content uris may be downloaded');
  const { api: huge } = apiWith(() =>
    new Response(new Uint8Array([1]), { status: 200, headers: { 'content-length': '4096' } }));
  await rejects(() => huge.downloadContent('mxc://media.example.org/OK', { maxBytes: 1024 }),
    (error) => error.code === 'too-large');
  const { api: liar } = apiWith(() => new Response(new Uint8Array(64), { status: 200 }));
  await rejects(() => liar.downloadContent('mxc://media.example.org/OK', { maxBytes: 16 }),
    (error) => error.code === 'too-large', 'the streaming cap holds even when the declared length lies');
  const { api: hopper, calls: hopCalls } = apiWith((call) => {
    if (call.url.includes('RELAY')) {
      return new Response(null, { status: 302, headers: { location: '/_matrix/client/v1/media/download/media.example.org/FINAL' } });
    }
    return new Response(new Uint8Array([7, 8]), { status: 200, headers: { 'content-length': '2' } });
  });
  deepStrictEqual(Array.from(await hopper.downloadContent('mxc://media.example.org/RELAY')), [7, 8],
    'a same-origin redirect is followed to its final payload');
  deepStrictEqual(hopCalls.length, 2, 'the redirect hop and the final hop are both recorded');
  ok(hopCalls[1].url.includes('/download/media.example.org/FINAL'));
  deepStrictEqual(hopCalls[1].headers.authorization, 'Bearer syt_secret', 'the bearer survives a same-origin hop');
  deepStrictEqual(new URL(hopCalls[1].url).search, '', 'redirects do not put the token in the URL');
  const { api: runner } = apiWith((call, index) => index === 0
    ? new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/away' } })
    : new Response(new Uint8Array([9]), { status: 200 }));
  await rejects(() => runner.downloadContent('mxc://media.example.org/OK'),
    (error) => error.code === 'matrix-invalid' && error.permanent,
    'redirects that leave the homeserver authority are refused');
});

function apiWithMockAgent(context) {
  const agent = new MockAgent();
  agent.disableNetConnect();
  context.after(() => agent.close());
  const { calls, fetchImpl } = recordingFetch((call) => {
    const { url, ...init } = call;
    return undiciFetch(url, { ...init, dispatcher: agent });
  });
  const api = new MatrixApi({ homeserver: HOME, accessToken: 'syt_secret', fetchImpl });
  return { api, agent, calls, pool: agent.get(HOME) };
}

test('plaintext Matrix image loads through authenticated media when legacy routes return 404', async (context) => {
  const { api, calls, pool } = apiWithMockAgent(context);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  pool.intercept({ path: /^\/_matrix\/media\/v(?:1|3)\/download\//u, method: 'GET' })
    .reply(404, { errcode: 'M_NOT_FOUND', error: 'Not found' }).persist();
  pool.intercept({
    path: '/_matrix/client/v1/media/download/media.example.org/PHOTO',
    method: 'GET',
    headers: { authorization: 'Bearer syt_secret' },
  }).reply(200, jpeg, { headers: { 'content-type': 'image/jpeg', 'content-length': String(jpeg.length) } });
  const source = createMatrixImageSource(api, {
    msgtype: 'm.image', body: 'photo.jpg', url: 'mxc://media.example.org/PHOTO',
    info: { mimetype: 'image/jpeg', size: jpeg.length },
  }, { maxBytes: 1024 });
  deepStrictEqual(await source.load(), jpeg);
  deepStrictEqual(calls.length, 1, 'authenticated media succeeds without retrying a legacy route');
  deepStrictEqual(calls[0].url, `${HOME}/_matrix/client/v1/media/download/media.example.org/PHOTO`);
  deepStrictEqual(calls[0].headers.authorization, 'Bearer syt_secret');
  deepStrictEqual(new URL(calls[0].url).search, '', 'access tokens must not appear in request URLs');
});

test('real Fetch follows a same-origin media redirect manually with bearer-only authentication', async (context) => {
  const { api, calls, pool } = apiWithMockAgent(context);
  const path = '/_matrix/client/v1/media/download/media.example.org';
  pool.intercept({ path: `${path}/RELAY`, method: 'GET' })
    .reply(302, '', { headers: { location: `${path}/FINAL` } });
  pool.intercept({ path: `${path}/FINAL`, method: 'GET', headers: { authorization: 'Bearer syt_secret' } })
    .reply(200, Buffer.from([7, 8]), { headers: { 'content-length': '2' } });
  deepStrictEqual(Array.from(await api.downloadContent('mxc://media.example.org/RELAY')), [7, 8]);
  deepStrictEqual(calls.length, 2, 'the API validates and issues each redirect hop itself');
  deepStrictEqual(calls.map((call) => call.redirect), ['manual', 'manual']);
  for (const call of calls) {
    deepStrictEqual(call.headers.authorization, 'Bearer syt_secret');
    deepStrictEqual(new URL(call.url).search, '');
  }
});

for (const [name, destination] of [
  ['different scheme', 'http://matrix.example.org/leak'],
  ['foreign hostname', 'https://evil.example.org/leak'],
  ['different port', 'https://matrix.example.org:8448/leak'],
  ['URL username', 'https://user@matrix.example.org/leak'],
  ['URL password', 'https://:password@matrix.example.org/leak'],
]) {
  test(`real Fetch refuses a media redirect to ${name} without sending credentials there`, async (context) => {
    const { api, agent, calls, pool } = apiWithMockAgent(context);
    let destinationRequests = 0;
    pool.intercept({ path: '/_matrix/client/v1/media/download/media.example.org/RELAY', method: 'GET' })
      .reply(302, '', { headers: { location: destination } });
    agent.get(new URL(destination).origin).intercept({ path: '/leak', method: 'GET' }).reply(() => {
      destinationRequests += 1;
      return { statusCode: 200, data: Buffer.from([9]) };
    });
    await rejects(() => api.downloadContent('mxc://media.example.org/RELAY'),
      (error) => error instanceof MatrixApiError && error.code === 'matrix-invalid' && error.permanent);
    deepStrictEqual(destinationRequests, 0, 'the rejected redirect destination must never receive a request');
    deepStrictEqual(calls.length, 1, 'only the configured homeserver receives the bearer');
    deepStrictEqual(calls[0].headers.authorization, 'Bearer syt_secret');
    deepStrictEqual(calls[0].redirect, 'manual');
  });
}

test('password logins keep the server-assigned device identity and fail with typed codes', async () => {
  const { calls, fetchImpl } = recordingFetch(() =>
    jsonResponse({ access_token: 'syt_t', user_id: '@bot:example.org', device_id: 'DEV9' }));
  const session = await performMatrixPasswordLogin(
    { homeserver: HOME, userId: '@bot:example.org', password: 'sekret', deviceId: 'DEV9', fetchImpl },
    {});
  deepStrictEqual(session, { accessToken: 'syt_t', userId: '@bot:example.org', deviceId: 'DEV9' });
  const body = JSON.parse(calls[0].body);
  deepStrictEqual(body.type, 'm.login.password');
  deepStrictEqual(body.identifier, { type: 'm.id.user', user: '@bot:example.org' });
  deepStrictEqual(body.initial_device_display_name, 'DeepSeek Harness');
  ok(!('medium' in body));
  await rejects(() => performMatrixPasswordLogin(
    { homeserver: HOME, userId: 'bad', password: 'x', fetchImpl }), TypeError);
  const broken = recordingFetch(() => jsonResponse({ errcode: 'm.forbidden' }, 403)).fetchImpl;
  await rejects(() => performMatrixPasswordLogin(
    { homeserver: HOME, userId: '@bot:example.org', password: 'x', fetchImpl: broken }),
    (error) => error.code === 'matrix-forbidden' && error.permanent);
});

test('credential inspection resolves one stable identity for either auth form', async () => {
  const tokenProbe = recordingFetch(() =>
    jsonResponse({ user_id: '@Bot:Example.org', device_id: 'DEV1' }));
  const inspected = await inspectMatrixCredentials(
    { homeserver: `${HOME}/`, accessToken: 'syt_t' }, { fetchImpl: tokenProbe.fetchImpl });
  deepStrictEqual(inspected, {
    platformId: 'matrix.example.org|@bot:example.org',
    homeserver: HOME,
    userId: '@Bot:Example.org',
    deviceId: 'DEV1',
    name: 'Bot',
    username: 'Bot',
  });
  const passwordProbe = recordingFetch(() =>
    jsonResponse({ access_token: 'syt_t', user_id: '@alice:example.org', device_id: 'DEV2' }));
  const viaPassword = await inspectMatrixCredentials(
    { homeserver: HOME, userId: '@alice:example.org', password: 'sekret' },
    { fetchImpl: passwordProbe.fetchImpl });
  deepStrictEqual(viaPassword.platformId, 'matrix.example.org|@alice:example.org');
  deepStrictEqual(viaPassword.name, 'alice');
  const rejectedProbe = recordingFetch(() => jsonResponse({ errcode: 'm.unauthorized' }, 401));
  await rejects(() => inspectMatrixCredentials(
    { homeserver: HOME, accessToken: 'bad' }, { fetchImpl: rejectedProbe.fetchImpl }),
    (error) => error.code === 'auth-failed');
  await rejects(() => inspectMatrixCredentials({ homeserver: 'ftp://x', accessToken: 't' },
    { fetchImpl: tokenProbe.fetchImpl }), (error) => error.code === 'invalid-config');
  await rejects(() => inspectMatrixCredentials({ homeserver: HOME },
    { fetchImpl: tokenProbe.fetchImpl }), (error) => error.code === 'invalid-config');
});
