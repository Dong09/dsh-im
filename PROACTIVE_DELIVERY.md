# 主动投递使用指南

**简体中文** · [English](PROACTIVE_DELIVERY.en.md)

主动投递让应用在没有用户新消息的情况下，通过已经接入 DSH-IM 的机器人发送文字消息。调用方只需保存一组稳定的 `botId + targetId`，不需要保存 Harness `sessionId`、聊天引用、消息 ID 或临时 Webhook。

九个内置渠道均支持主动投递：微信、飞书、钉钉、企业微信、QQ、Slack、Telegram、Discord 和 WhatsApp。

## Matrix 群聊定时附件（附件默认开启）

Matrix 群或线程的原生定时回合由两条独立链路处理：官方会话同步负责最终回答，自研 schedule relay 仅负责已登记的图片／文件。`matrix.scheduleReplies` 默认开启的是附件权限与发送，不会自动开启最终文字；最终文字必须启用「通用设置 → 投递」的全局 `deliverModelAnswers`，并满足当前绑定及下文的保存目标策略。房间和线程共用 Matrix ID 校验，支持经典格式及 v12 哈希房间 ID。附件不要求额外插件、手填 Room ID 或保存投递目标；下方的手动目标步骤不是附件回群的前置条件。

适用于每个群或线程使用独立 Session 的场景。从 Web 在同一 Session 创建的原生提醒也可获得附件权限。真实定时输入在首个模型步骤前获得仅属于本轮的附件权限；运行时、时间快照、技能目录和本插件上下文通知不算用户插话。混入真人输入或未知来源会撤销本轮定时附件权限，普通 IM 仍走原回复链。无绑定、私聊、其他渠道及多个目标共用 Session 时均不开定时附件权限。

模型须调用 `dsh_im_return_file` 显式登记已有图片或文件；成功仅表示“已登记待发送”，不等于 Matrix 已送达。原文件不为发送重新生成或改名；Web 展示卡片、Markdown 路径、失败工具及失败 Code Mode 外层不会被扫描补登记。正常完成后附件按登记顺序发送，但**文字与附件相对顺序不保证**。最终文字为空、官方文字失败／结果未知或文字同步关闭，都不会单独阻止仍获授权的附件；没有已确认附件时，不创建自研发送 attempt，也不发送最终文字兜底。附件失败的操作性提示不是最终回答，不算附件成功，也不授权补发文字或重新生图。

取消、附件路由失效或检查点写盘失败会停止后续附件。图片明确失败最多转文件一次；超时、网络故障、5xx 或缺少有效原生事件回执均视为未知，不换类型重发。已知加密房间缺少可用加密能力时在上传前拒绝，不明文降级。内部附件入口仅接受真实 managed artifact，不接受文字、伪造对象或任意 path／URL／bytes；公开 HTTP／RPC 仍是文字接口，不新增本地文件读取能力。

已记录的旧 Session **附件**回复位置会保留到 `/new` 之后，但不等于旧 Session 仍有官方文字绑定：当前绑定切走后，旧任务可以只有附件没有最终文字，不能借附件旧路由兜底文字。新旧候选冲突时拒绝附件发送，不自动改投新 Session 或其他线程。

状态保存在 Matrix `dshHome` 下的 `integrations/dsh-matrix/schedule-replies.json`。version 2 保留目的地、冲突、最近尝试 turn 和不可变部分清单；**新 attempt 必须是显式非空、全为 artifact 的清单，其结果只描述附件，不代表官方文字成功或失败**。每个附件保留状态、可用 `providerMessageIds` 与安全错误码；附件失败通知单独记录，不算附件成功。全部必需附件均确认成功才是附件 attempt 的 `sent`；部分结果汇总时 `sending`／`unknown` 优先于失败。上传／发送前先持久化完整意图与该附件的 `sending`，提供方返回后在发送 closure 之外记录终态；终态写盘失败保留已有防重记录并释放剩余快照，不转文件重发。查看 Host 的 `[schedule-im-relay]` 诊断及 `lastAttempt.parts`，不能用文字或通知可见推断附件送达。状态不保存凭据、文件字节或本地绝对路径。

reader 兼容有效 v1 四种尝试状态，以及 v2 的历史 text／mixed／artifact 清单与各部分状态；旧文字只作为历史证据保留，不发送、不调用废弃 writer 修补。首次 v2 写入前在原文件旁保留逐字节 `.v1.bak`，再原子升级；目的地、冲突及高水位不丢失。损坏、未来版本或备份／写盘失败明确拒绝，不按空库继续发送。重复完成、重启、发送后写盘失败均不重开已尝试回合；历史 `pending`、`sending`、`unknown`、`failed` 不恢复快照、不从旧路径补发，也不补发历史文字。用户须提出新的明确请求，上线不补发旧任务。

