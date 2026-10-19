# Host authority

[English](host-authority.md) | 中文

Team 是每个 DSH home 内唯一的协作域。append-only operation ledger 是 Member、Workspace、Channel、Message、独立 Thread aggregate、可选 Task overlay、Claim、Thread Attention、Inbox、Member pending 打断栈和 Activity facts 的 durable authority。

修改 Host capability 时，先阅读 package source/tests，再阅读匹配的 Harness capability contract。导航表见 [`harness-navigation.zh.md`](../harness-navigation.zh.md)，其中将 Host 改动映射到 `deepseek-harness/docs/subsystems/` 和 source packages。

## Ledger 权威与提交
- mutation 进入 Host authority，并提交一条 durable operation。
- Projections、Inbox results、tools、commands、Remote responses 和 UI 都从已提交的 operations 派生。
- Client code 不得解释 ledger records，也不得创建 parallel authority。
- 每份 ledger 文件只有一个写入者，由 Team 层强制（`ledger-fence.ts`）：sequence 号来自 Host 进程内的 replay 计数，而 Harness storage domain 明确声明跨进程写协调不在其职责内——两个活跃 ledger 共享一个介质就会交错写入、分叉 operation chain，且要到下一次 replay 校验才 fail-closed 检出。
- 若 Host 的 composition config 给出了共享 SQLite ledger 目录（`ledgerDirectory`，随 SQLite 路由一起 ship 在 Host 行上），挂载时就在该目录抢占一把锁（后 claim 者胜，合法 remount 永远不会被它正要替换的旧实例挡住）；此前每个持有者——同进程的 patch-reload 残留实例或其他 Host 进程——会在下一次 ledger 调用时失败、自行闭锁为 superseded，并从此不再提交。从未被告知该目录的 Host（memory 后端的测试 harness）不加围栏，也不碰 DSH home 里的任何东西；围栏只把双写窗口收窄到一次在途 commit，不能替代 Harness 并不提供的 storage 层 compare-and-swap。

