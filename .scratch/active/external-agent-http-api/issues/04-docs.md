# 04 — Maintained documents and release notes

**What to build:** an operator reading the maintained docs can decide whether the external-agent gateway fits their deployment, enable it, and bootstrap an external harness; the bundle's docs index, architecture set, package READMEs, and CHANGELOG all describe the shipped behavior.
**Blocked by:** 02 (03 for the skill/script wording)
**Status:** complete

- [ ] Architecture documentation covers the gateway as a Host transport: authority stays in the ledger, member-keyed entry points, external member semantics (never activated, poll-fed), the auth/trust model, and the watcher notification contract
- [ ] docs index / routing branches updated per `docs/AGENTS.md`; package READMEs (host, root) mention the feature; CHANGELOG entry added
- [ ] `.scratch` work item updated to complete and closed into the archive only after acceptance
