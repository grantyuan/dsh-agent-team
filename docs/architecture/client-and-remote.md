# Typed Remote and Client boundaries

English | [中文](client-and-remote.zh.md)

## Typed Remote
`@Remote` annotations on the Team service are inputs to `scripts/generate-typert.mjs`, which uses Harness `WorkspaceAnalyzer` and `FaceModelEmitter` to emit Host and Client artifacts under `packages/agent-team/lib/`.

```text
Host face declaration → generate:typert → Typert Host + Remote client → ctx.remote.$mount(...) → Client remote service
```

`InvocationDescriptor` is local reflection metadata, not a wire message. Wire fields remain explicit typed values. Update declarations/tests, regenerate, and run typecheck/build; never hand-edit artifacts.

## Client plugin and slot composition
The external Client plugin leaves the shipped Shell as outer-layout owner. Team adds one footer action and shadows three seats:

```text
sidebar.footer.action       additive Team entry
sidebar.workspaces          Team shadow, priority -100
main (key conversation)     Team shadow, priority -100
sidebar.settings            Team shadow, priority -100
```

Activation mounts `agentTeamRemote`, waits for `remote.agentTeam`, then registers Team footer and mode shadows. `dsh.client.inject` describes the module graph but does not guarantee apply order or service readiness; use `ctx.slots.inject()` when a declaration may appear later.

A slot parent's `children` declaration is both render site and authority. Team's `sidebar.workspaces` shadow must not redeclare shipped `sidebar.workspaces.directoryFlow`; Harness SlotCore rejects duplicate live declarations. Do not copy private WorkspaceBrowser, ConversationRoot, Shell, or private CSS. Use public Harness services and exports, such as `ctx.workspaces.pickDirectory()`, and record limitations rather than depending silently on private implementation.

## Client data and presentation boundary
Client components do not reach into `ctx`, the operation ledger, or Host classes. Data and callbacks arrive through slot owner props, runtime props, declared stores, or injected faces. Presentation consumes Host projections and local navigation state and does not invent durable facts.

Human navigation is Workspace → Channel → Thread; a Task is a card/header overlay. New Channel composition defaults to taskless and exposes default-off 「作为任务」 for atomic Task creation. Taskless Threads retain reply/read/follow/Inbox behavior but gate status, Claims, and resolution controls until promotion. Promotion is non-optimistic and followed by rereading Thread and supplemental projections.

The Agent create and edit dialogs carry handle, description, model, and the task-start context block — a continue/fresh policy picker plus a context-window override. The block maps through the same absent-clears semantics as the model: the fresh policy and a parsed window ride the request only when set, an empty window input reads as "follow the route window", and an unparsable one renders a local alert that keeps the submit disabled. The editor echoes the newer of its committed prompt profile and the row snapshot, so a display-facts edit never clears the paragraph — exactly like `capabilities`.

The Prompt dialog is the paragraph's only editor: every open re-reads the dedicated `memberPromptView` Remote — the stored profile plus handle, description, and state — renders one textarea with a live UTF-8 byte counter mirroring the Host's 8192-byte ceiling, and commits one echo-complete member update that merges the paragraph into the read profile, so `droppedSections` and `autoPrune` survive while the stored model/capabilities/context overrides ride along because absent clears. A non-enabled Member renders read-only; the create form stages its paragraph locally until the member-added commit.

When the Member has a live session, the same view also carries its assembled section list: one row per section with its byte size, its mapped tool-call count inside the rolling usage window, and a keep checkbox — a live section renders checked, unchecking it moves the name into the request's `droppedSections`. Protected rows (the persona slots and the paragraph section) render checked and disabled, a stale residual name renders unchecked and enabled so re-checking clears it (after which the checkbox disables).

Prose-only rows carry the "no automatic signal" mark, zero-use tool-mapped rows carry a long-unused mark, and every toggle is local state merged into the same single non-optimistic save; a Member without a live session renders no section list at all.

The dialog also hosts the auto-prune surfaces: two switches — check unused sections at task start and auto-execute without asking — ride the same merged save with their absent-clears echo, and while the Host's `pruneCandidates` list is non-empty a bordered confirm panel renders it with two actions — remove the candidates, or remove them and turn both switches on — either committing through the same echo-complete payload with the candidates merged into the drops. A `usagePartial` read renders a hint that the counts may under-count.

Every commit through the dialog re-reads the stored drop list first and reconciles it as a diff against the dialog's own open-time read: a name the Human re-checked stays restored, a newly unchecked name stays dropped, and a sweep that landed after the read stays removed — one standing open across a full-auto sweep never restores what the Host already removed.