## Lifecycle 与通知
- Agent lifecycle、JSON/SQLite replay、authorization、idempotency 和 revision checks 都留在 Host 侧。durable unread 变化可以通过 public Agent safe-boundary API 产生一条有界、合并后的 Agent context notification：direct mentions 携带其 Message 和 source，Task/Claim Activities 携带简要状态变化，ordinary unread 只携带不含正文的 Thread-first route（若存在则带 Task overlay）。Promotion 与其他 Task transition 一样是 Task activity，通过 Activity markers 到达 followers。这类 notification 不是第二权威，也不保证模型恰好处理一次。
- Member supervision（`supervisor.ts`）是 `recovery.ts` 之后的自动兜底。每十分钟一趟 tick——只在 startup 的 Member restore 落定后才挂上定时器，冷 Session 不会被误读为停止——观察对象是所有 enabled Members。一趟 tick 先推进 Host 手上未结束的强制链（重试那次没有落地的重置，随后交接给重置也没治好的 Member），再执行拉起 pass，因此已开启的强制链不会卡住、退化成无休止的「继续」提示。
- Agent 活着且 turn 仍可能推进时读作 settling（活着但闲置且持有未竟 Claim 是按设计等待，不被打扰）；不处于 active、携带 error presence、或已运行但超过三十分钟没有任何 durable session event 时读作 stopped。尚未被强制链接管的 stopped Member 每个 pass 拉起一次、至多三次；已被强制链接管的 Member 留给该链，因为 nudge 只会让它一直跑过那一步等待的 turn boundary。
- Supervision 不对失败做任何分类：开启强制链的只有纯故障计数——三次 `agent/error` 之间没有任何干净回合结束，或二十分钟滚动窗口内出现三次失败。装不进路由的上下文只是又一轮失败的 turn：provider 的拒绝照样上浮、计数照样累加，强制链随之推进，不存在任何上下文专属的快车道。
- 强制链的第一步是 Host 亲自重置该 Member 的上下文——与 Human 菜单相同的 fresh-context 重置，只私下提示被重置的 Member 本人，不进任何 Channel。归档与换代交接（下述）是最后手段，只在后续 tick 仍读出异常时才推进。任一时刻重新读作 healthy 都会结束强制链，被治好的 Member 重新武装温和的 bring-up。
- 每一轮完成的模型请求都要通过返回结果检查：一轮在结束时既没有工具调用也没有可见文本——或文本没有以「任务结束」完成标记收尾（标记之后跟随的标点或装饰字符仍被宽容接受）——即视为一轮故障，Host 会投递一条 `continue` 提示让 Member 继续执行：仍在进行中的轮次用 steer 插入，否则开启下一轮。连续三次提示后熔断，任何健康的一轮（出现工具调用或以标记收尾）都会重置 episode；该提示在 context projection 中始终按纯提醒处理。
- guard 同时管辖停止边界：turn 以 `completed` 结束而末轮呈故障形态时——即使环内提示预算已经熔断——Host 会按 per-Member 冷却在停止边界补发一次停止提醒，并为该提醒开启的新一轮重新武装提示预算。被中断的轮次、用户中止与 error 停止是人为或 Host 事件而非模型故障——停止 lane 保持安静，等下一轮。
- activation 会对持久化 Member 的 Session 日志做尾部扫描：近期一次未被提醒过的故障停止（六小时窗口内、且 Inbox 无待投递的 direct 工作）会补上停止提醒，而不是让中途停下的 Member 静默闲置。
- 替换在一个串行化的 lifecycle step 内以普通 Host 生命周期完成：失败 Member 走同一条 `archiveMember`（其 Claims 照常以公开 `claims_released` Activities 释放），同角色的下一代以 Human 权限入队——handle 取该角色下一个空闲的 `-N` 代际，可变角色事实照搬，私有记忆（`memory.md` 与 `notes/`，`skills/` 有意不继承）在替补首次 activation 之前拷贝完成，前任的 Channel 参与关系逐一补授。
- 替补逐字继承前任的配置——同一 `presetId`、`description`、`model`、`capabilities`、prompt 画像、`contextStartPolicy`、`contextWindow` 与 `leader` 标记——因此其生效设置与被它接替的 Member 一致，而不会静默重置为默认值；同时记录一条 succession edge（`predecessorMemberId`）指向该前任，这条 edge 把继任者的 Session lineage 扩展到前任的历史（读取逻辑见 Workspace, Session, and storage reuse）。
- continuation watcher（`continuation-watcher.ts`）负责监督的反面：每个 Agent 都健康且正常停止，但仍有 Agent 还能推进的任务。每分钟一趟 pass——与监督共用同一个 restore gate——当所有 enabled Member 都读作 `available` 且存在这类任务时开始一段 quiet hold；任何 ledger 提交都会重启该 hold（Human 阅读也算），Agent 重新工作、任务格局变化、或一条提醒无人理会超过十分钟，都会重新武装。安静满两分钟后，Host 以 Human 管理员的口吻向该 Workspace 被指定 leader（`member.leader`）的 open work 最繁忙 Channel 发一条提醒，列出 open Tasks；`@` 提及经普通 Inbox 路径唤醒 leader。没有 enabled 指定 leader 的 Workspace 每 episode 只记一次日志而不提醒；投递失败记日志并在后续 pass 重试。计数器与监督同为进程内。
- 完成联络员（`completion-liaison.ts`）负责 watcher 之后的 per-Member 时刻：Member 以「任务结束」标记停止且短暂宽限后仍静止时，Host 检查它完成后是否向指定负责人发过汇报（提及负责人的渠道消息或 DM，从完成位置向账本尾部扫描）；没有则以 Human 口吻在负责人自己的渠道发一条 report-check 提醒唤醒负责人。
- 若该 Workspace 没有指定 enabled 负责人，联络员改为把未完成任务直接推送给该 Member，由其自主决策——推送正文声明拒绝的唯一契约：最终回复以「拒绝继续」开头。被捕获的拒绝使本进程内不再向其推送任务，并把其原话（截断）在该渠道转告 `@human`；决定继续则不播报。episode、决策、拒绝与冷却闩同为进程内，而每条提醒都是普通 ledger Message。
- 指定负责人本人的标记完成不触发任何强行唤醒：既不自我推送任务，也不做自我检查——负责人对 Human 汇报是职责所在；负责人只有直接发生故障时才被唤起，且走 guard 与 supervision 的故障路径，绝不走联络员。
- activation 尾部扫描也会补开 episode：Member 的标记收尾停止若发生在 Host 离线期间（同样以六小时窗口计为近期，且没有已在处理它的待投递 direct 工作），恢复后的第一趟 pass 仍会补上这次 report check——部署重启不会让静止未汇报的 Member 悄悄脱离策略。宽限从停止时刻计，TTL 从联络员知晓时刻计。
- 输出截断升级（`truncation-escalation.ts`）负责 provider 强制的停止形态：turn 以每请求输出 token 上限（`max-tokens` 停止原因）截尾时，Member 的回答被截断但保留在其 Session 里；guard 的环内提示很可能为重跑同一条超长回答烧尽——此后 Member 就保持停止，正是 Web 端提示 Human「发送继续」的那种局面。此时 Host 不代替团队决策：对 Member 所在的每个 Workspace，以 Human 口吻在其指定负责人（`member.leader`，须为 Member 之外）的渠道发一条升级提醒，经普通 Inbox 路径唤醒负责人裁决——让该 Member 分块续作（写入文件、分段发布，避免再次触顶）、把未竟工作改派他人，或留其停止等待 Human。
- 升级按 (Member, Workspace) 十分钟闩一次：窗口内的再次截断是同一个未决局面，不再重复提醒；以「任务结束」标记收尾的干净停止结束 episode，下一次截断重新升级；没有合格负责人的 Member 每 episode 只记一次日志。闩为进程内，每条提醒都是普通 ledger Message；有意地，activation 尾部扫描不补发跨重启的截断升级——被截断的 Session 恢复后保持安静，直到该 Member 再次运转。
- watcher 的 open 集合止于 `in_review`：Claims 全部完成的任务在等 Human 验收，这不是要提醒已停止 Agent 的工作，因此只剩这类任务的 Workspace 永不触发——Human 任务列表仍将其显示为进行中。
- 随后替补以 Human 管理员口吻向受影响的业务 Channel 发一条结构化退役公示：一块带标题的正文，列明退役原因、该 Member 服役期间已完成的工作、可选的 best-effort Final Session recap，以及本次释放后重新无人认领的工作。Workspace 有指定 leader 时公示只投给该 leader 一人；只有在没有可及 leader 时才回退为在其继承的每个 Channel 广播，并以 `@human` 的请求触达每个存活的同侪 Member。
- 交接的一切 durable 结果都是 ledger operation，因此交接中途崩溃只会按正常台账重放，绝不会留下半真半假的 Team 事实；计数器与观察名单为进程内，重启即重新挣回预算，与压力策略同构。

