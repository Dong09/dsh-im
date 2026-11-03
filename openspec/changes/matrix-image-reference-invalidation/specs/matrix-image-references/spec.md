# Spec Delta: Matrix 图片引用生命周期

## Purpose

定义 Matrix 群聊中图片消息与后续提问之间的引用生命周期，使已撤回的图片不再持续阻塞新图，同时维持明确回复、暂时失败重试、持久状态及跨房间隔离的可验证边界，避免以不完整或错误的图片输入提交模型。

## ADDED Requirements

### Requirement: Automatic image selection preserves scope and ordering
系统 SHALL 仅为普通 @ 自动选择同房间、同发送者、同线程和既有时间窗口内的未消费、未失效图片，保持到达顺序；不同事件即使同名也 MUST 被视为独立引用。

#### Scenario: Recalled old image does not block a replacement
- **WHEN** 用户先发送图片 A、撤回 A，再发送图片 B 并普通 @，系统已确认 A 撤回
- **THEN** 本轮只以 B 作为图片输入，A 不被下载或继续阻塞 B

#### Scenario: Several valid images remain ordered and isolated
- **WHEN** 同一范围内存在两张有效图片及其他发送者、房间、线程或窗口外的图片
- **THEN** 系统按到达顺序提交两张有效图片，绝不附加其他范围图片

#### Scenario: Equal filenames do not imply equal identity
- **WHEN** 两次发送使用相同文件名但事件不同，且仅旧事件被撤回
- **THEN** 新事件仍可被选择和分析，失效不能按文件名传播

### Requirement: Trusted redactions invalidate references durably
系统 MUST 在收到可信的房间撤回事件后，使精确房间和目标事件对应的图片引用失效；该状态 SHALL 区别于成功消费且在重启后继续生效。重复、乱序和历史重放 MUST NOT 复活仍在保留范围内的失效引用。

#### Scenario: Redaction arrives before image recording
- **WHEN** 撤回先于其目标图片的本地记录被处理，随后该图片事件到达或重放
- **THEN** 在有界撤回保留范围内该图片仍被认定失效，不进入自动待处理集合

#### Scenario: Consumed image is later redacted
- **WHEN** 一张已分析的图片被撤回，之后用户明确回复该图片
- **THEN** 系统报告目标已不可用，不因其曾成功消费而允许再次读取

#### Scenario: Redaction replay and restart
- **WHEN** 同一撤回被重复处理并重启，随后同一旧图片重放
- **THEN** 失效处理保持幂等，旧引用不会恢复为待处理

#### Scenario: Same event identifier in a different room
- **WHEN** 一个房间收到针对某事件的撤回，而另一个房间有相同标识的引用
- **THEN** 撤回只改变原房间的状态

### Requirement: Read-time fallback requires affirmative permanent evidence
系统 SHALL 在读取已选引用时以可信的已撤回证据兜底失效处理，即使先前漏收撤回通知。网络故障、超时、取消、权限拒绝、服务错误、单独的不存在响应、空结果、解密失败及事件身份或类型不一致 MUST NOT 单独作为永久撤回证明。

#### Scenario: Missed redaction found on event lookup
- **WHEN** 图片 A 仍被自动选中，读取同房间同事件时返回可信撤回标记，集合中另有有效图片 B
- **THEN** 系统持久化 A 的失效状态并在同轮排除 A，仍以 B 继续处理

#### Scenario: Lookup is inconclusive
- **WHEN** 查询超时、返回权限错误、不存在响应、空结果或无撤回证据的空内容
- **THEN** 系统明确报错且不提交本轮模型输入，不把引用永久失效，后续可重试

#### Scenario: Identity or decrypted content does not match
- **WHEN** 查询结果事件标识、发送者或内容类型与记录不符，或无法解密，且没有可信撤回证据
- **THEN** 系统拒绝本轮输入，不自动选择替代目标或永久丢弃引用

### Requirement: Exact reply targets are never silently substituted
系统 MUST 将用户明确回复的图片视为精确目标；目标失效或不可读取时 SHALL 明确报错，不能自动换用其他待处理图片，也不能以纯文本继续图片分析。

#### Scenario: Reply to a recalled image while a new image is pending
- **WHEN** 用户明确回复已撤回图片 A，同时同一用户有有效图片 B 待处理
- **THEN** 系统报告 A 不可用，不提交模型输入且不消费 B

#### Scenario: Reply to a valid replacement bypasses unrelated pending images
- **WHEN** 用户明确回复有效图片 B，而旧图片 A 仍待处理或已失效
- **THEN** 系统只提交 B，不附加 A

