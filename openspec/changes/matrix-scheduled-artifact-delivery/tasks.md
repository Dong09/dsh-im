# Tasks

实施进度以各项复选框为准；未勾选项尚未完成验证或仍需用户许可。行为依据为 [spec](specs/matrix-scheduled-delivery/spec.md)，实施选择见 [design](design.md)。提案管理、代码开发与任务实施交由 [composite 项目](../../../)的专用会话；OpenSpec 管理命令、构建与测试均从该项目根目录执行。父级 `.pr-scratch` 会话用于跨项目讨论、工作树比较与统筹安排，原则上不直接实施子项目，也不保留同名提案副本。不自动补发旧任务、不更改生产配置或重启服务。

## 1. 回合附件所有权

- [x] 1.1 在 [artifact registry](../../../src/channels/shared/semantic/artifact.mjs)增加非 RPC 的显式 turn owner lease，保持文件工具参数不变；在 [consumer tests](../../../test/outbound-artifact-consumer.test.mjs)验证真实 schedule 无 rpcId 也能授权、跨 Session/turn 不能取用、重复 close 幂等且不伪造来源。
- [x] 1.2 为 stage、权威结果 commit、take、discard/close 加入所有者隔离，并同步 [普通 HarnessClient](../../../src/channels/shared/harness-client.mjs)的受检领取；在 consumer/recovery 测试验证 schedule 不抢普通 owner、旧 lease 晚到 commit/take/close 不污染或删除新 owner 的文件。
- [x] 1.3 保留受控快照与两阶段工具提交；在 [artifact tests](../../../test/outbound-artifact.test.mjs)、[recovery tests](../../../test/outbound-artifact-recovery.test.mjs)覆盖原文件不改名、文件失效/变化、工具与 Code Mode 外层失败、copy 期间撤权，断言没有可发送残留；同步 lease 和普通 RPC 兼容语义的 JSDoc。

## 2. 定时来源、首请求与路由授权

- [x] 2.1 在 [relay installer](../../../plugin-src/host/schedule-relay.mjs)与 [coordinator](../../../plugin-src/host/schedule-relay-coordinator.mjs)拆分同步 `(sessionId,turn)` claim 账本和异步发送队列；在 [Host tests](../../../test/schedule-relay-host.test.mjs)验证 turn/start 尚未经过异步 tail 时 claim 仍正确记录，下一 turn 不覆盖上一任务。
- [x] 2.2 使用 awaited pre-step 刷新唯一绑定并开 lease，重查取消、closed、输入代次及普通 owner，waterfall 保持 next() 语义；加入真实 Host 顺序回归，通过受支持的 dsh profile、脚本化模型及临时 home/workspace 验证 claim → assemble → pre-step → refreshContext → 首请求的指引与第一次 return-file 成功；不需要真实模型密钥或 Matrix 发送，不向插件包新增 DSH 运行时依赖，也不使用 sleep 或预先手动开消费者来替代。
- [x] 2.3 实现已知自动来源/form 分类与真实输入的粘性 mixed 拒绝；在 [relay tests](../../../test/schedule-relay.test.mjs)及 Host tests 覆盖实际 schedule+runtime+time 序列、技能目录、IM notice、伪装正文、未知源、schedule/user 两种先后顺序及下一 step 真人混入。
- [x] 2.4 复用唯一路由发现与已记录旧 Session 回复位置；验证未 claim 的未来普通 RPC 不误伤本轮、无绑定/多目标/私聊/其他渠道/远程 Harness 不开权限，经典/v12 房间及线程隔离正确；同步授权与来源分类的局部注释，不能扩大群历史或交互答题权限。

## 3. 内部文字与附件发送桥