## 变更流与 Projection
- `changes()` 是流式 Remote，可声明一个 scope（workspace/channel/thread/presence）；省略 scope 时观察共享 Team 投影变化，不包含 presence。Host 先注册监听，再发送当前基线，之后只发送匹配的变更通知；消费者暂停期间仅保留最新待发送版本。取消或 Host 释放时关闭订阅。Thread read 与 `team/dm-sent` 不改变共享投影，因此既不推进其版本也不唤醒订阅者。Presence 使用进程内 epoch，其余 scope 使用最近一次共享投影提交的 ledger sequence。版本只在同一 scope 和 Host 生命周期内有意义。Host 只为受 operation 影响的 Members 重算 Inbox hints。
- `TeamChangeStream` 在每个页面内通过 `ctx.remote.$stream()` 按 scope 共享一个逻辑流；Harness 管理共享的 `/api/remote.mux` WebSocket 和连接恢复。每次开场基线都会触发重新读取 Host，包括重连后的相同或更低版本，以补上首次读取与订阅之间的变化，并在没有新提交时恢复失败的读取。最后一个 listener 离开时释放该 scope，插件释放时关闭所有 scope。传输失败在恢复前只报告一次；终止性错误直接报告，不使用 Team 自有重试循环。没有长轮询回退、跨页面主从选举或单活跃页面限制。并发的补充读取合并通知；读取期间再收到通知时保留后续一轮读取，不用旧版本过滤重连基线。Human Inbox 徽标订阅无 scope 通知，经 debounce 重拉 Inbox 合计，并在本页 Thread read 后刷新。Presence 订阅更新 Member 可用状态，不唤醒 Inbox。通知只是重新读取的提示，不是第二份事实存储。
- Host 对 Member Session 的 projection 改为增量折叠。 context intent 与 clock baseline 都派生自同一个 Session 自身的 events，两者都经 Session event cursor 读取：cursor 把折叠出的值与其已消费的日志位置放在一起——`context-projection.ts` 提供折叠，`session-event-cursor.ts` 提供位置——因此一个日志第一次被读取时折一次，之后每次只折其后追加的 events。 cursor 假定该日志只 append，并只校验能校验的部分：它记住自己停在哪个事件的 sequence 与 type，所以 fork 前缀变动、日志变短、或该事件被替换时一律从头重折，fork / resume / rollover 最坏只退回一次冷折，而不会给出错画面。 模块里点名记下一条残留而不是掩盖它：同一 sequence、同一 type 但内容被就地替换的事件对该守卫不可见；这只有违反 append-only 契约才可达，而内容敏感的锚点也关不掉它，因为只有锚点位置被重读，更早的已折位置被换掉会同样放行。

  读取完整被检视日志或外来日志的冷路径——activation、transition、timeline、carried-input 重放——仍全量折叠。 两者各自按 Member 保存一个 cursor，并在该 Member 的 Session 变化时替换，因此保留的折叠状态以 roster 为界，而不随 Member 经历过的代数增长。

