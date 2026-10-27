# Matrix 渠道接入方案

当前主线：非加密房间的稳定收发与生命周期管理。CS API 直写方式、libolm WASM 加密编排、`e2eeMode` 默认值及现有设备与密钥状态均保留；未迁移 Matrix SDK，也未完成后续 E2EE 研究。加密能力仍为实验功能，仅有本地 WASM 环回与适配器自动化验证，未验证真实 homeserver／Element 互通。

当前实现约束：

- 附件的图片优先、明确失败后转文件策略由共享交付层独占；Matrix 原生 `sendImage`、`sendFile` 各只尝试一种事件类型。上传失败属于消息提交前失败；提交后出现网络、超时、5xx、无效 JSON 或缺失有效事件 ID 时，附件报告 `artifact-delivery-uncertain`，禁止改类型补发。429 保留 API 内同事务 ID 重试。
- 文字、主动文字和附件返回真实 `providerMessageIds`；控制器不再用 `{ sent: true }` 丢弃回执。`deleteBot` 完整成功返回布尔值；部分清理失败抛出 `matrix-cleanup-failed`，保留聚合原因和 `removed` 标志。配置已移除不表示全部状态或凭据已清理。
- 已知加密房间在没有可用加密引擎时拒绝明文发送，附件在上传前拒绝；引擎可用时保留现有加密路径。出站附件内容加密、设备验证与备份仍未实现，不构成完整端到端保密保证。
- 暂时同步失败设置 `ready=false`、`connectionState=connecting`，保留当前可取消轮询；永久失败停止该轮询并交给共享 supervisor 重建。`totals.configured`、`totals.connected` 反映所有已配置机器人，不能以当前 runtime 数量代替配置总数。
- 启动和停止各自单飞；停止先取消，再等待已接收的启动、同步、邀请、回复、原生发送及反应任务完成，然后释放 API／crypto 和刷新存储。共享 Bridge 仅在显式 `waitForIdle({ includeReactions: true })` 时等待反应尾任务，其他渠道默认行为不变。取消不等于服务端已提交事件被撤销。
- 凭据快照、写入、回滚、配置保存和删除均在稳定 botId 的同一串行操作内完成。关闭禁止新操作，并等待已接收操作及其资源清理；密码检查可能创建服务端登录会话，本地取消或回滚不保证撤销远端登录。回滚失败暂停自动连接，须检查存储并重新接入。停止失败时不删除仍可能被使用的凭据或密钥状态；成功停止后，各项清理均尝试并报告实际结果。

需求来源：Matrix 协议（去中心化、可联邦、可选端到端加密）的自建 homeserver 与社区服务器用户提出的接入诉求；dsh-im 现内置十一个 IM 渠道，无 Matrix 适配器。前置调研为 hermes-agent（NousResearch/hermes-agent）Matrix 适配器的全属性技术分析，本文全部数值常量、漏斗次序与坑账均可溯源至该仓库 `plugins/platforms/matrix/adapter.py` 及周边文件（见 §17）。

## 1. 最终决定

结论：可以做到，值得做。Matrix 作为第十二个内置渠道，按"统一语义 + 渠道原生适配"架构接入：

- 不改 `agent-loop`、不复制业务流程：会话绑定、命令、白名单、审批、超时补发、结果文件回传等公共语义全部由既有共享层承载，适配器只实现 Matrix 协议与原生呈现。
- 不引入 Matrix SDK 外部依赖：CS API（Client-Server API）基于 `undici`/原生 fetch 直写，与 `telegram-http.mjs`、`slack-api.mjs` 的既有自研协议路径一致；无原生编译依赖，Windows/macOS/Linux 全平台一致可用，规避 hermes 因 python-olm 无 Windows wheel 而按平台隐藏 Matrix 的能力门。
- E2EE 分期：PR1–PR2 完整支持未加密房间，加密房间给明确可见的降级提示；PR3 以 libolm 的 WebAssembly 构建实现 optional 模式端到端加密；`e2eeMode` 三态 `off | optional | required` 默认 `optional`——依赖缺失时 optional 降级续连、required 拒连并大声告警，照搬 hermes 三态门控。
- 复用"IM机器人"设置页与 `botId` 级存储模型：`BotWorkspaceStore` 统一按 `botId` 管理工作区、Agent Preset、投递目标与访问策略，Matrix 同样支持一个渠道并行多个机器人，各机器人连接状态、凭据、绑定彼此独立。
- 主动投递目标语法与既有 botId/targetId 稳定方案同构，新增 `matrix:` 前缀。
- 入站与出站的每条公共语义验收以 Issue #95 已定的机器人级访问策略（发送者白名单两档权限）为最低基线，不新设第二套访问模型。

