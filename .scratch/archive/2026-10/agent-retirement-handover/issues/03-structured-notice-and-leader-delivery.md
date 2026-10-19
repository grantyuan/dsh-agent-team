# 03 — Structured retirement notice and leader-directed delivery

**What to build:** On a supervision retirement, the affected business Channel gets a headed structured notice that states the retirement cause and the retired Agent's completed work; it is delivered to the workspace's designated leader, and is only broadcast to the Channels when no qualifying leader exists.

**Blocked by:** None — can start immediately.

**Status:** done

Touchpoints: the current handover announcement builder in the supervisor; the supervision handover step in the Host; the ledger (a new completed-work projection, existing claim/task/thread reads, active claims for a member); the leader-directed delivery precedent used by the context-truncation notice.

- [x] A ledger projection `completedWorkForMember(memberId)` derives the retired Member's finished work from operations (closed/completed Tasks it owned, `done` Claims, Threads it participated in); it is unit-tested independently
- [x] The handover builds a structured notice synchronously inside the lifecycle enqueue (guaranteed delivery, same durability as today's announcement), containing: (a) retirement cause derived from the supervision trigger plus the retired handle; (b) completed work from the projection plus the released claims collected during handover; (c) a successor transition line (handle, same role, same preset, inherited settings and reach). It replaces the free-text announcement as the delivered content
- [x] Delivery: resolve the workspace's designated leader (enabled, `leader === true`, belongs to the workspace, is neither the retired Member nor its replacement) and send the notice as the human actor to that leader's Channel with `recipients: [leader.memberId]` (mirrors the truncation-notice path; the human-actor send bypasses the member-in-Channel gate)
- [x] Fallback: when no qualifying leader exists, broadcast the notice across the inherited Channels exactly as the current path does
- [x] The notice is produced exactly once per retirement; a retried supervision tick does not post a duplicate
- [x] Unit tests cover the projection, notice content, leader-directed delivery, the no-leader fallback, and no-duplicate on retry (the browser journey showing the notice in the Channel lands in ticket 06)

Evidence it works: after a retirement, the leader's Channel shows a headed notice with the cause and the retired Agent's completed work; with the leader archived/absent, every inherited Channel shows the same notice.