import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentTeamAddMemberRequest,
  AgentTeamClientMemberStatus,
  AgentTeamInterruptRef,
  AgentTeamInterruptView,
  AgentTeamMemberId,
  AgentTeamMemberTaskQueue,
  AgentTeamModelSelection,
  AgentTeamTaskRow,
} from '@wowyuarm/dsh-agent-team/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { Button, IconChecklistOutlineRegular, IconChevronDownOutlineRegular, IconArchiveOutlineRegular, IconClockOutlineRegular, IconEditOutlineRegular, IconGaugeOutlineRegular, IconInspectOutlineRegular, IconNewChatOutlineRegular, IconPauseOutlineRegular, IconPlayOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular, Input, Menu, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { claimersLabel, formatAbsoluteTime, formatInboxTime, formatTaskStatus, taskStatusDot } from './team-formatters.ts'
import type { TeamSidebarProps } from './slots.ts'
import { TeamMemberIdentity } from './TeamMemberRow.tsx'
import { SortableRow, useSidebarRowDrag } from './sidebar-drag.tsx'
import { moveSidebarItem, useSidebarOrder } from './sidebar-order.ts'
import { useSidebarSectionOpen, setSidebarSectionOpen } from './sidebar-sections.ts'
import { mintRequestId } from './requests.ts'
import { diagnosticText } from './TeamPresenceDot.tsx'
import { TeamRowMenu } from './TeamRowMenu.tsx'
import { TeamSidebarSection } from './TeamSidebarSection.tsx'
import { TeamStateDot } from './TeamStateDot.tsx'
import { AgentEditorDialog, ContextPickerField, MemberPromptDialog, ModelPickerField, parseContextWindow, sameModel, warmModelCatalog } from './TeamMemberEditor.tsx'
import { TeamAgentImport } from './TeamAgentImport.tsx'
import createCss from './create.module.css'
import css from './sidebar.module.css'

interface TeamAgentsPanelProps {
  readonly workspaceId: WorkspaceId
  readonly loadMembers: TeamSidebarProps['loadMembers']
  readonly loadMemberTasks: TeamSidebarProps['loadMemberTasks']
  readonly subscribeChanges: TeamSidebarProps['subscribeChanges']
  readonly addMember: TeamSidebarProps['addMember']
  readonly updateMember: TeamSidebarProps['updateMember']
  readonly loadPromptView: TeamSidebarProps['loadPromptView']
  readonly curateMemberPrompt: TeamSidebarProps['curateMemberPrompt']
  readonly recoverMember: TeamSidebarProps['recoverMember']
  readonly clearMemberContext: TeamSidebarProps['clearMemberContext']
  readonly compactMemberContext: TeamSidebarProps['compactMemberContext']
  readonly loadMemberInterrupts: TeamSidebarProps['loadMemberInterrupts']
  readonly releaseMemberInterrupt: TeamSidebarProps['releaseMemberInterrupt']
  readonly selectSessionHistory: TeamSidebarProps['selectSessionHistory']
  readonly diagnoseMember: TeamSidebarProps['diagnoseMember']
  readonly archiveMember: TeamSidebarProps['archiveMember']
  readonly joinWorkspace: TeamSidebarProps['joinWorkspace']
  readonly leaveWorkspace: TeamSidebarProps['leaveWorkspace']
  readonly loadChannels: TeamSidebarProps['loadChannels']
  readonly loadModels: TeamSidebarProps['loadModels']
  /** Human Message lane for the task-reassignment consultation to the Team leader. */
  readonly sendMessage: TeamSidebarProps['sendMessage']
  readonly selectThread: TeamSidebarProps['selectThread']
  /** The Member Session currently embedded in the conversation seat, if any. */
  readonly memberSessionId?: AgentTeamClientMemberStatus['member']['sessionId']
  readonly openMemberSession: TeamSidebarProps['openMemberSession']
  readonly onCreatingChange: (request: AgentTeamAddMemberRequest, creating: boolean) => void
  readonly t: TeamSidebarProps['t']
}

