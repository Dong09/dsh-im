# Design: Matrix Scheduled Artifact Delivery

## Context

动机与确认范围见 [proposal](proposal.md)，外部行为见 [capability spec](specs/matrix-scheduled-delivery/spec.md)。提案保存在 [composite 项目根目录](../../../)的 OpenSpec 中，开发、测试及实施交由该项目的专用会话；父级 `.pr-scratch` 会话只承担跨项目讨论、工作树比较与统筹安排。不修改 Harness 核心、原生定时器或其他同级项目。

当前实现的约束：

- [relay coordinator](../../../plugin-src/host/schedule-relay-coordinator.mjs)将所有事件放入异步 tail，只有最终文字；仅排除运行时快照，实际时间快照会被当作其他输入。
- 原生 schedule 消息没有普通 IM 的 `rpcId`。现 [artifact registry](../../../src/channels/shared/semantic/artifact.mjs)仅通过 RPC 来源绑定消费者，且旧绑定与按回合清理不能隔离后来接管同回合的另一个所有者。
- [文件工具](../../../src/channels/shared/semantic/artifact.mjs)先复制受控快照，只有权威工具成功结果才 commit；`present` 与助手路径不是附件登记证据。
- [DeliveryService.send](../../../plugin-src/host/delivery-service.mjs)及 [adapter.sendText](../../../plugin-src/host/delivery-adapter.mjs)只返回布尔成功，不能表示附件回执；[共享附件交付器](../../../src/channels/shared/semantic/artifact-delivery.mjs)与 [MatrixRuntime](../../../src/channels/matrix/matrix-runtime.mjs)已拥有可复用的上传、图片回退、线程和未知结果处理。
- [现有 relay 状态](../../../plugin-src/host/schedule-relay-store.mjs)为 version 1，仅保存目的地、冲突及最近回合尝试。现有写入前 checkpoint 和失败不重放的原则继续保留。

## Goals / Non-Goals

**Goals**

- 让唯一绑定的 Matrix 定时回合在第一次调用文件工具时就能登记附件，回合完成后按既有媒体策略投递。
- 用真实输入归属和不可混用的所有者句柄隔离普通 IM、定时回合与自动上下文。
- 逐部分保存结果，关闭、取消、写盘失败和重启均不导致重复发送或跨目的地发送。

**Non-Goals**

- 不实现其他渠道、Matrix 私聊或远程 Harness 的定时附件；不增加外部文件发送 HTTP/RPC。
- 不自动从 Web deliverables、Markdown、历史工具输出中恢复待发送文件；不补发旧任务，不重建丢失的图片。
- 不承诺平台网络请求的 exactly-once 或“用户已阅读”；未知结果采取不自动重发，接受需要人工确认的代价。
- 不改变两个普通 RPC 请求之间既有的排队策略；只增加定时所有者与普通输入相遇时所需的隔离。

## Decisions

### D1. 同步记录 claim，使用可等待的 pre-step 完成首步授权

Host 的实际顺序为：同步 claim 通知、prompt assemble、可等待的 `agent/pre-step`、首请求前 refreshContext。`agent/inbox/claimed` 的异步返回不会阻塞执行，因此该回调只同步记录 `(sessionId, turn, message.id)`、真实 `source.kind === schedule` 和混合输入标志，不做异步绑定发现。

在全局 `agent/pre-step` 中等待已有 `captureBindings` 完成，取得唯一有效的持久化路由；随后重新核对 turn、输入代次、未关闭、取消信号及混合标志，条件仍成立才开定时 lease。waterfall 必须调用 `next()` 并保留其原有决定。无绑定、冲突或路由读取失败时记录原因、不开权限，不擅自改写原生任务或目标。

`dsh-im:return-file` 的 context 注册保持存在，空文本也允许刷新；首请求前的 Host refreshContext 会根据新 lease 重算指引。实施必须验证真实 Host 的 claim → assemble → pre-step → refresh → request 顺序及第一调用成功，不能用“先手动开消费者再调用工具”的假顺序替代。

**备选**：claim 时只使用启动预热的同步路由，可以更早授权，但第一次触发和新增绑定容易被误拒；claim 时 await 路由则没有真实执行屏障。选择可等待的现成 hook，避免修改核心或依赖旧缓存。

