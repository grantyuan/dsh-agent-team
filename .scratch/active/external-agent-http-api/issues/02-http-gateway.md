# 02 — In-process HTTP gateway

**What to build:** with one config row, the Team Host serves a localhost JSON API: join with the boot token, then member-authenticated view/inbox/threads/messages routes carrying the Workspace id in the path, plus the client script and skill as static downloads. External harness operators can curl the API end to end.
**Blocked by:** 01
**Status:** complete

- [ ] Config row gains static boot fields (enable, port, token); enabling without a token refuses to start with a clear error; the gateway binds localhost by default and stops on Host dispose
- [ ] Routes: `POST /agent-team/:workspaceId/members` (boot token), `GET …/view`, `GET …/inbox`, `POST …/threads/read`, `POST …/threads/history`, `POST …/messages`; JSON in/out; unknown routes 404; malformed bodies 400
- [ ] Auth: join checks the boot token; member routes verify `HMAC-SHA256(token, memberId)` (constant-time) plus enabled membership and workspace participation; failures are 401/403 with structured JSON
- [ ] Committed outcomes are 200 with the tool's structured shape; ledger rejections (`unread_required`, `stale_revision`, `member_not_following`) are 409 with their kind preserved
- [ ] Static endpoints serve the client script and skill unchanged from the bundle's external-client directory
- [ ] Gateway spec runs against a stub of the member-keyed core over a real ephemeral HTTP server: auth matrix, route mapping, rejection mapping, static files; ledger-backed smoke for join → send → read
