# Matrix Non-E2EE Mainline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 收敛 Matrix 非加密房间的发送、连接和认证重复实现，修复回执、关闭和健康状态，同时保留 E2EE 研究代码及用户状态。

**Architecture:** 保持现有 MatrixRuntime、MatrixController 和共享 TextHarnessBridge。附件回退只归共享投递器，连接重建只归共享 supervisor；Matrix 保留协议事件处理、双凭据接入与每 bot 资源。本计划按协议规则、发送、runtime 生命周期、controller/supervisor 四个可独立验收单元实施，最后做合并回归，不创建新通用框架。

**Tech Stack:** Node.js >=22.19；ESM JavaScript；node:test/node:assert；现有 AbortController、undici MockAgent、esbuild。不新增依赖。

**Spec:** [已批准设计](../specs/2026-10-27-matrix-non-e2ee-mainline-design.md)

## Global Constraints

- 不删除或默认停用 E2EE；不移动密钥或更改旧设备身份；不改变 crypto 相关依赖和配置默认值。
- 不整体迁移 Matrix SDK，不增加通用插件框架、大量配置开关或新的持久化格式。
- 不调整线程路由、触发规则、上下文消费、图片 inbox、图片关联或历史保留策略；不替换 Markdown/HTML 依赖。
- 不改变其他渠道的产品行为；共享 Bridge 的 reaction 等待是明确 opt-in，现有调用默认保持不等待 reaction 的行为。
- 所有新测试以可控 Promise、signal 或注入计时器建立顺序，不用长 sleep 等待竞态。
- 不在原始工作树解决 merge、stage 用户文件、重建 lib、reset、stash 或提交；提交和回合并需另行授权。
- 本计划只落实所列行为，不把静态图谱或离线桩测试描述成真实 homeserver/Element 验收。

## Review Focus

1. HTTP 成功但响应为空、JSON 无法解析或没有 event_id：发送结果未知，不得自动转文件补发（Task 2）。
2. stop 发生在 whoami、crypto.start、初始 sync 或增量批次持久化等待中：旧任务不能晚发布资源，stop 必须等已开始的写入结束（Task 3）。
3. 正文已交付而 reaction 尚未结束，或取消发生在远端提交后：不能提前销毁依赖，也不能宣称远端事件被撤回（Tasks 2–3）。
4. 1 个已连接账号加 1 个缺凭据账号：顶层不得全部健康，真实 supervisor 应使用离线退避（Task 4）。
5. 合法 v12 房间和 legacy thread conversation key：主动目标及建议双向一致，同时拒绝 alias；不得改变其他渠道路由（Task 1）。

## 执行隔离与基线

- [x] 执行前加载 using-git-worktrees。原仓库 `D:\RJD\workspace\agent\.pr-scratch\dsh-im` 在计划编写时有正在进行的 merge，`lib/index.js` 为 UU，MERGE_HEAD 为 `7e78d771e33ff655a91f127fdd04e90440403e71`。绝不在该树实施或构建。
- [x] 从已审查的 `d9fb1bd8` 创建独立分支及 worktree；目录和分支按 worktree 技能检查后确定。复制本设计和计划，不复制原树暂存改动、冲突产物或 graphify-out；记录原树状态以便交付时核对。
- [x] 在隔离树检查依赖可用性，必要时按现有锁安装且不改锁。运行 `node --test test/channels/matrix/*.test.mjs` 建立基线；已有失败单独记录，不以本批静默改写无关测试。

## 文件职责

