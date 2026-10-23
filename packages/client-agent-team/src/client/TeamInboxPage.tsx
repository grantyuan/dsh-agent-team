import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentTeamInboxItem, AgentTeamMemberId } from '@wowyuarm/dsh-agent-team/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamKey } from './locales.ts'
import type { TeamConversationProps } from './slots.ts'
import { claimersLabel, formatAbsoluteTime, formatInboxTime, groupThreadRows, type TeamThreadWorkspaceGroup } from './team-formatters.ts'
import { namedAvatarOwners, TeamAvatarStack, type TeamAvatarHuman } from './TeamAvatarStack.tsx'
import { TeamCountBadge } from './TeamCountBadge.tsx'
import { drainThreadUnread } from './requests.ts'
import css from './conversation.module.css'
import inboxCss from './inbox.module.css'

interface TeamInboxRow {
  readonly workspaceId: WorkspaceId
  readonly workspaceTitle: string
  readonly item: AgentTeamInboxItem
}

interface TeamInboxPageProps {
  readonly useWorkspaces: TeamConversationProps['useWorkspaces']
  readonly loadInbox: TeamConversationProps['loadInbox']
  /** Wake source while the page is open: one scope-less subscription, shared with the badge poll. */
  readonly subscribeChanges: TeamConversationProps['subscribeChanges']
  /** The durable read the page-wide drain runs; opening a row still acknowledges through its Thread. */
  readonly readThread: TeamConversationProps['readThread']
  readonly selectWorkspace: TeamConversationProps['selectWorkspace']
  readonly selectThread: TeamConversationProps['selectThread']
  /** The Human's display name, from the Client's one identity projection. */
  readonly humanName: string
  readonly humanAvatarUrl?: string | undefined
  readonly t: TeamConversationProps['t']
}

/**
 * How many 「最近活跃」 rows the merged page may show. The Host bounds each
 * Workspace's own slice; this is the single bound across every Workspace on
 * screen, so the section stays the same size no matter how many are open — and
 * it stays a way back into work rather than a second queue, which is why it is
 * shorter than the queue the reader is actually being asked to work through.
 */
const RECENT_ROWS_LIMIT = 5

/**
 * How many times 「全部已读」 may refill the queue after clearing what it can see.
 * The Host bounds each Workspace slice by `limit` (100), so a backlog larger than
 * one slice only becomes visible as the rows above it are consumed; each pass
 * clears the visible slice and asks for the next. The cap keeps a growing feed
 * from turning the sweep into a permanent job.
 */
const MARK_ALL_PASS_LIMIT = 20

/**
 * Queue order, one total order across Workspaces: the Host's own keys —
 * mentions first, then the ledger sequence, then the Thread ref. Each Workspace
 * slice already arrives in this order, and it is also the Host's truncation
 * policy, so the merge re-applies it instead of inventing a second one: a row
 * that survived the cut on mentions must not sink below a merely newer row
 * after the merge. `newestSequence` is a global ledger position, so it stays
 * comparable across Workspaces.
 */
function compareInboxRows(left: TeamInboxRow, right: TeamInboxRow): number {
  return right.item.directCount - left.item.directCount
    || right.item.newestSequence - left.item.newestSequence
    || left.item.thread.threadRef.localeCompare(right.item.thread.threadRef)
}

/** The reader's own ordering of the queue — a per-browser taste, never a Team fact. */
type InboxSortKey = 'latestReply' | 'created' | 'unread' | 'mentions'

const INBOX_SORT_KEYS: readonly InboxSortKey[] = ['latestReply', 'created', 'unread', 'mentions']
const INBOX_SORT_STORAGE_KEY = 'dsh.agent-team.inbox-sort'
const INBOX_SORT_LABEL_KEYS = {
  latestReply: 'inboxSortLatestReply',
  created: 'inboxSortCreated',
  unread: 'inboxSortUnread',
  mentions: 'inboxSortMentions',
} as const satisfies Record<InboxSortKey, TeamKey>

/** Corrupted, foreign, or absent storage all degrade to the page's default order. */
function loadInboxSortKey(): InboxSortKey {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(INBOX_SORT_STORAGE_KEY)
    return INBOX_SORT_KEYS.find(key => key === raw) ?? 'latestReply'
  } catch {
    return 'latestReply'
  }
}

