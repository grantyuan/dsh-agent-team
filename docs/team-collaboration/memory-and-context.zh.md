# 记忆、上下文压力与通知

[English](memory-and-context.md) | 中文

## Member memory 维护
`memory.md` 是有界路由索引而非仓库：只装身份与职责、必须每步生效的长期规则、当前在手，以及每个主题簇一行；`notes/` 按需读取、从不注入。成员把索引常态保持在 8 KiB 以内、硬顶 16 KiB——超过硬顶索引整块不再注入，注入块始终自带用量。维护手艺（什么配得上一行、三层结构、压实与降级）归内置 `member-memory-manager` core skill，与 skill 写作归 `member-skill-manager` 同一套路；persona 只常驻「索引必须有界、细节留在它点名的那篇笔记里」这一条，成员首次生成的 `memory.md` 脚手架陈述同样的小节。

## 上下文压力归属
Host 端到端拥有 Member 的上下文压力管理。两个预算阈值从该 Member 的 live routed selection 派生——当前 step 已进入 prompt assembly 时取其捕获的 selection，否则取 current selection——经 LLM 服务解析（handoff 预算上限 200K、硬上限 256K，并留安全 reserve）：达到 handoff 预算时，Member 在该 generation 内收到一条结构化压力通知，且它是命令而非建议——先把必须超出这份上下文存活的内容写进 private memory，再压缩上下文（`context_rollover`，或该 route 自带的压缩）——同一 generation 不重复，rollover 后重新武装。

持续在 handoff 预算之上推进的 Member 随后会收到该 generation 唯一一条压缩令；再耗尽压缩令自己的额度后，由 Host 代它执行这次压缩。Host 无法证明压回预算之内的上下文会阻断该请求，并被交给 supervision 强制链的 fresh-context 重置：Member 保住自己的 identity、private memory 与 Channels，并据此重新定位。

直接拒绝 Host 压缩的 route 仍交回它自带的压缩，那里由 provider 指明上下文超限——supervision 把这种停止当作「继续」提示治不了的一类。

达到硬上限时，Host 在转发下一个模型请求前强制一次原地 compaction，只有实测压力被证明降到硬上限之下才放行该 step——无法测量或仍超标即 fail closed（拒绝该 step，不超限提交）。每次恢复链只一次强制压缩，仅在干净响应或低于硬限的读数后重新武装，压不下来的上下文不再每步重复压缩重写、击穿 provider prompt cache。Provider context-overflow 失败获得一条有界的 compact-and-retry 序列后再上浮。无法测量窗口的 route 会显式拒绝，绝不静默超限提交。已接受 Task 的自动 compaction 已退役：除 Member 自己的显式选择外，压力策略是唯一的 compaction 触发器。

Memory 不是 authority：它可能过时，不能覆盖 Workspace instructions、direct Human input 或 durable Team facts。Member 只能记录已验证且持久的知识，不得记录 credentials、sensitive data、guesses、chat logs、其他 Members' memory，或 ledger 已拥有的 facts。

## 打断栈与续作
pending-interrupt 栈是被打断工作的 durable 记忆：同一 append-only ledger 上的一对 Host operation（`team/member-interrupt-recorded`、`team/member-interrupt-resolved`），投影为每个 Member 至多 8 条 pending、按锚点去重的 LIFO 栈。条目钉住一个已 resolve 的 checkpoint ref，加上有界的 label 与 `incompleteState`；完整工作状态绝不进 ledger——它留在 Member 的 Session 日志与私有记忆里，条目只是回到它的续作指针。

回放从 operations 重建栈；不存在第二份存储。

由被钉住的 checkpoint 种下的 `context_rollover` 会在同一个序列化转换内把该条目关闭为 `resumed`——resolve 由 ledger 亲自写入，以新 Session id 为键，重试或崩溃恢复的转换回放到同一次关闭。`released` 条目在不回返的情况下关闭：由 Member 经 `context_interrupt`，或由 Human 经 Client 行菜单。

完成前分析搭载在 completion liaison 上：只要 Member 的栈非空，收尾的 episode 会获得一条私有 resume-check 通知（steer 上下文，绝不是 ledger Message）；persona 契约要求 Member 先发布完成汇报，再按新→旧逐个走栈——回到每个可回返的锚点，对 timeline 已无法证明的锚点改走 fresh handoff 并释放条目。

候选新任务须先对照其他 Members 的 active Claims；强关联的工作直接继续，否则先写入私有记忆，再由 Member 重置自己的上下文。