本方案遵循 ADR-0001：渠道由明确的用户诉求驱动，不以渠道数量增加为目标；能力切片以 §12 渠道能力矩阵为准验收，每项降级均为用户可见、可追溯的明确降级。

## 2. 范围

### 2.1 必须实现

1. 凭据接入：homeserver + access token，或 homeserver + 用户 ID + 密码；密码检查与运行时登录复用 `performMatrixPasswordLogin`，保留现有密码凭据模式，不自动改成 token-only。
2. 收信：`m.text`/`m.notice`/`m.image`/`m.audio`/`m.video`/`m.file` 入站，去重、防回环、白名单、@提及判定、合批、时钟偏移探测。
3. 房间邀请：授权邀请人门控、非阻塞 join、死房婉拒、`m.direct` 私聊登记、每次全量 sync 后对账补漏。
4. 发送：纯文本 + HTML 富文本双份、@提及 pill 注入、回复引用/线程/编辑/表情反应关系事件、流式编辑、分片自管。
5. 媒体：图片、文件、音频收发与媒体仓储上传；外链媒体下载具备 SSRF 防护；结果文件回传与图片优先文件回退。
6. 交互：`!` 前缀命令规范化、审批与选择的表情反应键位、生命周期反应、输入提示（typing）、已读回执。
7. 主动投递：`matrix:` 目标语法、投递建议、超时补发。
8. 设置页：Matrix 卡片、凭据表单、能力开关折叠区、中英双语（i18n）。
9. E2EE（PR3）：加密房间收发的 Megolm 加解密、设备密钥与一次性密钥的服务端注册与校验、房间密钥经对设备（to-device）消息的共享/转发/请求闭环；`e2eeMode` 三态门控与加密状态 pickled store 的落盘、复原与设备漂移拒起。

### 2.2 明确不做

- 不做 Application Service（appservice）注册、federation 服务器管理、push gateway。
- 首版不做语音原生气泡转码（需 ffmpeg 外部进程）；无 opus 判定依据的音频按普通 `m.audio` 或 `m.file` 发送，不谎报为语音气泡。
- 不做扫码接入（Matrix 无官方机器人扫码开通协议），仅凭据表单接入。
- 首版不做 `create_room` 注入 `initial_state`（加密、power levels、可见性）；建房仅用 `private_chat` preset 交 homeserver 默认。
- 不做设备信任管理图形界面；不做多设备密钥共享的用户可视化。
- 不建立跨渠道统一用户账号体系，不推断 Matrix 用户与其他渠道用户同一。
- E2EE 范围边界（PR3 不含，详见《Matrix端到端加密可行性调研.md》）：不做加密房间内附件（`m.file`/`m.image` 等）的 AES-CTR 封装加解密，此类附件在加密房间按明文字段随 Megolm 事件发送（属用户可见的既定降级，非规范加密附件）；不做交叉签名（cross-signing）、SSSS 密钥备份/恢复与交互式设备验证（SAS/emoji），`recoveryKey` 通道字段预留但不启用。

## 3. 渠道注册与文件布局

`src/channels/matrix/`（渠道原生实现）：