### D2. 混合输入是本回合的粘性拒绝状态

正常权限以真实 inbox claim 为依据，而不是把全部 `user/message` 当成人类输入。durable 事件仍负责恢复本轮最终文字与结束事实；如为兼容保留来源分类，只接受已知 producer/form 的自动上下文：运行时和时间快照、Host 技能目录、插件的上下文快照或通知，不能把任意 `form: snapshot` 或正文前缀当作可信来源。

在 schedule 前、后或后续 step 中 claim 到真实普通输入，均将该 `(sessionId, turn)` 永久标为 mixed，撤销定时 lease，之后即使再次看到 schedule 也不重开。若普通 IM 有自己的消费者，可按其原路径继续；本插件不发送第二份自动定时回复。仅存在尚未 claim 的未来普通请求不构成本轮混合输入。

**备选**：删除 mixed-input 判断最省事，却可能将私有插话或普通回复重复发回群；保留现有“非 runtime 一律其他输入”则重现本次时间快照缺陷。选择真实 claim 与受限自动来源识别。

### D3. 增加非 RPC 的、所有者受检的回合附件 lease

在 [artifact registry](../../../src/channels/shared/semantic/artifact.mjs)增加显式 turn consumer 能力，返回仅在当前进程有效的 owner lease，含本轮受检的 take/close；不伪造 `rpcId`，不扩大文件工具参数，也不借此授予群历史读取或交互答题权限。

- schedule 不能覆盖本回合已有普通 IM owner。普通输入接管或混入时，定时 owner 失效；旧 schedule 暂存和已登记文件不能流入新普通 owner。
- stage、权威 tools/result commit、take 和 close 都核对 owner 身份。内部快照记录关联 owner；旧 lease 的晚到 commit、take 或 close 不能消费、提交或删除新 owner 的文件。
- [HarnessClient](../../../src/channels/shared/harness-client.mjs)的普通 RPC 消费可携带原有 prompt 身份核对自己的 take，不改变其工具成功才入队、回合结束才发送的用户行为。
- 保留受控快照、文件变化检查、两阶段工具提交、Code Mode 外层成功确认、materialize/release 规则；不扫描路径补登记。

**备选**：制造一个 RPC id 让旧逻辑“看起来绑定成功”，会混淆真实来源且容易抢占普通请求；无 owner 的按 turn 清理会误删接管者文件。增加明确 lease，而不是放宽原来的无消费者拒绝。

### D4. 同步回合账本与异步发送任务分离

[relay installer](../../../plugin-src/host/schedule-relay.mjs)同步维护按 `(sessionId, turn)` 区分的 claim、最终文字、路由快照、lease 和关闭状态。不要继续让 Promise tail 中尚未执行的 `turn/start` 成为 claim 授权的前提。

正常 completed 且本轮仍有资格时，冻结独立 delivery job：最终文字、路由身份、已确认附件、去重标识和发送取消状态。有附件但无文字时也创建 job。路由与 manifest 可复制冻结，但 artifact 必须保留 registry 的真实对象身份，不能 structuredClone 或 JSON 重建；其快照由私有 WeakMap 管理。registry 的结束观察必须在 lease 存活时保留文件；先 take 完成交接，再关闭原 turn lease。job 进入现有每 Session 串行发送队列，下一回合的 claim 不等待上一回合平台发送，也不能覆盖上一个 job 的所有者或清理状态。

失败、blocked、取消、mixed、无绑定、冲突、零产物、checkpoint 拒绝及卸载分支均 finally 关闭自己的 lease 并释放未交付快照。已交给 provider 的快照由交付器释放，避免双重所有权。关闭只清理 schedule 所有者，禁止调用全 registry clear。

### D5. 插件内部增加单部分发送入口，复用原生媒体策略

为 relay 增加仅同 Host 内部可用的窄入口，概念签名如下；最终符号名由实施保持一致：

```text
sendScheduledPart(botId, frozenTarget, TextPart | ManagedArtifactPart, options)
  -> structured receipt
```

