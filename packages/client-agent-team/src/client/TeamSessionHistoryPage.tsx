import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentTeamExternalContextResult,
  AgentTeamMemberId,
  AgentTeamMemberSessionSummary,
  AgentTeamMemberSessionTranscriptEntry,
} from '@wowyuarm/dsh-agent-team/types'
import { Button, IconChevronLeftOutlineRegular, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamPagePayload } from './slots.ts'
import type { TeamKey } from './locales.ts'
import { shouldClampMessage } from './team-formatters.ts'
import css from './session-history.module.css'
import conversationCss from './conversation.module.css'

interface TranscriptPage {
  readonly entries: readonly AgentTeamMemberSessionTranscriptEntry[]
  readonly hasEarlier: boolean
  readonly nextBeforeSeq?: number
}

interface TeamSessionHistoryPageProps {
  readonly memberId: AgentTeamMemberId
  /** The selected Workspace, when the seat has one; the external-context read scopes to it. */
  readonly workspaceId?: string
  readonly loadMembers: TeamPagePayload['loadMembers']
  readonly loadMemberSessions: TeamPagePayload['loadMemberSessions']
  readonly loadMemberSessionTranscript: TeamPagePayload['loadMemberSessionTranscript']
  readonly loadExternalContext: TeamPagePayload['loadExternalContext']
  readonly exitSessionHistory: TeamPagePayload['exitSessionHistory']
  readonly t: TeamPagePayload['t']
}

/**
 * The Human audit page for one Member's stored Sessions: every generation the
 * Member has run (the live one first, archived ancestors through the Host's
 * lineage walk), and a bounded read-only transcript of the selected generation.
 * The transcript is the Host's own stored-log render in multiline mode, so the
 * page can show each entry as authored Markdown — system instructions, Team
 * relays, and Host notices included — instead of the flattened single lines the
 * doctor's model-facing transcript needs. Opening this page never activates,
 * resumes, or writes a Member Session, which is why archived generations stay
 * browsable even though Harness refuses to open them as live conversations.
 */