function saveInboxSortKey(key: InboxSortKey): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(INBOX_SORT_STORAGE_KEY, key)
  } catch {
    // Private mode and quota failures cost the taste, not the page.
  }
}

/** One comparable instant or count for the chosen key; unread slices keep
 * their own newest fact when a Thread has no reply yet. */
function inboxSortValue(row: TeamInboxRow, key: InboxSortKey): number {
  if (key === 'unread') return row.item.unreadCount
  if (key === 'mentions') return row.item.directCount
  const occurredAt = key === 'created' ? row.item.createdOccurredAt : row.item.latestReplyOccurredAt ?? row.item.createdOccurredAt
  const at = Date.parse(occurredAt)
  return Number.isNaN(at) ? 0 : at
}

/** Newest/heaviest first under the reader's key, the Host's own order as the
 * stable tiebreaker, so a sort change re-lays the rows without inventing a
 * different list. */
function sortInboxRows(rows: readonly TeamInboxRow[], key: InboxSortKey): readonly TeamInboxRow[] {
  return [...rows].sort((left, right) => inboxSortValue(right, key) - inboxSortValue(left, key) || compareInboxRows(left, right))
}

/** The two names a row is filed under; module scope, so grouping needs no
 * dependency of its own. */
function inboxRowKeys(row: TeamInboxRow): { readonly workspaceId: WorkspaceId; readonly workspaceTitle: string; readonly channelRef: string; readonly channelName: string } {
  return { workspaceId: row.workspaceId, workspaceTitle: row.workspaceTitle, channelRef: row.item.channelRef, channelName: row.item.channelName ?? '' }
}

/**
 * The Human Inbox: one Inbox call per visible Workspace, rendering the Host's
 * two slices — the unread queue (「需要我」, mentions counted inside it rather
 * than alone) and the 「最近活跃」 tail of Threads the reader took part in.
 * Both slices take rows from every visible Workspace, and each is partitioned
 * into a Workspace heading, then a Channel heading, with the reader's own sort
 * re-laying only the rows inside a group.
 * Opening the page never acknowledges anything — only a durable Thread read
 * advances the watermark and consumes a mention marker, so rows and the badge
 * drop after the Thread is opened through the existing auto-ack path. A Thread
 * holding unread is only ever in the queue: the Host already excludes it from
 * the tail, and this page never re-derives that judgement.
 */