提示词缓存纪律是同一机制的成本侧面：checkpoint-return 的 seed 就是源日志的精确前缀——含 node-zero 系统提示词、已注入 instructions 与工具历史——因此内容未变时 Harness 的重装配不提交任何新提示词文本。转换还会携带退役代的 model selection，使 route 变量跨 handoff 保持稳定。

`fresh` rollover 同样保持注入面去重；Member 只在事实确实变化时重写 memory 索引或复述前缀已携带的内容。

## Agent notification boundary
Host 从 durable unread state 派生 Agent notifications，并通过 Agent public safe-boundary API 注入一条有界、合并后的 context message。Idle Agent 会开始一个 turn；running request 或 tool 会在下一个 step boundary 收到 context，且不会被中断。无论何时，durable Inbox 都是 authority：

- Structured direct mention 包含 Message body、sender、Channel、可选 Task overlay、Thread 和 Message ref。
- Task 或 Claim Activity 包含 actor、transition 与受影响的 Task/Thread/Claim refs。Task close 会在结束 Attention 之前为每个受影响 follower 保留 sparse Activity marker，使 terminal state change 在重启后仍可读。
- Ordinary unread Messages 只暴露无正文的 Thread-first route 与 unread count；taskful summaries 可以标出 Task overlay。任何通知都不渲染 revision 或写令牌。Agent 可以直接用 Thread ref 调用 `team_thread.read`；需要 triage 多个 Threads 时仍可使用 `team_inbox`。

Automatic context 最多包含 8 个 Inbox Threads、20 条详细 direct 或 Activity facts、每条 direct Message body 8 KiB、总计 32 KiB。省略内容仍由 `team_inbox` 与 `team_thread` 持久保存并可发现。成功的 Thread read 会同时消费相关 direct/Activity markers 和 ordinary read watermark。

Host 发布的周期性通知（continuation check，以及只有记录过已废止广播的旧 ledger 仍会携带的 context-reset Channel 公告）每次投递都重述完整现状，比同类最新一条更早的 unread 实例不携带新信息：automatic context 只完整渲染每组最新一条，被取代的旧实例折叠为一行摘要并腾出其配额，不再把重复的历史灌入被重置或被唤醒的 Agent；这些 Messages 仍完整留在 durable Inbox。

Pending hints 按 Member 合并。Consumed 或 ignored hint 不会再触发 turn，直到后续相关 durable change、resume 或 runtime-error recovery 重置 notification state。Restart/resume 使用同一 durable Inbox check，因此 transient Session queues 不是 authority。这是 at-least-once notification intent，不是 exactly-once model processing；Agent 可能忽略、失败或重复 Team read operation。

对于可恢复的临时 service errors，Host 按 Member 连续 `agent/error` occurrences 计数，而不是按 recovery wakeups 或 error text 计数：前两次 errors 各自在延迟后 wake 一次，第 3 次立即停止自动 recovery，并保留 error 交给 operator。不同 recoverable kinds 不会中断连续 error。只有 clean turn end 会清零，non-recoverable error 会取消 tracking。Recovery notice 自身会合并 continuation 与当前 durable Inbox facts，因此 ordinary Inbox notification 不会覆盖它或追加第二条提示。

Web Client 的 Agent-row menu 提供两个 runtime recovery entrances（都不写 ledger）：有 live session 的 error Member 显示「恢复」，由 Host 向 session 注入 continuation prompt；所有 unavailable 行显示「重启」，由 Host 的 `recoverMember` 依据实时状态选择修复——完成一次 durable 绑定已前移而 handle 尚未跟上的上下文转换、重跑失败的激活，孤儿 composition 则原地重建；再次失败时仍以 diagnostic 显示在 sidebar。

Agent 行菜单对 live Member 持有两个上下文动作，并对每一行提供「历史会话」与「已暂停任务」（pending 打断栈对话框）两个动作。

「重置」经 `clearMemberContext` 走持久的 rollover 机制换新 Member Session——新 Session id 带 fork lineage 指回被归档的上一份日志，私有记忆不受影响。「压缩」经 `compactMemberContext` 调度一次手动压缩：Remote 校验守卫（Member enabled、无进行中的 rollover、存在活跃 handle、没有已 pending 的压缩）并立即原样返回状态。

「历史会话」以独立审计页面占据对话席位：沿存储的 `parentSession` 谱系列出该 Member 的全部 Session 世代，由新到旧。当前世代经 live handle 读取——即使上下文转换已把 durable 绑定前移到它之前；不可读的当前绑定降级为带标记的条目，游走继续接上 ledger 记录的前驱世代，最新代际未能落盘的崩溃因此不吞掉归档历史。页面默认打开最新可读世代，全部不可读时如实说明。

