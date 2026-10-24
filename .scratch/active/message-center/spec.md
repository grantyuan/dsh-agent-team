# 消息中心 — 设计快照

## 1. 问题

Human 在收件箱里回复一条消息后，既找不到自己发出的那条消息，也无法判断 Agent 是否处理过它。Inbox 是「需要我处理」的队列，不是「我与 Agent 的全部通信」的检索面：它按 Workspace 分片、只列有我未读痕迹的 Thread、且不呈现我发出的内容。

## 2. 用户口径（已确认）

用户原话（m00001，逐字节选）：「我现在找不到发给我的消息，以及我回复的消息，在收件箱内回复消息后，就找不到我发生的那条消息了，也不知道是否已被agent处理了」。

| 问题 | 选择 | 含义 |
| --- | --- | --- |
| Q1 范围 | A | 全局聚合：跨当前可见的全部 Workspace，按 Workspace → Channel 分组 |
| Q2 收录 | 全纳入 | 发给我的（含 mention）+ 我发出的 Thread 回复 + DM 双向 |
| Q3 处理状态 | L3 | 需要新的显式账本事实；P1 先给派生痕迹，P3 再做事实 |
| Q4 检索 | A | 同一页面双 tab 共用一条搜索栏 |
| Q5 状态机 | A | pending / acknowledged / resolved 三态（忽略并入 resolved + reason） |

## 3. 数据模型事实（取证结论）

- `AgentTeamMessage`（`types/entities.ts:386-406`）没有父消息字段；全仓库 `replyTo|inReplyTo|parentMessageRef|replyToMessageRef` 零命中。**「回复对象」不能精确建模**。
- Thread 由首条 top-level Message 建立（`anchorByThread`），后续消息都是 Thread 内事实，不存在消息级回复链。
- 每条 Message 有 `mentions`（结构化 Member refs，来自发送操作），是「发给谁」的唯一权威。
- `AgentTeamDirectMarker`（`types/entities.ts:453-458`）= (memberId, threadRef, messageRef, sequence)：某条 mention 对某 Member 的未读直投痕迹；被读后从 `directMarkersByMember` 消失。
- `AgentTeamThreadAttention` 带 `readThroughSequence`：某 Member 在该 Thread 的已读水位；仅在其 follow 期间存在。
- Claim（`team/claim-created/done/released`）与 `team/task-changed` 是 Thread 内的活动事实，可按 sequence 定位在某条消息之后。
- DM 是 `team/dm-sent` 操作（`types/operations.ts:440-448`）：纯投递，不建 Channel/Thread/revision，无 Inbox 痕迹；只有 sender/recipient/body/occurredAt/sequence。

## 4. 处理痕迹口径（P1，零新事实）

对「我发出的消息」，按下列信号顺序推导，全部可在投影内计算：

| 信号 | 来源 | 含义 |
| --- | --- | --- |
| `read` | 收件人 `attention.readThroughSequence >= message.sequence`，或该消息的 direct marker 已被消费 | Agent 已读到这条 |
| `replied` | 同 Thread 中 sequence 更大的、由他人发出的 message 事实 | Agent 已在该 Thread 回复 |
| `claimed` | 该 Thread 的 Task 上、sequence 更大的 `claim-created` 活动 | Agent 已认领该工作 |
| `task-closed` | 该 Task 上 sequence 更大的 `task-changed`（accept/close）活动 | 工作已收口 |

映射到三态：任一 `task-closed` → `resolved`；否则有 `replied|claimed|read` → `acknowledged`；否则 `pending`。行上同时给出 `evidence` 数组与 `basis: 'derived'`，界面文案明确写「据账本推导」，不冒充人工确认。P3 才引入显式状态事实。

## 5. Remote 契约

```ts
@Remote('messageCenter')
messageCenter(request: AgentTeamMessageCenterRequest): AgentTeamMessageCenter
```

请求（每个 Workspace 一次；客户端按可见 Workspace fan-out，Host 仍逐 Workspace 授权）：

```ts
interface AgentTeamMessageCenterRequest {
  readonly workspaceId: WorkspaceId
  readonly view: 'topics' | 'messages'
  readonly query?: string          // 大小写不敏感子串，匹配主题、正文、发送者 handle/name
  readonly channelRef?: AgentTeamChannelRef
  readonly includeArchived?: boolean // 默认 false
  readonly since?: string          // ISO 时间下界（含）
  readonly until?: string          // ISO 时间上界（含）
  readonly direction?: 'received' | 'sent' | 'all' // 仅 messages，默认 all
  readonly cursor?: number         // 上一页最后一行的 sequence
  readonly limit?: number          // 默认 50，1..100
}
```

