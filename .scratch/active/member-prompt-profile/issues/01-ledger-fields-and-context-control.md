# 01 — Member ledger fields and context control

**What to build:** the Human opens the create form or the Agent editor dialog and sees a Context block: a task-start policy select (continue / fresh per task) and a context-window number input. Setting the window smaller makes that member's pressure budgets (handoff notice, hard-limit compaction) bite earlier; a fresh-policy member automatically gets a completely clean context when it claims its next task (or is atomically started by the Human), ledger-recorded like a Human reset. Members without these settings behave exactly as today.

**Blocked by:** None — can start immediately.

**Status:** done (commits f88e75d, 83cc4d3; spec + quality review passed)

- [x] `AgentTeamAgentMember` carries the three optional fields from spec D2 (`prompt`, `contextStartPolicy`, `contextWindow`) with validation (positive integer ≥ 8192 for the window; old ledgers without them replay unchanged)
- [x] `team/member-updated` accepts and durably replays the new fields; idempotency equality covers them
- [x] Typed Remote update request and Client create/edit forms carry the fields; the editor echoes stored intent when a field is absent (same pattern as capabilities)
- [x] Effective window = min(setValue, route window) inside the pressure-budget derivation; budgets derive through the existing single translation; a member with no override is unchanged
- [x] A member with fresh policy gets its context reset through the existing serialized lifecycle queue at the claim/atomic-start boundary, recorded durably; continue-policy members never trigger it
- [x] Unit tests cover ledger round-trip, old-ledger normalization, window validation/clamping, and the fresh-policy reset at the claim boundary; browser test covers the new Context block (desktop + 390×844)
- [x] Owning maintained docs updated in the same change (host-authority for budget ownership; client-and-remote for the new fields); CHANGELOG row

# 02 — Custom role paragraph end-to-end

**What to build:** the Human opens a member's Prompt dialog (new block from the editor) and writes a bounded custom role paragraph; from the member's next step its system prompt carries that paragraph, and editing it swaps in at a turn boundary without disposing the session. An empty paragraph means no registration and no visible change.

**Blocked by:** 01.

**Status:** ready

- [ ] Activation registers the member-scoped custom-prompt section per spec D1 when `customPrompt` is non-empty; edits swap it only at a turn boundary; disposal releases it
- [ ] Typed Remote read (`memberPromptView`) returns at least the stored custom paragraph; the Prompt dialog renders a textarea with the 8 KiB limit and a live counter
- [ ] Commit flows exclusively through the durable member update (non-optimistic UI; suspended/archived members render read-only)
- [ ] Unit tests cover registration, turn-boundary swap, empty-paragraph no-op, and size validation; browser test covers the Prompt dialog with the paragraph field
- [ ] Owning maintained docs updated (tools-and-preset for the section seam; client-and-remote for the view); CHANGELOG row

# 03 — Section list, drop toggles, protection marks

**What to build:** the Prompt dialog shows the member's actual system-prompt sections (name, char count, keep/drop toggle) assembled from the member's scope, with badges: protected (Team tool guidance, persona) refuses drops, stale (section no longer exists) is inert, and "no automatic signal" marks prose-only sections. Toggling a section off removes it from that member's next assemblies; toggling on restores it — nothing else about the prompt changes.

**Blocked by:** 02.

**Status:** ready

- [ ] The view read assembles the member's scope once and returns the section list plus the current drop list per spec D1
- [ ] The scoped assemble-waterfall listener drops listed sections for that member only; siblings and ordinary sessions are unaffected; edits swap at a turn boundary
- [ ] Protected and stale names are refused/inert and surfaced as badges; drop state persists through restart via the ledger
- [ ] Unit tests cover the listener's scoping, protection refusal, stale names, and restart replay; browser test covers the section list and toggles
- [ ] Owning maintained docs updated (tools-and-preset seam; client-and-remote view); CHANGELOG row

# 04 — Usage-frequency projection and toggle+confirm auto-prune

**What to build:** the Prompt dialog shows, per tool-mapped section, how often the member actually called the tools that section describes (across rollover generations when readable), flags long-unused candidates, and — when the member's auto-prune switch is on — offers the confirmed drop at the next task start: first hit notifies the Human inbox and asks, and an "auto-execute from now on" upgrade makes later drops automatic but still ledger-recorded.

**Blocked by:** 03.

**Status:** ready

- [ ] Section→tools mapping computed from current known tool names; usage counts folded from member session logs; archived-generation read failure degrades to current generation with a visible marker (spec D3)
- [ ] Candidate window = zero mapped calls within the last 20 completed turns or 14 days (whichever first), constants fixed in one place
- [ ] autoPrune=false (default): numbers and the "long-unused" badge show, nothing ever prunes automatically
- [ ] autoPrune=true: task-start trigger produces the inbox notice + dialog candidate list; confirmed drops commit via the durable member update; full-auto upgrade honored; prose-only sections never auto-pruned
- [ ] Unit tests cover mapping, counting, window edges, and the confirm/full-auto flows; browser test covers the usage column, badges, and confirm surface
- [ ] Owning maintained docs updated (host-authority for the projection; memory-and-context if it touches member context guidance); CHANGELOG row

# 05 — LLM curation (propose-only)

**What to build:** in the Prompt dialog the Human types extra requirements and presses "Curate with LLM"; the Host makes one bounded model call using the member's effective model selection and backfills the dialog with a proposal — section keep/drop set (protected excluded), skills allow-list, and a draft custom role paragraph. Nothing durable changes until the Human reviews, edits, and saves through the normal update path. Failures surface as dialog errors and never block manual editing.

**Blocked by:** 03.

**Status:** ready

- [ ] One-shot completion rides the in-process Harness completion seam (the same one compaction summarizers use), cancellable and time-bounded; model = pinned selection → Host default (create form: the selected model)
- [ ] Input covers section names/texts, private skills catalog names, member handle/description/responsibility, and the Human's requirement text
- [ ] Proposal backfills the form only — verified no direct commit path exists; skills proposal writes the existing capabilities skills allow-list on save
- [ ] Timeout/abort/failure render as dialog errors with retry; suspended/archived members disable the button
- [ ] Unit tests cover prompt construction boundaries, propose-only behavior, and failure surfaces; browser test covers the requirements input, backfill, and error state
- [ ] Owning maintained docs updated (client-and-remote for the curation request); CHANGELOG row

# 06 — Acceptance sweep and work-item exit

**What to build:** the whole feature is accepted end-to-end on the dev profile: a junior-programmer member with a small context window, a fresh-policy researcher member, a curated doc-writer member whose prompt carries only its relevant sections; screenshots and notes recorded, durable conclusions moved into the maintained docs, and the work item archived.

**Blocked by:** 01, 02, 03, 04, 05.

**Status:** ready

- [ ] `npm run test:browser` green; milestone screenshots at desktop and 390×844 stored under validation/ with Human confirmation
- [ ] Full check ladder for the changed surfaces (host + client) per the development doc
- [ ] Durable conclusions verified present in host-authority, tools-and-preset, and client-and-remote (bilingual pairs); process material without provenance deleted
- [ ] Work item closed into `.scratch/archive/` per the .scratch lifecycle
