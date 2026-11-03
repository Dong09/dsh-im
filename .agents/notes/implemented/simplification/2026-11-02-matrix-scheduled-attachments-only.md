# Agent Note: 官方独占最终文字，Matrix 定时路径只交付附件

Status: implemented

## Problem

官方 Session sync 已能交付定时回合最终文字，自研继续保留文字发送器需要完成事件 WeakMap、精确目的地排除及跨发送器参数。两套实现必须一起升级，文字结果与附件结果也容易混淆。直接关闭其中一个开关只能隐藏重复职责，不能删除耦合。此外，官方候选枚举原本只面向私聊交互，保存 Matrix 群／线程目标后可能反而失去最终文字。

## Decision

[后继 OpenSpec 设计](../../../../openspec/changes/simplify-matrix-scheduled-attachments/design.md)把最终回答交给官方协调器，自研 relay 不收集 assistant 文字、不创建或发送文字部分；没有已提交附件时不建立 attempt。事件归属 WeakMap、Host 的 resolver、service/adapter 目的地排除桥一并移除，不用新的仲裁器代替。

私有 scheduled 入口只接受真实 WeakMap 身份的 managed artifact，不接受 TextPart、伪造对象、path、URL 或 bytes，也不进入 facade、HTTP 或 RPC。附件仍走原生 Matrix 媒体桥及共享图片优先策略。失败提示只是操作性通知，不是最终回答或附件成功证明。

新 writer 只接受显式、非空、全 artifact 清单；reader 继续读取 v1/v2 历史 text/mixed/artifact，不改版本号或清空库。legacy `finish()` 无生产消费者，因此删除；历史测试直接构造历史文件，而不保留废弃文字 writer。v1 原字节备份、原子提交、高水位、逐附件 sending-before-side-effect、迟到结果隔离及未知不重放保持不变。检查点故障位于媒体 closure 之外，停止后续发送并释放快照，不能误触发图片转文件。

`listSessionSyncTargets(sessionId, {privateOnly = true} = {})` 默认仍限私聊，只有官方文字协调器显式请求 false，Host wrapper 原样转发。已启用且仍匹配 Session 的保存房间／线程可成为文字候选；保存目标存在但禁用、失配、删除或改绑时，不绕过既有策略退回绑定发送。审批、提问及其 Web／桌面兜底通知不扩大到群聊。

`matrix.scheduleReplies` 只控制定时附件；官方 `deliverModelAnswers` 是插件全局文字开关。附件之间有序，文字与附件之间不承诺相对顺序或联合成功；文字失败、未知或关闭不授权自研文字兜底，也不单独丢弃附件。附件 attempt 状态不表示官方文字结果。旧 Session 附件路由在 `/new` 后仍可使用，但官方无当前文字绑定时可以只有附件。

首步 pre-step lease、可信自动上下文白名单、mixed 粘性撤权、普通 RPC owner 隔离、账号及 registration 复核、精确线程、取消与关闭排空均保留。普通文字 `matrix-delivery-uncertain` 或已有分段回执转 `send-result-unknown` 的保护独立存在，不随排除桥删除。

运行实例启用必须在目标实现加载后，经原有认证 management transport GET → SET 仅 `{deliverModelAnswers:true}` → 同实例 GET；保留输入镜像和 icons，不改发布默认值或磁盘 JSON。无法证明目标实现已加载或没有合法通道时，运行启用保持未完成；浏览器刷新不是 Host 重新加载的证明。

## 活跃笔记审计

新建本文前检索并阅读所有活跃 proposed/implemented/rejected 笔记（本仓库无 rejected 记录）：

- [原定时附件决定](../bug-fix/2026-10-29-matrix-scheduled-artifact-delivery.md)：部分替代。文字共队列和跨发送器排除桥不再采用；附件 owner、检查点、兼容与历史验证仍有独立价值。旧文只加后继链接，不把历史 Decision 写成反面或整篇归档。
- [共享 Harness 生命周期](../bug-fix/2026-10-29-shared-harness-consumer-lifetime.md)：相关约束保留，无决定翻转。共享适配器与 peer 持有纪律不属于本次减法对象。
- [Matrix 非加密主线](../bug-fix/2026-10-27-matrix-non-e2ee-mainline.md)：相关约束保留，媒体未知结果、单一回退、加密前拒绝及真实排空不变。
- [生命周期消融提案](../../proposed/simplification/2026-10-28-matrix-lifecycle-ablation.md)：无关，仍为 proposed；不实施其中 generation／任务集合等局部机制简化。
- [统一语义核心 ADR](../../../../docs/adr/0001-semantic-core-native-channel-adapters.md)：继续遵守，不新增公开文件能力，不替换普通 IM 语义。

