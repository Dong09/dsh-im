# Agent Note: 共享 Harness 适配器与调用身份跟随全部使用者存活

Status: implemented

## Problem

Matrix 房间在切换机器人工作区后可能只留下“正在处理”，而 Harness 会话已经完成。此次现场会话在 2026-10-29 11:00:43 正常生成最终回答，但没有终端诊断可以确认事件监听、请求取消或平台发送中哪一段先失效。群历史授权失败在更早的成功回复中已经出现，不作为这次丢回复的根因。

调查发现一条独立且可复现的缺陷链：`modernHarnessApi` 与 `harnessPeer` 按 Host root 共享，但清理由第一个调用者的上下文持有。该上下文卸载时，仍在运行的另一个渠道失去事件监听和可用 peer；旧适配器仍返回健康。`session.page` 严格读取 `throughSeq` 指定的历史切面，因此停止推进的本地游标让新工作区会话的最终回答一直不可见。普通整插件关闭会同时停止 Matrix，不等于触发了这条“部分上下文卸载”路径；现场缺少相应卸载证据，不能把可复现缺陷直接认定为当次事故的唯一原因。

## Decision

[共享资源持有器](../../../../plugin-src/host/shared-host-resource.mjs)按 Host root 缓存资源，并为每个实际消费上下文登记一个可释放持有关系。同一上下文重复获取不增加持有数；最后一个使用者释放后才从缓存移除并销毁资源。peer 的异步销毁结果交回 Cordis 等待。

[适配器](../../../../plugin-src/host/modern-harness-api.mjs)的事件监听挂在 Host root，而不是第一个渠道的可卸载上下文；gateway 与 Connection 也通过 root 读取。Connection 的 `createPeer` 会把 peer 自动绑定到读取服务的上下文，因此只延长本地缓存、却仍从第一个渠道读取 Connection，真实 peer 仍会被提前销毁。每次获取适配器，包括命中缓存时，都通过 [harnessPeer](../../../../plugin-src/host/harness-peer.mjs)登记当前上下文对调用身份的持有；root 创建的 peer 仍由最后一个实际使用者主动释放，不永久保留。

最后一个使用者卸载后，旧适配器的 RPC、事件订阅和交互响应入口以 `harness-adapter-disposed` 拒绝新请求；健康检查不再谎报 ready。重新加载获得新资源，不复用已释放实例。现有工作区、房间映射、历史记录、凭据及投递检查点格式不改变，也不自动重连或重放已接受的模型请求。

### 默认关闭的现场诊断

[Peer 生命周期诊断](../../../../plugin-src/host/peer-lifecycle-trace.mjs)仅在启动前设置绝对路径环境变量 `DSH_IM_PEER_TRACE_FILE` 时启用。共享持有器提供不影响结果的 observer，记录 create／retain／reuse／release／dispose；peer 的一次性 abort listener 记录当场捕获的调用栈，兼容 API 在继续调用已 abort 的 peer 时记录 namespace／method。每条记录含 PID、peer ID、root/context 诊断 ID 和最后观察的持有数，用于区分最后使用者释放与持有者仍在时的外部取消，不通过自动换 peer 掩盖原因。

日志是进程本地的追加 NDJSON，每次追加前按 2 MiB 检查尺寸，达到上限后停止追加；不提供跨进程文件锁，多个进程共用目标时不是原子硬上限，因此启动脚本为每次运行选择 UUID 新文件，禁止人为让多个服务共用目标，不覆盖旧证据。拒绝 Windows UNC、设备路径、非完整盘符路径、备用数据流及已存在的非普通文件。写入失败被隔离，不能改变持有数量、销毁返回的 Promise、Gateway 错误或请求提交语义。默认不创建文件、不添加 abort listener。诊断不读取请求参数、聊天正文、凭据、rpcId 或任意 abort reason/message/stack；只捕获诊断代码自己创建的空消息 Error 栈。文件权限参数为 0600，但 Windows 仍由父目录 ACL 决定可读范围；路径应放在用户私有目录，取证后清除环境变量。

## Verification

[真实 Cordis 回归](../../../../test/host-shared-harness-lifecycle.test.mjs)只替换外部 gateway 和 Connection peer，保留真实插件上下文卸载、共享适配器、事件分发与资源释放。page 替身按实际 Host 的 `throughSeq` 截取，不能无条件返回全部事件。

