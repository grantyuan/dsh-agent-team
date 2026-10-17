# Typed Remote 与 Client 边界

[English](client-and-remote.md) | 中文

## Typed Remote
Remote methods 通过 Team service 的 `@Remote` annotations 声明。`scripts/generate-typert.mjs` 使用 Harness `WorkspaceAnalyzer` 和 `FaceModelEmitter`，在 `packages/agent-team/lib/` 下生成 Host 和 Client artifacts。

稳定流程如下：

```text
Host face declaration
        │ generate:typert
        ▼
Typert Host artifact + Remote client artifact
        │ ctx.remote.$mount(...)
        ▼
Client remote service
```

`InvocationDescriptor` 是 local reflection metadata，不是 wire message。Wire request 和 response fields 保持为显式 typed values。修改 Remote 时更新 declaration 和 tests，重新生成，然后运行 typecheck/build；不要手工编辑 artifact。

## Client plugin 和 slot composition
Team browser plugin 是 external Client plugin。Shipped Shell 继续拥有 outer layout。Team 增加一个 additive footer action，并动态 shadow 三个 seats：

```text
sidebar.footer.action       additive Team entry
sidebar.workspaces          Team shadow, priority -100
main (key conversation)     Team shadow, priority -100
sidebar.settings            Team shadow, priority -100
```

Browser activation 顺序是：

```text
Client plugin apply
  → ctx.remote.$mount(agentTeamRemote)
  → ctx.inject(['remote.agentTeam'], ...)
  → register Team footer and mode shadows
```

`dsh.client.inject` 描述 client module graph；它不保证 apply order、service readiness 或 slot declaration order。如果 declaration 可能稍后出现，使用 `ctx.slots.inject()`，让 registration 跟随 declaration lifetime，并随 owning fiber disposal。

Slot parent 的 `children` declaration 同时是 render site 和 render authority。两个存活的 parent entries 不能声明同一个 child slot。特别是 Team 的 `sidebar.workspaces` shadow 不得重新声明 shipped `sidebar.workspaces.directoryFlow`；即使 Team entry priority 更高，Harness SlotCore 也会拒绝这个 duplicate。不要复制 private WorkspaceBrowser、ConversationRoot、Shell 或 private CSS 来规避它。

Team feature 需要现有 Harness capability 时，使用 public service 或 package export。对于 directory selection，先检查 `ctx.workspaces.pickDirectory()` 和 `host.pickDirectory` path，再考虑 Team-specific picker。如果 public contract 无法表达目标 composition，记录这个 limitation，选择 Team-owned plugin 或新设计，不要静默依赖 private implementation details。

## Client data 和 presentation boundary
`packages/client-agent-team/src/client/` 下的 components 不接触 `ctx`、operation ledger 或 Host classes。Data 与 callbacks 通过 Client slot contract 进入，包括 owner props、runtime props、declared store 或 inject face。Presentation layer 消费 Host projections 和本地 navigation state，不自行发明 durable facts。

UI work 的边界如下：