| 文件 | 职责 |
| --- | --- |
| `matrix-identifiers.mjs` | 用户、房间、实际投递房间及事件 ID 的纯校验；API 保留原校验导出，Host 主动投递与建议复用同一规则 |
| `matrix-api.mjs` | CS API 客户端；共享密码登录函数 `performMatrixPasswordLogin`；请求超时、结构化错误与同事务 429 重试 |
| `matrix-controller.mjs` | 控制器：沿用 `TokenBotController` 生命周期契约，connect/disconnect/重连、sync 循环状态机、诊断摘要（`getDiagnostics` 同构，凭据脱敏输出） |
| `matrix-runtime.mjs` | 入站漏斗调度、出站发送调度、流式编辑节流、合批窗口、表情反应生命周期任务表 |
| `matrix-bridge.mjs` | 对接种入 `MessageEvent` 归一化、回复引用、@提及剥、命令规范化、审批交互 |
| `matrix-config-store.mjs` | botId 级配置读写（凭据经 credential-binding 通道）；`e2eeMode`、加密相关高级项与能力开关的归一化校验，非法值 fail-loud 拒写 |
| `matrix-crypto.mjs` | 端到端加密编排层（libolm WASM 之上）：设备与一次性密钥注册、Megolm 房间加解密、对设备（to-device）消息的房间密钥共享/转发/请求、重放去重、待发事件冲流、设备漂移拒起、`getStats` 诊断；不引入外部 Matrix SDK |
| `matrix-crypto-store.mjs` | 设备本地加密状态持久化：account/PkDecryption/群会话 pickle 的原子写、按设备 key 存储、pickled store 的落盘/复原/删除；口令随 store 落盘（与 access token 同一信任边界，见调研文档 §4） |
| `matrix-state-store.mjs` | 状态持久化：`next_batch`、已加入房间集、DM 房间缓存、crypto store 目录（PR3） |

`plugin-src/host/channels/matrix/`（装配）：`index.mjs`/`production.mjs`/`rpc.mjs` 与 telegram 同构——`apply(ctx, config)` 经 `installProductionChannel(ctx, config, { channel: 'matrix', rpcChannel: MATRIX_RPC_CHANNEL, createProduction, createHandler })`；`inject: ['connection', 'credentials', 'typertGateway']`。

装配与注册点（逐项必查）：

1. `plugin-src/host/index.mjs`：注册表增 `applyMatrix` 与 `createImHostPlugin` internals 项。
2. `plugin-src/client/channel-card-meta.js`：matrix 卡片元（接入方式与消息回复两列文案）。
3. `plugin-src/client/channel-logos.js`：Matrix 图标。
4. `plugin-src/client/i18n.js`：全部 Matrix 文案中英双语；受 `verify-client-ui-i18n` 同类检查。
5. 设置页渠道表单：Matrix 字段（§4），高级项入折叠区。
6. 主动投递：`plugin-src/host/delivery-adapter.mjs` 渠道枚举与 target 校验 `case 'matrix'`；`delivery-suggestions.mjs` 增 `matrixSuggestion`；`delivery-service/http/rpc` 透传不变。
7. 会话标题：`session-channel-labels.mjs`、`session-title-prefix` 增 matrix 标签。
8. `package.json`：keywords 增 `matrix`；描述改"十二种 IM 渠道/twelve IM channels"。
9. README（中英）渠道表增 Matrix 行、结果文件回传要求表增 Matrix 行；`docs/access-modes.md`、`docs/bot-commands.md` 涉 Matrix 行为处增补。

## 4. 凭据与配置项

凭据表单（与 Telegram BotFather Token、Discord Token 表单同级体验一致）：

- 必填：homeserver URL（`https://` 前导校验；右去 `/`）。
- 二选一：access token（推荐，密码可掩显示）；或用户 ID（`@localpart:server` 格式校验）+ 密码。
- 可选高级项（默认值全数可达，不改即完整可用）：

| 配置项 | 默认值 | 语义 |
| --- | --- | --- |
| `proxy` | 空（尊重环境代理变量） | HTTP(S)/SOCKS 代理；SOCKS 缺依赖仅告警直连 |
| `deviceId` | 空＝服务端实际设备 | 稳定设备 ID 供 E2EE 身份持久化 |
| `e2eeMode` | `optional` | `off`/`optional`/`required` 三态门控 |
| `requireMention` | `true` | 群聊 @提及门槛 |
| `freeResponseRooms` | 空 | 免 @提及房间集 |
| `allowedRooms` | 空＝不限 | 群聊房间白名单（DM 豁免） |
| `ignoreUserPatterns` | 空 | 发送者正则黑名单 |
| `processNotices` | `false` | `m.notice` 入站开关（防 bot 互喷） |
| `allowRoomMentions` | `false` | 出站 `@room` 全体提及门控 |
| `reactions` | `true` | 生命周期反应开关 |
| `sessionScope` | `auto` | `auto`/`room`/`thread` 会话作用域 |
| `maxMessageLength` | `16000` | 出站分片尺寸，夹逼 `[500, 65535]` |
| `maxMediaBytes` | `104857600` | 入站媒体尺寸门（100 MB），先拒不下载 |
| `autoJoinInvites` | `authorized` | 邀请策略：`authorized`/`all`（见 §7） |
| `recoveryKey` | 空（PR3） | 交叉签名恢复密钥；经凭据通道存储，永不落日志 |
| `approvalRequireSender` | `true` | 审批反应键须原请求者本人 |
| `approvalTimeoutSeconds` | `300` | 审批反应超时作废 |

