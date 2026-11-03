# Proposal: Matrix 图片引用撤回失效与读取兜底

## Why

Matrix 群聊先发图、后单独 @ 的分支扩展会收集窗口内全部未消费图片；撤回旧图没有清理派生引用，而失败又保留待重试状态，导致旧引用持续阻塞后来重发的新图。2026-11-02 的截图与本地状态显示多次独立发送的同名图片全部未消费；尚未读取原始事件响应，具体撤回形态和实际失败分支仍需验证，不能仅凭文件名断言桥接来源。

## What Changes

- 采用已确认的 A + B：处理可信撤回事件以持久化失效引用，同时在实际读取时依据明确的永久失效证据兜底；失效与成功消费是不同状态。
- 普通 @ 的隐式图片集合排除已确认失效项，保持其余图片顺序和原有房间、发送者、线程、时间窗口隔离；仍有有效图时继续同轮处理，并给出不含敏感细节的简短排除提示。
- 显式回复失效图片仍报错，绝不改选其他待处理图片；隐式候选全部失效时明确提示重发，不以纯文本提交图片分析。
- 网络、权限、超时、服务端错误、无证据的空结果、解密失败或身份不一致不作为撤回证明；仍采用整轮拒绝并保留重试。中止及连接世代失效不能写成永久失效。
- 在排队执行和读取边界重新检查失效状态，覆盖事件乱序、重放、重启和持久化失败；不声称可撤销已提交给模型的输入。
- 兼容读取现有 version 1 引用库，新增独立失效状态并明确新格式与降级限制；不人工清空生产状态，不把 consumed 当作 deleted。
- 新增行为、存储、API 查询分类、并发、错误提示及多语言回归；沿用共享图片输入安全语义，不新增通用“忽略坏图”开关。

## Capabilities

### New Capabilities

- `matrix-image-references`：Matrix 群聊图片引用的选择、撤回失效、可信读取分类、持久化、重试与用户可见反馈。

### Modified Capabilities

无。当前主规范清单为空；这里登记当前分支图片接入扩展的生命周期契约，不将其描述为官方已具备的新功能。

## Impact

- Matrix 入站与存储：[runtime](../../../src/channels/matrix/matrix-runtime.mjs)、[image inbox](../../../src/channels/matrix/matrix-image-inbox.mjs)、[image input](../../../src/channels/matrix/matrix-image-input.mjs)、[API](../../../src/channels/matrix/matrix-api.mjs)及必要的 [crypto](../../../src/channels/matrix/matrix-crypto.mjs) 类型分派核对。
- 队列准备与兼容：[text bridge](../../../src/channels/shared/text-harness-bridge.mjs)、[共享图片 prompt](../../../src/channels/shared/image-prompt.mjs)。只在现有准备扩展点不足时最小改动，不改变其他渠道失败策略。
- 测试：Matrix image-association、image-inbox、image-input、API、runtime/lifecycle，以及共享图片输入和所有现有翻译字典覆盖。
- 上游核查基线：2026-11-02 查到官方 main 为 [dd500d24](https://github.com/xmanrui/dsh-im/commit/dd500d24252a182ca64645ada005a553fd723831)，最新发布 [v5.9.1](https://github.com/xmanrui/dsh-im/releases/tag/v5.9.1)；两者没有本分支图片 inbox 扩展，未发现可直接复用的对应修复。官方回答同步处理出站文字，不替代入站失效处理。
- 以 [定时附件简化](../simplify-matrix-scheduled-attachments/proposal.md)的已完成代码为前置工作树基线，保留官方最终文字、自研仅定时附件、普通 IM 所有权和现有防重。2026-11-02 核查为 22/24 项完成，未完成两项属于运行加载与设置验收；[实施证据](../simplify-matrix-scheduled-attachments/implementation-evidence.md)记录代码/构建/测试完成、用户选择暂不启用运行实例。本变更不代为完成运行启用。
- 当前 HEAD 仍为 `7a73dd6aaad1155afb1d7e06942c09af4504592d`，简化成果尚在未提交工作树；后续实施须保存完整差异与未跟踪交付物作为新基线，不能仅凭 HEAD 恢复代码。图片修复独立回滚，不能恢复旧文字发送器、改写定时发送状态或启用全局回答开关。
- 图片失效提示属于普通入站操作通知，不走附件专属 scheduled 入口，不算模型最终回答或成功消费；已提交输入之后的撤回不追溯撤销输出附件。补充组合回归，不扩展到定时发送、回答同步、文本上下文撤回清理或其他渠道。
- 本次仅创建规划产物；不改业务代码、部署、凭据、运行设置或生产数据，无新增第三方依赖和公开 API。
