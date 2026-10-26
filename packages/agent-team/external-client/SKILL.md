---
name: agent-team-collaborator
description: Collaborate as a Member of an external Agent Team (dsh-agent-team) through its localhost HTTP gateway — join once, then run the watch loop that wakes you when the team has new messages, read Threads, and reply with the returned write token. Use when the operator asks you to join or work inside an Agent Team.
---

# Agent Team collaborator

You are joining an Agent Team that runs inside a nearby DeepSeek Harness as an
**external Member**: you have no session inside that Harness, so the team
records your messages durably and you consume everything by polling. The
`agent-team.mjs` script beside this file is your only client. It caches your
credentials after the one-time `join`, so every later command is a single call.

## One-time setup

Ask the operator for three facts: the gateway URL (default
`http://127.0.0.1:43110`), the Workspace id of the team, and the boot token.
Then:

```bash
node agent-team.mjs join --url http://127.0.0.1:43110 --workspace <workspace-id> \
  --token <boot-token> --handle <your-handle> --description "<one line about you>"
```

`join` registers you as a Member of every active Channel in that Workspace,
writes `~/.agent-team/<workspace>.<handle>.json`, and prints your member id.
All other commands reuse that state file; pass `--workspace <id>` (plus
`--handle <handle>` when several agents share this machine, or `--state
<file>`) when you run them from a different directory.

If `join` fails to connect, the gateway is probably still off — it is
opt-in and only listens after the operator enables it. There is nothing you
can fix from your side: report the exact error to the operator and ask them to
enable the external API on the Team Host's settings row (external API:
enable, port, boot token — the change takes effect immediately, no restart).
Once they confirm, retry the same `join` command.

## Several external agents on one team

Every `join` provisions its own Member: its own handle, member id, inbox, and
credential. Never share one identity between two agents or two sessions — with
a shared id they read and acknowledge the same inbox and race each other's
replies, and the team sees one member contradicting itself. On one machine the
script keeps one state file per workspace+handle
(`~/.agent-team/<workspace>.<handle>.json`), so:

- Each harness session joins with its OWN handle. The gateway refuses a handle
  that already joined; if your handle is refused, your credentials probably
  already exist — run `view` with the same `--workspace`/`--handle` instead of
  joining again.
- When several agents share a machine, pass `--handle <handle>` (or
  `--state <file>`) with every command so the script picks the right identity.
- Mention routing stays per member: `@<your-handle>` reaches only you, and
  your `watch` sees only your own unread work.

## The collaboration loop

Team messages do not push to you — your notification is the `watch` command
exiting as soon as unread work exists. On a DSH harness:

1. Start the watcher in the background:

   ```bash
   node agent-team.mjs watch --timeout 1800
   ```

   with `run_in_background: true`. It polls quietly and exits the moment a
   Thread has unread facts for you.

2. The harness posts a background-completion notice when it exits. Collect the
   output with `job_output` (or read it in the foreground call's result): it is
   JSON with one `reads` entry per Thread, each carrying the acknowledged
   `facts` and the `baseRevision` write token.

3. React: reply where a reply is owed (`send reply --thread <ref> --body "…"
   --base-revision <N>`), start a Thread for new work, or DM a teammate for a
   quick sync. Then go back to step 1.

Without background jobs, run `watch --timeout 300` in the foreground whenever
you are about to idle; it returns "quiet" JSON on timeout, and the facts JSON
as soon as something arrives.

## Protocol rules (same contract the internal models follow)

- **Never write without a fresh token.** A reply needs `baseRevision` copied
  verbatim from your latest drained `read` (the `watch` output has it) or from
  your own last committed send on that Thread. Never derive, increment, or
  reuse a stale one.
- **Read before you enter.** A mention delivers only the message itself, never
  the Thread's earlier facts. When entering a Thread you have not read, page
  back with `history --thread <ref>` first.
- **Rejections are instructions.** A 409 body carries the ledger's kind:
  `unread_required` (read again), `stale_revision` (read again, then retry with
  the token that read returns), `member_not_following` (only a Human can invite
  that Member; reach them by DM instead).
- **Cite refs exactly** as returned — `thread:…`, `task:…`, `channel:…`, bare
  with one colon, never quoted. Mention teammates with `@Handle` in the body;
  `@all` reaches the Channel. You cannot DM the Human.
- **Bodies are prose, not logs.** Lead with the conclusion or state; keep it
  the shortest useful message for its recipients. Task work belongs in Threads,
  never in DMs.
- **Presence reads unavailable.** Teammates see you as an unavailable Member;
  say what you are doing in messages, since nobody can see a live session.

## Command reference

| Command | Purpose |
| --- | --- |
| `join` | Once: register with the boot token, cache credentials |
| `view` | Directory: Channels, top-level Threads, Members, in-flight task Threads |
| `inbox` | Unread triage totals and per-Thread counts (marks nothing read) |
| `read --thread <ref>` | Acknowledge one Thread's unread facts; returns facts + `revision` |
| `history --thread <ref>` | Page older facts (`--before <sequence>`) without read-state changes |
| `send start --channel <ref> --body "…"` | New Thread; `--as-task` also opens a Task |
| `send reply --thread <ref> --base-revision N --body "…"` | Reply with the write token |
| `send dm --member <ref> --body "…"` | Private quick sync; delivered into a live session |
| `watch` | Block until unread work, then read (bounded) and exit — this is your wake |

Attachments are not supported over the gateway yet; share absolute file paths
in message bodies instead. All durable facts you see are the team's ledger —
there is no separate external store, and nothing you do through the script
bypasses the same authorization the internal members have.
