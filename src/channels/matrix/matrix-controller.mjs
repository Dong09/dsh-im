import { connectionTestMessage } from '../shared/connection-test.mjs';
import { publicMessageFailure } from '../shared/message-failure.mjs';
import { t } from '../shared/i18n.mjs';
import { deriveMatrixBotIdentity, maskMatrixBotId } from './matrix-config-store.mjs';
import { inspectMatrixCredentials, isMatrixUserId, validateMatrixHomeserver } from './matrix-api.mjs';
import { MATRIX_DESCRIPTOR } from './matrix-bridge.mjs';

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function safeError(code, message) {
  return Object.freeze({ code, message });
}

function operationError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function cleanupFailures(results, stages) {
  return results.flatMap((result, index) => {
    if (result.status === 'fulfilled') return [];
    const error = new Error(`Matrix cleanup failed at ${stages[index]}`, { cause: result.reason });
    error.stage = stages[index];
    return [error];
  });
}

function runtimeConnected(state) {
  return state?.ready === true && state.connectionState === 'connected' && state.harnessReachable !== false;
}

export class MatrixController {
  #credentials;
  #configStore;
  #inspectCredentials;
  #createRuntime;
  #deleteState;
  #logger;
  #runtimes = new Map();
  #errors = new Map();
  #transitions = new Map();
  #revision = 0;
  #closed = false;
  #closeTask = null;
  #runtimeStops = new Map();
  #inspectionController = new AbortController();

  constructor({
    credentials,
    configStore,
    inspectCredentials = inspectMatrixCredentials,
    createRuntime,
    deleteState = async () => {},
    logger = console,
  }) {
    if (!credentials || typeof credentials.resolve !== 'function'
      || typeof credentials.set !== 'function' || typeof credentials.unset !== 'function') {
      throw new TypeError('Matrix requires the DSH credential provider');
    }
    if (!configStore || typeof configStore.list !== 'function'
      || typeof configStore.save !== 'function' || typeof configStore.remove !== 'function') {
      throw new TypeError('Matrix requires a config store');
    }
    if (typeof inspectCredentials !== 'function' || typeof createRuntime !== 'function') {
      throw new TypeError('Matrix controller dependencies are incomplete');
    }
    this.#credentials = credentials;
    this.#configStore = configStore;
    this.#inspectCredentials = inspectCredentials;
    this.#createRuntime = createRuntime;
    this.#deleteState = deleteState;
    this.#logger = logger;
  }

  #assertOpen() {
    if (this.#closed) throw operationError('matrix-controller-closed', t('Matrix 控制器已关闭，请重新启用插件后再操作。'));
  }

  #requiresRebind(botId) {
    return ['matrix-bind-rollback-failed', 'matrix-cleanup-failed'].includes(this.#errors.get(botId)?.code);
  }