所选世代自身的事件经 `memberSessions` 与 `memberSessionTranscript` 分页呈现；每条条目保留完整存储文本——传输由分页限界，绝不靠裁剪内容——并按原始 Markdown 展示：系统指令、Team relay 与 Host notice 各占一个 lane，Inbox splice 批次按 lane 展开，thread 驱动的唤醒输入因此可读。

它从不激活、恢复或写入任何 Session，因此即便 Harness 拒绝把归档会话作为 live 对话打开，归档世代仍可浏览。

重置成功后，Host 只私下提示被重置的 Member 本人：提示点明是谁触发了重置，说明 Session 已清空重来而 handle、设置与私有记忆不变、durable Team facts 不受影响，并要求它在继续工作前先凭注入的记忆与 durable Team history（`team_view`、`team_inbox`、`team_thread`）重新定位当前任务，读完仍不清楚的应在相关 Thread 回复或发私信询问队友而不是猜测；不再向任何 Channel 广播，该提示是运行时 notification intent 而非 ledger Message，投递失败只记日志。

续期只发生在「被安排新任务」的接缝，且在完成时先被「武装」：`fresh` Member 以一次以完成标记收尾的停止进入 armed，之后在下一次 Claim、Human 原子开始、或队友直接派发（mention 的 Inbox wake 携带未读 direct work）送达时换新上下文——续期排在派发之前，任务正文落在全新代际的系统上下文里；DM 是纯会话中继，不消耗 arm。Claim 完成或 Task 验收绝不触发续期——live 日志因此保留刚完成的总结，直到下一次分配才清空。

要不要保留上下文由 Host 在派发那一步判断，且只在当前 Workspace 存在指定团队负责人时才做这个判断：Host 发起一次有界模型判定，把这条派发的正文与该成员近期工作比对——最近 5 条自己发的消息，加上最近 Claim 的那个任务的内容——得分达到 60% 视为同一件工作的续作，直接投进当前会话不续期；没有负责人，或判定失败、低于阈值，都先续期再投递。判定只针对本次派发，未读积压不参与。派发方仍可声明 `keepContext`（`team_message` 的 start/reply，Human 原子开始同样可携带）跳过判断强制保留；豁免绑定那一条 ledger sequence，绝不写成 durable fact，下一次派发重新判定。`team_view` 的 Agent 行显示该成员的上下文启动策略，判定分数写进日志。

读时验收指引对 `fresh` Member 同样给出 keep 而非 roll over，理由一致；persona 约定每个 Claim 完成时先在 Task Thread 发布完成消息并附上简明总结，让成果在 durable ledger 中活过之后任何一次重置。

后台运行等待 Member 的 idle 边界后，经一个瞬态 `BasicCompactionEngine` 强制一次缩减——该引擎把 Human 选定的摘要 LLM 携带在自己的 config 里（缺省回退到 Member 当前路由的模型）。持续 busy 的 Member 只记一行日志后放弃该请求——对话优先；失败的运行经压力策略同一条 compaction 失败槽上报。压缩不提交 ledger operation；只写入它自己的 Session history。模型发起的 rollover 期间（ledger 绑定已迁移、新 Session 尚未就绪），Member 状态短暂显示为 unavailable 并带 "context rollover in progress" diagnostic；若该 Member 的 Session 正嵌入右栏，Client 只在旧→新绑定变化且当前页面正是被观察的旧 live Session 时跟随一次到新 Session，归档视图不会跳转。

## Assembled acceptance
`npm run test:browser` 使用 credential-free Harness Web scaffold 验证 public Client 与 Host chain。代表性 trace 会执行默认 taskless top-level Thread、默认关闭的 Human「作为任务」control、Human promotion 与 Host reread、taskless header/Claim gating；还要求 Human 第二次发送确认以邀请未关注的 Agent，验证 Agent durable Inbox 与 explicit read/reply，然后验证 Human Channel 和 Thread state。Desktop、390×844 和 keyboard paths 都属于 assembled acceptance。Page reload 会从 Host projections 读取同一批 facts，然后 journey 离开 Team mode 并确认 ordinary DSH conversation surface 恢复。

Browser storage 仍仅限 navigation 和 Workspace selection。Acceptance trace 不从 local storage 或 Member Session relay text 推导 unread、Attention 或 Thread facts。Agent safe-boundary wake 及三种 notification forms——direct mention、Task/Claim Activity 和无正文 ordinary route——由 `packages/agent-team/tests/member-lifecycle.spec.ts` 中真实 Agent-loop integration tests 单独覆盖；browser replay 不依赖 live provider behavior。