不要把 v2 文件交给只读 v1 的旧版本，也不要删状态后重启。回滚优先恢复基线 `7a73dd6a` 的完整文字 relay 及双发送器排除桥，不可仅恢复文字发送而缺少去重桥；保留当前 v2 状态。降级前先关闭定时附件并停止当前 Host；优先保留新状态、关闭功能并修复前滚。若必须恢复备份，先在隔离副本核验，禁用所有在新版开始过的任务并保留 v2 状态人工核对，避免高水位缺失导致重发。测试只使用隔离 `dshHome`，不操作生产状态。加载更新后的 Host 产物才生效，浏览器刷新不能替换 Node 已导入模块；远程 Harness 模式不启用本地回合监听。

`matrix.scheduleReplies: false` 仅关闭定时附件；`scheduleReplyTimeoutMs` 默认 60000 毫秒，仅约束附件发送调用，不限制模型执行。官方回答由全局 `deliverModelAnswers` 独立控制；关闭任一开关不会把其职责转交另一条链路。两者不再使用完成事件归属表或目的地排除协议。普通文字分段已有成功回执或 Matrix 返回发送结果未知时，仍不得将整段回答作为纯文本重发。删除原生提醒可停止后续触发，不撤回已开始的平台请求。

## 快速开始

1. 打开「设置 → IM机器人」，找到需要发消息的机器人。
2. 点击机器人卡片右上角的齿轮图标。
3. 在「调用标识」中复制 `Bot ID`。
4. 点击「新建目标」，从已聊会话中选择，或点击「手动填写（高级）」填写平台原生 ID。
5. 填写或确认 `Target ID`、目标类型和平台原生 ID。
6. 点击「测试」。目标收到 `DSH-IM 主动投递测试成功。` 后，再点击「保存目标」。
7. 在已保存目标上点击「复制调用参数」，得到可供应用保存的 `{ botId, targetId }`。
8. 使用 HTTP POST、同 Host 的 `ctx.dshIm.send()` 或 Connection RPC 的 `message.send` 发送消息。

## 配置投递目标

### 1. 获取 Bot ID

`botId` 是当前已接入机器人的真实调用标识。请从设置页复制并将它视为不透明字符串，不要根据前缀推断渠道，也不要使用机器人名称、平台 App ID 或卡片中的脱敏 ID 代替。

目标配置跟随当前机器人保存。移除机器人时，它的投递目标也会被清理；重新接入后应重新复制 `botId` 并配置目标。

### 2. 新建目标

点击「新建目标」后，默认显示「从已聊过的会话选择」下拉框：

- 候选来自该机器人已经持久化的会话映射，不是平台通讯录，也不是严格按时间排序的完整最近会话列表。
- 候选只包含投递所需的目标类型和平台原生 ID，不包含 Harness `sessionId`、消息正文、消息 ID、会话名称或最后活跃时间。
- 已配置的相同目标会显示「已添加」并禁用。
- 没有候选时，先在对应平台与机器人聊一条消息，再点击「刷新」。仍未出现时可使用「手动填写（高级）」。

选择候选只会预填表单，不会自动保存。

### 3. 理解 Target ID

`targetId` 是你为调用方定义的稳定别名，不是平台用户 ID、群 ID 或频道 ID。

- 它只需在同一个机器人下唯一；不同机器人可以使用相同的 `targetId`。
- 可使用大小写字母、数字、点、下划线、冒号、`@` 或连字符，长度为 1–128 个字符。
- 新建时页面默认生成 `tgt_` 加 16 位十六进制随机串，例如 `tgt_7f3a91c8d2e64b10`。
- 首次保存前可以修改，例如改成 `daily-report` 或 `release-alerts`。
- 保存后 `targetId` 不可修改，但名称、目标类型和平台原生路由可以修改；调用方仍使用原来的 `botId + targetId`。

### 4. 测试、保存和复制

从会话新建、手动新建和编辑目标时，表单底部都会显示「测试」按钮：

- 机器人在线且当前目标所需的平台 ID 已填写完整时，测试按钮才可用。
- 测试使用当前表单中的目标类型和平台 ID，不会先创建、更新或保存目标。
- 修改测试过的平台 ID 后，旧的成功提示会清除，需要重新测试。
- 已保存目标列表中的「测试」按钮测试该目标当前保存的路由。
- 测试成功表示平台发送接口已接受请求或 SDK 成功返回，不代表消息已经被阅读。

保存后点击「复制调用参数」，页面会复制如下 JSON：

```json
{
  "botId": "bot_9577c8572d454122a4ef7fb4d8420a91",
  "targetId": "release-alerts"
}
```

### 配置示例：飞书告警群

假设飞书机器人已经在告警群中收到过消息：

1. 打开该机器人的设置页并复制 `Bot ID`。
2. 点击「新建目标」，在下拉框中选择告警群。
3. 将自动生成的 `Target ID` 改为 `release-alerts`，显示名称填为「发布告警群」。
4. 确认目标类型为「群聊」，群 Chat ID 已自动填入。
5. 点击「测试」，到飞书群中确认测试消息。
6. 点击「保存目标」，再点击「复制调用参数」。