  async initialize() {
    if (this.#closed) return this.status();
    for (const { botId } of this.#configStore.list()) {
      if (this.#closed) break;
      await this.#withBotTransition(botId, async () => {
        if (this.#closed || this.#requiresRebind(botId)) return;
        const config = this.#configStore.get(botId);
        if (!config) return;
        const state = this.#runtimes.get(botId)?.status;
        if (!this.#errors.has(botId) && (runtimeConnected(state) || state?.connectionState === 'connecting')) return;
        try {
          await this.#stopRuntime(botId);
          if (this.#closed) return;
          const resolved = await this.#resolveCredentials(config);
          if (this.#closed) return;
          if (!resolved) {
            this.#errors.set(botId, safeError('missing-token', t('Matrix机器人凭据缺失，请移除后重新接入。')));
            return;
          }
          await this.#startRuntime(config, resolved);
          this.#errors.delete(botId);
        } catch (error) {
          if (this.#closed) return;
          this.#errors.set(botId, safeError(error.code ?? 'connection-failed', error?.message ?? t('Matrix 连接未就绪，插件会自动重试。')));
          this.#logger.warn?.(`[dsh-im:matrix] bot ${botId} failed to initialize:`, error);
        } finally {
          this.#touch();
        }
      });
    }
    return this.status();
  }

  async bindCredentials({ homeserver, accessToken, userId, password } = {}) {
    this.#assertOpen();
    const base = validateMatrixHomeserver(homeserver);
    const token = cleanString(accessToken);
    const identifier = cleanString(userId);
    const secret = cleanString(password);
    if (!base) {
      const error = new Error(t('Matrix homeserver 地址无效，请填写 https:// 或 http:// 开头的完整地址。'));
      error.code = 'invalid-config';
      throw error;
    }
    if (!token && !(identifier && secret)) {
      const error = new Error(t('Matrix 凭据不完整：请提供访问令牌，或用户 ID 与密码的组合。'));
      error.code = 'invalid-config';
      throw error;
    }
    if (identifier && !isMatrixUserId(identifier)) {
      const error = new Error(t('Matrix 用户 ID 无效，请使用 @user:server 形式。'));
      error.code = 'invalid-config';
      throw error;
    }
    const inspected = await this.#inspectCredentials({
      homeserver: base,
      ...(token ? { accessToken: token } : {}),
      ...(identifier ? { userId: identifier } : {}),
      ...(secret ? { password: secret } : {}),
    }, { signal: this.#inspectionController.signal });
    const platformId = cleanString(inspected?.platformId);
    const resolvedUserId = cleanString(inspected?.userId);
    const name = cleanString(inspected?.name);
    if (!platformId || !resolvedUserId || !name) {
      throw new Error('Matrix homeserver returned an incomplete bot identity');
    }
    const derived = deriveMatrixBotIdentity({ homeserver: base, userId: resolvedUserId });
    return await this.#withBotTransition(derived.botId, async () => {
      this.#assertOpen();
      const existing = this.#configStore.getByPlatformId(platformId);
      if (existing && existing.botId !== derived.botId) throw new Error('This Matrix bot belongs to another Harness installation');
      const previous = this.#configStore.get(derived.botId);
      const previousRefs = await Promise.all([
        this.#readCredential(derived.tokenRef), this.#readCredential(derived.passwordRef),
      ]);
      this.#assertOpen();
      try {
        if (token) await this.#credentials.set(derived.tokenRef, token);
        else await this.#credentials.unset(derived.tokenRef);
        if (secret) await this.#credentials.set(derived.passwordRef, secret);
        else await this.#credentials.unset(derived.passwordRef);
        await this.#configStore.save({
          ...previous,
          botId: derived.botId, platformId, homeserver: base, userId: resolvedUserId,
          ...(cleanString(inspected?.deviceId) ? { deviceId: cleanString(inspected.deviceId) } : {}),
          tokenRef: derived.tokenRef, passwordRef: derived.passwordRef, name,
          username: cleanString(inspected?.username),
          createdAt: previous?.createdAt ?? new Date().toISOString(), connectedAt: previous?.connectedAt ?? null,
        });
      } catch (cause) {
        const results = await Promise.allSettled([
          this.#restoreCredential(derived.tokenRef, previousRefs[0]),
          this.#restoreCredential(derived.passwordRef, previousRefs[1]),
          previous ? this.#configStore.save(previous) : this.#configStore.remove(derived.botId),
        ]);
        const failures = cleanupFailures(results, ['access-token-rollback', 'password-rollback', 'config-rollback']);
        if (failures.length) {
          try { await this.#stopRuntime(derived.botId); }
          catch (error) { failures.push(error); }
          const error = operationError('matrix-bind-rollback-failed',
            t('Matrix 凭据或配置回滚失败，已暂停自动连接。请检查凭据存储并重新接入，勿直接重试连接。'),
            new AggregateError([cause, ...failures], 'Matrix binding rollback failed'));
          this.#errors.set(derived.botId, safeError(error.code, error.message));
          this.#touch();
          throw error;
        }
        throw cause;
      }
      try {
        this.#assertOpen();
        const config = this.#configStore.get(derived.botId);
        const resolved = await this.#resolveCredentials(config);
        if (!resolved) throw new Error(t('Matrix机器人凭据缺失，请重新输入凭据。'));
        await this.#startRuntime(config, resolved);
        this.#errors.delete(derived.botId);
        return this.#publicBot(config);
      } catch (error) {
        if (!this.#closed) this.#errors.set(derived.botId, safeError(error.code ?? 'connection-failed', error.message));
        throw error;
      } finally {
        this.#touch();
      }
    });
  }

  async reconnectBot(botId, { sendTest = false } = {}) {
    this.#requireId(botId);
    if (this.#closed) return this.status();
    return await this.#withBotTransition(botId, async () => {
      if (this.#closed) return this.status();
      await this.#stopRuntime(botId);
      if (this.#closed || this.#requiresRebind(botId)) return this.status();
      const config = this.#configStore.get(botId);
      if (!config) return this.status();
      const resolved = await this.#resolveCredentials(config);
      if (!resolved) {
        this.#errors.set(botId, safeError(
          'missing-token',
          t('Matrix机器人凭据缺失，请重新输入凭据。'),
        ));
        this.#touch();
        return this.status();
      }
      try {
        await this.#startRuntime(config, resolved);
        this.#errors.delete(botId);
        const saved = this.#configStore.get(botId);
        if (saved) {
          await this.#configStore.save({ ...saved, connectedAt: new Date().toISOString() });
        }
        if (sendTest) await this.sendConnectionTest(botId);
      } catch (error) {
        this.#errors.set(botId, safeError('connection-failed', error?.message ?? String(error)));
      } finally {
        this.#touch();
      }
      return this.status();
    });
  }

  async sendConnectionTest(botId) {
    this.#assertOpen();
    this.#requireId(botId);
    const runtime = this.#runtimes.get(botId);
    if (this.#errors.has(botId) || !runtime?.status?.ready) throw new Error('Matrix bot is not connected');
    const config = this.#configStore.get(botId);
    const masked = maskMatrixBotId(config?.platformId ?? botId);
    const name = cleanString(runtime.status?.name) ?? cleanString(config?.name) ?? masked;
    if (typeof runtime.sendConnectionTest !== 'function') {
      throw new Error('Matrix connection test is unavailable');
    }
    return await runtime.sendConnectionTest(connectionTestMessage(`${name}（${masked}）`, t('Matrix机器人')));
  }

  async sendProactiveText(botId, target, text, options = {}) {
    this.#assertOpen();
    this.#requireId(botId);
    const runtime = this.#runtimes.get(botId);
    if (this.#errors.has(botId) || !runtime?.status?.ready || typeof runtime.sendProactiveText !== 'function') {
      throw new Error('Matrix bot is not connected for proactive delivery');
    }
    return await runtime.sendProactiveText(target, String(text ?? ''), options);
  }

  async presentSessionSyncApproval(botId, target, interaction, options = {}) {
    this.#assertOpen();
    this.#requireId(botId);
    const runtime = this.#runtimes.get(botId);
    if (this.#errors.has(botId) || !runtime?.status?.ready || typeof runtime.presentSessionSyncApproval !== 'function') {
      throw new Error('Matrix bot is not connected for proactive delivery');
    }
    return runtime.presentSessionSyncApproval(target, interaction, options);
  }

  async deleteBot(botId) {
    this.#assertOpen();
    this.#requireId(botId);
    return await this.#withBotTransition(botId, async () => {
      this.#assertOpen();
      const config = this.#configStore.get(botId);
      try { await this.#stopRuntime(botId); }
      catch (cause) {
        const error = operationError('matrix-cleanup-failed',
          t('Matrix 连接未能停止，未执行配置、凭据和状态删除。请检查日志后重试。'),
          new AggregateError([cause], 'Matrix stop prerequisite failed'));
        error.removed = false;
        this.#errors.set(botId, safeError(error.code, error.message));
        this.#touch();
        throw error;
      }
      const suffix = botId.slice(7).toUpperCase();
      const results = await Promise.allSettled([
        this.#deleteState({ botId, config: config ?? {} }),
        this.#credentials.unset(`DSH_MATRIX_TOKEN_${suffix}`),
        this.#credentials.unset(`DSH_MATRIX_PASSWORD_${suffix}`),
      ]);
      const failures = cleanupFailures(results, ['state', 'access-token', 'password']);
      let removed = false;
      try { removed = Boolean(await this.#configStore.remove(botId)); }
      catch (error) { failures.push(error); }
      this.#touch();
      if (failures.length) {
        const error = operationError('matrix-cleanup-failed', removed
          ? t('Matrix 配置已移除，但部分状态或凭据未清理。请检查日志并清理残留后再接入。')
          : t('Matrix 清理未完成，请检查日志并确认配置、状态和凭据的残留情况。'),
        new AggregateError(failures, 'Matrix deletion cleanup failed'));
        error.removed = removed;
        this.#errors.set(botId, safeError(error.code, error.message));
        throw error;
      }
      this.#errors.delete(botId);
      return removed;
    });
  }

  status() {
    const bots = this.#configStore.list().map((config) => {
      const runtime = this.#runtimes.get(config.botId);
      const state = runtime?.status ?? null;
      // The shared token-channel settings view (createTokenChannelApi) renders
      // online/offline, the summary line and "最近检查" from these fields. Emit
      // them here so a connected bot is reported as connected instead of falling
      // back to the offline defaults, matching the other token channels.
      const hasError = Boolean(this.#errors.get(config.botId));
      const connected = !this.#closed && !hasError && runtimeConnected(state);
      const botState = connected ? 'connected'
        : state?.connectionState === 'connecting' ? 'connecting'
          : hasError || state?.connectionState === 'failed' ? 'error' : 'offline';
      return {
        botId: config.botId,
        name: maskMatrixBotId(config.platformId),
        bot: {
          name: cleanString(config.name) ?? maskMatrixBotId(config.platformId),
          username: cleanString(config.username) ?? undefined,
          idMasked: maskMatrixBotId(config.platformId),
        },
        idMasked: maskMatrixBotId(config.platformId),
        ready: connected,
        connectionState: this.#closed ? 'idle' : hasError ? 'failed' : state?.connectionState ?? 'idle',
        harnessReachable: state ? state.harnessReachable !== false : false,
        connected,
        state: botState,
        configured: true,
        health: {
          status: connected ? 'healthy' : botState === 'error' ? 'error' : 'offline',
          summary: connected
            ? t('Matrix 长轮询接收和 Harness 回复全部正常。')
            : hasError || botState === 'error'
              ? t('Matrix 连接未就绪，插件会自动重试。')
              : t('Matrix 连接当前离线。'),
          lastCheckedAt: state?.lastCheckedAt ?? state?.lastConnectedAt ?? null,
          lastConnectedAt: state?.lastConnectedAt ?? null,
        },
        stats: {
          messagesReceived: state?.messagesReceived ?? 0,
          messagesReplied: state?.messagesReplied ?? 0,
        },
        lastConnectedAt: state?.lastConnectedAt ?? null,
        lastError: this.#errors.get(config.botId) ?? state?.lastError ?? null,
        lastMessageAt: state?.lastMessageAt ?? null,
        lastMessageError: publicMessageFailure(state?.lastMessageError) ?? null,
      };
    });
    const ready = bots.filter((bot) => bot.connected).length;
    const allConnected = bots.length > 0 && ready === bots.length;
    return {
      revision: this.#revision,
      ready: allConnected,
      totals: {
        configured: bots.length, connected: ready,
        bots: bots.length,
        ready,
        failed: bots.filter((bot) => bot.connectionState === 'failed').length,
      },
      summary: {
        healthy: allConnected
          ? t('Matrix 长轮询接收和 Harness 回复全部正常。')
          : ready === 0 && bots.length > 0
            ? t('Matrix 长轮询尚未建立，请检查 homeserver 与凭据。')
            : t('Matrix 正在处理消息；当前存在未恢复的连接。'),
        attention: bots.flatMap((bot) => bot.lastMessageError
          ? [`${bot.name}：${bot.lastMessageError.message}`] : []),
      },
      bots,
    };
  }

  /** Revoke admission and await all accepted transitions and their owned runtime cleanup. */
  close() {
    if (this.#closeTask) return this.#closeTask;
    this.#closed = true;
    this.#inspectionController.abort(new DOMException('Matrix controller closed', 'AbortError'));
    const stopping = [...this.#runtimes.keys()].map((botId) => this.#stopRuntime(botId));
    this.#closeTask = this.#finishClose(stopping);
    return this.#closeTask;
  }

  async #finishClose(stopping) {
    await Promise.allSettled([...stopping, ...this.#transitions.values()]);
    while (this.#transitions.size) await Promise.allSettled([...this.#transitions.values()]);
    const results = await Promise.allSettled([...this.#runtimeStops.values()]);
    const failures = cleanupFailures(results, results.map(() => 'runtime-stop'));
    this.#touch();
    if (failures.length) {
      throw operationError('matrix-cleanup-failed', t('Matrix 连接资源未能完整释放，请检查日志后重启插件。'),
        new AggregateError(failures, 'Matrix controller shutdown failed'));
    }
    this.#runtimes.clear();
    this.#runtimeStops.clear();
  }

  async #startRuntime(config, resolved) {
    this.#assertOpen();
    await this.#stopRuntime(config.botId);
    this.#assertOpen();
    const runtime = await this.#createRuntime({
      botId: config.botId, config, homeserver: config.homeserver, userId: config.userId, ...resolved,
    });
    this.#runtimes.set(config.botId, runtime);
    try {
      this.#assertOpen();
      await runtime.start();
      this.#assertOpen();
      if (!runtime.status?.ready && runtime.status?.connectionState !== 'connecting') {
        throw new Error('Matrix connection is not ready');
      }
      return runtime;
    } catch (error) {
      try { await this.#stopRuntime(config.botId); }
      catch (cleanupError) {
        throw operationError('matrix-cleanup-failed', t('Matrix 连接资源未能完整释放，请检查日志后重启插件。'),
          new AggregateError([error, cleanupError], 'Matrix startup cleanup failed'));
      }
      throw error;
    }
  }

  #stopRuntime(botId) {
    const previous = this.#runtimes.get(botId);
    if (!previous) return Promise.resolve();
    const pending = this.#runtimeStops.get(previous);
    if (pending) return pending;
    const task = (async () => {
      try { await previous.stop?.(); }
      catch (error) {
        this.#errors.set(botId, safeError('matrix-runtime-stop-failed', error.message));
        this.#logger.warn?.(`[dsh-im:matrix] bot ${botId} stopped with an error:`, error);
        throw error;
      }
      if (this.#runtimes.get(botId) === previous) this.#runtimes.delete(botId);
    })();
    this.#runtimeStops.set(previous, task);
    const forget = () => { if (!this.#closed) this.#runtimeStops.delete(previous); };
    void task.then(forget, forget);
    return task;
  }

  async #readCredential(ref) {
    try { return await this.#credentials.resolve(ref); }
    catch (cause) {
      throw operationError('matrix-credentials-unavailable', t('Matrix 凭据读取失败，请检查凭据存储后重试。'), cause);
    }
  }

  async #resolveCredentials(config) {
    const token = cleanString((await this.#readCredential(config.tokenRef))?.value);
    if (token) return { accessToken: token };
    const password = cleanString((await this.#readCredential(config.passwordRef))?.value);
    if (password && config.userId) return { password, userId: config.userId };
    return null;
  }

  async #restoreCredential(ref, previous) {
    if (previous?.value) await this.#credentials.set(ref, previous.value);
    else await this.#credentials.unset(ref);
  }

  #requireId(botId) {
    if (typeof botId !== 'string' || !/^matrix_[a-f0-9]{24}$/.test(botId)) {
      throw new TypeError('Invalid Matrix bot id');
    }
  }

  #publicBot(config) {
    if (!config) throw new Error('Matrix bot is no longer configured');
    return {
      botId: config.botId,
      name: maskMatrixBotId(config.platformId),
      bot: {
        name: cleanString(config.name) ?? maskMatrixBotId(config.platformId),
        username: cleanString(config.username) ?? undefined,
        idMasked: maskMatrixBotId(config.platformId),
      },
      idMasked: maskMatrixBotId(config.platformId),
    };
  }

  #withBotTransition(botId, operation) {
    this.#assertOpen();
    const previous = this.#transitions.get(botId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const settled = current.finally(() => {
      if (this.#transitions.get(botId) === settled) this.#transitions.delete(botId);
    });
    this.#transitions.set(botId, settled);
    return settled;
  }

  #touch() {
    this.#revision += 1;
  }
}
