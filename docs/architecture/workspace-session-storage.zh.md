# Workspace、Session 和 storage reuse

[English](workspace-session-storage.md) | 中文

Team 读取现有 Harness Workspace projection，不创建第二套 Workspace store 或 Session tree。当前 Client 不调用 `ctx.workspaces.pickDirectory()` 或 `ctx.workspaces.create()`；需要创建 Workspace 时，用户回到普通 Session UI。

Member sessions 出现在普通 Session list 中，并且在 Host 保持 Member Agent live 时可继续读取。Cold Member session（suspended Member、activation failed，或 Host 尚未完成 restoring）无法通过 generic Session UI resume：该路径会在 ambient shipped roster 中解析 session 记录的 preset，而该 roster 刻意不包含 bundle-private `team-member` preset，因此 resume 会明确失败，而不会用错误 composition 重建 history。请通过 Team panel resume 这些 Members，或使用健康的 bundle 重启；不要给 ambient roster 增加 Team fallback。

修改 Workspace、Session、storage、persistence 或 Thread Inbox 时，先阅读相关 Team source/tests，然后阅读：

- `../deepseek-harness/docs/subsystems/workspace.md`
- `../deepseek-harness/docs/subsystems/session.md`
- `../deepseek-harness/docs/subsystems/storage.md`
- `../deepseek-harness/docs/subsystems/persistence.md`
- `../deepseek-harness/docs/defensive-patterns.md`

Team ledger 仍是唯一的 Team durable authority。Recovery 和 teardown 改动需要 failure-window 或 composition evidence，不能依赖 silent fallback。

Shipped bundle composition 只通过 public per-domain route table 把 `agent_team` domain 路由到 SQLite backend；其他 domains 保持 JSON default。SQLite medium（`$DSH_HOME/storages/agent_team.sqlite`）在首次 routed open 时全新创建；旧的 `agent_team.json` medium 永远不会被读取或迁移——是否移动或删除由 operator 决定。该 backend 是收归自有包名下的 vendored fork（`@wowyuarm/dsh-agent-team/sqlite-backend`，见 `packages/agent-team/src/vendor/storage-sqlite/`）；fork 为何存在、以及 loader 行不得重新引入的启动约束，归 [`development/storage-and-delivery.zh.md`](../development/storage-and-delivery.zh.md)。

0.1.5 分界之前写出的 Member Session 带有两个自定义 message source kind（`agent-team-context-handoff`、`agent-team-context-continuation`），released format 的迁移审计已不再准入它们。 该拒绝是 fail-closed 的，且发生在任何插件挂载之前，因此读时拦截无法救回这些日志。 `packages/agent-team/src/session-remediation.ts` 改为在启动时从写入侧修复：对每个 `enabled` Member，遍历其绑定的 Session 以及 header 上记录的每一级 `parentSession` 祖先；对 storage layer 拒绝、且行内确实带有上述 kind 的 artifact，把 source 改写为已准入形状（`plugin` + 具名 sections 的 `snapshot`），经 format catalog 的内存迁移链对整份 artifact 做全量校验，再用 hardlink 独占发布在原文件旁写出一份当前格式兄弟文件（`session.v3.jsonl.zstd`）。 原 artifact 永不被写入——storage layer 优先读兄弟文件，删掉它就是回滚。

因其它原因被拒的 artifact（未闭合的 `turn/start`、seq gap）保持字节不变并记诊断；历史里仍带旧 kind 但可读的世代只记日志、不改写，因为其 storage layer 可能仍在追加。 完成标记缓存在独立的 `agent_team_remediation` domain——刻意不放进 `agent_team` domain，后者的版本号是 ledger schema 的闸门。

Host 的每一次逐 Session stored 读取都经过同一个 seam：`packages/agent-team/src/stored-session-reader.ts` 负责一次 `open → read → close`（句柄保证关闭），并把所有失败归一为五类——`missing`、`refused`（确定性格式拒绝，携带 artifact 路径）、`corrupt`、`io`、`unknown`。消费方按类别选择策略，绝不匹配 Harness 错误文案：当前绑定激活与 checkpoint seed 解析对任何失败 fail-closed；carried-input replay 只对已退役世代的确定性 `refused`/`corrupt` 跳过；handoff 重建与 token 测量降级；timeline 在不可读祖先处截断 lineage 并以 `incompleteFrom` 显式报告，而不是静默断链。DSH persistence 接口变化只需在该模块内适配一次。上游 JSONL backend 的 corruption 系列以裸 `Error` 抛出，seam 内部以该稳定文案前缀识别；文案一旦变化即退化为 `unknown`，所有消费方对 `unknown` 走保守路径。

成员重启是确定性格式拒绝的有界自愈：激活失败带 `session-refused` diagnostic 时，`recoverMember` 先对该成员运行同一套启动 remediation，修出 artifact 才重试一次激活；走完而无 Team 可证明可修的内容时，diagnostic 标记为不可修复，Client 停止提供重启并显示 artifact 路径。激活 diagnostic 是结构化的——`AgentTeamMemberDiagnostic` 携带 `class`（`session-refused`、`session-unreadable`、`preset-composition`、`rollover`、`runtime`、`activation`）、detail，以及适用时的被拒 artifact 路径与可修复判定。availability/presence 仍是仅有的用户可见状态；diagnostic 是投影派生态、绝不持久化，ledger 仍是唯一 Team 权威。
