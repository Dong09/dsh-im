import { sharedHostResource } from './shared-host-resource.mjs';

const peers = new WeakMap();

/** One caller identity retained by every consuming session or command context. */
export function harnessPeer(ctx) {
  const scope = ctx?.root ?? ctx;
  // Connection owns each Peer through the context that reads the service.
  const connection = (typeof scope?.on === 'function' ? scope : ctx)?.connection;
  if (typeof connection?.createPeer !== 'function') return undefined;
  return sharedHostResource(peers, ctx, {
    // IM approvals and questions have their own listeners and response routing.
    create: () => connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' }),
    dispose: (peer) => peer.dispose(),
    label: 'dsh-im: shared Harness caller',
  });
}
