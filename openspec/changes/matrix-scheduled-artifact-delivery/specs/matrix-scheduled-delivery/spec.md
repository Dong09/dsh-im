# Spec Delta: Matrix Scheduled Delivery

## Purpose

让当前 Host 中、已唯一绑定到 Matrix 群聊或线程的原生定时回合，能够把成功完成的文字、图片和文件发送回原处。该能力区分自动上下文与真实输入，维持目的地隔离、明确的发送结果和不盲目重发的安全要求，避免把 Web 展示或附件登记成功误报为 Matrix 已送达。

## ADDED Requirements

### Requirement: Eligible scheduled turns have exactly one Matrix destination
系统 SHALL 仅为来自当前 Host 原生定时输入、且具有唯一有效 Matrix 群聊或线程回复位置的回合授权自动投递；普通输入中的任务描述或来源字符串 MUST NOT 授予此权限。

#### Scenario: Native schedule uses an existing room binding
- **WHEN** 一个原生定时输入进入已唯一绑定 Matrix 群聊的 Session
- **THEN** 系统确定该房间为此回合唯一的回复目的地，无需用户另建投递目标或开启会话同步

#### Scenario: Web-created schedule belongs to a bound Session
- **WHEN** 用户从 Web 在已唯一绑定 Matrix 房间的同一 Session 创建原生定时任务并触发
- **THEN** 该回合可以按相同规则回原房间，不要求创建动作必须来自 Matrix

#### Scenario: Missing or conflicting binding
- **WHEN** 一个定时回合没有有效绑定，或同一 Session 对应多个不同目的地
- **THEN** 系统拒绝自动附件授权及自动回群，并报告无绑定或绑定冲突，不猜测房间且不广播

#### Scenario: User text imitates schedule metadata
- **WHEN** 普通用户正文、工具结果或历史内容中包含看似定时来源或房间标识的文本
- **THEN** 系统不据此授权定时投递，也不改写目的地

### Requirement: Host context does not count as another user input
系统 SHALL 依据受信的结构化来源和形式识别 Host 自动运行时、时间、技能目录及 IM 上下文通知；这些消息 MUST NOT 被当作用户插话。真实用户输入及未识别的输入来源 MUST 保留混合输入保护，不能仅因正文看起来像上下文而被忽略。

#### Scenario: Actual runtime and time snapshots accompany the reminder
- **WHEN** 定时输入同轮伴随运行时快照和时间快照，且没有其他真实输入
- **THEN** 系统仍允许该定时回合投递，不将其标为混合输入

#### Scenario: Catalog or IM context notice accompanies the reminder
- **WHEN** 该回合还包含 Host 生成的技能目录或 IM 上下文通知，来源与形式均符合允许项
- **THEN** 这些自动消息不取消定时投递资格

#### Scenario: A human message joins the scheduled turn
- **WHEN** 定时回合中混入普通 IM、Web 或 CLI 用户输入
- **THEN** 系统阻止该回合的自动定时文字和附件投递，并记录混合输入原因

#### Scenario: Unknown source or a context-looking human message
- **WHEN** 消息来源未知，或普通用户正文声称自己是时间快照
- **THEN** 系统不能忽略它来绕过混合输入保护

### Requirement: Attachment registration is available before the first model step
系统 SHALL 在符合条件的定时回合进入首个模型步骤前准备好本轮附件投递权限，使文件登记工具在第一次调用时即可使用；此权限 MUST 限定到当前回合及唯一目的地，不得替换或借用普通 IM 请求已经持有的权限。

#### Scenario: First tool call registers the scheduled image
- **WHEN** 定时回合的第一个工具动作就是登记一个已有、可读的图片
- **THEN** 文件登记成功并明确返回“已登记待发送”，不再因缺少 IM 消费者而失败，也不声称图片已经送达

#### Scenario: Another IM turn already owns attachment delivery
- **WHEN** 同一 Session 的普通 IM 请求已拥有本轮附件投递，或同时出现不兼容的输入归属
- **THEN** 定时路径不夺取该归属，不消费其附件，也不产生第二份回复

#### Scenario: Input becomes mixed while a file is being prepared
- **WHEN** 文件准备期间又确认有真实用户输入混入该回合
- **THEN** 定时附件授权失效，晚到的登记不得留下可自动发送的附件

### Requirement: Only explicitly registered files are sent
系统 SHALL 只发送由当前回合文件登记工具成功确认的附件，复用已有文件内容而不为投递重新生成或重命名。Web 展示、助手 Markdown 路径、图片链接或工具失败的暂存产物 MUST NOT 自动成为待发送附件。

