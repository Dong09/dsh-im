/** Share one Host resource until the last consuming Cordis context unloads. */
export function sharedHostResource(cache, ctx, { create, dispose, label, observe }) {
  const scope = ctx?.root ?? ctx;
  if (!scope || !['object', 'function'].includes(typeof scope)) {
    throw new TypeError('dsh-im requires a Cordis Host context');
  }
  const notify = (event, resource) => {
    if (!observe) return;
    try { observe(event, { value: resource.value, scope, ctx, ownerCount: resource.owners.size }); }
    catch { /* Observability must not change ownership or disposal semantics. */ }
  };
  let entry = cache.get(scope);
  if (!entry) {
    entry = { value: create(scope), owners: new Set() };
    cache.set(scope, entry);
    notify('create', entry);
  }
  if (!entry.owners.has(ctx)) {
    entry.owners.add(ctx);
    notify('retain', entry);
    if (typeof ctx.effect === 'function') {
      const owned = entry;
      ctx.effect(() => () => {
        if (!owned.owners.delete(ctx)) return;
        notify('release', owned);
        if (owned.owners.size > 0) return;
        if (cache.get(scope) === owned) cache.delete(scope);
        notify('dispose', owned);
        return dispose(owned.value);
      }, label);
    }
  } else {
    notify('reuse', entry);
  }
  return entry.value;
}
