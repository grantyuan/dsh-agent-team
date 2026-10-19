import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { AgentTeamMemberId, AgentTeamPendingDecision } from '@wowyuarm/dsh-agent-team/types'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamKey } from './locales.ts'
import type { TeamConversationProps } from './slots.ts'
import { formatAbsoluteTime, formatInboxTime, groupThreadRows } from './team-formatters.ts'
import { namedAvatarOwners, TeamAvatarStack, type TeamAvatarHuman } from './TeamAvatarStack.tsx'
import { TeamCountBadge } from './TeamCountBadge.tsx'
import { drainThreadUnread, mintRequestId } from './requests.ts'
import css from './conversation.module.css'
import decisionsCss from './decisions.module.css'

interface TeamDecisionRow {
  readonly workspaceId: WorkspaceId
  readonly workspaceTitle: string
  readonly item: AgentTeamPendingDecision
}

interface TeamDecisionsPageProps {
  readonly useWorkspaces: TeamConversationProps['useWorkspaces']
  readonly loadPendingDecisions: TeamConversationProps['loadPendingDecisions']
  /** Wake source while the page is open: one scope-less subscription, like the Inbox page. */
  readonly subscribeChanges: TeamConversationProps['subscribeChanges']
  readonly readThread: TeamConversationProps['readThread']
  readonly changeAttention: TeamConversationProps['changeAttention']
  readonly reply: TeamConversationProps['reply']
  readonly changeTask: TeamConversationProps['changeTask']
  readonly selectWorkspace: TeamConversationProps['selectWorkspace']
  readonly selectThread: TeamConversationProps['selectThread']
  /** The Human's display name, from the Client's one identity projection. */
  readonly humanName: string
  readonly humanAvatarUrl?: string | undefined
  readonly t: TeamConversationProps['t']
}

/** The two reasons one row can be waiting, as the row's own chip reads them. */
const REASON_LABEL_KEYS = {
  decision_request: 'decisionsReasonQuestion',
  task_review: 'decisionsReasonReview',
} as const satisfies Record<AgentTeamPendingDecision['reason'], TeamKey>

/**
 * The reader's own ordering of the queue — a per-browser taste, never a Team
 * fact. The keys are the Inbox page's own three (its 「提及数量」 has no meaning
 * here: the queue row carries no per-reader mention count), so a reader who
 * learned the control on one page reads the other without learning a second.
 */
type DecisionsSortKey = 'latestReply' | 'created' | 'unread'

const DECISIONS_SORT_KEYS: readonly DecisionsSortKey[] = ['latestReply', 'created', 'unread']
const DECISIONS_SORT_STORAGE_KEY = 'dsh.agent-team.decisions-sort'
const DECISIONS_SORT_LABEL_KEYS = {
  latestReply: 'inboxSortLatestReply',
  created: 'inboxSortCreated',
  unread: 'inboxSortUnread',
} as const satisfies Record<DecisionsSortKey, TeamKey>

/** Corrupted, foreign, or absent storage all degrade to the page's default order. */
function loadDecisionsSortKey(): DecisionsSortKey {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(DECISIONS_SORT_STORAGE_KEY)
    return DECISIONS_SORT_KEYS.find(key => key === raw) ?? 'latestReply'
  } catch {
    return 'latestReply'
  }
}

function saveDecisionsSortKey(key: DecisionsSortKey): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(DECISIONS_SORT_STORAGE_KEY, key)
  } catch {
    // Private mode and quota failures cost the taste, not the page.
  }
}

/** One comparable instant or count for the chosen key; a Thread with no reply
 * yet falls back to its own creation instant, the way the Inbox row does. */
function decisionsSortValue(row: TeamDecisionRow, key: DecisionsSortKey): number {
  if (key === 'unread') return row.item.unreadCount
  const occurredAt = key === 'created' ? row.item.createdOccurredAt : row.item.latestReplyOccurredAt ?? row.item.createdOccurredAt
  const at = Date.parse(occurredAt)
  return Number.isNaN(at) ? 0 : at
}

/** The Host's own admission order — the longest wait leads — kept as the stable
 * tiebreaker so a sort change re-lays the rows without inventing a second list. */
function compareDecisionRows(left: TeamDecisionRow, right: TeamDecisionRow): number {
  const at = Date.parse(left.item.askOccurredAt) - Date.parse(right.item.askOccurredAt)
  return Number.isNaN(at) ? left.item.thread.threadRef.localeCompare(right.item.thread.threadRef) : at
}

