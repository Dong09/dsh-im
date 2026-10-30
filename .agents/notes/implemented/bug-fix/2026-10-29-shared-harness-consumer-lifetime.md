# Agent Note: 共享 Harness 适配器与调用身份跟随全部使用者存活

Status: implemented

## Problem

Matrix 房间在切换机器人工作区后可能只留下“正在处理”，而 Harness 会话已经完成。此次现场会话在 2026-10-29 11:00:43 正常生成最终回答，但没有终端诊断可以确认事件监听、请求取消或平台发送中哪一段先失效。群历史授权失败在更早的成功回复中已经出现，不作为这次丢回复的根因。

调查发现一条独立且可复现的缺陷链：`modernHarnessApi` 与 `harnessPeer` 按 Host root 共享，但清理由第一个调用者的上下文持有。该上下文卸载时，仍在运行的另一个渠道失去事件监听和可用 peer；旧适配器仍返回健康。`session.page` 严格读取 `throughSeq` 指定的历史切面，因此停止推进的本地游标让新工作区会话的最终回答一直不可见。普通整插件关闭会同时停止 Matrix，不等于触发了这条“部分上下文卸载”路径；现场缺少相应卸载证据，不能把可复现缺陷直接认定为当次事故的唯一原因。

## Decision

[共享资源持有器](../../../../plugin-src/host/shared-host-resource.mjs)按 Host root 缓存资源，并为每个实际消费上下文登记一个可释放持有关系。同一上下文重复获取不增加持有数；最后一个使用者释放后才从缓存移除并销毁资源。peer 的异步销毁结果交回 Cordis 等待。

[适配器](../../../../plugin-src/host/modern-harness-api.mjs)的事件监听挂在 Host root，而不是第一个渠道的可卸载上下文；gateway 与 Connection 也通过 root 读取。Connection 的 `createPeer` 会把 peer 自动绑定到读取服务的上下文，因此只延长本地缓存、却仍从第一个渠道读取 Connection，真实 peer 仍会被提前销毁。每次获取适配器，包括命中缓存时，都通过 [harnessPeer](../../../../plugin-src/host/harness-peer.mjs)登记当前上下文对调用身份的持有；root 创建的 peer 仍由最后一个实际使用者主动释放，不永久保留。

最后一个使用者卸载后，旧适配器的 RPC、事件订阅和交互响应入口以 `harness-adapter-disposed` 拒绝新请求；健康检查不再谎报 ready。重新加载获得新资源，不复用已释放实例。现有工作区、房间映射、历史记录、凭据及投递检查点格式不改变，也不自动重连或重放已接受的模型请求。

## Verification

[真实 Cordis 回归](../../../../test/host-shared-harness-lifecycle.test.mjs)只替换外部 gateway 和 Connection peer，保留真实插件上下文卸载、共享适配器、事件分发与资源释放。page 替身按实际 Host 的 `throughSeq` 截取，不能无条件返回全部事件。

| 行为与来源 | 正常或边界断言 | 异常或交错断言 |
| --- | --- | --- |
| 适配器跨上下文共享；原 `modernHarnessApi` root 缓存 | 两个使用者取得同一实例；同一上下文重复获取不泄漏 | 首个上下文卸载后，另一渠道继续读到用户、最终回答与 completed 事件 |
| mux 监听存活；原 `ModernHarnessApi` 订阅 | 订阅收到精确事件值 | 首个上下文卸载不能令另一使用者的等待返回 done |
| peer 共享；原 `harnessPeer` root 缓存 | 直接命令与适配器复用同一未取消身份 | 任一使用者卸载后其他调用仍持有效 peer；最后释放仅销毁一次 |
| 适配器终止与重建；原 `dispose` | 最后释放后重建不同实例并读到完整历史 | 旧实例拒绝健康、历史和订阅等新工作，不能继续读取旧切面 |

新增回归在修复适配器之前观察到三项失败：历史返回空页、存活渠道 mux 提前关闭、旧健康检查不拒绝。首次 peer 持有修复已先落盘，因此不把该轮 peer 通过误记为旧实现通过。审查补入真实 Cordis Service 的读取者自动拥有 peer 行为，先确认首读取者卸载导致取消的回归失败，再修正为 root 读取。

两项反向探针分别暂时移除最后使用者检查、将 Connection 改回从首渠道读取，均触发对应的提前销毁断言；探针随后原字节还原，未保留变异源码。五个相关测试文件合计 124/124 通过。另通过本机 Harness checkout 的真实 `HostConnectionService` 与 `Peer` 执行无网络烟测，确认共享、首使用者退出、最后释放与重新创建的行为。

最终执行 `node --test test/channels/matrix/*.test.mjs test/channels/shared/text-harness-bridge.test.mjs test/host-shared-harness-lifecycle.test.mjs test/host-harness-peer.test.mjs test/host-modern-harness-api.test.mjs test/conversation-bindings.test.mjs test/host-harness-connection.test.mjs test/host.test.mjs`，452/452 通过，无跳过。`node plugin-src/host/build.mjs` 与 `node scripts/verify-package.mjs` 通过；仅重新构建 Host，不改 Client 产物。只读复审未发现阻断项，额外验证旧资源异步释放未结束时重建不会误删新实例。这些证据仍不代表真实 Matrix homeserver 已验收。

## 与既有记录的关系

检索活跃笔记及 ADR 后，[Matrix 非加密主线](2026-10-27-matrix-non-e2ee-mainline.md)与本次部分重叠：其停止排空、未知结果不得盲目重发等要求继续成立；本文修复 Host 共享资源所有者，不改变原生 Matrix stop。[生命周期简化提案](../../proposed/simplification/2026-10-28-matrix-lifecycle-ablation.md)只涉及 Matrix runtime 和 controller 内部机制，与本次 Host 资源持有不同，不实施或改写该提案。[统一语义核心与渠道原生适配](../../../../docs/adr/0001-semantic-core-native-channel-adapters.md)保留；没有既有决定被吸收或归档。

[定时附件所有权与逐部分防重](2026-10-29-matrix-scheduled-artifact-delivery.md)继续使用本文的资源持有纪律；其回合 lease 与本篇 Host 共享资源所有者不同，不替换本篇决定。

## Alternatives considered

1. **每次 latest history 都重新取得 snapshot。** 不依赖进程内事件推进游标，能消除读取旧切面的风险；但不能恢复被提前关闭的交互订阅，也不能使已释放的 peer 重新有效，并增加现有轮询路径的 snapshot 与投影工作。本次修复共享所有权，保留现有历史分页读取方式，不把刷新历史当作生命周期修复。
2. **每个渠道各建一份适配器。** 生命周期可以局部管理，但会重复注册全局问答和审批监听，改变共享交互的所有权语义。本次保留 Host 级共享，只修正其持有关系。
3. **由 Host root 永久持有全部资源。** 实现简单且不会被某个渠道提前清理，但插件卸载后会残留监听、待回答交互及 peer。采用显式消费持有，最后释放时完整清理。

## Consequences

收益是部分渠道卸载不再破坏仍在运行的渠道，且失效资源立即报错而非等待回复超时。代价是增加跨上下文持有管理与对应交错测试；监听虽然注册到 root，但仍必须由最后使用者显式移除。外部 gateway/Connection 服务整体更换仍需其依赖上下文正常卸载，不能用本地持有延长已经失效的外部服务。

本次不重置机器人、不改生产配置、不补发旧消息。需要加载重新构建的 Host 后，在原 Matrix 房间发新的短消息验收；浏览器刷新本身不能替换运行中 Node 进程已经导入的 Host 代码。现场事故原因与真实房间送达在该验收前保持未确认。
