# Message center

English | [中文](message-center.zh.md)

The Inbox answers "what needs me"; the Message center answers "what was said". It is the Human's one read of the whole conversation record — every Thread in the visible Channels beside every Message addressed to or written by this person, searchable across Workspaces without opening a Thread — and it commits nothing: every row is a projection read, and the only writes it offers are the ordinary Human reply path and the Thread it navigates to.

## Entry and face

The center is the third global face beside Inbox and Tasks: one more card on the wide rail above the Workspace selector, and the third icon on the narrow rail (`IconBrowseOutlineRegular` — the record behind a frame, distinct from the Inbox queue's open bubble). It carries `aria-current="page"` while its page stands, obeys the same face discipline as the other two — selecting it clears the Channel/Thread faces, any other Team face takes the seat back, and the position is a durable navigation fact, so a reload reopens it.

A Thread opened from the center carries `messages` as its origin: Back reads 返回消息中心 and returns to the center, keeping the tab, the filters, and the scroll the reader left. The page needs no selected Workspace — it fans out one read per visible Workspace, like the Inbox and Tasks pages.

## One filter bar, two tabs

The page frame rides the shared conversation seat — the same header band, centered column, and state classes the Inbox uses. Under the header stands one toolbar: the two faces as a segmented tab pair — 所有讨论 (topics) and 我的消息 (messages) — over one shared filter row. The search field, the Channel select, and the since/until bounds apply to both tabs; only the direction select (发给我的 / 我发出的) belongs to the messages tab. Clearing is one 清除筛选 action while any filter stands.

The typed query and the applied query are two states: a keystroke lands in the field at once, the Host is asked once reading stops (250ms debounce). Filters are sent to the Host, not re-applied client-side — the Host's `messageCenter` search matches subject, body, and sender case-insensitively and returns the matched excerpt, so what the reader sees is what matched.

## The reads

Each tab reads one `messageCenter` call per visible Workspace and merges the slices by re-applying the Host's own order — the ledger sequence is one global position, so topics order by their newest fact and messages by their own sequence, both descending, without the Client inventing a second order. A Workspace slice that keeps `hasMore` continues through 加载更多, which pages each Workspace by its own returned cursor; the merge re-sorts, so appended rows land where the ledger puts them.

A partial failure keeps the rows it did get and reports through `role="alert"` under the list; a read that answered nothing and failed everywhere stays an unfetched face — the error state with its retry, not an empty list claiming the ledger holds nothing. While no Workspace roster has arrived the page holds 加载中 instead of pretending emptiness.

## Topics rows

A topics row is one Thread: the participant avatar stack (the Host resolves the senders in first-spoke order, so the row needs no roster), the Thread's subject line, the 待你决策 chip only when the Thread waits on the Human, the unread capsule, and the relative instant with its absolute `title`. The second line carries the search excerpt when a query matched and the subject otherwise, then the quiet facts — how many people joined in, whether this reader wrote in (我参与过), and the Task's live claim owners. Clicking a row selects its Workspace and opens its Thread.

## Message rows

A message row states one Message: a direction badge (发给我的 in the business ink, 我发出的 in the hairline), a 私信 badge on a direct Message, the sender's name, and the instant. The body line shows the matched excerpt or the trimmed body; the reply-context line quotes the Message this one answers — the Host derives it (the nearest earlier other-author Message, or the Thread's opening line), so the copy says 回复 or 讨论的第一条消息 and never claims an exact reply target.

A sent row carries its processing pill — 待处理, 已响应, or 已解决 — derived from ledger facts (a read watermark, a later reply, a claim, a closed Task), so it reads as an inference about work, never as a person's confirmation. Thread rows offer two actions: 回复 opens the inline composer, 定位到讨论 jumps into the Thread. A direct Message row offers neither: the ledger holds no Thread for it and the Human has no direct-Message lane — the row is the record, not a door.

## The inline reply

回复 opens one composer at a time, under the row it answers. Enter sends, Shift+Enter breaks the line, and an IME composition owns its Enter until it closes. Sending anchors on the Thread's current revision — the same `readThread`-then-`reply` path the Thread page uses, which also consumes that row's unread, because answering a message is reading it. The reply names the row's counterpart: the sender of a received Message, or the same Members a sent one named, never the reader.

A commit closes the composer, prints 回复已发出 on the row, and re-reads the tab so the new 我发出的 row appears without waiting for the next change wake; a refused reply keeps the composer and the draft and prints the failure on the row. The Host's confirmation detour (naming an unfollowed Member) retains the request id and token, so the second Enter continues the same intent instead of duplicating it.

## Locate

定位到讨论 opens the row's Thread with the row's ledger sequence as a durable navigation anchor (`focusSequence`), so a reload replays it. The Thread page runs a one-shot locate pass after its first read: it walks older history — bounded, the Host's maximum page — until the anchored fact is rendered, releases the bottom-follow margin so no prepended page yanks the viewport back, scrolls the row to the middle of the viewport, and flashes it once: fill and outline together, never colour alone, stilling under reduced motion. A sequence the pass cannot reach — a withdrawn row, or history that never holds it — is said once above the timeline while the Thread still opens and reads.