## Session 持久化与重放
- Bundle 目标为 DSH `0.2.1-alpha.2`。 其 Session persistence 使用当前 DSH schema：随附的 JSONL backend 会自行迁移已发布的旧格式（v0/v1/v2 → V3 → V4），旧格式数据无需手动处置。 这个 DSH Session-schema 策略不会抹掉 Team operation history：Team 有意保留针对旧版、Message-level `occurredAt` 之前 records 的窄 replay normalization。 普通存储的 Message operations 在加载时使用包裹 operation 的 instant；旧 `team/thread-read` snapshot anchors 与 Message facts 从来源 Message operation 解析 instant，只有必要时才回退到 read operation——而 snapshot 正是唯一仍会走到这条 normalization 的记录形态：它把 Message anchors 与 Thread facts 连同消费掉的 Inbox delta 一起冻结在记录里。

  当前每次读写入的 receipt 只存进度与 Inbox delta，是唯一不存任何 instant 的 Thread-read 形态；旧记录就地 normalize 并校验，绝不改写。 不要增加 Team 自有的 Session migration、宽泛 compatibility reads 或 fallback storage paths；可选的 `member.model` inheritance 与可选 Message attachments 都是当前语义，不是 legacy fields。

## Attention 与 Inbox 权威
- Thread Attention 是 private Member x Thread state。ordinary unread 来自当前 Attention；structured mentions 创建 direct markers；terminal Task changes 在 Attention 结束后仍可能保留稀疏 Activity markers。Host 是唯一 Inbox authority。Session history 可以保留有界 notification context（包括 direct Message bodies 和 Task/Claim transition summaries），但不能形成 parallel unread projection。
- 逐提交的唤醒是点对点的：只有当操作点名了该 Member（新增 Direct marker——mention 或 DM、新增属于其 Task 的 Activity marker、或它自己的动作）才唤起其模型。无人点名的 Thread 围观更新只在 projection 里累计未读数，随下一次被点名投递以无正文摘要同行——共享 Thread 的流量不为每个 follower 花费一个回合。restore/resume/故障恢复时的提示重建是另一条路径，仍读取全部 durable 未读。

