import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';

import { ImagePromptError } from '../shared/image-prompt.mjs';
import { t } from '../shared/i18n.mjs';

/** A failed image stops the whole submission; the model must not infer missing image contents. */
export function matrixImageFailure(name, stage, cause) {
  const file = typeof name === 'string' && name.trim() ? name.trim().slice(0, 160) : 'image';
  const userMessage = stage === 'event'
    ? t('无法读取引用的图片消息「{name}」，本次未提交图片分析。请回复原图并重新 @，或重新发送图片。', { name: file })
    : stage === 'decrypt'
      ? t('图片「{name}」解密或完整性校验失败，本次未提交图片分析。请重新发送图片后再 @。', { name: file })
      : stage === 'size'
        ? t('图片「{name}」超过接收大小上限，本次未提交图片分析。请压缩图片后重发，或调整附件大小上限。', { name: file })
        : t('图片「{name}」下载失败或内容不可用，本次未提交图片分析。请稍后重新 @ 重试，或重新发送图片。', { name: file });
  return new ImagePromptError(stage === 'size' ? 'image-too-large' : 'image-download-failed',
    `Matrix image ${stage} failed`, userMessage, { cause });
}

function decryptImage(data, file) {
  if (file?.v !== 'v2' || file?.key?.kty !== 'oct' || file?.key?.alg !== 'A256CTR'
    || typeof file.key.k !== 'string' || typeof file.iv !== 'string'
    || typeof file.hashes?.sha256 !== 'string'
    || !/^[A-Za-z0-9_-]+={0,2}$/.test(file.key.k)
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(file.iv)
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(file.hashes.sha256)) throw new Error('Invalid Matrix encrypted file descriptor');
  const key = Buffer.from(file.key.k, 'base64url');
  const iv = Buffer.from(file.iv, 'base64');
  const expected = Buffer.from(file.hashes.sha256, 'base64');
  const actual = createHash('sha256').update(data).digest();
  if (key.length !== 32 || iv.length !== 16 || expected.length !== actual.length
    || !timingSafeEqual(expected, actual)) throw new Error('Matrix encrypted image integrity check failed');
  const decipher = createDecipheriv('aes-256-ctr', key, iv);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

/** Download on demand only, enforce both channel and host byte caps, and authenticate encrypted media. */
export function createMatrixImageSource(api, content, { maxBytes }) {
  const name = typeof content?.body === 'string' ? content.body : 'image';
  return {
    name,
    ...(typeof content?.info?.size === 'number' ? { size: content.info.size } : {}),
    async load({ signal, maxBytes: hostMaxBytes } = {}) {
      signal?.throwIfAborted();
      const limit = Number.isSafeInteger(hostMaxBytes) && hostMaxBytes > 0
        ? Math.min(maxBytes, hostMaxBytes) : maxBytes;
      if (Number.isFinite(content?.info?.size) && content.info.size > limit) {
        throw matrixImageFailure(name, 'size');
      }
      const file = content?.file;
      const uri = file?.url ?? content?.url;
      if (typeof uri !== 'string' || !uri.startsWith('mxc://')) throw matrixImageFailure(name, 'download');
      let data;
      try {
        const loaded = await api.downloadContent(uri, { signal, maxBytes: limit });
        signal?.throwIfAborted();
        data = loaded instanceof Uint8Array ? Buffer.from(loaded) : null;
        if (!data?.length) throw new Error('Empty image download');
        if (data.length > limit) throw matrixImageFailure(name, 'size');
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        if (error instanceof ImagePromptError) throw error;
        throw matrixImageFailure(name, ['image-too-large', 'file-too-large', 'too-large'].includes(error?.code) ? 'size' : 'download', error);
      }
      if (file) {
        try { data = decryptImage(data, file); }
        catch (error) { throw matrixImageFailure(name, 'decrypt', error); }
      }
      return data;
    },
  };
}
