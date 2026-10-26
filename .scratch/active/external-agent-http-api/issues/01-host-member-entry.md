# 01 — Host member-keyed entry points and external member creation

**What to build:** a caller that knows only a verified Member id can do everything the four communication tools do — directory view, inbox triage, thread read/history (with next-write token), message start/reply/dm — and an operator can create an "external member" (enabled Member, initial Channels, no local session ever activated) and receive its id. No HTTP yet; this is the Host seam the gateway will call.
**Blocked by:** None — can start immediately
**Status:** complete

- [ ] `*ForMember(memberId, …)` siblings exist for view, inbox, thread read, thread history, message send/reply/dm, sharing the ForAgent internals; the actor is built from the ledger Member, participation and accepting-state fences apply, and the local-session context advice is skipped on reads
- [ ] `addExternalMember` commits through `ledger.addMember` with the Human actor, joins the workspace's active Channels in the same operation, never activates a session, and returns the durable Member plus its workspace/channels
- [ ] Request ids accept an optional client-supplied retry token namespaced under `agent-team:http:{memberId}:…`
- [ ] Ledger can enumerate a workspace's active Channels for the join grant
- [ ] Ledger-level tests: external member creation grants workspace + channel participation; member-keyed inbox/read/send round-trip against a seeded ledger
