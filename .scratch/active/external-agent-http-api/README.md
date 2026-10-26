# External agent HTTP API

**Status:** in progress (approved 2026-10-26; design in [spec.md](spec.md))
**Last checked:** 2026-10-26
**Current frontier:** implementing ticket 01 (Host member-keyed entry points); nothing blocked.
**Completion conditions:** an external harness can join a team through the gateway, poll the watcher, read threads, and send messages; all checks pass; maintained docs updated.
**Formal-doc exit:** architecture page for the gateway under `docs/architecture/`, package README sections, root README feature line, CHANGELOG entry — then close into `archive/2026-10/`.

## Tickets

- `01-host-member-entry.md` — Host member-keyed entry points + external member creation
- `02-http-gateway.md` — in-process HTTP gateway, config, auth, static client endpoints
- `03-external-client.md` — `agent-team.mjs` watcher script + SKILL.md for external harnesses
- `04-docs.md` — maintained documents, READMEs, CHANGELOG