function sortDecisionRows(rows: readonly TeamDecisionRow[], key: DecisionsSortKey): readonly TeamDecisionRow[] {
  return [...rows].sort((left, right) => decisionsSortValue(right, key) - decisionsSortValue(left, key) || compareDecisionRows(left, right))
}

/**
 * The Human decision queue: every Thread that still waits on the reader, taken
 * from every visible Workspace and partitioned by Workspace, then by Channel.
 * It is one page for one question — 「有什么事在等我决定」 — instead of a chip the
 * reader has to chase through the Inbox into each Thread. A row states the ask
 * in the words its author used and offers the two answers the Host accepts: a
 * reply, written here, and — for work awaiting acceptance — accepting it.
 * Opening the Thread stays available for anything that needs the full history
 * first, and two personal marks sit beside them: 「已读」 clears the reader's own
 * unread on the Thread without removing the row (the ask still waits), and
 * 「关注/取消关注」 toggles the Thread's Attention, which is the only thing that
 * gives a Thread an unread count for this reader at all.
 *
 * Which Workspace and which Channel a row belongs to is a heading rather than a
 * per-row crumb, and the reader's sort key re-lays the rows inside each Channel
 * group while the groups themselves hold their fixed order.
 *
 * The queue never answers anything by being opened: a row leaves only when the
 * Host's projection stops reporting it, which is what makes the page safe to
 * leave open while Agents keep working.
 */