- 新增 `src/channels/matrix/matrix-identifiers.mjs`：无 I/O 的 Matrix ID 校验；API 重导出现有符号以保持 import 兼容。
- 修改 `matrix-api.mjs`：唯一密码登录请求实现、原有 signal 和事务标识保证；不改变媒体下载安全限制。
- 修改 `matrix-runtime.mjs`：发送结果、安全门、连接取消/任务所有权、健康状态；不重构上下文代码。
- 修改 `matrix-controller.mjs`：完整 per-bot transition、close、清理失败和状态汇总。
- 修改 `src/channels/shared/text-harness-bridge.mjs`：仅为显式 opt-in 的 idle 等待提供 reaction 尾任务覆盖。
- 修改 `plugin-src/host/delivery-adapter.mjs` 与 `delivery-suggestions.mjs`：Matrix 分支共用校验；其余渠道不变。后者在原树属于正在合并的用户文件，后续移植必须人工核对差异。
- 新增 Matrix controller/lifecycle/supervisor 行为测试；更新现有 API/runtime/delivery 及共享 Bridge 测试。
- 只有最终隔离树构建时更新受影响 lib 产物；README 与英俄词典随相关可见行为一起更新。

### Task 1: 合并登录与 Matrix 目标校验

**Files:** Create `src/channels/matrix/matrix-identifiers.mjs`; modify `src/channels/matrix/matrix-api.mjs`, `plugin-src/host/delivery-adapter.mjs`, `plugin-src/host/delivery-suggestions.mjs`; test `test/channels/matrix/matrix-api.test.mjs`, `test/channels/matrix/matrix-delivery.test.mjs`, `test/delivery-adapter.test.mjs`.

**Interfaces:** Produce `isMatrixUserId(value)`, `isMatrixRoomId(value)`, `isMatrixEventId(value)` with their existing boolean semantics; additionally `isMatrixRoomTargetId(value)` accepts actual room IDs only, not `#alias`. API re-exports the three existing symbols. Retain `performMatrixPasswordLogin({homeserver,userId,password,deviceId?,fetchImpl?}, {signal?}={}) -> Promise<{accessToken,userId,deviceId}>`; `inspectMatrixCredentials` delegates its password request to that helper and preserves existing public error codes and identity fields. Private `matrixSuggestion(key)` keeps its existing result shape, validating parsed IDs through the pure helpers.

- [x] **Write failing tests** prefixed `matrix protocol`: use `!KplB3ESm99I-4PaRdWxDUKr0Sia5nRhRtykpfs1VloM`, legacy `!r:example.org:8448`, and thread `$thr:example.org`; assert suggestion-to-target normalization succeeds and `#alias:example.org`, short hashes and malformed threads are rejected. For login assert password identifier, supplied device ID and AbortSignal reach fetch, returned device ID is retained, pre-abort does not issue a request, and inspect maps 401/403 vs network errors distinctly.
- [x] **Run red:** `node --test --test-name-pattern="matrix protocol" test/channels/matrix/matrix-api.test.mjs test/channels/matrix/matrix-delivery.test.mjs`; verify failures correspond to duplicated current paths, not test setup.
- [x] **Implement** the pure helpers, compatibility re-exports, Matrix-only route checks and helper reuse. Search all production and package-export consumers before removing the unused `MatrixApi.login` wrapper. Preserve bot identity derivation, credential names and configured homeserver-only media authentication.
- [x] **Run green:** `node --test test/channels/matrix/matrix-api.test.mjs test/channels/matrix/matrix-delivery.test.mjs test/delivery-adapter.test.mjs`; all existing non-Matrix route assertions remain passing.
- [ ] **Review task diff** as an independently testable change. Do not commit without separate authorization.

### Task 2: 单一附件回退、回执和不确定结果

**Files:** Modify `src/channels/matrix/matrix-runtime.mjs`, `src/channels/matrix/matrix-controller.mjs`, `src/channels/shared/i18n-en/matrix.mjs`, `src/channels/shared/i18n-ru/matrix.mjs` as needed; test `test/channels/matrix/matrix-runtime.test.mjs`, new `test/channels/matrix/matrix-controller.test.mjs`, and existing `test/artifact-delivery.test.mjs`.