export function TeamSessionHistoryPage({ memberId, workspaceId, loadMembers, loadMemberSessions, loadMemberSessionTranscript, loadExternalContext, exitSessionHistory, t }: TeamSessionHistoryPageProps) {
  const [handleName, setHandleName] = useState<string>()
  // Undefined until the roster answers; true only for an external Member.
  const [rosterExternal, setRosterExternal] = useState<boolean>()
  const [generations, setGenerations] = useState<readonly AgentTeamMemberSessionSummary[]>()
  const [sessionsError, setSessionsError] = useState<string>()
  const [selected, setSelected] = useState<string>()
  const [page, setPage] = useState<TranscriptPage>()
  const [transcriptError, setTranscriptError] = useState<string>()
  const [loadingTranscript, setLoadingTranscript] = useState(false)
  const loadToken = useRef(0)

  // The page is durable navigation: after a reload it knows only the branded
  // Member id, so the roster read names the header. A Member archived since
  // still answers (the roster keeps archived rows), which is what makes the
  // audit trail of a retired Member reviewable.
  useEffect(() => {
    let alive = true
    loadMembers({})
      .then(result => {
        if (!alive) return
        if (!result.ok) {
          // An unreadable roster must not freeze the ordinary page: fall back
          // to the generation read, which answers for itself.
          setRosterExternal(false)
          return
        }
        const found = result.value.find(status => status.member.memberId === memberId)
        if (found !== undefined) {
          setHandleName(found.member.handle)
          setRosterExternal(found.member.external === true)
        } else setRosterExternal(false)
      })
      .catch(() => {
        if (alive) setRosterExternal(false)
      })
    return () => { alive = false }
  }, [loadMembers, memberId])

  useEffect(() => {
    // The roster answer decides the page shape: an external Member owns no
    // stored Session (skip the read), any other answer — including an
    // unreadable roster, which falls back to false — loads the generations.
    if (rosterExternal !== false) return
    let alive = true
    loadMemberSessions({ memberId })
      .then(result => {
        if (!alive) return
        if (!result.ok) {
          setSessionsError(result.error.message)
          return
        }
        setGenerations(result.value)
        // Default to the newest READABLE generation: the Host marks a
        // generation unreadable (no createdAt) when its stored log cannot be
        // opened — a context transition in progress binds exactly such a
        // Session. Selecting it would fire a transcript read that can only
        // fail, so the page lands on the newest row the Human can actually
        // read and leaves the unreadable one for inspection via its own row.
        const readable = result.value.filter(generation => generation.createdAt !== undefined)
        const first = readable.find(generation => generation.isCurrent) ?? readable[0]
        if (first !== undefined) setSelected(first.sessionId)
      })
      .catch(cause => {
        if (alive) setSessionsError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => { alive = false }
  }, [loadMemberSessions, memberId, rosterExternal])

  const loadPage = useCallback(async (sessionId: string, beforeSeq?: number): Promise<void> => {
    setLoadingTranscript(true)
    setTranscriptError(undefined)
    // A fast generation switch can leave an older response in flight; each
    // load claims a token and stale replies drop instead of overwriting.
    const token = (loadToken.current += 1)
    try {
      const result = await loadMemberSessionTranscript({
        memberId,
        sessionId: sessionId as AgentTeamMemberSessionSummary['sessionId'],
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
      })
      if (token !== loadToken.current) return
      if (!result.ok) {
        setTranscriptError(result.error.message)
        return
      }
      setPage(current => beforeSeq === undefined
        ? { entries: result.value.entries, hasEarlier: result.value.hasEarlier, ...(result.value.nextBeforeSeq === undefined ? {} : { nextBeforeSeq: result.value.nextBeforeSeq }) }
        : {
            entries: [...result.value.entries, ...(current?.entries ?? [])],
            hasEarlier: result.value.hasEarlier,
            ...(result.value.nextBeforeSeq === undefined ? {} : { nextBeforeSeq: result.value.nextBeforeSeq }),
          })
    } catch (cause) {
      if (token === loadToken.current) setTranscriptError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (token === loadToken.current) setLoadingTranscript(false)
    }
  }, [loadMemberSessionTranscript, memberId])

  useEffect(() => {
    if (selected === undefined) return
    setPage(undefined)
    void loadPage(selected)
  }, [selected, loadPage])

  // The Markdown chrome (code-copy buttons, footnotes heading) is locale copy
  // the primitive receives via props; stable per locale revision — a fresh
  // object per render would rebuild the component table on every chunk.
  const markdownLabels = useMemo<MarkdownLabels>(() => ({
    code: { copyLabel: t('copyCode'), copiedLabel: t('copiedCode') },
    footnotes: t('markdownFootnotes'),
  }), [t])

  // An external Member owns no stored Session — its audit page renders the
  // heartbeat-synced context instead of the generation list.
  if (rosterExternal === true) {
    return (
      <main className={conversationCss.surface} data-team-session-history>
        <div className={conversationCss.surfaceHeader}>
          <div className={conversationCss.backRow}>
            <Button size="sm" icon={<IconChevronLeftOutlineRegular />} onClick={exitSessionHistory}>{t('sessionHistoryBack')}</Button>
          </div>
          <header className={conversationCss.headerRow}>
            <div className={conversationCss.headerCopy}>
              <h1>{t('sessionHistoryTitle', { name: handleName ?? memberId })}</h1>
            </div>
          </header>
        </div>
        <ExternalContextPanel
          memberId={memberId}
          {...(workspaceId === undefined ? {} : { workspaceId })}
          loadExternalContext={loadExternalContext}
          t={t}
        />
      </main>
    )
  }

  return (
    <main className={conversationCss.surface} data-team-session-history>
      <div className={conversationCss.surfaceHeader}>
        <div className={conversationCss.backRow}>
          <Button size="sm" icon={<IconChevronLeftOutlineRegular />} onClick={exitSessionHistory}>{t('sessionHistoryBack')}</Button>
        </div>
        <header className={conversationCss.headerRow}>
          <div className={conversationCss.headerCopy}>
            <h1>{t('sessionHistoryTitle', { name: handleName ?? (generations === undefined ? '…' : memberId) })}</h1>
          </div>
        </header>
      </div>
      <div className={css.shell}>
        <nav className={css.pane} aria-label={t('sessionHistoryGenerations')}>
          {sessionsError !== undefined && <p className={conversationCss.errorState} role="alert">{sessionsError}</p>}
          {generations === undefined && sessionsError === undefined && <p className={css.emptyNote}>{t('sessionHistoryLoading')}</p>}
          <ul className={css.generationList}>
            {generations?.map((generation, index) => {
              const readable = generation.createdAt !== undefined
              return (
                <li key={generation.sessionId}>
                  <button
                    type="button"
                    className={css.generationRow}
                    data-selected={selected === generation.sessionId || undefined}
                    disabled={!readable}
                    onClick={() => { setSelected(generation.sessionId) }}
                  >
                    <span className={css.generationTitle}>
                      {generation.isCurrent
                        ? t('sessionHistoryCurrent')
                        : generation.predecessorHandle !== undefined
                          ? t('sessionHistoryInherited', { name: generation.predecessorHandle })
                          : t('sessionHistoryGeneration', { index: index + 1 })}
                    </span>
                    <span className={css.generationMeta}>
                      {readable
                        ? `${new Date(generation.createdAt!).toLocaleString()} · ${t('sessionHistoryEvents', { count: generation.eventCount! })}`
                        : t('sessionHistoryUnreadable')}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </nav>
        <div className={css.transcript} role="log" aria-live="polite">
          {loadingTranscript && page === undefined && <p className={css.emptyNote}>{t('sessionHistoryLoading')}</p>}
          {transcriptError !== undefined && (
            <p className={conversationCss.errorState} role="alert">
              <span>{transcriptError}</span>
              {selected !== undefined && <button type="button" className={css.textButton} onClick={() => { void loadPage(selected) }}>{t('retry')}</button>}
            </p>
          )}
          {!loadingTranscript && transcriptError === undefined && page !== undefined && page.entries.length === 0 && <p className={css.emptyNote}>{t('sessionHistoryEmpty')}</p>}
          {generations !== undefined && sessionsError === undefined && selected === undefined && <p className={css.emptyNote}>{t('sessionHistoryNoReadable')}</p>}
          {page !== undefined && page.hasEarlier && (
            <Button className={css.loadEarlier!} variant="outline" disabled={loadingTranscript} onClick={() => { if (selected !== undefined && page.nextBeforeSeq !== undefined) void loadPage(selected, page.nextBeforeSeq) }}>
              {loadingTranscript ? t('sessionHistoryLoading') : t('sessionHistoryLoadEarlier')}
            </Button>
          )}
          {page?.entries.map((entry, index) => (
            <TranscriptEntryRow key={`${entry.seq}:${index}`} entry={entry} markdownLabels={markdownLabels} t={t} />
          ))}
        </div>
      </div>
    </main>
  )
}

/** One transcript row: the Host labels the lane, the page renders its text as authored. */
function TranscriptEntryRow({ entry, markdownLabels, t }: {
  readonly entry: AgentTeamMemberSessionTranscriptEntry
  readonly markdownLabels: MarkdownLabels
  readonly t: TeamPagePayload['t']
}) {
  // Long entries start clamped behind the expand control; the toggle is
  // per-row view state nothing persists.
  const [expanded, setExpanded] = useState(false)
  const clampable = shouldClampMessage(entry.text)
  const clamped = clampable && !expanded
  const roleLabel = t(ROLE_LABEL_KEYS[entry.role])
  // Tool lanes are JSON-ish payloads, not prose: they keep the stored breaks
  // in a monospace block instead of becoming Markdown.
  const body = entry.role === 'tool-call' || entry.role === 'tool-result'
    ? <pre className={css.entryPre}>{entry.text}</pre>
    : <div className={css.entryMarkdown}><MarkdownText text={entry.text} labels={markdownLabels} /></div>
  return (
    <article className={css.entry} data-role={entry.role}>
      <div className={css.entryMeta}>
        <span className={css.entryRole}>{roleLabel}</span>
        <span className={css.entryTime}>{new Date(entry.time).toLocaleString()}</span>
        {clampable && (
          <button type="button" className={css.textButton} aria-expanded={expanded} onClick={() => { setExpanded(value => !value) }}>
            {expanded ? t('collapseMessage') : t('expandMessage')}
          </button>
        )}
      </div>
      <div className={clamped ? css.entryClamp : undefined}>{body}</div>
    </article>
  )
}

const ROLE_LABEL_KEYS: Record<AgentTeamMemberSessionTranscriptEntry['role'], TeamKey> = {
  system: 'historyRoleSystem',
  notice: 'historyRoleNotice',
  team: 'historyRoleTeam',
  user: 'historyRoleUser',
  assistant: 'historyRoleAssistant',
  'tool-call': 'historyRoleToolCall',
  'tool-result': 'historyRoleToolResult',
  error: 'historyRoleError',
  warning: 'historyRoleWarning',
}

/**
 * The external Member's audit face: the agent's own harness conversation,
 * synced by its heartbeat (activity note + bounded recent turns). The Host
 * keeps one latest-wins snapshot, so the panel polls on a slow interval while
 * mounted — a fresh beat replaces the whole view, and after a Host restart
 * the panel stays on "no heartbeat" until the agent beats again.
 */
function ExternalContextPanel({ memberId, workspaceId, loadExternalContext, t }: {
  readonly memberId: AgentTeamMemberId
  readonly workspaceId?: string
  readonly loadExternalContext: TeamPagePayload['loadExternalContext']
  readonly t: TeamPagePayload['t']
}) {
  const [context, setContext] = useState<AgentTeamExternalContextResult>()
  const [error, setError] = useState<string>()
  const loadToken = useRef(0)

  const load = useCallback(() => {
    if (workspaceId === undefined) return
    const token = loadToken.current += 1
    loadExternalContext({ workspaceId, memberId } as never)
      .then(result => {
        if (token !== loadToken.current) return
        if (!result.ok) {
          setError(result.error.message)
          return
        }
        setError(undefined)
        setContext(result.value)
      })
      .catch(cause => {
        if (token === loadToken.current) setError(cause instanceof Error ? cause.message : String(cause))
      })
  }, [loadExternalContext, memberId, workspaceId])

  useEffect(() => {
    load()
    const timer = setInterval(load, 10_000)
    return () => { clearInterval(timer); loadToken.current += 1 }
  }, [load])

  return (
    <div className={css.externalShell} data-external-context>
      <div className={css.externalHeader}>
        <div>
          <h2 className={css.externalTitle}>{t('externalContextTitle')}</h2>
          <p className={css.externalIntro}>{t('externalContextIntro')}</p>
        </div>
        <Button size="sm" variant="outline" onClick={load}>{t('externalContextRefresh')}</Button>
      </div>
      {error !== undefined && <p className={conversationCss.errorState} role="alert">{t('externalContextLoadFailed', { message: error })}</p>}
      {context === undefined && error === undefined && <p className={css.emptyNote}>{t('sessionHistoryLoading')}</p>}
      {context !== undefined && (context.lastBeatAt === undefined
        ? <p className={css.emptyNote}>{t('externalContextNever')}</p>
        : <>
            <p className={css.externalBeat}>{t('externalContextLastBeat', { time: new Date(context.lastBeatAt).toLocaleString() })}</p>
            {context.note !== undefined && (
              <div className={css.externalNote}>
                <span className={css.externalNoteLabel}>{t('externalContextNoteLabel')}</span>
                <span>{context.note}</span>
              </div>
            )}
            <div className={css.externalTurns} role="log" aria-live="polite">
              {context.entries?.map((entry, index) => (
                <article key={index} className={css.externalTurn} data-role={entry.role}>
                  <span className={css.externalTurnRole}>{entry.role}</span>
                  <p className={css.externalTurnText}>{entry.text}</p>
                </article>
              ))}
            </div>
          </>)}
    </div>
  )
}
