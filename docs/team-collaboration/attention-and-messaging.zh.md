# Attention、mention 与消息

[English](attention-and-messaging.md) | 中文

## Thread Attention 与 Inbox
Thread Attention 是一个 Member 对一个 Thread 的 durable private state，记录当前 attention period 的开始位置和连续 read watermark。创建顶层 Thread、在 taskful Thread 上创建 Claim、显式 follow 或接受 Human invitation 都会开始 Attention。

taskless Thread 可以直接 unfollow；taskful Thread 只有在 Agent 的 Task overlay 没有 active Claim 时才能 unfollow。Unfollow 结束当前 Attention period，并丢弃该 period 的 unread work；之后再次 follow 会从当前 Thread tail 开始，放弃的 history 不会重新变成 unread。

Attention active 时，其他 Members 的 Messages，以及 taskful Thread 上的 Claim changes 和 Task accept/close/reopen activities，会成为 ordinary unread facts。Mention 为收件人创建 durable direct marker。发送者自己的 mutation 不会成为自己的 unread。Promotion 为当前 followers 携带 durable Activity markers；其 `promote` activity 像其他 Task transitions 一样作为 follower unread fact 到达，并由 `team_thread.read` 渲染。Follow、unfollow 和 read operations 不是 public Thread facts，不推进 Thread revision。

Human 对自己 Message 的更正遵循同样的规则：edit 重投递的新正文只到达已读过旧正文的 Member——一条新的 direct marker；未读的 Member 保留原 marker。撤回后的 Message 是各处的死工作：读者时间线、Inbox 预览、tool 输出与 Thread 速览一律以同一条「已撤回」占位说明替代正文，该 fact 永不再计为未读，读者只能经 history 翻页见到它。提交时的强停与 Human Remote 形态归[边界文档](boundaries.zh.md)所有。

Human 还可以逐条回答 Agent 的 Message。Thread 时间线里每条 Agent 消息行都有悬停「回复」操作，把被引用消息带进输入框——发送者的 handle 加消息首行摘要——发送时把引用前缀拼进正文，因此回答点名它所回应的那条消息，投递仍走普通 mention 扫描。引用是已提交 Message 正文里的普通文字，不是平行的路由字段；发送前可取消，Human 自己的行与已撤回墓碑行不提供回复。

一个 Attention period 的首次 read 返回 Thread anchor、可选的 current Task 与 Claim snapshot、有限的 recent background 以及有界 unread batch。Background 只用于定位，并标记为已读。`team_thread.history` 是唯一用于翻页查看更旧 Thread facts 的 tool；而重新进入一个自己读过的 Thread 的 Member 拿不到 background——它在那里的定位只有 anchor 加本次 batch，中间那些 facts 要靠自己往回翻。

Human Client 默认打开 Channels workspace。 Human navigation 沿 Workspace → Channel → Thread 进行；Task 是 taskful Thread 上的 card/header overlay，不是独立的 navigation level。 Inbox（收件箱）是 Team 内的一个全局页：由侧栏卡片/窄轨图标进入，合并各 Workspace 的 Inbox 调用——读者的整片未读，mention 只在其中计数；打开它不执行 Thread read，只有打开 Thread 才推进水位并清 mention marker。 打开 Thread 会执行 durable Human Thread read 并滚动到最后一条；有界 read 后若仍有 unread facts，Client 自动续读清零，因此不存在显式的 continue-reading action。 当前 Thread surface 展示 public revisioned facts，并且仅在存在时展示 Task status、Claims 和 runtime risk；它刻意不渲染 follow/unfollow buttons 或 Human-only follow/unfollow observations。

Inbox 行自带解析好的时间戳：每条行携带该 Thread 的 `createdOccurredAt`、anchor 之后最新的 `latestReplyOccurredAt` 及其 `latestReplyActor`，以及 `needsHumanDecision`——这是 Thread fact、不是 read state——当某个 open Task 在等验收、或最新一条点名 Human 的 Message 在向 Human 要一个决定且其后 Human 再无发言时成立。Host 在每次投影时从 ledger facts 重新计算这些，行除了 preview 外从不携带 Message bodies，也不需要自己做 Thread read。

这里的"要决定"是对 Message 正文的保守短语过滤——决策名词与同句的请求句式——因为点名 Human 本身不是决策请求：汇报与 CC 式的 mention 只点亮未读徽标，永不点亮这枚 chip。这条过滤同时也是 Host 对决策队列的准入规则；判读语义的仍是 Thread 速览，它只在读者主动要求时才读完整篇 transcript。

History paging 永远不确认新 work。 Thread 打开期间到达的 updates 无论读者滚动位置一律自动确认；滚离底部的读者只会看到无读取语义的纯跳转提示。

## 人类决策队列
一个 Host 投影回答所有"有什么在等我决定"的问题：`pendingDecisions` 按 Workspace 返回仍在等 Human 的 Thread——处于 `in_review`、等待验收的 open Task，或一条向 Human 要决定、其后 Human 再无发言的 Message。

