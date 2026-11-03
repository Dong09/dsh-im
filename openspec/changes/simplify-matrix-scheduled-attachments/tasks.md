# Tasks

实施依据为 [spec](specs/matrix-scheduled-delivery/spec.md)，技术边界与取舍见 [design](design.md)。实施状态见下方复选框及[验证证据](implementation-evidence.md)。先移除自研文字职责，再删除排除桥；实际运行设置写入必须放在目标代码与回归通过之后，且须证明运行实例已加载目标实现。

## 1. 定时路径与状态写入收窄为附件

- [x] 1.1 记录实施 worktree 的 HEAD、另一 worktree 改动及现有状态兼容 fixture，保留安全基线；用 `git status`／引用及隔离副本确认没有覆盖用户新改动，不改生产状态或原生任务。
- [x] 1.2 在 [RelayStore](../../../plugin-src/host/schedule-relay-store.mjs)取消默认文字 manifest，新 attempt 显式要求非空附件清单，历史 reader 保留 v1/v2 text/mixed/artifact；更新 [store tests](../../../test/schedule-relay-store.test.mjs)覆盖 v1 四状态与字节备份、v2 旧文字/混合清单往返、损坏/未来版本拒绝、高水位不降、迟到结果隔离及新文字 manifest 拒绝。
- [x] 1.3 在 [relay coordinator](../../../plugin-src/host/schedule-relay-coordinator.mjs)删除最终文字收集与 text job/part，只有已确认附件才建 job；重写 [relay tests](../../../test/schedule-relay.test.mjs)及 [artifacts tests](../../../test/schedule-relay-artifacts.test.mjs)，断言无附件零自研发送和零新 attempt、纯附件可发送、新 manifest 全为 artifact、附件间顺序正确。
- [x] 1.4 将 [service](../../../plugin-src/host/delivery-service.mjs)、[adapter](../../../plugin-src/host/delivery-adapter.mjs)与 [MatrixController](../../../src/channels/matrix/matrix-controller.mjs)的私有 scheduled 部分入口收窄为真实 managed artifact；在 service/adapter/Matrix delivery 回归验证 text、伪造对象、path/URL/bytes 均在原生 side effect 前拒绝，文字 HTTP/RPC 白名单及其他渠道不变。
- [x] 1.5 审计 legacy `finish()` 等旧文字 writer 的实际调用点，替换旧测试的造数方式后移除无生产用途的写接口；用调用点检查及 [store tests](../../../test/schedule-relay-store.test.mjs)证明兼容读取不依赖废弃文字发送，更新模块 JSDoc 和中英文状态说明，明确新结果只描述附件。

## 2. 删除双文字去重桥，改成职责分离组合回归

- [x] 2.1 同批删除 relay 的 completed-event WeakMap／`deliveryDestinationFor`、[Host](../../../plugin-src/host/index.mjs) 的 `resolveAnswerDestination`、[通用同步](../../../plugin-src/host/session-sync-coordinator.mjs)及 service/adapter 的 `excludedDestination`／`matchesScheduledDestination`；检查这些生产符号已不存在，并以官方 Session sync 及 [Host tests](../../../test/host.test.mjs)验证不再依赖跨发送器归属协议。
- [x] 2.2 重写 [共存组合测试](../../../test/schedule-session-sync-coexistence.test.mjs)，使用真实 Host、官方协调器和附件 relay：房间/线程、sent/failed/unknown、延迟设置/发送各场景均断言仅一份官方最终回答、自研仅附件、同一 artifact 不重复派发；保留独立文字不确定性保护及对应 [service regressions](../../../test/delivery-service.test.mjs)。
- [x] 2.3 在组合测试补齐无附件、空最终文字、官方文字失败/未知/开关关闭、附件失败提示、附件检查点写入失败；断言两者独立而不强制相对顺序，失败不会授权自研文字兜底、补发附件或重新生图，更新中英文行为说明。
- [x] 2.4 更新 [Host relay tests](../../../test/schedule-relay-host.test.mjs)并保留 owner/来源/lifecycle 反例：首步文件登记、自动 time/runtime 上下文、mixed、普通 RPC 接管、旧 lease 晚到提交、下一回合并行、取消、关闭排空与卸载零晚到发送；无关的共享 Harness 生命周期及 v12 回归必须保持。

## 3. 官方文字目标与私聊交互目标分域

- [x] 3.1 在 adapter 和 DeliveryService 为 `listSessionSyncTargets` 增加默认私聊的显式范围，只有官方文字协调器请求 `privateOnly:false`；扩展 [adapter tests](../../../test/delivery-adapter.test.mjs)覆盖启用的保存房间/线程文字候选、禁用/删除/rebound 拒绝，默认私聊枚举保持原断言。
- [x] 3.2 修正 [Host 全局开关 wrapper](../../../plugin-src/host/index.mjs)转发范围参数；以真实 service/adapter/coordinator 的 Host 组合回归确认非私聊文字候选可达、两开关均关闭时任何范围都为空、无保存目标走绑定、存在但未匹配/未启用的保存目标仍不被绑定回退绕过。
- [x] 3.3 保留审批／提问默认私聊调用与 describe/present gates；运行 [service tests](../../../test/delivery-service.test.mjs)和 adapter 既有反例，证明群/线程既不接收交互，也不接收其 Web/桌面兜底通知，DS Bot 私聊歧义规则不变。
- [x] 3.4 更新 [中文指南](../../../PROACTIVE_DELIVERY.md)与 [English guide](../../../PROACTIVE_DELIVERY.en.md)的文字候选说明，区分全局回答开关、保存目标策略与私聊交互候选；用前述矩阵逐项核对文档，不把文字候选修复描述成任意房间授权。