以后即使编辑并更换群 Chat ID，调用方仍可继续使用同一组 `botId + release-alerts`。

## 会话双向同步

官方会话文字同步由「通用设置 → 投递」的全局开关控制。机器人没有保存目标时，文字可按 Session 当前聊天绑定投递（私聊、群聊、Slack Thread、Telegram Topic、Discord 频道等），不要求预先建目标；机器人已有保存目标时，则仅使用已启用同步且仍匹配该 Session 的目标。保存目标存在但没有匹配／启用候选时，不绕过目标策略回退到绑定发送。

1. 在该聊天里的普通提问和 `/steer` 仍走原回复链，不会被同步逻辑重复发送或转发到其他目标。
2. 其他来源的 Turn 成功完成后，只投递**最终回答**——最后一次工具调用之后的文字，而不是各 step 拼接的全文，也不是工具调用之前的寒暄：Web GUI 中提交的 Turn、定时任务（`schedule`、`deliveryMode: host`）、待答问题回执，以及 `subagent-settled` 等内部通知发起的 Turn。
3. 是否把 Web 中输入的文字本身也镜像到聊天、是否投递模型回答，由「通用设置 → 投递」决定；两个前缀图标分别作用于镜像的输入与模型回答。
4. 只有读者自己在 Web GUI 里提交的文字才会被镜像：Host 注入的上下文快照、定时提醒和内部通知都不会回显，只投递模型回答。镜像发送失败时，该 Turn 的回答也不再投递。
5. 渠道自己渲染回答时（飞书过程卡片），卡片就是这次投递：最终回答写在卡片里，只有卡片没能确认，才补发一条纯文字。同一条回答因此只会到达聊天一次，不会既在卡片里又以文字重发一遍。两个全局开关关闭时，卡片与文字一起停发，因为两者读的是同一份开关。
6. 每次发送重新验证当前绑定或保存目标的 Session 匹配；`/session`、`/new`、删除目标、改绑或禁用会使旧候选失效。没有可用文字路由时不发送，诊断不含消息正文；旧附件目的地不会被用作文字路由。

服务注入不会决定 Turn 的来源：Host 在每个 Turn 前注入的上下文快照、定时提醒与内部通知只是「这是本 Turn 的一条消息」，不会把 Turn 判成服务发起的。只有整个 Turn 都没有一条来自读者（Web 或本聊天）的消息时，才按服务发起的 Turn 投递回答；只要其中一条消息来自本聊天，该 Turn 就由聊天自己回答，同步逻辑完全不投递。

保存目标行的「会话双向同步」开关参与文字候选筛选。官方文字协调器显式使用内部 `listSessionSyncTargets(sessionId, {privateOnly:false})`，允许合法、已启用且仍绑定本 Session 的保存房间／线程目标；这不是任意房间授权。默认枚举仍是私聊，审批／提问及其 Web／桌面兜底通知继续限私聊，describe／present 权限和 DS Bot 私聊歧义规则不变，群成员不会因此获得代答／审批权。官方同步只处理当前 Host 的文字或既有回答卡片，不同步附件、工具过程或历史消息；Matrix 定时附件是上文独立扩展。显式配置远程 `harnessBaseUrl` 的渠道仍不支持本地同步。

## 投递设置

「通用设置 → 投递」保存的是全局设置，不属于单个机器人，写入 `<dshHome>/integrations/dsh-im/delivery-sync-settings.json`：

```json
{
  "version": 1,
  "deliverySync": {
    "mirrorUserInput": false,
    "deliverModelAnswers": false,
    "inputIcon": "",
    "modelIcon": ""
  }
}
```

- `mirrorUserInput`：把在 Web GUI 中提交的用户文字镜像到该 Session 绑定的聊天；默认关闭。关闭时不发送输入，模型回答照常投递。
- `deliverModelAnswers`：投递「非本聊天发起」的 Turn 的模型回答；默认关闭，与输入镜像一致。全新安装两项都是关闭的；设置文件无法读取时同样按两项关闭处理——协调器只记录一条警告，不会自行开始镜像。
- `inputIcon` / `modelIcon`：镜像输入与模型回答的前缀图标。去除首尾空白，最长 32 个字符，不允许多行或控制字符；无效值按空字符串处理，空字符串表示不加前缀。非空时消息格式为「图标 + 空行 + 文字」。

设置页通过当前 Host 的已认证 management transport 读写 `settings.delivery-sync.get` / `settings.delivery-sync.set`（`set` 仅应用传入字段，至少一个字段）。channel 为 `/dsh-im-delivery-sync`，Fetch carrier 路径为 `POST /api/dsh-im/dsh-im-delivery-sync`，遵守现有 `rpcAuthority` 与 Harness 认证，不使用公开主动发送 HTTP 代替。