export function TeamInboxPage({ useWorkspaces, loadInbox, subscribeChanges, readThread, selectWorkspace, selectThread, humanName, humanAvatarUrl, t }: TeamInboxPageProps) {
  const workspaces = useWorkspaces(state => state.items)
  const [rows, setRows] = useState<readonly TeamInboxRow[]>()
  const [recentRows, setRecentRows] = useState<readonly TeamInboxRow[]>([])
  // The Host names the Human's Member id on every Inbox row's payload; the
  // page keeps it so a row can draw that one actor from the Client's own
  // Human identity instead of the initials the stack gives every Agent.
  const [humanMemberId, setHumanMemberId] = useState<AgentTeamMemberId>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  // The reader's own ordering, persisted per browser: the page defaults to
  // newest-reply first and keeps whatever taste the reader picked.
  const [sortKey, setSortKey] = useState<InboxSortKey>(() => loadInboxSortKey())
  // The page-wide drain runs over every row that still holds unread in turn:
  // the button reports that work while it lasts, and one refusal stops the
  // sweep with one message rather than one error per row.
  const [markingAll, setMarkingAll] = useState(false)
  const [markAllError, setMarkAllError] = useState<string>()
  // Only the first refresh owns the loading surface; later wakes refresh the
  // rendered rows in place instead of flashing them back to skeleton.
  const loadedRef = useRef(false)
  // Wakes can start refreshes faster than their reads answer: without a
  // ticket, a slow read that started first can land after a fast second and
  // overwrite fresh rows with a stale queue. Only the newest refresh may write.
  const refreshTicket = useRef(0)
  // The page-wide drain reads the queue it can see, then re-reads it; a change
  // wake landing mid-sweep would race that read and pull back rows the sweep is
  // already clearing, so the sweep owns the queue while it runs.
  const markingRef = useRef(false)

  const refresh = useCallback(async (): Promise<readonly TeamInboxRow[] | undefined> => {
    const ticket = ++refreshTicket.current
    if (!loadedRef.current) setLoading(true)
    const results = await Promise.all(workspaces.map(async workspace => {
      const result = await loadInbox({ workspaceId: workspace.workspaceId, limit: 100 })
      return result.ok
        ? { ok: true as const, workspaceId: workspace.workspaceId, workspaceTitle: workspace.title, items: result.value.items, recent: result.value.recent, humanMemberId: result.value.humanMemberId }
        : { ok: false as const, message: result.error.message }
    }))
    if (ticket !== refreshTicket.current) return undefined
    const failure = results.find(result => !result.ok)
    setHumanMemberId(results.find(result => result.ok)?.humanMemberId)
    const asRows = (items: readonly AgentTeamInboxItem[], workspaceId: WorkspaceId, workspaceTitle: string): TeamInboxRow[] =>
      items.map(item => ({ workspaceId, workspaceTitle, item }))
    const queue = results.flatMap(result => result.ok ? asRows(result.items, result.workspaceId, result.workspaceTitle) : []).sort(compareInboxRows)
    setRows(queue)
    // The tail is one global bound rather than one per Workspace: the reader was
    // promised five Threads to step back into, and every Workspace's slice is
    // already capped on its own, so the merged list is trimmed here.
    setRecentRows(results.flatMap(result => result.ok ? asRows(result.recent, result.workspaceId, result.workspaceTitle) : [])
      .sort(compareInboxRows).slice(0, RECENT_ROWS_LIMIT))
    setError(failure?.ok === false ? failure.message : undefined)
    loadedRef.current = true
    setLoading(false)
    return queue
  }, [loadInbox, workspaces])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => subscribeChanges(undefined, update => {
    if (update.type === 'failed') {
      setError(update.message)
      return
    }
    if (markingRef.current) return
    void refresh()
  }), [subscribeChanges, refresh])

  const open = (row: TeamInboxRow): void => {
    selectWorkspace(row.workspaceId)
    selectThread(row.item.thread.threadRef, row.item.channelRef, row.item.task?.taskRef, row.item.taskNumber, 'inbox')
  }

  // The page rides the shared conversation seat: the same header band, 880px
  // reading column, responsive gutters, and scrollbar gutter as Channel and
  // Thread, so switching surfaces does not shift the content column.
  const totalUnread = rows?.reduce((sum, row) => sum + row.item.unreadCount, 0) ?? 0
  const totalMentions = rows?.reduce((sum, row) => sum + row.item.directCount, 0) ?? 0
  // Group order is the visible Workspace roster's own order; only the rows
  // inside each Channel group follow the reader's key, so re-sorting never
  // moves a group or changes which rows exist. The 「最近活跃」 five-row cap was
  // already cut in the Host's own order during refresh.
  const workspaceOrder = useMemo(() => workspaces.map(workspace => workspace.workspaceId), [workspaces])
  const queueGroups = useMemo(() => groupThreadRows(sortInboxRows(rows ?? [], sortKey), inboxRowKeys, workspaceOrder), [rows, sortKey, workspaceOrder])
  const tailGroups = useMemo(() => groupThreadRows(sortInboxRows(recentRows, sortKey), inboxRowKeys, workspaceOrder), [recentRows, sortKey, workspaceOrder])
  // What the page's own action can act on: the queue rows still holding unread.
  // The 「最近活跃」 tail never holds one — the Host keeps a Thread with unread in
  // the queue alone — so the drain is the queue's own backlog and nothing else.
  const rowsWithUnread = (rows ?? []).filter(row => row.item.unreadCount > 0)
  /**
   * Clear the whole backlog, one visible slice at a time. A row leaves the
   * rendered queue the moment its read lands, so the reader watches the list
   * shrink instead of a button that reports work it cannot show. Each pass then
   * re-reads the Host's queue: every Workspace slice is bounded, and a backlog
   * bigger than one slice only surfaces once the rows above it are consumed.
   * A refusal stops the sweep with one message — the read that failed is the
   * Host's own verdict, and repeating it would only multiply the same error.
   */
  const markAllRead = async (): Promise<void> => {
    if (markingRef.current) return
    let queue = (rows ?? []).filter(row => row.item.unreadCount > 0)
    if (queue.length === 0) return
    markingRef.current = true
    setMarkingAll(true)
    setMarkAllError(undefined)
    try {
      for (let pass = 0; pass < MARK_ALL_PASS_LIMIT && queue.length > 0; pass += 1) {
        for (const row of queue) {
          const taskRef = row.item.task?.taskRef
          const drain = await drainThreadUnread(readThread, { workspaceId: row.workspaceId, threadRef: row.item.thread.threadRef, ...(taskRef === undefined ? {} : { taskRef }) })
          if (drain.kind === 'refused') {
            setMarkAllError(t('inboxMarkAllReadFailed'))
            return
          }
          // A capped Thread still holds unread: leave its row where it is and
          // let the next pass pick the rest of it up.
          if (drain.kind !== 'drained') continue
          setRows(current => current?.filter(candidate => candidate.workspaceId !== row.workspaceId || candidate.item.thread.threadRef !== row.item.thread.threadRef))
        }
        const next = await refresh()
        // A newer refresh owns the page now; its rows are the truth, not this sweep's.
        if (next === undefined) return
        queue = next.filter(row => row.item.unreadCount > 0)
      }
      if (queue.length > 0) setMarkAllError(t('inboxMarkAllReadFailed'))
    } catch {
      setMarkAllError(t('inboxMarkAllReadFailed'))
    } finally {
      markingRef.current = false
      setMarkingAll(false)
    }
  }
  const human = humanMemberId === undefined
    ? undefined
    : { memberId: humanMemberId, name: humanName, ...(humanAvatarUrl === undefined ? {} : { avatarUrl: humanAvatarUrl }) } satisfies TeamAvatarHuman
  return <main className={css.surface} data-team-inbox>
    <div className={css.surfaceHeader}>
      <header className={css.headerRow}>
        <div className={css.headerCopy}>
          <h1>{t('inboxTitle')}</h1>
          {rows !== undefined && rows.length > 0 && <p className={inboxCss.headerMeta}>
            <span>{t('inboxHeaderThreads', { count: rows.length })}</span>
            {/* The one number the page is about leads the line; mentions join it
                only when the queue actually holds one. */}
            <span className={inboxCss.headerUnread}>{t('inboxHeaderUnread', { count: totalUnread })}</span>
            {totalMentions > 0 && <span>{t('inboxHeaderMentions', { count: totalMentions })}</span>}
          </p>}
        </div>
        {/* The queue's axis belongs to the reader, not the Host: newest reply
            leads by default, and whatever other order they pick rides this
            browser's storage. It is kept even on an empty queue — the taste is
            the page's control, not a filter over rows. The page-wide
            「全部已读」 leads it: clearing the whole backlog is about the queue the
            axis orders, while opening one row stays the reader's own way in. */}
        <div className={css.headerActions}>
          <Button size="sm" variant="outline" disabled={markingAll || rowsWithUnread.length === 0} onClick={() => { void markAllRead() }}>{markingAll ? t('inboxMarkAllReadBusy') : t('inboxMarkAllRead')}</Button>
          <div className={css.sortControl}>
            <label className={css.sortLabel} htmlFor="team-inbox-sort">{t('inboxSortLabel')}</label>
            <select
              id="team-inbox-sort"
              className={css.sortSelect}
              value={sortKey}
              onChange={event => {
                const next = INBOX_SORT_KEYS.find(key => key === event.target.value) ?? 'latestReply'
                setSortKey(next)
                saveInboxSortKey(next)
              }}
            >
              {INBOX_SORT_KEYS.map(key => <option key={key} value={key}>{t(INBOX_SORT_LABEL_KEYS[key])}</option>)}
            </select>
          </div>
        </div>
      </header>
    </div>
    <div className={css.timeline}>
      <div className={css.timelineContent}>
        {loading && rows === undefined && error === undefined && <div className={css.emptySurface}><p className={css.loadingState}><span className={css.loadingMark} aria-hidden="true" />{t('loadingInbox')}</p></div>}
        {!loading && rows === undefined && error !== undefined && <div className={css.errorState} role="alert"><span>{error}</span><Button size="sm" variant="outline" onClick={() => { void refresh() }}>{t('retry')}</Button></div>}
        {rows !== undefined && (rows.length === 0 && recentRows.length === 0
          ? <div className={css.emptySurface}>
              <div className={css.emptyState}>
                <strong>{t('inboxEmptyTitle')}</strong>
                <span>{t('inboxEmptyHint')}</span>
              </div>
            </div>
          : <>
              {queueGroups.length > 0 && <section className={inboxCss.section}>
                <h2 className={inboxCss.sectionTitle}>{t('inboxSectionNeedsMe')}<span className={inboxCss.sectionCount}>{rows.length}</span></h2>
                <InboxThreadGroups groups={queueGroups} t={t} human={human} onOpen={open} />
              </section>}
              {tailGroups.length > 0 && <section className={inboxCss.section}>
                <h2 className={inboxCss.sectionTitle}>{t('inboxSectionRecent')}<span className={inboxCss.sectionCount}>{recentRows.length}</span></h2>
                <InboxThreadGroups groups={tailGroups} t={t} human={human} onOpen={open} />
              </section>}
            </>)}
        {rows !== undefined && error !== undefined && <p className={css.error} role="alert">{error}</p>}
        {markAllError !== undefined && <p className={css.error} role="alert">{markAllError}</p>}
      </div>
    </div>
  </main>
}