`.well-known/matrix/client` 自动发现为增强点（PR4）：录入 homeserver 后先取发现文档，成功则提示规范地址；用户提供"按输入直用"复选框则跳过发现。

## 5. 连接与认证状态机

照搬 hermes 数值，改进两处（429 精确退避、凭据掩码）：

1. 建连会话：代理经 session 级 `proxy=`（undici 侧等价物），无代理时尊重 `HTTP(S)_PROXY` 环境变量。
2. token 路径：`GET /whoami` 验证并解析 user_id/device_id；token 绑定的实际设备与配置 `deviceId` 冲突时服务端实际设备优先并大声告警（token 只能为其设备上传密钥，冒名身份即陈旧密钥故障根源）；设备解析不到则 `POST /keys/query` 以 `[]` 兜底，恰一个设备自动采用，零设备置未验证旗跳过服务端密钥校验。
3. 密码路径：`POST /login`（`identifier`、`password`、`device_name`、可选 `device_id`），回读 `device_id` 与 `access_token` 持久化复用。
4. 首帧：无 `since` 的 `sync(timeout=0)` 建立房间与 DM 状态，先处理 to-device 事件，再处理时间线与邀请；异步续点检查连接代际与取消信号，持久化 `next_batch` 前拒绝过期连接。
5. 增量：长轮询传入运行时取消信号；暂时错误展示为未就绪／连接中，5 s 可取消等待后在原循环继续，成功后清除该连接错误，不覆盖图片状态写入等其他未恢复诊断。永久错误停止循环；共享 supervisor 才能重建连接。
6. 429 限流：按 `retry_after_ms` 等待，并复用同一事务 ID，避免事件重发。
7. `stop`：撤销新工作接收，取消并等待启动、sync、邀请、Bridge 工作、原生发送和 reaction 任务，随后停止 crypto 并完成存储写入；不使用固定等待时间假定工作已经结束。控制器 `close` 等待同一关闭任务，关闭期间不允许延迟返回的工厂再启动连接。

## 6. 入站漏斗

漏斗全序（次序固定，任一环节剔除即不入）：

1. 防自：发送者与自身用户 ID trim+小写比对；自身身份未解析时按自消息丢弃（防"镜像大厅"回环，对齐 hermes #15763）。
2. 桥接/系统号剔除：localpart 以 `_` 开头（appservice/桥/傀儡约定）、空 localpart、畸形号；此类永不发配对/授权码。
3. 正则黑名单：`ignoreUserPatterns`。
4. 房间白名单：`allowedRooms`，DM 豁免；与 botId 级访问策略（Issue #95 私聊/群聊两档）在同一设置页编辑，保存后对后续入站即时生效、无需重连。
5. 去重：event_id 环形缓存（deque 1000）+ 集合。
6. 启动宽限：事件时戳早于连接时刻减 5 s 者丢弃；时钟偏移探测器——连接 30 s 后连续 3 次同向、偏移方差 < 60 s 判 host 时钟超前，一次性 NTP 告警（对齐 hermes #12614"进房而不答"）。
7. `m.replace` 编辑事件丢弃；`m.notice` 非 `processNotices` 丢弃。
8. 分流：`m.text`/`m.notice` 入文本路；`m.image`/`m.audio`/`m.video`/`m.file` 入媒体路。
9. @提及判定：MSC3952 `m.mentions.user_ids` 为权威信号；降级链——body 含全量 MXID → localpart 词边界正则 → `formatted_body` pill 链接；`@user:server` 全量式方剥，绝不裸剥 localpart 词（防"某某机器人"剥成"机器人"）。
10. 合批：0.6 s 静默窗口，近分拆阈值尾时 2.0 s；合批键与网关会话键同源（群按按用户分流、线程不按）。
11. 已读回执与输入提示先行发出；回执为自包含 try 的后台任务，不再裸抛无人管理。

