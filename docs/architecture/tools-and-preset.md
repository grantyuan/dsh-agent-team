# Tools and preset

English | [中文](tools-and-preset.zh.md)

The explicit `team-member` preset is the only Team Member composition. It adds coding capability rows (shell, filesystem/search, web search and fetch, background jobs, the skill loader tool, todo, compaction), collaboration guidance/tools, Harness Workspace instruction discovery, and bounded private-memory context. Skill discovery itself is not a preset row: each Member's provider is Host-registered on its agent scope (see Host authority). Ordinary Sessions remain outside this roster and receive no Team prompt sections, tools, or Member memory.

Each Member can also carry a custom role paragraph: the ledger profile's `customPrompt`, capped at 8192 UTF-8 bytes (see Host authority). At activation `member-runtime.ts` registers it as one scoped `systemPrompt.section` named `team:member-prompt` on the Member's own agent scope, so it stays member-isolated and ordinary Sessions never see it. An edit swaps the section at the same turn boundary as tool and skill edits without renewing the Session; a blank paragraph or leaving the Team releases it. Humans edit it through the Web Client's Prompt dialog over the `memberPromptView` Remote.

Sections can also be dropped per Member. The ledger profile's `droppedSections` lists the section names a Human removed from that Member's next assembly; `member-runtime.ts` registers one scoped `system-prompt/assemble` waterfall listener per Member that filters those names from `assembly.sections`, swaps the list at the same turn boundary as the paragraph, and re-applies the stored list on every activation so drops survive restarts.

The listener keys on the assembly's turn signal: the agent loop is the only caller that assembles with one, so signal-less read-side assemblies such as `memberPromptView`'s still see the full list — dropped sections stay visible and recoverable in the dialog instead of masquerading as stale.

The protected set is defined once in `member-runtime.ts` (`isProtectedPromptSection`): the paragraph section itself, the deployment persona slots, and the Team tools' `tool:<name>` guidance sections — a drop request for a protected name is refused at consumption, rendering the row inert with the protected mark. The nine Team tools ship their guidance in tool descriptions rather than registered sections, so the `tool:*` entries are defensive: no live section carries those names, so they never render as dialog rows. Names that no live section provides are stored but inert — the dialog marks them stale.

`sectionToolMapping` is the shared primitive behind the dialog's "no automatic signal" mark: it scans each section's text for whole-word matches of the Member scope's tool schema names, so a section no current tool name maps to is prose-only.

The mapping also prices each section's usage. `memberPromptView` folds the Member's candidate window — the last 20 completed turns or 14 days, whichever the walk closes first (`member-section-usage.ts`, the one place the bounds live) — over the Member's session logs across the rollover lineage, and a section's usage is the sum of its mapped tools' calls inside that window. Each generation contributes only its own events (the fork-inherited prefix is excluded), an unreadable archive or a lineage past the walk cap degrades the fold to a `partial` view mark, and the counts are computed on read, never persisted.

Auto-prune rides that projection. The profile's `autoPrune` switch (default off) makes the Host sweep candidates — tool-mapped, unprotected, still-kept sections with zero window usage — at the same Human atomic-start boundary the fresh-start policy uses, through the same turn-boundary wait and serialized lifecycle queue. Ask mode (the default, and every sweep under a partial fold) only posts an `@human` inbox notice naming the candidates and leaves the drop to the Prompt dialog's durable member update.

The `autoExecutePrune` upgrade commits the drop itself through the same echo-complete shape under the Human actor, live-applies it at the settled boundary, and still posts the notice — every automatic drop stays ledger-recorded and announced. Prose-only and protected sections never become candidates.

The ten tools are defined in `packages/tool-agent-team/src/` — the six Team tools in `index.ts`, the four context tools in `context-tools.ts`; their contract is in [`tools.md`](../team-collaboration/tools.md). They mount under the isolated `team-member` preset. The Web Client is the only Human control surface and delegates every mutation through `ctx.agentTeam` typed Remote; do not restore a slash-command adapter.