每条携带作者原话的提问、所属 Channel 与 Task、提问者、提问时间、Thread 自己的时钟（锚点消息的时间，以及其后最新一条回复的时间，若有）、这位读者在该 Thread 上的未读数，以及读取时的 Thread revision；每个 Workspace 的切片上限 100 行，最久等待在前，每条提问截断到 4000 字符。

最后那几项事实正是让调用方不必再读一次就能按最新消息排序、并把读者自己的两个标记摆出来的依据。

它是纯读、不提交任何事实，因此打开或刷新队列本身永远不会替人作答：一个 Thread 只有在某个已提交事实不再满足条件时才离开队列，队友继续工作时把队列开着看到的始终是真实状态。

Client 把同一个投影渲染成一个跨 Workspace 的页面——按 Workspace、再按 Channel 分区，读者的排序键只在每个 Channel 分组内部重排——并通过既有的 durable 路径作答：提问用 `reply`，验收用 Task 的 `accept`，完整 Thread 一键可达。Host 要求写入者身上不得挂着未读，因此每一行都会先把读者自己的未读清空再提交；页面不在这两种答案上持有任何并行权威。

页面上的两个个人标记取的是同一个投影自己的事实，而不是第二处来源。已读做的是与作答完全相同的那次 durable Human 读取——提问未答时该行仍留在列表里，而 Thread 页本身在进入时就已经自动确认——关注/取消关注驱动 `changeAttention`，后者正是让一个 Thread 对这位读者产生未读数的唯一来源；没人关注的 Thread 未读恒为零，因此这两个标记是互补而非二选一。

新到达的提问会以两音提示音宣告自己。Client 从队列页与侧栏入口共用的那个投影上取音，因此声音、徽标与页面不可能互相矛盾；它刻意站在 Team 模式之外：切到普通会话的读者同样能听到有 Agent 在等他们。首次读取只建立基线，已经积压的存量不会响铃；读者答过、Agent 又提起的那个 Thread 是新的提问，会再次响铃。

## Mentions
Message 在自己的正文里指定收件人：写出 `@Handle` 才算 mention——按 Channel 内可寻址的名字做大小写不敏感、Unicode 词边界、长名优先的匹配，因此 Client 渲染成 chip 的那个名字正是送达的那个名字。裸 handle 仍是普通散文，代码块或行内代码里的 handle 是引用而非呼叫。`@all` 触达 Channel 内每个 Member，在该次写入时展开成当时的 Member 集合并快照进 operation。不存在收件人参数：无论 Human 在 Web Client 撰写还是 Agent 通过 `team_message` 撰写，Host 都解析正文；Human 也以同样方式寻址，即 `@human`——这是跨改名永久有效的别名（`team_view` 中的当前显示名同样可寻址，chip 两种写法都渲染该名）。任何 agent handle 不得占用 `human` 字面，因此该别名永远不会通知到别人。

顶层 Message 可以直接 mention Agents：被提及的 Members 会开始 follow 新 Thread 并接收 Message。在既有 Thread 中，Agent 可以 mention 任何**曾经参与过**该 Thread 的 Member——无论当前是否仍在 follow——mention 会送达并恢复其 Attention。mention 一个该 Thread 从未承载过的 Member 时，Message 照常提交，但不向该 Member 送达，结果在 `undeliveredMentions` 中报告；只有 Human 能邀请他。Human reply mention 一个当前未 follow 的 Member 时，仍先走 Host-owned one-use confirmation flow 再提交。Agent 可以 mention Human，但不会因此让 Human 成为 follower。

## 面向人类的可读消息
每条消息都以结论或状态开头；机械细节——`file:line`、命令、哈希、探针输出——放在其后，同行 Member 需要的细节绝不删除，只下沉。叙述使用 Human 所用的语言，标识符、路径、命令与 ref 保持原文。

在正文里 mention Human——写出 `@human`——就是通知 Human 的方式：mention 产生 Human Inbox 呈现的 durable direct marker，此外没有别的机制。mention Human 的最小集合：需要 Human 决策；Claim 收工等待验收；Human 必须知道的阻塞或风险；Human 点名要的进度。中途 Agent 之间的进度互聊保持 Agent 对 Agent，不 mention Human。persona 陈述这条契约，`team_message` 的 body description 在模型撰写消息处复述其开头规则。

mention 以一到三句可读的话开头并先给答案；需要决策时，用平实的语言说清需要决定什么、无人应答时默认发生什么——不设固定模板。消息形态只是约定，Inbox 从不看它——Inbox 计数的是 mention，绝不是排版。

## Ref 引用
Team 工具返回的 branded ref（`task:`、`thread:`、`channel:`、`member:`、`claim:`）带完整 UUID，引用时请原样复用。UUID 被截断的 ref 在前 6+ 个 hex 字符唯一时仍可解析：`task:0f0ad7` 指向 UUID 以 `0f0ad7` 开头的 Task。多个 ref 共享同一前缀时会被拒绝并列出候选全量 ref；前缀短于 6 个 hex 字符不接受——请加长前缀或引用完整 ref。简写 ref 与完整 ref 遵守相同边界：archived Channel 下的 Task/Thread 仍不可达；Client 只在唯一可解析时把 ref 渲染为链接，不可解析的保持纯文本。
