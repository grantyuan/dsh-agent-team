# Agent retirement handover — decision snapshot

Frozen 2026-10-18, approved by the Human. This is the working context for implementation; current behavior is still defined by `packages/` source and tests.

## Problem

The Agent Team supervision chain ends at a **retirement handover**: a Member that stays abnormal after a fresh-context reset is archived and replaced by a same-role successor (`handOverSupervisedMember` in the Host). Today the successor:

- inherits only six fields (`workspaceId`, `description`, `presetId`, `model`, `capabilities`, `privateMemoryPath`) and starts with `state: 'enabled'`;
- cannot read the predecessor's Session history — `memberSessionLineage` is closed over the Member's own `parentSession` chain, and the handover deliberately "never touches its Session log";
- announces the handover as a plain free-text broadcast, with no retirement cause section and no completed-work section.

The four requirements below close those gaps for the supervision handover path **only**.

## Requirement 1 — history continuity via link-style inheritance

**Decision: link-style continuity.** Move nothing. Predecessor Session logs stay exactly where the Harness stored them, keyed by `sessionId`. The Team adds a durable succession edge plus a relaxed read gate; no second Session tree, no log copy, no data movement.

- **Succession edge:** add optional `predecessorMemberId?: AgentTeamMemberId` to the `AgentTeamAgentMember` entity. Set it on the replacement Member built in `handOverSupervisedMember`. Because `ledger.addMember` spreads `request.member` into the `team/member-added` payload (stripping only `prompt`, then re-adding it), the field lands in the ledger with **no new operation kind and no schema migration**.
- **Relaxed lineage:** `memberSessionLineage(member)` walks the Member's own `parentSession` chain as today; when it reaches the root (no further `parentSession`) and the Member carries `predecessorMemberId`, it continues into the predecessor's lineage (predecessor resolved via `ledger.getMember`), still bounded by `MAX_TIMELINE_ANCESTORS`. The walk must terminate safely when a predecessor is missing/unreadable.
- **Read gate:** `memberSessionTranscript` already resolves a requested `sessionId` against `memberSessionLineage`; once lineage crosses the succession edge, predecessor Sessions become readable through the successor entry automatically — no separate authorization branch.
- **UI label:** add `predecessorHandle?: string` to `AgentTeamMemberSessionSummary`; the `memberSessions` Remote resolves the predecessor Member's handle so inherited Sessions can be labeled as inherited (distinct from the successor's own).
- **No-loss precondition (verified):** `archiveSession` only hides a Session (an `unarchiveSession` exists, reversible), and `disposeMemberSession` disposes the live handle without deleting the persisted log. So inheritance carries no data-loss risk.

## Requirement 2 — Channel retirement notice

**Decision: structured text notice, leader-directed delivery.**

- **Content (deterministic, ledger-derived, guaranteed):** built synchronously inside `enqueueLifecycle` alongside the current handover step, so delivery is as durable as today's broadcast. It is a headed structured block containing:
  1. **Retirement cause** — derived from the supervision `trigger` (`abnormal-stop | consecutive-failures | failure-rate | context-oversize | hung`) using the existing cause mapping; plus the failed handle.
  2. **Completed work / results** — a new ledger projection `completedWorkForMember(memberId)` deriving the retired Member's finished work from operations (completed/closed Tasks it owned, `done` Claims, Threads it participated in), plus the `releasedClaims` collected during handover.
  3. Transition line identifying the successor (handle, same-role, same preset, inherited settings and reach).
- **Delivery:** send to the **designated leader** of the affected workspace, mirroring `notifyLeaderOfTruncation` — choose the leader's Channel in that workspace and `sendMessageAs` with `recipients: [leader.memberId]`. **Send as the human actor** (`agentTeamHumanActor()`): a member-actor send is gated by `requireMemberChannel` (the sender must already belong to the Channel), which the human-actor path bypasses and which matches the existing leader-delivery precedent.
- **Fallback:** only when **no qualifying leader exists** (an enabled Member with `leader === true` that belongs to the workspace and is neither the retired Member nor its replacement), fall back to today's broadcast across the inherited Channels.
- **LLM digest (supplementary, best-effort):** a propose-only, one-shot summary reusing the `thread-digest.ts` shape — it does **not** enter the ledger and is not a Team fact. Input is limited to **the last 20 entries of the retired Member's last Session**. It is queued **outside** the ledger queue and never blocks or fails the handover; when available it is appended to the notice.
- The "public notice module" in the business Channel is realized as this structured notice message posted into the Channel where the leader resides.

## Requirement 3 — full configuration inheritance

**Decision: no inherited dimension may be dropped.** The replacement built in `handOverSupervisedMember` must additionally inherit (carried through the `member-added` spread unless noted):

- `prompt` — deep-copied via `deepCopyPrompt` (the `addMember` helper), so the successor starts with the same prompt profile (dropped sections, custom paragraph, auto-prune switches).
- `leader` — the designated-leader flag carries over, preserving leader continuity when the retired Member was the leader.
- `contextStartPolicy` — `'continue' | 'fresh'`.
- `contextWindow` — pinned context-window override.

Already inherited today: `workspaceId`, `description`, `presetId`, `model`, `capabilities`, `privateMemoryPath`. `state` is forced to `'enabled'` (correct — the successor is active).

`AgentTeamAddMemberRequest` already supports the parallel fields; no request/ledger schema change is needed for the handover path, whose replacement is constructed directly rather than through the Remote request. Acceptance requires a deep parity check across every inherited dimension.

## Requirement 4 — verification

- **Unit/integration (agent-team):** lineage crosses the succession edge and terminates safely; a predecessor Session is readable through the successor entry; the notice contains cause + completed work; successor config deep-equals predecessor config on every inherited dimension.
- **Browser journey (`npm run test:browser`):** the successor entry lists and opens the predecessor's history; the Channel shows the retirement notice; the successor's settings match the predecessor's. Inspect `artifacts/browser/` at desktop and 390×844; confirm keyboard/focus and ordinary DSH restoration.

## Explicitly not doing

- No second Session tree, no log copy, no movement of Session files.
- No new operation kind and no migration for the succession edge (entity optional field only).
- No change to non-supervision reset/disposition paths.
- No speculative registry, fallback authority, or compatibility layer.

## Applicable scope

Supervision retirement handover only — currently the sole path that archives a predecessor and creates a same-role successor.