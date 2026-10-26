import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash } from 'node:crypto';

import { MatrixApiError } from '../../../src/channels/matrix/matrix-api.mjs';
import { createMatrixImageSource } from '../../../src/channels/matrix/matrix-image-input.mjs';
import { inboundImagesAsFiles } from '../../../src/channels/shared/image-input.mjs';
import { ImagePromptError } from '../../../src/channels/shared/image-prompt.mjs';

const URI = 'mxc://example.org/image';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const content = (extra = {}) => ({ msgtype: 'm.image', body: 'photo.png', url: URI, ...extra });

function sourceFor(downloadContent, eventContent = content(), maxBytes = 1024) {
  return createMatrixImageSource({ downloadContent }, eventContent, { maxBytes });
}

function imageError(code, { cause, stage, filename = 'photo.png' } = {}) {
  return (error) => {
    assert.ok(error instanceof ImagePromptError);
    assert.equal(error.name, 'ImagePromptError');
    assert.equal(error.code, code);
    assert.equal(typeof error.userMessage, 'string');
    assert.ok(error.userMessage.length > 0, 'a failed image has a concrete user-facing explanation');
    if (filename) assert.ok(error.userMessage.includes(filename), error.userMessage);
    if (cause !== undefined) assert.equal(error.cause, cause, 'retain the original cause for diagnosis');
    if (stage) assert.match(error.message, new RegExp(stage));
    return true;
  };
}

function encryptedFixture() {
  // Fixed, local-only fixture; Matrix v2 uses AES-256-CTR and SHA-256 of ciphertext.
  const key = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');
  const iv = Buffer.from('a1a2a3a4a5a6a7a80000000000000000', 'hex');
  const cipher = createCipheriv('aes-256-ctr', key, iv);
  const ciphertext = Buffer.concat([cipher.update(PNG), cipher.final()]);
  return {
    ciphertext,
    file: {
      v: 'v2', url: 'mxc://example.org/encrypted-image',
      key: { kty: 'oct', alg: 'A256CTR', key_ops: ['encrypt', 'decrypt'], ext: true, k: key.toString('base64url') },
      iv: iv.toString('base64').replace(/=+$/, ''),
      hashes: { sha256: createHash('sha256').update(ciphertext).digest('base64').replace(/=+$/, '') },
    },
  };
}

test('source creation is lazy, exposes metadata and returns a Buffer only when loaded', async () => {
  const calls = [];
  const controller = new AbortController();
  const source = sourceFor(async (...args) => { calls.push(args); return PNG; },
    content({ info: { size: PNG.length, mimetype: 'image/png' } }));
  assert.equal(source.name, 'photo.png');
  assert.equal(source.size, PNG.length);
  assert.equal(source.data, undefined);
  assert.equal(calls.length, 0, 'ambient image receipts must not trigger downloads');
  const loaded = await source.load({ signal: controller.signal, maxBytes: 512 });
  assert.ok(Buffer.isBuffer(loaded));
  assert.deepEqual(loaded, PNG);
  assert.deepEqual(calls, [[URI, { signal: controller.signal, maxBytes: 512 }]]);
});

test('Uint8Array downloads become independent Buffer results', async () => {
  const bytes = new Uint8Array(PNG);
  const loaded = await sourceFor(async () => bytes).load();
  assert.ok(Buffer.isBuffer(loaded));
  assert.deepEqual(loaded, PNG);
  loaded[0] = 0;
  assert.equal(bytes[0], PNG[0], 'returned data must not alias the download buffer');
});

test('the stricter channel/host byte cap reaches the download API and exact boundaries pass', async () => {
  for (const [channelMaxBytes, hostMaxBytes, expected] of [
    [PNG.length, 1024, PNG.length], [1024, PNG.length, PNG.length],
    [PNG.length, PNG.length, PNG.length], [1024, undefined, 1024],
  ]) {
    let calls = 0;
    const source = sourceFor(async (_uri, options) => {
      calls += 1;
      assert.equal(options.maxBytes, expected);
      return PNG;
    }, content({ info: { size: PNG.length } }), channelMaxBytes);
    assert.deepEqual(await source.load({ maxBytes: hostMaxBytes }), PNG);
    assert.equal(calls, 1);
  }
});