复用（不复制九套业务逻辑）：`inbound-access`/`access-policy`、`inbound-file`（附件缓存与 TTL 清扫）、`batch-input`、`command-catalog`、`harness-session-binding`、`deferred-delivery`、`status-reaction`。

会话作用域：`sessionScope` 决定合成线程策略（真 `m.thread` 关系恒保持）；会话键含 room（+thread）维度。历史/恢复类命令的 Matrix 分支实装跨房防护：无来源 fail-closed、非同房同线程拒绝、`--all` 仅管理员；`/status` 以 `sha256` 前 12 位指纹示会话键（对齐 hermes `gateway/slash_commands.py` 的 Matrix 防护，落点在 dsh-im 共享层的 Matrix 分支）。

## 7. 房间邀请策略

1. `invite` 事件先过授权邀请人门：`autoJoinInvites=authorized` 时邀请人须在 botId 级发送者白名单（owner/接入者身份恒为授权邀请人，与 Issue #95"原有授权身份始终保留"一致）；非授权则拒绝并留日志。
2. join 非阻塞：45 s 超时、同房去重任务表；成功后更新已加入房间集、清除房间身份缓存；`is_direct` 则登记 `m.direct` account data。
3. 死房婉拒：join 错误串含 `no servers` 或 `room not found` 判死房，发 `leave` 婉拒该邀请，防每次重启死灰重试；瞬态故障（网络）保留邀请下次再试。
4. 对账：每次全量 sync 后扫 `rooms.invite` 补漏 join（幂等）。
5. 私聊判定权威：成员数 ≤ 2 为主判据；`m.direct` + 无名房间辅助；有名房间压过陈旧 `m.direct` 记录判 room 并标冲突旗。
6. `autoJoinInvites=all` 为开发/试用档，需显式二次确认并警示文案。

## 8. 出站发送管线

1. 双份：`body` 纯文本恒备；`formatted_body` HTML 经预 sanitization——先期剥离 `script`/`style`/`on*`/`javascript:`/`data:`/`vbscript:`，白名单标签集、`href` scheme 白名单 `http/https/matrix/mailto`、`class` 限 `language-*`；`format` 标 `org.matrix.custom.html`。
2. @提及 pill：保护区（围栏代码、行内代码、链接区）外将 `@user:server` 注入 `<@mxid>` 链接；随发附加 `m.mentions.user_ids`；`@room` 受 `allowRoomMentions` 门控。
3. 关系：回复引用 `m.in_reply_to`；线程 `m.thread`（含回退为回复的 fallback `is_falling_back`）；编辑 `m.replace` + `m.new_relation`（`m.new_content` + `"* "` 前缀新旧兼容）；表情反应 `m.annotation`。
4. 流式编辑：复用 `editable-message-stream`；Matrix 特例不带光标（部分客户端光标显豆腐块），保留 buffer_only 渐进；编辑间隔 + 字符阈值双触发；flood 自适应退避倍增封顶 10 s；连 3 strike 废编辑改纯发送。
5. 分片自管：`maxMessageLength` 16000 自管分片，声明渠道自管分片，投递层不再二次截断（对齐 hermes #53026：4000 会把 Markdown 表格拦腰折断）。
6. 媒体仓储上传：共享交付策略尝试 `m.image`，明确失败时最多再尝试一次 `m.file`；Matrix 原生发送不再增加第二层回退。事件提交结果未知时不发送新的文件事件；所有成功结果透传服务端事件 ID。
7. 外链媒体下载具备 SSRF 防护：scheme 白名单、连接时 IP 校验、逐跳重定向复检、跳数上限 20、Content-Length 预检与分块累计上限；下载失败的回退提示文本不含 URL 凭据（防外泄）。
8. 输入提示：typing 通知（`PUT /typing`）；已读回执；presence 上线/离线附 status message。

## 9. 交互与命令