#### Scenario: Existing generated file is reused
- **WHEN** 定时任务登记之前已生成且仍可读取的图片
- **THEN** 系统发送登记时保存的文件内容，不再调用生图服务，也不为发送创建重命名副本

#### Scenario: File is missing or unreadable
- **WHEN** 原文件已被清理、路径不存在或无法读取
- **THEN** 登记明确失败，不将空文件记为成功，不自动重新生图，并在可用的结果记录中保留失败原因

#### Scenario: Web presentation or Markdown contains a file path
- **WHEN** 助手只通过 Web 展示文件或在文字中写出路径，没有成功登记该附件
- **THEN** 系统不读取该路径并自动上传，也不将 Web 展示成功记为 Matrix 发送成功

#### Scenario: File tool or its enclosing tool operation fails
- **WHEN** 文件曾被暂存，但文件工具或其外层工具操作最终失败
- **THEN** 暂存产物不进入定时附件发送列表

### Requirement: Successful completion delivers text and attachments in order
系统 SHALL 仅在具备投递资格的回合正常完成后开始发送其最终文字及已确认附件；有文字时先尝试最终文字，再按登记顺序尝试附件。纯附件回合 MUST 能发送，不能因最终文字为空而被丢弃；发送某一部分失败不得将其余部分误记为成功。

#### Scenario: Text and multiple attachments
- **WHEN** 定时回合正常完成，包含最终文字、一张图片和一个文档
- **THEN** 系统先尝试文字，再依次尝试图片和文档，并记录每一部分的独立结果

#### Scenario: Attachment without final text
- **WHEN** 定时回合正常完成，最终文字为空但存在已确认附件
- **THEN** 系统仍尝试发送附件，不仅发送通用的“已完成”文字来替代附件

#### Scenario: Text fails but an attachment can still be sent
- **WHEN** 最终文字发送明确失败，但渠道仍可处理附件且该回合未取消
- **THEN** 系统继续尝试已登记附件，并把文字失败与附件结果分别记录

#### Scenario: Turn failed or was cancelled before delivery
- **WHEN** 模型回合失败、被停止或被取消，没有正常完成
- **THEN** 系统不自动发送该回合的文字或附件，并释放不再使用的附件资源

### Requirement: Matrix media delivery preserves native safety rules
系统 SHALL 复用现有 Matrix 媒体发送行为：图片优先，明确失败后最多一次转为文件；派发结果未知不得换类型重发。对于已知加密房间，缺少可用加密能力时 MUST 在上传前拒绝，不得发送明文。

#### Scenario: Image is definitely rejected
- **WHEN** 图片发送明确失败且未取消，文件发送能力仍可用
- **THEN** 系统最多再尝试一次文件发送，不增加第三次事件派发

#### Scenario: Event dispatch has an unknown outcome
- **WHEN** 事件请求派发后出现网络中断、超时、服务端异常或无有效消息回执
- **THEN** 系统记录结果未知，不自动转文件、不创建新的重复事件

#### Scenario: Encrypted room lacks usable encryption
- **WHEN** 目标已知为加密房间且当前没有可用加密能力
- **THEN** 系统拒绝附件上传及明文发送，并报告加密不可用

### Requirement: Destination remains isolated throughout delivery
系统 SHALL 将投递限定在本轮授权的机器人账号、房间及线程，开始发送前重新检查目标仍可用且无冲突；不得因绑定变化把已登记文件改发其他目的地。旧 Session 的已记录回复位置 SHALL 按既有规则保留。

#### Scenario: Thread receives the scheduled file
- **WHEN** 定时任务属于某个 Matrix 线程
- **THEN** 文字、图片及文件均使用该线程，不发送到另一个线程或无关房间

#### Scenario: New Session replaces the room conversation
- **WHEN** 群聊执行新建会话，但旧 Session 中的定时任务仍有已记录且无冲突的回复位置
- **THEN** 旧任务仍只能按该位置发送，不跟随其他 Session 或机器人

#### Scenario: Binding conflict or account removal occurs before sending
- **WHEN** 授权后出现目的地冲突，或对应账号被删除、替换为其他身份或不再可用
- **THEN** 系统阻止后续受影响的发送并记录原因，不改选其他账号或房间

#### Scenario: Protocol-valid legacy and v12 destinations
- **WHEN** 目的地使用渠道支持的经典房间标识或 v12 哈希房间标识，以及合法线程标识
- **THEN** 定时投递与普通 Matrix 投递使用同样的接受规则，不另加要求房间 ID 必须含冒号的限制

