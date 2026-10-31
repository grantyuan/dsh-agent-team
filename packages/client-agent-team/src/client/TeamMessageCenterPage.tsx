import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentTeamChannelRef, AgentTeamConfirmationToken, AgentTeamMemberId, AgentTeamMessageRow, AgentTeamRequestId, AgentTeamTopicRow } from '@wowyuarm/dsh-agent-team/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { Button, IconSearchOutlineRegular, SegmentedTabs, type SegmentedTab } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamPagePayload } from './slots.ts'
import { mintRequestId } from './requests.ts'
import { claimersLabel, formatAbsoluteTime, formatInboxTime } from './team-formatters.ts'
import { namedAvatarOwners, TeamAvatarStack, type TeamAvatarHuman } from './TeamAvatarStack.tsx'
import { TeamCountBadge } from './TeamCountBadge.tsx'
import css from './conversation.module.css'
import inboxCss from './inbox.module.css'
import centerCss from './message-center.module.css'

/**
 * The Human Message Center: two faces over the same filters. 「所有讨论」 lists
 * every Thread in the visible Channels; 「我的消息」 lists what was addressed to
 * this person and what they wrote back. Both are reads of the ledger — the page
 * commits nothing, and every row opens the Thread it belongs to.
 */

/** The two faces; they share the filter bar on purpose. */
type CenterView = 'topics' | 'messages'

/** Which way one Message relates to this person. */
type CenterDirection = 'all' | 'received' | 'sent'

/**
 * How many rows one Workspace slice may contribute. The Host bounds a slice by
 * 100, and the page merges one slice per visible Workspace, so a longer backlog
 * is reached through 「加载更多」 rather than by widening the page.
 */
const PAGE_LIMIT = 100

/** One topic row, carrying the Workspace it came from. */
interface TopicRow {
  readonly workspaceId: WorkspaceId
  readonly workspaceTitle: string
  readonly topic: AgentTeamTopicRow
}

/** One message row, carrying the Workspace it came from. */
interface MessageRow {
  readonly workspaceId: WorkspaceId
  readonly workspaceTitle: string
  readonly message: AgentTeamMessageRow
}

/** One Channel's share of a Workspace group. */
interface ChannelBucket<Row> {
  readonly channelRef: string
  readonly channelName: string
  readonly rows: Row[]
}

/** One Workspace's share of the page. */
interface WorkspaceBucket<Row> {
  readonly workspaceId: WorkspaceId
  readonly workspaceTitle: string
  readonly channels: readonly ChannelBucket<Row>[]
}

/** The one local instant a datetime-local field carries, as an ISO instant. */
function toInstant(value: string): string | undefined {
  if (value.trim() === '') return undefined
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString()
}

/**
 * Partition rows into Workspace then Channel groups. The Workspace order is the
 * visible roster's own order; Channels inside a Workspace run by name. A row
 * without a Channel (a direct Message) rides its own group, so the heading still
 * says what the row is.
 */
function groupRows<Row>(
  rows: readonly Row[],
  keysOf: (row: Row) => {
    readonly workspaceId: WorkspaceId
    readonly workspaceTitle: string
    readonly channelRef: string | undefined
    readonly channelName: string | undefined
  },
  workspaceOrder: readonly WorkspaceId[],
  directLabel: string,
): readonly WorkspaceBucket<Row>[] {
  const workspaces = new Map<string, { workspaceId: WorkspaceId; workspaceTitle: string; channels: Map<string, ChannelBucket<Row>> }>()
  for (const row of rows) {
    const keys = keysOf(row)
    const workspace = workspaces.get(keys.workspaceId) ?? { workspaceId: keys.workspaceId, workspaceTitle: keys.workspaceTitle, channels: new Map<string, ChannelBucket<Row>>() }
    workspaces.set(keys.workspaceId, workspace)
    const channelRef = keys.channelRef ?? ''
    const channelName = keys.channelName ?? directLabel
    const channel = workspace.channels.get(channelRef) ?? { channelRef, channelName, rows: [] }
    workspace.channels.set(channelRef, channel)
    channel.rows.push(row)
  }
  const rank = new Map<string, number>(workspaceOrder.map((workspaceId, index) => [workspaceId, index]))
  return [...workspaces.values()]
    .sort((left, right) => (rank.get(left.workspaceId) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.workspaceId) ?? Number.MAX_SAFE_INTEGER)
      || left.workspaceTitle.localeCompare(right.workspaceTitle)
      || left.workspaceId.localeCompare(right.workspaceId))
    .map(workspace => ({
      workspaceId: workspace.workspaceId,
      workspaceTitle: workspace.workspaceTitle,
      channels: [...workspace.channels.values()]
        .sort((left, right) => left.channelName.localeCompare(right.channelName) || left.channelRef.localeCompare(right.channelRef)),
    }))
}