The dialog also offers one propose-only LLM curation: the Human types free-text requirements, and the Host builds one bounded call over the Member's live assembly, private skills catalog, identity, and those requirements, riding the Member's effective route through the same in-process completion seam (`ctx.llm.stream`) as the compaction summarizer — cancellable and hard-bounded at sixty seconds, with `modelUsed` naming the exact route in the result.

The parsed proposal — dropped section names, a skills allow-list subset of the live catalog, and a custom role paragraph draft — only backfills the form: the Human reviews, edits, and commits it through the same merged save, and a failed call renders inside the dialog without ever blocking manual editing. The create form offers no curation, because its input needs the live member scope a staged form does not have. The curation inputs are injectable by design — section texts and requirements ride the prompt verbatim, only bounded — so containment is propose-only parsing, re-validation against the same live snapshot, and the Human review every commit already requires.

The Thread page offers the same propose-only shape one call wider: `summarizeThread` reads the bounded Thread history through the ledger, builds one call over it on the Team's own configured route through the same `ctx.llm.stream` seam — cancellable, hard-bounded at sixty seconds, reporting `modelUsed` and the revision it read at — and answers with a plain-language digest: a summary, the turns that matter, and, when the Thread waits on the Human, the question plus the options the Messages actually proposed. The call is the reader's to start, never the page's: opening a Thread spends nothing, and the seat's own 生成速览 button is what buys the recap.

The route is read-side Team preference, never a Member fact write: the Workspace's enabled designated leader's pinned model first (a leader that pins nothing effectively holds the Host default, so the Host default runs); with no designated leader, the first enabled Workspace Member that pinned a model interprets through it; only when nobody pinned one does the call fall back to the Host default. The request is assembly-free by construction: the seam receives the digest instruction and the bounded transcript only — no tools, skills, MCP, memory or Member identity rides in.

The digest commits nothing and the panel holds no parallel authority: the reader's answer — a picked option or a written opinion — leaves through the ordinary durable `reply` path, so it lands as a Message like every other Human word; a failed call degrades the panel to a retry without touching the timeline.

The recap is browser-kept presentation memory, never a Team fact: one entry per Thread revision in `localStorage`, so a refresh answers the same Thread state without paying the model call twice and only a revision that actually moved forces a re-read; 重新生成 drops the Thread's entry and asks again.

The Inbox page carries a page-wide 全部已读 beside the sort control: it runs a Thread read over every row still holding unread, one durable read each, so a reader clears a whole page without walking it — it changes what the reader holds, never what the Host asks, and the Host's own admission rule decides what remains on the page afterwards.

The Human Client consumes the Host's Inbox projection (the 「收件箱 / Inbox」 queue: the merged per-Workspace badge and the page partitioned by Workspace then Channel, covering each reader's whole unread slice — mentions are counted inside it, never its admission rule, plus a second 「最近活跃」 slice — the Threads that reader has written a Message in, so a Thread they replied to is theirs whether or not they follow it, newest activity first, each Workspace's own slice bounded to ten while the merged page shows at most five, which an Agent's Inbox never carries); it never keeps a parallel Inbox authority, and opening the page acknowledges nothing.

Every Inbox row carries its own resolved clocks — `createdOccurredAt`, `latestReplyOccurredAt` with its `latestReplyActor`, and the `needsHumanDecision` flag (an open Task at `in_review`, or a Human-naming Message that asked for a decision with no Human word after it — a bare mention never lights it) — so the row needs no Thread read of its own; the page's 排序 control re-lays those rows per browser, a taste in `localStorage` that never becomes a Team fact.

Team navigation mode, Workspace selection, the last Channel/Thread, and the page position of the Inbox and Tasks lists are browser-persisted; unread, Attention, and what waits on the Human are Host-owned.

The Team sidebar keeps Channels/Agents ordering as a browser-only `localStorage` preference, merged over Remote defaults.

An embedded Member Session uses the shipped composer unmodified: the Team registers no member-session composer surface — no seat shadow, no trigger sources, no dock strip. rc.1 moved the trigger-menu overlay into `conversation.composer.bar`'s children (a shadowing entry would inherit — and strand — the overlay), and the Team's own command/member reference entry points carried no irreplaceable value over the shipped vocabulary, so they were removed together.

Ordinary and member sessions share the same composer and vocabulary. Reuse public primitives and `--dsw-*` tokens, keep CSS in CSS Modules, and preserve Team mode restoration and narrow layouts.
