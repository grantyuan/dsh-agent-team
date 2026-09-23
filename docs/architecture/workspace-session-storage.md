# Workspace, Session, and storage reuse

English | [中文](workspace-session-storage.zh.md)

Team reads the existing Harness Workspace projection and does not create a second Workspace store or Session tree. The Client does not create Workspaces; users return to ordinary Session UI for that. Member sessions appear in the ordinary list, but cold Members cannot resume there because the ambient shipped roster lacks the private `team-member` preset; resume through the Team panel or restart with a healthy bundle.

For Workspace, Session, storage, persistence, or Thread Inbox changes, read the relevant Team source/tests and Harness `workspace.md`, `session.md`, `storage.md`, `persistence.md`, and `defensive-patterns.md`. The ledger remains the only Team authority, and recovery changes require failure-window or composition evidence.

The published bundle routes only `agent_team` to SQLite at `$DSH_HOME/storages/agent_team.sqlite`; every other domain keeps JSON. The medium is created fresh and an older `agent_team.json` is never read or migrated. The backend is a vendored fork under our own package name (`@wowyuarm/dsh-agent-team/sqlite-backend`, see `packages/agent-team/src/vendor/storage-sqlite/`); [`development/storage-and-delivery.md`](../development/storage-and-delivery.md) owns why the fork exists and the boot constraint a loader row must not reintroduce.

Member Sessions written before the 0.1.5 cut carry two bespoke message source kinds (`agent-team-context-handoff`, `agent-team-context-continuation`) that the released format's migration audit no longer admits. That refusal is fail-closed and precedes every plugin mount, so no read-time interception can recover those logs.

`packages/agent-team/src/session-remediation.ts` repairs them from the write side at startup instead: for each `enabled` Member it walks the Session binding and every recorded `parentSession` ancestor, and for an artifact the storage layer refuses whose rows carry one of those kinds it admits the source into the shipped shape (`plugin` + `snapshot` with named sections), proves the whole artifact through the format catalog's in-memory migration chain, and publishes one current-format sibling (`session.v3.jsonl.zstd`) beside the original with a hardlink-exclusive publish.

The original artifact is never written — the storage layer prefers the sibling, so deleting it rolls the repair back. An artifact refused for any other reason (an unclosed `turn/start`, a seq gap) is left byte-identical with a diagnostic; a readable generation whose history still holds the retired kinds is logged, not rewritten, because its storage layer may still append to it. Completion is cached in a separate `agent_team_remediation` domain — deliberately not in the `agent_team` domain, whose version gates the ledger schema.

Every per-Session stored read the Host performs goes through one seam, `packages/agent-team/src/stored-session-reader.ts`: one `open → read → close` cycle with the handle guaranteed closed, and every failure normalized into five categories — `missing`, `refused` (deterministic format refusals, carrying the artifact location), `corrupt`, `io`, and `unknown`.

Consumers choose policy by category and never match Harness error text: current-binding activation and checkpoint-seed resolution fail closed on any failure, carried-input replay skips only the deterministic `refused`/`corrupt` classes of a retired generation, handoff reconstruction and token measurement degrade, and the timeline truncates its lineage walk at an unreadable ancestor and reports `incompleteFrom` instead of silently ending. A DSH persistence-interface change is adapted in this one module.

The shipped JSONL backend throws its corruption family as plain `Error`s, so corruption is matched by that stable message prefix inside the seam; if the text ever changes, the failure degrades to `unknown`, which every consumer treats conservatively.

Member restart is the bounded self-heal for deterministic refusals: when activation failed with a `session-refused` diagnostic, `recoverMember` first runs the same startup remediation for that one Member and retries activation once when it repaired something; a walk that completed with nothing provably Team-written marks the diagnostic non-remediable, and the Client stops offering restart and shows the artifact path instead.

Activation diagnostics are structured — `AgentTeamMemberDiagnostic` carries a `class` (`session-refused`, `session-unreadable`, `preset-composition`, `rollover`, `runtime`, or `activation`), a detail, and where applicable the refused artifact location and the remediable verdict. Availability/presence remain the only user-facing states; diagnostics are projection-derived, never persisted, and the ledger stays the sole Team authority.