只启用回答时：先 GET `{}` 记录原值 → SET `{deliverModelAnswers:true}` → 同一运行 Host 再 GET `{}` 读回，核对输入镜像和两个图标未变；原本开启的输入镜像也应保留并报告。这是全局设置，影响其他已绑定聊天的非 IM 回合，不是 Matrix 单 bot 开关。

store 是同 Host 单例且有缓存，直接编辑 JSON 或另起进程写同路径不等于运行实例生效；无法认证或无法确认目标代码已加载时，明确保留未启用，不降权限、不擅自重启。协调器每回合缓存设置，验证应使用读回之后的新回合。以上是操作说明，不表示本轮已在运行实例启用或已向 Matrix 验收发送。

消息语言通过 `settings.language.set` 在「跟随 DSH 界面语言」与 `zh`／`en`／`ru` 之间切换：显式选择优先于 DSH 界面语言，插件 `language` 选项仍然优先于两者。

## 九渠道手动填写字段

优先从已聊会话中选择。只有目标未出现在候选中时，才需要手动取得以下平台原生 ID。

| 渠道 | 目标类型 | 需要填写的字段 | 示例或说明 |
| --- | --- | --- | --- |
| 微信 | `user` | 微信用户 ID（`toUserId`） | 填写接收消息的微信用户 ID |
| 飞书 | `user` | Open ID（`openId`） | 例如 `ou_xxx` |
| 飞书 | `group` | 群 Chat ID（`chatId`） | 例如 `oc_xxx` |
| 钉钉 | `user` | 用户 ID（`userId`） | 填写钉钉用户 ID |
| 钉钉 | `group` | 群 Open Conversation ID（`openConversationId`） | 主动投递不使用临时 `sessionWebhook` |
| 企业微信 | `user` | 用户 ID（路由字段为 `chatId`） | 私聊填写用户 ID |
| 企业微信 | `group` | 群 Chat ID（`chatId`） | 群聊填写群 `chatid` |
| QQ | `user` | 用户 Open ID（`userOpenId`） | 平台提供的 `user_openid` |
| QQ | `group` | 群 Open ID（`groupOpenId`） | 平台提供的 `group_openid` |
| Slack | `conversation` | Channel ID（`channelId`） | 例如 `C0123456789` |
| Slack | `thread` | Channel ID + Thread 时间戳（`channelId`, `threadTs`） | 例如 `1712345678.123456` |
| Telegram | `chat` | Chat ID（`chatId`） | 十进制字符串，例如 `-1001234567890` |
| Telegram | `topic` | Chat ID + Topic ID（`chatId`, `messageThreadId`） | Topic ID 必须是正整数 |
| Discord | `channel` | Channel ID（`channelId`） | 私信、频道和 Thread 都使用可发消息的 Channel ID |
| WhatsApp | `user` | 用户 JID（`jid`） | 例如 `8613800000000@s.whatsapp.net` |
| WhatsApp | `group` | 群 JID（`jid`） | 例如 `1234567890-123456@g.us` |

平台 ID 字符串不能为空或带首尾空格。一个目标只接受所选渠道和类型要求的字段，额外字段会被拒绝。

## 通过 HTTP POST 发送

普通外部应用可以直接调用 Host 的主动投递接口：

```bash
curl --request POST \
  http://127.0.0.1:3080/api/dsh-im/delivery/messages \
  --header 'Content-Type: application/json' \
  --data '{
    "botId": "bot_9577c8572d454122a4ef7fb4d8420a91",
    "targetId": "release-alerts",
    "text": "构建已经完成。"
  }'
```

成功返回：

```json
{ "sent": true }
```

请求体接受必填的 `botId`、`targetId`、`text` 和可选的 `format`（`plain` 或 `markdown`，默认 `plain`），JSON 总大小不能超过 1 MiB。不要附加平台原生路由、`sessionId`、`chatRef`、临时 Webhook 或 `idempotencyKey`。

接口路径固定为 `POST /api/dsh-im/delivery/messages`，复用当前 DSH Host 的 WebServer，不会另开端口。示例中的 `3080` 是 Web profile 的默认端口；实际地址以 Host 启动时显示的地址为准。

当前 HTTP 接口不包含鉴权，也不提供 CORS。只应在本机或可信网络中使用，不要直接暴露到公网。

## 在同一 Host 的插件中发送

消费插件声明 `dshIm` 注入后，可以直接调用共享服务，不经过 Connection RPC。

下面是一个最小示例；插件加载时会发送一次消息：

```js
export const inject = ['dshIm'];

export async function apply(ctx) {
  const result = await ctx.dshIm.send(
    'bot_9577c8572d454122a4ef7fb4d8420a91',
    'release-alerts',
    '构建已经完成。',
  );

  if (result.sent !== true) {
    throw new Error('主动投递没有返回成功结果');
  }
}
```

实际使用时，把 `ctx.dshIm.send()` 放进你的定时任务、构建回调或业务事件处理函数中。可选的第四个参数支持取消信号和文本格式：

