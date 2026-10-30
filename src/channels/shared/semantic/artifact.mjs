import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, open, realpath, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';

export const OUTBOUND_ARTIFACT_TOOL = 'dsh_im_return_file';

const ARTIFACT_KIND = 'dsh-im-outbound-artifact';
const ARTIFACT_READ_CHUNK_BYTES = 64 * 1024;
const MIME_BY_EXTENSION = new Map([
  ['.csv', 'text/csv'],
  ['.doc', 'application/msword'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.json', 'application/json'],
  ['.md', 'text/markdown'],
  ['.pdf', 'application/pdf'],
  ['.png', 'image/png'],
  ['.rar', 'application/vnd.rar'],
  ['.txt', 'text/plain'],
  ['.webp', 'image/webp'],
  ['.xls', 'application/vnd.ms-excel'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.xml', 'application/xml'],
  ['.zip', 'application/zip'],
]);

const artifactStorage = new WeakMap();
const materializedArtifactSources = new WeakMap();
const artifactProviderSettlements = new WeakMap();
let managedSnapshotDirectoryPromise;

function managedSnapshotDirectory() {
  managedSnapshotDirectoryPromise ??= mkdtemp(join(tmpdir(), 'dsh-im-outbound-')).catch((error) => {
    managedSnapshotDirectoryPromise = undefined;
    throw error;
  });
  return managedSnapshotDirectoryPromise;
}

function artifactError(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function currentTurn(agent) {
  const events = typeof agent?.session?.snapshotEvents === 'function'
    ? agent.session.snapshotEvents()
    : agent?.session?.events;
  if (!Array.isArray(events)) return null;
  let turn = null;
  for (const event of events) {
    if (event?.type === 'turn/start') {
      turn = Number.isInteger(event.data?.turn) ? event.data.turn : null;
    } else if (event?.type === 'turn/end' && event.data?.turn === turn) {
      turn = null;
    }
  }
  return Number.isInteger(turn) && turn >= 0 ? turn : null;
}

function sessionIdOf(session) {
  const sessionId = session?.id ?? session?.header?.id;
  return typeof sessionId === 'string' && sessionId ? sessionId : null;
}

function turnKey(sessionId, turn) {
  return `${sessionId}\u0000${turn}`;
}

function promptKey(sessionId, promptRpcId) {
  return `${sessionId}\u0000${promptRpcId}`;
}

function safeFileName(value) {
  const cleaned = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\p{Cf}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return 'result.bin';
  return [...cleaned].slice(0, 255).join('');
}

function mediaTypeFor(name) {
  return MIME_BY_EXTENSION.get(extname(name).toLowerCase()) ?? 'application/octet-stream';
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sameIdentity(left, right) {
  return typeof left?.dev === 'bigint'
    && typeof left?.ino === 'bigint'
    && typeof left?.size === 'bigint'
    && typeof left?.mtimeNs === 'bigint'
    && typeof left?.ctimeNs === 'bigint'
    && left.dev === right?.dev
    && left.ino === right?.ino
    && left.size === right?.size
    && left.mtimeNs === right?.mtimeNs
    && left.ctimeNs === right?.ctimeNs;
}

async function hashFile(path, signal) {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY);
    const hash = createHash('sha256');
    const stream = handle.createReadStream({
      autoClose: false,
      highWaterMark: ARTIFACT_READ_CHUNK_BYTES,
      ...(signal ? { signal } : {}),
    });
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      hash.update(chunk);
    }
    return hash.digest('hex');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Read exactly the observed file size and prove EOF. No project-level size or time limit applies. */
export async function readExactArtifactFile(handle, expectedSize, {
  signal,
  errorCode = 'artifact-changed',
  errorMessage = 'The result file changed while it was being read.',
} = {}) {
  const changed = () => artifactError(errorCode, errorMessage);
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) throw changed();
  signal?.throwIfAborted();

  let bytes;
  try {
    bytes = Buffer.allocUnsafe(expectedSize);
  } catch {
    throw changed();
  }

  if (typeof handle?.createReadStream === 'function') {
    const stream = handle.createReadStream({
      autoClose: false,
      start: 0,
      // Node's end offset is inclusive, so this reads one byte beyond the
      // observed size when the file grows and catches the change.
      end: expectedSize,
      highWaterMark: ARTIFACT_READ_CHUNK_BYTES,
      ...(signal ? { signal } : {}),
    });
    let offset = 0;
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (offset + part.length > expectedSize) throw changed();
      part.copy(bytes, offset);
      offset += part.length;
    }
    if (offset !== expectedSize) throw changed();
    return bytes;
  }

  let offset = 0;
  while (offset < expectedSize) {
    signal?.throwIfAborted();
    const length = Math.min(ARTIFACT_READ_CHUNK_BYTES, expectedSize - offset);
    const result = await handle.read(bytes, offset, length, offset);
    const bytesRead = Number(result?.bytesRead ?? 0);
    if (!Number.isInteger(bytesRead) || bytesRead <= 0 || bytesRead > length) throw changed();
    offset += bytesRead;
  }
  signal?.throwIfAborted();
  const probe = Buffer.allocUnsafe(1);
  if ((await handle.read(probe, 0, 1, expectedSize))?.bytesRead !== 0) throw changed();
  return bytes;
}

async function snapshotFile(workspace, requestedPath, signal) {
  signal?.throwIfAborted();
  let storagePath;
  try {
    const candidate = isAbsolute(requestedPath)
      ? requestedPath
      : resolve(workspace, requestedPath);
    const canonicalPath = await realpath(candidate);
    const source = await lstat(canonicalPath, { bigint: true });
    if (!source.isFile()) {
      throw artifactError('artifact-not-file', 'The requested path is not a file.');
    }

    const directory = await managedSnapshotDirectory();
    storagePath = join(directory, `${randomUUID()}.artifact`);
    try {
      await copyFile(canonicalPath, storagePath, fsConstants.COPYFILE_EXCL);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      signal?.throwIfAborted();
      // System temp cleanup can remove the cached directory between sends.
      // Recreate it with mkdtemp's private permissions and retry only once.
      await mkdir(directory, { recursive: true, mode: 0o700 });
      signal?.throwIfAborted();
      await copyFile(canonicalPath, storagePath, fsConstants.COPYFILE_EXCL);
    }
    signal?.throwIfAborted();

    const snapshot = await lstat(storagePath, { bigint: true });
    const size = Number(snapshot.size);
    if (!snapshot.isFile() || !Number.isSafeInteger(size) || size < 0) {
      throw artifactError('artifact-unavailable', 'The file could not be prepared for delivery.');
    }
    const fileName = safeFileName(basename(candidate));
    return Object.freeze({
      fileName,
      mediaType: mediaTypeFor(fileName),
      size,
      digest: await hashFile(storagePath, signal),
      storagePath,
    });
  } catch (error) {
    if (storagePath) await unlink(storagePath).catch(() => undefined);
    if (error?.code?.startsWith?.('artifact-')) throw error;
    if (signal?.aborted) throw signal.reason ?? error;
    throw artifactError('artifact-unavailable', 'The requested file is unavailable.', error);
  }
}

function publicArtifact(artifact) {
  return Object.freeze({
    artifactId: artifact.artifactId,
    fileName: artifact.fileName,
    size: artifact.size,
  });
}

function artifactKey(artifact) {
  return artifact.artifactId;
}

function cleanupArtifactStorage(artifact) {
  const storage = artifactStorage.get(artifact);
  if (!storage) return;
  storage.releaseRequested = true;
  if (storage.materializing > 0) {
    storage.cleanupRequested = true;
    return;
  }
  const pending = [...artifactProviderSettlements.get(artifact) ?? []];
  if (pending.length > 0) {
    if (!storage.cleanupDeferred) {
      storage.cleanupDeferred = true;
      void Promise.allSettled(pending).finally(() => {
        storage.cleanupDeferred = false;
        cleanupArtifactStorage(artifact);
      });
    }
    return;
  }
  artifactStorage.delete(artifact);
  artifactProviderSettlements.delete(artifact);
  storage.onCleanup?.();
  void unlink(storage.path).catch(() => undefined);
}

/** Only the original, still-live managed snapshot is an internal delivery capability. */
export function isManagedOutboundArtifact(value) {
  const storage = artifactStorage.get(value);
  return Boolean(storage && !storage.releaseRequested);
}

/**
 * Holds two-phase tool results for their exact in-process delivery owner.
 * RPC consumers bind only when their queued request is actually claimed. A
 * trusted scheduled relay may instead open an observed Turn lease, without
 * inventing an RPC source. Neither API decides which files a user may send.
 */
export class OutboundArtifactRegistry {
  // All file collections and cancellation listeners are keyed by owner identity,
  // not just Session/Turn: an old owner's late cleanup cannot touch its successor.
  #turns = new Map();
  #stagedTurns = new Map();
  #claimedTurns = new Map();
  #claimSignals = new Map();
  #signalClaims = new Map();
  #consumersByPrompt = new Map();
  #consumersByTurn = new Map();
  #openTurns = new Map();
  #disposedSessions = new Set();
  #uuid;

  constructor({ uuid = randomUUID } = {}) {
    if (typeof uuid !== 'function') throw new TypeError('uuid must be a function');
    this.#uuid = uuid;
  }

  /**
   * Register a queued ordinary RPC consumer. Opening it does not take over an
   * active Turn; the Host's claim binds it. The returned close is owner-scoped
   * and idempotent. Already claimed files belong to the provider pipeline.
   */
  openConsumer(sessionId, promptRpcId) {
    if (typeof sessionId !== 'string' || !sessionId
      || typeof promptRpcId !== 'string' || !promptRpcId) {
      throw new TypeError('sessionId and promptRpcId are required');
    }
    const key = promptKey(sessionId, promptRpcId);
    const previous = this.#consumersByPrompt.get(key);
    if (previous) this.#closeConsumer(previous);
    const consumer = {
      sessionId,
      promptRpcId,
      owner: null,
      released: this.#disposedSessions.has(sessionId),
    };
    if (!consumer.released) this.#consumersByPrompt.set(key, consumer);
    return () => this.#closeConsumer(consumer);
  }

  /**
   * Open an internal non-RPC lease only for the currently observed live Turn.
   * Refuse an existing owner, an unobserved/future/closed Turn or disposed
   * Session. Authorization/routing is the relay's responsibility. The lease
   * cannot select another Session/Turn or be serialized into a capability.
   *
   * active remains true after turn/end so the relay can first take() and then
   * close(). close() discards only this owner's unclaimed files; taken files
   * retain their original identity and must be released by their recipient.
   * @returns {null | { readonly active: boolean, take(options?: {signal?: AbortSignal}): object[], close(): void }}
   */
  openTurnConsumer(sessionId, turn) {
    if (typeof sessionId !== 'string' || !sessionId
      || !Number.isInteger(turn) || turn < 0
      || this.#disposedSessions.has(sessionId)
      || this.#openTurns.get(sessionId) !== turn
      || this.#consumerForTurn(sessionId, turn)) return null;
    const owner = { kind: 'turn', sessionId, turn, released: false };
    this.#consumersByTurn.set(turnKey(sessionId, turn), owner);
    return Object.freeze({
      get active() { return !owner.released; },
      take: ({ signal } = {}) => this.#take(owner, signal),
      close: () => this.#closeOwner(owner),
    });
  }

  #closeConsumer(consumer) {
    if (consumer.released) return;
    consumer.released = true;
    const key = promptKey(consumer.sessionId, consumer.promptRpcId);
    if (this.#consumersByPrompt.get(key) === consumer) this.#consumersByPrompt.delete(key);
    if (consumer.owner) this.#closeOwner(consumer.owner);
  }

  #closeOwner(owner) {
    if (owner.released) return;
    owner.released = true;
    const key = turnKey(owner.sessionId, owner.turn);
    if (this.#consumersByTurn.get(key) === owner) this.#consumersByTurn.delete(key);
    this.#discardOwner(owner);
  }

  /** The Host claims input before assembling the first step's prompt. */
  observeClaimedMessage(session, message, turn) {
    const sessionId = sessionIdOf(session);
    if (!sessionId || !Number.isInteger(turn) || turn < 0
      || this.#currentTurn(session) !== turn) return;
    this.#bindConsumer(sessionId, message?.source?.rpcId, turn);
  }

  #bindConsumer(sessionId, rpcId, turn) {
    if (typeof rpcId !== 'string' || !rpcId) return;
    const consumer = this.#consumersByPrompt.get(promptKey(sessionId, rpcId));
    if (!consumer || consumer.released) return;
    const previous = this.#consumerForTurn(sessionId, turn);
    if (previous && previous === consumer.owner) return;
    // Preserve ordinary RPC queue/claim order. A real claim, not merely a
    // pending RPC, revokes a schedule and removes its staged/committed files.
    if (previous) this.#closeOwner(previous);
    if (consumer.owner) this.#closeOwner(consumer.owner);
    const owner = { kind: 'rpc', sessionId, turn, consumer, released: false };
    consumer.owner = owner;
    this.#consumersByTurn.set(turnKey(sessionId, turn), owner);
  }

  /** Observe durable Session events to bind delivery ownership and clean up. */
  observeSessionEvent(session, event, { logger } = {}) {
    const sessionId = sessionIdOf(session);
    if (!sessionId || this.#disposedSessions.has(sessionId)
      || !event || typeof event !== 'object') return;
    if (event.type === 'turn/start') {
      const turn = event.data?.turn;
      if (Number.isInteger(turn) && turn >= 0) this.#openTurns.set(sessionId, turn);
      return;
    }
    if (event.type === 'user/message') {
      const rpcId = event.data?.source?.rpcId;
      const turn = this.#currentTurn(session);
      if (typeof rpcId !== 'string' || !rpcId || !Number.isInteger(turn)
        || (Number.isInteger(event.data?.turn) && event.data.turn !== turn)) return;
      this.#openTurns.set(sessionId, turn);
      this.#bindConsumer(sessionId, rpcId, turn);
      return;
    }
    if (event.type !== 'turn/end') return;
    const turn = event.data?.turn;
    if (!Number.isInteger(turn) || turn < 0) return;
    // Retain the observed closed state so a stale Session snapshot cannot
    // reopen a Turn while its consumer is still waiting to claim the files.
    if (this.#currentTurn(session) === turn) this.#openTurns.set(sessionId, null);
    for (const owner of new Set([...this.#turns.keys(), ...this.#stagedTurns.keys()])) {
      if (owner.sessionId !== sessionId || owner.turn !== turn
        || this.#consumerForTurn(sessionId, turn) === owner) continue;
      const artifactCount = (this.#turns.get(owner)?.size ?? 0)
        + (this.#stagedTurns.get(owner)?.size ?? 0);
      this.#closeOwner(owner);
      if (artifactCount > 0) {
        logger?.warn?.('[dsh-im] discarded files without an active IM delivery consumer:', {
          sessionId, turn, artifactCount,
        });
      }
    }
  }

  #currentTurn(session) {
    const sessionId = sessionIdOf(session);
    if (this.#disposedSessions.has(sessionId)) return null;
    return this.#openTurns.has(sessionId)
      ? this.#openTurns.get(sessionId)
      : currentTurn({ session });
  }

  #consumerForTurn(sessionId, turn) {
    const owner = this.#consumersByTurn.get(turnKey(sessionId, turn));
    if (!owner || owner.released) return null;
    if (owner.kind === 'turn') return owner;
    const consumer = owner.consumer;
    return !consumer.released && consumer.owner === owner
      && this.#consumersByPrompt.get(promptKey(sessionId, consumer.promptRpcId)) === consumer
      ? owner : null;
  }

  /** Prompt guidance follows the active Turn's actual delivery owner. */
  hasActiveConsumer(session) {
    const turn = this.#currentTurn(session);
    return Number.isInteger(turn)
      && this.#consumerForTurn(sessionIdOf(session), turn) !== null;
  }

  /** Dispose only this Session's unclaimed work, never another delivery job. */
  disposeSession(session) {
    const sessionId = sessionIdOf(session);
    if (!sessionId) return;
    this.#disposedSessions.add(sessionId);
    for (const consumer of this.#consumersByPrompt.values()) {
      if (consumer.sessionId === sessionId) this.#closeConsumer(consumer);
    }
    for (const owner of [...this.#consumersByTurn.values()]) {
      if (owner.sessionId === sessionId) this.#closeOwner(owner);
    }
    this.#openTurns.delete(sessionId);
  }

  async stage(args, exec) {
    const requestedPath = args?.path;
    if (typeof requestedPath !== 'string' || !requestedPath.trim()) {
      throw new TypeError('A file path is required.');
    }
    const agent = exec?.agent;
    const sessionId = agent?.session?.header?.id;
    const workspace = agent?.session?.header?.cwd;
    const turn = this.#currentTurn(agent?.session);
    if (typeof sessionId !== 'string' || !sessionId
      || typeof workspace !== 'string' || !workspace || turn === null) {
      throw artifactError(
        'artifact-context-required',
        'A live Harness Session is required to return a file.',
      );
    }

    const consumer = this.#consumerForTurn(sessionId, turn);
    const unavailable = () => artifactError(
      'artifact-consumer-required',
      'No active IM delivery consumer owns this turn. The file was not queued. Use the host present tool if available to return the file in this conversation.',
    );
    if (!consumer) throw unavailable();

    const snapshot = await snapshotFile(workspace, requestedPath, exec?.signal);
    const { storagePath, ...snapshotMetadata } = snapshot;
    // Copying and hashing yield to cancellation, disposal and Turn completion.
    // Never leave a late snapshot behind after its delivery owner has gone.
    try {
      exec?.signal?.throwIfAborted();
      if (this.#currentTurn(agent?.session) !== turn
        || this.#consumerForTurn(sessionId, turn) !== consumer) throw unavailable();
    } catch (error) {
      await unlink(storagePath).catch(() => undefined);
      throw error;
    }
    const artifact = Object.freeze({
      kind: ARTIFACT_KIND,
      schemaVersion: 1,
      artifactId: this.#uuid(),
      deliveryKey: this.#uuid(),
      ...snapshotMetadata,
      source: 'managed-temp',
      registeredBy: Object.freeze({
        kind: 'tool-result',
        eventId: typeof exec?.callId === 'string' ? exec.callId : 'unknown',
        toolName: OUTBOUND_ARTIFACT_TOOL,
      }),
      origin: Object.freeze({
        sessionId,
        turn,
        callId: typeof exec?.callId === 'string' ? exec.callId : null,
      }),
      createdAt: Date.now(),
    });
    artifactStorage.set(artifact, {
      path: storagePath,
      owner: consumer,
      materializing: 0,
      materialized: false,
      releaseRequested: false,
      cleanupRequested: false,
      cleanupDeferred: false,
      onCleanup: () => this.#forgetArtifact(artifact, consumer),
    });
    let staged = this.#stagedTurns.get(consumer);
    if (!staged) {
      staged = new Map();
      this.#stagedTurns.set(consumer, staged);
    }
    staged.set(artifactKey(artifact), artifact);
    return artifact;
  }

  /** Commit only this registry's staged file while its original owner is live. */
  commit(artifact) {
    const owner = artifactStorage.get(artifact)?.owner;
    const key = artifactKey(artifact ?? {});
    const staged = this.#stagedTurns.get(owner);
    if (staged?.get(key) !== artifact) return null;
    if (!isManagedOutboundArtifact(artifact)
      || this.#consumerForTurn(owner.sessionId, owner.turn) !== owner) {
      cleanupArtifactStorage(artifact);
      return null;
    }
    staged.delete(key);
    if (staged.size === 0) this.#stagedTurns.delete(owner);
    let committed = this.#turns.get(owner);
    if (!committed) {
      committed = new Map();
      this.#turns.set(owner, committed);
    }
    committed.set(key, artifact);
    return publicArtifact(artifact);
  }

  release(artifact) {
    cleanupArtifactStorage(artifact);
  }

  /**
   * Collect ordinary RPC files. HarnessClient supplies promptRpcId so a stale
   * request cannot collect its successor's files. Omission retains the legacy
   * ordinary-consumer API; non-RPC files are accessible only via their lease.
   */
  take(sessionId, turn, { signal, promptRpcId } = {}) {
    const owner = this.#rpcOwner(sessionId, turn, promptRpcId);
    return owner ? this.#take(owner, signal) : [];
  }

  #rpcOwner(sessionId, turn, promptRpcId) {
    const owner = this.#consumerForTurn(sessionId, turn);
    return owner?.kind === 'rpc'
      && (promptRpcId === undefined || promptRpcId === owner.consumer.promptRpcId)
      ? owner : null;
  }

  #take(owner, signal) {
    if (this.#consumerForTurn(owner.sessionId, owner.turn) !== owner) return [];
    const committed = this.#turns.get(owner);
    this.#turns.delete(owner);
    if (!committed) return [];
    if (signal?.aborted) {
      for (const artifact of committed.values()) cleanupArtifactStorage(artifact);
      return [];
    }
    const claimed = this.#claimedTurns.get(owner) ?? new Map();
    this.#claimedTurns.set(owner, claimed);
    const artifacts = [];
    for (const [key, artifact] of committed) {
      if (!isManagedOutboundArtifact(artifact) || artifactStorage.get(artifact).owner !== owner) continue;
      claimed.set(key, artifact);
      artifacts.push(artifact);
    }
    if (claimed.size === 0) this.#claimedTurns.delete(owner);
    else if (!this.#bindClaimSignal(owner, signal)) return [];
    return artifacts;
  }

  /** Discard unclaimed ordinary RPC files, with the same identity check as take(). */
  discard(sessionId, turn, { promptRpcId } = {}) {
    const owner = this.#rpcOwner(sessionId, turn, promptRpcId);
    if (owner) this.#discardOwner(owner);
  }

  #discardOwner(owner) {
    const artifacts = new Set([
      ...this.#turns.get(owner)?.values() ?? [],
      ...this.#stagedTurns.get(owner)?.values() ?? [],
    ]);
    this.#turns.delete(owner);
    this.#stagedTurns.delete(owner);
    for (const artifact of artifacts) cleanupArtifactStorage(artifact);
  }

  clear() {
    const artifacts = new Set();
    for (const entries of this.#turns.values()) {
      for (const artifact of entries.values()) artifacts.add(artifact);
    }
    for (const entries of this.#stagedTurns.values()) {
      for (const artifact of entries.values()) artifacts.add(artifact);
    }
    for (const entries of this.#claimedTurns.values()) {
      for (const artifact of entries.values()) artifacts.add(artifact);
    }
    for (const artifact of artifacts) cleanupArtifactStorage(artifact);
    this.#turns.clear();
    this.#stagedTurns.clear();
    this.#claimedTurns.clear();
    for (const owner of this.#claimSignals.keys()) this.#releaseClaimSignal(owner);
    for (const consumer of this.#consumersByPrompt.values()) consumer.released = true;
    for (const owner of this.#consumersByTurn.values()) owner.released = true;
    this.#consumersByPrompt.clear();
    this.#consumersByTurn.clear();
    this.#openTurns.clear();
    this.#disposedSessions.clear();
  }

  #bindClaimSignal(owner, signal) {
    if (!signal) return true;
    this.#releaseClaimSignal(owner);
    let claim = this.#signalClaims.get(signal);
    if (!claim) {
      claim = { owners: new Set(), onAbort: null };
      claim.onAbort = () => {
        for (const claimedOwner of [...claim.owners]) {
          for (const artifact of this.#claimedTurns.get(claimedOwner)?.values() ?? []) {
            cleanupArtifactStorage(artifact);
          }
        }
      };
      this.#signalClaims.set(signal, claim);
      signal.addEventListener('abort', claim.onAbort, { once: true });
    }
    claim.owners.add(owner);
    this.#claimSignals.set(owner, signal);
    if (signal.aborted) {
      claim.onAbort();
      return false;
    }
    return true;
  }

  #releaseClaimSignal(owner) {
    const signal = this.#claimSignals.get(owner);
    if (!signal) return;
    this.#claimSignals.delete(owner);
    const claim = this.#signalClaims.get(signal);
    claim?.owners.delete(owner);
    if (claim?.owners.size === 0) {
      signal.removeEventListener('abort', claim.onAbort);
      this.#signalClaims.delete(signal);
    }
  }

  #forgetArtifact(artifact, owner) {
    const key = artifactKey(artifact);
    for (const collection of [this.#turns, this.#stagedTurns, this.#claimedTurns]) {
      const entries = collection.get(owner);
      if (entries?.get(key) === artifact) entries.delete(key);
      if (entries?.size === 0) collection.delete(owner);
    }
    if (!this.#claimedTurns.has(owner)) this.#releaseClaimSignal(owner);
  }

}

export const outboundArtifactRegistry = new OutboundArtifactRegistry();

/**
 * Build a two-phase tool: execute stages a file; the authoritative tools/result
 * observer commits only a successful native call or successful Code Mode parent.
 */
export function createOutboundArtifactTool({ registry = outboundArtifactRegistry } = {}) {
  const staged = new WeakMap();
  const pendingByParent = new Map();
  const appendPending = (parent, artifact) => {
    let pending = pendingByParent.get(parent);
    if (!pending) {
      pending = { artifacts: [] };
      pendingByParent.set(parent, pending);
    }
    pending.artifacts.push(artifact);
  };
  const definition = Object.freeze({
    name: OUTBOUND_ARTIFACT_TOOL,
    description: 'Register a readable file or generated image for delivery through the current IM conversation after this turn. Requires an active IM delivery consumer; in Web, Desktop, or CLI conversations use the host present tool if available. Existing and newly created files are both valid. Success means queued, not sent; do not claim the user has received the file.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path, or a path relative to the current workspace.',
        },
      },
      required: ['path'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          artifactId: { type: 'string' },
          fileName: { type: 'string' },
          size: { type: 'number' },
        },
        required: ['artifactId', 'fileName', 'size'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Registered ${value.fileName} (${value.size} bytes) for IM delivery after this turn. The file has not been sent yet; describe it as prepared or queued, not sent or received.`,
      }],
    },
    async execute(args, exec) {
      const artifact = await registry.stage(args, exec);
      staged.set(exec, artifact);
      return publicArtifact(artifact);
    },
  });

  const onResult = (exec, result) => {
    if (exec?.name === OUTBOUND_ARTIFACT_TOOL) {
      const artifact = staged.get(exec);
      if (!artifact) return;
      staged.delete(exec);
      if (result?.isError) {
        registry.release(artifact);
        return;
      }
      if (exec.parent === undefined) registry.commit(artifact);
      else appendPending(exec.parent, artifact);
      return;
    }
    const pending = pendingByParent.get(exec?.token);
    if (!pending) return;
    pendingByParent.delete(exec.token);
    if (result?.isError) {
      for (const artifact of pending.artifacts) registry.release(artifact);
      return;
    }
    if (exec.parent !== undefined) {
      for (const artifact of pending.artifacts) appendPending(exec.parent, artifact);
      return;
    }
    for (const artifact of pending.artifacts) registry.commit(artifact);
  };

  return Object.freeze({ definition, onResult });
}

/** Register the file-return tool with guidance scoped to an owned IM Turn. */
export function installOutboundArtifactTool(ctx, { registry = outboundArtifactRegistry } = {}) {
  if (typeof ctx?.tools?.register !== 'function'
    || typeof ctx?.systemPrompt?.context !== 'function'
    || typeof ctx?.on !== 'function') return false;
  const logger = typeof ctx.logger === 'function'
    ? ctx.logger('dsh-im:outbound-artifact')
    : (ctx.logger ?? console);
  const tool = createOutboundArtifactTool({ registry });
  ctx.tools.register(tool.definition);
  ctx.on('tools/result', tool.onResult);
  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    registry.observeClaimedMessage(agent?.session, message, turn);
  }, { global: true });
  ctx.on('session/event', (session, event) => registry.observeSessionEvent(session, event, { logger }));
  ctx.on('session/disposed', (session) => registry.disposeSession(session));
  ctx.systemPrompt.context({
    name: 'dsh-im:return-file',
    order: 115,
    text: (assembly) => registry.hasActiveConsumer(assembly?.agent?.session)
      ? `When the user asks to receive a file or generated image, call ${OUTBOUND_ARTIFACT_TOOL} with its path. Existing files can be sent directly; do not recreate or rename a file solely for delivery. This tool only registers the file; the channel uploads and sends it after your turn finishes. In your reply say the file is prepared or queued, never that it has already been sent or received. The channel reports delivery failures separately.`
      : '',
  });
  return true;
}

/** Materialize the registered snapshot for the channel provider. */
export async function materializeOutboundArtifact(artifact, {
  signal,
} = {}) {
  if (signal?.aborted) {
    cleanupArtifactStorage(artifact);
    signal.throwIfAborted();
  }
  if (artifact?.kind !== ARTIFACT_KIND || artifact.schemaVersion !== 1
    || !isManagedOutboundArtifact(artifact)
    || typeof artifact.digest !== 'string'
    || !Number.isSafeInteger(artifact.size) || artifact.size < 0) {
    throw artifactError('artifact-invalid', 'The file registration is invalid.');
  }
  const storage = artifactStorage.get(artifact);
  storage.materializing += 1;
  let handle;
  let materialized = false;
  try {
    const noFollow = Number.isInteger(fsConstants.O_NOFOLLOW) ? fsConstants.O_NOFOLLOW : 0;
    handle = await open(storage.path, fsConstants.O_RDONLY | noFollow);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size !== BigInt(artifact.size)) {
      throw artifactError('artifact-invalid', 'The file registration is invalid.');
    }
    const bytes = await readExactArtifactFile(handle, artifact.size, {
      signal,
      errorCode: 'artifact-invalid',
      errorMessage: 'The file registration is invalid.',
    });
    const after = await handle.stat({ bigint: true });
    if (!sameIdentity(before, after)
      || bytes.byteLength !== artifact.size
      || sha256(bytes) !== artifact.digest) {
      throw artifactError('artifact-invalid', 'The file registration is invalid.');
    }
    signal?.throwIfAborted();
    materialized = true;
    const file = Object.freeze({
      artifactId: artifact.artifactId,
      deliveryKey: artifact.deliveryKey,
      fileName: artifact.fileName,
      mediaType: artifact.mediaType,
      size: artifact.size,
      bytes,
    });
    materializedArtifactSources.set(file, artifact);
    storage.materialized = true;
    return file;
  } catch (error) {
    if (error?.code?.startsWith?.('artifact-')) throw error;
    if (signal?.aborted) throw signal.reason ?? error;
    throw artifactError('artifact-invalid', 'The file registration is invalid.');
  } finally {
    await handle?.close().catch(() => undefined);
    storage.materializing -= 1;
    if (!materialized || storage.cleanupRequested) {
      cleanupArtifactStorage(artifact);
    }
  }
}

/** Keep a materialized snapshot alive until an unabortable provider call settles. */
export function trackOutboundArtifactProviderPromise(file, promise) {
  const artifact = materializedArtifactSources.get(file);
  if (!artifact || !artifactStorage.has(artifact)
    || !promise || typeof promise.then !== 'function') return promise;
  const settlements = artifactProviderSettlements.get(artifact) ?? new Set();
  const settlement = Promise.resolve(promise).then(
    () => undefined,
    () => undefined,
  );
  settlements.add(settlement);
  artifactProviderSettlements.set(artifact, settlements);
  void settlement.finally(() => {
    settlements.delete(settlement);
    if (settlements.size === 0) artifactProviderSettlements.delete(artifact);
  });
  return promise;
}

/** Release a claimed snapshot after its provider send reaches a terminal result. */
export function releaseOutboundArtifact(artifact) {
  const storage = artifactStorage.get(artifact);
  if (storage) storage.releaseRequested = true;
  cleanupArtifactStorage(artifact);
}
