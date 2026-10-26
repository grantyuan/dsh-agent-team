# Spec — external agent HTTP API (confirmed 2026-10-26)

Let an external harness's agent join an Agent Team as a Member and collaborate through an HTTP API, with a skill + watcher script that notifies the external harness of new Team messages. Decided after reading Host/tool/ledger sources; approved by the operator for the simplest quick path.

## Decisions

1. **Authority stays in `packages/agent-team`.** The gateway is another transport into the Host (like Remote and the Team tools), not a parallel authority. No new package; no Harness modification.
2. **Member-keyed Host entry points.** Every `*ForAgent(agent, …)` Host method only adapts a live Agent object to `actor = { kind: 'member', memberId, handle }` before calling the ledger, which is already memberId-keyed. Add sibling `*ForMember(memberId, …)` methods that build the actor from an authenticated memberId, plus `addExternalMember`. The ForAgent methods stay untouched.
3. **External member = a never-activated Member.** `ledger.addMember` is independent of session activation. A Member whose session is never activated is naturally external: presence reads unavailable, @-mentions land as unread (existing "Recorded, not delivered" semantics), and it consumes Team facts by polling. No new member kind.
4. **In-process HTTP gateway.** `node:http`, zero new dependencies, bound to `127.0.0.1` by default, started by the Host service when config enables it, stopped on dispose.
5. **Team id in the path.** Routes carry the Workspace id: `/agent-team/:workspaceId/…`. Workspace = the team the message targets.
6. **Auth.** One boot secret (`externalApiToken`):
   - `POST …/members` (join) requires the secret as bearer — self-serve join, operator-held token.
   - Member routes require `Authorization: Bearer HMAC-SHA256(secret, memberId)` plus the memberId — per-member, stateless, survives restart, constant-time compare. Trust model: whoever holds the boot secret can derive any member token; acceptable for a single-operator localhost deployment, documented.
   - Optional per-call `clientRequestId` becomes `agent-team:http:{memberId}:{clientRequestId}` for ledger idempotent retry; absent → a fresh UUID.
7. **v1 surface = the four communication tools**, mapped 1:1 to their structured tool output shape: view (`team_view`), inbox (`team_inbox`), threads read/history (`team_thread read`/`history`), messages start/reply/dm (`team_message`). Ledger rejections (`unread_required`, `stale_revision`, `member_not_following`) return as structured JSON with HTTP 409 — external agents follow the same read→token→write protocol as internal models. Claims, supervision, and leader-only watch are out of scope.
8. **External client = one zero-dependency Node script + one skill.** `agent-team.mjs` (subcommands `join/view/inbox/read/history/send/watch`, credentials cached in a state file) and `SKILL.md` live in the bundle's `external-client/` directory and are served by the gateway as static endpoints for one-curl bootstrap into an external harness's skills directory.
9. **Notification = watcher exit.** The watcher polls the inbox (default 3s) and exits when unread work exists, printing facts plus the next-write token. On DSH harnesses it runs via bash `run_in_background`, whose job-backed completion notice (`agent.inject()`) wakes the agent, which collects output with `job_output`. Harnesses without background jobs use a bounded foreground call. No server-side long-poll in v1.
10. **Delivery model.** v1 is poll-only; messages addressed to an external member accumulate as unread. `contextAdvice` enrichment from thread reads is skipped for external callers (no local session to measure).

## Out of scope (v1)

team_claim / team_supervise / team_watch, long-poll or webhook push, attachment upload, multi-host clusters, TLS, CORS.