/**
 * One slice's rows, partitioned by Workspace and then by Channel. The two
 * headings are what replaced the per-row 「Workspace / #Channel」 crumb: the
 * reader learns where a Thread lives once, at the group it sits under, instead
 * of reading it off every row. The counts close each heading so the reader never
 * counts rows to find out how much a group holds.
 */
function InboxThreadGroups({ groups, t, human, onOpen }: {
  readonly groups: readonly TeamThreadWorkspaceGroup<TeamInboxRow>[]
  readonly t: TeamConversationProps['t']
  readonly human: TeamAvatarHuman | undefined
  readonly onOpen: (row: TeamInboxRow) => void
}) {
  return <>
    {groups.map(group => <div key={group.workspaceId} className={css.group} data-team-inbox-group>
      <h3 className={css.groupTitle}>{group.workspaceTitle}<span className={css.groupCount}>{group.channels.reduce((sum, channel) => sum + channel.rows.length, 0)}</span></h3>
      {group.channels.map(channel => <div key={channel.channelRef} className={css.channelGroup}>
        <h4 className={css.channelTitle}>#{channel.channelName}<span className={css.groupCount}>{channel.rows.length}</span></h4>
        <div className={inboxCss.list}>
          {channel.rows.map(row => <InboxQueueRow key={`${row.workspaceId} ${row.item.thread.threadRef}`} row={row} t={t} human={human} onOpen={() => { onOpen(row) }} />)}
        </div>
      </div>)}
    </div>)}
  </>
}