test('declared size over either byte cap fails before starting a download', async () => {
  for (const [channelMaxBytes, hostMaxBytes] of [[PNG.length - 1, 1024], [1024, PNG.length - 1]]) {
    let downloads = 0;
    const source = sourceFor(async () => { downloads += 1; return PNG; },
      content({ info: { size: PNG.length } }), channelMaxBytes);
    await assert.rejects(source.load({ maxBytes: hostMaxBytes }), imageError('image-too-large', { stage: 'size' }));
    assert.equal(downloads, 0);
  }
});

test('undeclared or understated downloads exceeding either cap cannot bypass the limit', async () => {
  for (const info of [undefined, { size: 1 }]) {
    for (const [channelMaxBytes, hostMaxBytes] of [[PNG.length - 1, 1024], [1024, PNG.length - 1]]) {
      const source = sourceFor(async () => PNG, content({ info }), channelMaxBytes);
      await assert.rejects(source.load({ maxBytes: hostMaxBytes }), imageError('image-too-large', { stage: 'size' }));
    }
  }
});

test('actual Matrix API too-large errors and compatible limit codes retain their cause and size classification', async () => {
  for (const code of ['too-large', 'image-too-large', 'file-too-large']) {
    const cause = new MatrixApiError('download stream crossed its byte cap', { code });
    await assert.rejects(sourceFor(async () => { throw cause; }).load(),
      imageError('image-too-large', { cause, stage: 'size' }));
  }
});

test('download exceptions are concrete ImagePromptErrors retaining the original cause, not empty successes', async () => {
  const cause = new Error('network disconnected');
  const source = sourceFor(async () => { throw cause; });
  await assert.rejects(source.load(), imageError('image-download-failed', { cause, stage: 'download' }));
});

test('null, unsupported response shapes and empty downloads fail with their diagnostic cause', async () => {
  for (const value of [null, undefined, Buffer.alloc(0), new Uint8Array(0), { data: PNG }]) {
    await assert.rejects(sourceFor(async () => value).load(), (error) => {
      imageError('image-download-failed', { stage: 'download' })(error);
      assert.ok(error.cause instanceof Error);
      assert.match(error.cause.message, /Empty image download/);
      return true;
    });
  }
});

test('an existing ImagePromptError from the download layer is not masked or downgraded', async () => {
  const error = new ImagePromptError('image-too-large', 'already classified', 'original user explanation');
  await assert.rejects(sourceFor(async () => { throw error; }).load(), (actual) => actual === error);
});

test('an already-aborted signal rejects with its exact reason before any network work', async () => {
  const controller = new AbortController();
  const reason = new Error('user cancelled before loading');
  controller.abort(reason);
  let downloads = 0;
  const source = sourceFor(async () => { downloads += 1; return PNG; });
  await assert.rejects(source.load({ signal: controller.signal }), (error) => error === reason);
  assert.equal(downloads, 0);
});

test('abort while downloading preserves the signal reason rather than wrapping it as an image failure', async () => {
  const controller = new AbortController();
  const reason = new Error('user cancelled while loading');
  const networkError = new Error('transport stopped');
  const source = sourceFor(async (_uri, { signal }) => {
    assert.equal(signal, controller.signal);
    controller.abort(reason);
    throw networkError;
  });
  await assert.rejects(source.load({ signal: controller.signal }), (error) => error === reason);
});

test('abort winning the download completion race cannot return successful image bytes', async () => {
  const controller = new AbortController();
  const reason = new Error('cancelled just before bytes became available');
  const source = sourceFor(async () => {
    controller.abort(reason);
    return PNG; // A transport may resolve despite cancellation; the source must recheck.
  });
  await assert.rejects(source.load({ signal: controller.signal }), (error) => error === reason);
});

test('missing or unusual MIME declarations defer to shared byte sniffing instead of rejecting valid images', async () => {
  for (const mimetype of [undefined, '', 'application/octet-stream', 'image/x-unusual', 'text/plain', 'image/jpeg']) {
    let downloads = 0;
    const source = sourceFor(async () => { downloads += 1; return PNG; }, content({
      info: { ...(mimetype === undefined ? {} : { mimetype }) },
    }));
    const [file] = inboundImagesAsFiles([source], { maxImages: 20, maxDownloadBytes: 512 });
    assert.equal(downloads, 0);
    const loaded = await file.load();
    assert.deepEqual(loaded.data, PNG);
    assert.equal(loaded.mediaType, 'image/png', 'actual bytes, not the claimed MIME type, determine the format');
    assert.equal(downloads, 1);
  }
});

