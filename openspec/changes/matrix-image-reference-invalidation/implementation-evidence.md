# Implementation evidence

## 安全基线

- 2026-11-02 在 composite 工作树开始实施，HEAD 为 `7a73dd6aaad1155afb1d7e06942c09af4504592d`，不是简化完成后的独立提交。
- 完整实际基线保存于 `%TEMP%\dsh-image-invalidation-baseline-20261102-121828`：1,051 个 tracked/非忽略 untracked 文件的独立副本、逐文件 SHA-256 manifest、完整 tracked binary patch、status 与 HEAD。含 29 个既有 tracked 修改和未跟踪简化交付物，未 reset、自动提交或覆盖。
- 第一遍基线复制因 Git 默认对中文路径进行 C 引用而失败；没有修改源文件。改用单次 `git -c core.quotepath=false ls-files` 后完整复制成功，失败的临时副本不作为恢复基线。
- 已读取简化实施证据：代码、构建、测试完成，运行验收 6.3/6.4 未完成；本变更不代做运行加载、认证设置写入或真实群发送。

## 实施与验证

### 协议与边界

- 原始服务器事件的 `unsigned.redacted_because` 是读取兜底依据；旧顶层 redacts 与 room v11 content.redacts 兼容，出现冲突/畸形字段拒绝。未收到目标时只记录有界 room/event 墓碑，不按同名文件传播。
- 协议出处：[Client-Server redactions](https://spec.matrix.org/v1.16/client-server-api/#redactions)、[room v1 stripping](https://spec.matrix.org/v1.16/rooms/v1/#redactions)、[room v11](https://spec.matrix.org/v1.16/rooms/v11/#redactions)。helper 信任 homeserver 提供的外层元数据，不自行验证事件签名或 room power level。
- 对抗审查识别并修复：解密出的 redaction 仅证明内容身份、不代表服务器授权，因此必须独立查询目标证实；B 的失效写盘失败需保留目标修复队列，否则 barrier 会阻止任何后续修复；到达时图片快照不可跨队列缓存；图片形状不能替代真实事件/decrypted type 和精确 room/event/sender 校验。
- 集成回归先观察到排除旧图仍被标 consumed：桥接器使用消息副本，已修正为更新实际执行消息的有效 event ID 清单。加密 fixture 最初缺少 cryptoStore 的 bootstrap/apply 契约，补齐 fixture 后通过，未放宽生产契约。
- 代码编辑期间 Windows CRLF 导致 diff-check 把整文件视为尾随 CR，按原仓库 LF 归一化本次修改文件后检查通过，不进行无关源文件格式化。

### 已执行分组验证

- 严格 API 与撤回 helper：67/67（32 API、35 redaction），房间历史 14/14，无跳过；403/404/500/503、网络、超时、取消与空结果不伪装成撤回。
- 引用库 27 项；引用库+原图片输入/关联初始组合 74/74；后续 inbox+回滚演练+定时 store 60/60。实际安全基线回滚演练 2/2，设置 `DSH_IMAGE_REFERENCE_BASELINE` 指向保存的 files 副本，不使用生产状态。证明旧 reader 拒绝新图片 v2、精确恢复原 v1 字节，简化后的源文件与 bundle 保持 SHA-256 身份，独立定时库和高水位未改写。
- Matrix 图片关联与 lifecycle 最终针对面板：67/67，无失败/跳过。覆盖同步撤回失败不推进游标、服务器重放后修复、B 写盘失败后下次提及修复、下载期间撤回、排队精确目标刷新、重启与错误 envelope。等待的是可观察事件与生产退避，而非用测试 sleep 推断成功。
- 共享图片输入的 opt-in 最终确认：专属 10/10；图片输入面板 58/58；共享 reply/bridge/i18n 面板 120/120；最终专属+i18n 25/25。默认其他渠道不启用 callback，暂时故障仍整轮失败。
- 真正 libolm/Megolm 回归扩展为 7/7：真实双引擎、签名 to-device 密钥分享、恢复真实出站 ratchet，验证 peer type 被保留但不被提升为服务器 unsigned 撤回授权。
- 新入站/出站组合 4/4；与现有职责分离、图片关联组合 83/83。使用真实 runtime/Harness/registry/store/relay/service/adapter/官方同步协调器，平台和 Host RPC 为替身。验证查询/真实 FS 写失败不取消另一 Session 定时附件，已提交后撤回不撤销输出 owner，notice 不提前消费，关闭后两套 v2 store 独立恢复及发送高水位不重放。没有真实 homeserver 互通或第二 runtime 重连的声明。

### 全量与生成物

- 第一轮 `npm run check`：5,374 项，5,367 通过，0 失败/取消，7 项环境跳过；build、package verify 通过。日志：`%TEMP%\dsh-image-invalidation-full-check.log`。此后增加了游标与真实 typed-Megolm 测试。
- 第二轮：5,376 项，5,368 通过、1 失败、7 跳过；唯一失败是原有 Feishu SDK wait 100ms 截止测试，`requests` 为 0 而非 1。相关 Feishu 测试和实现与安全基线逐字节一致，隔离 `node --test test/channels/feishu/feishu-operation.test.mjs` 为 3/3 通过。未修改该测试、放大超时或新增 skip。失败日志：`%TEMP%\dsh-image-invalidation-final-check.log`。
- 最终完整复跑同一 `npm run check`：**5,376 项，5,369 通过、0 失败、0 取消、7 环境跳过，65.138 秒**；Client/Host build 及 package verify 均通过。日志：`%TEMP%\dsh-image-invalidation-final-repeat.log`。7 项跳过为五项需要 POSIX ffmpeg stub、一项未安装真实 ffmpeg、一项平台权限测试；本次新增图片、回滚基线和组合测试没有跳过。
- 测试进程仅设置规范 Windows TEMP/TMP、保存的 `DSH_IMAGE_REFERENCE_BASELINE` 和本机 `DSH_SCHEDULE_RELAY_DSH_CHECKOUT`，避免既有短路径与可选真实 Host fixture 缺失导致假失败；不改系统或运行服务环境。
- 生成 Host 的无服务启动 ESM 导入烟测通过：导出 apply、createImHostPlugin、inject、name。仅重建 bundle，不等于正在运行实例已加载。
- 决策转为 implemented 后重新执行 notes tree/format/archive：6 篇记录全部通过、0 archives；OpenSpec 严格校验、包校验、Host ESM 导入与 `git diff --check` 全部通过。

### 简化成果保全审计

- 对实施前 1,051 文件 SHA-256 manifest 完成逐文件比较，基线文件无缺失。变化仅为本图片修复源/测试/文档、构建 Host、规划状态和决策互链；没有清空、回退或重写继承差异。
- 9 个关键继承文件逐字节相同：delivery adapter/service、Host index、schedule relay coordinator/store/installer、official sync coordinator、MatrixController、简化 tasks。原最终文字 sender/排除桥未恢复，简化 6.3/6.4 未代勾。
- [图片引用决策记录](../../../.agents/notes/implemented/bug-fix/2026-11-02-matrix-image-reference-invalidation.md)在验证后转为 implemented；已有三篇相关记录仅增加互链，没有改写旧决定或将其他 proposed 方案实施。

## 运行与交付边界

本次没有读取真实凭据、修改生产图片/定时状态、调用运行设置 SET、重新加载/停止服务或向真实 Matrix 发消息。现有运行实例尚未证明加载本次代码，回答同步未由本次启用；真实互通与部署需另行授权。变更不自动提交、推送、归档或同步主规范。