/**
 * One queue row, shaped like the shipped two-line result row: who is on this
 * Thread leads in the gutter, the identity line answers which Thread this is,
 * how much is waiting, and when it last moved, and the gist sits under it on the
 * same column as evidence for that identity rather than as the row's subject.
 *
 * The gutter carries the one thing every row has — who is on the work, or who
 * moved a Thread nobody has claimed — so a Thread that merely arrived and one
 * that named the reader open on the same edge instead of the quieter one opening
 * on a slot reserved for a count it does not hold. It is the grammar the Channel
 * feed's Thread entry row already speaks, where the people on the work lead the
 * row.
 *
 * Before the queue admitted every unread Thread, each row was a mention and the
 * rows were interchangeable; now that named and ambient unread share one list,
 * the row has to carry that difference itself. The count closes the identity
 * line and only its ink changes — the shared capsule fill for a row that names
 * the reader, a hairline for one that merely moved. The two numbers behind that
 * ink (unread, mentions) reach assistive tech through the capsule's own name,
 * because a second visible count beside the first would cost the row the one
 * thing it needs to stay scannable.
 */
function InboxQueueRow({ row, t, human, onOpen }: {
  readonly row: TeamInboxRow
  readonly t: TeamConversationProps['t']
  readonly human: TeamAvatarHuman | undefined
  readonly onOpen: () => void
}) {
  const { item } = row
  const actor = item.newestActor
  const owners = item.claimOwners
  // The row's names come from the Client's Human identity where it applies, so
  // the chip's letter and the label's name move together on a rename.
  const namedOwners = namedAvatarOwners(owners, human)
  const namedActor = namedAvatarOwners([actor], human)[0]!
  const named = item.directCount > 0
  const countLabel = named
    ? t('inboxRowUnreadMentions', { count: item.unreadCount, mentions: item.directCount })
    : t('inboxRowUnread', { count: item.unreadCount })
  // The reply the reader is being pointed at, drawn with the one Human identity
  // every seat uses when the replier happens to be the reader themselves.
  const replyActor = item.latestReplyActor === undefined
    ? undefined
    : namedAvatarOwners([item.latestReplyActor], human)[0]!
  return <button type="button" className={inboxCss.row} data-named={named || undefined} onClick={onOpen}>
    {/* Who is on this Thread leads every row, in the slot the count used to
        reserve: the cluster is there whatever the row holds, so a row never
        opens on empty space and the one column the reader scans down answers
        「谁」 before it answers anything else. A Task's live owners answer it
        wherever there are any — the same stack, the same rule, and the same
        words the Channel feed's Thread entry row leads with — and a Thread with
        no live owner falls back to the person its newest fact came from, since
        that is all anybody knows about it. Which of the two a row shows is the
        Thread's own fact, never the section's: a Thread must not change shape on
        its way from the queue into the 「最近活跃」 tail. The stack's own label is
        what joins the control's accessible name — the avatars are presentational,
        the row's visible text is the Thread, not the queue. */}
    <span className={inboxCss.rowActor}>
      {owners.length > 0
        ? <TeamAvatarStack owners={namedOwners} label={claimersLabel(namedOwners, t)} human={human} />
        : <TeamAvatarStack owners={[namedActor]} label={t('inboxRowActor', { name: `@${namedActor.name}` })} human={human} />}
    </span>
    <span className={inboxCss.rowLine}>
      {/* Which Workspace and which Channel this Thread lives in is stated by the
          group headings above the row, so the identity line carries only the
          Task marker and the queue's own marks. */}
      <span className={inboxCss.rowCrumb}>
        {item.taskNumber !== undefined && <span className={inboxCss.rowTask}>{t('taskLabel', { number: item.taskNumber })}</span>}
      </span>
      {/* One capsule per row, closing the identity line beside the instant it
          shares its subject with. A 「最近活跃」 row holds no unread, so it
          renders no capsule at all — zero is the absence of a badge, not a badge
          reading zero — and the row keeps its shape without it. */}
      {item.needsHumanDecision && <span className={inboxCss.rowDecision}>{t('inboxRowDecision')}</span>}
      <TeamCountBadge count={item.unreadCount} tone={named ? 'solid' : 'hairline'} label={countLabel} />
      <time className={inboxCss.rowTime} dateTime={item.newestOccurredAt} title={formatAbsoluteTime(item.newestOccurredAt)}>{formatInboxTime(item.newestOccurredAt, t)}</time>
    </span>
    {/* The gist stays the second line's subject, and the row's clocks trail it
        in quiet tabular ink — creation, and the newest reply with its author.
        A seat too narrow for both yields the clocks entirely rather than fold
        the row: the same give the instant already makes one line above. */}
    <span className={inboxCss.rowSecond}>
      <span className={inboxCss.rowPreview}>{item.previewText}</span>
      <span className={inboxCss.rowMeta}>
        <span className={inboxCss.rowMetaItem} title={formatAbsoluteTime(item.createdOccurredAt)}>
          {t('inboxRowCreated', { time: formatInboxTime(item.createdOccurredAt, t) })}
        </span>
        {item.latestReplyOccurredAt !== undefined && replyActor !== undefined && <span className={inboxCss.rowMetaItem} title={formatAbsoluteTime(item.latestReplyOccurredAt)}>
          {t('inboxRowReplyBy', { name: `@${replyActor.name}`, time: formatInboxTime(item.latestReplyOccurredAt, t) })}
        </span>}
      </span>
    </span>
  </button>
}