- [x] 3.1 在 [delivery service](../../../plugin-src/host/delivery-service.mjs)与 [adapter](../../../plugin-src/host/delivery-adapter.mjs)增加 relay 专用的可选单部分入口，只接受内部文字或真实 managed artifact；在 [service tests](../../../test/delivery-service.test.mjs)与 [adapter tests](../../../test/delivery-adapter.test.mjs)验证仅 Matrix room/thread 可用、拒绝伪造 artifact/path/URL/bytes、缺少能力明确失败且不影响其他渠道必需接口。
- [x] 3.2 经 [MatrixController](../../../src/channels/matrix/matrix-controller.mjs)包装现 [MatrixRuntime](../../../src/channels/matrix/matrix-runtime.mjs)媒体函数，贯穿 relay deadline 与 runtime signal，正确映射 fileName/name、线程关系及原生 event_id；新增 proactive 路径测试，断言文件名、字节、目标及回执精确值，而非仅无异常。
- [x] 3.3 对单个 artifact 复用 [shared artifact delivery](../../../src/channels/shared/semantic/artifact-delivery.mjs)，不另加原生重试且不抹平 uncertain；在 [artifact-delivery tests](../../../test/artifact-delivery.test.mjs)与 [Matrix runtime tests](../../../test/channels/matrix/matrix-runtime.test.mjs)验证明确拒绝最多转一次文件，超时/网络/5xx/无效事件 ID 不回退，加密不可用零上传和零明文。
- [x] 3.4 内部文字入口保留可用 provider message ids 与准确 outcome，附件失败通知和失败附件结果分开；通过 service/adapter 回归验证布尔 sent、可见 notice 或单个消息 ID 不被当成全部成功证据，并补齐内部接口 JSDoc。
- [x] 3.5 保持公开 facade、文字 HTTP/RPC 白名单及格式不变；在 [HTTP tests](../../../test/delivery-http.test.mjs)、[RPC tests](../../../test/delivery-rpc.test.mjs)验证新入口未暴露、外部 path/files/bytes 仍被拒绝，且不需要新增第三方依赖。

## 4. 逐部分状态与旧版本兼容

- [x] 4.1 为 [RelayStore](../../../plugin-src/host/schedule-relay-store.mjs)定义 version 2 读写、不可变 attempt identity/manifest、每部分状态/回执与聚合结果；在 [store tests](../../../test/schedule-relay-store.test.mjs)覆盖 text+多个 artifact、artifact 身份而非文件名去重、跨 turn 延迟结果不得覆盖新尝试。
- [x] 4.2 实现 version 1/2 双读、旧格式备份与首次原子升级，保留 destination/conflict/lastAttempt 高水位；测试四种旧状态、经典/v12/线程、损坏/重复项/未来版本/备份失败，断言不降为空库、不补发旧回合且原始数据不被破坏。
- [x] 4.3 为整轮清单、每部分 sending 和终态提供受检的串行写入；故障注入验证前置写失败时零平台调用、后置写失败时保留防重状态，未确认部分不伪装成 sent；同步状态格式与迁移不变量的 JSDoc。
- [x] 4.4 在 [主动投递说明](../../../PROACTIVE_DELIVERY.md)及 [English guide](../../../PROACTIVE_DELIVERY.en.md)随状态演进说明逐项结果、v1 升级、v2 降级拒绝及不恢复历史快照的限制；以隔离 home 的往返读取/失败示例核验文档，不操作生产状态。

## 5. 完成回合交付与防重复

- [x] 5.1 正常完成时冻结独立 job，先 owner-checked take 再 close，保留 artifact 原对象身份；在 relay/Host tests 验证纯附件、文字+多文件、没有产物、工具失败、不同 Session 同 turn 和下一回合并行生成，未 take 文件不被结束观察抢先丢弃。
- [x] 5.2 实现先持久化整轮意图，再逐部分写 sending、调用内部入口、在发送器外写终态的流程；在 relay/store 组合测试验证文字失败仍按设计尝试可用附件、取消或 checkpoint 故障停止后续 side effects，失败部分不覆盖其他部分的真实结果。
- [x] 5.3 加入 P0 故障注入：图片原生发送成功后，最终 checkpoint 写入失败；断言没有文件 fallback、没有第二次图片事件、没有后续附件发送，状态仍能阻止重放，且所有剩余快照释放。
- [x] 5.4 从文字及每个 artifact 结果显式归纳整轮状态；覆盖 text sent + A sent + B failed、unknown 优先于 failed、notice 成功但附件失败、notice 也失败，以及缺少有效回执，任何必需部分未确认都不能聚合为 sent。
- [x] 5.5 验证重复 turn/end、重启时 sending/unknown/failed/sent、写盘失败后的重复事件与旧回合历史重放均不重开一轮；允许规定的单轮图片转文件回退，但不以相同 path/hash 自动恢复登记或重新运行生图。
- [x] 5.6 在 [relay 安装与回群说明](../../../PROACTIVE_DELIVERY.md)及 [English guide](../../../PROACTIVE_DELIVERY.en.md)同步写清“登记不等于送达”、纯附件、文字失败与文件结果、失败查看方式；新中文提示走既有 t() 与全部字典，执行对应 i18n 覆盖检查。

