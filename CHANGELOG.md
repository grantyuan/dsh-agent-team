# Changelog

All notable changes to this project are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and Semantic Versioning. Team bundle versions evolve independently of DeepSeek Harness versions; DeepSeek Harness compatibility is expressed through `peerDependencies` and [`docs/dsh-release-compatibility.md`](docs/dsh-release-compatibility.md).

## [Unreleased]

- New `team_watch` model tool, reserved for the Team Leader: `start` places a standing watch over another Agent Member with its own sampling cadence and stall threshold, `stop` cancels it, `status` samples one watched Member on the spot, and `list` shows every watch the leader holds. A watch is durable ledger state, so it survives a restart; while it stands the Host posts a Team Assistant notice into the leader's Inbox only when that Member changes supervision state, stays in one state past the threshold, or changes the Tasks it holds — each notice carrying the state, presence, diagnostic, context tokens against the route window, completed turns across the whole rollover lineage, and the running Tasks, so "stopped for five minutes" arrives once instead of once per pass. The watch is read-only: it never resets, interrupts, or messages the watched Member.

- Fixed replying to the same Thread more than once: the Human's first reply started the Host following that Thread, but the durable validator still only accepted the older reply shape, so every reply after the first was recorded in a shape the replay then rejected — the second answer surfaced as a failure and a restart could refuse to load the ledger at all. The validator now accepts the shape the writer emits and still reads the legacy one, so existing ledgers replay untouched and replying repeatedly works.

- 回复 Agent 的消息不再需要猜「你在说哪条」：Thread 时间线里每条 Agent（含 Team Assistant）消息行都带一个悬停「回复」操作，点击后输入框上方出现一条引用——回复 @handle：消息首行摘要——发送时把这条引用拼进消息正文，于是你回答的是哪条消息对 Agent 是明说的，投递仍走普通 @mention 机制；发送前随时可以点 × 取消引用。你自己发的消息行与已撤回的占位行不提供该操作。

- 你发出的指令现在可以收回：Thread 页里你自己发的每条消息都带 修改 / 撤回 / 删除 操作（撤回与删除前有确认弹窗），修改会把更正后的文本重新送到已经读过旧文本的 Agent 面前；被撤回的消息对所有人都只剩一条「该指令已被用户撤回」的占位说明，原文只留在账本审计里。如果你操作时某个 Agent 已经在执行这条指令，它会被立即停下——当前的回合被取消，但排队的其它任务原样继续——空闲的 Agent 则收到一句平实语言的提示；重复操作是安全的，已撤回的工作也绝不会再以未读的形式回来。

- A new Team Assistant voice speaks for the Host's supervision: the system notices that used to ride your identity — continuation nudges, leader report checks, truncation escalations, and retirement notices — now post as a fixed non-Member identity named Team Assistant, so 团队频道 no longer shows the machine's prompts as if you had typed them, and your account stays the only voice of the real user. The Assistant is not a roster Member: it owns no Session, cannot be messaged, only ever posts top-level Channel messages, and its name is reserved so no Member can register it. A side benefit of the change: notices that ask for you now carry a real @human mention, so they land on the 收件箱 as an ask waiting on you instead of an unread line.

- One button clears a whole queue: 全部已读 now stands in the header of 收件箱, beside its 排序 control, and reads every Thread still holding unread on the page through once apiece — one durable read each, no confirmation and no row-by-row walk — so a reader who has already seen a page clears their own backlog in one action. It changes only what the reader holds: a Thread it reads leaves 需要我 — where it lands afterwards is the Host's admission rule rather than the button's promise: one this reader wrote in falls back into 最近活跃, while one they merely followed leaves the page — with the sidebar entry's unread mark following the completed reads down. The button reads 已读中… while the sweep runs, disables itself when the page holds no unread, and one refusal stops the sweep with a single 没能清除未读，请重试 line instead of one error per Thread.

- Supervised retirement now hands the successor its predecessor's whole history and configuration. A Member archived and replaced by the supervision chain records `predecessorMemberId`, so 历史会话 opened on the successor lists the retired Member's own Session generations beside the successor's own — read-only, each labelled with the predecessor's handle, with nothing migrated or copied between Members. The replacement inherits the predecessor's configuration verbatim — same preset, description, model, capabilities, prompt profile, context-start policy, context window, and leader flag — rather than reverting to defaults. The handover notice is now a structured retirement notice posted in the Team Assistant's voice into the affected Channel and addressed to the designated Workspace leader alone (falling back to the inherited-Channel broadcast only when no leader is reachable), stating the retirement cause, the work the Member completed in service, the work its release left unclaimed, and a best-effort recap of its final Session when one could be made.

- The 收件箱 grew its own clocks and a faster read: every row now prints when its Thread was created, who last replied and when, and a 待你决策 chip only when the Thread truly waits on the Human — a Message asking them for a decision (naming them alone is not asking: reports and CC-style mentions keep the unread badge but no chip) or a Task awaiting acceptance. The queue leads by newest reply and the header's 排序 control re-lays it by created time, unread, or mention count — a per-browser taste, not a shared fact. The rows are no longer one flat run: each slice — 需要我 and 最近活跃 — partitions its own rows by Workspace and then by Channel, so the reader walks one Workspace's and one Channel's backlog at a time instead of every Queue interleaved, while the Host's admission order still holds inside each group and the sort key never moves a group. A plain-language 速览 sits one button away on the Thread: 生成速览 spends one model call on the Team's own configured LLM (the designated leader's pinned model, else any enabled member's, else the Host default) to recap the whole Thread in your language and, when a decision is owed, lay its own alternatives on the table — pick one, or tick several when the digest reads the options as combinable, or write your opinion; the answer goes out as an ordinary reply. Nothing is generated automatically: opening a Thread shows a stored recap for the current state when there is one and otherwise only offers the button, so no Thread opening spends a call on spec. The recap survives a refresh — one stored entry per Thread revision answers until a new fact moves the revision — and the call carries only the digest instruction and the bounded transcript, never tools, skills, MCP or memory. The recap and its decision question now read as everyday language: internal identifiers, refs, raw handles, tool and protocol names, and status codes are excluded by the prompt, so the summary says what something means rather than what the ledger calls it.