- Human navigation 从 Channels 开始，沿 Workspace → Channel → Thread；真实 Task 是其 Thread 上的 card/header overlay。 Channel composer 默认创建 taskless Thread，并提供默认关闭的「作为任务」控件以原子创建 Task。 taskless Thread 保留 normal read/reply/inbox behavior，但在 promotion 前隐藏 Task status、Claims 和 Task-resolution controls。 Promotion 是 durable、non-optimistic 的 Host mutation；成功后 Client 重新读取 Thread 和 supplemental projections，而不是本地合成 Task。

  Agent 的创建与编辑对话框携带 handle、description、model 和任务启动上下文块——continue/fresh 策略选择器加一个上下文窗口覆盖输入。该块与 model 走同一套 absent-clears 语义：fresh 策略与解析成功的窗口仅在设置时随请求发送，空输入读作「跟随模型路由窗口」，解析失败的输入渲染本地 alert 并禁用提交。编辑器按「对话框已提交画像与行快照中较新者」回传 `prompt`，纯展示事实编辑因此绝不会因缺省清掉段落，与 `capabilities` 同一模式。

  Prompt 对话框是该段落的唯一编辑器：每次打开都重新读取专用的 `memberPromptView` Remote——存储画像加 handle、description、state——渲染一个带实时 UTF-8 字节计数器的 textarea（镜像 Host 的 8192 字节上限），并提交一次 echo 齐全的 member update，把段落合并进读到的画像——`droppedSections` 与 `autoPrune` 得以保留，存储的 model/capabilities/context 覆盖也随行回传（缺席即清除）。非启用状态的 Member 只读渲染；创建表单的段落仅本地暂存，直到 member-added commit。

  Member 有活动 Session 时，同一份 view 还携带它装配出的 section 清单：每个 section 一行，带字节大小、滚动用量窗口内的映射工具调用数与一个保留勾选——live section 显示为勾选，取消勾选即把名字移入请求的 `droppedSections`。受保护行（persona 槽位与段落 section）以勾选禁用态渲染，残留的已失效名以未勾选可操作态渲染、重新勾选即清除（之后勾选转为禁用）。

  纯散文行带"无自动信号"标记，零调用的工具映射行带「长期未用」标记；每次切换都是本地状态，合并进同一次非乐观保存；没有活动 Session 的 Member 完全不渲染 section 清单。

  对话框同时承载 auto-prune 面：两个开关——任务启动时自动检查未用段落与自动执行（不再确认）——随同一次合并保存走 absent-clears 回传；Host 的 `pruneCandidates` 非空时渲染一个带边框的确认面板，两个动作——移除候选，或移除并同时打开两个开关——都走同一条 echo 齐全的 payload，把候选并入 drops。`usagePartial` 读取时渲染「计数可能偏少」提示。

  对话框的每次提交都会先重读存储的 drop 清单，并以本对话框打开时的读取为基准做差量合并：Human 重新勾选的名字保持恢复，新取消勾选的名字保持移除，打开后才发生的 sweep 保持移除——因此在 full-auto sweep 期间一直打开的对话框绝不会恢复 Host 已移除的段落。

  对话框还提供一次 propose-only 的 LLM 策划：Human 输入自由文本的策划要求，Host 沿成员的有效路由、经由与 compaction summarizer 相同的进程内完成接缝，基于成员的实时装配、私有技能目录、身份与这些要求构造一次有界调用——可取消，硬性限时六十秒，结果在提案旁以 `modelUsed` 给出确切路由。

  解析出的提案——建议移除的段落名、现有目录子集内的技能白名单、自定义角色段落草稿——只回填表单：Human 审阅、编辑后经同一次合并保存提交，失败的调用在对话框内渲染错误，绝不阻塞手动编辑。创建表单不提供策划入口，因为其输入需要暂存表单不具备的实时成员范围。策划输入在设计上可被注入——段落文本与策划要求按原文进入提示词，只做截断不做清洗——因此防护在于 propose-only 解析、对同一实时快照的重新校验，以及每次提交本就要求的人工审阅。

  Thread 页把同样的 propose-only 形态放宽到另一类调用：`summarizeThread` 经 ledger 读取有界的 Thread history，经由同一 `ctx.llm.stream` 接缝、按团队自身配置的路由构造一次调用——可取消，硬性限时六十秒，结果报告 `modelUsed` 与所读取的 revision——返回通俗速览：一段 summary、若干 keyPoints，以及当 Thread 在等 Human 时，Host 判定出的 decisionQuestion 与 Messages 里真实出现过的 options。

  该路由是纯读取侧的团队偏好，绝不写任何 Member fact：本 Workspace 内已启用的指定 leader 的钉选模型优先（leader 未钉选即等于持有 Host 默认，就按 Host 默认跑）；没有指定 leader 时，取第一个钉选了模型的启用成员来解释；全员都没钉选才落回 Host 默认路由。这个请求按构造与装配隔离：接缝只收到速览指令与有界 transcript，不带 tools、skills、MCP、memory 或成员身份。

  速览本身不提交任何内容，也不维护并行 authority：读者的答复——无论选一个 option 还是写自己的意见——都走普通的 durable `reply` 路径落地为 Message；调用失败把面板降级为重试，绝不影响 timeline。

  速览是留在浏览器里的呈现记忆，不是 Team fact：`localStorage` 按 Thread revision 每条存一份，刷新后同一 Thread 状态直接由存储作答、不再付第二次模型调用，只有 revision 真的前进了才强制重读；「重新生成」清掉该 Thread 的存储条目再问一次。

  Human Client 消费 Host 的 Inbox 投影（「收件箱 / Inbox」队列：合并各 Workspace 的徽标与页，覆盖读者的整片未读——mention 只在其中计数，绝不是准入条件——外加该读者写过 Message 的「最近活跃」段（回复过的 Thread 无论是否 follow 都算他的；按最新活跃降序，Host 侧每个 Workspace 上限 10，合并到页面上最多 5 条，永不进入 agent 的 Inbox）），但绝不维护并行 Inbox authority；打开页不确认任何内容。 Thread reads 使用 Host projections（`readThread`、`threadHistory`）和 Host mutations（replies、promotion、Task actions）。 当前 Thread UI 不提供 Attention controls 或 observations；其 Host Remote methods 留给后续自有 UI。 Browser 会持久化 Team navigation mode、Workspace selection、最近选中的 Channel 或 Thread 以及 Inbox 页位置（回到 Team 时恢复位置），但不持久化 unread 或 Attention。

  每条 Inbox row 自带 Host 解析好的时间戳——`createdOccurredAt`、`latestReplyOccurredAt` 与其 `latestReplyActor`、以及 `needsHumanDecision`（某个 open Task 停在 `in_review` 等验收，或一条点名 Human 的 Message 在向其要决定且其后 Human 再无发言——单纯点名从不点亮它）——行因此不需自己再做 Thread read；页头的 排序 控件按本浏览器偏好重排这些行，这份偏好存 `localStorage`，从不成为 Team fact。

  Agent Inbox 仍由 Host 持有，并通过 `team_inbox` 提供。
