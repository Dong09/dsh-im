# Agent Note: Matrix 定时附件的所有者授权与逐部分防重

Status: implemented

## Problem

原生 schedule 没有普通 IM 的 rpcId，文件登记因此缺少消费者；时间快照又被当成人类插话。仅放宽消费者检查会把附件交给错误回合，且文字成功不能证明附件已送达。图片成功之后的本地写盘失败若进入图片发送 closure，会被共享交付器当成图片失败，产生第二个文件事件。

## Decision

实现依据为 [OpenSpec 设计](../../../../openspec/changes/matrix-scheduled-artifact-delivery/design.md)与[能力规范](../../../../openspec/changes/matrix-scheduled-artifact-delivery/specs/matrix-scheduled-delivery/spec.md)。同步 claim 账本按 Session 与 turn 分离；可等待 pre-step 取得唯一 Matrix room/thread 路由、冻结账号及 adapter registration，复查输入代次与取消状态后打开非 RPC lease。真正混入输入会粘性拒绝本轮；只有已知 producer/form 的自动上下文可以忽略，不匹配正文前缀或任意 snapshot。

文件 stage、权威工具 commit、take、close 及 abort 清理都核对私有 owner。正常结束先 take 再 close，冻结 job 保留受控 artifact 原对象，不序列化其 WeakMap 身份；下一回合生成不等待上一回合发送。普通 RPC 携带 promptRpcId 领取自己的附件，不伪造 schedule rpcId，也不扩大历史或问答权限。

内部单部分入口只接受真实 managed artifact 或内部文字，复用现有 Matrix runtime 与共享图片优先策略，不进入公开 facade、HTTP 或 RPC。文字及各附件显式记录真实结果，失败通知单独保留，不能用通知可见、布尔 sent 或单个消息 ID 推导全部成功。

v2 状态先落完整意图，再逐项落 sending，发送器返回后才落终态。所有 checkpoint 都在图片/文件 closure 之外；终态写盘失败停止剩余 side effects，保留 sending 防重，释放剩余快照。未知优先于失败，只有全部必需部分确认才为 sent。v1 双读保留原目的地、冲突和高水位，首次写 v2 前保留原字节备份；损坏、未来版本或备份失败拒绝启动，不降为空库。重启不恢复历史快照或 pending，不补发旧回合。

关闭先撤 hooks 和 admission、撤自己的 lease、取消尚未开始的工作，再等待已接受发送与 checkpoint 收尾，最后撤 adapter/runtime/store。abort 不代表远端撤回，已有可信成功回执保留；未确认结果不盲目补发。不调用全局 registry.clear。

## Verification

本次基线 relay/Host 为 32/32；v2 store 的 12/12 覆盖同名不同 artifact 身份、迟到尝试、v1 四状态备份与升级、损坏/重复/未来格式拒绝和写盘失败。OpenSpec 严格校验通过；i18n 覆盖 15/15，通过既有文案避免新增未翻译提示。运行日志中静态扫描未解析的动态 t 调用与孤立字典项是提示，不是本次新增缺键。

反向探针临时移除 time-context 允许项、令首步 lease 为空，均使真实来源组合测试在 active consumer 断言变红，字节还原后通过。第三项把终态 checkpoint 临时放入测试平台的 image closure，P0 检查观察到本不应发生的文件回退，字节还原后通过。第四项令旧 lease 的清理误伤新 owner，普通 owner 隔离用例变红，按记录哈希还原后通过。四项探针只在隔离测试环境执行，没有真实 Matrix 请求。

真实 DSH headless profile 的首请求序列以脚本化模型与临时 home/workspace 回放四场景（原房间图片、线程图片、原房间普通文件、直接 IM），每场景模型调用两次、生图调用零次，断言原字节（图片 68 字节精确）、精确目的地、version 2 全部 parts 为 sent 且直接 IM 仅一条回复；不使用 sleep，也不预先手动打开消费者。最终合并受影响回归 844/844 通过、零失败零跳过，覆盖 store 12/12、relay 11/11、relay Host 12/12、relay artifacts 54/54、outbound artifact 系列 77/77、delivery service/adapter/http/rpc/contract、matrix-runtime、lifecycle 与 i18n 15/15；无新增 t() 文案，静态扫描未解析动态调用与孤立字典项为既有提示而非缺键。构建、包校验与 `lib/index.js` ESM 烟测（导出 apply/createImHostPlugin/inject）通过。

真实互通验收已在用户明确允许下完成于运行实例（未重启 Web）：经 HMR profile recomposition 热重载新 bundle 后，运行实例以新代码完成生产状态 v1→v2 迁移（`.v1.bak` 与迁移前基线逐字节一致）。原群图片交付（session-094cb… turn 16）：text 回执 `$8X_qKty9…` 经同步时间线命中，artifact `banner.png` 310,969 B、digest `abbbff5a…65074209` 与源文件逐位一致、homeserver 签发回执 `$YzAyMiR…`，用户客户端目视确认图片消息正常。测试线程文件交付（新线程 Session turn 2）：thread 路线 threadId 为合法事件 ID，text `$6QIhLZDu…` 时间线命中，artifact `THIRD_PARTY_NOTICES.md` 20,540 B、digest `07e05299…90628c2d` 与源文件逐位一致、回执 `$VnRIpGeHs…`，客户端文件卡片渲染确认；线程任务落于独立新 Session，父房间高水位未被污染，线程隔离在真实环境成立。bot 自身 m.image/m.file 不写入 ambient 历史属既有策略，其事件存在性由 homeserver send 回执与用户客户端目视共同闭合。

## 与既有记录的关系

创建本文前检索所有活跃 proposed/implemented/rejected 笔记及相关 ADR：[共享 Harness 生命周期](2026-10-29-shared-harness-consumer-lifetime.md)部分重叠，继续保留其共享资源持有纪律；[Matrix 非加密主线](2026-10-27-matrix-non-e2ee-mainline.md)部分重叠，继续保留单一回退、加密拒绝、未知结果与真实排空规则；[生命周期简化提案](../../proposed/simplification/2026-10-28-matrix-lifecycle-ablation.md)不在本次范围，不实施或改变其状态；[统一语义核心 ADR](../../../../docs/adr/0001-semantic-core-native-channel-adapters.md)保持现有约束。没有旧笔记被完全吸收、替换、拒绝或归档。

## Alternatives considered

1. **在 claim 时 await 路由。** 授权位置直观，但 Host 不等待 claim 回调的异步返回，不能保障首请求；选择已有 awaited pre-step，并由真实 Host 的 refreshContext 顺序测试验证指引。
2. **伪造 RPC id 复用普通消费者。** 能少改一层 API，但混淆来源且旧回合清理会伤及普通 owner；使用明确的非 RPC lease。
3. **继续只存文字布尔成功，或把 checkpoint 放入媒体 closure。** 前者保持旧存储简单，后者便于局部包装，但不能表示部分失败，还会让本地磁盘故障触发图片转文件；采用逐部分状态和发送器外 checkpoint。
4. **扩展外部主动发送为任意文件接口。** 调用方便，但扩大本地文件读取能力，并重复凭据和生命周期实现；选择仅 Host 内部 managed artifact 桥。

## Consequences

收益是首工具即可登记、普通与定时所有权隔离、文字失败不吞附件、真实部分结果及失败不重播。代价是每个部分增加原子写入，进程崩溃时接受尚未提交附件也不自动恢复；用户需新建明确请求并人工核对未知结果。该实现不提供 exactly-once、远端撤回或用户已读保证，也不改变工作区、凭据、原生任务和其他渠道能力。
