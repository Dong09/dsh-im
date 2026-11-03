# Spec Delta: Matrix Scheduled Delivery

## Purpose

为当前 Host 中的 Matrix 定时任务定义单一文字交付者和独立附件交付者：官方会话同步负责最终回答，自研仅负责受控图片／文件的授权、发送、旧回复位置及持久化防重。在精简重复实现的同时保留普通 IM、目的地隔离和未知结果不盲目重发的安全边界。

## ADDED Requirements

### Requirement: Final scheduled text has one delivery owner
系统 SHALL 仅由官方会话同步发送定时回合的最终回答，并遵守其全局开关、当前绑定与输入来源规则。自研定时附件路径 MUST NOT 发送、补发或兜底最终回答，亦不得用附件状态声称官方文字已经送达。

#### Scenario: Final answer and registered artifacts
- **WHEN** 一个符合条件的定时回合正常结束，存在最终文字和已登记附件，且官方回答同步开启、文字目的地有效
- **THEN** 官方链路发送最终文字，自研链路仅发送附件，不产生第二份最终回答

#### Scenario: Text is disabled or cannot be routed
- **WHEN** 官方回答同步关闭，或当前文字绑定不存在、不可用或被既有目标策略禁止
- **THEN** 自研路径不接管文字；符合附件授权规则的附件仍独立处理

#### Scenario: No registered artifacts
- **WHEN** 定时回合正常完成且没有已确认附件
- **THEN** 不创建自研附件发送尝试，也不写入新的自研文字尝试；有最终文字时由官方链路决定是否发送

### Requirement: Saved text targets do not broaden interactive authority
系统 SHALL 为官方文字同步提供明确的非私聊文字候选范围，使已启用、仍绑定到目标 Session 的 Matrix 房间／线程目标可接收最终回答。审批、提问及其桌面兜底通知 MUST 继续限于原有私聊候选，未启用或失效的目标 MUST NOT 被绕过。

#### Scenario: Enabled saved Matrix room or thread
- **WHEN** 机器人有保存目标，且启用的 Matrix 房间或线程目标仍绑定本回合 Session
- **THEN** 官方文字链路可选中该目标，不因交互候选的私聊过滤而静默丢失回答

#### Scenario: Interactive request in a shared destination
- **WHEN** 同一机器人产生审批、待答问题或这些交互的 Web／桌面兜底通知
- **THEN** 共享房间／线程不会因此成为交互或交互通知目的地，私聊选择与歧义保护保持不变

#### Scenario: Saved target is disabled or rebound
- **WHEN** 保存目标已关闭同步、被删除或不再绑定本回合 Session
- **THEN** 不向该目标发送，不为绕过目标设置而改用绑定回退

### Requirement: Attachment authority exists before the first tool call
系统 SHALL 仅对当前 Host 中已确认的原生定时输入、唯一可信 Matrix 群聊／线程目的地及未混入真实输入的回合，授予首个模型步骤即可使用的附件登记权限。该权限 MUST 隔离 Session、回合及普通 IM 请求，不得伪造或借用普通请求身份。

#### Scenario: First call registers an existing file
- **WHEN** 符合条件的定时回合第一次工具调用登记已有图片或文件
- **THEN** 登记可成功并返回待发送语义，但不声称已送达 Matrix

#### Scenario: Known automatic context accompanies schedule
- **WHEN** 同轮输入仅包含定时消息及已知运行时／时间快照、技能目录或插件上下文
- **THEN** 自动上下文不被当作真人插话，附件权限不被误撤销

#### Scenario: Mixed or conflicting ownership
- **WHEN** 真实普通输入、未知来源、其他 owner、无绑定、绑定冲突或取消出现在授权前后
- **THEN** 不打开或撤销本轮定时附件权限；晚到登记、提交及旧 owner 清理不能污染普通 IM 或下一回合

### Requirement: Only explicitly committed managed artifacts are sent
系统 SHALL 只发送当前回合通过文件工具成功确认的受控附件，并使用登记时保存的文件内容、名称及真实附件身份。Web 卡片、Markdown 路径、失败工具、失败外层调用和历史文件记录 MUST NOT 自动转成附件，也不得为发送重新生图或重命名。