入口位于 delivery service → adapter → MatrixController → MatrixRuntime，继续使用已连接的 runtime、现有凭据和生命周期信号。它只接受本轮已认领的受控 artifact 对象，不接受模型提交的任意路径；不加入公开 `ctx.dshIm` facade，不挂到外部 HTTP/RPC，也不改现有 `dshIm.send` 的文字请求格式。adapter 能力为 Matrix 可选能力，不加入所有渠道必须实现的方法集合。

文字部分保留原生 provider message ids，不再经布尔 `im.send` 结果判定整轮成功。附件部分一次只传一个 artifact 给 `deliverOutboundArtifacts`，由其执行 materialize、图片优先、明确失败后最多一次文件回退及 release，再把该附件的完整结果交回 coordinator。原生入口只包装现有媒体函数，统一适配 `fileName` 与原生 `name` 字段，保留房间/线程关系、真实 `event_id` 及 `artifact-delivery-uncertain`，不通过通用错误包装抹成明确失败。

不直接构建新 MatrixApi，不读取凭据另发请求，不增加原生层重试。已知加密房间缺少加密能力时维持零上传和零明文发送。

**备选**：把 attachments 塞进现有文字 send 在当前接口上不存在，且会扩张外部调用面；relay 直接读凭据发媒体则重复实现校验与生命周期。采用内部单部分桥接以复用既有实现并方便写入独立 checkpoint。

### D6. Checkpoint 在发送器之外，不能变成图片回退的触发条件

发送顺序为最终文字（若有）及登记顺序的附件。文字发送明确失败或结果未知本身不重新执行模型，也不重发文字；在渠道仍可用、未取消且 checkpoint 可写时，可继续尝试尚未提交的独立附件，保持普通 IM “文字失败不吞附件”的行为。取消、身份/目标不再可信或本地状态持久化失败则停止后续 side effects。

每一部分执行：先原子记录 sending → 调单部分发送入口 → 取得结果 → 在交付器外原子记录终态 → 才处理下一项。绝不能在 sendImage/sendFile closure 内追加 checkpoint 写入：图片已经成功、随后本地写盘失败，若抛回共享交付器会被误认为图片明确失败，从而再次发文件。checkpoint 异常是本地持久化故障，停止剩余发送，保留先前 sending/unknown 防重，并释放剩余快照，不进入媒体回退。

不使用 `userVisible`、非空消息 ID、布尔 sent 或现有 merge receipt 的默认值计算整体结果。整体 sent 仅当全部必需部分确认 sent；任一 sending/unknown 则整体 unknown；无未知但有 failed/skipped 则 failed。失败通知是诊断，不是附件成功的证据；通知本身失败也必须保留 Host 日志与状态记录。

**备选**：任一文字失败就丢弃所有文件虽简单，却使能正常发送的文件被文字故障吞掉；仅按一条布尔回执标记整轮成功则隐藏本次附件失败。选择逐项结果，但不新增自动重试服务。

### D7. 明确演进状态格式，保留不重放原则

将 [relay store](../../../plugin-src/host/schedule-relay-store.mjs)扩展为 version 2：保留每个 Session 的 destination、conflict 和 lastAttempt 高水位；lastAttempt 增加已冻结的部分列表，各部分包含稳定 id、类别、发送状态、必要的附件摘要、可用 provider message ids 与安全错误码。不保存凭据、图片字节、完整提示词或任意本地绝对路径。

- 文字 id 为 text；附件 id 从当前成功登记的 artifact 身份得到，不靠文件名猜测去重。每项状态更新核对 session、turn、attempt 和 part identity，迟到的旧结果不能覆盖较新的回合或另一个部分。
- 在任何文字请求、媒体上传前，整轮发送意图和组成部分清单必须先落盘；每部分开始前再落 sending。整轮重复完成事件不得重建发送队列。
- version 1 读取保持原目的地、冲突和 lastAttempt 语义；保留原文件备份，首次 version 2 写入原子提交。旧 sending/failed/unknown/sent 均保持已尝试，不据新字段缺失而重发。
- 进程重启后，不自动恢复历史附件，不补 pending/sending 部分，不从原路径重新 stage。sending 为结果未确认，不伪造 failed 或 sent；代价是崩溃时尚未提交的文件也需要用户发起新的明确请求。
- 损坏、未来未知格式或备份/写盘失败必须报错，不能清空状态继续发送。实现前将 version 1 fixtures 与所有校验读写者一并列入测试。