**Interfaces:** Consume Task 1 ID helpers and existing `deliverOutboundArtifacts` policy. Runtime `sendProactiveText(target,text,options)` and controller `sendProactiveText(botId,target,text,options)` return the actual `{providerMessageIds:string[]}` result. Bot `sendImage`/`sendFile` return that same result and issue one native msgtype attempt. Preserve `#sendRoomEvent(roomId,eventType,content,options={})` and its raw successful `{event_id}` result. Add `#assertRoomSendSupported(roomId)` for known encrypted rooms without crypto; use error code `matrix-encryption-unavailable` and localized actionable text. Event-dispatch uncertainty becomes `matrix-delivery-uncertain` with cause, mapped to `artifact-delivery-uncertain` by the attachment boundary; upload failures remain definitely-before-message failures.

- [x] **Write failing tests** prefixed `matrix send`: text chunk IDs preserve order; proactive room and DM IDs pass through both layers; a successful file returns its real event ID; image rejection invokes only the shared image→file policy. Use shared delivery against the real runtime adapter rather than testing two disconnected fakes. Assert unknown send outcomes (network, timeout, 5xx, invalid success JSON, missing/invalid event ID) cause no second event; assert a definite upload failure is not reported as an already-committed message. Assert known encrypted/no-crypto targets perform zero upload and zero plaintext send, while available crypto still emits the encrypted event type.
- [x] **Run red:** `node --test --test-name-pattern="matrix send" test/channels/matrix/matrix-runtime.test.mjs test/channels/matrix/matrix-controller.test.mjs`.
- [x] **Implement** removal of the Matrix attempts loop, event-ID propagation, encryption guard before media work, and request-phase-specific uncertainty classification. Preserve existing same-transaction 429 retry. Caller cancellation never enables fallback and must not assert that a dispatched event was rolled back. Do not use error-message regexes to classify known MatrixApiError values.
- [x] **Run green:** the two Matrix files above plus `node --test test/artifact-delivery.test.mjs test/channels/shared/delivery-message-ids.test.mjs test/channels/matrix/matrix-crypto.test.mjs`; verify success and uncertain receipts against shared extraction.
- [ ] **Review task diff**, including dictionary coverage for any new Chinese `t()` literal; retain current E2EE modes, stores and dependency versions.

### Task 3: Runtime 可取消生命周期与 reaction 收尾

**Files:** Modify `src/channels/matrix/matrix-runtime.mjs`, `src/channels/shared/text-harness-bridge.mjs`; create `test/channels/matrix/matrix-lifecycle.test.mjs`; update `test/channels/matrix/matrix-runtime.test.mjs`, `test/channels/shared/text-harness-bridge.test.mjs` and `test/channels/shared/status-reaction.test.mjs` as needed.

**Interfaces:** Add runtime-owned `#lifecycleController`, `#startTask`, `#stopTask`; `start()`/`stop()` return awaitable single-flight tasks. Thread `{generation, signal}` through initial sync, incremental sync and handlers, and introduce `#assertCurrentGeneration(generation,signal)` to reject invalid continuations before resource publication or dependent work. API identity/login/sync calls consume existing `{signal}`. Bridge `waitForIdle({includeReactions=false}={}) -> Promise<void>` adds an opt-in without changing existing callers; Matrix calls with true. Store a reaction finalization promise for each accepted processing task, invoking its existing `success/error` and then `settled`, and remove it when settled. Matrix reaction adapters combine the per-operation timeout signal with runtime cancellation and forward it to API calls.