export function TeamDecisionsPage({ useWorkspaces, loadPendingDecisions, subscribeChanges, readThread, changeAttention, reply, changeTask, selectWorkspace, selectThread, humanName, humanAvatarUrl, t }: TeamDecisionsPageProps) {
  const workspaces = useWorkspaces(state => state.items)
  const [rows, setRows] = useState<readonly TeamDecisionRow[]>()
  // The Host names the Human's Member id on every payload; the page keeps it so
  // a row that names the reader draws the one identity every seat draws.
  const [humanMemberId, setHumanMemberId] = useState<AgentTeamMemberId>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  // The reader's own ordering, persisted per browser: the page defaults to
  // latest-reply first and keeps whatever taste the reader picked.
  const [sortKey, setSortKey] = useState<DecisionsSortKey>(() => loadDecisionsSortKey())
  // The page-wide drain runs over every row that still holds unread in turn:
  // the button reports that work while it lasts, and one refusal stops the
  // sweep with one message rather than one error per row.
  const [markingAll, setMarkingAll] = useState(false)
  const [markAllError, setMarkAllError] = useState<string>()
  // Only the first refresh owns the loading surface; later wakes refresh the
  // rendered rows in place instead of flashing them back to skeleton.
  const loadedRef = useRef(false)
  // Wakes can start refreshes faster than their reads answer: without a ticket,
  // a slow read that started first can land after a fast second and overwrite
  // the queue with rows the reader already answered.
  const refreshTicket = useRef(0)

  const refresh = useCallback(async () => {
    const ticket = ++refreshTicket.current
    if (!loadedRef.current) setLoading(true)
    const results = await Promise.all(workspaces.map(async workspace => {
      const result = await loadPendingDecisions({ workspaceId: workspace.workspaceId })
      return result.ok
        ? { ok: true as const, workspaceId: workspace.workspaceId, workspaceTitle: workspace.title, items: result.value.items, humanMemberId: result.value.humanMemberId }
        : { ok: false as const, message: result.error.message }
    }))
    if (ticket !== refreshTicket.current) return
    const failure = results.find(result => !result.ok)
    setHumanMemberId(results.find(result => result.ok)?.humanMemberId)
    setRows(results.flatMap(result => result.ok
      ? result.items.map(item => ({ workspaceId: result.workspaceId, workspaceTitle: result.workspaceTitle, item }))
      : []))
    setError(failure?.ok === false ? failure.message : undefined)
    loadedRef.current = true
    setLoading(false)
  }, [loadPendingDecisions, workspaces])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => subscribeChanges(undefined, update => {
    if (update.type === 'failed') {
      setError(update.message)
      return
    }
    void refresh()
  }), [subscribeChanges, refresh])

  // Group order is the visible Workspace roster's own order; only the rows
  // inside each Channel group follow the reader's key.
  const workspaceOrder = useMemo(() => workspaces.map(workspace => workspace.workspaceId), [workspaces])
  const groups = useMemo(() => groupThreadRows(
    sortDecisionRows(rows ?? [], sortKey),
    row => ({ workspaceId: row.workspaceId, workspaceTitle: row.workspaceTitle, channelRef: row.item.channelRef, channelName: row.item.channelName }),
    workspaceOrder,
  ), [rows, sortKey, workspaceOrder])
  // What the page's own action can act on: the rows still holding unread. The
  // queue itself is not what the button empties — an ask nobody answered still
  // waits — only the reader's own unread marks go.
  const rowsWithUnread = (rows ?? []).filter(row => row.item.unreadCount > 0)
  const markAllRead = async (): Promise<void> => {
    if (markingAll || rowsWithUnread.length === 0) return
    setMarkingAll(true)
    setMarkAllError(undefined)
    try {
      for (const row of rowsWithUnread) {
        const taskRef = row.item.task?.taskRef
        const drain = await drainThreadUnread(readThread, { workspaceId: row.workspaceId, threadRef: row.item.thread.threadRef, ...(taskRef === undefined ? {} : { taskRef }) })
        if (drain.kind === 'refused') { setMarkAllError(t('inboxMarkAllReadFailed')); break }
      }
    } catch {
      setMarkAllError(t('inboxMarkAllReadFailed'))
    } finally {
      setMarkingAll(false)
      void refresh()
    }
  }
  const human = humanMemberId === undefined
    ? undefined
    : { memberId: humanMemberId, name: humanName, ...(humanAvatarUrl === undefined ? {} : { avatarUrl: humanAvatarUrl }) } satisfies TeamAvatarHuman
  return <main className={css.surface} data-team-decisions>
    <div className={css.surfaceHeader}>
      <header className={css.headerRow}>
        <div className={css.headerCopy}>
          <h1>{t('decisionsTitle')}</h1>
          <p>{rows === undefined || rows.length === 0 ? t('decisionsSubtitle') : t('decisionsHeaderCount', { count: rows.length })}</p>
        </div>
        {/* The queue's axis belongs to the reader, not the Host: the newest
            message leads by default, and whatever other order they pick rides
            this browser's storage. The control stays on an empty queue too —
            the taste is the page's own, not a filter over rows. The page-wide
            「全部已读」 leads it, because clearing the backlog is about the whole
            queue the axis orders rather than about one row. */}
        <div className={css.headerActions}>
          <Button size="sm" variant="outline" disabled={markingAll || rowsWithUnread.length === 0} onClick={() => { void markAllRead() }}>{markingAll ? t('inboxMarkAllReadBusy') : t('inboxMarkAllRead')}</Button>
          <div className={css.sortControl}>
            <label className={css.sortLabel} htmlFor="team-decisions-sort">{t('inboxSortLabel')}</label>
            <select
              id="team-decisions-sort"
              className={css.sortSelect}
              value={sortKey}
              onChange={event => {
                const next = DECISIONS_SORT_KEYS.find(key => key === event.target.value) ?? 'latestReply'
                setSortKey(next)
                saveDecisionsSortKey(next)
              }}
            >
              {DECISIONS_SORT_KEYS.map(key => <option key={key} value={key}>{t(DECISIONS_SORT_LABEL_KEYS[key])}</option>)}
            </select>
          </div>
        </div>
      </header>
    </div>
    <div className={css.timeline}>
      <div className={css.timelineContent}>
        {loading && rows === undefined && error === undefined && <div className={css.emptySurface}><p className={css.loadingState}><span className={css.loadingMark} aria-hidden="true" />{t('loadingDecisions')}</p></div>}
        {!loading && rows === undefined && error !== undefined && <div className={css.errorState} role="alert"><span>{error}</span><Button size="sm" variant="outline" onClick={() => { void refresh() }}>{t('retry')}</Button></div>}
        {rows !== undefined && (rows.length === 0
          ? <div className={css.emptySurface}>
              <div className={css.emptyState}>
                <strong>{t('decisionsEmptyTitle')}</strong>
                <span>{t('decisionsEmptyHint')}</span>
              </div>
            </div>
          : <div className={decisionsCss.groups}>
              {groups.map(group => <section key={group.workspaceId} className={css.group} data-team-decision-group>
                <h2 className={css.groupTitle}>{group.workspaceTitle}<span className={css.groupCount}>{group.channels.reduce((sum, channel) => sum + channel.rows.length, 0)}</span></h2>
                {group.channels.map(channel => <div key={channel.channelRef} className={css.channelGroup}>
                  <h3 className={css.channelTitle}>#{channel.channelName}<span className={css.groupCount}>{channel.rows.length}</span></h3>
                  <div className={decisionsCss.list}>
                    {channel.rows.map(row => <DecisionRow
                      key={`${row.workspaceId} ${row.item.thread.threadRef}`}
                      row={row}
                      human={human}
                      readThread={readThread}
                      changeAttention={changeAttention}
                      reply={reply}
                      changeTask={changeTask}
                      onAnswered={() => { void refresh() }}
                      onOpen={() => {
                        selectWorkspace(row.workspaceId)
                        selectThread(row.item.thread.threadRef, row.item.channelRef, row.item.task?.taskRef, row.item.taskNumber, 'decisions')
                      }}
                      t={t}
                    />)}
                  </div>
                </div>)}
              </section>)}
            </div>)}
        {rows !== undefined && error !== undefined && <p className={css.error} role="alert">{error}</p>}
        {markAllError !== undefined && <p className={css.error} role="alert">{markAllError}</p>}
      </div>
    </div>
  </main>
}

