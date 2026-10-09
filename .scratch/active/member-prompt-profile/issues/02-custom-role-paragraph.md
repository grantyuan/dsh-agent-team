# 02 — Custom role paragraph end-to-end

**What to build:** the Human opens a member's Prompt dialog (new block from the editor) and writes a bounded custom role paragraph; from the member's next step its system prompt carries that paragraph, and editing it swaps in at a turn boundary without disposing the session. An empty paragraph means no registration and no visible change.

**Blocked by:** 01.

**Status:** ready

- [ ] Activation registers the member-scoped custom-prompt section per spec D1 when `customPrompt` is non-empty; edits swap it only at a turn boundary; disposal releases it
- [ ] Typed Remote read (`memberPromptView`) returns at least the stored custom paragraph; the Prompt dialog renders a textarea with the 8 KiB limit and a live counter
- [ ] Commit flows exclusively through the durable member update (non-optimistic UI; suspended/archived members render read-only)
- [ ] Unit tests cover registration, turn-boundary swap, empty-paragraph no-op, and size validation; browser test covers the Prompt dialog with the paragraph field
- [ ] Owning maintained docs updated (tools-and-preset for the section seam; client-and-remote for the view); CHANGELOG row
