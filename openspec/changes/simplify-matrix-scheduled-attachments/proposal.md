# Proposal: 官方统一文字同步，Matrix 自研仅保留定时附件

## Why

官方主线已经能把当前绑定 Session 的定时回合最终文字同步到 Matrix；继续保留自研最终文字发送器及两套文字发送器的目的地排除协议，增加了重复实现和升级耦合。用户确认保留定时图片／文件实际回群、旧 Session 的附件路由与附件防重，并由官方统一负责最终文字。

## What Changes

- **BREAKING**：自研 schedule relay 不再收集或发送最终回答，不再创建新的 `text` manifest part。最终文字仅由官方 Session sync 和 `deliverModelAnswers` 控制；`matrix.scheduleReplies` 保留现有配置键，但只控制定时附件授权与发送。
- 保留真实 schedule claim、首步附件 owner lease、自动上下文白名单、mixed/取消撤权、受控文件登记、Matrix 媒体发送、逐附件 checkpoint、未知结果不重发及关闭排空。
- 保留旧 Session → Matrix room/thread 的已记录附件目的地及历史防重高水位；v1/v2 旧状态（包括文字 part）兼容读取但不重播，不删生产状态、不自动补发旧任务。
- 删除因双文字发送器而加入的事件 WeakMap、`deliveryDestinationFor`、`resolveAnswerDestination`、`excludedDestination`、`matchesScheduledDestination` 等归属排除桥接，不用另一套去重协议替代。
- 内部 scheduled 单部分入口收窄到真实 managed artifact；拒绝文字和外部 path/URL/bytes。保留附件发送失败时既有的操作性提示，不把它当成最终回答或附件成功。
- 修复官方文字路由的已观测缺口：Matrix 房间／线程不能因为机器人已有保存目标却被私聊候选过滤而静默丢失最终文字；文字候选与审批／提问候选分离，不能把群聊变成可答题或可审批的目标。
- **行为变化**：文字与附件独立交付，不承诺文字先于附件；文字失败不吞附件。`/new` 后旧 Session 的附件仍可按原记录回群，但官方查不到当前文字绑定时不由自研兜底发送文字。
- 实施并验证后，经现有已认证设置接口仅 patch 当前运行 Host 的 `deliverModelAnswers: true` 并读回确认；它是全局开关，影响其他已绑定聊天的非 IM 回合。保留其余设置，不更改发布默认值，不直接修改进程缓存背后的 JSON。

## Capabilities

### New Capabilities

- `matrix-scheduled-delivery`：在尚无主规范的项目中，沿用前变更的能力标识，登记“官方最终文字 + 自研定时附件”的后继契约；不是新增一套并行功能。新 spec 明确替代前变更中“自研文字与附件同队列发送／文字优先／新文字检查点”的要求，保留附件授权、安全和防重要求。

### Modified Capabilities

无已登记的主 capability；`openspec list --specs --json` 当前为空。前变更 [matrix-scheduled-artifact-delivery](../matrix-scheduled-artifact-delivery/proposal.md)尚未归档，本次不把它误当成现行主规范，也不悄悄改写其历史设计；实施时补充后继关系，之后不得把旧文字要求原样归档成现行能力。

## Impact

- 核心简化：[schedule-relay-coordinator](../../../plugin-src/host/schedule-relay-coordinator.mjs)、[relay installer](../../../plugin-src/host/schedule-relay.mjs)、[RelayStore](../../../plugin-src/host/schedule-relay-store.mjs)、[Host 入口](../../../plugin-src/host/index.mjs)。
- 删除文字共存桥、保留内部附件桥：[Session sync coordinator](../../../plugin-src/host/session-sync-coordinator.mjs)、[DeliveryService](../../../plugin-src/host/delivery-service.mjs)、[adapter](../../../plugin-src/host/delivery-adapter.mjs)、[MatrixController](../../../src/channels/matrix/matrix-controller.mjs)。
- 附件与路由边界：[artifact registry](../../../src/channels/shared/semantic/artifact.mjs)、[共享附件交付](../../../src/channels/shared/semantic/artifact-delivery.mjs)、[MatrixRuntime](../../../src/channels/matrix/matrix-runtime.mjs)。保留普通 IM 的 promptRpcId 所有权、v12 标识、图片输入及共享 Harness 生命周期修复，不将无关代码一起回退。
- 测试：relay/Host/store/artifact/Matrix、[Session sync](../../../test/session-sync-coordinator.test.mjs)、[delivery service](../../../test/delivery-service.test.mjs)、[adapter](../../../test/delivery-adapter.test.mjs)、[现有共存组合](../../../test/schedule-session-sync-coexistence.test.mjs)、真实 headless fixtures；保留普通 Matrix 文字结果未知／部分已送达时不整段重发的独立保护。
- 设置与文档：复用 [delivery-sync RPC](../../../plugin-src/host/delivery-sync-rpc.mjs)及其共享 store，更新中英文主动投递指南和决策记录。无需新增依赖、Harness 核心改动或公开文件发送 API。
- 本轮仅生成规划工件；不修改业务代码、运行设置、分支历史、远端或正在运行的服务。实施入口为本变更的 apply。