## Session 策略与上下文压力
- Team 管理的 Agent sessions 使用显式 Team preset 和可信的 `danger-full-access` policy，这是面向可信 Workspace 的有意产品边界。
- Host 激活 Member 时，会通过 session-title service 用其 handle 命名没有标题的 Member session，使普通 Session list 显示 Member identity。显式 rename 或任何已有 title 始终优先，命名失败不会导致 activation 失败。
- 已接受 Task 的自动 compaction 已退役，且 Host 不再盯上下文大小：压力 coordinator 只剩 provider 溢出自救一条车道（见 Tools and preset）——对 provider 因上下文装不下而拒绝的请求，每次开放故障链给一条有界 compact-and-retry，只有成功请求才重新武装；被路由 proxy 接管压缩的车道从不尝试。Member 按需读到的一切——验收建议、`context_timeline` 工具、checkpoint 回返守卫——都按当前 route 定价，绝不参与请求决策。Pending/error bookkeeping 只在进程内维护；只有进入 transaction 的 compactions 才会写入 durable Session history，绝不写入 Team ledger。
- Supervision 的进度判定只有纯故障计数（见 Lifecycle 与通知）：连续 3 次 `agent/error` 且中间没有任何干净回合，即开启强制链的 fresh-context 重置——identity、固定设置与 private memory 完好——没有任何上下文专属的分类或快车道。

## 私有记忆、归档与身份效应
- `$DSH_HOME/agent-team/members/` 下的 private-memory directories 是 Member identity 的 Host-owned effects，不是第二权威。Member activation 确保 private-memory directory、`notes/` 和缺失的 `memory.md` 存在；startup 不会清理 ledger 不知道的 `member:` directories。显式 Member removal 会归档其 Session 并移除该 Member 的 private-memory directory；Team removal path 之外的 entries 保持不动。这项删除与 activation 时对旧式 colon 目录的改名都限定在当前进程自己的 members root 之内——记录里的 `privateMemoryPath` 是一条 durable 绝对事实，指向「当初添加该 Member 的那个 DSH home」里的目录；因此解析到另一个 home 的进程会拒绝搬移或删除它（并告警），而不是把 Member 的真实私有记忆搬出它自己的 home。
- Member 与 Channel 的归档是介于 suspend 与 remove 之间的可逆第三态。 `archiveMember` 提交 `team/member-archived`，dispose live session（私有 memory 与 Session log 留在磁盘）、把 Session 从分组 surface 归档，并以公开 `claims_released` Activity 加上 Attention/marker 清理释放该 Member 的 active Claims——被隐藏的 Member 不得让 Task 卡在 in progress 或留下幻影 unread 计数。 `archiveChannel` 提交 `team/channel-archived`，对 Channel 上所有 Thread 的 owner 施加同样的释放形态；两种归档形态下 Membership 都保留（隐藏态，非退出）。

  Archived 实体从所有 Team API surface 消失——projection（view channels/threads/tasks/members、mention 候选、Channel join、编辑）、ref 解析（`resolveTaskRefs`/`resolveThreadRefs` 跳过它们，使 message 正文渲染为纯文本）、以及 ref-addressed read（`readThread`/`threadHistory`/`threadObservations`/`listClaims` 以明确的 archived 错误拒绝，绝不伪装成 unknown-ref）——而事实完整保留在 ledger 中供重放与未来恢复；这条边界就是 archival 与 remove 的分界。 从 archived 状态 Remove 仍可作为数据清理路径，且本轮刻意不提供 restore 入口（与 dsh 的 archived session 对齐）。 Channel 归档之前写入的 ledger 省略 `channel.state`；记录 schema 在 load 时把它归一化为 `active`。