```js
await ctx.dshIm.send(botId, targetId, text, { signal }); // 保持原有默认发送行为
await ctx.dshIm.send(botId, targetId, '# 每日报告\n\n**检查完成**', {
  signal,
  format: 'markdown',
});
```

`format` 只接受 `plain` 和 `markdown`，省略时为 `plain`。HTTP 和 `message.send` RPC 可添加同名字段。Markdown 复用各渠道的发送路径，不启动 Session 或新的流式输出：

| 渠道 | Markdown 呈现方式 |
| --- | --- |
| 飞书/Lark | 原生 Markdown 卡片 |
| Telegram | Rich Markdown，复用既有文本回退 |
| QQ | Markdown 消息；已知格式拒绝时仅当前分段回退文本 |
| 钉钉 | 主动 Markdown 消息；明确格式拒绝时回退文本 |
| Slack | 标准 Markdown block，保留通知文本；明确 block 拒绝时使用原有文本发送 |
| 企业微信机器人 | 现有 Markdown 消息类型 |
| Matrix | 清理后的 HTML，并附带文本正文 |
| Discord | 消息正文的原生 Markdown |
| WhatsApp | 有限转换常用格式，保护代码，复杂语法保留原文 |
| 企业微信应用／微信 | 完整文本，保留代码和链接目标 |

长消息按渠道限制分段。飞书主动卡片保留原有不自动分段的行为，平台拒绝或结果未知时不自动改发文本。其他新增回退仅针对本地格式处理错误或明确的格式拒绝，不重发已成功的分段，不因网络结果未知而改格式重试。旧 Host 可能忽略 `format`，需要加载更新后的插件。

会话同步的最终助手回答请求 Markdown，镜像的 Web 输入使用纯文本；地址遵守上文当前绑定／保存目标策略。既有渠道回答卡片确认时由卡片承载回答，未确认才走文字回退，不另发相同回答。

同 Host 插件也可以列出某个机器人的已保存目标：

```js
const targets = await ctx.dshIm.listTargets(botId);
// [{ targetId, name?, kind, route }, ...]
```

同 Host 插件也可以把已知的会话路由注册成投递目标。注册后该 `targetId` 可直接用于 `send`，并出现在设置页的目标列表里。下面以飞书私聊为例，`botId` 必须属于飞书机器人：

```js
await ctx.dshIm.createTarget(botId, {
  targetId: 'release-alerts',
  kind: 'user',
  route: { openId: 'ou_xxx' },
  name: '发布提醒',              // 可选
});
```

