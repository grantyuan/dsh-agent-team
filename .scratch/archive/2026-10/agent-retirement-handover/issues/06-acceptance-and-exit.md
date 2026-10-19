# 06 — Acceptance sweep and work-item exit

**What to build:** The whole feature is accepted end-to-end on the dev profile: a supervision retirement occurs, the successor lists and opens the predecessor's full history, the Channel shows the structured retirement notice, and the successor's settings equal the predecessor's; screenshots and notes are recorded, durable conclusions move into the maintained docs, and the work item is archived.

**Blocked by:** 01, 02, 03, 04, 05.

**Status:** complete

- [x] `npm run test:browser` green; the browser journey exercises the three verified behaviors — predecessor history accessible through the successor entry, the Channel notice complete and accurate, and successor/predessor config parity — with screenshots at desktop and 390×844 stored under `validation/` with Human confirmation
- [x] Full check ladder for the changed surfaces (Host + Client) per the development doc
- [x] Durable conclusions verified present in the maintained docs (candidate targets: host-authority for handover/notice authority, workspace-session-storage for the succession edge and lineage read, tools-and-preset for config inheritance) with bilingual pairs; CHANGELOG row
- [x] Work item closed into `.scratch/archive/` per the .scratch lifecycle