## Member capabilities 与 skills
- Member capabilities（Member 实体上的 `capabilities` 字段：预留的 `tools.allow` 与 `skills.allow`）是随全部 lifecycle operation 原样流转的 durable intent。commit 时不做已知名白名单校验，保证 Harness 升级后旧 ledger 仍可重放；与已知名的偏差在 activation 时派生为不持久化的 `capabilityWarnings`。`tools.allow` 是有意的接口预留（无 UI 写入路径），供后续 Runtime Revision manifest 编排依赖，cleanup 时勿删。编辑语义与 `model` 一致（absent 即清除）；不管理 capabilities 的调用方必须回传已存储的值。`leader` 标记是唯一的 keeps-prior 字段：absent 保留现有指定，因此总是回显该值的编辑器保持幂等。
- Activation 把 `tools.allow` 作为 scoped restriction 应用在已组合的 preset 面上，顺序为 mount → restrict → validate（validate 观察限制后的可见面），并在配置之上强制并集十个 Team tools。未知名 drop + warning，不阻断 activation；restriction 失败只表现为该 Member 的 activation failure。
- 对 live Member 编辑 allow-list 或 prompt 画像：durable 编辑在 commit 处立即应答，live 换装在同一 Session 的 turn 边界完成——idle 在编辑自身的队列 body 内生效；running 则交给后台 scheduled apply（与 fresh-start reset／auto-prune sweep 同形），故响应与串行 lifecycle 队列都不被一次轮次（乃至卡死的 Member）拖住。被任何 dispose 移除的 handle（包括队列从未看见的那次）直接跳过换装，存量事实于下次 activation 落地；换装失败只记日志、不上抛。
- Skills 是 Member 私有的。 preset 不带共享 skill-filesystem row；Host 在每个 Member 的 agent exact scope layer 上（traceable-service 接缝，与 tool restriction 同构）注册一个 filesystem provider，只扫两个 Team 自有 root（排除默认 roots）：插件内置的只读 core skills（`packages/agent-team/core-skills/`，排前——同名内置 skill 跨升级保持稳定）和 Member 可写的 `$DSH_HOME/agent-team/members/<memberId>/skills/`。

  Member catalog 因此以内置集起始（`member-skill-manager` meta skill——全部 skill 写作/安装/credentials 引导都在它里面，persona 只陈述私有空间物理事实）；安装就是往自己目录写（目录形态 `skills/<name>/SKILL.md` + 可选 references/scripts，或平铺 `.md`），有意不提供上传 Remote，filesystem watcher 驱动发现。

  `skills.allow` 通过 live selection ref 过滤 `list()` 输出（编辑与 tool 编辑同一 turn 边界换过滤并失效 catalog）；过滤是可见性语义不是安全边界——两个 root 始终被扫描和 watch。 Member remove 连同私有目录一起删除；suspend/resume 与 Host restart 恢复相同 catalog。

