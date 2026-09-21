# Context continuity — 引擎抽取与 Team 接入

## Status

active — 引擎已独立落地并发布（`@wowyuarm/dsh-context-continuity`，发布与仓库由 @Ferry 负责），Team 侧接入走到三步中的第二步。

last-checked: 2026-09-21（Team 侧 fold 迁移完成并提交；按 Human 要求「team那边先不急」，这三个提交暂不推）。

## 这是什么

Team 的 context management（rollover / checkpoint / 投影 fold / 压力策略 / 谱系检索）抽成独立插件，Team 作为外部依赖消费它。原孵化目录 `packages/context-continuity/`（未提交）已删除：其 `src/` 七个文件与引擎仓库首个提交 `94ff8f7` 逐字节相同（仅 `@module` 标签不同），两份设计文档原样迁入本工作项。

## 当前 frontier

三步走（见 [`spec.md`](spec.md) §C.5），每步以 Team 现有 context 测试全绿为验收：

1. ✅ coordinator + codec 接入（Team `37336bb`）
2. ✅ 投影 fold 迁到引擎的 `contextContinuity` unit，Team 只留 host 半边（`c66bce0`）；引擎解析改为「相邻 checkout → registry 已安装包」+ 根 devDependency（`25b8f01`），干净 checkout 形状已端到端验证
3. ⏳ **timeline / search 接入** —— ticket [`issues/01-team-timeline-search.md`](issues/01-team-timeline-search.md)，无阻塞，可直接开工

阻塞：无。第二步的三个提交（`f650835` / `c66bce0` / `25b8f01`）留在本地等 Human 发话。

## 完成条件

- 三步各自全绿，且 [`spec.md`](spec.md) §C.4 的四项验收在能跑完整 Team 测试的环境里做完：现有 context 测试、`dsh-developer verify` 真机跑三个 context 工具、带旧 `new_context` 事件与旧 section 名的历史日志迁移、rollover 崩溃恢复演练。**前三项尚未做**，是本工作项收尾前必须补的。
- Team 不再持有引擎已有机制的副本（自有 fold、timeline candidates 派生）。

## 正式文档出口

- host 如何接入引擎 → 引擎仓库 `docs/integration.md`（host 契约的唯一权威）。
- Team 侧当前机制与边界 → `docs/architecture.md`「Tools and preset」段（已随第二步更新）。
- 引擎依赖与安装契约 → `docs/development.md`（已随第二步更新）。
- 本工作项收尾时：仍属维护性的结论并入上述文档，其余移入 `archive/2026-09/`。

## 仍然绑定的红线（[`spec.md`](spec.md) §C.3，第三步同样适用）

pluginId 保持 `@wowyuarm/dsh-agent-team`；handoff / checkpoint 的 section 名固定；rollover session id 命名 `agent-team-rollover-${sha256(...)}` 不变；projection state 语义一变就 bump `stateVersion`；`new_context` 的 legacy 解码保留（它是日志解码器，不是工具别名）。
