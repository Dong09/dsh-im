import { writeFile } from 'node:fs/promises';

export const name = 'schedule-relay-profile-audit';

/** Fail promptly if Loader leaves the evidence-producing plugin inactive. */
export function apply(ctx) {
  ctx.effect(() => ctx.get('appReady').onReady(() => {
    const entry = [...ctx.get('loader').entries()].find(candidate => candidate.options.id === 'schedule-relay-real-host-fixture');
    if (entry?.fiber?.state === 2) return;
    const error = 'The real Host fixture plugin did not activate; inspect stderr for Loader diagnostics.';
    console.error(error);
    void writeFile(process.env.DSH_SCHEDULE_RELAY_RESULT, JSON.stringify({ error })).finally(() => ctx.get('appExit')(1));
  }));
}