### Requirement: Exclusion is visible and empty-image analysis is prohibited
系统 SHALL 在自动候选因确认失效被排除、且仍有可用图片时，提供每个请求至多一次的简短操作提示；提示不能冒充模型分析或暴露内部事件、凭据和 URL。若本轮有图片关联意图但候选全因失效被排除，系统 MUST 提示重发有效图片且不提交纯文本图片分析。

#### Scenario: Partial exclusion notice
- **WHEN** 自动候选 A 已确认失效，B 成功成为本轮图片输入
- **THEN** 用户获知有已撤回图片未参与，本轮模型仍可基于 B 作答；提示不作为图片成功消费依据

#### Scenario: All selected or scoped candidates are invalid
- **WHEN** 窗口内本轮关联到的图片全部已确认失效，无可用图片
- **THEN** 系统提示重新发送或明确回复有效图片，本轮模型提交次数为零

#### Scenario: Ordinary text without image association
- **WHEN** 用户普通文字 @ 且其范围内没有图片候选或失效图片关联
- **THEN** 系统沿用原有文字处理，不把所有文字 @ 一律拦截

### Requirement: Retryable failures remain atomic
只要本轮任一有效图片遇到暂时失败、字节校验或大小限制错误，系统 MUST 维持整轮拒绝及原有重试契约，不因失效排除功能跳过该图片或部分提交模型。有效图片 SHALL 仅在原有成功交付条件下被消费，已证明撤回的失效状态不受其他图片失败回滚。

#### Scenario: Valid image download fails after another was excluded
- **WHEN** A 已确认撤回并失效，B 有效但下载超时
- **THEN** 本轮不提交模型，B 保留重试，A 保持失效

#### Scenario: Second valid image fails validation
- **WHEN** 有效图片 B 已下载，随后有效图片 C 的格式或大小验证失败
- **THEN** 不提交仅含 B 的部分输入，B 和 C 都不被成功消费

### Requirement: Invalidation is rechecked before submission
系统 MUST 在队列准备和图片读取的提交前边界重新检查已知失效状态，避免旧候选快照绕过撤回。提交前已观察到的撤回 SHALL 排除隐式引用或拒绝显式目标；系统不承诺撤销已提交给模型的图片输入。

#### Scenario: Image recalled while request waits in queue
- **WHEN** 请求已捕获 A、B 候选但尚未执行，等待期间 A 的撤回已持久化
- **THEN** 执行时不使用旧快照恢复 A，只处理有效 B

#### Scenario: Redaction observed during image preparation
- **WHEN** 图片字节已获取，但在提交前的最终准备检查之前系统已观察到该图片撤回
- **THEN** 隐式输入中排除它并重新判断是否还有图片，显式输入则报错

### Requirement: Storage evolution is safe and bounded
系统 SHALL 兼容读取现有 version 1 图片引用和消费状态，新增的失效状态及必要的撤回墓碑 MUST 有界、可持久化且不保存图片字节或密钥。损坏或未来格式 MUST NOT 被当成空库；持久化失败 MUST NOT 被报告为成功失效或成功处理。

#### Scenario: Existing version 1 state is upgraded
- **WHEN** 加载包含已消费和未消费记录的旧引用库并首次保存新格式
- **THEN** 原记录身份、顺序及消费状态被保留，旧数据可恢复且降级限制明确

#### Scenario: Invalidation persistence fails
- **WHEN** 排除确认撤回的图片所需的持久化操作失败
- **THEN** 当前受影响请求停止并报告存储错误，不以成功分析或成功失效掩盖故障；之后可重试同一失效操作

#### Scenario: Retention reaches its configured bound
- **WHEN** 图片引用和未知目标撤回墓碑数量超过各自保留上限
- **THEN** 状态按文档化的有界规则淘汰，不进行无界增长，也不把淘汰本身当作成功消费

### Requirement: Diagnostics distinguish reference loss from transient failure
系统 SHALL 区分已确认撤回、尚无法读取、无剩余图片及失效状态保存失败的用户诊断，提供真实可执行的恢复建议；新增文本 MUST 在全部现有翻译语言中保持占位符一致。

#### Scenario: Confirmed recalled explicit target
- **WHEN** 显式回复目标已确认撤回
- **THEN** 提示改为回复新图或重新发送有效图片，不要求回复已经不存在的原图

#### Scenario: Localized exclusion or retry diagnostic
- **WHEN** 当前语言不是中文且发生引用排除或可重试失败
- **THEN** 返回该语言的对应诊断，不丢失占位参数、不泄露内部错误原文