#### Scenario: Original image and equal filenames
- **WHEN** 回合登记已有图片或多个同名但不同身份的文件
- **THEN** 按登记的实际身份和顺序发送对应内容，不按文件名合并，也不重新生成图片

#### Scenario: Missing file or failed tool
- **WHEN** 文件不可读、准备期间失效，或工具及其外层调用未成功确认
- **THEN** 不留下可自动发送的附件，明确报告登记失败或释放暂存资源

#### Scenario: Internal attachment entry receives a text or arbitrary path
- **WHEN** 定时附件入口收到文字部分、伪造附件对象、任意 path、URL 或 bytes
- **THEN** 请求在上传／发送之前被拒绝；普通公开文字发送接口不因此新增文件能力

### Requirement: Attachment delivery is independent from final text
系统 SHALL 在回合正常完成后按附件登记顺序发送已确认图片／文件；最终文字为空、文字发送失败或文字同步关闭 MUST NOT 单独导致已授权附件被丢弃。文字与附件之间不提供先后顺序或联合成功保证。

#### Scenario: Attachment-only completed turn
- **WHEN** 正常完成回合没有最终文字，但有一个或多个已确认附件
- **THEN** 自研路径仍发送附件，官方路径不伪造最终回答

#### Scenario: Official text fails
- **WHEN** 官方最终文字发送失败或结果未知，但附件路由仍可信且回合未取消
- **THEN** 仍可发送已确认附件，不等待文字重试，也不通过自研路径补发最终文字

#### Scenario: Artifact failure notice
- **WHEN** 某附件发送失败并触发既有简洁失败提示
- **THEN** 提示仅表达附件失败，不重发最终回答，不把提示可见当成附件成功

### Requirement: New attempts contain attachments only
系统 SHALL 仅为非空的已确认附件集合创建新的自研发送尝试，部分清单 MUST 只包含附件；每项结果独立保留原生回执、明确失败或未知状态。所有必需附件得到确认之前，附件尝试 MUST NOT 标为全部成功。

#### Scenario: Text plus files creates artifact-only manifest
- **WHEN** 回合同时产生最终文字与两个已确认文件
- **THEN** 新自研尝试仅记录两个附件，不生成文字部分；该状态不表示官方文字成功或失败

#### Scenario: Partial attachment outcome
- **WHEN** 附件 A 已发送、B 结果未知、C 失败或未开始
- **THEN** 各项结果和可用回执分别保留，整体不能为 sent，未知不能被失败覆盖

### Requirement: Durable checkpoints prevent attachment replay
系统 SHALL 在任何附件上传或发送前持久化完整附件意图和该附件的发送中状态，再于平台操作之外记录终态。重复完成、迟到结果、重启、发送结果未知及本地写盘失败 MUST NOT 重开已尝试的附件或触发第二次媒体发送。

#### Scenario: Provider succeeds and final checkpoint fails
- **WHEN** 图片原生发送已成功，但终态写盘失败
- **THEN** 保留先前防重记录，停止后续附件并释放快照，不将本地故障解释为图片失败来转文件重发

#### Scenario: Duplicate completion or restart
- **WHEN** 已尝试回合再次出现完成事件，或进程重启后遇到历史记录
- **THEN** 不恢复历史快照、不从旧路径重新登记、不补发已尝试或未确认附件，也不自动补发历史文字

### Requirement: Existing state remains readable and monotonic
系统 SHALL 保留原状态位置并安全读取现有 v1/v2 数据，包括旧文字部分、混合清单、目的地、冲突及最近尝试高水位。升级 MUST NOT 清空数据或降低高水位；损坏、未来格式及备份失败 MUST 明确拒绝，而非按空库继续发送。

#### Scenario: Legacy text or mixed record
- **WHEN** 新版读取旧文字成功／失败／未知／发送中或文字加附件记录
- **THEN** 保留兼容读取和防重语义，不执行历史文字发送，也不把旧记录补成新的附件任务