/**
 * One waiting decision, drawn as the ask rather than as a pointer to it: who is
 * waiting leads, the provenance line says which work and why it is here, the
 * ask speaks in its author's own words, and the answers sit under it. A row
 * keeps its own draft and its own in-flight state, so answering one decision
 * never disturbs another the reader is halfway through.
 */
function DecisionRow({ row, human, readThread, changeAttention, reply, changeTask, onAnswered, onOpen, t }: {
  readonly row: TeamDecisionRow
  readonly human: TeamAvatarHuman | undefined
  readonly readThread: TeamConversationProps['readThread']
  readonly changeAttention: TeamConversationProps['changeAttention']
  readonly reply: TeamConversationProps['reply']
  readonly changeTask: TeamConversationProps['changeTask']
  readonly onAnswered: () => void
  readonly onOpen: () => void
  readonly t: TeamConversationProps['t']
}) {
  const { item } = row
  const taskRef = item.task?.taskRef
  const [composing, setComposing] = useState(false)
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  // The writer must hold no unread work before any Thread write commits, so
  // every answer reads the Thread through first and replies against the
  // revision that read returned.
  const drainUnread = async (): Promise<number | undefined> => {
    const drain = await drainThreadUnread(readThread, { workspaceId: row.workspaceId, threadRef: item.thread.threadRef, ...(taskRef === undefined ? {} : { taskRef }) })
    if (drain.kind === 'drained') return drain.revision
    if (drain.kind === 'refused') setError(drain.message)
    return undefined
  }

  // 「已读」 is the reader clearing their own backlog on a Thread that still waits
  // on them: the durable read is the same one an answer performs, so the row
  // stays (the ask is unanswered) and only its unread mark goes.
  const markRead = async (): Promise<void> => {
    if (pending || item.unreadCount === 0) return
    setPending(true)
    setError(undefined)
    try {
      if (await drainUnread() === undefined) return
      onAnswered()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }

  // Following a Thread is what makes it carry unread for this reader at all, so
  // the toggle is decided from the row's own Attention. The Host refuses a
  // no-op either way, and its refusal is English technical prose a reader must
  // not be shown: the row re-reads the queue instead, which corrects a label
  // that had already moved on, and says so in the reader's language.
  const toggleAttention = async (): Promise<void> => {
    if (pending) return
    setPending(true)
    setError(undefined)
    try {
      const result = await changeAttention({
        requestId: mintRequestId(),
        workspaceId: row.workspaceId,
        threadRef: item.thread.threadRef,
        ...(taskRef === undefined ? {} : { taskRef }),
        action: item.attention === undefined ? 'follow' : 'unfollow',
      })
      if (!result.ok) setError(t('decisionsFollowFailed'))
      onAnswered()
    } catch {
      setError(t('decisionsFollowFailed'))
      onAnswered()
    } finally {
      setPending(false)
    }
  }

  const sendReply = async (): Promise<void> => {
    const body = draft.trim()
    if (pending || body === '') return
    setPending(true)
    setError(undefined)
    try {
      const revision = await drainUnread()
      if (revision === undefined) return
      const result = await reply({ requestId: mintRequestId(), workspaceId: row.workspaceId, threadRef: item.thread.threadRef, ...(taskRef === undefined ? {} : { taskRef }), body, baseRevision: revision, recipients: [] })
      if (!result.ok) { setError(result.error.message); return }
      if (result.value.kind === 'committed') {
        setDraft('')
        setComposing(false)
        onAnswered()
      } else if (result.value.kind === 'unread_required') {
        setError(t('unreadRequired', { count: result.value.unreadCount }))
        onAnswered()
      } else if (result.value.kind === 'stale_revision') {
        setError(t('staleRevision'))
        onAnswered()
      } else {
        // Recipients are empty on this path, so nothing here can name an Agent
        // who is not following; any other refusal is the Host's own message.
        setError(t('decisionsSendFailed'))
        onAnswered()
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }

  const acceptTask = async (): Promise<void> => {
    if (pending || taskRef === undefined) return
    setPending(true)
    setError(undefined)
    try {
      const revision = await drainUnread()
      if (revision === undefined) return
      const result = await changeTask({ requestId: mintRequestId(), workspaceId: row.workspaceId, taskRef, action: 'accept', baseRevision: revision })
      if (!result.ok) { setError(result.error.message); return }
      if (result.value.kind === 'committed') onAnswered()
      else if (result.value.kind === 'unread_required') { setError(t('unreadRequired', { count: result.value.unreadCount })); onAnswered() }
      else { setError(t('staleRevision')); onAnswered() }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }

  const actor = namedAvatarOwners([item.askActor], human)[0]!
  // The instant the row shows is when the Thread last moved, falling back to its
  // creation while nobody has replied yet — the same clock the Inbox row runs
  // on. The ask's own instant is what the queue is ordered by, so it rides the
  // element's hover title rather than competing with the visible one.
  const lastOccurredAt = item.latestReplyOccurredAt ?? item.createdOccurredAt
  return <article className={decisionsCss.row} data-team-decision-row>
    <div className={decisionsCss.rowHead}>
      <span className={decisionsCss.rowActor}>
        <TeamAvatarStack owners={[actor]} label={t('decisionsRowActor', { name: `@${actor.name}` })} human={human} />
      </span>
      <span className={decisionsCss.rowCrumb}>
        {item.taskNumber !== undefined && <span className={decisionsCss.rowTask}>{t('taskLabel', { number: item.taskNumber })}</span>}
      </span>
      <span className={decisionsCss.rowReason}>{t(REASON_LABEL_KEYS[item.reason])}</span>
      <TeamCountBadge count={item.unreadCount} label={t('inboxRowUnread', { count: item.unreadCount })} />
      <time className={decisionsCss.rowTime} dateTime={lastOccurredAt} title={t('decisionsRowAskedAt', { time: formatAbsoluteTime(item.askOccurredAt) })}>{formatInboxTime(lastOccurredAt, t)}</time>
    </div>
    <p className={decisionsCss.rowAsk}>{item.askText}</p>
    {/* The answers sit under the ask, in the order the reader is likely to
        need them: writing back first, accepting second, and opening the whole
        Thread last for anything the ask alone does not settle. The two personal
        marks take the row's other edge, because clearing unread or changing
        whether this Thread follows the reader is not an answer to anybody. */}
    <div className={decisionsCss.rowActions}>
      <Button size="sm" disabled={pending} onClick={() => { setError(undefined); setComposing(open => !open) }}>{t('decisionsReply')}</Button>
      {item.reason === 'task_review' && <Button size="sm" variant="outline" disabled={pending} onClick={() => { void acceptTask() }}>{t('decisionsAccept')}</Button>}
      <Button size="sm" variant="outline" disabled={pending} onClick={onOpen}>{t('decisionsOpenThread')}</Button>
      <span className={decisionsCss.rowPersonal}>
        <Button size="sm" disabled={pending || item.unreadCount === 0} onClick={() => { void markRead() }}>{t('decisionsMarkRead')}</Button>
        <Button size="sm" disabled={pending} onClick={() => { void toggleAttention() }}>{item.attention === undefined ? t('decisionsFollow') : t('decisionsUnfollow')}</Button>
      </span>
    </div>
    {composing && <div className={decisionsCss.composer}>
      <textarea
        className={decisionsCss.composerInput}
        value={draft}
        rows={3}
        aria-label={t('decisionsReplyLabel')}
        placeholder={t('decisionsPlaceholder')}
        onChange={event => { setError(undefined); setDraft(event.target.value) }}
      />
      <div className={decisionsCss.composerActions}>
        <Button size="sm" disabled={pending || draft.trim() === ''} onClick={() => { void sendReply() }}>{pending ? t('sendingMessage') : t('decisionsSend')}</Button>
      </div>
    </div>}
    {error !== undefined && <p className={decisionsCss.rowError} role="alert">{error}</p>}
  </article>
}