- 历史会话 now shows the whole real process instead of only the messages that survived: a turn that failed, was cancelled, or was blocked, a model attempt that committed no reply, a developer message, a context compaction, and a tool's structured refusal each reach the audit page as their own entry, so a reviewer sees what actually happened rather than a transcript that quietly ends where the writing stopped. The model-facing doctor fold is unchanged — it still keeps its single-line budget and tail ordering.

- Inbox and Tasks rows now return to their own list: a Thread opened from the 收件箱 or 任务 list carries that list as its Back target — the button reads 返回收件箱列表 or 返回任务列表 and returns there — while a Thread entered from its Channel keeps 返回频道. The origin is a durable navigation fact, so a reload reopens the Thread with the right Back target.

- Interruptible work with a durable resume memory: a Member can interrupt its current session and pin the unfinished state onto the ledger's pending-interrupt stack — a resolved context checkpoint plus a short label and a bounded incomplete-state note, up to eight entries per Member, newest-first. The new `context_interrupt` tool records, lists (each entry annotated with whether citing its anchor to `context_rollover` would return today), and releases entries; when a checkpoint-return rollover actually resumes pinned work, the Host closes that entry as `resumed` inside the same transition. A Member with a non-empty stack gets one private resume-check notice after each finished episode, so completion always faces the pre-completion analysis: report first, then walk the stack newest-first, release what can no longer be returned to, and let a strongly related follow-up continue directly while unrelated work is written to memory before a context reset. The Agent row menu gains 已暂停任务: the Human can read the same stack and release stale entries; the `resumed` close stays the Host's own.

- Prompt-cache discipline across context resets: a checkpoint-return seed carries the source log's exact prefix — system prompt, injected instructions, and tool history included — so unchanged assembly re-commits no new prompt text, the transition carries the retiring generation's model selection so a default-route flip cannot re-interpolate the prompt mid-handoff, and the persona forbids rewriting the memory index or restating carried content unless the fact actually changed.

- Expanded 历史会话 entries are no longer cut short: the Human-facing transcript fold keeps each entry's full stored text (only the model-facing doctor transcript keeps its per-line budget), and the page stays bounded by its paging instead of a silent mid-content ellipsis, so 展开 now shows the entry as authored all the way to its end.

- A Member mid-context-transition is no longer unreadable and unactionable. The session-history walk reads the live handle as the current generation — during a transition the durable binding already names a Session that may not exist on disk yet, and the page used to fail with "could not be read: session ... not found" — an unreadable current binding now continues the walk at the ledger-recorded predecessor so archived history stays auditable, and the page defaults to the newest readable generation instead of fetching a log the Host cannot open. Every unavailable Agent row additionally offers 重启: the Host's recovery read completes an interrupted transition (retire the stale generation, activate the bound Session) instead of leaving the operator with no action while the conversation cannot be opened.

- 历史会话 (Session history) is now a standalone audit page instead of a dialog: the Agent row menu opens it in the conversation seat, and the reviewed Member stays the page's durable navigation state across reloads. The transcript stops being folded into single flat lines — every entry renders as authored Markdown, and the Host fold now separates the lanes a reviewer needs to tell apart: 系统指令 (the rendered system prompt), 团队消息 (Member-to-Member relays), 系统通知 (Host-injected notices), beside ordinary Human input and assistant replies. Assistant entries now carry their text (the fold had been reading the event envelope, not the message, and rendered them empty), and Inbox splice batches — how a Member's wake input actually reaches the model surface — are expanded into their own lane rows instead of dropped, which is why thread-driven collaboration history no longer reads as an empty session. Tool calls and results keep a monospace lane, and long entries collapse behind an expand control.

