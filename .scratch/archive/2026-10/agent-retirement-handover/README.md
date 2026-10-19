# Agent retirement handover

- **Status:** closed 2026-10-18. All six tickets done; acceptance sweep green on the dev-linked build.
- **Last checked:** 2026-10-18.
- **Current frontier:** none — the work item is complete and archived.
- **Completion conditions (all met):**
  1. A supervision-handover successor reads the retired predecessor's full Session history through its own entry (`memberSessions` / `memberSessionTranscript`), via a durable succession edge and a relaxed lineage read — nothing moved, no log loss, gap, or access break.
  2. The affected business Channel carries an explicit structured retirement notice covering the retirement cause **and** the retired Member's completed work / released claims, delivered to the designated leader (broadcast only when no leader exists).
  3. The successor's configuration deep-equals the predecessor's on every inherited dimension (model, capabilities, prompt profile, context policy, leader flag, private-memory path, workspace, description, preset).
  4. Unit/integration tests plus a browser journey prove all three, with no regression on ordinary restoration.
- **Formal-doc exit:** durable conclusions verified present and accurate in `docs/architecture/host-authority.md` (handover/notice authority), `docs/architecture/workspace-session-storage.md` (succession edge and lineage read), and `docs/architecture/tools-and-preset.md` (preset/config inheritance), all with bilingual pairs, plus a `CHANGELOG.md` row; 2026-10-18 sweep, no gaps found.
- **Scope guard:** applies **only** to the supervision retirement handover path (`handOverSupervisedMember`). Human/teammate/doctor/policy resets and every other disposition path are untouched.

Decisions snapshot: [spec.md](spec.md). Milestone screenshots: [validation/README.md](validation/README.md).