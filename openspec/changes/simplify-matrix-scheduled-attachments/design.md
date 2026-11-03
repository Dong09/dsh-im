# Design: 单一官方文字链路与定时附件扩展

## Context

动机与用户确认范围见 [proposal](proposal.md)，后继行为契约见 [spec](specs/matrix-scheduled-delivery/spec.md)。当前两个 worktree 都在 `7a73dd6a`，官方基线为 `dd500d24`；本轮只创建本变更工件，不修改代码或运行设置。

已核对的实际实现约束：

- [定时协调器](../../../plugin-src/host/schedule-relay-coordinator.mjs)在 `complete()` 中把 `state.text` 与附件放进同一 job；其新文字 part、自研最终文字发送及事件 WeakMap 是本次删除对象。
- [官方协调器](../../../plugin-src/host/session-sync-coordinator.mjs)已识别 schedule 服务回合、累计最后一次工具之后的最终文字并依照全局设置发送。它不提供非 RPC 文件消费者，也不保存旧 Session 的附件回复位置。
- [Registry](../../../src/channels/shared/semantic/artifact.mjs)的 `openTurnConsumer`、owner-checked stage/commit/take/close 及普通 RPC 的 `promptRpcId` 隔离仍是定时附件的必要权限边界。
- [RelayStore](../../../plugin-src/host/schedule-relay-store.mjs)已经读 v1/v2；v2 reader 接受 `text` 与 `artifact`，`attempt()` 的默认参数仍会构造文字清单，另有 legacy `finish()`。不能只删发送文字而留下默认文字 writer。
- [Adapter](../../../plugin-src/host/delivery-adapter.mjs)的 `listSessionSyncTargets` 仍默认只列私聊，但官方协调器也用它枚举文字目标；保存目标存在时，官方不会绕过目标策略退到绑定发送。这是文字职责统一前必须覆盖的具体路由缺口。
- [DeliveryService](../../../plugin-src/host/delivery-service.mjs)的审批／提问不仅用该枚举展示交互，还用其发送 Web／桌面兜底通知。直接扩大默认列表会把通知发进共享房间。
- [设置 RPC](../../../plugin-src/host/delivery-sync-rpc.mjs)和协调器使用同一 [单例 store](../../../src/channels/shared/delivery-sync-settings-store.mjs)。store 首次加载后缓存；外部改 JSON 或用另一个 Node 进程调用 store 并不能更新运行 Host 的缓存。

## Goals / Non-Goals

**Goals**

- 减少发送最终文字的实现数量，而不是增加第三种仲裁器。
- 保留现有附件能力、安全检查和状态格式；文字与附件拥有清楚、独立、可验证的结果。
- 在启用真实环境全局开关之前，证明当前 Matrix 文字路由可用且交互权限没有扩大。

**Non-Goals**

- 不实现其他渠道、Matrix 私聊或远程 Harness 的定时附件，不增加公开本地文件发送接口。
- 不提供跨进程附件重试队列、exactly-once、平台撤回或用户已读保证。
- 不恢复历史文字，不为旧 Session 增加新的官方文字路由，不改原生定时任务文本或目标。
- 不强制文字早于附件，也不让附件等待官方文字成功。
- 不回退 v12 标识、Matrix 图片输入、共享 Harness/Peer 生命周期或普通 IM 文件所有权修复。

## Decisions

### D1. 删除重复职责，而不是长期关闭其中一个发送器

官方协调器独占最终回答。自研删除 `textOf`、`state.text`、assistant/message 文字收集、文字 job/manifest 构造和发送分支；没有附件时结束并清理 lease，不调用 store.attempt 或平台接口。仍需将事件交给 registry 维持工具提交与生命周期观察。

同时删除 `completedDestinations` WeakMap、`deliveryDestinationFor`、Host 的 `resolveAnswerDestination`、通用同步和 service/adapter 的 `excludedDestination`、`matchesScheduledDestination` 及仅服务这些接口的测试。最终代码不应留下一个关闭但仍可恢复的自研最终文字路径。

**备选**：仅设置开关关闭自研文字实现更快，但残留第二发送器与未来开关组合风险；继续维护目的地排除协议保留了所有维护成本。选择移除重复发送责任。

### D2. 保留窄附件入口，明确拒绝文字

沿用现有私有 scheduled 单部分桥及账号／registration 授权，以减少无关重命名；在 normalize/service/adapter/controller 的实际边界收窄到 `ManagedArtifactPart`。不再接受 `TextPart`，但保持现有 Matrix 可选能力，不要求其他渠道实现附件接口，也不将它暴露到 facade、HTTP 或 RPC。

复用既有 `deliverOutboundArtifacts`、materialize/release、图片优先、明确拒绝才转文件一次和线程原生发送。附件失败的操作性通知可以继续，但不是模型最终回答，也不算附件成功。