## Member 上下文控制
- Member 在 `model` 与 `capabilities` 之外携带三个可选覆盖字段：`contextStartPolicy`（`continue` | `fresh`）、`contextWindow`（不小于 8192 的整数），以及 `prompt` 画像（`droppedSections`、`customPrompt`、`autoPrune`、`autoExecutePrune`）。 commit 校验将存储的 `customPrompt` 限制在 8192 个 UTF-8 字节内，并把空白段落归一化为缺省字段。每个字段都被消费：段落成为 Member 的 custom prompt section，`droppedSections` 过滤该 Member 的 assembly，auto-prune 二元组驱动用量 sweep——机制详见 Tools and preset。
- 创建与编辑在 commit 时校验，记录 schema 镜像同一下限——低于下限的存储记录会拒绝重放。编辑遵循 `model` 的 absent-clears 语义；这些字段出现之前的旧 ledger 按普通 continue/跟随路由的 Member 重放。
- 窗口覆盖只会从路由向下收窄压力预算、绝不放大：`routeLimitsForAgent` 以覆盖值与实时路由窗口的较小者计算预算，超过路由的覆盖值等于没有设置。未设置覆盖的 Member 行为与之前完全一致。
- `fresh` 策略只在「被安排新任务」时重续 Member 上下文：Member 认领任务时、Human 原子开始的 committed 直接提及点名该 Member 时、或队友的直接派发（mention 的 Inbox wake 携带未读 direct work）送达时。DM 是纯会话中继，不经这道门，也绝不消耗 arm。
- 续期经序列化 lifecycle 队列执行，走 Human 重置路径使用的同一个 `renewMemberContextNow` 持久操作；调度器等待 Member 的 turn 边界，像 member transition 一样收敛运行中的 Agent。
- 续期在完成时被「武装」而非立即触发：`completed` 停止且末轮以完成标记收尾会把 Member 置为 armed（activation 尾部扫描发现最后一次持久停止就是标记收尾时同样置为 armed），任务完成本身从不当场续期。
- 派发门会扣住携带 direct work 的 wake，直到续期落地——重置通知与全新系统上下文先于任务正文出现在新代际里；不携带 direct work 的通知（Thread 闲聊、Task activity 流转）绝不消耗 arm。续期落地后经同一道门重新推导那被扣住的 wake（landed-renewal 放行避免 signature dedupe 把它吞掉），重置 body 退出时也会再 flush 一次仍未送出的投递，因此 gating 从不丢失工作。
- 该不该重置只在当前 Workspace 存在指定团队负责人时鉴别：派发门上 Host 发起一次有界模型判定，把这条派发正文与该 Member 的近期工作比对——它最近 5 条自己发的 Message，加上它最近 Claim 的那个 Task 的内容——得分达到 60% 判定为同一件工作的续作，直接投进 live Session 而不续期；没有负责人，或调用失败、超时、无历史、低于阈值，都花掉 arm 先续期。判定只看本次派发（sequence 最新的 direct work），未读积压不参与，否则一条相关消息会把后续无关任务一起保住。每次判定的分数都写日志。
- 派发方仍可显式否决这道判断：committed Message 携带 `keepContext` 时（`team_message` 的 start/reply，或 Human 原子开始），Host 在 emit 之前记下该 operation sequence 对这些 direct markers 的豁免，跳过判断直接保留上下文。豁免与续期判断都是进程内意图，绝不写成 ledger fact；豁免绑定 sequence，因此只覆盖这一条投递，下一次派发重新判定。`team_view` 的 Agent 行显示 `contextStartPolicy`，让派发方先看清谁会续期。
- 最终放弃（give-up）则释放 arm、让该派发降级到旧上下文投递，而不是热循环重排。已排期的重置若在此期间遭遇 live handle 换代——restart、rollover 或 dispose——body 会重绑到当前 handle 并继续重试，上限五轮绑定，绝不把已排期的续期连同旧 handle 一起丢弃。
- 完成工作不是分配：Claim 标 done 或 Task 被验收都不提交任何续期；读时验收指引对 `fresh` Member 也改为 keep 当前上下文而非建议 rollover，让完成总结在下一次分配续期前始终可在 live 日志中读到。
- 提交前调度器重读存储的策略与状态：期间策略已被改掉、或 Member 已无法对其 Agent 进行 dispose 的情形跳过续期。已提交的重置只私下提示被其 fresh-start Task 策略续期的那个 Member；`continue` Member 从不经此路径续期。
- `autoPrune` 开关在与 fresh 策略相同的任务边界附加一次用量 sweep。与 fresh 调度器一样，它等待 turn 边界、在那里重读存储的开关与状态（期间被编辑或暂停则跳过），并在串行 lifecycle queue 内执行。用量折叠要读整个 session 文件，因此先于队列完成。ask 模式只发 `@human` 收件箱通知。
- 队列内的 sweep body 只做廉价重验——重读的成员仍开启开关、每个折叠候选仍对应一个 live、不受保护、有工具映射的 section——然后再询问或提交。
- full-auto（`autoExecutePrune`，partial 用量折叠下永不发生）以 Human actor、一次 echo 齐全的 member update 提交候选移除，在边界落定后 live 生效，并且仍然宣告。用量投影在读取时计算、从不持久化；partial 折叠（归档不可读、血统深过遍历上限）只会让决策降级——不可读历史只会少算，因此绝不驱动自动移除。
- 窗口计价的是近期工作而非终身闲置：闲置超过 14 天下限的成员折叠出零用量，full-auto 可能在该成员下一次任务启动时清理所有映射 section——这是窗口语义的预期结果，且每次移除都能在 Prompt 对话框恢复。

