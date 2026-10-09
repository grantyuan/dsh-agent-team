# Tools and preset

[English](tools-and-preset.md) | 中文

显式的 `team-member` preset 是唯一的 Team Member composition。它加入完整 coding capability rows（shell、filesystem/search、web search 与 fetch、background jobs、skill 加载工具、todo、compaction）；skill 发现本身不是 preset row——每个 Member 的 provider 由 Host 注册在其 agent scope 上（见 Host authority）、Team collaboration guidance/tools、Harness Workspace instruction discovery 和有界的 private-memory reference context。普通 Sessions 留在这个 isolated roster 之外，不会获得 Team prompt sections、tools 或 Member memory。

每个 Member 还可携带一段 custom role paragraph：ledger 画像的 `customPrompt`，由 Host 限制在 8192 个 UTF-8 字节内、空白归一化为缺省（见 Host authority）。激活时它作为一个 scoped `systemPrompt.section`（`team:member-prompt`，排在既有 sections 之后）注册在 Member 自己的 agent scope 上，因此保持成员隔离，普通 Sessions 永远看不到它。编辑在与 tool、skill 编辑相同的 turn boundary 换装该 section，不续期 Session；段落清空或离开 Team 时解除注册。Human 通过 Web Client 的 Prompt 对话框经 `memberPromptView` Remote 编辑它（见 client-and-remote）。

Section 也可以按 Member 移除。ledger 画像的 `droppedSections` 记录 Human 从该 Member 下一次 assembly 中移除的 section 名；`member-runtime.ts` 为每个 Member 注册一个 scoped `system-prompt/assemble` waterfall listener，把这些名字从 `assembly.sections` 中过滤掉，在与段落相同的 turn boundary 换装这份清单，并在每次激活时重新施加存储的清单，因此 drop 状态跨重启保留。

listener 以 assembly 的 turn signal 为门：agent loop 是唯一带着 signal 装配的调用方，因此 `memberPromptView` 这类无 signal 的 read-side 装配仍看到完整清单——被 drop 的 section 在对话框中保持可见、可恢复，而不会伪装成 stale。

protected 集合在 `member-runtime.ts` 一处定义（`isProtectedPromptSection`）：段落 section 自身、deployment persona 槽位、以及 Team tools 的 `tool:<name>` guidance sections——对受保护名字的 drop 请求在消费端拒绝，对话框将该行渲染为带受保护标记的不可操作状态。九个 Team tools 目前把 guidance 放在 tool description 而非注册的 prompt section 里，所以 `tool:*` 条目今天是前瞻防御：没有任何 live section 携带这些名字，它们不会渲染为对话框的 live 或 stale 行。没有任何 live section 提供的名字照常存储但不起作用——对话框标记为已失效。

`sectionToolMapping` 是对话框「无自动信号」标记背后的共享 primitive：它扫描每个 section 的文本，对 Member scope 工具 schema 名做整词匹配，不匹配任何当前工具名的 section 即为纯散文。

同一份 mapping 还为每个 section 计价用量。`memberPromptView` 把 Member 的候选窗口——最近 20 个已完成回合或 14 天，回溯遍历先到者先关（`member-section-usage.ts`，窗口边界的唯一定义点）——折叠在 Member 跨 rollover 世代自己的 session 日志上，一个 section 的用量即其映射工具在该窗口内的调用数之和。每个世代只贡献自己的事件（fork 继承前缀不计入），归档不可读或血统深过遍历上限时折叠降级为 view 上的 `partial` 标记；计数在读取时计算，从不持久化。

Auto-prune 就骑在这份投影上。画像的 `autoPrune` 开关（默认关）让 Host 在与 fresh-start 策略相同的 Human atomic-start 边界扫描候选——有工具映射、不受保护、仍被保留且窗口内零调用的 section——走同样的 turn-boundary 等待与串行 lifecycle queue。ask 模式（默认，且 partial 折叠下的每次 sweep 一律如此）只发一条点名候选的 `@human` 收件箱通知，把移除留给 Prompt 对话框的 durable member update。

`autoExecutePrune` 升级让 sweep 以 Human actor、同样的 echo 齐全形状自行提交移除，在边界落定后 live 生效，并且仍然发通知——每次自动移除都留在台账里且被广播。纯散文与受保护 section 永远不会成为候选。

九个 model-facing tools 定义在 `packages/tool-agent-team/src/`：六个 Team 工具在 `index.ts`，三个 context 工具在 `context-tools.ts`；实现的 collaboration contract 记录在 [`tools.zh.md`](../team-collaboration/tools.zh.md)。它们挂载在隔离开的 `team-member` preset 下（`cordis.patch.yml` 里的一条 declarative row）。不要为了让测试可用就把 tool package 作为 global row 添加；普通 Sessions 必须保持 Team-free。

