# Agent Note: Matrix 非加密主线的投递与生命周期收敛

Status: implemented

## Problem

Matrix 的原生附件发送与共享交付层同时拥有图片转文件策略，明确失败可能引发第三次发送，事件派发后的网络故障又可能触发重复投递。成功回执丢失服务端事件 ID，会破坏结果文件与机器人事件的关联。

连接管理的风险来自不同的完成条件：取消请求不等于在途任务结束，等待预算用完不等于可以释放 API／crypto；暂时未就绪不等于当前轮询已经终止；已创建 runtime 的数量不等于已配置机器人的数量。控制器若只串行切换 runtime，却在锁外写凭据或回滚，关闭、重新绑定与删除仍可能互相覆盖。

用户选择先优化非加密房间，保留 E2EE 并继续研究其支持方式。因此本批需要修正发送、关闭和状态语义，而不是通过禁用加密、迁移全部协议实现或重写所有渠道控制器来绕开这些问题。

## Decision

### 投递策略只由共享层拥有

共享 `deliverOutboundArtifacts` 负责图片优先、明确失败后最多转一次文件；Matrix 原生 `sendImage`、`sendFile` 每次调用只尝试一种事件类型。原生事件发送保留服务端 `event_id`，文本分段、主动文字与附件通过 `providerMessageIds` 传递真实回执，不用 `{ sent: true }` 代替已取得的消息标识。

上传失败属于消息提交前失败，但不承诺远端没有残留媒体。事件派发后的网络断开、超时、5xx、无效响应或无有效事件 ID 属于结果未知，保留原始原因，禁止通过新事件补发文件。Matrix 使用 `matrix-delivery-uncertain` 表达原生派发未知结果，附件边界转换为共享层识别的 `artifact-delivery-uncertain`。API 内部的 429 重试复用同一事务 ID，不与改类型重发混为一谈。

### 停止完成以任务排空为准

runtime 为每次连接持有取消信号，并通过 generation 检查拒绝过期异步续点。start 与 stop 分别复用在途完成任务。stop 先停止接收新工作并取消，再等待已接收的启动、同步、邀请、原生发送、出站工作和 Bridge 收尾，之后才停止 crypto、刷新存储和清空依赖。固定时长的 Promise.race 不能充当工作已完成的证明；已经提交的远端事件也不能被描述为已由取消撤回。

共享 [TextHarnessBridge](<../../../../src/channels/shared/text-harness-bridge.mjs>) 的 `waitForIdle({ includeReactions: true })` 显式等待 reaction 尾任务；默认调用不等待这些尾任务，保留其他渠道的现有完成语义。Matrix 同时跟踪底层原生 reaction removal：状态反应自己的超时结束，不代表其原生请求已经结束。

### 重建只有一个所有者，健康状态反映所有配置

暂时同步失败设置 `ready=false`、`connectionState=connecting`，保留当前轮询及其可取消退避；永久失败结束轮询并报告 failed，由共享 supervisor 经 controller 重建。runtime 不安排另一套私有重连定时器。initialize 复用仍在连接或轮询重试中的实例，不因 ready 为 false 就替换它。

`totals.configured`、`totals.connected` 按全部已配置机器人统计；顶层 ready 只有在存在机器人且全部连接时才为 true。同步恢复只清除自身连接错误，不抹掉图片处理状态写入等其他未恢复诊断。

### 本地变更覆盖完整事务，破坏性清理先取得资源控制权

[MatrixController](<../../../../src/channels/matrix/matrix-controller.mjs>) 按稳定 botId 串行执行凭据快照、写入、配置保存、回滚、runtime 切换与删除。快照读取失败必须拒绝后续替换，不能当作原凭据为空；重新绑定保留房间策略与加密配置。关闭同步禁止新操作，等待已接收事务及晚到工厂的资源清理，不允许关闭后再启动连接。

已有 runtime 停止失败时，不启动替代实例，也不删除可能仍被使用的凭据或密钥。成功停止后，删除尝试各项状态、凭据及配置清理；部分失败通过 `matrix-cleanup-failed`、聚合原因和 `removed` 报告，不能把配置已移除等同于全部清理完成。完整删除返回布尔值。回滚失败使用 `matrix-bind-rollback-failed` 并暂停自动复用不可信状态。

远端身份检查可以先于本地 botId 事务；密码检查可能创建服务端会话，本地取消或回滚不承诺撤销远端登录。检查完成后仍须在事务内重新确认关闭状态。

### 协议规则共享，但入口权限不扩张

凭据检查与 runtime 启动复用 `performMatrixPasswordLogin`，保留密码接入、设备 ID 和错误分类，不自动改成 token-only。没有调用者的 `MatrixApi.login` 重复包装移除。用户、房间、事件 ID 使用 [纯校验模块](<../../../../src/channels/matrix/matrix-identifiers.mjs>)，并保留 API 原有校验导出。

Host 主动投递与建议支持 v12 实际房间 ID、旧式房间 ID 和合法线程标识；主动投递不因通用协议校验支持 alias 而接受房间别名。稳定 botId、credential reference 和持久化格式保持不变。

### E2EE 保留，不允许已知加密房间明文降级