export function TeamAgentsPanel({ workspaceId, loadMembers, loadMemberTasks, subscribeChanges, addMember, updateMember, loadPromptView, curateMemberPrompt, recoverMember, clearMemberContext, compactMemberContext, loadMemberInterrupts, releaseMemberInterrupt, selectSessionHistory, diagnoseMember, archiveMember, joinWorkspace, leaveWorkspace, loadChannels, loadModels, sendMessage, selectThread, memberSessionId, openMemberSession, onCreatingChange, t }: TeamAgentsPanelProps) {
  const [members, setMembers] = useState<readonly AgentTeamClientMemberStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [formOpen, setFormOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const [handle, setHandle] = useState('')
  const [description, setDescription] = useState('')
  const [model, setModel] = useState<AgentTeamModelSelection | undefined>(undefined)
  const [policy, setPolicy] = useState<'continue' | 'fresh'>('continue')
  const [windowText, setWindowText] = useState('')
  const [promptText, setPromptText] = useState('')
  const [promptOpen, setPromptOpen] = useState(false)
  const parsedWindow = parseContextWindow(windowText)
  const windowInvalid = Number.isNaN(parsedWindow)
  const [creating, setCreating] = useState(false)
  const [retryRequest, setRetryRequest] = useState<AgentTeamAddMemberRequest>()
  const triggerRef = useRef<HTMLButtonElement>(null)
  // Same presentation-preference ordering as the Channels list; the drag
  // commits through one shared mutation.
  const agentRefs = useMemo(() => members.map(status => status.member.memberId), [members])
  const orderedAgentRefs = useSidebarOrder(workspaceId, 'agents', agentRefs)
  const orderedMembers = useMemo(() => {
    const byId = new Map(members.map(status => [status.member.memberId, status]))
    return orderedAgentRefs.map(memberId => byId.get(memberId)).filter(status => status !== undefined)
  }, [orderedAgentRefs, members])
  const applyMove = (movedRef: typeof agentRefs[number], targetRef: typeof agentRefs[number], marker: 'before' | 'after'): void => {
    void moveSidebarItem(workspaceId, 'agents', orderedAgentRefs, movedRef, targetRef, marker)
  }
  const drag = useSidebarRowDrag({ refs: orderedAgentRefs, onCommit: applyMove })
  const sectionOpen = useSidebarSectionOpen(workspaceId, 'agents')

  // Observed old→new Session binding per Member while this panel is
  // mounted. A model-initiated rollover moves the binding without any
  // Client action; when the conversation seat is showing the Member's
  // previous live Session, the panel follows to the new one exactly once —
  // but only after the refreshed status is actually active, so the commit
  // window (binding moved, new Session not yet live) never redirects to a
  // Session that does not exist. The follow requires the seat to still show
  // the previous Session at completion as well: a rollover observed while
  // unavailable stays pending, and navigating away before it completes
  // cancels the follow instead of pulling the pane back.
  const observedSessionIds = useRef(new Map<string, AgentTeamClientMemberStatus['member']['sessionId']>())
  const pendingFollows = useRef(new Map<string, { readonly previousSessionId: AgentTeamClientMemberStatus['member']['sessionId']; readonly nextSessionId: AgentTeamClientMemberStatus['member']['sessionId'] }>())
  // The seat's embedded Session id rides a ref: the change subscription may
  // deliver an invalidation through a refresh closure captured before the
  // seat rebinds, and the follow decision must always read the live value.
  const seatSessionIdRef = useRef(memberSessionId)
  seatSessionIdRef.current = memberSessionId
  const openMemberSessionRef = useRef(openMemberSession)
  openMemberSessionRef.current = openMemberSession
  const followRollover = useCallback((statuses: readonly AgentTeamClientMemberStatus[]) => {
    for (const status of statuses) {
      const memberId = status.member.memberId
      const observed = observedSessionIds.current.get(memberId)
      if (observed === undefined) {
        observedSessionIds.current.set(memberId, status.member.sessionId)
        continue
      }
      if (observed !== status.member.sessionId) {
        observedSessionIds.current.set(memberId, status.member.sessionId)
        // Only the exact previous live page follows; browsing an older
        // archive or another Member stays untouched. A binding change seen
        // before any page is embedded is still recorded so the observation
        // baseline stays current.
        const seatSessionId = seatSessionIdRef.current
        if (seatSessionId !== undefined && observed === seatSessionId) pendingFollows.current.set(memberId, { previousSessionId: observed, nextSessionId: status.member.sessionId })
        else pendingFollows.current.delete(memberId)
      }
      const pending = pendingFollows.current.get(memberId)
      if (pending !== undefined && pending.nextSessionId === status.member.sessionId && status.availability === 'active') {
        // The seat must still show the followed Member's previous Session at
        // completion too: the commit window can outlive the user's patience,
        // and navigating away (or onto another Member/archive view) cancels
        // the follow instead of yanking the pane back onto the new Session.
        const seatSessionId = seatSessionIdRef.current
        pendingFollows.current.delete(memberId)
        if (seatSessionId !== undefined && seatSessionId === pending.previousSessionId) openMemberSessionRef.current(pending.nextSessionId)
      }
    }
  }, [])

  // Only the first refresh owns the loading surface; presence wakes (Agent
  // running/idle) ride the dedicated scope and refresh rows in place.
  const loadedRef = useRef(false)
  const refresh = useCallback(async () => {
    if (!loadedRef.current) setLoading(true)
    const result = await loadMembers({ workspaceId })
    if (result.ok) {
      // Archived Members are hidden from every surface; the row disappears
      // the moment the workspace-scope wake delivers the archived state.
      const next = result.value.filter(status => status.member.state !== 'inactive' && status.member.state !== 'archived')
      setMembers(next)
      followRollover(next)
      setError(undefined)
      loadedRef.current = true
    } else {
      setError(result.error.message)
    }
    setLoading(false)
  }, [loadMembers, workspaceId, followRollover])

  useEffect(() => { void refresh() }, [refresh])
  // Warm the Host model catalog while the roster loads, so the create and
  // edit pickers open with rows instead of paying the first read on open.
  // Mount-scoped (not per refresh): presence wakes must not refetch it.
  useEffect(() => { warmModelCatalog(loadModels) }, [loadModels])
  useEffect(() => subscribeChanges({ kind: 'workspace', workspaceId }, update => {
    if (update.type === 'failed') {
      setError(update.message)
      return
    }
    // The section stays mounted across Channel creation, so the Member roster
    // rides every workspace invalidation.
    void refresh()
  }), [subscribeChanges, refresh, workspaceId])
  // Presence transitions commit nothing: the Host wakes only this scope, so
  // the green dots stay live without any catalog refetch.
  useEffect(() => subscribeChanges({ kind: 'presence', workspaceId }, update => {
    if (update.type === 'failed') {
      setError(update.message)
      return
    }
    void refresh()
  }), [subscribeChanges, refresh, workspaceId])

  const closeForm = () => {
    if (creating) return
    setFormOpen(false)
    queueMicrotask(() => { triggerRef.current?.focus() })
  }

  const provision = async (request: AgentTeamAddMemberRequest) => {
    setCreating(true)
    onCreatingChange(request, true)
    setError(undefined)
    setRetryRequest(request)
    try {
      const result = await addMember(request)
      if (result.ok) {
        const committed = { ...result.value.status, workspaceIds: result.value.workspaceIds }
        setMembers(current => {
          const retained = current.filter(status => status.member.memberId !== committed.member.memberId)
          return committed.member.state === 'inactive' || committed.member.state === 'archived' ? retained : [...retained, committed]
        })
        setHandle('')
        setDescription('')
        setModel(undefined)
        setPolicy('continue')
        setWindowText('')
        setPromptText('')
        setFormOpen(false)
        if (result.value.status.presence === 'unavailable') {
          setError(diagnosticText(result.value.status) || t('statusUnavailable'))
        } else {
          setRetryRequest(undefined)
        }
        queueMicrotask(() => { triggerRef.current?.focus() })
      } else {
        await refresh()
        setError(result.error.message)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setCreating(false)
      onCreatingChange(request, false)
    }
  }

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const normalizedHandle = handle.trim()
    const normalizedDescription = description.trim()
    if (normalizedHandle.length === 0 || creating || windowInvalid) return
    const stagedPrompt = promptText.trim() === '' ? undefined : promptText
    const sameRequest = retryRequest !== undefined && retryRequest.workspaceId === workspaceId
      && retryRequest.handle === normalizedHandle && retryRequest.description === normalizedDescription
      && sameModel(retryRequest.model, model)
      && (retryRequest.contextStartPolicy ?? 'continue') === policy
      && retryRequest.contextWindow === parsedWindow
      && (retryRequest.prompt?.customPrompt ?? undefined) === stagedPrompt
      && retryRequest.channelRefs.length === 0
    void provision(sameRequest ? retryRequest : {
      requestId: mintRequestId(),
      workspaceId,
      handle: normalizedHandle,
      description: normalizedDescription,
      presetId: 'team-member',
      // No initial Channels at creation: the Member joins Channels later from
      // the Channel side and stays reachable through its DM view meanwhile.
      channelRefs: [],
      ...(model === undefined ? {} : { model }),
      // Same absent-clears mapping as the editor: the fresh policy is only
      // sent when picked, and an empty window input means "follow the route
      // window".
      ...(policy === 'fresh' ? { contextStartPolicy: policy } : {}),
      ...(parsedWindow === undefined ? {} : { contextWindow: parsedWindow }),
      // The staged paragraph rides the member-added commit; an empty or blank
      // one stays absent — the same shape the Host's normalization stores.
      ...(stagedPrompt === undefined ? {} : { prompt: { customPrompt: stagedPrompt } }),
    })
  }

  return (
    <div className={css.panel}>
      <Modal
        open={formOpen}
        onClose={closeForm}
        title={t('addAgent')}
        closeLabel={t('close')}
        contentClassName={createCss.dialogContent!}
        footer={<><Button variant="outline" disabled={creating} onClick={closeForm}>{t('cancel')}</Button>{!importing && <Button type="submit" form="team-agent-create-form" variant="primary" disabled={creating || handle.trim().length === 0 || windowInvalid}>{creating ? t('creatingAgent') : t('createAgent')}</Button>}</>}
      >
        <Button className={createCss.modeSwitch!} variant="outline" disabled={creating} aria-expanded={importing} onClick={() => { setImporting(value => !value); setError(undefined) }}>{importing ? t('createAgent') : t('importAgentTitle')}</Button>
        {formOpen && importing ? <TeamAgentImport workspaceId={workspaceId} loadMembers={loadMembers} joinWorkspace={joinWorkspace} onPending={setCreating} onJoined={async () => { await refresh(); setFormOpen(false); queueMicrotask(() => { triggerRef.current?.focus() }) }} t={t} /> : <form id="team-agent-create-form" className={createCss.form} onSubmit={submit}>
          <label className={createCss.field}>
            <span>{t('agentName')}</span>
            <Input className={createCss.input!} value={handle} onChange={event => { setHandle(event.target.value); setRetryRequest(undefined) }} disabled={creating} autoFocus />
          </label>
          <label className={createCss.field}>
            <span>{t('agentDescription')}{t('optionalSuffix')}</span>
            <Input className={createCss.input!} value={description} placeholder={t('agentDescriptionPlaceholder')} onChange={event => { setDescription(event.target.value); setRetryRequest(undefined) }} disabled={creating} />
          </label>
          <ModelPickerField model={model} onModelChange={choice => { setModel(choice); setRetryRequest(undefined) }} loadModels={loadModels} disabled={creating} t={t} />
          <ContextPickerField
            policy={policy}
            onPolicyChange={next => { setPolicy(next); setRetryRequest(undefined) }}
            windowText={windowText}
            onWindowTextChange={text => { setWindowText(text); setRetryRequest(undefined) }}
            invalid={windowInvalid}
            disabled={creating}
            t={t}
          />
          <div className={createCss.field}>
            <span>{t('memberPrompt')}</span>
            <Button variant="outline" disabled={creating} onClick={() => { setPromptOpen(true) }}>{t('memberPromptEdit')}</Button>
            <small className={css.editHint}>{t('memberPromptHint')}</small>
          </div>
          {formOpen && error !== undefined && <p className={createCss.error} role="alert">{error}</p>}
        </form>}
      </Modal>
      {formOpen && promptOpen && (
        <MemberPromptDialog
          mode="stage"
          initialText={promptText}
          onApply={next => { setPromptText(next); setRetryRequest(undefined) }}
          onClose={() => { setPromptOpen(false) }}
          t={t}
        />
      )}
      <TeamSidebarSection
        title={t('agents')}
        open={sectionOpen}
        onToggle={open => { setSidebarSectionOpen(workspaceId, 'agents', open) }}
        actions={(
          <Tooltip label={t('addAgent')} delayMs={500}>
            <button ref={triggerRef} type="button" className={css.iconButton} aria-label={t('addAgent')} onClick={() => { setError(undefined); setImporting(false); setFormOpen(true) }}>
              <IconPlusOutlineRegular size={14} />
            </button>
          </Tooltip>
        )}
      >
        {loading && members.length === 0 && <p className={css.emptyState}>{t('loadingAgents')}</p>}
        {/* `members` is empty both before the first successful load and after a
            failed one, so the empty claim additionally requires a clear error. */}
        {!loading && error === undefined && members.length === 0 && <p className={css.emptyState}>{t('emptyAgents')}</p>}
        <div className={css.agentList}>
          {orderedMembers.map(status => (
            <SortableRow key={status.member.memberId} drag={drag} orderKey={status.member.memberId}>
              <AgentRow workspaceId={workspaceId} leaveWorkspace={leaveWorkspace} status={status} {...(memberSessionId === undefined ? {} : { current: status.member.sessionId === memberSessionId })} updateMember={updateMember} loadPromptView={loadPromptView} curateMemberPrompt={curateMemberPrompt} recoverMember={recoverMember} clearMemberContext={clearMemberContext} compactMemberContext={compactMemberContext} loadMemberInterrupts={loadMemberInterrupts} releaseMemberInterrupt={releaseMemberInterrupt} selectSessionHistory={selectSessionHistory} diagnoseMember={diagnoseMember} archiveMember={archiveMember} loadChannels={loadChannels} loadModels={loadModels} openMemberSession={openMemberSession} members={members} loadMemberTasks={loadMemberTasks} sendMessage={sendMessage} selectThread={selectThread} onUpdated={refresh} t={t} />
            </SortableRow>
          ))}
        </div>
      </TeamSidebarSection>
      {!formOpen && error !== undefined && (
        <div className={css.retryError} role="alert">
          <span>{error}</span>
          {retryRequest !== undefined && <button type="button" className={css.textButton} disabled={creating} onClick={() => { setFormOpen(true) }}>{t('retry')}</button>}
        </div>
      )}
    </div>
  )
}

/**
 * One sidebar Agent row: the select button opens the Member's own Session
 * conversation page, the avatar carries identity plus the presence badge, and
 * the row menu opens the editor. The row menu's Task-queue entry opens the
 * Member's working queue — current Claims and unclaimed Channel work, each
 * row opening its Thread, each row asking the Team leader to reassign it.
 */
function AgentRow({ workspaceId, leaveWorkspace, status, current, updateMember, loadPromptView, curateMemberPrompt, recoverMember, clearMemberContext, compactMemberContext, loadMemberInterrupts, releaseMemberInterrupt, selectSessionHistory, diagnoseMember, archiveMember, loadChannels, loadModels, openMemberSession, members, loadMemberTasks, sendMessage, selectThread, onUpdated, t }: {
  readonly workspaceId: WorkspaceId
  readonly leaveWorkspace: TeamSidebarProps['leaveWorkspace']
  readonly status: AgentTeamClientMemberStatus
  /** This Member's Session is the one embedded in the conversation seat. */
  readonly current?: boolean
  readonly updateMember: TeamSidebarProps['updateMember']
  readonly loadPromptView: TeamSidebarProps['loadPromptView']
  readonly curateMemberPrompt: TeamSidebarProps['curateMemberPrompt']
  readonly recoverMember: TeamSidebarProps['recoverMember']
  readonly clearMemberContext: TeamSidebarProps['clearMemberContext']
  readonly compactMemberContext: TeamSidebarProps['compactMemberContext']
  readonly loadMemberInterrupts: TeamSidebarProps['loadMemberInterrupts']
  readonly releaseMemberInterrupt: TeamSidebarProps['releaseMemberInterrupt']
  readonly selectSessionHistory: TeamSidebarProps['selectSessionHistory']
  readonly diagnoseMember: TeamSidebarProps['diagnoseMember']
  readonly archiveMember: TeamSidebarProps['archiveMember']
  readonly loadChannels: TeamSidebarProps['loadChannels']
  readonly loadModels: TeamSidebarProps['loadModels']
  readonly openMemberSession: TeamSidebarProps['openMemberSession']
  /** The Workspace roster, behind the reassign dialog's taker picker. */
  readonly members: readonly AgentTeamClientMemberStatus[]
  readonly loadMemberTasks: TeamSidebarProps['loadMemberTasks']
  readonly sendMessage: TeamSidebarProps['sendMessage']
  readonly selectThread: TeamSidebarProps['selectThread']
  readonly onUpdated: () => Promise<void> | void
  readonly t: TeamSidebarProps['t']
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [interruptsOpen, setInterruptsOpen] = useState(false)
  const [tasksOpen, setTasksOpen] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [compacting, setCompacting] = useState(false)
  const [rowAlert, setRowAlert] = useState<string>()
  const [archivePending, setArchivePending] = useState(false)
  const [resetPending, setResetPending] = useState(false)
  const [compactPending, setCompactPending] = useState(false)
  const [diagnosePending, setDiagnosePending] = useState(false)
  const [compactModel, setCompactModel] = useState<AgentTeamModelSelection | undefined>(undefined)
  const archiveRequest = useRef<ReturnType<typeof mintRequestId>>()
  const withdrawing = workspaceId !== status.member.workspaceId
  // Both row actions ride the same runtime remote: the Host steers a live
  // session, rebuilds an orphaned composition, or re-runs a failed activation.
  const recover = async (): Promise<void> => {
    try {
      const result = await recoverMember({
        requestId: mintRequestId(),
        workspaceId: status.member.workspaceId,
        memberId: status.member.memberId,
      })
      await onUpdated()
      if (!result.ok) {
        setRowAlert(t('restartFailed', { message: result.error.message }))
        return
      }
      if (result.value.status.availability === 'unavailable') {
        setRowAlert(t('restartStillUnavailable', { diagnostic: diagnosticText(result.value.status) || t('statusUnavailable') }))
        return
      }
      setRowAlert(undefined)
      // A page opened while the Member was down predates the live Session;
      // re-selecting is a no-op when already bound and rebinds when stale.
      if (current === true) openMemberSession(status.member.sessionId)
    } catch (cause) {
      setRowAlert(t('restartFailed', { message: cause instanceof Error ? cause.message : String(cause) }))
    }
  }
  const archive = async (): Promise<void> => {
    if (archivePending) return
    setArchivePending(true)
    setRowAlert(undefined)
    archiveRequest.current ??= mintRequestId()
    const request = { requestId: archiveRequest.current, memberId: status.member.memberId }
    try {
      const result = withdrawing ? await leaveWorkspace({ ...request, workspaceId }) : await archiveMember(request)
      if (!result.ok) throw new Error(result.error.message)
      setArchiving(false)
      archiveRequest.current = undefined
      await onUpdated()
    } catch (cause) {
      setRowAlert(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setArchivePending(false)
    }
  }
  const reset = async (): Promise<void> => {
    if (resetPending) return
    setResetPending(true)
    setRowAlert(undefined)
    try {
      const result = await clearMemberContext({
        requestId: mintRequestId(),
        workspaceId: status.member.workspaceId,
        memberId: status.member.memberId,
      })
      if (!result.ok) throw new Error(result.error.message)
      setResetting(false)
      await onUpdated()
      // The seat may still show the retired Session; rebind it to the renewed one.
      if (current === true) openMemberSession(result.value.status.member.sessionId)
    } catch (cause) {
      setRowAlert(t('resetAgentFailed', { message: cause instanceof Error ? cause.message : String(cause) }))
    } finally {
      setResetPending(false)
    }
  }
  const compact = async (): Promise<void> => {
    if (compactPending) return
    setCompactPending(true)
    setRowAlert(undefined)
    try {
      const result = await compactMemberContext({
        requestId: mintRequestId(),
        workspaceId: status.member.workspaceId,
        memberId: status.member.memberId,
        ...(compactModel === undefined ? {} : { model: compactModel }),
      })
      if (!result.ok) throw new Error(result.error.message)
      setCompacting(false)
      // Schedule-time acknowledgement only: the Host runs the compaction
      // behind the Member's current activity, and the conversation surface
      // shows the committed summary once it lands.
      setRowAlert(t('compactAgentScheduled'))
      await onUpdated()
    } catch (cause) {
      setRowAlert(t('compactAgentFailed', { message: cause instanceof Error ? cause.message : String(cause) }))
    } finally {
      setCompactPending(false)
    }
  }
  // The Host creates or reuses the durable `doctor` Member, starts it on a
  // fresh Session, and hands it the failed Member's transcript as research
  // material; the doctor reports its analysis to the Human.
  const diagnose = async (): Promise<void> => {
    if (diagnosePending) return
    setDiagnosePending(true)
    setRowAlert(undefined)
    try {
      const result = await diagnoseMember({
        requestId: mintRequestId(),
        workspaceId: status.member.workspaceId,
        memberId: status.member.memberId,
      })
      if (!result.ok) throw new Error(result.error.message)
      setRowAlert(t('analyzeAgentDispatched', { name: status.member.handle }))
      await onUpdated()
    } catch (cause) {
      setRowAlert(t('analyzeAgentFailed', { message: cause instanceof Error ? cause.message : String(cause) }))
    } finally {
      setDiagnosePending(false)
    }
  }
  return (
    <>
      <div className={css.agentRow} data-agent-row data-menu-open={menuOpen || undefined}>
        <button type="button" className={css.agentSelect} aria-label={t('openAgentSession', { name: status.member.handle })} aria-current={current ? 'page' : undefined} disabled={status.availability !== 'active'} onClick={() => { openMemberSession(status.member.sessionId) }}>
          <TeamMemberIdentity status={status} name={status.member.handle.replace(/^@/, '')} className={css.agentCopy} t={t} />
        </button>
        <span className={css.rowMenu}>
          <TeamRowMenu
            label={t('actionsAgent', { name: status.member.handle })}
            items={[
              { id: 'edit', label: t('editAgent'), icon: <IconEditOutlineRegular /> },
              ...(status.presence === 'error' ? [
                { id: 'resume', label: t('resumeAgent'), icon: <IconPlayOutlineRegular /> },
                { id: 'diagnose', label: t('analyzeAgent'), icon: <IconInspectOutlineRegular /> },
              ] : []),
              ...(status.availability === 'unavailable' ? [{ id: 'restart', label: t('restartAgent'), icon: <IconRefreshOutlineRegular /> }] : []),
              // Both context actions need a live Member Session: the Host
              // rollover replaces the active log, and compaction is scheduled
              // behind the active Agent's current activity.
              ...(status.availability === 'active' ? [
                { id: 'reset', label: t('resetAgent'), icon: <IconNewChatOutlineRegular /> },
                { id: 'compact', label: t('compactAgent'), icon: <IconGaugeOutlineRegular /> },
              ] : []),
              // Session history reads the stored lineage: it works for every
              // lifecycle state, because archived logs survive suspensions
              // and renewals alike.
              { id: 'history', label: t('sessionHistory'), icon: <IconClockOutlineRegular /> },
              // The Member's working queue: current Claims plus unclaimed
              // Channel work, each row navigable and reassignable.
              { id: 'tasks', label: t('agentTasks'), icon: <IconChecklistOutlineRegular /> },
              // The interrupt stack is a durable ledger read: the Host annotates
              // the return verdict only while the Member is live, and the dialog
              // degrades to unverified entries otherwise.
              { id: 'interrupts', label: t('interrupts'), icon: <IconPauseOutlineRegular /> },
              { id: 'archive', label: t(withdrawing ? 'withdrawAgent' : 'archiveAgent'), icon: <IconArchiveOutlineRegular size={16} />, danger: true },
            ]}
            onSelect={(id) => {
              if (id === 'edit') setEditing(true)
              else if (id === 'archive') setArchiving(true)
              else if (id === 'reset') setResetting(true)
              else if (id === 'history') selectSessionHistory(status.member.memberId)
              else if (id === 'tasks') setTasksOpen(true)
              else if (id === 'interrupts') setInterruptsOpen(true)
              else if (id === 'compact') {
                setCompactModel(undefined)
                setCompacting(true)
              }
              else if (id === 'diagnose') void diagnose()
              else void recover()
            }}
            onOpenChange={setMenuOpen}
          />
        </span>
      </div>
      {!archiving && !resetting && !compacting && rowAlert !== undefined && <div className={css.rowAlert} role="alert">{rowAlert}</div>}
      {resetting && (
        <Modal
          open
          onClose={() => { if (!resetPending) setResetting(false) }}
          title={t('resetAgentTitle', { name: status.member.handle })}
          closeLabel={t('close')}
          contentClassName={createCss.dialogContent!}
          footer={<>
            <Button variant="outline" disabled={resetPending} onClick={() => { setResetting(false) }}>{t('cancel')}</Button>
            <Button variant="primary" disabled={resetPending} onClick={() => { void reset() }}>{t('resetAgentConfirm')}</Button>
          </>}
        >
          <p className={createCss.error}>{t('resetAgentNotice', { name: status.member.handle })}</p>
          {rowAlert !== undefined && <p className={createCss.error} role="alert">{rowAlert}</p>}
        </Modal>
      )}
      {compacting && (
        <Modal
          open
          onClose={() => { if (!compactPending) setCompacting(false) }}
          title={t('compactAgentTitle', { name: status.member.handle })}
          closeLabel={t('close')}
          contentClassName={createCss.dialogContent!}
          footer={<>
            <Button variant="outline" disabled={compactPending} onClick={() => { setCompacting(false) }}>{t('cancel')}</Button>
            <Button variant="primary" disabled={compactPending} onClick={() => { void compact() }}>{compactPending ? t('compactAgentRunning') : t('compactAgentRun')}</Button>
          </>}
        >
          <p className={createCss.error}>{t('compactAgentNotice', { name: status.member.handle })}</p>
          <ModelPickerField model={compactModel} onModelChange={setCompactModel} loadModels={loadModels} disabled={compactPending} t={t} defaultLabel={t('compactModelFollowSession')} />
          {rowAlert !== undefined && <p className={createCss.error} role="alert">{rowAlert}</p>}
        </Modal>
      )}
      {archiving && (
        <Modal
          open
          onClose={() => { if (!archivePending) setArchiving(false) }}
          title={t(withdrawing ? 'withdrawAgentTitle' : 'archiveAgentTitle', { name: status.member.handle })}
          closeLabel={t('close')}
          contentClassName={createCss.dialogContent!}
          footer={<>
            <Button variant="outline" disabled={archivePending} onClick={() => { setArchiving(false) }}>{t('cancel')}</Button>
            <Button variant="primary" disabled={archivePending} onClick={() => { void archive() }}>{t(withdrawing ? 'withdrawAgent' : 'archiveAgentConfirm')}</Button>
          </>}
        >
          <p className={createCss.error}>{t(withdrawing ? 'withdrawAgentNotice' : 'archiveAgentNotice', { name: status.member.handle })}</p>
          {!withdrawing && status.workspaceIds.length > 1 && <p>{t('archiveOtherWorkspaces', { count: status.workspaceIds.length - 1 })}</p>}
          {rowAlert !== undefined && <p className={createCss.error} role="alert">{rowAlert}</p>}
        </Modal>
      )}
      {editing && (
        <AgentEditorDialog
          status={status}
          updateMember={updateMember}
          loadPromptView={loadPromptView}
          curateMemberPrompt={curateMemberPrompt}
          loadModels={loadModels}
          onCommitted={onUpdated}
          onClose={() => { setEditing(false) }}
          t={t}
        />
      )}
      {interruptsOpen && (
        <MemberInterruptsDialog
          workspaceId={workspaceId}
          status={status}
          loadMemberInterrupts={loadMemberInterrupts}
          releaseMemberInterrupt={releaseMemberInterrupt}
          onClose={() => { setInterruptsOpen(false) }}
          t={t}
        />
      )}
      {tasksOpen && (
        <MemberTasksDialog
          workspaceId={workspaceId}
          status={status}
          members={members}
          loadMemberTasks={loadMemberTasks}
          loadChannels={loadChannels}
          sendMessage={sendMessage}
          selectThread={selectThread}
          onClose={() => { setTasksOpen(false) }}
          t={t}
        />
      )}
    </>
  )
}

/** Abbreviated anchor display: the full ref rides the row's title. */
const shortCheckpointRef = (ref: string): string => ref.length > 30 ? `${ref.slice(0, 24)}…` : ref

/**
 * One Member's pending interrupt stack, newest first: the durable memory the
 * Member pinned when its work was interrupted, each entry annotated with the
 * Host's live verdict on whether the anchor can still be returned to. The
 * Human can release an entry the Member will never resume; `resumed` closes
 * stay the Host's own and are never offered here.
 */
function MemberInterruptsDialog({ workspaceId, status, loadMemberInterrupts, releaseMemberInterrupt, onClose, t }: {
  readonly workspaceId: WorkspaceId
  readonly status: AgentTeamClientMemberStatus
  readonly loadMemberInterrupts: TeamSidebarProps['loadMemberInterrupts']
  readonly releaseMemberInterrupt: TeamSidebarProps['releaseMemberInterrupt']
  readonly onClose: () => void
  readonly t: TeamSidebarProps['t']
}) {
  const [items, setItems] = useState<readonly AgentTeamInterruptView[]>()
  const [error, setError] = useState<string>()
  const [releasingRef, setReleasingRef] = useState<AgentTeamInterruptRef>()
  const reload = useCallback(async () => {
    try {
      const result = await loadMemberInterrupts({ workspaceId, memberId: status.member.memberId })
      if (result.ok) {
        setItems(result.value.items)
        setError(undefined)
      } else {
        setError(t('interruptsLoadFailed', { message: result.error.message }))
      }
    } catch (cause) {
      setError(t('interruptsLoadFailed', { message: cause instanceof Error ? cause.message : String(cause) }))
    }
  }, [loadMemberInterrupts, workspaceId, status.member.memberId, t])
  useEffect(() => { void reload() }, [reload])
  const release = async (interruptRef: AgentTeamInterruptRef): Promise<void> => {
    if (releasingRef !== undefined) return
    setReleasingRef(interruptRef)
    try {
      const result = await releaseMemberInterrupt({ requestId: mintRequestId(), workspaceId, memberId: status.member.memberId, interruptRef })
      if (!result.ok) setError(t('interruptsReleaseFailed', { message: result.error.message }))
      await reload()
    } catch (cause) {
      setError(t('interruptsReleaseFailed', { message: cause instanceof Error ? cause.message : String(cause) }))
    } finally {
      setReleasingRef(undefined)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={t('interruptsTitle', { name: status.member.handle })}
      closeLabel={t('close')}
      contentClassName={createCss.dialogContent!}
      footer={<Button variant="outline" onClick={onClose}>{t('close')}</Button>}
    >
      {items === undefined && error === undefined && <p className={createCss.state}>{t('interruptsLoading')}</p>}
      {items !== undefined && items.length === 0 && <p className={createCss.state}>{t('interruptsEmpty')}</p>}
      {items !== undefined && items.length > 0 && <ul className={createCss.sectionList}>
        {items.map(item => (
          <li key={item.interruptRef} className={createCss.sectionRow}>
            <span className={createCss.badge}>{item.restorable ? t('interruptsRestorable') : t('interruptsNotRestorable')}</span>
            <span>{item.label}</span>
            <small>{item.incompleteState}</small>
            <small title={item.checkpointRef}>{t('interruptsCheckpoint', { ref: shortCheckpointRef(item.checkpointRef) })} · {formatAbsoluteTime(item.recordedAt)}</small>
            {!item.restorable && item.reason !== undefined && <small>{item.reason}</small>}
            <Button variant="outline" disabled={releasingRef !== undefined} onClick={() => { void release(item.interruptRef) }}>{releasingRef === item.interruptRef ? t('interruptsReleasing') : t('interruptsRelease')}</Button>
          </li>
        ))}
      </ul>}
      {error !== undefined && <p className={createCss.error} role="alert">{error}</p>}
    </Modal>
  )
}

/**
 * One Member's working queue: the open Tasks it holds Claims on first, then
 * the unclaimed Tasks waiting in its Channels. The read happens on open, so a
 * stale panel snapshot never feeds the dialog; a row opens the Task's Thread,
 * and its trailing control starts the reassignment consultation.
 */
function MemberTasksDialog({ workspaceId, status, members, loadMemberTasks, loadChannels, sendMessage, selectThread, onClose, t }: {
  readonly workspaceId: WorkspaceId
  readonly status: AgentTeamClientMemberStatus
  /** The Workspace roster, behind the reassign dialog's taker picker. */
  readonly members: readonly AgentTeamClientMemberStatus[]
  readonly loadMemberTasks: TeamSidebarProps['loadMemberTasks']
  readonly loadChannels: TeamSidebarProps['loadChannels']
  readonly sendMessage: TeamSidebarProps['sendMessage']
  readonly selectThread: TeamSidebarProps['selectThread']
  readonly onClose: () => void
  readonly t: TeamSidebarProps['t']
}) {
  const [queue, setQueue] = useState<AgentTeamMemberTaskQueue>()
  const [error, setError] = useState<string>()
  const [reassigning, setReassigning] = useState<AgentTeamTaskRow>()
  const reload = useCallback(async () => {
    try {
      const result = await loadMemberTasks({ workspaceId })
      if (result.ok) {
        setQueue(result.value.queues.find(item => item.memberId === status.member.memberId))
        setError(undefined)
      } else {
        setError(t('agentTasksLoadFailed', { message: result.error.message }))
      }
    } catch (cause) {
      setError(t('agentTasksLoadFailed', { message: cause instanceof Error ? cause.message : String(cause) }))
    }
  }, [loadMemberTasks, workspaceId, status.member.memberId, t])
  useEffect(() => { void reload() }, [reload])
  const current = queue?.current ?? []
  const queued = queue?.queued ?? []
  const renderRow = (task: AgentTeamTaskRow) => (
    <li key={task.taskRef} className={createCss.sectionRow}>
      <button type="button" className={css.queueRowMain} title={task.subject} onClick={() => { selectThread(task.threadRef, task.channelRef, task.taskRef, task.taskNumber) }}>
        <TeamStateDot state={taskStatusDot(task.status)} />
        <strong>{t('taskLabel', { number: task.taskNumber })}</strong>
        <span className={css.queueRowSubject}>{task.subject}</span>
        {task.claimOwners.length > 0 && <small>{claimersLabel(task.claimOwners, t)}</small>}
        <small>{formatInboxTime(task.lastActivityAt, t)}</small>
      </button>
      <Button variant="outline" onClick={() => { setReassigning(task) }}>{t('agentTasksReassign')}</Button>
    </li>
  )
  return (
    <Modal
      open
      onClose={onClose}
      title={t('agentTasksTitle', { name: status.member.handle })}
      closeLabel={t('close')}
      contentClassName={createCss.dialogContent!}
      footer={<Button variant="outline" onClick={onClose}>{t('close')}</Button>}
    >
      {queue === undefined && error === undefined && <p className={createCss.state}>{t('agentTasksLoading')}</p>}
      {queue !== undefined && current.length === 0 && queued.length === 0 && <p className={createCss.state}>{t('agentTasksEmpty')}</p>}
      {current.length > 0 && <h3 className={css.queueHeading}>{t('agentTasksCurrent')}</h3>}
      {current.length > 0 && <ul className={createCss.sectionList}>{current.map(renderRow)}</ul>}
      {queued.length > 0 && <h3 className={css.queueHeading}>{t('agentTasksQueued')}</h3>}
      {queued.length > 0 && <p className={createCss.notice}>{t('agentTasksQueuedHint')}</p>}
      {queued.length > 0 && <ul className={createCss.sectionList}>{queued.map(renderRow)}</ul>}
      {error !== undefined && <p className={createCss.error} role="alert">{error}</p>}
      {reassigning !== undefined && (
        <TaskReassignDialog
          workspaceId={workspaceId}
          task={reassigning}
          holder={status}
          members={members}
          loadChannels={loadChannels}
          sendMessage={sendMessage}
          onClose={() => { setReassigning(undefined) }}
          t={t}
        />
      )}
    </Modal>
  )
}

/**
 * The reassignment consultation: pick a taker from the Workspace roster, add
 * an optional note, and one Human Message goes to the Team leader stating the
 * Task, its standing and the requested taker. The leader stays the
 * decision-maker — this surface only asks, it never moves the Claim.
 */
function TaskReassignDialog({ workspaceId, task, holder, members, loadChannels, sendMessage, onClose, t }: {
  readonly workspaceId: WorkspaceId
  readonly task: AgentTeamTaskRow
  /** The Member whose queue the consultation starts from — the Task's holder. */
  readonly holder: AgentTeamClientMemberStatus
  readonly members: readonly AgentTeamClientMemberStatus[]
  readonly loadChannels: TeamSidebarProps['loadChannels']
  readonly sendMessage: TeamSidebarProps['sendMessage']
  readonly onClose: () => void
  readonly t: TeamSidebarProps['t']
}) {
  const [targetId, setTargetId] = useState<string>()
  const [note, setNote] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string>()
  const claimOwnerIds = new Set(task.claimOwners.map(owner => owner.memberId))
  // A taker is any live roster Member other than the holder and the people
  // already on the Task; the leader arbitrates finer fits.
  const targets = members.filter(member => member.member.state !== 'inactive' && member.member.state !== 'archived'
    && member.member.memberId !== holder.member.memberId && !claimOwnerIds.has(member.member.memberId))
  const leader = members.find(member => member.member.leader === true && member.member.state !== 'inactive' && member.member.state !== 'archived')
  const target = targets.find(member => member.member.memberId === targetId)
  const send = async (): Promise<void> => {
    if (leader === undefined || target === undefined || sending) return
    setSending(true)
    setError(undefined)
    try {
      // The Message needs one Channel the leader can hear: the first active
      // one the leader has joined. The Human may post anywhere, so the
      // sender's own membership never blocks the consultation.
      const view = await loadChannels({ workspaceId })
      if (!view.ok) throw new Error(view.error.message)
      const leaderChannel = view.value.channels.find(channel => channel.state === 'active'
        && view.value.members.some(membership => membership.channelRef === channel.channelRef && membership.memberId === leader.member.memberId))
      if (leaderChannel === undefined) throw new Error(t('reassignNoLeaderChannel'))
      const body = [
        t('reassignBodyTitle', { number: task.taskNumber }),
        t('reassignBodyTask', { subject: task.subject }),
        t('reassignBodyRefs', { taskRef: task.taskRef, threadRef: task.threadRef }),
        t('reassignBodyStatus', { status: formatTaskStatus(task.status, t) }),
        task.claimOwners.length > 0
          ? t('reassignBodyOwners', { owners: task.claimOwners.map(owner => owner.name).join(', ') })
          : t('reassignBodyUnclaimed'),
        t('reassignBodyTarget', { name: target.member.handle.replace(/^@/, '') }),
        ...(note.trim() === '' ? [] : [t('reassignBodyNote', { note: note.trim() })]),
        t('reassignBodyAsk'),
      ].join('\n')
      const result = await sendMessage({
        requestId: mintRequestId(),
        workspaceId,
        channelRef: leaderChannel.channelRef,
        body,
        recipients: [leader.member.memberId],
        asTask: false,
      })
      if (!result.ok) throw new Error(result.error.message)
      setSent(true)
    } catch (cause) {
      setError(t('reassignFailed', { message: cause instanceof Error ? cause.message : String(cause) }))
    } finally {
      setSending(false)
    }
  }
  const items: MenuEntry[] = targets.map(member => ({
    id: member.member.memberId,
    label: <>{member.member.handle.replace(/^@/, '')}<small className={css.menuHint}>{` ${member.member.description}`}</small></>,
  }))
  return (
    <Modal
      open
      onClose={onClose}
      title={t('reassignTitle', { number: task.taskNumber })}
      closeLabel={t('close')}
      contentClassName={createCss.dialogContent!}
      footer={sent
        ? <Button variant="primary" onClick={onClose}>{t('close')}</Button>
        : <>
          <Button variant="outline" disabled={sending} onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" disabled={sending || leader === undefined || target === undefined} onClick={() => { void send() }}>{sending ? t('reassignSending') : t('reassignConfirm')}</Button>
        </>}
    >
      {sent ? <p className={createCss.notice}>{t('reassignSent')}</p> : <>
        <p className={createCss.notice}>{t('reassignIntro')}</p>
        {leader === undefined && <p className={createCss.error}>{t('reassignNoLeader')}</p>}
        {leader !== undefined && targets.length === 0 && <p className={createCss.error}>{t('reassignNoTargets')}</p>}
        {leader !== undefined && targets.length > 0 && <>
          <div className={createCss.field}>
            <span>{t('reassignTarget')}</span>
            <Menu
              open={pickerOpen}
              portal
              className={createCss.menuCap!}
              items={items}
              selectedIds={targetId === undefined ? [] : [targetId]}
              onSelect={id => { setTargetId(id); setPickerOpen(false) }}
              onClose={() => { setPickerOpen(false) }}
              anchor={
                <button
                  type="button"
                  className={createCss.selectTrigger!}
                  aria-label={t('reassignTarget')}
                  aria-haspopup="menu"
                  aria-expanded={pickerOpen}
                  onClick={() => { setPickerOpen(value => !value) }}
                >
                  <span className={createCss.selectValue}>{target === undefined ? t('reassignTargetPlaceholder') : target.member.handle.replace(/^@/, '')}</span>
                  <span className={`${createCss.chevron!} ${pickerOpen ? createCss.chevronOpen! : ''}`} aria-hidden><IconChevronDownOutlineRegular /></span>
                </button>
              }
            />
          </div>
          <label className={createCss.field}>
            <span>{t('reassignNote')}</span>
            <Input value={note} placeholder={t('reassignNotePlaceholder')} onChange={event => { setNote(event.target.value) }} disabled={sending} />
          </label>
        </>}
        {error !== undefined && <p className={createCss.error} role="alert">{error}</p>}
      </>}
    </Modal>
  )
}