1. 命令复用 `command-catalog`；入站前缀规范化 `!`→`/`，经已知命令表核验，普通感叹号保持聊天原文（Matrix 客户端保留 `/` 为客户端本地命令）。
2. 审批：`harness-approval` 以表情反应键位呈现——✅ 单次、🔐 会话、♾ 始终、❌ 拒绝，键含变体别名；反应者须为白名单用户且 `approvalRequireSender` 时须原请求者本人；超时作废并撤回机器人自发的一切表情反应；`on_processing_start/complete` 生命周期反应 👀→✔/✘（取消不发 ✔/✘），受 `reactions` 开关。
3. 提问/选择：`harness-question` keycap 键位至 12 席，同一超时作废机制。
4. 会话/工作区/模型/预设等全部控制命令与九渠道同一行为，不新设 Matrix 专命令。

## 10. 主动投递与结果文件回传

1. 目标语法：`matrix:!roomId:serverName`（群聊）与 `matrix:@user:server`（私聊，先查 `m.direct` 缓存，无则按 `is_direct` 语义首条建会话）；与《Issue-65-botId-targetId稳定主动投递方案》同构，`delivery-adapter.mjs` 校验 `!`/`@` 形态与 server name。
2. 投递建议：`delivery-suggestions.mjs` 增 matrix 建议项；私聊投递目标当前会话双向同步方案同步适用。
3. 结果文件回传：复用 outbound-artifact（受信工具显式登记、绑定 Session/Turn）；图片优先文件回退；发送结果不确定时不补发，防重复消息。
4. 超时补发：复用 deferred-delivery——"等待模型回复超时"任务跟踪，完成后补发最终文字至原房间/线程；`/stop` 只停当前聊天提交的对应回合。

## 11. E2EE 分期（PR3）

1. 目标（PR3 实装面）：加密房间收发的 Megolm 加解密、设备与一次性密钥的服务端注册校验、房间密钥经对设备（to-device）消息的共享/转发/请求闭环、pickled store 的落盘复原与设备漂移拒起、`e2eeMode` 三态门控。加密附件的 AES-CTR 封装加解密、交叉签名/SSSS 备份恢复/交互式验证不在本期范围（见 §2.2 与《Matrix端到端加密可行性调研.md》）。
2. 实现路径：libolm 的 WebAssembly 构建 + 自研 crypto store——文件持久化、原子写、按设备 key 存储；设备变更即重置 store；陈旧 pickle 式迁移顺序**先会话后账号**（账号记录为迁移提交标记，先写账号会让被打断的清扫永不再重试）；两把 key 都解不开的记录原地不动仅告警。
3. 服务端校验：`query_keys` 取本设备 `ed25519` 比对——缺失则置 unshared 上传后复查；陈旧且已 shared 硬失败，提示删 store 或换 token；陈旧未 shared 试 `DELETE /devices/{id}` 再上传。
4. 交叉签名（本期不实装，`recoveryKey` 通道字段预留）：设想为 `recoveryKey` 经凭据通道存储（永不明文、不落日志），配置即 `verify_with_recovery_key`；无密钥时不自动生成。PR3 未接通交叉签名/SSSS 备份恢复/交互式验证的任何路径，配置项存在但行为空，留待后续增强；详见 §2.2 范围边界与《Matrix端到端加密可行性调研.md》。
5. 门控：`e2eeMode=optional` 依赖装载失败→加密房间降级并渠道日志告警；`required` 拒连并告警——"加密房间会静默失败"不可接受。
6. 前置 spike：PR3 开工前先验证 libolm wasm 在 Node 22.19+ 目标环境的可行性；不通过则保持 optional 降级并在实施记录留痕结论；**不引入原生编译依赖**，不破坏全平台一致可用。spike 已完成：主选定 `@matrix-org/olm@3.2.15` WASM 直连（零原生编译、整包约 651 KB、Apache-2.0、零运行时依赖）+ 自持 Olm/Megolm 编排层，备选 `matrix-js-sdk` 之 `initRustCrypto`；详见《Matrix 端到端加密可行性调研》。
7. 编排层依 WASM 实测 API 落定（`test/channels/matrix/matrix-crypto.test.mjs` 以真机 WASM 环回锁死这些契约，防回归）：`PkEncryption.encrypt` 返回 `{ciphertext, mac, ephemeral}`、`PkDecryption.decrypt(ephemeral, mac, ciphertext)`、`Utility.ed25519_verify(publicKey, message, signature)`（参数次序颠倒即抛 `OLM.INVALID_BASE64`）、`InboundGroupSession.decrypt(ciphertext)` 返回对象 `{plaintext, message_index}`（非裸字符串），`first_known_index()` 与 `message_index()` 为取值方法；编排层对字符串/对象双形态解密返回兼容处理，重放以已见 message_index 集合去重。加密房间内 `m.file`/`m.image` 等附件走 Megolm 事件携带明文字段（`url`/`file` 未做 AES-CTR 封装），属用户可见的既定降级，非规范加密附件，详见《Matrix端到端加密可行性调研.md》范围边界节。

