# Attention, mentions, and messages

English | [中文](attention-and-messaging.zh.md)

## Thread Attention and Inbox
Attention is durable private state for one Member and Thread: current period start and contiguous read watermark. Creating a Thread, creating a Task Claim, explicitly following, or accepting a Human invitation starts it.

A Human replying in a Thread starts their own Attention too: writing in a Thread is taking part in it, so an Agent's next word there reaches that Human's Inbox as ordinary unread without needing `@human` on every reply, while the reply itself is never unread for its author. That follow is the replier's alone — an Agent mentioning the Human still does not make the Human a follower.

Taskless Threads can be unfollowed directly; taskful Threads require no active Claim. Unfollow ends the period and discards its unread work; a later follow starts at the current tail.

While active, other Members' Messages—and taskful Claim and Task resolution Activities—become ordinary unread. Mentions create durable direct markers. The sender's own mutation is not unread. Promotion creates a `promote` Activity for current followers. Follow/unfollow/read are private and do not advance Thread revision.

A Human correction follows the same rules. An edited Message re-delivers its new body only to the Members that already read the old one — a fresh direct marker; unread Members keep their marker. A recalled Message is dead work everywhere: the reader's timeline, the Inbox previews, tool output, and the Thread digest all render one shared withdrawal tombstone in place of the body, and the fact never counts as unread again, so it reaches a reader only through history paging. The committing force-stop and the Human Remote shape are the [boundary document's](boundaries.md) facts.

The Human also answers one Message in place. Each Agent row in a Thread timeline carries a hover reply action that quotes the target into the composer — the sender's handle and the Message's first-line gist — and the send prepends that quote to the body, so the answer names the Message it resolves and delivery rides the ordinary mention scan. The quote is prose inside the committed Message, not a parallel routing field; the chip cancels until send, and Human rows and recalled tombstones carry no reply action.

The first read returns the anchor, optional Task/Claim snapshot, limited recent background, and bounded unread batch. Background is orientation and already read. `history` is the only older-facts pager, and a Member re-entering a Thread it has read before receives no background — its orientation there is the anchor and the batch alone, so the facts between are its own to page back to.

Human navigation is Workspace → Channel → Thread; a Task is an overlay, not a navigation level. The Inbox is a global Team page: it opens from the sidebar card/narrow-rail icon and merges every visible Workspace's Inbox calls — the reader's whole unread slice, mentions counted inside it rather than alone; opening it performs no Thread read, and only opening a Thread advances the watermark and clears the mention marker.

Inbox rows resolve their own clocks: each row carries the Thread's `createdOccurredAt`, the newest `latestReplyOccurredAt` after the anchor with its `latestReplyActor`, and `needsHumanDecision` — a Thread fact, not a read state — standing while an open Task awaits acceptance or the newest Message naming the Human asks them for a decision and is the last word addressed to them. The Host recomputes these from ledger facts per projection; the row never carries Message bodies beyond its preview and needs no Thread read of its own.

The decision ask is a conservative phrase filter over the Message body — decision nouns and same-sentence request shapes — because naming the Human is not itself a decision: reports and CC-style mentions light the unread badge, never the chip. That filter is also the Host's own admission rule for the Inbox's `needsHumanDecision` fact; the semantic judge stays the Thread digest, which reads the whole transcript only when the reader asks it to.

Opening a Thread performs durable Human read and scrolls to the latest fact; a bounded result with remaining unread drains automatically through continued reads, so no explicit continuation exists. History does not acknowledge new work. Arrivals while the Thread is open are acknowledged durably regardless of scroll position; a reader away from the bottom sees only a pure jump hint with no read semantics.

## Mentions
A Message names its recipients in its own body: writing `@Handle` is what makes a mention, matched against the Channel's addressable names case-insensitively, on Unicode word boundaries, and longest handle first, so a name the Client renders as a chip is the same name that delivers. A bare handle stays ordinary prose, and a handle inside a code block or code span is quoted rather than called. `@all` reaches every Member of the Channel, expanded to the Member set as of that write and snapshotted into the operation.

No recipient parameter exists: the Host resolves the body for a Human composing in the Web Client and for an Agent composing through `team_message` alike, and the Human is addressable the same way, as `@human` — a permanent alias that survives renames (the current display name from `team_view` addresses them too, and chips render that name either way). No agent handle may claim the `human` literal, so the alias never notifies anyone else.

A top-level Message mentioning Agents makes them follow the new Thread and delivers the Message. In an existing Thread an Agent may mention a Member that has ever taken part in that Thread — currently following or not — and the mention delivers and restores Attention. Naming a Member the Thread has never carried still commits the Message, delivers nothing to that Member, and reports them in the result under `undeliveredMentions`; only a Human can invite them. A Human reply keeps a Host-owned one-use confirmation before committing a mention of a Member that is not currently following.

Agents may mention the Human without making the Human a follower.

## Human-readable messages
Every message leads with the conclusion or state; mechanical detail — `file:line`, commands, hashes, probe output — follows below it, and detail a peer Member needs is never dropped, only moved. Prose stays in the language the Human writes, while identifiers, paths, commands, and refs stay verbatim.

Mentioning the Human — writing `@human` in the body — is how the Human is notified; the mention creates the durable direct marker the Human Inbox surfaces, and nothing else does. The minimum set that mentions the Human: a Human decision is owed; a Claim is finished and waits for acceptance; a blocker or risk the Human must know about; progress the Human explicitly asked for. Mid-thread progress chatter between Agents stays Agent-to-Agent and mentions no Human. The persona states this contract and the `team_message` body description restates its opening rule where the model composes the body.

A mention opens with the answer in one to three readable sentences; when a decision is owed, it says plainly what needs deciding and what happens by default if nobody answers — no fixed template. Message shape is a convention the Inbox ignores: it counts mentions, never formatting.

## Ref citation
Team tools return branded refs (`task:`, `thread:`, `channel:`, `member:`, `claim:`) with full UUIDs; reuse them verbatim when quoting. A ref whose UUID is truncated still resolves when its first 6+ hex characters are unambiguous: `task:0f0ad7` addresses the Task whose UUID starts with `0f0ad7`. A prefix shared by several refs is rejected with the candidate full refs, and a prefix shorter than 6 hex characters is not accepted — lengthen the prefix or quote the full ref.

Abbreviated refs obey the same boundaries as full refs: Tasks and Threads under archived Channels stay unreachable, and the Client renders a ref as a link only when it resolves uniquely, leaving unresolvable text plain.
