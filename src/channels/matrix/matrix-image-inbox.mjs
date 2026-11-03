import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const RECORD_KEYS = ['roomId', 'eventId', 'senderId', 'threadId', 'ts', 'name', 'consumed'];
const identity = ({ roomId, eventId }) => JSON.stringify([roomId, eventId]);

function identifier(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`Matrix image inbox requires a nonempty ${field}`);
  }
  return value;
}

function targetValue({ roomId, eventId } = {}) {
  return { roomId: identifier(roomId, 'roomId'), eventId: identifier(eventId, 'eventId') };
}

function thread(value) {
  return value === null ? null : identifier(value, 'threadId');
}

function timestamp(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Matrix image inbox requires a nonnegative integer ${field}`);
  }
  return value;
}

function recordValue({ roomId, eventId, senderId, threadId = null, ts, name = '' } = {}) {
  if (typeof name !== 'string') throw new TypeError('Matrix image inbox requires a string name');
  // Explicit allowlist: never copy event content, downloaded bytes or encryption keys.
  return {
    ...targetValue({ roomId, eventId }),
    senderId: identifier(senderId, 'senderId'),
    threadId: thread(threadId),
    ts: timestamp(ts, 'ts'),
    name,
    consumed: false,
    invalidated: false,
  };
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key));
}

function unique(values, convert) {
  const seen = new Set();
  return values.map((raw) => {
    const value = convert(raw);
    const key = identity(value);
    if (seen.has(key)) throw new TypeError('Duplicate Matrix image inbox room/event reference');
    seen.add(key);
    return value;
  });
}

function documentValue(value) {
  const legacy = value?.version === 1;
  if (!exactKeys(value, legacy ? ['version', 'entries'] : ['version', 'entries', 'tombstones'])
    || (!legacy && value.version !== 2) || !Array.isArray(value.entries)
    || (!legacy && !Array.isArray(value.tombstones))) {
    throw new TypeError('Invalid Matrix image inbox document');
  }
  const entries = unique(value.entries, (raw) => {
    if (!exactKeys(raw, legacy ? RECORD_KEYS : [...RECORD_KEYS, 'invalidated'])
      || typeof raw.consumed !== 'boolean' || (!legacy && typeof raw.invalidated !== 'boolean')) {
      throw new TypeError('Invalid Matrix image inbox record');
    }
    return { ...recordValue(raw), consumed: raw.consumed, invalidated: legacy ? false : raw.invalidated };
  });
  const tombstones = legacy ? [] : unique(value.tombstones, (raw) => {
    if (!exactKeys(raw, ['roomId', 'eventId'])) throw new TypeError('Invalid Matrix image inbox tombstone');
    return targetValue(raw);
  });
  // A retained tombstone is affirmative evidence even for an externally written
  // document whose corresponding entry has not yet been marked invalidated.
  const invalidated = new Set(tombstones.map(identity));
  return { entries: entries.map((entry) => invalidated.has(identity(entry))
    ? { ...entry, invalidated: true } : entry), tombstones, legacy };
}

/**
 * Reference-only, single-owner store. Call load() at startup. Entries and unknown
 * target tombstones have independent global FIFO bounds (both default to 2000).
 * Replays do not refresh arrival order. Consumption and invalidation are orthogonal.
 * get() includes both states; candidates() includes unconsumed invalidated entries.
 *
 * Writes are serial, copy-on-write, visible only after atomic sibling-temp rename.
 * No interprocess locking: one live writer owns each path. Before the first v2
 * mutation, exact v1 bytes are preserved at `${path}.v1.bak`. Downgrade requires
 * stopping the writer and manually restoring that backup, losing later progress.
 */
export class MatrixImageInboxStore {
  #path;
  #limit;
  #tombstoneLimit;
  #entries = [];
  #tombstones = [];
  #legacyBytes = null;
  #queue = Promise.resolve();
  #failure = null;
  #unrepaired = new Map();

  constructor(path, { limit = 2000, tombstoneLimit = limit } = {}) {
    identifier(path, 'file path');
    for (const [name, value] of Object.entries({ limit, tombstoneLimit })) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new TypeError(`Matrix image inbox ${name} must be a positive safe integer`);
      }
    }
    this.#path = path;
    this.#limit = limit;
    this.#tombstoneLimit = tombstoneLimit;
  }

  #enqueue(key, task, signal) {
    const operation = this.#queue.then(task);
    // The sequencing tail always recovers. A failed target stays unsafe until
    // that exact operation succeeds; unrelated writes and flush cannot repair it.
    this.#queue = operation.then(() => {
      this.#unrepaired.delete(key);
    }, (error) => {
      this.#failure ??= error;
      if (!signal?.aborted) this.#unrepaired.set(key, error);
    });
    return operation;
  }

  async #backupLegacy() {
    if (this.#legacyBytes === null) return;
    const backup = `${this.#path}.v1.bak`;
    try {
      await writeFile(backup, this.#legacyBytes, { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = await readFile(backup);
      if (!existing.equals(this.#legacyBytes)) {
        throw new Error('Matrix image inbox legacy backup differs from loaded version 1 bytes');
      }
    }
  }

  async #persist(entries, tombstones = this.#tombstones, signal) {
    signal?.throwIfAborted();
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    await this.#backupLegacy();
    signal?.throwIfAborted();
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify({ version: 2, entries, tombstones }, null, 2)}\n`, {
        encoding: 'utf8', mode: 0o600, flag: 'wx', signal,
      });
      // Cancellation before the commit boundary must not create permanent state.
      signal?.throwIfAborted();
      await rename(temporary, this.#path);
      this.#legacyBytes = null;
    } catch (error) {
      try {
        await unlink(temporary);
      } catch (cleanupError) {
        if (cleanupError?.code !== 'ENOENT') {
          throw new AggregateError([error, cleanupError], 'Matrix image inbox write and temporary cleanup failed');
        }
      }
      throw error;
    }
  }

  async load() {
    return this.#enqueue('load', async () => {
      let bytes;
      try {
        bytes = await readFile(this.#path);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        this.#entries = [];
        this.#tombstones = [];
        this.#legacyBytes = null;
        return this;
      }
      const document = documentValue(JSON.parse(bytes.toString('utf8')));
      const entries = document.entries.slice(-this.#limit);
      const tombstones = document.tombstones.slice(-this.#tombstoneLimit);
      const previousLegacy = this.#legacyBytes;
      this.#legacyBytes = document.legacy ? bytes : null;
      try {
        if (document.entries.length > entries.length || document.tombstones.length > tombstones.length) {
          await this.#persist(entries, tombstones);
        }
      } catch (error) {
        this.#legacyBytes = previousLegacy;
        throw error;
      }
      this.#entries = entries;
      this.#tombstones = tombstones;
      return this;
    });
  }

  /** Await durable recording; duplicates return the original retained record. */
  async record(value) {
    const entry = recordValue(value);
    return this.#enqueue(`record:${identity(entry)}`, async () => {
      const existing = this.get(entry);
      if (existing) return existing;
      entry.invalidated = this.isInvalidated(entry);
      const next = [...this.#entries, entry].slice(-this.#limit);
      await this.#persist(next);
      this.#entries = next;
      return { ...entry };
    });
  }

  get(value) {
    const { roomId, eventId } = targetValue(value);
    const entry = this.#entries.find((candidate) => candidate.roomId === roomId && candidate.eventId === eventId);
    return entry ? { ...entry } : null;
  }

  isInvalidated(value) {
    const target = targetValue(value);
    return this.get(target)?.invalidated === true
      || this.#tombstones.some((candidate) => identity(candidate) === identity(target));
  }

  /** Pure scoped query, inclusive window and arrival order; excludes consumed only. */
  candidates({ roomId, senderId, threadId = null, beforeTs = Infinity, sinceTs = 0 } = {}) {
    identifier(roomId, 'roomId');
    identifier(senderId, 'senderId');
    thread(threadId);
    if (beforeTs !== Infinity) timestamp(beforeTs, 'beforeTs');
    timestamp(sinceTs, 'sinceTs');
    return this.#entries.filter((entry) => (
      !entry.consumed && entry.roomId === roomId && entry.senderId === senderId
      && entry.threadId === threadId && entry.ts >= sinceTs && entry.ts <= beforeTs
    )).map((entry) => ({ ...entry }));
  }

  pending(query) {
    return this.candidates(query).filter((entry) => !entry.invalidated);
  }

  /** Returns true only when new invalidation state was durably committed. */
  async invalidate(value, { signal } = {}) {
    const target = targetValue(value);
    return this.#enqueue(`invalidate:${identity(target)}`, async () => {
      signal?.throwIfAborted();
      if (this.isInvalidated(target)) return false;
      const existing = this.get(target);
      const entries = this.#entries.map((entry) => identity(entry) === identity(target)
        ? { ...entry, invalidated: true } : entry);
      const tombstones = existing ? this.#tombstones
        : [...this.#tombstones, target].slice(-this.#tombstoneLimit);
      await this.#persist(entries, tombstones, signal);
      this.#entries = entries;
      this.#tombstones = tombstones;
      return true;
    }, signal);
  }

  /** Call only after successful processing. Returns the newly consumed count. */
  async markConsumed({ roomId, eventIds } = {}) {
    identifier(roomId, 'roomId');
    if (!Array.isArray(eventIds)) throw new TypeError('Matrix image inbox requires an eventIds array');
    const ids = new Set(eventIds.map((eventId) => identifier(eventId, 'eventId')));
    return this.#enqueue(`consume:${JSON.stringify([roomId, [...ids].sort()])}`, async () => {
      let marked = 0;
      const next = this.#entries.map((entry) => {
        if (entry.roomId !== roomId || entry.consumed || !ids.has(entry.eventId)) return entry;
        marked += 1;
        return { ...entry, consumed: true };
      });
      if (marked > 0) {
        await this.#persist(next);
        this.#entries = next;
      }
      return marked;
    });
  }

  /** Wait for queued work; failures remain until the same operation is repaired. */
  async barrier() {
    await this.#queue;
    if (this.#unrepaired.size) throw this.#unrepaired.values().next().value;
  }

  /** Legacy report-and-clear diagnostic; never acknowledges barrier failures. */
  async flush() {
    await this.#queue;
    if (this.#failure !== null) {
      const error = this.#failure;
      this.#failure = null;
      throw error;
    }
  }
}
