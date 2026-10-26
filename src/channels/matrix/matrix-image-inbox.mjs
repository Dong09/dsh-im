import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const RECORD_KEYS = new Set(['roomId', 'eventId', 'senderId', 'threadId', 'ts', 'name', 'consumed']);

function identifier(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`Matrix image inbox requires a nonempty ${field}`);
  }
  return value;
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
    roomId: identifier(roomId, 'roomId'),
    eventId: identifier(eventId, 'eventId'),
    senderId: identifier(senderId, 'senderId'),
    threadId: thread(threadId),
    ts: timestamp(ts, 'ts'),
    name,
    consumed: false,
  };
}

function documentEntries(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== 1 || !Array.isArray(value.entries)
    || Object.keys(value).some((key) => key !== 'version' && key !== 'entries')) {
    throw new TypeError('Invalid Matrix image inbox document');
  }
  const seen = new Set();
  return value.entries.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || Object.keys(raw).length !== RECORD_KEYS.size
      || Object.keys(raw).some((key) => !RECORD_KEYS.has(key))
      || typeof raw.consumed !== 'boolean') {
      throw new TypeError('Invalid Matrix image inbox record');
    }
    const entry = { ...recordValue(raw), consumed: raw.consumed };
    const key = JSON.stringify([entry.roomId, entry.eventId]);
    if (seen.has(key)) throw new TypeError('Duplicate Matrix image inbox room/event reference');
    seen.add(key);
    return entry;
  });
}

/**
 * Reference-only, single-owner Matrix image inbox. Call load() at startup.
 *
 * Retention is GLOBAL: only the latest `limit` arrivals across all rooms survive,
 * including consumed entries. Replays neither update metadata nor move an entry.
 * Array order is arrival order, independent of event timestamps and filesystem
 * clocks. get() deliberately includes consumed entries for explicit replies.
 *
 * All disk operations are serialized. Mutations use copy-on-write and become
 * visible only after the sibling-temp-file atomic rename succeeds. This is not
 * an interprocess lock: one live store must own each path. No credentials, media
 * downloads, or Matrix APIs are used here.
 */
export class MatrixImageInboxStore {
  #path;
  #limit;
  #entries = [];
  #queue = Promise.resolve();
  #failure = null;

  constructor(path, { limit = 2000 } = {}) {
    identifier(path, 'file path');
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new TypeError('Matrix image inbox limit must be a positive safe integer');
    }
    this.#path = path;
    this.#limit = limit;
  }

  #enqueue(task) {
    const operation = this.#queue.then(task);
    // Recover the sequencing tail, not the caller's promise. Remember failures
    // until flush() reports them, even if subsequent operations succeed.
    this.#queue = operation.then(() => undefined, (error) => {
      this.#failure ??= error;
    });
    return operation;
  }

  async #persist(entries) {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, {
        encoding: 'utf8', mode: 0o600, flag: 'wx',
      });
      await rename(temporary, this.#path);
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
    return this.#enqueue(async () => {
      let text;
      try {
        text = await readFile(this.#path, 'utf8');
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        this.#entries = [];
        return this;
      }
      const entries = documentEntries(JSON.parse(text));
      const retained = entries.slice(-this.#limit);
      if (entries.length > this.#limit) await this.#persist(retained);
      this.#entries = retained;
      return this;
    });
  }

  /** Await durable recording; duplicates return the original retained record. */
  async record(value) {
    const entry = recordValue(value);
    return this.#enqueue(async () => {
      const existing = this.#entries.find((candidate) => (
        candidate.roomId === entry.roomId && candidate.eventId === entry.eventId
      ));
      if (existing) return { ...existing };
      const next = [...this.#entries, entry].slice(-this.#limit);
      await this.#persist(next);
      this.#entries = next;
      return { ...entry };
    });
  }

  get({ roomId, eventId } = {}) {
    identifier(roomId, 'roomId');
    identifier(eventId, 'eventId');
    const entry = this.#entries.find((candidate) => candidate.roomId === roomId && candidate.eventId === eventId);
    return entry ? { ...entry } : null;
  }

  /** Pure query: inclusive time window, exact room/sender/thread, arrival order. */
  pending({ roomId, senderId, threadId = null, beforeTs = Infinity, sinceTs = 0 } = {}) {
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

  /** Call only after successful processing. Returns the newly consumed count. */
  async markConsumed({ roomId, eventIds } = {}) {
    identifier(roomId, 'roomId');
    if (!Array.isArray(eventIds)) throw new TypeError('Matrix image inbox requires an eventIds array');
    const ids = new Set(eventIds.map((eventId) => identifier(eventId, 'eventId')));
    return this.#enqueue(async () => {
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

  /** Barrier for queued operations; reports the first failure since last flush. */
  async flush() {
    await this.#queue;
    if (this.#failure !== null) {
      const error = this.#failure;
      this.#failure = null;
      throw error;
    }
  }
}
