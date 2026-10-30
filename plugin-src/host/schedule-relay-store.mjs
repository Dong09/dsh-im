import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isMatrixEventId, isMatrixRoomTargetId } from '../../src/channels/matrix/matrix-identifiers.mjs';

const STATUSES = new Set(['sending', 'sent', 'failed', 'unknown']);
const PART_STATUSES = new Set(['pending', ...STATUSES, 'skipped']);
const string = (value) => typeof value === 'string' && value.length > 0 && value.trim() === value;
const failure = (code) => Object.assign(new Error(code), { code });
const safeError = (value) => typeof value === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(value);

/** Validate and copy the Matrix destinations accepted by this plugin. */
export function destination(value) {
  if (!string(value?.botId) || !['room', 'thread'].includes(value.kind)
    || !isMatrixRoomTargetId(value.route?.roomId)
    || (value.kind === 'thread' && !isMatrixEventId(value.route.threadId))) {
    throw failure('invalid-destination');
  }
  return { botId: value.botId, kind: value.kind, route: {
    roomId: value.route.roomId,
    ...(value.kind === 'thread' ? { threadId: value.route.threadId } : {}),
  } };
}

export const destinationIdentity = (value) => JSON.stringify(destination(value));

/** Unknown dispatch wins over definite failure; notices are never required parts. */
export function aggregateRelayParts(parts) {
  if (parts.some((part) => ['sending', 'unknown'].includes(part.status))) return 'unknown';
  return parts.length > 0 && parts.every((part) => part.status === 'sent') ? 'sent' : 'failed';
}

function manifestPart(value) {
  if (!string(value?.id) || !['text', 'artifact'].includes(value.kind)
    || (value.kind === 'text' && value.id !== 'text')) throw failure('invalid-part-manifest');
  if (value.kind === 'text') return { id: 'text', kind: 'text' };
  if (!string(value.artifactId) || value.id !== `artifact:${value.artifactId}`
    || !string(value.fileName) || /[\\/\u0000-\u001f]/u.test(value.fileName)
    || !string(value.mediaType) || !Number.isSafeInteger(value.size) || value.size < 0
    || !/^[a-f0-9]{64}$/.test(value.digest ?? '')) throw failure('invalid-part-manifest');
  return { id: value.id, kind: 'artifact', artifactId: value.artifactId,
    fileName: value.fileName, mediaType: value.mediaType, size: value.size, digest: value.digest };
}

function receiptFields(value) {
  const result = {};
  if (value.error !== undefined) {
    if (!safeError(value.error)) throw failure('invalid-delivery-result');
    result.error = value.error;
  }
  if (value.providerMessageIds !== undefined) {
    if (!Array.isArray(value.providerMessageIds) || !value.providerMessageIds.every(isMatrixEventId)) {
      throw failure('invalid-delivery-result');
    }
    result.providerMessageIds = [...new Set(value.providerMessageIds)];
  }
  if (value.notice !== undefined) {
    if (!['sent', 'failed', 'unknown'].includes(value.notice?.status)) throw failure('invalid-delivery-result');
    result.notice = { status: value.notice.status, ...receiptFields({
      ...(value.notice.error === undefined ? {} : { error: value.notice.error }),
      ...(value.notice.providerMessageIds === undefined ? {} : { providerMessageIds: value.notice.providerMessageIds }),
    }) };
  }
  return result;
}