## Composer attachments（cache，不是 archive）

Composer attachments 是 `$DSH_HOME/agent-team/attachments/v1/<attachmentId>/` 下的有界 cache（包含经过清理的原始名称和 `meta.json` sidecar），不是 archive，也不是 ledger bytes。

- `putAttachment` 写入 immutable payload（每个文件上限 10 MB，并从名称中剥离 path separators 和 control characters）；`getAttachment` 为 Client display 读取它们。两者和其他 Host capabilities 一样都是 typed Remote actions。
- Channel 与 Thread composer 的附件入口有两个：「+」按钮选择文件，或直接向输入框粘贴——携带文件的粘贴会被拦截并进入同一 pending-file chips 流，纯文本粘贴保持浏览器原生插入。
- Message 在 ledger 中记录 attachment metadata（`attachmentId`、`name`、`byteSize`、`mediaType`）；存储 body 为每个 attachment 携带一行面向机器的 `[attachment] <absolute path>`，让 Member agents 通过普通 file tools 按 path 读取 bytes。Client 会从 display 中移除这些行，改为根据 metadata 渲染 thumbnails/chips。
- Ledger 是唯一 durable attachment authority。Bytes 是 transient 的：Host startup 以及每 24h 执行一次 GC sweep；被 Message 引用且超过 72h 的 uploads（Member consumption window），或从未发送的 orphaned uploads 超过 24h 的，都会被移除。Metadata 保留，Client 随后优雅降级为 name chip。
- Members 通过 `team_message` 的可选 `attachments`（absolute paths）共享文件：Host 先验证每个 path（absolute、regular file、non-empty、10 MB），再以 extension-derived media type 复制到 cache 的新 immutable entry，因此 agent-sent images 与 composer uploads 的渲染一致。任一 rejection 都会拒绝整个 send，不提交也不复制。
- 不需要为手动 path references 增加机制：粘贴到 Message body 的 absolute path 会被 Member agent 像其他文件一样读取，Host 不会触碰不属于自己的内容。

## Human profile 与版本脚注

Human 的显示名与头像引用存放在 Team Host row 自身的 Config（settings namespace 即该 row 的 id，user layer）；头像 bytes 存放在持久的 `$DSH_HOME/agent-team/human/v1/` store，从不进入带 TTL 的 attachment cache。

已退役的 `agent-team-human` section 不再是权威：rc.1 的 settings importer 通过一份封闭的内置映射搬运 section，第三方 section 会留在改名后的 legacy document 里。启动时若发现该 row 仍是 pristine（默认名且无头像），就沿用设置页同一条写入路径收养这些 facts，已经重新填过的值优先。

四个 typed Remote 服务设置页：`humanProfile`（名字、头像引用与版本脚注 facts），以及 `putHumanAvatar`/`getHumanAvatar`/`removeHumanAvatar`（只收图片，与 attachments 共用 10 MB 上限；已删除的条目读取时抛错，Client 回退到首字母）。

脚注携带本 Host 实际运行的那份 bundle 的版本（从已安装包自身的 manifest 读取，因此陈述的是 profile 真正装上的那一份，而不是每次发版都得记得改的字符串），以及 repository 链接；当后台检查观察到更新的已发布 release 时，再多一条点名该版号的更新 tip。

检查最多每 12h 询问一次公开 npm `latest` document，后台刷新使 profile 读取永不等待网络，任何失败都落为"无已知更新"，`DSH_AGENT_TEAM_UPDATE_CHECK=0` 时保持关闭。

ledger 为 `team_view` 与 @ 匹配读取同一份 profile，一次改名同时到达每个 surface；`human` 是 Human 的永久别名，任何 agent handle 不得占用该字面，因此 `@human` 跨改名持续送达，而 chip 始终渲染当前显示名。