## 4. 附件独有安全边界与真实 Host fixtures

- [x] 4.1 保留 [artifact registry](../../../src/channels/shared/semantic/artifact.mjs)的非 RPC owner lease 和普通 promptRpcId 隔离；运行 outbound-artifact/consumer/recovery 回归，断言普通 IM 附件仍正常、无消费者拒绝不放宽、工具及外层失败不提交、旧清理不影响新 owner。
- [x] 4.2 在附件组合与 Matrix runtime/lifecycle 回归保留：原字节及 fileName、经典/v12 房间和精确 thread、图片明确拒绝最多一次文件回退、未知零回退、加密不可用零上传/零明文、发送成功后 checkpoint 故障零重复与剩余快照释放；测试明确状态不代表官方文字成功。
- [x] 4.3 更新 [真实 headless 测试](../../../test/schedule-relay-real-host.test.mjs)及其 [fixture plugin](../../../test/fixtures/schedule-relay-real-host-plugin.mjs)、[顺序 fixture](../../../test/fixtures/schedule-relay-sequence.json)和 profile audit：脚本模型/临时 home/平台替身下验证一份官方文字加原图片/普通文件、原群/线程、直接 IM 不重复，且不依赖手动预开消费者或 sleep。
- [x] 4.4 对旧 Session 路由添加 `/new`／改绑及隔离重启回归：附件仍按无冲突旧记录处理，官方缺少当前文字绑定时不伪造文字；更新说明中“附件路由保留不等于旧 Session 文字保留”的限制，并覆盖新旧 v2 高水位不触发历史补发。

## 5. 设置契约与决策记录随改动落地

- [x] 5.1 扩展 [settings tests](../../../test/delivery-sync-settings.test.mjs)及 [management tests](../../../test/management-rpc.test.mjs)，验证正常认证 GET→仅 patch 回答字段→GET 保留输入镜像和 icons、同一 Host 单例可见、未授权零写入；保留发布 defaults=false 和跨平台文件权限 helper，不用外部 JSON 修改代替缓存更新。
- [x] 5.2 新建本次简化的后继决策 note，按活跃 notes 逐篇记录相关/部分替代/无关；旧定时附件 note 仅增加后继链接，不将历史 Decision 改成反面，也不整篇归档；执行 notes tree/format/archive 校验并在新记录中标明实际验证与未执行验收。
- [x] 5.3 随实现更新中英文指南、相关源码 JSDoc 及前 OpenSpec change 的后继引用，明确 `matrix.scheduleReplies` 仅控制附件、官方回答开关全局、独立顺序、附件状态专属及 v1/v2 回滚边界；核对相对链接有效，不能让旧文字要求随后原样归档成现行主规范。

## 6. 跨模块验证与当前实例启用

- [x] 6.1 运行全部受影响 relay/store/artifact/service/adapter/Session sync/Host/Matrix/settings/authority 回归与全量测试，使用 Windows 规范临时路径；如实记录通过、失败、取消、环境跳过，并通过 notes 校验、OpenSpec 严格校验及 `git diff --check`。
- [x] 6.2 重建 Client/Host，运行包校验和 Host ESM 导出烟测，检查私有附件入口未进入 facade/HTTP/RPC；记录实际部署路径和加载/重载方式，不能以浏览器刷新假称运行 Host 已加载目标代码，不擅自停止服务。
- [ ] 6.3 只读确认当前运行 Host 的设置作用域和合法 management transport；在目标实现已加载后，通过该实例 `settings.delivery-sync.get` 记录原值，`settings.delivery-sync.set` 仅传 `{deliverModelAnswers:true}`，再 GET 读回；报告全局影响和原本已开启的输入镜像，不改认证策略、默认值、其他字段或磁盘 JSON。
- [ ] 6.4 交付代码改动、构建及回归证据与设置读回结果；无法合法启用或无法确认目标代码已加载时，明确保留该项未完成并报告具体缺口，不能以已生成代码／写过文件替代运行时成功；真实平台未发送验收则明确说明，不宣称当前 Matrix 客户端已收到附件。

## Workflow follow-up

- 本轮提案完成后停止；新的用户请求进入 apply 才实施，不在规划轮修改代码或启用设置。
- 用户另行允许真实平台验收时，再明确测试房间/线程、已有文件和新提醒范围；仅验证新任务，不补发历史任务。
- 是否提交、推送、同步另一 worktree、同步主规范或归档变更，由后续明确指令决定；不自动覆盖另一分支的新改动或重写远端。
