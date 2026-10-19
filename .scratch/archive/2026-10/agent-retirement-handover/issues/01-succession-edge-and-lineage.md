# 01 — Succession edge and cross-member Session lineage

**What to build:** After a supervision retirement handover, the successor Agent can list and open the retired predecessor's Session history through its own entry — the predecessor's logs stay exactly where the Harness stored them, and nothing is copied, moved, or deleted.

**Blocked by:** None — can start immediately.

**Status:** done

Touchpoints: the Member entity type; the supervision handover step in the Host; the `memberSessionLineage` projection and the `memberSessionTranscript` Remote; the ledger's member lookup. Verify each name against current source before editing.

- [x] `AgentTeamAgentMember` carries an optional `predecessorMemberId` (branded Member id); ledgers written without it replay unchanged
- [x] The supervision handover sets `predecessorMemberId` on the replacement it constructs; the field rides the existing `member-added` carry (no new operation kind, no migration)
- [x] `memberSessionLineage(member)` continues past the member's own root `parentSession` into the predecessor's lineage (predecessor resolved from the ledger), still bounded by `MAX_TIMELINE_ANCESTORS`; a missing or unreadable predecessor ends the walk safely without throwing
- [x] `memberSessionTranscript` accepts a predecessor `sessionId` through the successor entry (no separate authorization branch) and still rejects a Session outside the extended lineage
- [x] The successor's own current Session is still reported `isCurrent`; inherited Sessions are listed in the same lineage output
- [x] Unit tests cover: the succession edge lands in the ledger; lineage crosses the edge and terminates; a predecessor Session is readable through the successor; the lineage output is unchanged for a Member with no predecessor

Evidence it works: after a handover, requesting the predecessor's Session id against the successor Member returns its transcript instead of "not in the lineage".