## 6. 取消、目标变化与插件关闭

- [x] 6.1 所有拒绝分支和 model error/blocked/abort 关闭自己的 lease，接管后的旧清理不得误伤普通 IM；在 consumer/relay tests 用受控 Promise 验证路由刷新或文件复制中混入输入、取消、Session 释放和 late commit，不留下可发送文件。
- [x] 6.2 开始每部分前复核被冻结的 bot/room/thread 与当前受控账号和 adapter registration；在 [Matrix delivery tests](../../../test/channels/matrix/matrix-delivery.test.mjs)及 relay tests 验证删除/换账号/冲突时零改投、线程不丢失，已记录旧 Session 路由仍按既有规则可用。
- [x] 6.3 在 [Host close ordering](../../../plugin-src/host/index.mjs)和 [channel startup](../../../plugin-src/host/channels/shared/startup.mjs)保持先停 admission/撤 hooks、取消未开始工作、排空在途发送再撤 adapter/runtime/store；在 [lifecycle tests](../../../test/channels/matrix/matrix-lifecycle.test.mjs)与 Host tests 覆盖挂起 load/upload/send/checkpoint、关闭期间晚到路由结果、重复关闭及超时。
- [x] 6.4 验证 abort 与原生成功回执交错时保留可确认结果，否则记 unknown 且不换类型重发；同步关闭责任与不承诺远端撤回的接口说明，并确认不调用全局 registry.clear 或误取消普通 IM 交付。

## 7. 跨模块验证与交付

- [x] 7.1 用脱敏 fixture 回放本次真实顺序：原图已存在、schedule 无 rpcId、自动 runtime/time 快照、首调用登记、回合完成，断言原图片内容发送到精确原房间且模型/生图调用次数不增加；另验证线程、普通文件、直接 IM 回复不重复。回放只用平台替身，不连接真实群。
- [x] 7.2 对至少“时间快照误拦”“首步 lease 缺失”“旧 lease 清理新 owner”“图片成功后写盘失败触发回退”各做一项临时反向探针，记录变红用例并原样还原；随后运行全部受影响 relay、artifact、delivery、Host 与 Matrix 回归，报告通过/跳过/基线失败的真实数量。
- [x] 7.3 更新实施决策记录中的已选方案、拒绝项和验证证据，保持现有相关笔记及本文设计链接一致；执行 notes 校验、OpenSpec 严格校验与 git diff --check，不把计划中的真实平台验收写成已通过。
- [x] 7.4 重新构建 Host 并执行包校验与编译产物烟测，确认未扩张公开文件接口且实际安装路径能加载新产物；交付准确的重新加载步骤，不自动停止当前 Web、修改 workspace/凭据或补发旧任务。
- [x] 7.5 用户明确允许真实发送及重新加载后，在原群和测试线程分别创建新的短任务发送已有图片/普通文件，核对客户端消息、原生事件回执与状态三者一致；若尚未获得许可，保留此任务未完成并明确真实互通缺口，不能以本地替身测试代替。

## Workflow follow-up

- 提案通过审阅后，由用户另行请求进入 apply；本次仅创建方案，不运行上述实施任务。
- 实施及必要验收完成后，再按用户请求同步规范或归档，不在本次提案生成中自动执行。
