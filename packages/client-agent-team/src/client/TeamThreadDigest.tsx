import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentTeamRequestId, AgentTeamSummarizeThreadResult, AgentTeamTaskRef, AgentTeamThreadRef } from '@wowyuarm/dsh-agent-team/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { Button, IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamConversationProps } from './slots.ts'
import { mintRequestId } from './requests.ts'
import css from './conversation.module.css'
import digestCss from './thread-digest.module.css'

type ThreadDigest = AgentTeamSummarizeThreadResult['digest']

interface TeamThreadDigestProps {
  readonly workspaceId: WorkspaceId
  readonly threadRef: AgentTeamThreadRef
  readonly taskRef?: AgentTeamTaskRef
  /** The Thread revision currently on screen: the digest is read at it, and the decision reply commits against it. */
  readonly revision: number
  readonly summarizeThread: TeamConversationProps['summarizeThread']
  readonly reply: TeamConversationProps['reply']
  readonly disabled: boolean
  readonly t: TeamConversationProps['t']
}

/**
 * One digest per Thread revision, kept in the browser across refreshes:
 * reopening the same Thread state answers from storage instead of paying the
 * model call twice, and only a committed new fact — the revision moving —
 * forces a fresh read. The store is presentation memory, never a Team fact:
 * the Host digests on demand and commits nothing. Values are re-validated on
 * the way in, so a hand-edited entry can never render, and the store stays
 * bounded by evicting the oldest entries first.
 */
const DIGEST_STORAGE_KEY = 'dsh.agent-team.thread-digest'
const DIGEST_STORE_LIMIT = 40

function isStoredDigest(value: unknown): value is ThreadDigest {
  if (value === null || typeof value !== 'object') return false
  const digest = value as Record<string, unknown>
  return typeof digest.summary === 'string' && Array.isArray(digest.keyPoints)
    && digest.keyPoints.every(entry => typeof entry === 'string')
    && typeof digest.needsHumanDecision === 'boolean'
    && (digest.decisionQuestion === undefined || typeof digest.decisionQuestion === 'string')
    && (digest.options === undefined || (Array.isArray(digest.options) && digest.options.every(entry => typeof entry === 'string')))
    && (digest.optionSelection === undefined || digest.optionSelection === 'single' || digest.optionSelection === 'multiple')
}

function readDigestStore(): Record<string, ThreadDigest> {
  try {
    const raw = localStorage.getItem(DIGEST_STORAGE_KEY)
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return {}
    const entries: Record<string, ThreadDigest> = {}
    for (const [key, digest] of Object.entries(parsed as Record<string, unknown>)) {
      if (isStoredDigest(digest)) entries[key] = digest
    }
    return entries
  } catch { return {} }
}

function loadDigest(key: string): ThreadDigest | undefined {
  return readDigestStore()[key]
}

function rememberDigest(key: string, digest: ThreadDigest): void {
  try {
    const entries = readDigestStore()
    delete entries[key]
    entries[key] = digest
    const keys = Object.keys(entries)
    for (let index = 0; index + DIGEST_STORE_LIMIT < keys.length; index += 1) delete entries[keys[index]!]
    localStorage.setItem(DIGEST_STORAGE_KEY, JSON.stringify(entries))
  } catch { /* a full or blocked store only costs one repeat call */ }
}

function forgetDigest(key: string): void {
  try {
    const entries = readDigestStore()
    delete entries[key]
    localStorage.setItem(DIGEST_STORAGE_KEY, JSON.stringify(entries))
  } catch { /* as above */ }
}

/**
 * The plain-language recap above the timeline: what the Thread asked, what
 * has happened, and — when it waits on the Human — the choices on offer. The
 * reader answers a decision without reading the whole timeline: pick the
 * Thread's own options (one when the digest read them as mutually exclusive,
 * several when it read them as combinable), or write an opinion; either way
 * the answer goes out through the normal durable reply path, so it lands in
 * the ledger as an ordinary Message like every other Human word.
 */
