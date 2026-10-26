# 01 — Host 消息中心投影

**What to build:** Human 可用的一个只读 Remote `messageCenter`，按 Workspace 回答两种视图：「所有讨论」（该 Workspace 内全部未归档 Channel 的 Thread 行，带时间与文本过滤）与「我的消息」（发给我的、我发出的 Thread 消息，以及与我相关的 DM，带方向、发送者、回复上下文、派生处理痕迹）。返回形状可直接驱动界面，无需客户端二次拼装。
**Blocked by:** None — can start immediately
**Status:** done

- [x] `AgentTeamMessageCenterRequest` 与两种结果形状（`view` 判别键）进入共享类型导出，风格与 `AgentTeamInboxRequest`/`AgentTeamInbox` 一致
- [x] topics 视图返回该 Workspace 内全部未归档 Channel 的 Thread；`includeArchived` 可纳入已归档；每行含主题截断、打开时间、最后活动时间与 actor、消息数、参与者数、未读数、我是否参与、是否需要 Human 决策、claim owners
- [x] messages 视图返回三类来源：mention 到我的消息、我发出的 Thread 消息、与我相关的 DM；`direction` 可过滤 received/sent/all
- [x] 每行给出 direction、via、发送者、时间、摘要、`replyContext`（标注为推导关系而非精确 replyTo）
- [x] 我发出的 Thread 消息带 `processing`：三态 + evidence 数组 + `basis: 'derived'`，由已读水位、后续他人回复、后续 claim、后续 task 收口推导
- [x] `query` 对主题、正文、发送者 handle/name 做大小写不敏感子串匹配，命中行带 `matchExcerpt`；`since`/`until` 按 ISO 时间过滤
- [x] `channelRef` 过滤经唯一前缀解析；归档 Channel 在未显式纳入时被跳过
- [x] `limit` 默认 50、越界抛 `message center limit must be an integer between 1 and 100`；`cursor` 严格递减分页，`hasMore` 正确
- [x] 结果全部 `Object.freeze`；非参与者或跨 Workspace 越权请求被拒绝，与既有 Host 授权边界一致
- [x] Host 测试覆盖：两种视图、三个来源、派生处理痕迹的每种 evidence、搜索与时间过滤、分页边界、limit 越界、归档 Channel 与授权拒绝
