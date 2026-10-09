# Member prompt profile and context control

- **Status:** design approved; tickets 01–06 written, none started.
- **Last checked:** 2026-10-09.
- **Current frontier:** 01 is the only unblocked ticket; 02–05 chain behind it (04 and 05 both depend on 03 and can run in parallel), 06 closes the item.
- **Completion conditions:** section filtering + custom prompt paragraph, LLM curation (propose-only), usage-frequency projection with toggle+confirm auto-prune, per-member task-start context policy and context-window override — all shipped through ledger/Host/Client with tests and browser acceptance.
- **Formal-doc exit:** move durable conclusions into `docs/architecture/host-authority.md`, `docs/architecture/tools-and-preset.md`, and `docs/architecture/client-and-remote.md` (bilingual pairs) before archiving.

Decisions snapshot: [spec.md](spec.md).