`kind` 和 `route` 必须匹配机器人的渠道，参见[九渠道手动填写字段](#九渠道手动填写字段)。例如飞书群聊使用 `kind: 'group'` 和 `route: { chatId: 'oc_xxx' }`；Telegram 私聊或群聊使用 `kind: 'chat'` 和 `route: { chatId: '123456789' }`，Chat ID 必须是十进制字符串。

`targetId` 已存在时以 `target-conflict` 拒绝；修改或删除已有目标仍走管理 RPC 的 `target.update` / `target.delete`。

同 Host 插件可以通过同一个服务发现已配置机器人：

```js
const bots = await ctx.dshIm.listBots();
// [{ botId, channel }, ...]
```
返回值只包含稳定的公开元数据，不包含凭据、平台路由或目标内容。

同 Host 插件还可通过 `listConversationBindings(botId)` 查询当前 Session 与平台目标的对应关系；它不创建目标，也不开启同步：

```js
const { channel, bindings } = await ctx.dshIm.listConversationBindings(botId);
// bindings: [{ sessionId, kind, route }, ...]
```

查询只返回已记录且可解析的地址和 Session ID，不返回凭据、消息正文或内部会话键；同一 Session 的多个地址原样保留，由调用方处理歧义。读取失败会拒绝，不伪装成空列表；旧适配器不支持时返回 `capability-unavailable`。此接口仅用于同 Host 插件，不新增 HTTP 或浏览器 RPC。已知地址可通过现有 `send(botId, { kind, route }, text)` 临时路由发送，无需先保存目标。

调用失败时 Promise 会拒绝，`error.code` 使用本文后面的公共错误码。

## 通过 Connection RPC 发送

Connection RPC 适合已经持有当前 DSH Host `connection` 客户端的调用方，也是设置页管理目标所使用的接口。普通外部应用优先使用上面的 HTTP POST。

先封装 RPC 成功与错误包络：

```js
const DELIVERY_CHANNEL = '/dsh-im-delivery';

async function callDelivery(connection, endpoint, payload, signal) {
  const result = await connection.rpc.call(
    DELIVERY_CHANNEL,
    endpoint,
    payload,
    signal,
  );

  if (result?.ok !== true) {
    const error = new Error(result?.error?.message || 'delivery-failed');
    error.code = result?.error?.code || 'delivery-failed';
    throw error;
  }
  return result.value;
}
```

然后使用已复制的 `botId + targetId` 发送文字：

```js
const result = await callDelivery(connection, 'message.send', {
  botId: 'bot_9577c8572d454122a4ef7fb4d8420a91',
  targetId: 'release-alerts',
  text: '构建已经完成。',
});

// result: { sent: true }
```

`message.send` 接受 `{ botId, targetId, text, format? }`；`format` 只允许 `plain` 或 `markdown`。不要附加平台路由、`sessionId`、`chatRef`、临时 Webhook 或 `idempotencyKey`。

### 示例：投递每日报告

```js
async function sendDailyReport(connection, summary) {
  try {
    await callDelivery(connection, 'message.send', {
      botId: 'bot_9577c8572d454122a4ef7fb4d8420a91',
      targetId: 'daily-report',
      text: `今日运行摘要\n\n${summary}`,
    });
  } catch (error) {
    if (error.code === 'bot-not-connected') {
      // 等待机器人恢复连接后，由业务决定是否重试。
      return { delivered: false, reason: 'offline' };
    }
    throw error;
  }
  return { delivered: true };
}
```

## 管理 RPC 参考

设置页使用同一个 Connection RPC 通道管理目标。普通调用方通常只需要 `message.send`；需要自行管理目标时再使用其他端点。

所有响应均为 `{ ok: true, value }` 或 `{ ok: false, error: { code, message, details } }`。

| 端点 | Payload | 成功时的 `value` |
| --- | --- | --- |
| `message.send` | `{ botId, targetId, text }` | `{ sent: true }` |
| `target.list` | `{ botId }` | `{ botId, channel, targets }` |
| `target.suggestion.list` | `{ botId }` | `{ botId, channel, suggestions }` |
| `target.create` | `{ botId, target: { targetId, name?, kind, route } }` | 已创建的完整目标 |
| `target.update` | `{ botId, targetId, target: { name?, kind, route } }` | 更新后的完整目标 |
| `target.delete` | `{ botId, targetId }` | `{ deleted: true }` |
| `target.session-sync.set` | `{ botId, targetId, enabled }` | `{ enabled, state }`；管理保存目标的同步候选资格，交互仍限私聊 |
| `target.test` | `{ botId, targetId }` | `{ sent: true }` |
| `target.test` | `{ botId, target: { kind, route } }` | `{ sent: true }`；测试草稿，不保存 |

接口严格校验字段。`target.update` 的内部 `target` 不能包含 `targetId`；草稿测试不能包含 `targetId` 或 `name`。`target.list` 返回的每个目标带只读 `sessionSync: { enabled, state }`，其中 `state` 为 `off`、`active`、`waiting` 或 `unavailable`；内部会话键不会返回客户端。

## 错误处理

HTTP 失败响应格式为 `{ "error": { "code", "message", "details" } }`。同 Host 和 RPC 使用相同错误码，但没有 HTTP 状态码。

| 错误码 | HTTP 状态 | 含义与处理建议 |
| --- | --- | --- |
| `bad-request` | 400 | 请求结构、ID 格式、JSON 或文字无效；检查字段名并移除额外字段 |
| `unknown-bot` | 404 | `botId` 不属于当前 Host；重新从机器人设置页复制 |
| `unknown-target` | 404 | 该机器人下不存在 `targetId`；检查是否复制错误或目标已被删除 |
| `target-conflict` | 409 | 同一机器人下已经存在相同 `targetId`；更换别名 |
| `invalid-target` | 422 | 目标类型或平台原生 ID 不符合当前渠道规则；重新选择类型并核对 ID |
| `bot-not-connected` | 503 | 机器人当前离线；恢复连接后由调用方决定是否重试 |
| `target-rejected` | 422 | 平台明确拒绝目标或机器人缺少发送权限；检查平台权限和目标 ID |
| `delivery-failed` | 502 | 网络、平台或其他无法安全细分的发送失败；检查连接状态和 Host 日志 |
| `session-sync-unavailable` | — | 目标不是可确认的当前 Host 会话，尚无当前 Session，或渠道使用远程 Harness；先从已聊会话创建目标并建立 Session；审批／提问仍须私聊 |
| `cancelled` | 408 | 调用被取消；按业务需要结束或重新发起 |

HTTP 协议层还可能返回 `method-not-allowed`（405）、`unsupported-media-type`（415）或 `payload-too-large`（413）。

## 投递语义与限制

- 当前主动投递只发送非空文字，不支持在该接口中发送图片、文件、卡片或富文本。
- HTTP JSON 请求体上限为 1 MiB。
- `{ sent: true }` 表示平台发送接口接受请求或 SDK 成功返回，不承诺最终送达或已读。
- DSH-IM 不保存主动投递历史，不生成 `deliveryHandle` 或 `idempotencyKey`，也不自动重试。
- 调用方超时后重试可能产生重复消息；需要业务幂等时，由调用方保存自己的业务事件 ID 和处理结果。
- 正式发送只使用已保存的 `botId + targetId`。平台原生路由保存在目标配置中，不应随每次消息发送。
- 一个调用只发送到一个目标。需要通知多个目标时，应分别调用并分别处理结果。
- 机器人离线时仍可编辑目标，但不能测试或主动发送。
- 微信主动投递、连接测试和延迟任务结果会使用该机器人最近收到的对应用户 `context_token`。上下文仅保存在 Host 的账号状态中，重启后恢复，不放进投递目标或返回给调用方；重新绑定并更换登录凭据后清理。升级后需要收到一次用户消息才能建立缓存。
- 微信是否接受发送仍受 iLink 服务端规则约束。长轮询在线不保证主动发送可用；若持续出现 `ret=-2 prepare failed`，不要通过反复发送心跳尝试续期。可让目标用户发一条消息后重试；这不是登录凭据失效的确定证据，也不能仅凭此错误确定上下文过期或额度耗尽。
- 微信主动长文本沿用 1,800 字符分段预算，同步助手的 Markdown 代码块在各段补齐围栏。每一段都占用平台发送次数；分段不会解除平台额度限制。中途拒发或结果不确定时停止并报告失败，不重发已经接受的段；诊断会标明失败段序号和总段数。

- 微信主动发送失败会保留在账号的最近消息错误中，包含平台错误码和是否携带上下文等脱敏诊断；健康轮询不会清除此错误，后续成功投递会清除。HTTP/RPC 仍返回既有的 `delivery-failed`，不会自动重试或断开正常的长轮询连接。

## HTTP 与 RPC 可达范围

HTTP 接口只在当前 Host 提供 WebServer 时注册，并使用同一个监听地址和端口。默认 Web profile 地址通常是 `127.0.0.1:3080`，只能由本机访问。若要从其他机器调用，需要在对应 profile 的 `cordis.patch.yml` 中把 WebServer 绑定到可达地址并重启 Host，例如：

```yaml
- id: webserver
  config:
    host: '0.0.0.0'
```

这会同时扩大该 WebServer 上其他页面和路由的网络可达范围。当前主动投递 HTTP 接口没有鉴权，因此只能配合可信局域网、防火墙或反向代理使用，不能直接暴露到公网。

管理 Connection RPC 默认沿用 Harness 已认证的 `trusted-host` authority；配置 `rpcAuthority: loopback` 时进一步限于回环 Host／Origin。受信任 profile 可在 `cordis.patch.yml` 显式声明：

```yaml
- id: xmanrui-dsh-im
  config:
    rpcAuthority: trusted-host
```

`trusted-host` 只是 Host／Origin 可达性边界，不是用户认证。启用后，能访问该受信网络 authority 的调用方也能访问机器人管理接口；只应在可信网络中使用。

## 常见问题

### 下拉框找不到目标会话

先在对应平台向该机器人发送一条消息，再返回设置页刷新。候选不是平台的完整会话目录；仍然找不到时使用「手动填写（高级）」。

### 测试按钮不可点击

确认机器人在线，并填写当前目标类型要求的全部平台原生 ID。Slack Thread 和 Telegram Topic 都需要两个字段。

### 保存后能否修改 Target ID

不能。你可以编辑名称、类型和平台路由而保持调用参数不变；若必须更换 `targetId`，请新建目标并让调用方切换后再删除旧目标。

### 为什么不用 sessionId

`sessionId` 标识 Harness 会话，不是九个平台统一、稳定的消息投递地址。主动投递只使用机器人和已保存目标的稳定组合。

### 测试成功但对方没有看到消息

测试成功只证明平台接口接受发送。请继续检查机器人权限、平台限制、目标是否正确，以及客户端侧的消息过滤或归档设置。

## Companion Plugin 的条件主动发送

same-Host `dshIm` Service 新增 `contractVersion:1`、`describeBot(botId)` 和 `sendChecked(botId,targetId,text,options)`。首版认证账号实现只支持飞书/Lark；其他渠道在实现此契约前明确返回 `capability-unavailable`。现有 `send`、HTTP 与管理 RPC 不变。

`describeBot` 返回 `{version:1,botId,channel,account:{fingerprint,name?},connected,capabilities}`；`proactive-text-checked` capability 不是用户授权。飞书/Lark 通过 credentials service 解析凭据，并向平台验证当前 Bot Open ID。fingerprint 为按固定字段顺序 `JSON.stringify({provider:'feishu',domain,appId,botOpenId})` 的 UTF-8 小写 SHA-256，不返回凭据或 token；平台身份与已配置的 verified bot 不同则拒绝。Host 启动时账号异步初始化，需要后续刷新 discovery。

options 必须包含 `expectedFingerprint`、`expectedTargetDigest`，可选 `signal`、`format`。目标 digest 为 `JSON.stringify({kind,route})` 的 UTF-8 小写 SHA-256，route keys 按 JavaScript 字符串 code-unit 升序排列；名称和 alias 不参与。发送检查当前 saved target，冻结规范化 route，再在账号 transition 内重新验证认证身份后使用此 route；验证期间编辑 alias 不会改投。lookup 前删除或改址会拒绝；请求已经开始后，修改不能撤销外部效果。

`account-unverified`、`account-changed`、`target-changed`、`capability-unavailable` 是发送前拒绝；凭据读取与平台认证失败也返回 `account-unverified`。`{sent:true}` 仍只代表平台接受，不代表送达/已读。SDK 开始后的取消、超时和含糊失败不能证明没有发送；调用者持有 durable authorization／intent／attempt 与 reconciliation，不得盲重试。Provider Registration 撤销或控制器关闭会拒绝尚未开始 SDK 请求的条件投递，包括在最后一次账号核验期间发生的撤销；不能撤回已开始的 SDK 请求。

## 飞书/Lark 独占文本收件（同 Host）

拥有独立持久消息存储的应用，可通过 `ctx.dshIm`（`inboundVersion: 1`）独占接收文本消息，并使用 `replyChecked` 沿校验过的原消息/话题回复。此能力仅适用于明确选择外部消费模式的飞书/Lark 账号；其他平台及未启用此模式的账号沿用现有行为。

调用 `describeBot(botId)` 校验身份和 `exclusive-text-consumer`、`reply-text-checked` 能力，然后调用 `consumeInbound(botId, {expectedFingerprint, signal, onEvent})`。`onEvent(event, {signal})` 应先进行群授权、去重和应用持久提交，再返回 `{accepted: true}`。返回的释放函数应随应用 Registration/Fiber 释放。回调仅用于同 Host Service，不暴露至浏览器 RPC 或 HTTP。完整示例见[英文契约](PROACTIVE_DELIVERY.en.md#exclusive-feishulark-text-intake-same-host)。

事件 v1 携带平台、账号和可信 fingerprint、eventId/messageId、发送人原始 ID、群/私聊 ID、mentions、mentionedAccount、ISO 时间、原始文本和原消息回复路由（messageId/conversationId/actorId/threadId/rootId/parentId）。平台提供的可选姓名仅用于展示；此切片不提供头像或附件，有界历史读取见下文。应用自行决定收件范围和唤醒策略。

每个账号只能有一个 Consumer；冲突返回 `consumer-conflict`。`consumerMode: external-consumer` 持久保存后，不创建独立 Session，不执行原生卡片或 slash command。释放 Consumer、Registration 替换、Host 重启均不自动回退独立处理；需重新注册 Consumer，或者明确修改账号模式并重连。应用持久提交需响应取消；已完成的提交不能被释放操作撤销。

`replyChecked` 在发送前读取原消息，核对发送人、群以及 thread/root/parent 路由；同话题回复不回退群主线。来源消失或变化返回 `stale-route`。发送请求已尝试后的 SDK 失败返回 `reply-result-unknown`，应先核对外部会话再决定是否重试。平台重投递可能有缺口、无恢复游标；本契约不保证传输恰好一次，不提供消息已读回执或跨账号回复。去重和持久发送意图归应用管理。

## 有界飞书／Lark 上下文读取（同一 Host）

活跃的独占接收方可调用可选的 `dshIm.historyChecked(botId, source.reply, query, {expectedFingerprint, signal})`。先检查 `history-text-checked`；读取话题另需 `thread-history-text-checked`。query 为 `{scope: 'group' | 'nearby' | 'thread', limit: 1..20, cursor?: string}`。不提供浏览器／HTTP 历史端点；必须使用已验证的 Bot 身份及当前接收权，standalone 账号无法通过此契约读取。

每次读取先重新获取来源，核对发送人、群、thread、root、parent ID。`group` 列出来源群；`nearby` 用消息前后各五分钟的群时间窗口，不声称是原生“附近消息”接口；`thread` 按原生话题读取。返回 `{version:1, scope, events, omitted, hasMore, nextCursor?, window?, coverage:'provider-visible-human-text'}`。每次最多检查 limit 条平台记录；不支持的消息、撤回、应用发言及无效文本计入 omitted。一次只读一页，后续页显式调用；调用方将 continuation 绑定原来源和查询。历史事件 ID 为 `history:<messageId>`，应用应以平台 messageId 和实时事件一起去重。

只返回该 Bot 可见的 Human 文本，沿用标准事件格式。平台返回的可选 `sender_name` 和 mention `name` 仅用于展示，不能用于身份或授权；缺失时不猜测，不查通讯录、不使用 Human token。读取不自动投递普通消息到 Inbox、不唤醒、不回复、不标记已读、不同步撤回；这些决定及 canonical 持久化由消费应用负责。

Bot 权限不足返回 `history-permission-denied`；来源消失或改变返回 `stale-route`；来源没有话题返回 `thread-unavailable`；平台故障及无效分页返回 `history-unavailable`；混入其他群／话题返回 `untrusted-source`。调用取消、接收权释放、Host 关闭、Provider 替换都会丢弃未返回结果。消费方需保留接收生命周期直到读取结束。本能力不保证完整历史，也不提供全平台搜索。