## 12. 渠道能力矩阵与降级规则

| 能力 | Matrix 实现 | 降级规则（明确降级，非撤） |
| --- | --- | --- |
| 文本/富文本 | HTML `formatted_body` + 纯文本双份 | sanitizer 失败发纯文本单份 |
| 流式呈现 | 编辑同一条消息（`m.replace`） | 编辑废 3 strike 改整条发送；光标不显（特例） |
| 长消息 | 16000 自管分片 | 无 |
| 回复引用/线程 | `m.in_reply_to`/`m.thread` | 线程回退为回复 |
| @提及 | pill + `m.mentions` | 纯文本 MXID |
| 图片/文件 | media upload 原生 | 图片回退文件附件 |
| 音频 | `m.audio`（+voice 旗标） | 不转码，按普通音频/文件；不谎报气泡 |
| 审批/提问 | 表情反应键位 | 文本 `!approve/!deny` 键 |
| 输入提示/已读 | typing/typing-receipt | 失败静默跳过 |
| 生命周期反应 | 👀/✔/✘ | `reactions=false` 关闭 |
| 主动投递/结果文件 | 原生 | 平台限流以 `retry_after_ms` 退避 |
| E2EE | libolm wasm（PR3 已接线：设备密钥注册、Megolm 收发改解密、to-device 共享/转发/请求闭环） | optional 缺依赖→加密房间降级提示；required 拒连；加密房间内附件未做 AES-CTR 封装加解密，按明文字段随 Megolm 事件发送（既定降级，非规范加密附件） |
| 扫码接入 | 无（明确不做） | 凭据表单接入 |

## 13. 安全与门控

- 凭据永不落日志：token、密码、恢复密钥在诊断摘要、错误文案、日志中一律脱敏（URL 脱敏等价物）。
- 本地路径不回显聊天；发送失败的提示不含签名媒体 URL 与凭据。
- 桥接/appservice 消息永不发配对/授权码。
- 房间邀请经授权邀请人门控（§7）。
- 房间管理类能力（建房、请人、红action）若未来工具化，门控与房间白名单校验必须在工具派发层显式实装，默认关闭——戒 hermes"门控声明存于 docstring 与文档而代码未实装"之覆。
- HTML sanitizer 白名单为唯一出站出口；模型产出的富文本一律经 sanitization 后发送。

## 14. 测试与验收计划

1. 单元测试 `test/channels/matrix/*.test.mjs`（`node --test`）：API 错误三分类与 429 退避（mock fetch）、whoami/设备对账、sync 永久错误停环、去重/宽限/时钟偏移、@提及三态判定链、sanitizer 对抗用例（`script`/`on*`/`javascript:`/`data:`）、关系构造、邀请门控/死房婉拒/`m.direct`、合批窗口、分片、目标语法校验；PR3 增 crypto store 迁移顺序与设备重置。
2. 共享层集成：`test/channels/access-policy-fixture.mjs` 同构 fixtures 跑访问策略、命令、审批、投递全链路。
3. 实机验收（matrix.org 测试服务器或本地 Synapse + Element，按仓库《实测记录》惯例留痕）：邀请进群→应答、群聊 @提及门槛、加密房间（PR3）、流式编辑不闪、审批反应、主动投递、结果文件回传、`/stop`、断线重连。
4. UI：设置页新表单与卡片中英双语齐；用户可见 GUI 变更的 PR 须附演示记录（GIF，按 `record-browser-gif` 惯例）。
5. 文档：README（中英）渠道表与结果文件回传要求表、`docs/access-modes.md`、`docs/bot-commands.md` 同步修订。

## 15. PR 切分与验收门

