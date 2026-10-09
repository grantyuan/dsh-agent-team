# 06 — Acceptance sweep and work-item exit

**What to build:** the whole feature is accepted end-to-end on the dev profile: a junior-programmer member with a small context window, a fresh-policy researcher member, a curated doc-writer member whose prompt carries only its relevant sections; screenshots and notes recorded, durable conclusions moved into the maintained docs, and the work item archived.

**Blocked by:** 01, 02, 03, 04, 05.

**Status:** done (sweep 2026-10-10 on fa73a46 + parity fix 93553f7; validation set and archive confirmed by Human)

- [x] `npm run test:browser` green; milestone screenshots at desktop and 390×844 stored under validation/ with Human confirmation
- [x] Full check ladder for the changed surfaces (host + client) per the development doc — green except `node scripts/audit-ui-parity.mjs`, whose two remaining errors are pre-existing outside this work item (2026-10-01 `sidebar.module.css .inboxCard`, 2026-10-07 `tasks.module.css` undefined `--dsh-alias-surface-primary`); the one error this work item introduced (`create.module.css .badge`) was fixed in 93553f7
- [x] Durable conclusions verified present in host-authority, tools-and-preset, and client-and-remote (bilingual pairs); process material without provenance deleted
- [x] Work item closed into `.scratch/archive/` per the .scratch lifecycle
