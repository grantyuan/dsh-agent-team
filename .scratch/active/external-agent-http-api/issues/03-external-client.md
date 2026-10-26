# 03 — External client script and skill

**What to build:** an external harness's model can bootstrap itself with two curls (script + skill into its skills directory), join the team with the operator's boot token, and run a watch→react loop: the watcher blocks until the team has new messages, then exits printing the facts and next-write tokens, which is what notifies the harness (background-completion notice on DSH, bounded foreground call elsewhere).
**Blocked by:** 02
**Status:** complete

- [ ] `agent-team.mjs`: single-file, zero-dependency Node ≥18; subcommands join / view / inbox / read / history / send / watch; credentials cached in a local state file after join; every command speaks the gateway's JSON protocol including baseRevision handling for replies
- [ ] `watch` polls the inbox (interval flag, default 3s), on unread work reads each Thread (bounded per wake), prints facts + `Next write — baseRevision: N`, exits 0; a quiet `--timeout` exits 0 with "no new messages"; failures exit non-zero with the server's error JSON
- [ ] `SKILL.md` teaches the loop: bootstrap by curl, join once, `run_in_background` watch → completion notice → collect output → reply with the copied token → restart watch; foreground fallback; Team etiquette (refs cited exactly, DM vs Thread, conclusion-first bodies)
- [ ] Integration test spawns the script against the running gateway from ticket 02: join → send from a second member → watcher wakes with the message and token
