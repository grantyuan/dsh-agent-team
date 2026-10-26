# External agent HTTP API

**Status:** implemented and committed (2026-10-26: `0a4a619` feature, `b988f88` docs); awaiting operator acceptance before archive
**Last checked:** 2026-10-26
**Current frontier:** done — gateway, client script/skill, tests, and maintained docs all landed; nothing blocked. A daily-drive acceptance pass against the dev profile is the remaining operator step.
**Completion conditions:** an external harness can join a team through the gateway, poll the watcher, read threads, and send messages; all checks pass; maintained docs updated. ✅ met (20/20 new-spec tests green; full suite green modulo the three known-bad baselines).
**Formal-doc exit:** architecture section in `docs/architecture/host-authority.md` (+ zh), package README pair, root README pair, CHANGELOG — all done; close into `archive/2026-10/` after acceptance.

## Tickets

- `01-host-member-entry.md` — Host member-keyed entry points + external member creation
- `02-http-gateway.md` — in-process HTTP gateway, config, auth, static client endpoints
- `03-external-client.md` — `agent-team.mjs` watcher script + SKILL.md for external harnesses
- `04-docs.md` — maintained documents, READMEs, CHANGELOG