| 行为与来源 | 正常或边界断言 | 异常或交错断言 |
| --- | --- | --- |
| 适配器跨上下文共享；原 `modernHarnessApi` root 缓存 | 两个使用者取得同一实例；同一上下文重复获取不泄漏 | 首个上下文卸载后，另一渠道继续读到用户、最终回答与 completed 事件 |
| mux 监听存活；原 `ModernHarnessApi` 订阅 | 订阅收到精确事件值 | 首个上下文卸载不能令另一使用者的等待返回 done |
| peer 共享；原 `harnessPeer` root 缓存 | 直接命令与适配器复用同一未取消身份 | 任一使用者卸载后其他调用仍持有效 peer；最后释放仅销毁一次 |
| 适配器终止与重建；原 `dispose` | 最后释放后重建不同实例并读到完整历史 | 旧实例拒绝健康、历史和订阅等新工作，不能继续读取旧切面 |

新增回归在修复适配器之前观察到三项失败：历史返回空页、存活渠道 mux 提前关闭、旧健康检查不拒绝。首次 peer 持有修复已先落盘，因此不把该轮 peer 通过误记为旧实现通过。审查补入真实 Cordis Service 的读取者自动拥有 peer 行为，先确认首读取者卸载导致取消的回归失败，再修正为 root 读取。

两项反向探针分别暂时移除最后使用者检查、将 Connection 改回从首渠道读取，均触发对应的提前销毁断言；探针随后原字节还原，未保留变异源码。五个相关测试文件合计 124/124 通过。另通过本机 Harness checkout 的真实 `HostConnectionService` 与 `Peer` 执行无网络烟测，确认共享、首使用者退出、最后释放与重新创建的行为。

最终执行 `node --test test/channels/matrix/*.test.mjs test/channels/shared/text-harness-bridge.test.mjs test/host-shared-harness-lifecycle.test.mjs test/host-harness-peer.test.mjs test/host-modern-harness-api.test.mjs test/conversation-bindings.test.mjs test/host-harness-connection.test.mjs test/host.test.mjs`，452/452 通过，无跳过。`node plugin-src/host/build.mjs` 与 `node scripts/verify-package.mjs` 通过；仅重新构建 Host，不改 Client 产物。只读复审未发现阻断项，额外验证旧资源异步释放未结束时重建不会误删新实例。这些证据仍不代表真实 Matrix homeserver 已验收。

现场诊断增加 7 项回归，覆盖默认关闭、持有数与原 Promise 身份、外部 abort 与无敏感信息输出、Windows 非本地/设备路径拒绝、不可写目标、文件上限、observer/堆栈格式化异常隔离。完整测试 5,383 项，5,375 通过、0 失败/取消、8 跳过；其中一项缺少保存基线变量的可选图片回滚随后设置实际安全快照单独执行，2/2 通过，其余七项为既有平台/ffmpeg 环境跳过。Host 重建及包校验通过。另以新的临时 home 分别从源码、构建包启动真实 headless Host，启用诊断后各 3 次直接 hi 和 1 次 Matrix 网络替身入站均成功，两组日志均实际捕获 create/retain/reuse 和正常关闭时的 abort/release/dispose，不把正常 Host 关闭的提前 abort 当作事故原因。该阶段未启动生产实例诊断取证；后续现场结果见下节，不能将隔离通过当作事故已修复。

## 2026-11-03 跨插件配置钩子现场

生产 PID 22736 的 IM peer 在 08:49:44.112 创建、08:49:44.150 abort；期间没有 release/dispose，持有数为 1。Matrix 新参考号 `MF-49426EE9` 仍为 session.prepare/workspace.list 的 gateway/peer-disposed。用户同时报告微信渠道异常；当前读回的微信账户 lastMessageError 为空，因此不伪称已经取得微信相同参考号的现场记录。

通过现有进程的临时 loopback Node inspector 只读查看该确切 peer，发现 scope fiber UID 367 为 FAILED(3)，父 root UID 0 仍 ACTIVE(2)，inject 为空；其真实初始化异常是 `Cannot read properties of undefined (reading 'entry')`，首帧为已安装 `dsh-codex-subscription 3.2.3` 的 `lib/index.js:3773`，来自其全局 internal/config listener。调试接口随后关闭，原进程继续监听原 3080，没有重启、修改业务对象或重发消息。

该插件 listener 在当前 Cordis 钩子中优先用 this.entry 判断 Fiber，entry-less 内部 scope 则把配置参数（可能为 undefined）当作 Fiber 传给 configure；configure 无条件读 fiber.entry，导致 scope 初始化失败，Cordis 按失败清理 Peer 的 abort effect。共享持有器没有错误释放，仍持有的兼容 API 随后复用该失效身份。这是与本篇先前首消费者卸载缺陷不同的跨插件兼容问题，不能再归因于 Matrix 图片/附件实现。