保留 `@matrix-org/olm`、默认 optional 模式、crypto 实现与身份校验，不自动删除、重建或迁移用户密钥状态。已知加密房间缺少可用 crypto 时，文本明确拒绝，附件在读取上传前拒绝；有 crypto 时继续使用现有加密路径。

运行时定向错误还必须进入 [共享消息失败分类](<../../../../src/channels/shared/message-failure.mjs>)。`matrix-delivery-uncertain` 和 `matrix-encryption-unavailable` 使用各自的公开文案，不能退化为通用“原因未知，请重试”，否则会诱导用户对未知结果盲目重发。

## Verification

首次决策日期为 2026-10-27，本笔记于 2026-10-28 补录。当前可追溯实现提交为 `1b232261`，原实施说明同步提交为 `2ad3f672`。以下是实施阶段的验证记录，不是本次文档补录重新执行的结果：

- Matrix 全套 234/234、受影响共享测试 145/145；构建、包校验与空白检查退出 0，真实 libolm 本地环回测试执行而非跳过。
- [投递测试](<../../../../test/channels/matrix/matrix-runtime.test.mjs>) 覆盖明确拒绝不产生第三个事件、派发结果未知不转文件、事件 ID 与附件后续回复关联、加密不可用时零上传及零明文消息。
- [生命周期测试](<../../../../test/channels/matrix/matrix-lifecycle.test.mjs>) 通过受控 Promise 验证挂起启动、sync、持久化、邀请、发送及原生 reaction removal 的关闭交错，不用 sleep 推断资源已结束。
- [控制器测试](<../../../../test/channels/matrix/matrix-controller.test.mjs>) 与 [真实 supervisor 集成测试](<../../../../test/channels/matrix/matrix-connection-supervisor.test.mjs>) 覆盖关闭中的延迟工厂、凭据回滚、清理失败、配置总数及暂态循环复用；[公开失败分类测试](<../../../../test/message-failure.test.mjs>) 验证两个 Matrix 定向错误的用户提示。

本地测试不等于真实 homeserver／Element 互通验收；该环境尚未验证。2026-10-28 消融面板中的新增行为检查也不能冒充已经纳入本批正式测试，相关差距由后续提案记录。

## 与既有记录的关系

- [统一语义核心与渠道原生适配](<../../../../docs/adr/0001-semantic-core-native-channel-adapters.md>) 保留：共享策略与原生单次投递遵循其既有语义不可降级的约束。
- [原设计](<../../../../docs/superpowers/specs/2026-10-27-matrix-non-e2ee-mainline-design.md>) 和 [五任务计划](<../../../../docs/superpowers/plans/2026-10-27-matrix-non-e2ee-mainline.md>) 保留为需求和执行记录；本文集中保存长期取舍与安全要求，不复制实施流水账。
- [生命周期消融与简化提案](<../../proposed/simplification/2026-10-28-matrix-lifecycle-ablation.md>) 保留为 proposed。它评估本实现中重复机制的合并，没有授权取消任务排空或错误语义，也没有改变本文所记录的当前实现。

本次没有旧决策被完全取代，不归档或删除既有记录。

## Alternatives considered

1. **直接迁移完整 Matrix SDK。** 有机会将同步、协议和加密维护交给上游，但也涉及 Node 持久化、设备身份、事件模型及打包兼容。本批先稳定已有路径，SDK 研究继续保留，不把未验证的迁移当作已解决 E2EE。
2. **先替换为所有渠道共用的控制器框架。** 可以减少重复管理代码，但 Matrix 双凭据和密钥清理要求会扩展共享接口并影响其他渠道，因此本批只收敛本地事务和复用既有 supervisor。
3. **各层独立做图片转文件与连接恢复。** 局部实现看似自足，但共享层和原生层同时重试会产生重复事件，两个连接恢复所有者会竞争创建 runtime。回退和重建分别只保留一个策略所有者。
4. **关闭等待固定时间后强制清空依赖。** 可限制表面等待时间，但预算耗尽不能证明工作结束，会留下晚写入或已释放依赖的访问。采用可取消请求与任务排空，接受真实完成条件决定关闭时长。
5. **关闭加密或遇到加密故障改发明文。** 可以减少当前维护负担，却违背保留 E2EE 的产品决定，也破坏保密边界。采用已知加密房间发送前拒绝，不以重置密钥规避错误。

## Consequences

- 收益是单一回退与重建策略、真实事件回执、可观察的降级健康状态，以及关闭、回滚和删除的明确完成条件；错误提示保留未知结果与不可发送之间的区别。
- 代价是继续维护 CS API 和 libolm 编排，且不响应取消的依赖可能拖延关闭，直到其自身完成或超时。为保护仍可能活跃的状态，持续失败的 stop 会阻断替换与删除，可能需要重启进程，而不是强行删除密钥。
- 公开返回值中的主动发送回执与删除布尔值需要消费者正确处理；部分清理与取消均不承诺远端或本地操作已回滚。
- 线程、触发、上下文、图片关联和存储格式保持既有行为；共享 reaction 排空为显式选择，不改变其他渠道默认 waitForIdle 的语义。
- E2EE 仍仅适合非敏感测试。设备交互验证、备份、SSSS 和出站附件内容加密未完成，本批修正不构成完整端到端保密保障。