function readAttempt(value, version, sessionId) {
  if (!Number.isSafeInteger(value?.turn) || value.turn < 0 || !STATUSES.has(value.status)
    || (value.error !== undefined && !(version === 1 || value.legacy === true ? string(value.error) : safeError(value.error)))) throw failure('invalid-relay-state');
  if (version === 1) return { turn: value.turn, status: value.status,
    attemptId: `legacy:${sessionId}:${value.turn}`, legacy: true, parts: [],
    ...(value.error ? { error: value.error } : {}) };
  if (!string(value.attemptId) || !Array.isArray(value.parts)
    || (value.legacy !== undefined && value.legacy !== true)
    || (value.legacy === true ? value.parts.length !== 0 : value.parts.length === 0)) throw failure('invalid-relay-state');
  const ids = new Set();
  const parts = value.parts.map((part) => {
    const manifest = manifestPart(part);
    if (ids.has(manifest.id) || !PART_STATUSES.has(part.status)) throw failure('invalid-relay-state');
    ids.add(manifest.id);
    const fields = receiptFields(part);
    if (part.status === 'sent' && !fields.providerMessageIds?.length) throw failure('invalid-relay-state');
    return { ...manifest, status: part.status, ...fields };
  });
  if (value.status === 'sent' && value.legacy !== true && aggregateRelayParts(parts) !== 'sent') {
    throw failure('invalid-relay-state');
  }
  return { turn: value.turn, attemptId: value.attemptId, status: value.status, parts,
    ...(value.legacy ? { legacy: true } : {}), ...(value.error ? { error: value.error } : {}) };
}

/**
 * Atomic v2 routes and immutable attempt manifests. v1 is read without replay,
 * backed up byte-for-byte before the first v2 commit. Snapshots are never restored.
 * A rejected write does not publish its candidate records to readers.
 */
export class RelayStore {
  #records;
  #path;
  #legacySource;
  #tail = Promise.resolve();
  #closed = false;

  constructor(path, records, legacySource) {
    this.#path = path; this.#records = records; this.#legacySource = legacySource;
  }