**备选**：在 version 1 中静默追加多媒体字段可能被旧写入者剥离，且不便明确降级边界；丢弃旧检查点则可能补发历史消息。采用显式版本与安全读取，不改原生 schedule 存储。

### D8. 关闭先停止授权，再等待已接受交付结束

复用 [Host 的 beforeMatrixClose](../../../plugin-src/host/index.mjs) 与 [channel startup 的关闭次序](../../../plugin-src/host/channels/shared/startup.mjs)，在注销 delivery adapter 或停止 Matrix runtime 前停止新 admission、撤 hook、取消尚未派发的工作并等待已接受 job 收尾。路由刷新、文件准备等异步续点重新检查 closed/代次，禁止关闭后新建 lease。

发送继续使用已有 `scheduleReplyTimeoutMs` 和 Matrix 生命周期取消。已开始的原生发送不能被描述为已由 abort 撤回；有真实回执时保留真实结果，否则按未知处理。所有 store、lease、快照均在其最后使用者结束后释放。

## Risks / Trade-offs

- [pre-step 位于 assemble 之后] → 用真实 Host 顺序测试证明 refreshContext 在首请求前重算指引；如果当前支持版本不具备此能力，停止实施并修订方案，不用延时冒充屏障。
- [同回合从 schedule 切到普通输入] → owner 身份贯穿暂存、commit、take、close；做顺序相反、晚到 commit 和旧 close 的交错测试。
- [部分发送后发生磁盘故障] → sending 在外部副作用前持久化；写盘异常不落入媒体回退，接受人工确认而非自动修补。
- [每部分一次以上原子状态写入增加 I/O] → 只处理实际登记部分，复用串行 store；不做固定间隔轮询或新服务。
- [附件快照是进程期资源] → 关闭主动释放；重启不按历史路径重造或补发，文档明确不提供持久化附件重试队列。
- [关闭或取消恰好与服务端成功交错] → 保留可确认回执，无法确认则 unknown，不宣称成功回滚或 exactly-once。

## Migration Plan

1. 在隔离测试 home 中准备真实 version 1 路由、经典/v12 房间、线程及四种既有 lastAttempt 状态，验证兼容读取、备份、原子升级及损坏拒绝。
2. 通过单元、Host 顺序、组合及产物烟测后构建 dsh-im Host；不修改生产工作区、凭据、任务文本或已有任务状态，不自动补发本次猫图。
3. 由用户选择时机重新加载当前 Host，在原 Matrix 群与线程创建新的短任务，先登记已有测试图片，再验证普通文件；区分模型完成时间与平台发送结果。
4. 降级到只读 version 1 的旧版本前，先关闭定时回群并停止当前 Host；不能把 version 2 文件直接交给旧读取器或删除它后重启。若必须恢复备份，在隔离副本验证，且所有已在新版本开始的任务保持禁用，避免旧备份缺少新高水位而重发；保留新状态供人工核对。正常回退选择保留新状态、关闭定时回群并修复前滚，不自动降级或重放。

## Decision Record Links

[定时附件实施决定](../../../.agents/notes/implemented/bug-fix/2026-10-29-matrix-scheduled-artifact-delivery.md)记录本设计落地的授权、逐部分状态和发送器外 checkpoint 取舍及验证缺口。

[共享 Harness 生命周期修复](../../../.agents/notes/implemented/bug-fix/2026-10-29-shared-harness-consumer-lifetime.md)部分相关：复用其资源所有权纪律，不重新改写已实施决定。[Matrix 非加密主线](../../../.agents/notes/implemented/bug-fix/2026-10-27-matrix-non-e2ee-mainline.md)部分相关：保留未知结果不回退、加密拒绝和真实资源排空。[生命周期简化提案](../../../.agents/notes/proposed/simplification/2026-10-28-matrix-lifecycle-ablation.md)不在本批实施范围；没有既有笔记被替换或归档。
