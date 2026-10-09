# Spec — Member Prompt Profile and Context Control

Status: design approved by Human (2026-10-09). Snapshot of the converged decisions; implementation tickets live in `issues/`.

## Goal

1. Human can view and edit each Member's effective system prompt in the Web Client.
2. A Member only carries prompt sections relevant to its responsibility — not every skill or unrelated instruction.
3. On create/edit, the Member's default LLM curates the prompt (section toggles + skills allow-list + custom role paragraph) per its responsibility and the Human's requirements; the Human reviews before commit.
4. Usage frequency of tool-mapped sections is shown in the dialog; long-unused sections can be auto-pruned at the next task start (toggle + confirm semantics).
5. New (2026-10-09): per-Member context control — a task-start context policy (`continue` | `fresh`) and a Human-set context-window override clamping the member's pressure budgets.

## Non-goals

- Per-Member preset composition (preset stays shared; only section-level filtering within a Member's assembly).
- Replacing the whole system prompt wholesale (would strip Harness core behavior).
- Building the future Runtime Revision manifests system now (the seams below are its primitives).
- Semantic/embedding-based usage estimation for prose-only sections (marked "no automatic signal" instead).

## Approved decisions

### D1 — Approach A: ledger prompt profile + assemble waterfall filter

Per-Member filtering rides three Host-owned seams, isomorphic to the existing `tools.restrict` and skill-selection seams; no Harness modification:

- **Custom section registration**: on activation, register a scoped `systemPrompt.section({ name: 'team:member-prompt', order: last, text: customPrompt })` when the member has a custom prompt; edits swap it at a turn boundary (same `awaitTurnBoundary` pattern as tool policy).
- **Section drop listener**: a scoped `system-prompt/assemble` waterfall listener on the Member's agent scope filters `assembly.sections` by the member's dropped list. Team-owned sections (the nine Team tools' guidance) and Harness persona sections (`deployment:persona-*`) are protected — drop requests for them are ignored and flagged in the dialog.
- **Usage projection**: computed on demand (dialog open / auto-prune), never persisted. Section→tools mapping = scan each section's text for current known tool names (`ctx.tools.schemas(scope)`); usage = `tool/call` counts in the Member's session logs (across rollover generations via the existing archived-session read path; degrade to current generation with a marker if archived reads fail).

Rejected alternatives: per-Member preset variants (fragile registry interception, wrong granularity); full Runtime Revision manifests (does not exist yet — out of scope).

### D2 — Data model

`AgentTeamAgentMember` gains optional fields (ledger `team/member-added`; `team/member-updated` editable-field set extended from `handle, description, model, capabilities` to also include `prompt`, `contextStartPolicy`, `contextWindow`; old ledgers normalize absent → `undefined` = today's behavior):

```ts
export interface AgentTeamMemberPromptProfile {
  /** Shared section names to drop from this Member's assembly (default: none). */
  readonly droppedSections?: readonly string[]
  /** Bounded custom role paragraph appended to the system prompt (max 8 KiB). */
  readonly customPrompt?: string
  /** Auto-prune long-unused tool-mapped sections at task start; default off. */
  readonly autoPrune?: boolean
}

// on the member entity, flat like model?/leader?:
readonly prompt?: AgentTeamMemberPromptProfile
/** Task-start context policy; absent = 'continue' (current behavior). */
readonly contextStartPolicy?: 'continue' | 'fresh'
/** Human-overridden context window in tokens; absent = follow the route window. */
readonly contextWindow?: number
```

Validation: `contextWindow` positive integer, floor 8192; `customPrompt` ≤ 8 KiB; unknown/absent sections drop silently and show as "stale" in the dialog.

### D3 — Auto-prune semantics (toggle + confirm)

- Active only when the member's `prompt.autoPrune === true`; trigger point is the next task start (claim / Human atomic start) at the turn boundary.
- Candidates = tool-mapped sections with zero mapped calls within the window (last 20 completed turns or 14 days, whichever first; constants fixed initially).
- First hit does NOT prune silently: a Team notice goes to the Human inbox, the dialog shows the candidate list, and Human confirmation commits the drop via `member-updated`. The dialog offers "auto-execute from now on" (per-member full-auto upgrade; drops still ledger-recorded and traceable).
- Prose-only sections (no tool mapping) are never auto-pruned; Human-only.

### D4 — LLM curation (create/edit dialog)

- "Curate with LLM" button → Host-side one-shot completion, model = the member's effective selection (pinned model → Host default; on create, the form's selected model). Reuses the in-process Harness completion path (the same seam compaction summarizers use) — no hidden member, no new remote model route. Cancellable (signal) and time-bounded; failure surfaces as dialog error only.
- Input: full section list (name + text), current private skills catalog names, member handle/description/responsibility, and a free-text "requirements" box the Human fills.
- Output proposal: section keep/drop set (protected sections excluded), skills allow-list (writes existing `capabilities.skills.allow`), and a draft custom role paragraph. **The proposal only backfills the dialog form — nothing durable until Human reviews and commits through `member-updated`.**

### D5 — Context control (new 2026-10-09)

- `contextStartPolicy = 'fresh'`: when the Member claims a Task (or a Human atomic start assigns it), the Host automatically performs one context reset at the turn boundary through the existing serialized lifecycle queue (equivalent to the Human reset path, durably ledger-recorded). `'continue'` keeps today's behavior.
- `contextWindow`: effective window = `min(setValue, routeWindow)` inside `routeLimitsForAgent`; budgets still derive via the existing `contextLimits()` (handoff/hard caps unchanged in shape). Setting it small makes the handoff notice / hard compaction arrive earlier; setting it large can never exceed the provider's real capacity.

### D6 — Client UI

- Create form and Agent editor dialog gain a "Prompt" block (opens a dedicated Prompt dialog) and a "Context" block (policy select: continue / fresh-per-task; context-window number input with the current route window as placeholder).
- Prompt dialog: section list (name, char count, toggle, usage count, badges "long-unused" / "no automatic signal" / "protected" / "stale"), custom role paragraph textarea (8 KiB counter), autoPrune toggle, "Curate with LLM" button + requirements input, auto-prune candidate list with confirm.
- New typed Remote read `memberPromptView`: returns the Host-assembled section list (with usage projection and protection marks) + current profile. `AgentTeamUpdateMemberRequest` extended with `prompt`, `contextStartPolicy`, `contextWindow` (editor echoes stored intent when fields are absent, same pattern as capabilities).
- All mutations non-optimistic, durable through the Host; suspended/archived members render the Prompt dialog read-only.

## Error handling / invariants

- Drops, custom prompt, context policy/window are durable ledger facts; Host restart replays them; no optimistic UI.
- Protected sections refuse drops; stale section names are inert.
- Usage projection is read-only over session logs; archived-generation read failure degrades to current-generation counts with a visible marker.
- Curation is strictly propose-only; commit flows exclusively through `member-updated`.

## Testing

- Ledger: prompt/context field round-trips on added/updated, old-ledger normalization, protected-section refusal, `contextWindow` validation.
- Runtime: assemble-listener drop + custom section registration, turn-boundary swap, usage projection counts, `contextWindow` clamping, `fresh` policy triggering reset at the claim boundary.
- Client: Prompt dialog render/commit, curation backfill (no direct commit), context block; `npm run test:browser` with desktop + 390×844 screenshots.
- Docs: update `host-authority.md` (member profile and context budget ownership), `tools-and-preset.md` (section filter seam), `client-and-remote.md` (new Remote), bilingual pairs; CHANGELOG entry.

## Formal-doc exit

Durable conclusions move into the maintained docs listed in Testing before the work item closes into `.scratch/archive/`.
