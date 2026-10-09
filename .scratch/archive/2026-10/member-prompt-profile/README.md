# Member prompt profile and context control

- **Status:** closed 2026-10-10. All six tickets done and reviewed (two-stage review per ticket); acceptance sweep green.
- **Last checked:** 2026-10-10.
- **Current frontier:** none — the work item is complete and archived.
- **Completion conditions (all met):** section filtering + custom prompt paragraph, LLM curation (propose-only, edit-dialog-only), usage-frequency projection with toggle+confirm auto-prune, per-member task-start context policy and context-window override — all shipped through ledger/Host/Client with tests and browser acceptance.
- **Formal-doc exit:** durable conclusions verified present and accurate in `docs/architecture/host-authority.md`, `docs/architecture/tools-and-preset.md`, and `docs/architecture/client-and-remote.md` (bilingual pairs), 2026-10-10 sweep; no gaps found.
- **Residual note:** `node scripts/audit-ui-parity.mjs` still reports two errors that predate this work item (2026-10-01 `sidebar.module.css .inboxCard`, 2026-10-07 `tasks.module.css` undefined `--dsh-alias-surface-primary`); Human chose to leave them out of scope here.

Decisions snapshot: [spec.md](spec.md). Milestone screenshots: [validation/README.md](validation/README.md).
