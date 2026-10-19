# 04 — LLM digest appendix on the retirement notice

**What to build:** When the model is reachable, the retirement notice gains a short plain-language summary of the retired Agent's final Session; when it is not, the notice ships without the appendix and the handover is unaffected.

**Blocked by:** 03.

**Status:** done

Touchpoints: the existing propose-only thread-digest module (shape, budget constants, cancellation); the retirement notice built in ticket 03; the retired Member's last Session transcript source.

- [x] A one-shot, propose-only digest reuses the thread-digest shape (bounded timeframe/tokens per its budget constants, cancellable) and never writes a Team fact or ledger operation
- [x] Input is limited to the retired Member's **last Session's last 20 transcript entries**; no other Session is read for the digest
- [x] The digest runs **outside** the ledger queue and never blocks or fails the handover; it is appended to the notice only when it resolves in time
- [x] Model selection = the retired Member's pinned selection, falling back to the Host default
- [x] Unit tests: the input is bounded to the last 20 entries of the last Session; a timeout/abort/failure yields the notice without an appendix; no ledger write occurs

Evidence it works: with the model reachable the notice carries a readable summary; with the model unreachable the notice is still delivered complete apart from the summary.

## Evidence

`retirementRecapDigestMessages(handle, entries)` folds the retired Member's own final-Session transcript into the digest message shape: the newest `DIGEST_RETIREMENT_ENTRY_LIMIT` (20) entries, the Member's own turns labelled by its handle, everyone else by lane. The recap call reuses `buildDigestMessages`/`parseThreadDigest` under the existing budget constants (`DIGEST_TIMEOUT_MS`, `DIGEST_MAX_TOKENS`), pick the Member's pinned model or the Host default, and never touches the ledger.

`startRetirementRecap` fires a floating promise from the give-up entry (`escalateSupervisedMember`); the resolved value is read zero-wait at the handover pass from a mutable slot. A digest that faults, times out, or never settles simply leaves the slot empty, and the notice ships without the appendix.

New unit tests in `packages/agent-team/tests/member-lifecycle.spec.ts`:

- `Retirement recap digest fold > keeps only the newest twenty entries and labels each lane by its author` — the fold keeps `line-5..line-24` of 25 synthetic entries and maps each lane (assistant→handle, user→`human`, team→`teammate`, notice/system→`notice`, tool-*→`tool`).
- `Member supervision handover > appends the final-Session recap to the retirement notice when the digest model answers` — the notice carries `**Final Session recap**` plus the parsed summary/key points, and the digest input stems from the retired Member's own final Session.
- `Member supervision handover > ships the retirement notice without a recap when the digest provider faults` — the notice is delivered complete apart from the recap section.
- `Member supervision handover > never blocks the handover on a hanging digest call` — the handover completes with the successor active while the digest call is still pending.

Verification: `npx tsc -p packages/agent-team/tsconfig.json --noEmit` exits 0; `npx vitest run packages/agent-team/tests/member-lifecycle.spec.ts` → 122 passed.