Two of the four context tools are the engine's own definitions: `context-tools.ts` builds `context_rollover` and `context_checkpoint` through the engine's `createContinuityTools`, supplying Team vocabulary and the host adapter rather than its own prose or validation. `context_timeline` and `context_interrupt` stay Team-authored: the timeline never prints a citable ref for a non-restorable row, and the interrupt tool drives the ledger's pending-interrupt stack through Host-authority methods rather than engine state.

Member context self-management is Host-orchestrated on top of that preset. The `context_rollover` and `context_checkpoint` tools only validate and conclude/anchor the turn: at tool time the engine's gate refuses a `checkpointRef` the Member's own timeline does not list as restorable, and every ref that passes it is still prevalidated by the Host's seed resolver — the one the swap uses — so a ref that cannot succeed rejects as a model-visible error result instead of a fake `scheduled`, while the mutable guard set (jobs, route limits) is revalidated at the commit seam.

A single context-continuity coordinator (`ContextContinuityCoordinator` from `@wowyuarm/dsh-context-continuity`) is bound to the Member lifecycle by `context-continuity-host.ts`, which also supplies the engine's message codec with Team's plugin id and the frozen handoff prose. It watches each Member Session's events, folds rollover and checkpoint intent from the durable `tool/call`+`tool/result` pairs, and executes the swap through the serialized lifecycle queue.

The fold is the engine's own `contextContinuity` projection unit, registered once per host at Team service init. `context-projection.ts` supplies only the Team half:

- the host hooks that resolve `context-checkpoint-*`/`team-boundary-*` refs, classify a boundary as `team-boundary`, `handoff`, or `compaction`, attribute a claim boundary to its ledger Thread, and recognize Team notices;
- the adapter that reads the engine state.

The unit carries the fork cut, so a seeded child's inherited prefix folds back to the same reference. The swap then runs in order:

1. wait for true idle;
2. recheck the owned-jobs guard at the commit seam;
3. retire the old generation (dispose + archive, never delete);
4. commit the idempotent `team/member-session-rolled-over` operation;
5. activate a fresh Session — or a seeded Session for a checkpoint return, with the exact completed-turn prefix and its seed source as lineage parent;
6. deliver the handoff via steer and any carried non-Team input via followup.

Intent is one-per-unresolved-turn at the fold: a second successful rollover call inside the same unresolved turn is first-wins, and a pending whose turn ended is the ready (or, after a restart, recoverable) intent — the coordinator's process lock rejects a later call on the normal in-flight path. Only once that lock is gone (the transition failed or never ran) can a later-turn successful rollover replace the ended intent, which is the retry path that recovers the Member after a seam failure.

The admission gate (`agent/turn-stopping` + `agent/pre-step`) is armed only for the outgoing generation's Agent instance so later input cannot open another old-generation model request. Quiet checkpoint continuations deliver exactly once (per-member latch in-process, the projection's durable delivery record across restarts).

Recovery is log-derived: a restart replays pending intent and finishes the swap; a restart between the durable rollover commit and the new Session's activation reconstructs the handoff from the ledger-recorded previous Session — even when the new Session never materialized before the crash — and the reconstruction is idempotent (a generation whose own log already carries a handoff never receives a second one).

Carried-input replay after a restart is bounded: a current generation that already started its own turns skips the replay (its carried input was delivered or superseded while it ran), and an unreadable retired previous Session fails open with a warning for two bounded classes — log corruption (`corrupt session log`, whose torn tail the Host repairs) and a deterministic released-format refusal (`SessionFormatUnsupportedError`, which no retry can change) — while missing/IO and unknown causes stay fail-closed, so a retired generation's readability never gates the Member's activation once the current one has run.

Whether a Member Session has durable persisted content is decided through session-persistence inspection (which awaits in-flight retirement drains), never a bare metadata listing that races a suspend's final flush.

Context pressure is a second Host-owned coordinator (`pressure-policy.ts`) riding the same pre-step seam: budget thresholds derive from the live route's context window (200K handoff / 256K hard caps with a safety reserve); at the handoff budget one structured notice per generation advises a rollover (re-armed after one); at the hard limit the coordinator forces an in-place compaction and fails closed when it cannot prove progress; a provider context-overflow failure gets one bounded compact-and-retry sequence.

In-place hard compaction never cancels the owner, so it stays exempt from the rollover job guard that rejects switches over running or unreported-terminal jobs.
