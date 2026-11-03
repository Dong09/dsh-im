# Agent Note: Codex 订阅插件回退一版且保全 IM 状态

Status: implemented

## Problem

已安装 dsh-codex-subscription 3.2.3 的全局 internal/config 监听器将 entry-less scope 的配置当作 Fiber，触发读取 undefined.entry 的异常，导致共享 Peer 的内部 scope 初始化失败。最小本机保护修复后，新 Web 进程的 Peer 不再 abort，但 Matrix 新参考号 MF-06EB4450 改为 SESSION_WRITER_HELD，用户同时报告微信无响应，并明确要求 Codex 插件往前回退一版。版本回退不等同于解决会话写入占用或证明微信入站恢复。

## Decision

当前 web profile 通过包管理器精确固定 `dsh-codex-subscription@3.2.2`，依赖清单、锁文件和安装产物保持一致，执行安装时禁止生命周期脚本。不恢复整份旧 profile、不回退两项 IM OpenSpec 实施、不改变账号、模型、IM 工作区和会话历史，不删除锁或抢占写入权。

3.2.2 是 npm 上 3.2.3 之前的相邻稳定发布。其全局配置监听器直接使用实际 this Fiber，不含 3.2.3 中按 this.entry 回退到配置参数的错误分支；虽然 configure 内仍读取 fiber.entry，但传入的 Fiber 对象存在，entry-less scope 可正常跳过。采用未修改的发布产物，不将前一本机 3.2.3 空值补丁混入 3.2.2。

## 备份与验证

- 独立暂存 npm 3.2.2 tarball 并读取兼容声明，使用真实 Cordis、HostConnectionService、Peer 与 IM harnessPeer 验证其实际全局 listener：内部 scope ACTIVE，peer 保持存活。
- 安装前完整复制 3.2.3 本机热修复包，以及 profile 的 package.json、pnpm-lock.yaml、pnpm-workspace.yaml、cordis.patch.yml，备份位于用户 `.dsh/logs/codex-rollback-3.2.2-L4kQpj`；不把凭据或会话复制到诊断目录。
- 执行 `pnpm add dsh-codex-subscription@3.2.2 --save-exact --ignore-scripts`，供给链检查通过，退出码 0，仅报告包替换 +1。包管理器的 Host peer dependency 警告保留，不以安装成功替代实际运行兼容验收。
- 安装后的版本、依赖 specifier 和锁文件 version 均为 3.2.2。其他直接依赖的 specifier/resolution 和 bundle 列表保持不变；cordis.patch.yml 与 pnpm-workspace.yaml SHA-256 与备份逐字节一致，IM 仍链接原工作树。
- 安装 Host 产物 SHA-256 为 ab557e627d0bfe25cf157e88d2d443a147a842481ddd78efa55153b90e9a13ab，与单独获取的发布包一致；直接对实际已安装代码重跑 entry-less scope 检查通过。
- 未停止或启动 Web 服务，运行进程可能仍缓存 3.2.3。新进程加载、浏览器插件刷新、Matrix 和微信真实消息验收尚待完成。

## 活跃记录审计

[共享 Harness 生命周期](../bug-fix/2026-10-29-shared-harness-consumer-lifetime.md)部分重叠：保留原持有纪律和 3.2.3 根因/本机补丁证据，部署上由本篇的发布版本回退接替该补丁；不是推翻共享资源决定。[图片引用失效](../bug-fix/2026-11-02-matrix-image-reference-invalidation.md)、[定时附件简化](../simplification/2026-11-02-matrix-scheduled-attachments-only.md)、[非加密主线](../bug-fix/2026-10-27-matrix-non-e2ee-mainline.md)、[原定时附件实现](../bug-fix/2026-10-29-matrix-scheduled-artifact-delivery.md)不属于本次回退对象，保留原实现与状态。[生命周期消融提案](../../proposed/simplification/2026-10-28-matrix-lifecycle-ablation.md)无关，仍保持 proposed。没有旧记录被完全吸收、删除或归档。

## Alternatives considered

1. **继续保留 3.2.3 本机一处保护。** 功能变化最小，且已证明解决首次 Peer 初始化异常；但用户在后续消息仍失败后明确选择先回退相邻发布版，因此保全该安装的完整备份和证据，改用精确 3.2.2 pin，不声称原修复无效。
2. **仅覆盖旧发布包文件。** 改动范围直观，但依赖清单和锁文件仍指向 3.2.3，下一次安装会覆盖且无法审计实际版本；选择包管理器更新并检查其他依赖未变。

## Consequences

收益是回到可复现的未修改发布产物、获得一致版本 pin，并保留完整恢复材料。代价是放弃 3.2.3 新增行为，需要新进程与前端刷新；未来主动升级仍可改变 pin。回退不能释放其他存活实例或同进程遗留句柄持有的 Session writer，不能绕过 Windows 内核信号量，也不能将微信无入站/无回复直接当作同一个错误。恢复原 3.2.3 时应依据备份重新安装并显式决定是否重新应用空值补丁，不覆盖后续用户设置。
