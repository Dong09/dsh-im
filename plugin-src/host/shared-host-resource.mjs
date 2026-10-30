/** Share one Host resource until the last consuming Cordis context unloads. */
export function sharedHostResource(cache, ctx, { create, dispose, label }) {
  const scope = ctx?.root ?? ctx;
  if (!scope || !['object', 'function'].includes(typeof scope)) {
    throw new TypeError('dsh-im requires a Cordis Host context');
  }
  let entry = cache.get(scope);
  if (!entry) {
    entry = { value: create(scope), owners: new Set() };
    cache.set(scope, entry);
  }
  if (!entry.owners.has(ctx)) {
    entry.owners.add(ctx);
    if (typeof ctx.effect === 'function') {
      const owned = entry;
      ctx.effect(() => () => {
        if (!owned.owners.delete(ctx) || owned.owners.size > 0) return;
        if (cache.get(scope) === owned) cache.delete(scope);
        return dispose(owned.value);
      }, label);
    }
  }
  return entry.value;
}