- Sidebar row order（Channels/Agents）是每个 browser 的 Human presentation preference，保存在 `localStorage`，加载时折叠到 Remote default order 上（保留的 refs 保持顺序，移除的 refs 丢弃，新的 refs 追加）；它从不成为 ledger fact。Whole-row native drag 复用 Harness list interaction model，并且是 Team-owned rows 唯一的重排控件。
- 嵌入的 Team Member Session 使用未修改的 shipped composer：Team 不注册任何成员会话的 composer 表面——不接管 seat、无 trigger sources、无 dock 提示条。rc.1 把 trigger-menu overlay 移进了 `conversation.composer.bar` 的 children（接管者会一并继承渲染义务并使 overlay 悬空），且 Team 自有的命令/成员引用入口相对 shipped 词汇表不再有不可替代的价值，因此一并移除。普通会话与成员会话共享同一 composer 与词汇表。
- 有对应能力时复用 public Harness primitives 和 `--dsw-*` theme tokens。
- CSS 保持在 CSS Modules 中；不要 import private Harness CSS。
- Runtime presence 必须与 Claim 和 Task state 分离。
- Task resolution controls 会修改 Task 和 Claim。Closed Task 对 replies 和 new Attention 是 terminal；reopen 会恢复 open Task，但不会恢复此前的 Attention。
- Message、Activity、Claim 和 Task 的 presentation 要保持区分且用户可读；不要暴露 opaque refs 或 internal enums。
- Durable mutations 不做 optimistic update；失败时保留 input，并渲染下一份 Host projection。
- 保持 Team mode enter/leave、refresh recovery、slot restoration 和 narrow layout behavior。

UI redesign 已完成。需要理解当时的取舍时，查 [`.scratch/archive/2026-08/ui-redesign/`](../../.scratch/archive/2026-08/ui-redesign/)；它是历史设计背景，不是当前实现权威。UI 改动的当前验收规则见 [`development/README.zh.md`](../development/README.zh.md)。