本地隔离因果复现脚本（含运行实例诊断资料，未随仓库发布）读取实际安装产物，只提取相关 listener/switcher 函数，在临时内存中结合真实 Cordis、HostConnectionService、Peer 和 harnessPeer 运行：原函数必现同一 TypeError、scope FAILED 和 peer abort；仅将 `standard(fiber.entry, config)` 改为 `standard(fiber?.entry, config)` 后 scope ACTIVE、peer 保持存活。额外验证 undefined/null/空/非 spawn 配置、标准 spawn→Codex 切换、custom persona 不变以及当前 listener 路径。原安装产物 SHA-256 为 becea0cb25789d0e3cbc5b47f65e168e16ef39bf9c76c5ba14b93d89902fdaf3。用户确认后于 2026-11-03 09:13:12 对 web profile 的 Codex 安装文件应用该一处保护，先校验原哈希并复制原文件到用户 `.dsh/logs/codex-peer-hotfix-LyoijZ/index.before.js`，通过同目录临时文件 rename 原子替换，链接数由 2 变为 1，避免修改 pnpm 共享硬链接 inode。补丁后 SHA-256 为 2366760ad6518695275d2e57676d21296dbc6c40acd9d603ebc24c0b45da85a5，备份与 manifest 均保留；语法检查及从实际已修复文件提取的因果/兼容检查通过。未改模型或账号设置，原 PID 未重启，修复后现场验收仍未完成；后续安装或更新可能覆盖这份本机热修复。

后续新进程已确认 Peer 不再 abort，但 Matrix 新错误为 SESSION_WRITER_HELD，用户要求回退相邻发布版；当前安装与锁文件固定到未修改的 3.2.2，见 [Codex 发布版本回退](../process/2026-11-03-codex-subscription-rollback.md)。本节保留 3.2.3 根因和本机保护的验证证据，不将部署替换误写成原因判断失效。

## 与既有记录的关系

检索活跃笔记及 ADR 后，[Matrix 非加密主线](2026-10-27-matrix-non-e2ee-mainline.md)与本次部分重叠：其停止排空、未知结果不得盲目重发等要求继续成立；本文修复 Host 共享资源所有者，不改变原生 Matrix stop。[生命周期简化提案](../../proposed/simplification/2026-10-28-matrix-lifecycle-ablation.md)只涉及 Matrix runtime 和 controller 内部机制，与本次 Host 资源持有不同，不实施或改写该提案。[统一语义核心与渠道原生适配](../../../../docs/adr/0001-semantic-core-native-channel-adapters.md)保留；没有既有决定被吸收或归档。

[定时附件所有权与逐部分防重](2026-10-29-matrix-scheduled-artifact-delivery.md)继续使用本文的资源持有纪律；其回合 lease 与本篇 Host 共享资源所有者不同，不替换本篇决定。

## Alternatives considered

1. **每次 latest history 都重新取得 snapshot。** 不依赖进程内事件推进游标，能消除读取旧切面的风险；但不能恢复被提前关闭的交互订阅，也不能使已释放的 peer 重新有效，并增加现有轮询路径的 snapshot 与投影工作。本次修复共享所有权，保留现有历史分页读取方式，不把刷新历史当作生命周期修复。
2. **每个渠道各建一份适配器。** 生命周期可以局部管理，但会重复注册全局问答和审批监听，改变共享交互的所有权语义。本次保留 Host 级共享，只修正其持有关系。
3. **由 Host root 永久持有全部资源。** 实现简单且不会被某个渠道提前清理，但插件卸载后会残留监听、待回答交互及 peer。采用显式消费持有，最后释放时完整清理。
4. **仅把 Peer 诊断写到控制台。** 不增加文件格式，但当前运行日志没有持续落盘接口，重启后无法通过 MF 参考号复查；采用显式启用的有界本地文件。不开默认日志，不复制任意 abort reason 的文本或栈，也不自动更换 Peer 来隐藏提前释放。

## Consequences

收益是部分渠道卸载不再破坏仍在运行的渠道，且失效资源立即报错而非等待回复超时。代价是增加跨上下文持有管理与对应交错测试；监听虽然注册到 root，但仍必须由最后使用者显式移除。外部 gateway/Connection 服务整体更换仍需其依赖上下文正常卸载，不能用本地持有延长已经失效的外部服务。

本次不重置机器人、不改生产配置、不补发旧消息。需要加载重新构建的 Host 后，在原 Matrix 房间发新的短消息验收；浏览器刷新本身不能替换运行中 Node 进程已经导入的 Host 代码。现场事故原因与真实房间送达在该验收前保持未确认。