- The Host no longer polices a Member's context size: the whole pre-step pressure ladder — the one-shot handoff-budget notice, the per-generation reduction order, the Host-forced compaction budget, and the fail-closed request block — is gone, and a Member manages its context itself through `context_rollover` and `context_checkpoint`. Supervision's whole progress judgment is the plain failure streak: three consecutive `agent/error` turns with no clean turn between them open the Host's coercion chain — the ten-minute tick advances that chain before it spends any bring-up budget, a reset that failed to commit is retried on the next tick, a Member the reset did not heal reaches the archive-and-replace handover, and a Member the chain already owns is left to the chain instead of being woken with another 继续 — while the rolling-window failure-rate lane, the abnormal-stop bring-up budget, and the hung-Member detection keep their own lanes. The one context-specific rescue left is the provider's own overflow refusal: a request the provider rejects because the context no longer fits its route earns one bounded compact-and-retry per open failure chain, re-armed only by a successful request, and a lane whose routed proxy owns compression (the `dsh_compaction_refused` rejection) never retries — its overflows surface as ordinary failures for the streak to judge. The budgets the Member reads on demand — the acceptance advice, the `context_timeline` tool, the checkpoint-return guard — are priced from the routed model's own information instead of fixed product caps: the hard limit is the route's context window minus the output reserve (the adapter's disclosed default per-request output cap, floored at 16K), the handoff budget subtracts a further reserve of `max(8K, 4% of the window)`, and tool paths that cannot price the live route fall back to the conservative narrow-route budgets rather than the old caps.

- Output truncation escalation: when a Member's turn is cut off at the per-request output-token cap (the reply is truncated and the Web UI hints 发送「继续」), the Host posts one escalation notice in the Team Assistant's voice into the designated Team leader's Channel for every Workspace the Member holds, waking the leader to decide what happens to it — have it resume in smaller chunks (writing output into files or posting part by part so it does not hit the cap again), reassign its unfinished work to another Member, or leave it stopped for you. Escalations latch per (Member, Workspace) for ten minutes, a clean 任务结束 stop re-arms the episode, and a Member with no eligible designated leader is logged rather than nudged.

- Per-Member completion liaison: when a Member stops on the 任务结束 marker and stays idle without ever addressing the designated Team leader (no Channel mention, no DM), the Host wakes the leader with a Team report check notice in their Channel. When the Workspace designates no leader, the open Tasks are pushed to the Member itself to decide autonomously — one contract declines: a reply opening with 拒绝继续 means the Member hands the decision back, the Team stops pushing Tasks to it, and its own feedback words are relayed to @human in the Channel. The designated Leader's own completed stop earns no forced wake at all — no self-push, no self-check: the Leader reports to @human by duty, and only a Leader failure summons the machinery, through the guard and supervision lanes. A marker-completed stop that landed while the Host was down earns the same report check retroactively at activation, so a deploy restart does not leave idle unreported Members off-policy.
- Inbox waking is now point-to-point: a committed operation summons a Member's model only when it names them — a Direct marker from a mention or DM, an Activity marker on their Task, or their own acting — while unaddressed Thread chatter merely counts in the Inbox projection and rides the next addressed delivery body-free, cutting the per-follower token spend of shared-Thread traffic. Host-generated notices quote Task subjects and refusal feedback with full-width ＠ so a quoted name can no longer resolve as an authored mention and escalate a bystander into a recipient.
- Abnormal stops no longer fall silent: a turn that ends `completed` without a tool call and without the 任务结束 marker now earns a stop-boundary continue reminder even after the response guard's three-nudge in-loop budget has stood down — the reminder re-arms the budget for the round it opens, throttles on a per-Member cooldown, and a recent faulty stop that no reminder ever reached is paid at activation from the stored Session tail. Text whose completion marker trails punctuation or decoration still counts as a clean finish.
- A fresh-context (每个任务全新上下文) Member now renews before every new dispatch, not just its own Claim or a Human atomic start: marker-completed stops arm the renewal, the Inbox gate holds a teammate's direct mention until the reset lands so the task body arrives in the fresh generation after the reset notice, a handle swapped mid-schedule re-binds instead of silently dropping the scheduled reset, and completion alone still never renews on the spot. A DM stays pure session relay and never spends the arm. The Host now makes the "does this task need the old context?" call itself — and only while the Workspace has a designated Team Leader: at each dispatch seam one bounded model call scores the incoming Message against the Member's recent work (its last five authored Messages plus the content of the Task it most recently claimed) and delivers into the live Session unread at 60% or above; with no leader, or when the call fails or scores below the bar, it renews first. `keepContext: true` on a `team_message` start/reply (or a Human atomic start) skips the judgement and forces the keep; both exemptions are process-local intent bound to one ledger sequence, never durable facts, so a later dispatch is judged again. `team_view` prints each Agent's context-start policy on its row, and the score behind every decision is logged.

- Fresh-context (每个任务全新上下文) semantics tightened around assignment only: a fresh Member renews its context at its next Claim or Human atomic start and never when a Claim completes or a Task is accepted, and the post-acceptance context advice for a fresh Member now says keep instead of roll over, so the Human can still read the completion summary in the live Session. The Member persona contract posts each completion in the Task's Thread with a compact summary attached before closing the Claim — the durable record outlives every later reset. The Agent row menu gains 历史会话 (Session history): a read-only view listing every Session generation of the Member (the live one first, unreadable ancestors flagged) with a bounded, cursor-paged transcript of the selected generation, read from the stored logs through new `memberSessions` / `memberSessionTranscript` Remote reads that never activate or write a Session.
- Lighter Agent inbox wakes: a Member's automatic notification context now renders only the newest unread instance of each Host recurring notice — continuation checks and context-reset announcements — with superseded earlier ones folded into a single summary line that frees their slots for live work. A reset or idle-woken Agent no longer receives the same open-Task list repeated message after message; every Message stays durable in the Inbox.
- Fixed the Prompt dialog hanging on 保存中: saving an edit of a busy Member now answers the moment the change is committed, while the paragraph, section drops, skills, and tool restrictions land in the background at that Member's next turn boundary. A long-running or stuck Member no longer keeps the save spinning, and no longer blocks another Agent's edit, suspend, archive, or reset behind it.
- Propose-only LLM curation in the Prompt dialog: type your 策划要求 and 使用 LLM 策划 has the Host make one bounded call over the Member's live prompt assembly, private skills catalog, identity, and your requirements on the Member's effective route — cancellable, hard-bounded at sixty seconds, and reporting the exact `modelUsed` route. The reply returns as a proposal — sections to drop, a skills allow-list, and a custom role paragraph draft — that only fills the form for your review; you commit it through the same merged save, nothing lands without you, and a failed call renders 策划失败 inside the dialog without blocking manual editing.
- Fixed restoring a dropped prompt section: re-checking the row in a Prompt dialog opened after the drop silently re-applied the stored drop on save instead of clearing it.
- Usage-aware prompt sections with confirmable auto-prune: the Prompt dialog now prices every tool-mapped section with its call count inside a rolling window — the last 20 completed turns or 14 days, whichever closes first — marks zero-use rows 长期未用, and warns that counts may under-count when part of the archived lineage was unreadable. A per-Member 任务启动时自动检查未用段落 switch has the Host sweep unused candidates at the same atomic task-start boundary as the fresh-context policy: the default ask mode posts one @human inbox notice naming the candidates and waits for your confirmation in the dialog's new confirm panel, whose 移除并不再确认 action also turns on 自动执行（不再确认） so later sweeps remove and announce without asking — every removal still lands as an echo-complete, ledger-recorded member update, and protected and prose-only sections are never candidates.
- Per-Member system-prompt section drops: the Prompt dialog lists the Member's live assembly — one row per section with its byte size and a keep toggle — so a Human can remove a section from the Member's next model assembly or restore it, with the paragraph and other profile fields untouched. Protected rows (the deployment persona slots and the custom paragraph section) refuse drops with a 受保护 mark, names no live section provides stay inert as 已失效, and prose-only rows carry a 无自动信号 mark. The Host registers one member-scoped assemble listener per Member that filters the dropped names at the turn boundary — read-side views still see the full list — refuses protected names at consumption, and replays the stored list across restarts.
- Per-Member custom role paragraph: the Agent create and edit dialogs gain a 自定义提示词 block whose Prompt dialog edits one fixed paragraph appended after the Member's system prompt. The Host registers it as a member-scoped prompt section at activation, swaps it at the next turn boundary when edited (the Session survives), and releases it when the paragraph clears or the Member leaves. It stores in the member prompt profile under an 8192-byte UTF-8 cap — the dialog's live counter mirrors that ceiling — merges without touching the profile's other fields, and a blank paragraph stores as none.
- Per-Member context control: the Agent create and edit dialogs gain a 任务启动上下文 block — a continue/fresh picker plus a context-window override. A fresh Member starts every task it claims or is @-mentioned into from an empty context (the same durable reset the 重置 action performs, privately noticed to the Member), and the override prices the Member's context-pressure budget from the smaller of itself and the model route's window, so it can only narrow — never widen — what the route admits (floor 8192 tokens). Members without overrides keep exactly their previous behavior.
- Batch acceptance on the Tasks page: open rows carry a selection checkbox, and the sticky bar that rises on the first tick resolves the whole selection at once — 验收所选 or 关闭所选 through one Host call per Workspace, each Task its own durable operation. Already-resolved Tasks report as skipped instead of failing the batch, a failed run keeps the selection for retry, and the note reports committed, skipped, and failed counts.
- Fixed the Tasks and Inbox pages landing on stale rows after a burst of background updates: concurrent refreshes could complete out of order and let an older read overwrite a newer one, leaving the list disagreeing with the Threads it summarizes until the next wake.
- New Tasks page in the sidebar: the Human's cross-Workspace Task list showing every Task with its derived status, per-Channel ordinal, live owners, and the sub-tasks Agents split underneath their parent with `n/m` progress — one click opens the Task's Thread. New `tasks` Remote serves the list; done and closed work stays visible under 已完成.
- Agents can split work: a taskful `team_message.start` accepts `parentTaskRef` and files the new Task as a sub-task of an open Task in the same Channel (abbreviated refs resolve; cross-Channel and closed parents are refused).
- Members can be designated the Team leader (成员编辑器 设为团队负责人): the flag rides the Member editor, shows a 负责人 badge in rosters, and survives edits that do not mention it.
- Idle continuation watch: when every Agent has stopped normally but Tasks Agents can still advance remain, the Host waits out a two-minute quiet hold and then posts one continuation nudge in the Team Assistant's voice into the open work's busiest Channel, naming the designated leader and listing the open Tasks so the Team keeps moving. Tasks in 待验收 are off the watcher's list — their Claims are done and only Human acceptance can move them, so a Workspace holding only such Tasks never fires. Each Workspace keeps its own quiet hold, and a nudge re-arms when an Agent works again, the Task landscape changes, or ten minutes pass unheard; a Workspace without a designated leader is logged once instead of nudged.
- Every Member's model rounds now pass a response-shape guard: a round that ends with only thinking content, or with text that neither calls a tool nor ends with the 任务结束 completion marker, is treated as a faulty round and the Host delivers a `continue` (steering the still-open turn or opening the next one) so the Member keeps working — up to three consecutive nudges before standing down, resetting on any healthy round. The Member persona states the matching rule: a finished turn that ends in plain text closes with 任务结束 as its very last words.
- The Agent row menu gains two context actions for live Members: 重置 (Reset) rolls the Member over to a fresh session through a destructive confirm — the old log stays archived and private memory is untouched — and 压缩 (Compact) schedules a context compaction, optionally pinning the summarizing LLM or following the session's current model; the Host runs the reduction after the Member's current activity, without blocking later work.
- The Host's ten-minute supervision pass now watches every enabled Member instead of only Claims holders, and treats a running Agent with no durable session event for thirty minutes as hung beside the stopped and error-presence cases. Repeated failures — three `agent/error` turns in a row or three failures inside twenty minutes — no longer replace the Member on the spot: the Host opens the coercion by performing the same fresh-context reset the sidebar menu offers, privately noticed to the reset Member alone with nothing posted to any Channel, and only a Member still unhealthy on a later pass is archived and replaced by a same-role `-N` generation carrying its private memory and Channels, which asks `@human` in Channel to reassign the abandoned work.
- New `team_supervise` model tool: `status` reports what the supervision pass reads about one Member (pass state, presence, failure diagnostic, failures in the last twenty minutes), and `reset` gives an abnormal Member the same fresh-context reset the Human menu performs — a healthy Member refuses, and the caller cannot reset itself.
- Context compaction survives a broken summarizer: when a scheduled or pressure-forced compaction fails on a real error, the Host retries it through the Host catalog's other configured LLM routes one by one — excluding the Member's current one, up to three attempts — before reporting the failure.
- A Member that stopped with an error gains an 分析错误 (Analyze error) menu action: it dispatches the durable `doctor` Member — created on first use — to a fresh session with the failed Member's context as research material. The doctor automatically joins the failed Member's Channels, reports its analysis to you by direct message, and posts the same report as a Thread in that Channel so the diagnosis stays traceable in the Team ledger without a manual invitation.
- A replacement's handover notice now goes to every Channel it inherited and directly notifies all live fellow Members — not just `@human` — so the whole team learns who took over and that the replacement carries the predecessor's settings and memory.
- Resetting a Member's context (重置) no longer broadcasts a notice to the team: the Host privately notices only the reset Member — its Session restarted empty while handle, settings, and private memory are unchanged — and directs it to re-orient from its private memory and recent Team history, asking teammates about whatever stays unclear instead of guessing. The notice is runtime delivery, not a ledger Message.
- Fixed runaway context compaction at the hard limit: a forced compaction must now prove the measured context dropped below the hard limit before the step goes out — otherwise the step fails closed — and at most one forced compaction is spent per recovery chain, ending the loop of repeated compress-rewrite steps that busted the provider prompt cache and burned tokens without shrinking the context.
- The sender name follows the content-size setting: at a raised size the author grows with the message instead of staying at its default size, while the message body keeps the grid it already had.
- The certified DSH baseline moves to `0.2.0-rc.2`: every `@deepseek-ai/dsh-*` peer advances to `>=0.2.0-rc.2 <0.2.1`, so a host still on `0.2.0-rc.1` falls outside the declared range.
- Certified against DSH `0.2.1-alpha.2`: every `@deepseek-ai/dsh-*` peer moves together to `>=0.2.1-alpha.2 <0.2.2`, and the `@deepseek-ai/cordis` peer moves to `~4.0.5-alpha.1` — the range that line's own packages declare — because a `^4.0.1` comparator admits no prerelease tuple and an npm install of the candidate resolved to nothing. The `@deepseek-ai/dsh-invariants` peer left with the package it named: Harness removed its runtime invariant registry, so the ledger divergence guard is now a Team-owned companion row beside the Host, keeping the same fail-closed mount check and the same deferred, burst-coalesced replay after commits.

## [0.2.0] - 2026-09-29

- `team_view` lists the Task Threads in flight: every in-progress or in-review Task in your Channels, with the members already on it and the latest activity, independent of your own unread queue.
- Settings says whether the DSH you are running is one this bundle supports: it states the running version and the supported range in words, and reports a version it cannot read as not determined rather than unsupported.
- Interface details follow DSH 0.1.7-rc.2: focus rings use DSH's own ring tokens with one ring colour everywhere, and radii move onto DSH's own scale.
- Certified against DSH `0.2.0-rc.1`: every `@deepseek-ai/dsh-*` peer moves together to `>=0.2.0-rc.1 <0.2.1`, and the context-continuity engine floor moves to `^0.1.6`.

## [0.1.15] - 2026-09-24

- Upgrades carry your profile across: the name and avatar saved under the old settings section land in the Team Host row on the first boot after upgrading, and anything you re-entered yourself wins.
- Long messages read as documents: a body past the fold takes a roomier rhythm of paragraph, list and line spacing, short chat keeps its dense grid, and message text follows the content-size setting.
- The Team Client takes DSH 0.1.7's surface language: sidebar rows, the Workspace selector and member rows share one radius tier, the composer card wears DSH's own hairline and elevation, a narrow composer narrows its gaps instead of dropping the as-task word, and the Inbox row's clock yields when the line cannot hold it.
- Fixed the `@mention` menu being hard to read: DSH 0.1.7 made the shared menu surface translucent, and the suggestion list now frosts what is behind it instead of letting the conversation bleed through the names.
- Fixed the settings footnote naming the wrong version: 0.1.14 shipped a hard-coded previous version, so the footnote reported the old release and the update check offered the release you already had.
- The sidebar's Plugins panel entry stands down while Team mode stands and returns when you leave; ordinary conversations keep it.
- Fixed a fresh install of 0.1.14 losing context handoff silently on the previous DSH line: this release declares the engine's current line and matches its data shapes.
- Certified against DSH `0.1.7-rc.1`: every `@deepseek-ai/dsh-*` peer moves together to `>=0.1.7-rc.1 <0.1.8`, so upgrade DSH together with this release. The `@deepseek-ai/dsh-agent-presets` peer left with the package it named.
- Durable messages carry their own producer's kind as DSH's session format requires, history written by earlier lines still reads back, and the startup pass that rewrote those sources is gone.

## [0.1.14] - 2026-09-22

- Context continuity runs on `@wowyuarm/dsh-context-continuity`, the extracted context-continuity engine: rollover, checkpoints, the projection fold, and the timeline all read through that published package. Timeline rows carry a short `anchor` id, and only a restorable row ever prints a ref `context_rollover` accepts.
- Settings gains a `My profile` section: set the display name Agents mention and an avatar, which then leads your own Inbox rows, avatar stacks, and message seats — bad image bytes fall back to your initial, and `@human` survives any rename.
- The Settings footnote checks for a newer release in the background and names it once observed (12-hour cache, silent on failure, `DSH_AGENT_TEAM_UPDATE_CHECK=0` to opt out).
- Member memory carries a 16 KiB budget with usage shown on every injection (`X.X KiB / 16 KiB`); the over-budget warning states exact bytes, and a bundled `member-memory-manager` skill holds the upkeep rule.
- The sidebar leads with one keyboard-operable workspace selector on a single line; Thread, Channel, and Member references render as titled clickable chips; a finished Task row reads `Task #N` without its last-activity time.
- The Task Thread header separates its sections by space instead of a second rule, reads Claims in two lines with finished ones stepped back, and states each runtime risk as one localized line with the full diagnostic on hover.
- Agent model pickers open from a warmed shared catalog — a slow Host read delays a refresh instead of hanging, and a failed read offers a retry instead of endless loading.

## [0.1.13] - 2026-09-17

- Fixed market-installed DSH Desktop clients failing to start: the SQLite storage backend now ships inside this bundle instead of depending on a package no published host provides. Existing media open without migration.
- Agent Members can now work across Workspaces: joining a Member into another Workspace is explicit, and the five Team tools take an optional Workspace selector. The Inbox merges every participation, and the Human member panel gains import and withdraw controls.
- Mention chips render only where delivery reaches: a name needs its authored `@` to chip.
- The Inbox leads with rows that mention you, ahead of merely newer ones.
- Team pages stay responsive when several are open at once, and reconnected pages catch up without a new commit. A Host and a Client half from different bundle versions no longer work together — restart the Host after updating.
- Fixed archived Channels leaking their Threads into the Inbox: archival ends participation as well as notification.

## [0.1.12] - 2026-09-16

- Reworked Inbox around unread and recent activity: the unread queue leads with counts, and threads you keep returning to get their own list.
- Mention members with `@handle` or `@all` right in the message body, with suggestions and a will-notify line as you type.
- Connection loss renders as an inline state with retry in place, and surfaces wake up on recovery.
- Interface details aligned with DeepSeek Harness conventions.
- Fixed long threads silently dropping facts a bounded read left behind.
- Fixed member private-data migration and removal to stay within the current DSH home.
- Other changes: progress nudges are gone; member context is fully managed by members and the Host pressure policy.

## [0.1.11] - 2026-09-14

- The Human Team gains a `Mentions of me` Inbox that gathers unread mentions from every Workspace into one list.

- A member whose stored Session cannot be read can be repaired by restarting it, and an unavailable member reports why.

- Thread messages are conclusion-first, mentioning the Human only when you must know or decide.

- Opening a Thread, waking a long-lived member and startup are faster, and stored data is smaller.

- Team interface details are aligned with DeepSeek Harness's own conventions.

- Fixed surfaces not showing a change that landed while you were away.

- Fixed `team_view` reporting a wrong revision for a Task whose Thread is outside the page.

- The `@deepseek-ai/dsh-*` peers declare exactly the certified DSH line, `>=0.1.5-rc.1 <0.1.6`; a newer `0.1.x` reports a peer conflict.

## [0.1.10] - 2026-09-11

- The certified baseline moves to DSH `0.1.5-rc.1`, and `0.1.5-rc.2` is certified on the same peers with no manifest change; the peer range is now `>=0.1.5-rc.1 <0.2.0`. Seven upstream source breaks are adapted to, including the agent setup signature, the keyed `main` slot, the Session persistence handle API, and the `dsh-persona` config key rename. Published 0.1.9 cannot install on this line, because `>=0.1.2-rc.1 <0.2.0` admits prereleases only on its own base tuple; DSH `0.1.2-rc.1`–`0.1.4` fall outside the new range, so upgrade `@deepseek-ai/dsh` together with this release.

- Member Sessions record rollover handoffs and checkpoint continuations as named snapshot sections instead of package-specific source kinds, so what this version writes stays readable through a later format migration.

- Member Sessions that the current format migration refuses, or whose retired log is corrupt, no longer block startup or leave a Member `unavailable`: a refused artifact is admitted into the shipped shape with one current-format sibling published beside it, leaving the original byte-identical, while genuine read failures stay fail-closed.

- Fixed Channel archival and Channel member removal on a Channel holding a taskless Thread, which wrote an incomplete inbox cleanup and made the next start fail; records written by 0.1.7–0.1.9 with that legacy cleanup are repaired in memory on load.

- Members gain `web_fetch` through the `team-member` preset, and the `web_search` guidance now recommends fetching a specific result.

- Members now have time awareness: every agent-facing surface carries absolute instants in the fixed Team coordination zone UTC+8 with an explicit offset, and a `member-time-context` clock row gives the first step of an eligible turn one durable snapshot with the current instant, the elapsed time since the preceding model-visible event, and the ordering-authority note.

- The five model-facing Team tools render as one decision interface: `team_view` is an address book, `team_inbox` states unread and direct counts, and `team_thread` renders its five actions separately.

- The write basis is an opaque next-write token rendered only on a fully drained `team_thread read` and on your own committed public mutation; committed results name their action, claim mutations render the affected Claim first, and `team_claim list` shows only active Claims.

- A Member activation failure caused by two physical copies of `@deepseek-ai/dsh-scope` now states its fix instead of the bare `selected preset is not team-enabled`.

## [0.1.9] - 2026-09-07

- Members manage their own context: `context_rollover` ends the current context and continues as the same Member in a new one, `context_checkpoint` records a restorable anchor before a risky operation, and `context_timeline` inspects the context lineage (checkpoint, first-arrival, and Task claim boundaries labeled by their semantics) and picks an anchor to return to.
- Member context no longer needs watching: near the budget a Member receives one notice suggesting `context_rollover`; at the hard limit the Host compacts before the next request, so a task is not interrupted by context exhaustion.
- Context switches survive restarts and crashes: pending switches replay safely and a crash rebuilds the handoff from the last recorded state.
- `team_view` now lists top-level Threads (with revision and message count), so Members can discover discussions they were not mentioned in.
- Windows support: attachment file names and member memory directories are sanitized per Windows rules (illegal characters, reserved device names, trailing dots and spaces), legacy memory directories migrate automatically, and legacy colon-spelled memory directories merge into the canonical path on activation, with conflicting content archived under a `.colon-twin` suffix.
- Team tool results carry more complete decision information: thread/inbox lines show channel, status, unread/direct counts, and revision; Claims show status, owner, and direction.
- Fixed an intermittent session-retirement race during member activation that could fail startup.
- Fixed the underlying session not rebinding after leaving an embedded member view, which could cross replies.
- Fixed early-accept notifications carrying an empty finished-claim clause.
- Fixed a poisoned rollover pending that could not recover; recovery now retries and prevalidates the checkpointRef.
- The manual "start from a fresh context" action is removed; Member context management is fully delegated to Members and the Host pressure policy.
- CI gains Linux and Windows (Git Bash) lanes, and build/dev scripts are adapted for Windows environments.

## [0.1.8] - 2026-09-05

- Members that run 20 tool calls (then 40, 60…) without posting to a Thread receive a reminder in the current turn, listing the Tasks they hold a Claim on and the Threads they follow, asking for a brief note on what is confirmed, what remains, and any blocker. A reminder the member has not read yet is revoked once the member commits a message.
- A member following a still-`todo` Task it has never claimed receives one `team_claim` reminder after 5 tool calls (once per Thread per Session), suggesting it state its direction in the Thread first. Both reminders are advisory, write nothing to the ledger, and never wake an idle member.
- Team tools and the Web Client accept abbreviated refs: `task:0f0ad7` and any 6+ unambiguous hex prefix resolve to the matching Task / Thread / Member / Channel / Claim. Ambiguous prefixes are rejected with the candidate full refs, prefixes shorter than 6 hex characters are not accepted, and a Task ref renders as a link only after the Host confirms it — unresolved text stays plain.
- On Thread surfaces the mention candidate list ranks the current Thread's followers above the remaining roster, because mentioning a follower delivers directly while a non-follower needs the Human's two-step invitation.
- Member sessions now use the same shipped composer as ordinary sessions: the Team's own hint strip and its `/compact` and `@member` entry points are removed. Member context still compacts automatically past the threshold, and members still get the pre-compaction hint to persist key conclusions first.
- Member guidance separates the two channels: Team messages go to the ledger (visible to the team, revisitable), while a session reply goes straight to the Human who reads the output. It also states that a member's private memory/notes/skills are readable only by that member — restate the content inside the message instead of pointing at a note path.
- Task chips, thread pills, and member avatars share one status-dot component, so the same state renders at the same size and color everywhere.
- The mention candidate list keeps the keyboard selection inside the visible area when the roster needs scrolling.
- The new-update jump hint at the bottom of a Thread disappears once the reader scrolls to the newest message.

## [0.1.7] - 2026-09-04

- Fixes startup failure with current DSH. 0.1.6 combined with the current `@deepseek-ai/dsh` (latest is now 0.1.2-rc.1) installs cleanly — via npm directly or via `dsh plugin add` — but the host then fails to start, because the old peer range still resolves to the 0.1.1-rc.2 generation while DSH itself runs rc.1. This release fixes the combination and moves the certified baseline to DSH `0.1.2-rc.1`. Breaking for older DSH: this is a hard cut — the bundle no longer runs on 0.1.1-rc.2; users still on rc.2 must upgrade `@deepseek-ai/dsh` together with this release.
- Four previously missing peer declarations added (`dsh-api-session-controller`, `dsh-api-workspace-controller`, `dsh-client-ui-renderer`, `dsh-skill`). Two of them appear in the published type declarations, so consumers depending on Team types were relying on `@deepseek-ai/dsh` to pull them in transitively; they are now declared explicitly.
- Member sessions now use the full shipped composer. The restricted Team-only input box is gone: `/` and `@` menus, attachments, and the model picker come from the standard DSH input bar, with a slim Team hint strip above it (vocabulary hint + member turn errors, one quiet line on every viewport).
- Typing `/compact` as a full line now works in member sessions — it routes to the Team compact transaction whether picked from the menu or typed outright; `@member` still inserts structured references.
- Members and Channels can be archived — a reversible third state between suspend and remove. Archiving disposes the live session (member) while keeping private memory and logs on disk, releases the Member's active Claims with public activities, and hides archived entities from every Team surface; direct reads of archived threads return an explicit archived error.
- Member departure cleanup fixed: a departing member's Attention and markers now clear on every thread it followed, taskless ones included (was taskful only).
- README gains a Core-ideas section and a star nudge; docs updated to match the new member-session input surface and the rc.1 baseline.

## [0.1.6] - 2026-09-02

- Member runtime phase one: durable per-member capabilities schema, per-member tool policy, and member-private skills through per-member providers.
- Members can own their private space: the bundled member-skill-manager meta skill guides creating, installing, and maintaining private skills beside member roots.
- Member-to-member direct messages ship with focused context, recipient-handle error reporting, and correct reader-perspective context direction.
- Threads read their updates automatically without manual controls, and the client drops channel-level member editing in favor of the member-focused flow.
- The README now acknowledges Raft as the design inspiration for the collaboration shape.

## [0.1.5] - 2026-08-31

- Member sessions can start from a new context in place: renewing a session keeps the Agent identity, and error members get the same fresh-start path.
- Branded thread references navigate like Task references, and Human mentions render correctly in rich Markdown bodies.
- The team composer accepts pasted files as attachments, expands `@all` to all eligible members, and the member composer accepts mention candidates with Tab.
- Sidebar section collapse state persists per browser, and unclaimed `todo` Tasks can be accepted directly by the Human.
- Before automatic compaction, Members receive one advisory hint to persist their own key conclusions; writing remains the Agent's own call.
- Docs are now bilingual (English default path plus `.zh.md`), the Chinese README carries the full badge row, and builds allow esbuild scripts under pnpm 11.

## [0.1.4] - 2026-08-30

- Thread-first collaboration: start ordinary Threads without a Task, then promote a Thread to a Task when work is ready; structured promotion activity and optional Task overlays keep both paths durable.
- Add long-message expansion and clearer Thread/Channel conversation layouts, including stable reference chips and persisted workspace navigation.
- Add a Human restart action for unavailable Agent members and report the resulting runtime status in the Agent row.
- Keep composer task-mode state visible, preserve Thread header controls after replies, and improve Task reference and mention rendering.
- Refresh the bilingual README previews with current Team mode and Task Thread screenshots; archive completed diagnostics and maintenance records.

## [0.1.3] - 2026-08-29

- Member sessions now support direct Human editing and messaging, including session controls and a dedicated embedded composer.
- Accepted Tasks coordinate bounded automatic Member compaction when scoped token usage exceeds the threshold, without adding compaction facts to the Team ledger.
- Member recovery stops after three consecutive errors, and compaction state heals across preset reloads.
- Harden attachment payload sanitization, normalize legacy Team timestamps, and simplify Host and Client dispatch/rendering paths.
- Add stable Task reference formatting and inline mention rendering, plus the Awesome DSH Plugin listing badge in both README languages.
- Build cleanup, duplication checks, shipping specs, and browser test surfaces now better match the published bundle layout.

## [0.1.2] - 2026-08-27

- Human Thread replies now accept local file attachments; attachment chips, reference rendering, and draft previews are unified across message paths.
- Task references in Human and Agent prose resolve to Task numbers and navigate across Channels; Agent Markdown renders those references inline.
- Human members can accept a Task early while its open Claims finish their work.
- Channels and Agent members can be reordered per browser, with the chosen order restored after reload.
- Preserve member Sessions and pinned reasoning effort through model updates; fixes cover empty optional Team fields and cold-start records.
- Refresh the README Team mode capture to show the current collaboration UI.

## [0.1.1] - 2026-08-26

- Composer attachments: upload local files with cached bytes and thumbnail display, a larger zoom preview, and `team_message` delivery through the host attachment cache.
- Member recovery: resume or restart error-stopped members from the row menu, with automatic scheduled recovery that stands down after repeated failures.
- Restart member sessions in place, with distinct resume/restart row menu icons.
- Pin per-member reasoning effort together with the model selection.
- Simplified Agent and Channel creation: descriptions and initial Channels are optional, and both forms share the unified multi-select picker.
- Time dividers between wide same-sender message runs, and Team mode restores your last location after reload.
- Visual fixes: composer attach button alignment, suppressed stacked row fills while an Agent card menu is open, theme tokens limited to those the DSH theme defines, and a leveled divider hairline.

## [0.1.0] - 2026-08-24

First published release of the bundle.

- Durable single-host Agent Team: Workspaces, Channels, Messages, Tasks, Threads, Claims, and managed Agent membership, backed by an append-only operation ledger.
- Web Client for Human control: Team mode entry, refresh recovery, and exit; Channel and Agent management; Thread attention; Task review.
- Isolated `team-member` preset with five model-facing tools: `team_inbox`, `team_thread`, `team_message`, `team_claim`, and `team_view`.
- Pull-based collaboration protocol: Agent Inbox admission is durable and does not claim that the model has processed an update.
- Team ledger storage routed to SQLite via the public composition patch; other domains keep the JSON default route.
- Certified against DeepSeek Harness `0.1.1-rc.2`.
