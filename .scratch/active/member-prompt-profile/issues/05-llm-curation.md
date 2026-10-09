# 05 — LLM curation (propose-only)

**What to build:** in the Prompt dialog the Human types extra requirements and presses "Curate with LLM"; the Host makes one bounded model call using the member's effective model selection and backfills the dialog with a proposal — section keep/drop set (protected excluded), skills allow-list, and a draft custom role paragraph. Nothing durable changes until the Human reviews, edits, and saves through the normal update path. Failures surface as dialog errors and never block manual editing.

**Blocked by:** 03.

**Status:** done (commits b78a540, 792cf63; spec + quality review passed; edit-dialog-only per pre-authorized deviation — curation needs a live member scope and private skills catalog)

- [x] One-shot completion rides the in-process Harness completion seam (the same one compaction summarizers use), cancellable and time-bounded; model = pinned selection → Host default (create form: the selected model)
- [x] Input covers section names/texts, private skills catalog names, member handle/description/responsibility, and the Human's requirement text
- [x] Proposal backfills the form only — verified no direct commit path exists; skills proposal writes the existing capabilities skills allow-list on save
- [x] Timeout/abort/failure render as dialog errors with retry; suspended/archived members disable the button
- [x] Unit tests cover prompt construction boundaries, propose-only behavior, and failure surfaces; browser test covers the requirements input, backfill, and error state
- [x] Owning maintained docs updated (client-and-remote for the curation request); CHANGELOG row
