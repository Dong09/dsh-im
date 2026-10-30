# Proposal: Matrix 定时回合图片与文件投递

提案、开发与实施由 [composite 项目](../../../)及其专用会话管理。父级 `.pr-scratch` 会话用于跨项目讨论、工作树比较与统筹安排，原则上不直接实施子项目；本提案不扩展到其他同级项目。

## Why

2026-10-29 的实际 Matrix 会话中，定时任务按时触发并调用 `dsh_im_return_file`，却因该回合没有 IM delivery consumer 而注册失败，随后只能通过 `present` 在 Web 展示；直接 IM 请求则能登记同类附件。当前定时回群只发送最终文字，且把 Host 自动 `time-context` 快照误当成用户插话，附件缺失与文字误拦需要一起修复。

## What Changes

- 为真实原生定时输入、且具有唯一 Matrix 群聊或线程目的地的回合，在首个模型步骤前建立受控附件投递所有权；不从提示文本猜测来源，不伪造普通 IM 请求的 `rpcId`。
- 按结构化输入来源区分 Host 自动上下文与真实用户输入：时间、运行时等自动上下文不触发混合输入拦截；真正混合输入、绑定冲突及无绑定继续阻止自动回群。
- 回合成功结束后，复用现有附件快照、图片优先、明确失败转文件和 Matrix 原生上传发送流程，支持文字加附件及纯附件；已生成的图片直接按现有路径登记，不为发送而重新生成或重命名。
- 使用内部受控附件发送入口，不扩展现有文字 HTTP/RPC 接口为任意本地文件发送接口，不从助手 Markdown 或 Web 展示卡片自动抓取文件。
- 文字和每个附件分别记录发送状态与可用的平台回执；部分失败不能标记为整轮成功，结果未知不自动重发，重复事件和重启不能重复投递已尝试的回合。
- 补充来源分类、首步授权、路由隔离、生命周期、文件失败及状态兼容回归；更新中英文主动投递说明。
- 仅支持当前 Host 上已绑定的 Matrix 群聊与线程。保留原生调度器、既有工作区和凭据、旧 Session 的已记录回复位置；不补发历史任务，不新增其他渠道或远程 Harness 支持。

## Capabilities

### New Capabilities

- `matrix-scheduled-delivery`：Matrix 原生定时回合的输入识别、唯一目的地授权、文字与附件发送、生命周期清理和防重复状态记录。

### Modified Capabilities

无。当前项目尚无已登记的 OpenSpec capability；本提案不将代码中既有文字行为当作新的能力扩张。

## Impact

- 调度回群与状态：[schedule-relay.mjs](../../../plugin-src/host/schedule-relay.mjs)、[schedule-relay-coordinator.mjs](../../../plugin-src/host/schedule-relay-coordinator.mjs)、[schedule-relay-store.mjs](../../../plugin-src/host/schedule-relay-store.mjs)。
- 附件所有权与发送：[artifact.mjs](../../../src/channels/shared/semantic/artifact.mjs)、[artifact-delivery.mjs](../../../src/channels/shared/semantic/artifact-delivery.mjs)、[harness-client.mjs](../../../src/channels/shared/harness-client.mjs)、[delivery-service.mjs](../../../plugin-src/host/delivery-service.mjs)、[delivery-adapter.mjs](../../../plugin-src/host/delivery-adapter.mjs)、[MatrixController](../../../src/channels/matrix/matrix-controller.mjs)、[MatrixRuntime](../../../src/channels/matrix/matrix-runtime.mjs)。普通 IM 的附件所有权与工具成功才提交的语义保持不变。
- 兼容性：现有配置、`dshIm.send` 及文字 HTTP/RPC 请求格式不变；定时回群状态格式的演进必须兼容读取现有 version 1，并明确降级限制，不重写用户的原生定时任务。
- 验证与文档：既有 relay、artifact、Host 与 Matrix 测试及主动投递说明。无新增第三方依赖，无 Harness 核心或生图服务修改。
