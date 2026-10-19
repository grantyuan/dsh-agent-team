# 02 — Inherited-session labeling in the session list

**What to build:** The successor's Session list marks which Sessions were inherited from the retired predecessor, so the Human can tell inherited history apart from the successor's own Session, and can open an inherited Session directly.

**Blocked by:** 01.

**Status:** done

Touchpoints: the Member Session summary result type; the `memberSessions` Remote projection; the Client session list surface for a Member.

- [x] `AgentTeamMemberSessionSummary` carries an optional `predecessorHandle` (resolved predecessor handle)
- [x] The `memberSessions` Remote populates `predecessorHandle` for inherited entries and leaves the successor's own current Session unmarked
- [x] The Client session list shows inherited entries distinctly (labeled as inherited) while keeping the current Session marked as current; selecting an inherited entry opens its transcript through the successor entry
- [x] Unit/browser test: a successor with a predecessor lists inherited Sessions labeled and opens them; a Member without a predecessor shows no label and no behavior change

Evidence it works: the Human opens the successor and sees the predecessor's Sessions listed and labeled, and can open any of them.