interface TeamMessageCenterPageProps {
  readonly useWorkspaces: TeamPagePayload['useWorkspaces']
  /** The Host's read-only Message Center projection; one call per visible Workspace. */
  readonly loadMessageCenter: TeamPagePayload['loadMessageCenter']
  /** The Channel roster, so the filter can name Channels the page has not listed yet. */
  readonly loadChannels: TeamPagePayload['loadChannels']
  /** The Thread read an inline reply anchors to; it also consumes that row's unread. */
  readonly readThread: TeamPagePayload['readThread']
  /** The same Human reply path the Thread composer uses; the Host resolves delivery. */
  readonly reply: TeamPagePayload['reply']
  /** Wake source while the page is open; one scope-less subscription, shared with the sidebar badge. */
  readonly subscribeChanges: TeamPagePayload['subscribeChanges']
  readonly selectWorkspace: TeamPagePayload['selectWorkspace']
  readonly selectThread: TeamPagePayload['selectThread']
  /** The Human's display name, from the Client's one identity projection. */
  readonly humanName: string
  readonly humanAvatarUrl?: string | undefined
  readonly t: TeamPagePayload['t']
}

export function TeamMessageCenterPage({ useWorkspaces, loadMessageCenter, loadChannels, readThread, reply, subscribeChanges, selectWorkspace, selectThread, humanName, humanAvatarUrl, t }: TeamMessageCenterPageProps) {
  const workspaces = useWorkspaces(state => state.items)
  const [view, setView] = useState<CenterView>('topics')
  // The typed query and the applied query are two states on purpose: a
  // keystroke has to land in the field at once, while the Host is only asked
  // once the reading stopped.
  const [queryInput, setQueryInput] = useState('')
  const [query, setQuery] = useState('')
  const [direction, setDirection] = useState<CenterDirection>('all')
  const [channelRef, setChannelRef] = useState('')
  const [sinceInput, setSinceInput] = useState('')
  const [untilInput, setUntilInput] = useState('')
  const [topics, setTopics] = useState<readonly TopicRow[]>()
  const [messages, setMessages] = useState<readonly MessageRow[]>()
  const [topicsHasMore, setTopicsHasMore] = useState(false)
  const [messagesHasMore, setMessagesHasMore] = useState(false)
  const [topicsError, setTopicsError] = useState<string>()
  const [messagesError, setMessagesError] = useState<string>()
  const [channels, setChannels] = useState<readonly { readonly ref: string; readonly name: string }[]>([])
  const [humanMemberId, setHumanMemberId] = useState<AgentTeamMemberId>()
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const ticketRef = useRef(0)
  // The merged rows and the continuation cursors are read by the loader only,
  // so they live outside the render state: a load must append to what the last
  // load produced, not to the slice captured when the callback was created.
  const topicsRef = useRef<readonly TopicRow[]>()
  const messagesRef = useRef<readonly MessageRow[]>()
  const cursorsRef = useRef<Readonly<Record<string, number | undefined>>>({})

  const since = useMemo(() => toInstant(sinceInput), [sinceInput])
  const until = useMemo(() => toInstant(untilInput), [untilInput])
  const filtered = query !== '' || channelRef !== '' || since !== undefined || until !== undefined

  /**
   * Read one face of the Message Center across every visible Workspace and
   * merge the slices. The Host's sequence is one global ledger position, so the
   * merge re-applies the Host's own order across Workspaces instead of
   * inventing a second one.
   *
   * `append` continues from the cursors the previous call returned; a fresh
   * read discards them. A newer call owns the page: an older answer that lands
   * late is dropped rather than overwriting the newer rows.
   */
  const load = useCallback(async (target: CenterView, append: boolean): Promise<void> => {
    const ticket = ticketRef.current + 1
    ticketRef.current = ticket
    // No visible Workspace means nothing was asked, let alone answered: the
    // face stays 「加载中」 until the roster lands, instead of one empty
    // frame pretending the ledger had nothing to say.
    if (workspaces.length === 0) return
    if (append) setLoadingMore(true)
    else setLoading(true)
    const results = await Promise.all(workspaces.map(async workspace => {
      const key = `${target}|${workspace.workspaceId}`
      const cursor = append ? cursorsRef.current[key] : undefined
      const result = await loadMessageCenter({
        workspaceId: workspace.workspaceId,
        view: target,
        ...(query === '' ? {} : { query }),
        ...(channelRef === '' ? {} : { channelRef: channelRef as AgentTeamChannelRef }),
        ...(since === undefined ? {} : { since }),
        ...(until === undefined ? {} : { until }),
        ...(target === 'messages' && direction !== 'all' ? { direction } : {}),
        limit: PAGE_LIMIT,
        ...(cursor === undefined ? {} : { cursor }),
      })
      if (!result.ok) return { ok: false as const, workspaceId: workspace.workspaceId, message: result.error.message }
      return { ok: true as const, workspaceId: workspace.workspaceId, title: workspace.title, value: result.value }
    }))
    if (ticket !== ticketRef.current) return
    const nextCursors: Record<string, number | undefined> = { ...cursorsRef.current }
    const nextTopics: TopicRow[] = append ? [...(topicsRef.current ?? [])] : []
    const nextMessages: MessageRow[] = append ? [...(messagesRef.current ?? [])] : []
    let more = false
    let failure: string | undefined
    for (const result of results) {
      if (!result.ok) {
        failure = failure ?? result.message
        continue
      }
      nextCursors[`${target}|${result.workspaceId}`] = result.value.cursor
      more = more || result.value.hasMore
      setHumanMemberId(result.value.humanMemberId)
      if (result.value.view === 'topics') {
        for (const topic of result.value.topics) nextTopics.push({ workspaceId: result.workspaceId, workspaceTitle: result.title, topic })
      } else {
        for (const message of result.value.messages) nextMessages.push({ workspaceId: result.workspaceId, workspaceTitle: result.title, message })
      }
    }
    cursorsRef.current = nextCursors
    // Both orders are the Host's: topics by their newest sequence (the same
    // instant the row prints), messages by their own sequence, both descending.
    nextTopics.sort((left, right) => right.topic.newestSequence - left.topic.newestSequence || left.topic.threadRef.localeCompare(right.topic.threadRef))
    nextMessages.sort((left, right) => right.message.sequence - left.message.sequence)
    if (target === 'topics') {
      topicsRef.current = nextTopics
      // A read that answered nothing and failed everywhere has not arrived:
      // `undefined` keeps the error state (with its retry) on screen instead
      // of an empty list claiming the ledger holds no discussions.
      setTopics(nextTopics.length === 0 && failure !== undefined ? undefined : nextTopics)
      setTopicsHasMore(more)
      setTopicsError(failure)
    } else {
      messagesRef.current = nextMessages
      setMessages(nextMessages.length === 0 && failure !== undefined ? undefined : nextMessages)
      setMessagesHasMore(more)
      setMessagesError(failure)
    }
    setLoading(false)
    setLoadingMore(false)
  }, [workspaces, loadMessageCenter, query, channelRef, since, until, direction])

  // The applied query follows the typed one once the reading stopped.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(queryInput.trim()), 250)
    return () => clearTimeout(timer)
  }, [queryInput])

  // A changed filter or a changed face invalidates both faces: rows computed
  // under the old filter must not be shown as if they matched the new one.
  useEffect(() => {
    topicsRef.current = undefined
    messagesRef.current = undefined
    setTopics(undefined)
    setMessages(undefined)
    setTopicsHasMore(false)
    setMessagesHasMore(false)
    void load(view, false)
  }, [load, view])

  // The Channel roster behind the filter: one read per visible Workspace.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const results = await Promise.all(workspaces.map(async workspace => {
        const result = await loadChannels({ workspaceId: workspace.workspaceId, limit: 1 })
        return result.ok ? result.value.channels : []
      }))
      if (cancelled) return
      const names = new Map<string, string>()
      for (const list of results) for (const channel of list) names.set(channel.channelRef, channel.name)
      setChannels([...names.entries()].map(([ref, name]) => ({ ref, name })).sort((left, right) => left.name.localeCompare(right.name)))
    })()
    return () => { cancelled = true }
  }, [loadChannels, workspaces])

  // The ledger moved: re-read the face on screen. A failed change stream is the
  // Host's own verdict and is shown where it happened.
  useEffect(() => subscribeChanges(undefined, update => {
    if (update.type === 'failed') {
      if (view === 'topics') setTopicsError(update.message)
      else setMessagesError(update.message)
      return
    }
    void load(view, false)
  }), [subscribeChanges, load, view])

  const openTopic = useCallback((row: TopicRow): void => {
    selectWorkspace(row.workspaceId)
    selectThread(row.topic.threadRef, row.topic.channelRef, row.topic.taskRef, row.topic.taskNumber, 'messages')
  }, [selectThread, selectWorkspace])

  const openMessage = useCallback((row: MessageRow): void => {
    if (row.message.threadRef === undefined) return
    // 「定位」 carries the row's ledger sequence: the Thread page walks its
    // history to that fact, scrolls it into view, and flashes it once.
    selectWorkspace(row.workspaceId)
    selectThread(row.message.threadRef, row.message.channelRef, row.message.taskRef, row.message.taskNumber, 'messages', row.message.sequence)
  }, [selectThread, selectWorkspace])

  // The inline reply: one composer at a time, one notice per row, and the
  // request id retained between attempts so the Host's confirmation replay
  // commits the same intent instead of a second one.
  const [replySequence, setReplySequence] = useState<number>()
  const [replyDraft, setReplyDraft] = useState('')
  const [replyPending, setReplyPending] = useState(false)
  const [replyNotice, setReplyNotice] = useState<{ readonly sequence: number; readonly tone: 'error' | 'status'; readonly text: string }>()
  const replyRequestRef = useRef<{ readonly id: AgentTeamRequestId; readonly token?: AgentTeamConfirmationToken }>()

  const openReply = useCallback((row: MessageRow): void => {
    if (row.message.threadRef === undefined) return
    setReplySequence(row.message.sequence)
    setReplyDraft('')
    setReplyNotice(undefined)
    replyRequestRef.current = undefined
  }, [])

  const closeReply = useCallback((): void => {
    setReplySequence(undefined)
    setReplyDraft('')
    setReplyNotice(undefined)
    replyRequestRef.current = undefined
  }, [])

  /**
   * The row's answer names its counterpart: the sender of a received Message,
   * or the same Members the sent one named — never this reader themself. The
   * Host's mention scan resolves delivery; the row's own thread position
   * supplies the context.
   */
  const replyRecipients = useCallback((message: AgentTeamMessageRow): readonly AgentTeamMemberId[] => {
    const candidates = message.direction === 'received'
      ? [message.sender.memberId]
      : message.recipients.map(actor => actor.memberId)
    return [...new Set(candidates.filter(id => id !== humanMemberId))].sort()
  }, [humanMemberId])

  const sendInlineReply = useCallback(async (row: MessageRow): Promise<void> => {
    const message = row.message
    const sequence = message.sequence
    if (message.threadRef === undefined || replyPending || replyDraft.trim() === '') return
    const body = replyDraft.trim()
    setReplyPending(true)
    setReplyNotice(undefined)
    try {
      // The reply commits against the Thread's current revision, so the read
      // that anchors it also consumes the row's unread: answering a message
      // is reading it.
      const read = await readThread({ requestId: mintRequestId(), workspaceId: row.workspaceId, threadRef: message.threadRef, ...(message.taskRef === undefined ? {} : { taskRef: message.taskRef }) })
      if (!read.ok) {
        replyRequestRef.current = undefined
        setReplyNotice({ sequence, tone: 'error', text: read.error.message })
        return
      }
      const requestId = replyRequestRef.current?.id ?? mintRequestId()
      const result = await reply({
        requestId,
        workspaceId: row.workspaceId,
        threadRef: message.threadRef,
        ...(message.taskRef === undefined ? {} : { taskRef: message.taskRef }),
        body,
        baseRevision: read.value.thread.revision,
        recipients: replyRecipients(message),
        ...(replyRequestRef.current?.token === undefined ? {} : { confirmationToken: replyRequestRef.current.token }),
      })
      if (!result.ok) {
        replyRequestRef.current = undefined
        setReplyNotice({ sequence, tone: 'error', text: t('messagesReplyFailed', { message: result.error.message }) })
        return
      }
      if (result.value.kind === 'committed') {
        replyRequestRef.current = undefined
        setReplySequence(undefined)
        setReplyDraft('')
        setReplyNotice({ sequence, tone: 'status', text: t('messagesReplySent') })
        // The committed fact also rides the next Host wake; this read brings
        // the 「我发出的」 row up without waiting for it.
        void load('messages', false)
      } else if (result.value.kind === 'confirmation_required') {
        replyRequestRef.current = { id: requestId, token: result.value.confirmationToken }
        setReplyNotice({ sequence, tone: 'status', text: t('mentionConfirmation') })
      } else if (result.value.kind === 'unread_required') {
        replyRequestRef.current = undefined
        setReplyNotice({ sequence, tone: 'error', text: t('unreadRequired', { count: result.value.unreadCount }) })
      } else if (result.value.kind === 'stale_revision') {
        replyRequestRef.current = undefined
        setReplyNotice({ sequence, tone: 'error', text: t('staleRevision') })
      } else {
        replyRequestRef.current = undefined
        setReplyNotice({ sequence, tone: 'error', text: t('messagesReplyFailed', { message: result.value.memberIds.join(', ') }) })
      }
    } catch (cause) {
      setReplyNotice({ sequence, tone: 'error', text: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      setReplyPending(false)
    }
  }, [replyPending, replyDraft, readThread, reply, replyRecipients, t, load])

  const clearFilters = useCallback((): void => {
    setQueryInput('')
    setQuery('')
    setDirection('all')
    setChannelRef('')
    setSinceInput('')
    setUntilInput('')
  }, [])

  const human = useMemo<TeamAvatarHuman | undefined>(() => humanMemberId === undefined
    ? undefined
    : { memberId: humanMemberId, name: humanName, ...(humanAvatarUrl === undefined ? {} : { avatarUrl: humanAvatarUrl }) },
  [humanMemberId, humanName, humanAvatarUrl])

  const tabItems = useMemo<readonly [SegmentedTab<CenterView>, ...SegmentedTab<CenterView>[]]>(() => [
    { value: 'topics', label: t('messagesTabTopics'), id: 'team-messages-topics-tab', panelId: 'team-messages-topics-panel' },
    { value: 'messages', label: t('messagesTabMine'), id: 'team-messages-messages-tab', panelId: 'team-messages-messages-panel' },
  ], [t])

  const workspaceOrder = useMemo(() => workspaces.map(workspace => workspace.workspaceId), [workspaces])
  const topicGroups = useMemo(() => groupRows(topics ?? [], row => ({ workspaceId: row.workspaceId, workspaceTitle: row.workspaceTitle, channelRef: row.topic.channelRef, channelName: row.topic.channelName }), workspaceOrder, t('messagesDirect')), [topics, workspaceOrder, t])
  const messageGroups = useMemo(() => groupRows(messages ?? [], row => ({ workspaceId: row.workspaceId, workspaceTitle: row.workspaceTitle, channelRef: row.message.channelRef, channelName: row.message.channelName }), workspaceOrder, t('messagesDirect')), [messages, workspaceOrder, t])

  const topicsCount = topics?.length ?? 0
  const messagesCount = messages?.length ?? 0
  const showingCount = view === 'topics' ? topicsCount : messagesCount
  const activeError = view === 'topics' ? topicsError : messagesError
  const activeRows = view === 'topics' ? topics : messages
  const activeHasMore = view === 'topics' ? topicsHasMore : messagesHasMore

  return <main className={css.surface} data-team-messages>
    <div className={css.surfaceHeader}>
      <header className={css.headerRow}>
        <div className={css.headerCopy}>
          <h1>{t('messagesTitle')}</h1>
          <p className={inboxCss.headerMeta}>
            <span>{view === 'topics' ? t('messagesTopicsCount', { count: topicsCount }) : t('messagesMessagesCount', { count: messagesCount })}</span>
            {filtered && <span>{t('messagesShowing', { count: showingCount })}</span>}
          </p>
        </div>
      </header>
      <div className={centerCss.toolbar}>
        <SegmentedTabs<CenterView> className={centerCss.tabs} label={t('messagesTabsLabel')} value={view} onChange={setView} items={tabItems} />
        <div className={centerCss.filters}>
          <div className={centerCss.filterControl}>
            <label className={centerCss.filterLabel} htmlFor="team-messages-search">{t('messagesSearchLabel')}</label>
            <div className={centerCss.searchField}>
              <span className={centerCss.searchIcon} aria-hidden="true"><IconSearchOutlineRegular size={16} /></span>
              <input id="team-messages-search" className={centerCss.searchInput} type="search" value={queryInput} placeholder={t('messagesSearchPlaceholder')} onChange={event => setQueryInput(event.target.value)} />
            </div>
          </div>
          {view === 'messages' && <div className={centerCss.filterControl}>
            <label className={centerCss.filterLabel} htmlFor="team-messages-direction">{t('messagesDirectionLabel')}</label>
            <select id="team-messages-direction" className={centerCss.filterSelect} value={direction} onChange={event => setDirection(event.target.value as CenterDirection)}>
              <option value="all">{t('messagesDirectionAll')}</option>
              <option value="received">{t('messagesDirectionReceived')}</option>
              <option value="sent">{t('messagesDirectionSent')}</option>
            </select>
          </div>}
          <div className={centerCss.filterControl}>
            <label className={centerCss.filterLabel} htmlFor="team-messages-channel">{t('messagesChannelLabel')}</label>
            <select id="team-messages-channel" className={centerCss.filterSelect} value={channelRef} onChange={event => setChannelRef(event.target.value)}>
              <option value="">{t('messagesChannelAll')}</option>
              {channels.map(channel => <option key={channel.ref} value={channel.ref}>{channel.name}</option>)}
            </select>
          </div>
          <div className={centerCss.filterControl}>
            <label className={centerCss.filterLabel} htmlFor="team-messages-since">{t('messagesTimeFrom')}</label>
            <input id="team-messages-since" className={centerCss.filterInput} type="datetime-local" value={sinceInput} onChange={event => setSinceInput(event.target.value)} />
          </div>
          <div className={centerCss.filterControl}>
            <label className={centerCss.filterLabel} htmlFor="team-messages-until">{t('messagesTimeTo')}</label>
            <input id="team-messages-until" className={centerCss.filterInput} type="datetime-local" value={untilInput} onChange={event => setUntilInput(event.target.value)} />
          </div>
          {filtered && <Button size="sm" variant="outline" onClick={clearFilters}>{t('messagesClearFilters')}</Button>}
        </div>
      </div>
    </div>
    <div className={css.timeline}>
      <div className={css.timelineContent}>
        <div id="team-messages-topics-panel" role="tabpanel" aria-labelledby="team-messages-topics-tab" className={centerCss.panel} hidden={view !== 'topics'} tabIndex={0}>
          {/* A face that never arrived says so instead of claiming emptiness: an
              empty list and a refused read are different answers, and only the
              second one carries a retry. */}
          {topics === undefined && topicsError !== undefined && <div className={css.errorState} role="alert">
            <span>{t('messagesLoadFailed', { message: topicsError })}</span>
            <Button size="sm" variant="outline" onClick={() => { void load('topics', false) }}>{t('retry')}</Button>
          </div>}
          {topics === undefined && topicsError === undefined && <div className={css.emptySurface}><p className={css.loadingState}><span className={css.loadingMark} aria-hidden="true" />{t('messagesLoading')}</p></div>}
          {topics !== undefined && topics.length === 0 && <div className={css.emptySurface}><div className={css.emptyState}>
            <strong>{filtered ? t('messagesSearchEmptyTitle') : t('messagesEmptyTopicsTitle')}</strong>
            <span>{filtered ? t('messagesSearchEmptyHint') : t('messagesEmptyTopicsHint')}</span>
          </div></div>}
          {topics !== undefined && topics.length > 0 && <div className={centerCss.rows}>
            {topicGroups.map(group => <section key={group.workspaceId} className={css.group} data-team-messages-workspace={group.workspaceId}>
              <h3 className={css.groupTitle}>{group.workspaceTitle}<span className={css.groupCount}>{group.channels.reduce((total, channel) => total + channel.rows.length, 0)}</span></h3>
              {group.channels.map(channel => <div key={channel.channelRef} className={css.channelGroup}>
                <h4 className={css.channelTitle}>{channel.channelName}<span className={css.groupCount}>{channel.rows.length}</span></h4>
                <div className={inboxCss.list}>
                  {channel.rows.map(row => <TopicRowView key={row.topic.threadRef} row={row} human={human} onOpen={openTopic} t={t} />)}
                </div>
              </div>)}
            </section>)}
          </div>}
        </div>
        <div id="team-messages-messages-panel" role="tabpanel" aria-labelledby="team-messages-messages-tab" className={centerCss.panel} hidden={view !== 'messages'} tabIndex={0}>
          {messages === undefined && messagesError !== undefined && <div className={css.errorState} role="alert">
            <span>{t('messagesLoadFailed', { message: messagesError })}</span>
            <Button size="sm" variant="outline" onClick={() => { void load('messages', false) }}>{t('retry')}</Button>
          </div>}
          {messages === undefined && messagesError === undefined && <div className={css.emptySurface}><p className={css.loadingState}><span className={css.loadingMark} aria-hidden="true" />{t('messagesLoading')}</p></div>}
          {messages !== undefined && messages.length === 0 && <div className={css.emptySurface}><div className={css.emptyState}>
            <strong>{filtered ? t('messagesSearchEmptyTitle') : t('messagesEmptyMessagesTitle')}</strong>
            <span>{filtered ? t('messagesSearchEmptyHint') : t('messagesEmptyMessagesHint')}</span>
          </div></div>}
          {messages !== undefined && messages.length > 0 && <div className={centerCss.rows}>
            {messageGroups.map(group => <section key={group.workspaceId} className={css.group} data-team-messages-workspace={group.workspaceId}>
              <h3 className={css.groupTitle}>{group.workspaceTitle}<span className={css.groupCount}>{group.channels.reduce((total, channel) => total + channel.rows.length, 0)}</span></h3>
              {group.channels.map(channel => <div key={channel.channelRef} className={css.channelGroup}>
                <h4 className={css.channelTitle}>{channel.channelName}<span className={css.groupCount}>{channel.rows.length}</span></h4>
                <div className={inboxCss.list}>
                  {channel.rows.map(row => <MessageRowView key={row.message.sequence} row={row} onOpen={openMessage} t={t}
                    replyOpen={replySequence === row.message.sequence}
                    replyDraft={replyDraft}
                    replyPending={replyPending}
                    {...(replyNotice?.sequence === row.message.sequence ? { replyNotice } : {})}
                    onReplyDraftChange={setReplyDraft}
                    onReplySend={() => { void sendInlineReply(row) }}
                    onReplyOpen={openReply}
                    onReplyClose={closeReply}
                  />)}
                </div>
              </div>)}
            </section>)}
          </div>}
        </div>
        {activeRows !== undefined && activeHasMore && <div className={centerCss.more}>
          <Button size="sm" variant="outline" disabled={loadingMore} onClick={() => { void load(view, true) }}>{loadingMore ? t('messagesLoading') : t('messagesLoadMore')}</Button>
        </div>}
        {/* A partial read keeps the rows it did get and states what failed, so a
            single unreachable Workspace never blanks the whole page. */}
        {activeRows !== undefined && activeRows.length > 0 && activeError !== undefined && <p className={css.error} role="alert">{t('messagesLoadFailed', { message: activeError })}</p>}
      </div>
    </div>
  </main>
}

/** One discussion row: what the Thread is, who is in it, and how fresh it is. */
function TopicRowView({ row, human, onOpen, t }: { readonly row: TopicRow; readonly human: TeamAvatarHuman | undefined; readonly onOpen: (row: TopicRow) => void; readonly t: TeamPagePayload['t'] }) {
  const topic = row.topic
  const participantsLabel = t('messagesParticipants', { count: topic.participantCount })
  return <button type="button" className={inboxCss.row} data-team-messages-topic onClick={() => { onOpen(row) }}>
    <span className={inboxCss.rowActor} aria-hidden="true"><TeamAvatarStack owners={namedAvatarOwners(topic.participants, human)} label={participantsLabel} human={human} /></span>
    <span className={inboxCss.rowLine}>
      <span className={inboxCss.rowCrumb}>{topic.subject}</span>
      {topic.needsHumanDecision && <span className={inboxCss.rowDecision}>{t('messagesNeedsDecision')}</span>}
      <TeamCountBadge count={topic.unreadCount} tone="hairline" label={t('messagesUnread', { count: topic.unreadCount })} />
      <time className={inboxCss.rowTime} dateTime={topic.lastOccurredAt} title={formatAbsoluteTime(topic.lastOccurredAt)}>{formatInboxTime(topic.lastOccurredAt, t)}</time>
    </span>
    <span className={inboxCss.rowSecond}>
      <span className={inboxCss.rowPreview}>{topic.matchExcerpt ?? topic.subject}</span>
      <span className={inboxCss.rowMeta}>
        <span className={inboxCss.rowMetaItem}>{participantsLabel}</span>
        {topic.iParticipated && <span className={inboxCss.rowMetaItem}>{t('messagesIParticipated')}</span>}
        {topic.claimOwners.length > 0 && <span className={inboxCss.rowMetaItem}>{claimersLabel(topic.claimOwners, t)}</span>}
      </span>
    </span>
  </button>
}

/** One message row: who sent it, which way it went, and what the ledger shows happened to it. */
function MessageRowView({ row, onOpen, t, replyOpen, replyDraft, replyPending, replyNotice, onReplyDraftChange, onReplySend, onReplyOpen, onReplyClose }: {
  readonly row: MessageRow
  readonly onOpen: (row: MessageRow) => void
  readonly t: TeamPagePayload['t']
  /** The one open inline composer; Thread rows only — a direct Message has no lane this seat may write. */
  readonly replyOpen: boolean
  readonly replyDraft: string
  readonly replyPending: boolean
  readonly replyNotice?: { readonly tone: 'error' | 'status'; readonly text: string }
  readonly onReplyDraftChange: (draft: string) => void
  readonly onReplySend: () => void
  readonly onReplyOpen: (row: MessageRow) => void
  readonly onReplyClose: () => void
}) {
  const message = row.message
  const answerable = message.threadRef !== undefined
  const processing = message.processing
  const processingLabel = processing === undefined
    ? undefined
    : processing.state === 'resolved' ? t('messagesProcessingResolved')
      : processing.state === 'acknowledged' ? t('messagesProcessingAcknowledged') : t('messagesProcessingPending')
  return <article className={centerCss.messageRow} data-team-messages-message data-direction={message.direction}>
    <div className={centerCss.messageHead}>
      <span className={centerCss.directionBadge} data-direction={message.direction}>{message.direction === 'sent' ? t('messagesDirectionSent') : t('messagesDirectionReceived')}</span>
      {message.via === 'dm' && <span className={centerCss.directionBadge} data-direction="dm">{t('messagesDirect')}</span>}
      <span className={centerCss.senderName}>{message.sender.name}</span>
      <time className={inboxCss.rowTime} dateTime={message.occurredAt} title={formatAbsoluteTime(message.occurredAt)}>{formatInboxTime(message.occurredAt, t)}</time>
    </div>
    <p className={centerCss.excerpt}>{message.matchExcerpt ?? message.excerpt}</p>
    {message.replyContext !== undefined && <p className={centerCss.replyContext}>
      {message.replyContext.relation === 'thread-anchor'
        ? t('messagesReplyContextAnchor')
        : t('messagesReplyContext', { name: message.replyContext.sender.name, excerpt: message.replyContext.excerpt })}
    </p>}
    <div className={centerCss.messageFoot}>
      {processingLabel !== undefined && <span className={centerCss.processingPill} data-state={processing?.state}>{processingLabel}</span>}
      {answerable && <Button size="sm" variant="outline" aria-expanded={replyOpen} onClick={() => { if (replyOpen) onReplyClose(); else onReplyOpen(row) }}>{t('messagesReplyAction')}</Button>}
      {answerable && <Button size="sm" variant="outline" onClick={() => { onOpen(row) }}>{t('messagesLocate')}</Button>}
    </div>
    {replyOpen && <div className={centerCss.replyBox}>
      <textarea
        className={centerCss.replyArea}
        aria-label={t('messagesReplyAction')}
        placeholder={t('messagesReplyPlaceholder')}
        value={replyDraft}
        rows={2}
        disabled={replyPending}
        onChange={event => onReplyDraftChange(event.target.value)}
        onKeyDown={event => {
          // Enter sends, Shift+Enter breaks the line; an IME composition owns
          // its Enter until the candidate window closes.
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            onReplySend()
          }
        }}
      />
      <div className={centerCss.replyActions}>
        <Button size="sm" variant="primary" disabled={replyPending || replyDraft.trim() === ''} onClick={onReplySend}>{replyPending ? t('messagesReplySending') : t('messagesReplySend')}</Button>
        <Button size="sm" variant="outline" disabled={replyPending} onClick={onReplyClose}>{t('cancel')}</Button>
      </div>
    </div>}
    {/* The row's own outcome line: it survives the composer closing, so the
        commit and every refusal stay legible where the row is. */}
    {replyNotice !== undefined && <p className={centerCss.replyNotice} role={replyNotice.tone === 'error' ? 'alert' : 'status'}>{replyNotice.text}</p>}
  </article>
}