**备选**：将附件塞进公开文字 send 能减少表面函数，却扩张文件读取权限；直接从 relay 新建 Matrix API 会重复凭据和取消逻辑。保留现有内部媒体桥。

### D3. writer 附件专属，reader 保留历史兼容

保持状态路径及 version 2，不做无必要的 v3 迁移。新 attempt 要求显式非空附件 manifest，移除默认 `[{id:'text',kind:'text'}]`；读历史 part 的校验继续接受旧 `text`。新写入的 manifest 校验与历史读取校验分清，防止仅通过默认参数意外创建文字任务。

v1 备份、原子提交、destination/conflict、最近尝试高水位、attempt/part identity 检查及 sending-before-side-effect 维持不变。历史 record 可在记住路由／兼容升级时原样保留；新回合正常推进 lastAttempt 不意味着重播旧清单。历史 `text`、混合清单及所有结果状态只能作为旧证据读取，不调用旧文字发送或 finish 来修补结果。legacy `finish()` 在全部调用点替换后若无实际用途则删除；不为保留旧测试而继续暴露废弃 writer。

空附件回合不新增持久化 attempt。重启不恢复旧快照、不从路径重新 stage，旧高水位也不会被新写入器降低。

**备选**：清空状态最容易删兼容分支，但会丢路由和防重边界；新版本号仅为“新清单只有附件”增加迁移成本。保留既有格式，仅收窄新写入行为。

### D4. 权限、旧路由和关闭排空仍归附件路径所有

保留同步 claim + awaited pre-step、可信自动来源白名单、mixed 的粘性撤权、普通 owner 优先、受控快照、工具权威 commit 和 owner-checked take/close。正常结束先 take 再 close，job 保留真实 artifact 对象，不等待上一回合网络发送才允许下一回合授权。

`matrix.scheduleReplies`、`scheduleReplyTimeoutMs` 保持键名和默认值，以减少迁移；文档将其职责收窄到附件。`beforeMatrixClose` 等关闭 hook 仍必须先停附件授权并排空，再注销 adapter/runtime/store，不因删了文字而一并删除。

已记录旧 Session 的附件 destination 继续可用；新旧候选冲突仍 fail closed，不按新 Session 改投。官方最终文字只使用它自己的当前绑定：旧 Session 在 `/new` 后没有当前文字绑定时，可以只有附件没有文字，不能把附件路径变成文字兜底。

**备选**：完全移除 turn lease 会使 schedule 的首次文件调用重新失去消费者；让旧附件跟随新绑定则可能泄露到其他线程。保留必要安全支撑。

### D5. 两条链路独立，不增加文字先发屏障

正常完成事件分别驱动官方文字与自研附件。附件之间保持登记顺序，但文字与附件相对顺序不承诺；文字失败或关闭不吞附件，附件失败也不触发文字补发。每个自研 attempt 的整体结果只描述其附件，不代表整次交互的文字与附件联合成功。

保留 service 普通文字发送中 `matrix-delivery-uncertain`／已有部分 providerMessageIds 映射为 `send-result-unknown` 的独立保护；这不是双发送器排除协议，不能一起回退，否则官方 markdown→plain 回退可能重发已送达分段。

**备选**：等待官方发送完成再开始附件能保留旧文字优先顺序，但需要新增跨链路等待、结果与关闭契约，抵消本次简化；选择独立完成并如实说明顺序变化。

### D6. 文字枚举显式扩展，交互枚举保持私聊默认

为 `listSessionSyncTargets(sessionId, {privateOnly = true} = {})` 在 adapter 和 DeliveryService 增加内部明确范围；仅官方文字协调器请求 `{privateOnly:false}`。显式 false 时使用现有 general conversation-key matcher；默认调用、审批／提问及其兜底通知仍走 private matcher。

Host 对 `deliveryService.listSessionSyncTargets` 的全局开关 wrapper 必须转发 options；两全局开关都关闭时，两种枚举都应返回空。现有 `sendSessionSyncText` 的启用状态、Session 匹配、stale/rebound 检查继续生效，privateOnly 的 describe/present guards 与 DS Bot 交互限制保持不变。

此修复仅让合法且已启用的保存房间／线程目标进入文字候选，不删除 `botHasSavedTargets` 的既有控制策略；保存目标存在但本会话没有启用／匹配候选时，不绕过目标配置自动绑定发送。实施验收必须覆盖并说明此情况。

**备选**：无条件扩大默认列表最短，但会扩大共享聊天接收交互通知的范围；另建一整套 text-target API 更明确但重复枚举。选择带安全私聊默认值的内部参数，外部接口不变。

### D7. 启用的是运行实例设置，不是发布默认值