- [x] **Write failing tests** prefixed `matrix lifecycle` with explicit deferred promises: concurrent starts create one connection; repeated stops share completion; stop during whoami, crypto.start, initial sync and entered batch processing prevents late publication/dispatch and waits begun writes. A blocked real Bridge ask receives abort; API/crypto are released only after Bridge and reaction tails settle. A temporary poll error clears visible health and a later successful response restores it; a permanent error clears ready and ends the poll without scheduling a private reconnect timer.
- [x] **Write shared compatibility tests:** ordinary message processing and default `waitForIdle()` do not wait on a deliberately blocked reaction; `waitForIdle({includeReactions:true})` remains pending until the reaction finalization settles. Both modes must absorb best-effort reaction failures, not leak unhandled rejections.
- [x] **Run red:** `node --test --test-name-pattern="matrix lifecycle" test/channels/matrix/matrix-lifecycle.test.mjs` and the new shared test names in `test/channels/shared/text-harness-bridge.test.mjs`.
- [x] **Implement** stop admission→generation invalidation→abort→drain startup/sync/invites/Bridge/reactions→crypto cleanup→clear published dependencies. Remove local reconnect timer/index policy; keep abortable temporary-poll delay. Temporary poll failure sets `ready=false`, `connectionState='connecting'` and visible error while retaining the current loop; successful sync restores connected health. Check generation around asynchronous sync and crypto callbacks, not only after HTTP. Ensure stop does not await itself through a startup cleanup cycle. Update existing Matrix fake sync to honor AbortSignal; never hide deadlocks by manually draining it before testing real cancellation.
- [x] **Run green:** `node --test test/channels/matrix/matrix-lifecycle.test.mjs test/channels/matrix/matrix-runtime.test.mjs test/channels/shared/text-harness-bridge.test.mjs test/channels/shared/status-reaction.test.mjs`. Check runtime context/image fixtures for custom sync promises that now require cancellation-aware teardown.
- [ ] **Review task diff** for closed-generation side effects, crypto double-stop/free, queued Bridge work and parent-signal ownership; do not change reaction payload protocol or unrelated rendering in this task.

### Task 4: Controller 事务、关闭和真实 supervisor 集成

**Files:** Modify `src/channels/matrix/matrix-controller.mjs`, `plugin-src/host/channels/matrix/production.mjs` only if wiring requires it; update new `test/channels/matrix/matrix-controller.test.mjs`; create `test/channels/matrix/matrix-connection-supervisor.test.mjs`; retain `test/channels/matrix/production.test.mjs` image-resource coverage.

**Interfaces:** Existing bind/reconnect/delete method names remain. All mutation after the inspected stable bot identity is known runs inside `#withBotTransition(botId,operation)`; re-check closed state in that operation and around runtime creation. `close()` returns a shared drain task, rejects new operations, drains authorized transitions and then stops resources. Preserve deleteBot's boolean on complete success; if any cleanup fails, still attempt remaining cleanup and config removal, then throw code `matrix-cleanup-failed` with a localized message distinguishing removed configuration from partial state/credential cleanup, retaining structured causes and a `removed` flag. Do not silently report full deletion. `status()` adds `totals.configured`/`totals.connected`, retains existing counters, and derives readiness from configured bots actually connected.

- [x] **Write failing tests** prefixed `matrix controller`: close while runtime factory is paused cannot start a connection after release; queued bind/delete and failed credential rollback cannot overwrite a later operation; repeated close waits the same drain; one cleanup failure does not skip the other credential or configuration removal and becomes a visible error. Verify existing successful return fields and proactive IDs from Task 2.
- [x] **Write real integration tests** prefixed `matrix supervisor`: instantiate MatrixController and TokenConnectionSupervisor with only credentials/runtime/Harness transport stubbed. Inject timers with `retryDelaysMs:[123]` and `healthyIntervalMs:9876`; after initialization a missing-credential bot must schedule `123`, not `9876`. With one connected plus one missing bot assert `configured===2`, `connected===1`, `ready===false`; after permanent runtime failure clear readiness and verify a later supervisor reconcile creates exactly one replacement; temporary connecting/retrying state must not create a replacement while its current sync loop is alive.
- [x] **Run red:** `node --test --test-name-pattern="matrix controller|matrix supervisor" test/channels/matrix/matrix-controller.test.mjs test/channels/matrix/matrix-connection-supervisor.test.mjs`.
- [x] **Implement** the per-bot mutation scope, close checks/drain, all-attempted cleanup errors and corrected status counters. `initialize()` reuses a runtime in connected or active connecting/retrying state; it rebuilds terminal failed runtimes, rather than replacing every temporarily not-ready runtime. Remote identity inspection may precede the identity-keyed lock, but never read local rollback snapshots or write credentials/config outside the owning transition. Password inspection can create a remote device session; cancellation does not imply remote rollback. After inspection, re-check closed state under the lock before recording anything. Do not replace the controller with TokenBotController or change stable identities.
- [x] **Run green:** the two new test files, `test/channels/matrix/production.test.mjs`, `test/channels/shared/production.test.mjs`, `test/channels/shared/connection-diagnostics.test.mjs`, and `test/channels/weixin/connection-supervisor.test.mjs` using `node --test` with explicit file arguments. Ensure no cross-channel production behavior changes.
- [ ] **Review task diff**, especially removal errors visible through the existing RPC failure envelope, closed authorization points and supervisor ownership. Add missing EN/RU Matrix translations in this same task.

