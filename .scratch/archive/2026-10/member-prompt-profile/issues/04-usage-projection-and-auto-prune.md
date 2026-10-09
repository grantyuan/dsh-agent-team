# 04 — Usage-frequency projection and toggle+confirm auto-prune

**What to build:** the Prompt dialog shows, per tool-mapped section, how often the member actually called the tools that section describes (across rollover generations when readable), flags long-unused candidates, and — when the member's auto-prune switch is on — offers the confirmed drop at the next task start: first hit notifies the Human inbox and asks, and an "auto-execute from now on" upgrade makes later drops automatic but still ledger-recorded.

**Blocked by:** 03.

**Status:** done (commits a010a5e, 398351d, d7b0a2d; spec + quality review passed; `autoExecutePrune` added as the D3 full-auto upgrade storage)

- [x] Section→tools mapping computed from current known tool names; usage counts folded from member session logs; archived-generation read failure degrades to current generation with a visible marker (spec D3)
- [x] Candidate window = zero mapped calls within the last 20 completed turns or 14 days (whichever first), constants fixed in one place
- [x] autoPrune=false (default): numbers and the "long-unused" badge show, nothing ever prunes automatically
- [x] autoPrune=true: task-start trigger produces the inbox notice + dialog candidate list; confirmed drops commit via the durable member update; full-auto upgrade honored; prose-only sections never auto-pruned
- [x] Unit tests cover mapping, counting, window edges, and the confirm/full-auto flows; browser test covers the usage column, badges, and confirm surface
- [x] Owning maintained docs updated (host-authority for the projection; memory-and-context if it touches member context guidance); CHANGELOG row