没有旧记录被完全吸收、删除或归档。前 OpenSpec 变更明确链接本后继契约，不能把旧自研文字要求原样归档成现行主规范。

[图片引用撤回失效](../bug-fix/2026-11-02-matrix-image-reference-invalidation.md)以本文已交付代码为基线，只扩展入站引用生命周期；其回滚不得恢复旧文字发送器，入站操作提示也不得使用附件专属 scheduled 入口，不代做本文尚未完成的运行启用。

## Alternatives considered

1. **只用开关关掉自研文字。** 风险较小、切换快，但留下两套发送实现与开关组合，无法消除排除桥及维护成本；选择实际删除第二份文字职责。
2. **等待官方文字结果再发附件。** 保持旧文字先发体验，但需要新增跨链路完成、错误和关闭屏障，抵消简化收益；选择独立交付并明确顺序变化。
3. **无条件扩大默认候选列表。** 调用点改动更少，但审批／提问兜底通知也使用该列表，会把共享房间变成交互目标；选择安全默认和文字显式扩域。
4. **清空状态或升级 v3。** 前者易删除兼容分支，后者易区分 writer，但清空会丢失防重和旧路由，v3 则增加无必要迁移；保留 v2 并分开 reader/writer 校验。
5. **直接修改设置 JSON。** 无需运行接口，但缓存不会刷新且后续保存可能覆盖，不能证明实例生效；只走原认证接口并如实保留未完成项。

## Verification

实施基线为 `7a73dd6aaad1155afb1d7e06942c09af4504592d`，安全引用与隔离归档见[实施证据](../../../../openspec/changes/simplify-matrix-scheduled-attachments/implementation-evidence.md)。另一 worktree 未修改，没有操作生产 relay 状态或原生任务。

已执行 relay/store/artifacts 99/99、普通 artifact 系列 92/92、settings/management 28/28、职责分离组合 29/29；Host relay 12/12。真实 headless profile 使用脚本模型、临时 home 和平台替身，4/4 通过：原房间图片、线程图片、普通文件与直接 IM，均两次模型调用、零生图；schedule 仅一份官方文字与一个附件，直接 IM 官方与 relay 均零重复，不手动预开消费者或 sleep。

最终全量使用进程级规范 Windows TEMP/TMP：5,281 项中 5,274 通过、0 失败、0 取消、7 项环境跳过（五项 POSIX ffmpeg stub、一项真实 ffmpeg 缺失、一项平台权限检查）。初轮八项 Feishu 失败在隔离基线同样复现，规范化临时路径后基线与当前各 326/326 通过，未改无关代码；另两项 Matrix 旧文字入口测试按新契约迁移后，Matrix 全套 255/255。Client/Host 构建、包校验、文件式 Host ESM 导出烟测、notes tree/format/archive、OpenSpec 严格校验及 diff 空白检查均通过，详细命令和初轮失败记录见实施证据。

运行 profile 确实链接到本 worktree，但没有可证明新 bundle 已在内存加载的证据，也没有本会话可用的已认证 management transport（未认证只读探测为 401）。没有重启服务或规避认证，没有执行设置 SET／读回；原输入镜像及 icons 值未确认。用户在交付确认时明确选择先交付代码、暂不启用运行实例；任务 6.3/6.4 保留未勾选，等待后续运行验收。当前运行实例的设置启用尚未完成，真实 Matrix 发送未执行；上述隔离测试不能证明当前客户端收到附件。

## Consequences

收益是最终文字只有一个发送责任，删除跨发送器归属协议；附件权限、媒体安全和防重保持明确。代价是文字与附件可能以任意相对顺序出现，附件 sent 不代表文字成功；旧 Session 无当前文字绑定时不再有自研文字兜底。保存目标策略仍可能有意阻止文字，而不是把任意绑定房间自动授权。

没有跨进程快照恢复、历史补发、exactly-once、撤回或已读保证。回滚优先恢复基线及完整双文字排除桥，并保留当前 v2 高水位，不恢复缺桥的旧文字 relay。只有确认用户没有后续设置修改时才可按记录恢复本次回答字段，不能覆盖其余设置。若官方将来改变来源/绑定或文字候选契约，需重跑真实 Host 和组合回归，不能重新偷偷引入文字兜底。
