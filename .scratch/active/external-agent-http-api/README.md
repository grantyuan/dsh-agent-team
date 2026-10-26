# External agent HTTP API

**Status:** implemented and committed (2026-10-26: `0a4a619` feature, `b988f88` docs, `786db4b` live-settings fix, `d0073d7` settings-page controls, external-virtual-marker fix); awaiting operator acceptance before archive
**Last checked:** 2026-10-26
**Current frontier:** done. Three follow-up fixes landed after first use: the gateway controls are volatile Team settings reconciled live (`786db4b` — the first cut had no reachable enable path, which is why the operator's agent saw 43110 refused); the controls render in Team's own settings page (「我的资料」→「外部 Agent 网关」, `d0073d7` — the Host row is `auto: false`, so schema fields alone render nowhere); and external members are durably virtual (an `external` roster marker read by the restart restore, resume, recover, supervision reset, and the supervisor watch list — the operator reported dispatched tasks being double-executed because a restart built every enabled member a real session, and a permanent-stopped virtual member would have been archived-and-replaced by supervision). Nothing blocked. A daily-drive acceptance pass against the dev profile is the remaining operator step.
**Completion conditions:** an external harness can join a team through the gateway, poll the watcher, read threads, and send messages; all checks pass; maintained docs updated. ✅ met (20/20 new-spec tests green; full suite green modulo the three known-bad baselines).
**Formal-doc exit:** architecture section in `docs/architecture/host-authority.md` (+ zh), package README pair, root README pair, CHANGELOG — all done; close into `archive/2026-10/` after acceptance.

## Tickets

- `01-host-member-entry.md` — Host member-keyed entry points + external member creation
- `02-http-gateway.md` — in-process HTTP gateway, config, auth, static client endpoints
- `03-external-client.md` — `agent-team.mjs` watcher script + SKILL.md for external harnesses
- `04-docs.md` — maintained documents, READMEs, CHANGELOG
