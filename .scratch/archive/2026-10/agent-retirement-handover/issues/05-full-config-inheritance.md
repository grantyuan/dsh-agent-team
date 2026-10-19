# 05 — Full configuration inheritance on the successor

**What to build:** The successor is configured exactly like the retired predecessor on every inherited dimension — no setting is dropped, reset to a default, or left inconsistent.

**Blocked by:** None — can start immediately.

**Status:** done

Touchpoints: the replacement construction in the supervision handover; the ledger's member-add carry and its prompt-copy helper; the Member entity fields.

- [x] The handover replacement carries, and the ledger persists, every inherited dimension: `model`, `capabilities`, `prompt` (deep-copied via the existing prompt-copy helper), `contextStartPolicy`, `contextWindow`, `leader`, `privateMemoryPath`, `workspaceId`, `description`, and `presetId`, with `state: 'enabled'`; identity is the only thing that changes (ids, handle, session)
- [x] A deep parity check proves the successor equals the predecessor on every inherited dimension; no field silently falls back to a default
- [x] When the retired Member was the designated leader, the workspace ends with exactly one leader after handover (no duplicate leader flag)
- [x] Unit tests cover the full-parity check and the leader-continuity case; an older ledger without these fields still replays

Evidence: [member-lifecycle.spec.ts](../../../../packages/agent-team/tests/member-lifecycle.spec.ts) `describe('Member supervision handover')` — "replaces an unrecoverable leader with a full-parity successor and exactly one surviving leader" drives the coercion chain on a fully-configured leader and asserts deep parity (`model`/`capabilities`/`prompt`/`contextStartPolicy`/`contextWindow`/`leader`/`workspaceId`/`description`/`presetId`/`privateMemoryPath`), exactly one enabled leader, and a cold-ledger replay restoring the successor's overlay. The pre-existing legacy test in [update-operations.spec.ts](../../../../packages/agent-team/tests/update-operations.spec.ts) ("carries Member prompt profile and context control…") proves an older ledger with none of these fields still replays and restarts.

Evidence it works: comparing the successor's stored Member to the predecessor's shows identical values on all inherited dimensions.