Member 上下文自主管理在这些 preset 之上由 Host 编排。`context_rollover` 与 `context_checkpoint` 工具只做校验并结束/锚定 turn：在 tool 时，引擎的门先拒绝 Member 自己的 timeline 未列为 restorable 的 `checkpointRef`，通过这道门的 ref 仍由 Host 的 seed resolver（与换窗同一套）预校验，因此当下不可能成功的 ref 以 model-visible 的 error result 拒绝，而不是返回假 `scheduled`；可变 guard 集（jobs、route limits）在 commit seam 复查。

三个 context 工具里有两个用的是引擎自己的定义：`context-tools.ts` 通过引擎的 `createContinuityTools` 构造 `context_rollover` 与 `context_checkpoint`，只提供 Team 词汇与 host adapter，不再自带文案与校验。`context_timeline` 仍是 Team 自己的实现——它的渲染对不可返回的行绝不打印可引用的 ref。

单一 context-continuity coordinator（`ContextContinuityCoordinator`，来自 `@wowyuarm/dsh-context-continuity`）由 `context-continuity-host.ts` 绑定到 Member lifecycle，后者还用 Team 的 plugin id 与冻结的 handoff 文案构造引擎的 message codec。它监听各 Member Session 的事件，从 durable 的 `tool/call`+`tool/result` 对折出 rollover 与 checkpoint 意图，再经串行 lifecycle queue 执行换窗。

该折叠即引擎自身的 `contextContinuity` projection unit，在 Team service init 时按 host 注册一次。`context-projection.ts` 只提供 Team 的那一半：

- 解析 `context-checkpoint-*`/`team-boundary-*` ref、把 boundary 归类为 `team-boundary`/`handoff`/`compaction`、把 claim boundary 归因到 ledger 上的 Thread、识别 Team notice 的 host hooks；
- 读取引擎状态的适配层。

unit 自带 fork cut，seed 子代的继承前缀折叠回同一引用。换窗随后按序执行：

1. 等真正 idle；
2. 在 commit seam 复查 owned-jobs guard；
3. retire 旧代（dispose + 归档、绝不删除）；
4. 提交幂等的 `team/member-session-rolled-over` operation；
5. 激活全新 Session——checkpoint 回返则以精确 completed-turn 前缀作 seed 的 Session，lineage parent 指向 seed 来源；
6. 以 steer 送达 handoff、以 followup 投递携带的非 Team 输入。

意图在折叠层为每条未结束 turn 唯一：同一未结束 turn 内的第二次成功 rollover 调用保持 first-wins，而所属 turn 已结束的 pending 正是 ready（重启后为 recoverable）的意图——正常 in-flight 路径上 coordinator 的进程锁会拒绝后续调用。只有该锁消失后（transition 失败或从未运行），后续 turn 的成功 rollover 才会替换已结束的 intent——这就是 seam 失败后恢复 Member 的 retry 路径。admission gate（`agent/turn-stopping` + `agent/pre-step`）只对旧代 Agent instance 生效，使后续输入无法再开启旧代 model request。quiet checkpoint continuation 恰好投递一次（进程内 per-member latch，跨重启由 projection 的 durable delivery record 判重）。

恢复由日志派生：重启重放 pending 意图并完成换窗；落在 rollover 的 durable commit 与新 Session 激活之间的重启，会从 ledger 记录的上一 Session 重建 handoff——即使新 Session 在崩溃前从未落盘——且重建幂等（自身日志已含 handoff 的一代不再收到第二条）。重启后的 carried-input 重放是有界的：当前代一旦已开始自身 turn 即跳过重放（其携带输入已在运行中被投递或取代）；上一代 Session 不可读时，属日志损坏类（`corrupt session log`，Host 会修复 torn tail）或确定性格式拒绝类（`SessionFormatUnsupportedError`，重试无法改变结果）的以 warn 放行，缺失/IO 及未知原因仍 fail-closed——当前代一旦运行过，其激活不再受退役代可读性阻塞。Member Session 是否有 durable 持久内容，通过 session-persistence inspection 判定（会等待进行中的 retirement drain），绝不使用会与 suspend 终末 flush 竞争的裸元数据列表。

上下文压力是第二个 Host 持有的 coordinator（`pressure-policy.ts`），挂在同一 pre-step 接缝上：预算阈值从当前 route 的 context window 派生（handoff 200K / 硬上限 256K cap 加安全 reserve）；handoff 预算处每 generation 一条结构化通知建议 rollover（一次后重新武装）；硬上限处强制原地 compaction，无法证明进展即 fail closed；provider context-overflow 失败获得一条有界 compact-and-retry 序列。原地硬 compaction 绝不取消 owner，因此豁免于拒绝持有 running 或未上报 terminal jobs 的 rollover job guard。

Web Client 是唯一的 Human control surface。它通过 typed Remote 把每个 mutation 委托给 `ctx.agentTeam`，不绕过 Host authorization 或 ledger commits。不要重新加入 slash-command adapter 作为第二界面。

修改 schema、canonical output、presentation 或 preset 时，编辑前先阅读匹配的 Harness docs：

- `../deepseek-harness/docs/subsystems/tools.md`
- `../deepseek-harness/docs/cookbook/adding-a-tool.md`
- `../deepseek-harness/docs/subsystems/permission-presets.md`