代码与回归通过后，使用当前运行 Host 已认证的 management transport。现有 channel 为 `/dsh-im-delivery-sync`，外层 route 为 `/api/dsh-im/dsh-im-delivery-sync`，inner methods 为 `settings.delivery-sync.get`／`settings.delivery-sync.set`。

执行顺序：GET `{}` 记录原值 → SET 仅 `{deliverModelAnswers:true}` → 同一运行 Host 再 GET `{}`。读取结果必须确认回答开关为 true，`mirrorUserInput` 与两个 icon 保持原值；不主动启用输入镜像，也不擅自关闭用户已经开启的镜像，若原值为 true 则明确报告。设置为全局，不伪装成 Matrix 单机器人开关。协调器每回合缓存设置，验收使用读回之后的新回合。

不改 shipped defaults，不直接改 JSON，也不从单独进程操作同路径 store 来假装运行 Host 已更新。遵守现有 `rpcAuthority` 和认证；拿不到合法通道时把“当前实例未启用”作为明确未完成项，不能降权限或重启服务绕过。实际 home、路由可用性和当前开关在实施的只读预检中确认，不在提案阶段假称已完成。

**备选**：直接编辑磁盘看似方便，但已有单例缓存不会刷新，后续 Host 保存还可能覆盖；修改默认值则会让所有安装默认开始同步。选择现有运行时设置接口。

### D8. 决策翻转使用后继记录，不改写历史理由

实施时新建当前简化决定的 note，记录为何从“自研文字+附件”改为“官方文字+自研附件”、保留的安全不变量及真实验证。旧定时附件 note 只增加部分被替代的链接，不把其旧 Decision 改成反面或整篇归档：附件授权、checkpoint 和历史验证仍有价值。

已检索的关系：原定时附件记录部分重叠且文字职责被本次收窄；共享 Harness 生命周期、Matrix 非加密主线保留；既有生命周期消融提案不属于本次，不改变其状态。前 OpenSpec change 尚未归档，须在实施工件中链接本后继边界，不能以后把旧文字要求直接归档成现行主规范。

## Risks / Trade-offs

- [官方文本设置是全局开关] → 用户已确认该影响；只 patch 回答字段，记录原值并读回，不改其余字段或发布默认。
- [保存目标、远程 Harness 或旧 Session 无当前绑定仍可能没有官方文字] → 覆盖真实路由分支、输出清晰诊断；保留附件旧路由，但不偷偷恢复第二个文字发送器。
- [图片可能先于最终文字出现] → 文档明确独立顺序，不增加跨链路锁；附件间仍有序。
- [收窄新 writer 误伤旧状态] → v1 四状态、v2 text/mixed/artifact、旧 pending/sending/unknown、损坏和未来版本做只读/往返 fixture，原字节备份与高水位断言不可删。
- [交互范围被意外扩大] → 默认私聊参数及现有“群聊不收到交互和兜底通知”的回归必须保留；只在文字调用点显式 false，验证 Host wrapper 不吞参数。
- [将历史整体状态误报为新的文字成功] → 新状态只统计附件；文档与结果测试区分平台接受、操作性提示及官方文字结果。
- [关闭时媒体仍在途] → 保留原 abort/排空/晚到 owner 清理测试，不以固定 sleep 或 race 代替完成。

## Migration Plan

1. 在实施 worktree 记录基线和已跟踪改动，保留分支及状态安全副本；不覆盖另一 worktree 的新改动，不自动重写远端。
2. 先实现附件专属 job/writer/API 及对应回归，再同批删除双文字排除桥，避免中间态同时存在两个文字发送者。
3. 补齐显式文字目标枚举与私聊交互隔离测试；跑 relay/store/artifact、Host、Matrix、Session sync、authority/settings 和真实 headless 替身回归。
4. 创建后继 note、更新中英文说明和前变更的后继引用；执行 notes、OpenSpec 严格校验及 diff 检查，重建 Client/Host、包校验和 ESM 烟测；全量测试如实报告通过／失败／环境跳过。
5. 通过当前运行 Host 的正常接口只启用回答字段并读回，确认当前实例已加载目标代码；浏览器刷新不能替代 Host 重新加载，也不擅自停止服务。
6. 本变更不默认批准向真实 Matrix 群发送测试消息或创建真实提醒；若验收需要这些外部 side effects，先明确新任务、测试目的地和发送内容并取得许可。未执行真实发送时把“运行设置已启用”与“平台互通已验收”分开汇报。
7. 回滚优先恢复基线 `7a73dd6a` 及其完整双文字去重桥，而非恢复缺少桥接的更旧文字 relay；保留当前 v2 状态。仅在确认没有后续用户设置变更时，按记录恢复本次修改的回答字段，不覆盖其他设置，不补发历史任务。