结果（判别联合，`view` 是判别键）：

```ts
interface AgentTeamMessageCenterTopics {
  readonly view: 'topics'
  readonly humanMemberId: AgentTeamMemberId
  readonly topics: readonly AgentTeamTopicRow[]
  readonly hasMore: boolean
  readonly cursor?: number
}
interface AgentTeamMessageCenterMessages {
  readonly view: 'messages'
  readonly humanMemberId: AgentTeamMemberId
  readonly messages: readonly AgentTeamMessageRow[]
  readonly hasMore: boolean
  readonly cursor?: number
}
```

排序与分页：topics 按 `lastOccurredAt` 降序（同刻按 `threadRef` 升序），messages 按 `sequence` 降序；`cursor` 是上一页最后一行的 sequence，下一页只返回严格更小的 sequence。越界 limit 抛 `message center limit must be an integer between 1 and 100`。

## 6. 行形状

`AgentTeamTopicRow`：workspaceId、channelRef、channelName、threadRef、taskRef?、taskNumber?、subject（anchor 正文截断 120 字符）、openedAt、lastOccurredAt、lastActor、messageCount、participantCount、unreadCount、iParticipated（我写过消息）、needsHumanDecision、claimOwners、matchExcerpt?（query 命中片段）。

`AgentTeamMessageRow`：workspaceId、channelRef、channelName、threadRef?、threadSubject?、taskRef?、taskNumber?、messageRef?（DM 行无）、dmOperationId?（DM 行有）、sequence、occurredAt、sender、recipients（mention 或 DM 对方）、excerpt、direction（received|sent）、via（thread|dm）、dmPartner?、replyContext?、processing。

`replyContext` 诚实表达推导性质：`{ relation: 'previous-in-thread' | 'thread-anchor', sender, excerpt, messageRef }` —— 用「Thread 内我这条之前最近一条他人消息」作回复对象，界面文案写「上一条」而不是「回复了这条」。精确 replyTo 需要新增字段，属 v2。

## 7. Client 设计

- 新导航面 `messages`（与 `inbox`/`tasks` 同级）：`navigation.ts` 的 readSnapshot、persistSnapshot、每个 setter 的解构、leaveThread 分流都要同时加，否则两个面会同真。
- 页面：顶部一条共用搜索栏 + 时间范围 + Channel 过滤；下面两个 tab：「所有讨论」「我的消息」。两个 tab 共用同一搜索状态。
- 「所有讨论」行：Channel 名 + 主题 + 最后活动时间 + 参与者头像堆 + 我参与标记 + claim owner 徽标；点击进入 Thread。
- 「我的消息」行：方向徽标（收到/发出）+ 发送者 + 时间 + 摘要 + 回复对象上下文 + 处理痕迹胶囊；行内可直接回复（复用 `reply`）；点击「定位」跳 Thread 并滚到该条消息、高亮一次。
- 分组：按 Workspace → Channel，组头显示未读数；跨 Workspace 聚合在客户端完成（与 `TeamInboxPage` 相同的 fan-out）。
- 空/加载/错误三态齐备；键盘可达；390×844 窄屏可用。

## 8. 分期

- **P1**：类型 + `messageCenter` Remote + 派生处理痕迹 + Host 测试。
- **P2**：navigation face + 页面 + 双 tab + 搜索 + 分组 + 行内回复。
- **P3**（延后，验收后再定）：`team/message-acknowledgement-changed` 事实、人侧 `changeMessageAcknowledgement` Remote、agent 工具。

## 9. 落点（决策密集，供实现时定位）

- 类型：`packages/agent-team/src/types/requests-results.ts`（照 `AgentTeamInboxRequest`/`AgentTeamInbox` 风格）。
- 投影：`packages/agent-team/src/ledger.ts`，复用 `memberActor`(2488)、`liveClaimOwners`(2501)、`isChannelMember`(5216)、`threadAnchor`(4961)、`workspacesOf`(5243)、`taskNumbers`；limit 校验照 `inboxForWorkspaces`(2367)。
- Remote：`packages/agent-team/src/index.ts` 4050-4055 模板，`this.requireWorkspace(request.workspaceId)` 后委托 ledger。
- Client 接线：`packages/client-agent-team/src/client/index.ts` 的 `sharedRemotes`；`slots.ts` 的 `TeamConversationProps` 与 import 块；`TeamConversation.tsx` 在 sessionHistory 分支之前插入 `messages` 分支。
