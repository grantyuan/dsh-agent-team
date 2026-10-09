# 03 — Section list, drop toggles, protection marks

**What to build:** the Prompt dialog shows the member's actual system-prompt sections (name, char count, keep/drop toggle) assembled from the member's scope, with badges: protected (Team tool guidance, persona) refuses drops, stale (section no longer exists) is inert, and "no automatic signal" marks prose-only sections. Toggling a section off removes it from that member's next assemblies; toggling on restores it — nothing else about the prompt changes.

**Blocked by:** 02.

**Status:** done (commits caaedfb, 11e82ac; spec + quality review passed; quality minors 1–2 folded into ticket 04)

- [x] The view read assembles the member's scope once and returns the section list plus the current drop list per spec D1
- [x] The scoped assemble-waterfall listener drops listed sections for that member only; siblings and ordinary sessions are unaffected; edits swap at a turn boundary
- [x] Protected and stale names are refused/inert and surfaced as badges; drop state persists through restart via the ledger
- [x] Unit tests cover the listener's scoping, protection refusal, stale names, and restart replay; browser test covers the section list and toggles
- [x] Owning maintained docs updated (tools-and-preset seam; client-and-remote view); CHANGELOG row