export function TeamThreadDigest({ workspaceId, threadRef, taskRef, revision, summarizeThread, reply, disabled, t }: TeamThreadDigestProps) {
  // The recap is read once per opening at the revision the reader arrived at:
  // a Message landing mid-view must not replace the summary being acted on.
  // The seat keys this page by Thread, so a Thread switch always remounts and
  // pins its own revision; the decision reply still commits against the live
  // revision, where the page's own fences would surface any race.
  const [pinnedRevision] = useState(revision)
  const cacheKey = `${threadRef}:${pinnedRevision}`
  const [digest, setDigest] = useState<ThreadDigest | undefined>(() => loadDigest(cacheKey))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [status, setStatus] = useState<string>()
  const [chosen, setChosen] = useState<readonly number[]>([])
  const [opinion, setOpinion] = useState('')
  const [sending, setSending] = useState(false)
  const requestIdRef = useRef<AgentTeamRequestId>()
  const mountedRef = useRef(true)
  const ticketRef = useRef(0)
  const abortRef = useRef<AbortController>()

  const generate = useCallback(async (): Promise<void> => {
    const hit = loadDigest(cacheKey)
    if (hit !== undefined) {
      setDigest(hit)
      setError(undefined)
      return
    }
    const ticket = ++ticketRef.current
    const controller = new AbortController()
    abortRef.current = controller
    setLoading(true)
    const result = await summarizeThread({ workspaceId, threadRef }, controller.signal)
      .catch((cause: unknown): { ok: false; error: { message: string } } => ({
        ok: false,
        error: { message: cause instanceof Error ? cause.message : String(cause) },
      }))
    if (!mountedRef.current || ticket !== ticketRef.current) return
    setLoading(false)
    if (result.ok) {
      rememberDigest(cacheKey, result.value.digest)
      setDigest(result.value.digest)
      setError(undefined)
    } else {
      setError(result.error.message)
    }
  }, [cacheKey, summarizeThread, threadRef, workspaceId])

  // One call per opening: the pinned key answers from memory when the reader
  // comes back to the same Thread state, and nothing here re-reads mid-view.
  useEffect(() => {
    mountedRef.current = true
    ticketRef.current += 1
    setDigest(loadDigest(cacheKey))
    setError(undefined)
    setStatus(undefined)
    setChosen([])
    setOpinion('')
    if (loadDigest(cacheKey) === undefined) void generate()
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
    }
  }, [cacheKey, generate])

  const options = digest?.options ?? []
  const multiple = digest?.optionSelection === 'multiple'
  const canSend = !sending && (chosen.length > 0 || opinion.trim() !== '')

  // Combinable asks answer with every ticked option in the digest's own
  // order, so the Message reads as the Thread listed them, not as click order.
  const chosenText = [...chosen].sort((left, right) => left - right)
    .map(index => options[index]).filter((option): option is string => option !== undefined)
    .join(t('digestOptionJoin'))

  const toggleOption = (index: number): void => {
    setStatus(undefined)
    setChosen(current => multiple
      ? (current.includes(index) ? current.filter(placed => placed !== index) : [...current, index])
      : (current.length === 1 && current[0] === index ? [] : [index]))
  }

  const sendDecision = async (): Promise<void> => {
    if (disabled || sending || digest === undefined) return
    const body = opinion.trim() !== '' ? opinion.trim() : chosen.length === 0 ? '' : `${t('digestDecisionPrefix')}${chosenText}`
    if (body === '') return
    setSending(true)
    setError(undefined)
    setStatus(undefined)
    const id = requestIdRef.current ?? mintRequestId()
    requestIdRef.current = id
    try {
      const result = await reply({ requestId: id, workspaceId, threadRef, ...(taskRef === undefined ? {} : { taskRef }), body, baseRevision: revision, recipients: [] })
      if (result.ok && result.value.kind === 'committed') {
        requestIdRef.current = undefined
        setChosen([])
        setOpinion('')
        setStatus(t('digestDecisionSent'))
      } else if (result.ok && result.value.kind === 'stale_revision') {
        requestIdRef.current = undefined
        setError(t('staleRevision'))
      } else if (result.ok) {
        requestIdRef.current = undefined
        setError(result.value.kind === 'unread_required' ? t('unreadRequired', { count: result.value.unreadCount }) : result.value.kind === 'member_not_following' ? t('memberNotFollowing', { ids: result.value.memberIds.join(', ') }) : t('mentionConfirmation'))
      } else {
        setError(result.error.message)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (mountedRef.current) setSending(false)
    }
  }

  if (digest === undefined && loading && error === undefined) {
    return <section className={digestCss.digestSection} aria-label={t('digestTitle')}>
      <p className={css.loadingState}><span className={css.loadingMark} aria-hidden="true" />{t('digestGenerating')}</p>
    </section>
  }
  if (digest === undefined) {
    if (error === undefined) return <div />
    return <section className={digestCss.digestSection} aria-label={t('digestTitle')}>
      <div className={digestCss.digestError} role="alert"><span>{t('digestFailed')}</span><Button size="sm" variant="outline" onClick={() => { void generate() }}>{t('retry')}</Button></div>
    </section>
  }
  return <section className={digestCss.digestSection} aria-label={t('digestTitle')} data-team-digest>
    <h2>{t('digestTitle')}</h2>
    <p className={digestCss.digestSummary}>{digest.summary}</p>
    {digest.keyPoints.length > 0 && <ul className={digestCss.digestPoints}>
      {digest.keyPoints.map((point, index) => <li key={index}>{point}</li>)}
    </ul>}
    {digest.needsHumanDecision && <div className={digestCss.digestDecision}>
      <h3>{digest.decisionQuestion ?? t('digestDecisionNeeded')}</h3>
      <p className={digestCss.digestHint}>{t(multiple ? 'digestChooseOptionMulti' : 'digestChooseOption')}</p>
      {options.length > 0 && <div className={digestCss.digestOptions} role={multiple ? 'group' : 'radiogroup'} aria-label={t('digestDecisionNeeded')}>
        {options.map((option, index) => <button
          key={index}
          type="button"
          role={multiple ? 'checkbox' : 'radio'}
          aria-checked={chosen.includes(index)}
          className={chosen.includes(index) ? `${digestCss.digestOption} ${digestCss.digestOptionChosen}` : digestCss.digestOption}
          title={option}
          onClick={() => { toggleOption(index) }}
        >{option}</button>)}
      </div>}
      <label className={digestCss.digestOpinionLabel} htmlFor={`team-digest-opinion-${threadRef}`}>{t('digestOtherOpinion')}</label>
      <textarea
        id={`team-digest-opinion-${threadRef}`}
        className={digestCss.digestOpinion}
        rows={2}
        value={opinion}
        placeholder={t('digestOtherOpinionPlaceholder')}
        onChange={event => { setOpinion(event.target.value); setStatus(undefined) }}
      />
      <div className={digestCss.digestActions}>
        {chosen.length > 0 && opinion.trim() === ''
          ? <Button size="sm" variant="primary" disabled={disabled || sending} onClick={() => { void sendDecision() }}>{t('digestSendChoice')}</Button>
          : <Button size="sm" variant="primary" disabled={disabled || sending || !canSend} onClick={() => { void sendDecision() }}>{t('digestSendOpinion')}</Button>}
        {status !== undefined && <span className={digestCss.digestStatus} role="status">{status}</span>}
        {error !== undefined && <span className={digestCss.digestStatus} role="alert">{error}</span>}
      </div>
    </div>}
    <div className={digestCss.digestFooter}>
      <Button size="sm" variant="ghost" icon={<IconRefreshOutlineRegular />} disabled={disabled || loading} onClick={() => { forgetDigest(cacheKey); void generate() }}>{t('digestRegenerate')}</Button>
    </div>
  </section>
}
