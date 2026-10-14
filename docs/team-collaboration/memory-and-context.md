# Memory, context pressure, and notifications

English | [中文](memory-and-context.zh.md)

## Member memory upkeep
`memory.md` is a bounded routing index rather than a store: identity and role, durable rules that must bind every step, what is in hand, and one line per topic cluster, while `notes/` is read on demand and never injected. Members hold the index well under 8 KiB against the 16 KiB hard ceiling — past it the index is not injected at all, and the block always states its own usage.

Upkeep craft (what earns a line, the three tiers, compaction and demotion) is owned by the bundled `member-memory-manager` core skill, on the same pattern as skill craft in `member-skill-manager`; the persona carries only the resident rule that the index stays bounded and that detail lives in the note it names, and a Member's first-run `memory.md` scaffold states the same sections.

## Context pressure ownership
The Host owns Member context pressure end to end.

Two budget thresholds derive from the Member's live routed selection — the selection captured for the current step when it entered prompt assembly, its current selection otherwise — resolved through the LLM service (capped at 200K handoff / 256K hard, with a safety reserve). At the handoff budget the Member receives one binding pressure notice per generation: persist what must outlive the context into private memory, then reduce it (`context_rollover`, or the route's own compression). Repeating is suppressed for that generation and re-armed after a rollover.

A Member that keeps stepping above the handoff budget then receives one reduction order per generation, and past that order's own allowance the Host runs the reduction on its behalf. A context the Host cannot prove back under the budget blocks the request and is handed to the supervision chain's fresh-context reset: the Member keeps its identity, private memory, and Channels, and re-orients from them.

A route that refuses Host compaction outright is left to its own compression, and there it is the provider that names an oversized context — which supervision treats as a stop no continue nudge can heal.

At the hard limit the Host forces an in-place compaction before the next model request is forwarded, and releases the step only when the measured pressure is provably below the hard limit — an unmeasurable or still over-limit compaction fails closed, the step being rejected rather than submitted over the Team limit. One forced compaction is budgeted per recovery chain, re-armed only by a clean model response or a reading below the limit, so a context that will not shrink stops paying for repeated per-step rewrites that bust the provider prompt cache.

A provider context-overflow failure gets one bounded compact-and-retry sequence before surfacing. A route whose window cannot be measured is an explicit rejection, never a silent over-limit submission. Accepted-Task auto compaction is retired: pressure policy is the only compaction trigger besides the Member's own explicit choice.

## Agent notification boundary
Host derives bounded coalesced notifications from durable unread state. Idle Agents start a turn; running Agents receive context at the next safe step. Direct mentions include Message body, sender, Channel, optional Task overlay, Thread, and Message ref. Task/Claim Activities include actor, transition, and affected Task/Thread/Claim refs. Ordinary unread exposes only a body-free Thread-first route with its unread count; taskful summaries may name the Task. No notice renders a revision or write token. Omitted details remain discoverable through `team_inbox` and `team_thread`.

Host-posted recurring notices — continuation checks, and the context-reset Channel announcements only ledgers that recorded the retired broadcast still carry — restate the full current state with every delivery, so an unread instance older than its kind's newest carries no information. The automatic context renders only each group's newest instance in full and folds the superseded ones into one summary line that frees their slots for live work; every Message stays durable in the Inbox.

Hints are at-least-once notification intent, coalesced per Member and rediscovered on restart/resume. A consumed or ignored hint does not create another turn until a later relevant durable change or recovery. Runtime recovery, error thresholds, and the two UI recovery actions remain Host behavior; they do not create ledger authority beyond their documented operations.

Automatic recovery acts only on two conservatively matched error families — transient network failures and rate limiting — and counts consecutive `agent/error` occurrences per Member rather than wakeups or error text: each of the first two occurrences schedules its own delayed wakeup, the third stands down and leaves the error with the operator, and a non-recoverable error cancels tracking outright. Only a clean turn end clears the count.

The Agent row menu carries two context actions over a live Member plus 历史会话 (session history) over every row. 重置 (reset) renews the Member Session through `clearMemberContext` via the durable rollover machinery — a new Session id with fork lineage back to the archived previous log, private memory untouched. 压缩 (compact) schedules one manual compaction through `compactMemberContext`: the Remote validates guards (enabled Member, no rollover in transition, an active handle, none already pending) and returns the unchanged status at once.

历史会话 reads through the `memberSessions` and `memberSessionTranscript` Remotes: every Session generation from the stored `parentSession` lineage — live one first, an unreadable ancestor flagged where the walk stops — and the selected generation's own events as a bounded, cursor-paged transcript. It never activates, resumes, or writes a Session, so archived generations stay browsable even where Harness refuses to open them as live conversations.

After a successful reset the Host privately notices only the reset Member: the notice names who triggered it, states the Session restarted empty while handle, settings, and private memory are unchanged, and directs the Member to re-orient from its injected memory and the durable Team history (`team_view`, `team_inbox`, `team_thread`) before continuing, asking the relevant teammates in a Thread reply or direct message instead of guessing. Nothing is broadcast; the notice is runtime intent, not a ledger Message, and a failed delivery only logs.

Renewal is an assignment seam only, and completion arms it: a `fresh` Member whose turn closes on the completion marker becomes armed, and it renews at its next Claim, Human atomic start, or teammate dispatch (an Inbox wake carrying unread direct work from a mention) — the renewal runs ahead of the dispatch, so the task lands in the fresh generation's system context. A DM is pure session relay and never spends the arm. Completing a Claim or accepting a Task never renews it — the live log keeps the fresh completion summary readable until that next assignment.

The Host makes the keep-or-renew call at the dispatch, and only while the Workspace has a designated Team Leader: one bounded model call scores the incoming assignment against the Member's recent work — its last five authored Messages plus the content of the Task it most recently claimed — and delivers into the live Session unread when the score clears 60%. Without a leader, or when the call fails or scores below the bar, it renews first. Only the dispatch being judged counts; the unread backlog never joins it.

The sender may still declare `keepContext` (a `team_message` start or reply, or a Human atomic start) to skip the judgement and force the keep; that exemption is bound to one ledger sequence, never a durable fact, so the next dispatch is judged again. `team_view` prints each Agent's context-start policy on its row, and every decision logs its score.

The matching read-time acceptance advice for a `fresh` Member says keep rather than roll over for the same reason, and the persona contract has the Member post each completion into the Task's Thread with a compact summary attached, so the result outlives every later reset in the durable ledger.

The background run then waits for the Member's idle boundary and forces one reduction through a transient `BasicCompactionEngine` carrying the Human-chosen summarization LLM in its config (absent falls back to the Member's routed model). A persistently busy Member drops the request with a log line only — conversation takes precedence — and a failed run surfaces through the same compaction failure slot the pressure policy reports through. Compaction commits no ledger operation; only the Session history it writes.

That Remote keeps its `team/member-session-renewed` operation schema and replay validation, so ledgers that recorded it still replay. During a model-initiated rollover the Member reads unavailable with a `context rollover in progress` diagnostic; when that Member's Session is embedded in the right rail, the Client follows the old→new binding once, and archived views never follow.

## Assembled acceptance
`npm run test:browser` uses a credential-free Harness Web scaffold. It verifies default taskless Thread creation, default-off Human 「作为任务」, Human promotion and Host reread, taskless header/Claim gating, invitation confirmation, Agent Inbox read/reply, Human Channel/Thread state, reload persistence, desktop/390×844/keyboard paths, Team exit, and ordinary DSH restoration. Real Agent-loop integration tests separately cover safe-boundary wake and direct, Activity, and body-free ordinary notification forms.
