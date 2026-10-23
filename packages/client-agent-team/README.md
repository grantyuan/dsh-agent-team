# @wowyuarm/dsh-agent-team/client

English | [中文](README.zh.md)

The optional Web Client for Agent Team. It adds Team mode through public Client slots and typed Host Remote methods; it does not own Team data or unread state.

## Human workflow

Team mode opens the Channels workspace by default. Human navigation follows Workspace → Channel → Thread; a Task is an optional card/header overlay on a Thread, not a navigation level. A top-level Channel Message defaults to a taskless Thread; the Human composer has a default-off **As task** control for atomic Task creation, and a taskless Thread can later be promoted by the Human through a durable Host mutation. Promotion rereads Host projections rather than synthesizing an optimistic Task. Taskless Threads retain reply, follow, mentions, Inbox, read, and history, while status, Claims, and Task-resolution controls appear only after a Task exists. The Client renders the Host's Inbox as a page but owns no unread state of its own. Opening a Thread performs a Host-owned `readThread` and shows the public Thread timeline, bounded history, any active Claims, and runtime risk for claimed Agents in an error state. The current Thread UI does not show follow/unfollow controls or Human follow/unfollow observations. Human messages render as literal text while Agent messages render through the shared Harness Markdown primitive; the timeline opens at the latest fact, follows new content only while the reader stays at the bottom, and keeps prepended history visually stable. Reading is fully automatic: a bounded read's remaining unread drains through continued Host reads (no manual read or continue-reading controls exist), and arrivals while the Thread is open are acknowledged durably regardless of scroll position — a reader away from the bottom sees only a pure “↓ N new update(s)” jump hint with no read semantics. Known branded Task refs in message bodies render in place as clickable `Task #N` links and resolve to their home Channel and Thread, including inside Agent Markdown and across Channels; model-style doubled-colon or uppercase spellings are canonicalized before lookup, and a code span holding exactly one ref renders as its link too. Code blocks and code spans holding more than a ref stay literal; unknown refs remain non-navigable. Each Agent row in a Thread timeline also carries a hover 回复 action that quotes the target Message — sender handle and first-line gist — into the composer above the draft; the send prepends the quote to the body so the answer names the Message it resolves, delivery rides the ordinary mention scan, and the chip cancels until send (Human rows and recalled tombstones carry no reply action).

The Thread's digest is generated on request, never automatically: the seat offers 生成速览, spends one propose-only Host model call when the reader asks, and when the Thread waits on the Human lays out the question with the options the Thread's own Messages proposed — picking one or writing an opinion sends an ordinary reply, and a failed call leaves only a quiet retry line. A Thread opening with no stored digest for its current state shows the button alone and spends nothing. The Inbox rows carry their own clocks (creation time, newest reply and its author) and a decision mark while the Thread waits on the Human, and the queue can be re-sorted per browser. Both slices (需要我 and 最近活跃) partition their own rows by Workspace and then by Channel, keeping the Host's admission order inside each group, and the sort key never moves a group. The header also carries 全部已读: it reads every Thread the queue still holds unread through, once apiece, so the reader's own mark clears across the page without walking it — the queue empties, a Thread this reader wrote in falls back into 最近活跃 while one they merely followed leaves the page, and the entry's dot follows the completed reads down.

The sidebar rows carry their own controls: the ⋯ row menu opens per-row editors, `updateChannel` renames a Channel's name/description and `updateMember` edits an Agent's handle/description and pins an optional per-Member provider/model (an absent model clears the override back to Host-default inheritance; changing the model of an active Member updates its live model selection in place, preserving the Agent and Session identities so subsequent requests use the new choice). The model picker reads the Host catalog through the session-independent `llm.models` RPC. Clicking an Agent card temporarily shows that Member's Session inside Team mode without discarding the selected Channel or Thread underneath. Both row menus also carry a danger **Archive** entry: `archiveMember` and `archiveChannel` hide the entity from every surface (durable data kept, active Claims released) behind a destructive-confirm dialog that states the no-restore-entry-point contract; archived rows disappear with the workspace-scope refresh, and mention candidates, member pickers, and Channel member lists all exclude archived Members. There is no sidebar archive list or restore entry this round.

The Client uses these Host projections and mutations:

- `readThread` acknowledges a Thread batch.
- `threadHistory` pages older facts without marking them read.
- `editMessage` re-stamps the Human's own Message body and re-delivers the correction to the Members that already read the old body.
- `recallMessage` retracts or deletes the Human's own Message; every reader then sees a withdrawal tombstone instead of the body. Committing either mutation force-stops the Members executing that instruction, while their other queued work continues.
- `summarizeThread` reads one propose-only plain-language digest of a Thread (summary, key turns, and any decision the Thread is waiting on); the call rides the Team's own configured model — leader first, then any member that pinned one, then the Host default — and `modelUsed` names the route; it commits nothing, and a decision the reader sends from it lands as an ordinary `reply`. The seat spends the call only when the reader presses 生成速览, never on open.
- `promoteThread` atomically attaches a real Task to a taskless Thread and records its structured `promote` Task activity.
- `resolveTaskRefs` resolves known branded Task refs to their display number and home Channel/Thread for navigation.
- `updateChannel` commits a Channel rename (name/description display facts).
- `archiveChannel` hides a Channel from every surface with its facts kept (no restore entry point yet).
- `updateMember` commits Agent handle/description edits plus an optional per-Member model override.
- `archiveMember` hides an Agent from every surface with its session log and private memory kept (no restore entry point yet).
The Host Remote also exposes `threadObservations` and `changeAttention`; the current Human Thread surface does not render these controls or observations. `changes` is a scoped streaming Remote consumed through Harness `ctx.remote.$stream()`. Each page shares one logical subscription per scope and Harness multiplexes it over the page's shared WebSocket, so opening several Team pages does not reserve ordinary HTTP connections for notifications. Every opening/reconnection baseline triggers a Host reread, including unchanged versions; leaving the last subscriber cancels that scope. Opening a Thread performs parallel initial reads and may perform a baseline catch-up, but private read acknowledgments cause no shared notification loop. See [architecture](../../docs/architecture/host-authority.md) for the authoritative scope and recovery contract.

Team mode, selected Workspace, the last selected Channel or Thread, and the page position of the Inbox and Tasks lists are persisted in browser storage, so returning to Team restores the previous location. Attention, unread counts, revisions, observations, Thread facts, and everything waiting on the Human remain Host-owned. Durable mutations are refreshed from Host after commit or rejection.

## Composition boundary

The package contributes the Team workspace, conversation, and footer slots through the public Harness slot APIs. It does not modify Harness source, replace shipped stores, or read the operation ledger. The `team-member` preset remains the only place where model-facing Team tools and guidance are enabled.

## Development

Run package checks from the repository root:

```sh
npm run typecheck
npm test
npm run build
npm run test:browser
npm run preview:ui
```

`test:browser` runs the deterministic, credential-free assembled Team journey. `preview:ui` loads isolated Host fixture state with model streaming disabled. Use the root `npm run preview` only for credentialed live Agent interaction.
