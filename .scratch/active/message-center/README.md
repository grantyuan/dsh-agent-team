# 消息中心（Message Center）

**状态**：in-progress — P1（Host 只读投影）实施中，P2（Client 页面）未开始。
**最近核对**：2026-10-24
**当前前沿**：P1 = `AgentTeamMessageCenterRequest/Result` 类型 + `@Remote('messageCenter')` + 派生处理痕迹 + Host 测试。P2 在 P1 通过后开始。
**完成条件**：P1 与 P2 均落地，且 `npm run test`、`npm run typecheck`、`npm run test:browser` 通过；页面上能按时间/文本检索、能从行直接回复、能点击定位到 Thread 内该条消息并高亮；每条「我发出的消息」在行内可见处理痕迹（已读/已回复/已认领/已关闭）。
**正式文档出口**：P2 完成后把落地行为写进 `docs/frontend-design/message-center.md` 与 `message-center.zh.md`，同步两份 `docs/README` 索引行与 `scripts/check-docs.mjs` 的 ceiling 行；随后本目录归档到 `.scratch/archive/2026-10/message-center/`。

## 决策快照

见 [spec.md](spec.md)。它记录已确认口径、Remote 契约、行形状、派生处理痕迹口径与分期，是继续本工作项的唯一入口。

## 票据

| # | 票据 | 状态 |
| --- | --- | --- |
| 01 | [Host 消息中心投影](issues/01-host-message-center-projection.md) | in-progress |
| 02 | [Client 消息中心页面](issues/02-client-message-center-page.md) | ready（blocked by 01） |
| 03 | [Thread 定位与行内回复](issues/03-thread-locate-and-reply.md) | ready（blocked by 02） |
| 04 | [维护文档与验收证据](issues/04-durable-docs-and-evidence.md) | ready（blocked by 03） |

## 不做什么

P3（显式处理状态账本事实 `team/message-acknowledgement-changed`、人侧 Remote、agent 工具）不在本工作项范围内；P1 只展示零新事实的派生痕迹。