| PR | 内容 | 验收门 |
| --- | --- | --- |
| PR1 渠道本体 | §3 全部注册点、§4 配置、§5 连接、§6 入站漏斗、§7 邀请、§8 出站（未加密全链路）、§10 投递/回传、设置页 + i18n + 图标 + 会话标签 + README/keywords | §14.1–14.3 非 E2EE 项全过；实机 matrix.org 测试服务器 Element 验收 |
| PR2 交互增强 | §9 审批/提问反应键、生命周期反应、typing/receipt/presence、`!` 命令规范化、跨房 `/resume` 防护 | 审批与命令全链路实机全过；跨房防护对抗用例全过 |
| PR3 E2EE | §11 实装面（Megolm 收发改解密、设备/一次性密钥注册校验、to-device 共享转发请求闭环、pickled store 落盘复原与设备漂移拒起、`e2eeMode` 三态门控） | `matrix-crypto.test.mjs` 真机 WASM 环回全过：bootstrap 注册＋重启复原同身份、设备漂移拒起、共享→导入→解密→待发冲流、重放去重、未知 sender_key 拒解、store 文件布局；runtime E2EE 用例覆盖三态门控、入站解密达桥、出站 `m.room.encrypted` 封装、to-device 分发、成员变更触发重共享失效、maintain 与停机；加密附件加解密与交叉签名/恢复路径不在本期验收范围（见 §2.2） |
| PR4 后发优势（可选） | `.well-known` 自动发现、语音气泡转码评估、`create_room` 注入 `initial_state`/power levels、appservice 调研 | 按项单独验收 |

## 16. 风险与开放问题

- homeserver 异构：部分服务器密码登录走 OAuth/UIA 流程，密码路径兼容性有限；表单以 token 为主推荐并在文案中明示。
- libolm wasm 决策未经实证：PR3 前置 spike 验证；兜底为保持 optional 降级，不阻塞 PR1/PR2。
- CS API 演进（MSC 未批准项如 `m.mentions`）：一律"权威信号 + 降级链"双轨，单信号失效不断链。
- 长尾渠道维护成本 vs 用户价值：验收以本方案能力矩阵为限；后续新能力入统一语义流程（ADR-0001），不私设 Matrix 专用旁路。
- 多机器人并行部署：crypto store 与状态按 botId 目录隔离；跨机器人不共享 device_id 与凭据。
- 开放问题：`sessionScope=thread` 下投递目标的 thread_id 维度是否与 Telegram Topic 投递同构（PR1 实施记录裁决）。

## 17. 参考实现要点（hermes-agent 溯源）

均指 `plugins/platforms/matrix/adapter.py`（NousResearch/hermes-agent，5423 行），除非注明：注册 `register(ctx)` 5403-5423；连接 `connect()` 1677-2108；sync 循环 `_sync_loop` 2985-3060；邀请 `_on_invite`/`_join_room_by_id`/`_schedule_invite_join`/`_schedule_pending_invite_joins` 3742-3855；E2EE store 重置与迁移 1441-1591、装配 1870-2011、`_CryptoStateStore` 1068-1133；入站漏斗 `_on_room_message` 3171-3310、上下文/提及 `_resolve_message_context` 3312-3428、`_is_bot_mentioned`/`_strip_mention` 4877-4938；富文本 `_build_text_message_content` 4773-4789、`_markdown_to_html(_fallback)` 4964-5149、sanitizer 414-490/902-940；发送 `send()` 2153-2215、`edit_message` 2295-2325、媒体 `_upload_and_send` 2833-2923、语音转码 147-275；审批/选择器 2610-2821；reaction 3861-3967；合批 4228-4290；跨房 `/resume` 防护在 `gateway/slash_commands.py` 978-1010、4775-4888；流式编辑节流在 `gateway/stream_consumer.py`；房间边界 prompt 在 `gateway/session.py` 557-571；Windows 能力门在 `tools/lazy_deps.py` 539-552。已知缺陷（本方案不重复）：`MATRIX_TOOLS_ALLOW_*` 门控仅存 docstring 与文档；`MATRIX_HOME_CHANNEL(_NAME)`（plugin.yaml）与代码实读 `MATRIX_HOME_ROOM*` 命名不相副；429 无专设处理；无 `.well-known` discovery。
