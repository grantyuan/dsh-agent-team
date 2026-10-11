import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AgentTeamClientMemberStatus,
  AgentTeamMemberSessionSummary,
  AgentTeamMemberSessionTranscriptEntry,
} from '@wowyuarm/dsh-agent-team/types'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamSidebarProps } from './slots.ts'
import createCss from './create.module.css'
import css from './session-history.module.css'

interface TranscriptPage {
  readonly entries: readonly AgentTeamMemberSessionTranscriptEntry[]
  readonly hasEarlier: boolean
  readonly nextBeforeSeq?: number
}

/**
 * The session-history dialog for one Member: every Session generation it has
 * run (the live one first, archived ancestors through the Host's lineage
 * walk), and a bounded read-only transcript of the selected generation. The
 * transcript is the Host's own stored-log render — opening this dialog never
 * activates, resumes, or writes a Member Session, which is why archived
 * generations stay browsable even though Harness refuses to open them as
 * live conversations.
 */
export function TeamSessionHistoryDialog({ status, loadMemberSessions, loadMemberSessionTranscript, onClose, t }: {
  readonly status: AgentTeamClientMemberStatus
  readonly loadMemberSessions: TeamSidebarProps['loadMemberSessions']
  readonly loadMemberSessionTranscript: TeamSidebarProps['loadMemberSessionTranscript']
  readonly onClose: () => void
  readonly t: TeamSidebarProps['t']
}) {
  const [generations, setGenerations] = useState<readonly AgentTeamMemberSessionSummary[]>()
  const [sessionsError, setSessionsError] = useState<string>()
  const [selected, setSelected] = useState<string>()
  const [page, setPage] = useState<TranscriptPage>()
  const [transcriptError, setTranscriptError] = useState<string>()
  const [loadingTranscript, setLoadingTranscript] = useState(false)
  const [maximized, setMaximized] = useState(false)
  const loadToken = useRef(0)

  useEffect(() => {
    let alive = true
    loadMemberSessions({ memberId: status.member.memberId })
      .then(result => {
        if (!alive) return
        if (!result.ok) {
          setSessionsError(result.error.message)
          return
        }
        setGenerations(result.value)
        const first = result.value.find(generation => generation.isCurrent) ?? result.value[0]
        if (first !== undefined) setSelected(first.sessionId)
      })
      .catch(cause => {
        if (alive) setSessionsError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => { alive = false }
  }, [loadMemberSessions, status.member.memberId])

  const loadPage = useCallback(async (sessionId: string, beforeSeq?: number): Promise<void> => {
    setLoadingTranscript(true)
    setTranscriptError(undefined)
    // A fast generation switch can leave an older response in flight; each
    // load claims a token and stale replies drop instead of overwriting.
    const token = (loadToken.current += 1)
    try {
      const result = await loadMemberSessionTranscript({
        memberId: status.member.memberId,
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
  }, [loadMemberSessionTranscript, status.member.memberId])

  useEffect(() => {
    if (selected === undefined) return
    setPage(undefined)
    void loadPage(selected)
  }, [selected, loadPage])

  const roleLabel = (role: AgentTeamMemberSessionTranscriptEntry['role']): string =>
    role === 'user' ? t('historyRoleUser') : role === 'assistant' ? t('historyRoleAssistant') : role === 'tool-call' ? t('historyRoleToolCall') : t('historyRoleToolResult')

  return (
    <Modal
      open
      onClose={onClose}
      title={t('sessionHistoryTitle', { name: status.member.handle })}
      closeLabel={t('close')}
      // A wide, drag-resizable transcript card (`.dialog` already declares
      // `overflow: hidden`, which is what arms the native resize handle);
      // the footer toggle swaps the card between that and the full frame.
      className={[createCss.historyModal, maximized ? createCss.historyModalMaximized : undefined].filter(Boolean).join(' ')}
      contentClassName={createCss.historyContent!}
      footer={<>
        <Button variant="outline" aria-pressed={maximized} onClick={() => { setMaximized(value => !value) }}>
          {maximized ? t('restoreDialog') : t('maximizeDialog')}
        </Button>
        <Button variant="outline" onClick={onClose}>{t('close')}</Button>
      </>}
    >
      <div className={css.shell}>
        <ul className={css.generationList} aria-label={t('sessionHistoryGenerations')}>
          {sessionsError !== undefined && <li className={createCss.error} role="alert">{sessionsError}</li>}
          {generations === undefined && sessionsError === undefined && <li className={css.emptyNote}>{t('sessionHistoryLoading')}</li>}
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
                    {generation.isCurrent ? t('sessionHistoryCurrent') : t('sessionHistoryGeneration', { index: index + 1 })}
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
        <div className={css.transcript} role="log" aria-live="polite">
          {loadingTranscript && page === undefined && <p className={css.emptyNote}>{t('sessionHistoryLoading')}</p>}
          {transcriptError !== undefined && (
            <p className={createCss.error} role="alert">
              <span>{transcriptError}</span>
              {selected !== undefined && <button type="button" className={css.textButton} onClick={() => { void loadPage(selected) }}>{t('retry')}</button>}
            </p>
          )}
          {!loadingTranscript && transcriptError === undefined && page !== undefined && page.entries.length === 0 && <p className={css.emptyNote}>{t('sessionHistoryEmpty')}</p>}
          {page !== undefined && page.hasEarlier && (
            <Button className={css.loadEarlier!} variant="outline" disabled={loadingTranscript} onClick={() => { if (selected !== undefined && page.nextBeforeSeq !== undefined) void loadPage(selected, page.nextBeforeSeq) }}>
              {loadingTranscript ? t('sessionHistoryLoading') : t('sessionHistoryLoadEarlier')}
            </Button>
          )}
          {page?.entries.map(entry => (
            <div key={entry.seq} className={css.entry}>
              <span className={css.entryMeta}>
                <span className={css.entryRole} data-role={entry.role}>{roleLabel(entry.role)}</span>
                <span className={css.entryTime}>{new Date(entry.time).toLocaleTimeString()}</span>
              </span>
              <span className={css.entryText}>{entry.text}</span>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  )
}