### Requirement: Delivery outcomes reflect each attempted part
系统 SHALL 区分文件登记、Web 展示、平台发送成功、明确失败与结果未知。只有所有应发送部分均得到成功确认时，才能把该回合记为全部成功；文字成功但附件失败 MUST 保留失败或部分失败结果，不能用单个布尔成功值覆盖附件结果。

#### Scenario: Text succeeds and image fails
- **WHEN** 文字已发送，而图片及其允许的文件回退都明确失败
- **THEN** 结果中保留文字成功与附件失败，该回合不显示为全部成功；有可用渠道时尽力发送简洁失败提示

#### Scenario: Different files have different outcomes
- **WHEN** 第一个附件成功、第二个结果未知、第三个明确失败
- **THEN** 结果保留三项区别及可用的平台消息标识，整体结果不能为成功，未知结果不得被明确失败覆盖

#### Scenario: Failure notice cannot be delivered
- **WHEN** 附件发送失败且渠道也不能发送失败提示
- **THEN** Host 诊断及持久化结果仍记录失败，不因提示未送达而把原发送改为成功

### Requirement: Repeated events and restart do not replay attempted deliveries
系统 SHALL 在开始平台发送前持久化本轮及其组成部分的尝试状态，并在发送完成后记录结果。重复完成事件、重启、状态写入失败或未知平台结果 MUST NOT 自动重复发送已尝试部分；本变更不自动补发上线前的历史回合。

#### Scenario: Completion event is observed twice
- **WHEN** 同一定时回合的完成事件重复出现
- **THEN** 文字和每个附件最多启动一轮投递；该轮允许规定范围内的图片转文件回退，但不能因事件重放而重开一轮并重新发送原文件

#### Scenario: Crash follows platform dispatch
- **WHEN** 进程在发送已开始后退出，重启时只能确定该部分处于发送中
- **THEN** 系统将其视为不应自动重发的已尝试或未知结果，而不是未发送

#### Scenario: Final checkpoint write fails
- **WHEN** 平台已接受某一部分，但保存最终结果失败
- **THEN** 先前的尝试记录仍阻止自动重发，系统明确报告状态写入失败

#### Scenario: Historical scheduled turn predates deployment
- **WHEN** 加载新版本时发现旧任务已经触发完成
- **THEN** 系统不为应用修复而自动补发旧文字或附件

### Requirement: Consumer shutdown cleans up without late sends
系统 SHALL 在定时投递关闭、Session 释放或插件卸载时停止新授权，取消未开始的发送并等待已接收的发送收尾；附件快照必须在不再使用后释放。释放其他独立回合的资源 MUST NOT 取消仍在运行的普通 IM 投递。

#### Scenario: Shutdown during model preparation
- **WHEN** 插件关闭时模型回合尚未完成或文件尚在准备
- **THEN** 不再产生新的定时附件发送，晚到结果不能复活已关闭的投递权限

#### Scenario: Shutdown while an upload or event request is in flight
- **WHEN** 插件在已开始的上传或事件请求期间关闭
- **THEN** 关闭流程等到该操作收尾后释放所需资源，并按证据记录已确认成功、明确失败或结果未知，不能因正在关闭而覆盖有效成功回执，也不能声称远端请求已被撤回

#### Scenario: Ordinary IM file sending continues
- **WHEN** 某个定时回合的权限被释放，而普通 IM 回合拥有自己的附件
- **THEN** 普通回合的附件不被定时清理消费或丢弃，也不发生重复发送

### Requirement: Existing configuration and state remain safe
系统 SHALL 保持现有定时器、工作区、凭据及文字发送接口不变；新状态必须安全读取原有 version 1 的回复位置和去重检查点，对损坏或未来未知格式明确拒绝而不覆盖。其他渠道、Matrix 私聊和远程 Harness 的既有行为 MUST NOT 因此获得新的自动附件权限。

#### Scenario: Existing state is upgraded
- **WHEN** 新版本读取包含经典或 v12 路由及已有尝试记录的有效旧状态
- **THEN** 路由和旧去重结果保持有效，不重发旧回合；新格式写入采用明确版本及原子提交

#### Scenario: Corrupt or unsupported state
- **WHEN** 状态文件内容损坏或使用不受支持的未来版本
- **THEN** 系统明确报告问题并停止依赖该状态的投递，不把它当作空状态覆盖

#### Scenario: Out-of-scope channel or transport
- **WHEN** 定时任务属于其他渠道、Matrix 私聊或显式远程 Harness
- **THEN** 本能力不新建自动附件投递权限，不改变其原有行为