test('shared byte sniffing, not the Matrix adapter, rejects non-image bytes', async () => {
  const bytes = Buffer.from('not image data');
  const source = sourceFor(async () => bytes, content({ info: { mimetype: 'image/png' } }));
  assert.deepEqual(await source.load(), bytes, 'the adapter downloads bytes without trusting the MIME label');
  const [file] = inboundImagesAsFiles([source], { maxImages: 20, maxDownloadBytes: 512 });
  await assert.rejects(file.load(), (error) => error instanceof ImagePromptError && error.code === 'unsupported-image-type');
});

test('Matrix encrypted file v2 decrypts AES-256-CTR ciphertext and uses its own mxc reference', async () => {
  const { ciphertext, file } = encryptedFixture();
  assert.notDeepEqual(ciphertext, PNG);
  let downloads = 0;
  const source = sourceFor(async (uri, options) => {
    downloads += 1;
    assert.equal(uri, file.url, 'encrypted file.url takes precedence over a top-level url');
    assert.equal(options.maxBytes, 512);
    return ciphertext;
  }, content({ url: 'mxc://example.org/not-the-encrypted-file', file }));
  assert.equal(downloads, 0);
  const decrypted = await source.load({ maxBytes: 512 });
  assert.ok(Buffer.isBuffer(decrypted));
  assert.deepEqual(decrypted, PNG);
  const [staged] = inboundImagesAsFiles([source], { maxImages: 20, maxDownloadBytes: 512 });
  assert.equal((await staged.load()).mediaType, 'image/png');
});

test('ciphertext tampering and incorrect SHA-256 hashes fail loudly before accepting decrypted bytes', async () => {
  const { ciphertext, file } = encryptedFixture();
  const tampered = Buffer.from(ciphertext);
  tampered[10] ^= 1;
  const cases = [
    [tampered, file],
    [ciphertext, { ...file, hashes: { sha256: Buffer.alloc(32).toString('base64') } }],
    [ciphertext, { ...file, hashes: { sha256: Buffer.alloc(31).toString('base64') } }],
  ];
  for (const [data, descriptor] of cases) {
    await assert.rejects(sourceFor(async () => data, content({ file: descriptor })).load(), (error) => {
      imageError('image-download-failed', { stage: 'decrypt' })(error);
      assert.ok(error.cause instanceof Error);
      assert.match(error.cause.message, /integrity check failed/);
      return true;
    });
  }
});

test('unsupported or malformed encryption descriptors are rejected with a retained decryption cause', async () => {
  const { ciphertext, file } = encryptedFixture();
  const descriptors = [
    { ...file, v: 'v1' }, { ...file, v: undefined },
    { ...file, key: undefined }, { ...file, key: { ...file.key, kty: 'RSA' } },
    { ...file, key: { ...file.key, alg: 'A256GCM' } },
    { ...file, key: { ...file.key, k: undefined } },
    { ...file, key: { ...file.key, k: Buffer.alloc(31).toString('base64url') } },
    { ...file, iv: undefined }, { ...file, iv: Buffer.alloc(15).toString('base64') },
    { ...file, hashes: undefined }, { ...file, hashes: { sha256: undefined } },
    { ...file, hashes: { sha256: 'not-a-sha256-hash' } },
  ];
  for (const descriptor of descriptors) {
    await assert.rejects(sourceFor(async () => ciphertext, content({ file: descriptor })).load(), (error) => {
      imageError('image-download-failed', { stage: 'decrypt' })(error);
      assert.ok(error.cause instanceof Error, 'descriptor errors remain available as the cause');
      assert.match(error.cause.message, /descriptor|integrity check/);
      return true;
    });
  }
});

test('missing, non-string or non-Matrix content references fail without initiating downloads', async () => {
  const invalid = [
    content({ url: undefined }), content({ url: null }), content({ url: '' }),
    content({ url: 123 }), content({ url: 'https://example.org/image.png' }),
    content({ url: 'file:///private/image.png' }), content({ url: 'mxcx://example.org/image' }),
    content({ url: undefined, file: { url: undefined } }),
  ];
  let downloads = 0;
  for (const eventContent of invalid) {
    const source = sourceFor(async () => { downloads += 1; return PNG; }, eventContent);
    await assert.rejects(source.load(), imageError('image-download-failed', { stage: 'download' }));
  }
  assert.equal(downloads, 0);
});
