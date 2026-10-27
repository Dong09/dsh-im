import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MatrixConfigStore, deriveMatrixBotIdentity } from '../../../../src/channels/matrix/matrix-config-store.mjs';
import { MatrixController } from '../../../../src/channels/matrix/matrix-controller.mjs';

export function runtimeStub(overrides = {}) {
  return Object.assign({
    status: { ready: false, connectionState: 'idle', harnessReachable: false },
    starts: 0, stops: 0,
    async start() { this.starts += 1; Object.assign(this.status, { ready: true, connectionState: 'connected', harnessReachable: true }); },
    async stop() { this.stops += 1; Object.assign(this.status, { ready: false, connectionState: 'idle', harnessReachable: false }); },
    async sendProactiveText() { return { providerMessageIds: ['$controller-send:example.org'] }; },
  }, overrides);
}

/** Real Matrix config/controller with only credential transport and runtime I/O doubled. */
export async function controllerFixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-matrix-controller-'));
  const configStore = await new MatrixConfigStore(join(directory, 'bots.json')).load();
  const identity = deriveMatrixBotIdentity({ homeserver: 'https://matrix.example.org', userId: '@bot:example.org' });
  const config = {
    ...identity, platformId: 'matrix.example.org|@bot:example.org',
    homeserver: 'https://matrix.example.org', userId: '@bot:example.org', name: 'fixture',
  };
  await configStore.save(config);
  const secrets = new Map([[identity.tokenRef, 'fixture-token']]);
  const credentials = {
    resolve: async (ref) => secrets.has(ref) ? { value: secrets.get(ref) } : undefined,
    set: async (ref, value) => { secrets.set(ref, value); },
    unset: async (ref) => { secrets.delete(ref); },
  };
  const runtimes = [];
  const controller = new MatrixController({
    configStore, credentials,
    inspectCredentials: options.inspectCredentials,
    deleteState: options.deleteState,
    logger: { info() {}, warn() {}, error() {} },
    createRuntime: async (args) => {
      const runtime = options.createRuntime ? await options.createRuntime(args) : runtimeStub();
      runtimes.push(runtime);
      return runtime;
    },
  });
  t.after(async () => {
    await options.cleanup?.();
    await controller.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { controller, configStore, config, identity, credentials, secrets, runtimes };
}