### Task 5: 合并回归、当前说明与隔离树构建

**Files:** Modify relevant Matrix paragraphs in `README.md`, `README.en.md`, `docs/方案/Matrix渠道接入方案.md`; regenerate affected `lib/index.js` and `lib/client.js` only by the existing build command in the isolated tree. Do not edit archived E2EE research or promise real interoperability.

- [x] **Run Matrix acceptance:** `node --test test/channels/matrix/*.test.mjs`; retain all crypto, context, room-history, image input/inbox/association and production tests. Verify no temporary directory is removed until task and store writes settle.
- [x] **Run relevant shared and route checks:** `node --test test/artifact-delivery.test.mjs test/delivery-adapter.test.mjs test/channels/shared/text-harness-bridge.test.mjs test/channels/shared/status-reaction.test.mjs test/channels/shared/delivery-message-ids.test.mjs test/channels/shared/i18n-coverage.test.mjs test/channels/shared/i18n.test.mjs test/channels/shared/media-queue-recovery.test.mjs`.
- [x] **Update docs** to state one fallback owner, real returned IDs, observable degraded connection and cancelled/drained shutdown; explain the new explicit refusal of known encrypted-room plaintext fallback. Keep the existing warning that E2EE is experimental and not verified against real homeserver/Element. Do not imply paused SDK research is completed.
- [x] **Build and verify only in isolation:** `npm run build`, then `node scripts/verify-package.mjs`, then `git diff --check`. Investigate nonzero exits; do not claim an unrelated baseline failure as fixed or silently run the full repository suite. Inspect generated artifact diff for accidental dependency/crypto removal.
- [x] **Run one fresh whole-branch review** against `d9fb1bd8`, prioritizing TDD evidence, unknown delivery effects, lifecycle ownership and retained E2EE behavior. Fix review findings and rerun only affected checks.
- [x] **Deliver** branch/worktree location, edited files, removed duplicate policy, actual command results and absent real-server verification. Verify the original merge tree remains untouched. No commit, push, merge or conflict resolution without separate user authorization.

## Self-review result

Spec sections 1–3 map to Tasks 1–4; acceptance conditions 1–3 map to Task 2, 4 to Task 3, 5–6 to Task 4, 7 to Task 1 and 8 to Task 5. Review Focus cases are pinned to explicit owning tests. Shared reaction waiting is opt-in; protocol re-exports preserve current imports; no auth/store format or E2EE dependency change is planned. The original merge conflict is an execution-isolation requirement, not a problem this change is authorized to fix.

## Execution choice pending

建议 Native：这些任务连续修改同一个 runtime，统一上下文可以减少接口漂移；保留最后一次独立分支审查。若用户选择 Subagent-driven，则每个任务由新的实现 agent 和 reviewer 完成，按上面的接口顺序交接。两种方式都必须先执行隔离步骤，不在当前 main 合并工作树修改产品代码。
