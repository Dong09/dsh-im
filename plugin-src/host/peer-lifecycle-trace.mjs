import { appendFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

// Local, opt-in diagnostics only. Never serialize a request, context or abort message.
const MAX_BYTES = 2 * 1024 * 1024;
const ids = new WeakMap();
const peerFacts = new WeakMap();
let nextId = 0;

function tracePath() {
  const path = process.env.DSH_IM_PEER_TRACE_FILE;
  if (typeof path !== 'string' || !isAbsolute(path)) return null;
  // Never synchronously touch UNC/device paths or alternate data streams.
  if (process.platform === 'win32') {
    if (!/^[A-Za-z]:[\\/]/u.test(path) || path.slice(2).includes(':')) return null;
    if (path.split(/[\\/]/u).slice(1).some(part => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) return null;
  }
  return path;
}

function identity(value) {
  if (!value || !['object', 'function'].includes(typeof value)) return null;
  if (!ids.has(value)) ids.set(value, ++nextId);
  return ids.get(value);
}

function frames() {
  // Capture our own empty-message Error, never an arbitrary abort reason's stack.
  const stack = new Error().stack;
  return typeof stack === 'string'
    ? stack.split('\n').filter(line => /^\s+at /u.test(line)).slice(0, 24).join('\n').slice(0, 12_000)
    : null;
}

function peerIdentity(peer) {
  return typeof peer?.id === 'string' && /^[a-f0-9-]{36}$/iu.test(peer.id)
    ? peer.id : `local-${identity(peer)}`;
}

function write(event, peer, facts = {}) {
  try {
    const path = tracePath();
    if (!path) return;
    let size = 0;
    try { const stat = statSync(path); if (!stat.isFile()) return; size = stat.size; }
    catch (error) { if (error.code !== 'ENOENT') return; }
    const line = JSON.stringify({ version: 1, at: new Date().toISOString(), pid: process.pid,
      event, peerId: peerIdentity(peer), aborted: peer?.signal?.aborted === true, ...facts }) + '\n';
    if (size + Buffer.byteLength(line) > MAX_BYTES) return;
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, line, { encoding: 'utf8', mode: 0o600 });
  } catch { /* Diagnostics must never change resource ownership or RPC results. */ }
}

/** Created only when the process explicitly opts in before resource acquisition. */
export function peerLifecycleObserver() {
  if (!tracePath()) return undefined;
  return (event, { value: peer, scope, ctx, ownerCount }) => {
    try {
      const facts = { rootId: identity(scope), contextId: identity(ctx), ownerCount,
        fiberUid: Number.isInteger(ctx?.fiber?.uid) ? ctx.fiber.uid : null,
        stack: frames() };
      if (peer && ['object', 'function'].includes(typeof peer)) peerFacts.set(peer, facts);
      write(event, peer, facts);
      if (event === 'create' && peer?.signal?.addEventListener) {
        const aborted = () => {
          try { write('abort', peer, { ...peerFacts.get(peer), stack: frames() }); }
          catch { /* Includes stack formatting hooks and unexpected Peer accessors. */ }
        };
        if (peer.signal.aborted) aborted();
        else peer.signal.addEventListener('abort', aborted, { once: true });
      }
    } catch { /* A diagnostic observer must not escape into ownership handling. */ }
  };
}

/** Correlate a rejected call without logging args, session ids, prompts or rpc ids. */
export function traceAbortedPeerCall(peer, namespace, method) {
  try {
    if (!peer?.signal?.aborted || !tracePath()) return;
    write('call-with-aborted-peer', peer, {
      namespace: /^[a-z][a-zA-Z0-9-]{0,63}$/u.test(namespace ?? '') ? namespace : null,
      method: /^[a-z][a-zA-Z0-9-]{0,63}$/u.test(method ?? '') ? method : null,
      stack: frames(),
    });
  } catch { /* Includes stack formatting hooks and unexpected Peer accessors. */ }
}