#### Scenario: First write after valid v1 read
- **WHEN** 需要在读取有效 v1 后提交新的附件尝试
- **THEN** 继续保留原始字节备份并原子写入兼容 v2，原路由、冲突和高水位不丢失

### Requirement: Old attachment destinations remain frozen
系统 SHALL 保留已记录旧 Session 的唯一 Matrix 附件回复位置，并在每个部分发送前复核账号、adapter 归属和精确房间／线程。绑定或账号变化不得将已登记附件改投别处；该保留规则不授予旧 Session 额外的最终文字发送路径。

#### Scenario: New conversation replaces current binding
- **WHEN** 房间执行 `/new` 或切换绑定，而旧 Session 定时任务已有可信附件回复记录
- **THEN** 旧任务的附件仍仅按旧记录及现有安全检查处理；官方查不到当前文字绑定时允许没有最终文字，不由自研补发

#### Scenario: Account or destination changes
- **WHEN** 授权后账号被删除、替换，出现路由冲突或线程目标失效
- **THEN** 阻止受影响的后续附件发送并记录原因，不换账号、不落到父房间或其他线程

### Requirement: Native Matrix media safety is retained
系统 SHALL 保持经典及 v12 房间／线程支持、原生图片优先及明确拒绝后最多一次文件回退。超时、网络、5xx 或无有效事件回执 MUST 按未知处理且不换类型重发；已知加密房间缺少可用加密能力时 MUST 在上传前拒绝明文。

#### Scenario: Image rejected or outcome uncertain
- **WHEN** 图片明确被拒绝，或另一次派发结果无法确认
- **THEN** 仅前者允许规定的一次文件回退；后者不创建新的图片／文件事件

#### Scenario: Known encrypted room cannot encrypt
- **WHEN** 已知加密房间当前不具备可用加密能力
- **THEN** 不上传附件，也不降级成明文发送

### Requirement: Shutdown and ordinary IM ownership remain safe
系统 SHALL 在附件路径关闭、Session 释放或插件卸载时停止新授权、取消未开始操作、等待已接受发送及检查点收尾后释放资源。清理 MUST 仅作用于自己的附件 owner，不得取消普通 IM 或其他回合，也不得声称取消撤回了远端已接受消息。

#### Scenario: Close during upload or checkpoint
- **WHEN** 关闭发生在已接受附件上传、发送或状态写入期间
- **THEN** 按既有排空边界收尾，保留可信回执或未知状态，之后无晚到新发送

#### Scenario: Direct IM succeeds after scheduled lease closes
- **WHEN** 旧定时 lease 结束后普通 IM 已接管新的文件投递
- **THEN** 普通 IM 文件仍能登记与发送，旧 lease 的晚到提交或 close 不消费其文件

### Requirement: Live official answer activation is explicit and verifiable
系统 SHALL 在实施验收阶段通过当前运行 Host 的现有认证设置接口，仅更新全局 `deliverModelAnswers` 为 true，并在同一 Host 读回确认。其余设置 MUST 保留；发布默认值、认证策略和生产状态文件 MUST NOT 被改写来绕过运行时缓存或权限。

#### Scenario: Answer-only activation
- **WHEN** 已授权的实施调用先读设置，再只修改回答开关并读回
- **THEN** 官方回答开关为 true，输入镜像及前缀保持原值，后续新回合使用新设置，报告其影响是全局而非仅 Matrix

#### Scenario: Runtime API or authentication unavailable
- **WHEN** 无法通过当前运行 Host 的正常设置接口完成写入与读回
- **THEN** 明确报告尚未启用，不直接编辑 JSON 假装生效、不放宽权限，也不擅自重启服务

#### Scenario: Attachment switch changes
- **WHEN** `matrix.scheduleReplies` 为 false 或官方回答同步开关关闭
- **THEN** 前者仅停止定时附件权限与发送；后者仅控制官方最终文字，不把两个开关合并成新的隐式主开关