  /** Corruption, duplicates and future versions reject; they are never an empty database. */
  static async open(path) {
    let source;
    try { source = await readFile(path, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return new RelayStore(path, new Map());
      throw error;
    }
    const document = JSON.parse(source);
    if (![1, 2].includes(document?.version) || !Array.isArray(document.sessions)) throw failure('invalid-relay-state');
    const records = new Map();
    for (const entry of document.sessions) {
      if (!string(entry?.sessionId) || records.has(entry.sessionId) || typeof entry.conflict !== 'boolean') {
        throw failure('invalid-relay-state');
      }
      const record = { sessionId: entry.sessionId, destination: destination(entry.destination), conflict: entry.conflict };
      if (entry.lastAttempt !== undefined) record.lastAttempt = readAttempt(entry.lastAttempt, document.version, entry.sessionId);
      records.set(entry.sessionId, record);
    }
    return new RelayStore(path, records, document.version === 1 ? source : undefined);
  }

  get(sessionId) { return structuredClone(this.#records.get(sessionId) ?? null); }

  async #write(records) {
    await mkdir(dirname(this.#path), { recursive: true });
    if (this.#legacySource !== undefined) {
      const backup = `${this.#path}.v1.bak`;
      try { await copyFile(this.#path, backup, constants.COPYFILE_EXCL); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      if (await readFile(backup, 'utf8') !== this.#legacySource) throw failure('relay-backup-conflict');
    }
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify({ version: 2, sessions: [...records.values()] }, null, 2)}\n`, {
        encoding: 'utf8', mode: 0o600, flag: 'wx',
      });
      await rename(temporary, this.#path);
      this.#legacySource = undefined;
    } finally {
      try { await unlink(temporary); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }

  #change(operation) {
    if (this.#closed) return Promise.reject(failure('relay-store-closed'));
    const work = this.#tail.then(async () => {
      const records = structuredClone(this.#records);
      const { changed, value } = operation(records);
      if (changed) { await this.#write(records); this.#records = records; }
      return structuredClone(value);
    });
    // Callers receive failures; independent later operations may still settle.
    this.#tail = work.catch((error) => { void error; });
    return work;
  }

  remember(sessionId, candidates) {
    if (!string(sessionId)) return Promise.reject(failure('invalid-session'));
    const unique = new Map(candidates.map((candidate) => [destinationIdentity(candidate), destination(candidate)]));
    return this.#change((records) => {
      const existing = records.get(sessionId);
      if (unique.size === 0) return { changed: false, value: existing ?? null };
      if (existing) unique.set(destinationIdentity(existing.destination), existing.destination);
      const conflict = existing?.conflict === true || unique.size > 1;
      if (existing && existing.conflict === conflict) return { changed: false, value: existing };
      const record = existing ? { ...existing, conflict } : { sessionId, destination: [...unique.values()][0], conflict };
      records.set(sessionId, record);
      return { changed: true, value: record };
    });
  }

  /** Persist the entire intent before any provider side effect; high water never decreases. */
  attempt(sessionId, turn, manifest = [{ id: 'text', kind: 'text' }], { expectedDestination } = {}) {
    if (!Number.isSafeInteger(turn) || turn < 0) return Promise.reject(failure('invalid-turn'));
    const parts = manifest.map(manifestPart);
    if (!parts.length || new Set(parts.map((part) => part.id)).size !== parts.length) return Promise.reject(failure('invalid-part-manifest'));
    return this.#change((records) => {
      const record = records.get(sessionId);
      if (!record || record.conflict || (record.lastAttempt && record.lastAttempt.turn >= turn)) return { changed: false, value: null };
      if (expectedDestination && destinationIdentity(expectedDestination) !== destinationIdentity(record.destination)) throw failure('delivery-destination-changed');
      record.lastAttempt = { turn, attemptId: randomUUID(), status: 'sending', parts: parts.map((part) => ({ ...part, status: 'pending' })) };
      return { changed: true, value: { ...record.lastAttempt, destination: record.destination } };
    });
  }

  #part(records, sessionId, turn, attemptId, partId) {
    const attempt = records.get(sessionId)?.lastAttempt;
    if (attempt?.turn !== turn || attempt.attemptId !== attemptId || attempt.legacy) throw failure('delivery-checkpoint-changed');
    const part = attempt.parts.find((entry) => entry.id === partId);
    if (!part) throw failure('delivery-checkpoint-changed');
    return { attempt, part };
  }

  /** Only pending -> sending may precede a platform request. */
  startPart(sessionId, turn, attemptId, partId) {
    return this.#change((records) => {
      const { attempt, part } = this.#part(records, sessionId, turn, attemptId, partId);
      if (part.status !== 'pending') throw failure('delivery-part-already-attempted');
      part.status = 'sending';
      attempt.status = 'sending';
      return { changed: true, value: part };
    });
  }

  /** Checkpoint a provider result outside its send/fallback closures. */
  finishPart(sessionId, turn, attemptId, partId, result) {
    if (!['sent', 'failed', 'unknown'].includes(result?.status)) return Promise.reject(failure('invalid-delivery-status'));
    const fields = receiptFields(result);
    if (result.status === 'sent' && !fields.providerMessageIds?.length) return Promise.reject(failure('invalid-delivery-result'));
    return this.#change((records) => {
      const { attempt, part } = this.#part(records, sessionId, turn, attemptId, partId);
      if (part.status !== 'sending') throw failure('delivery-part-not-sending');
      Object.assign(part, { status: result.status, ...fields });
      attempt.status = aggregateRelayParts(attempt.parts);
      return { changed: true, value: attempt };
    });
  }

  skipPending(sessionId, turn, attemptId, error = 'cancelled') {
    if (!safeError(error)) return Promise.reject(failure('invalid-delivery-result'));
    return this.#change((records) => {
      const attempt = records.get(sessionId)?.lastAttempt;
      if (attempt?.turn !== turn || attempt.attemptId !== attemptId) throw failure('delivery-checkpoint-changed');
      for (const part of attempt.parts) if (part.status === 'pending') Object.assign(part, { status: 'skipped', error });
      attempt.status = aggregateRelayParts(attempt.parts);
      return { changed: true, value: attempt };
    });
  }

  /** Legacy text-only callers cannot overwrite an unrelated newer attempt. */
  finish(sessionId, turn, status, error) {
    if (!['sent', 'failed', 'unknown'].includes(status) || (error !== undefined && !safeError(error))) return Promise.reject(failure('invalid-delivery-status'));
    return this.#change((records) => {
      const record = records.get(sessionId);
      if (record?.lastAttempt?.turn !== turn || !record.lastAttempt.legacy) throw failure('delivery-checkpoint-changed');
      Object.assign(record.lastAttempt, { status, ...(error ? { error } : {}) });
      return { changed: true, value: record };
    });
  }

  async close() { this.#closed = true; await this.#tail; }
}
