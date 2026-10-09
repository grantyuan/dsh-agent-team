import { useEffect, useState } from 'react'
import type { AgentTeamClientMemberStatus, AgentTeamModelSelection, AgentTeamUpdateMemberRequest } from '@wowyuarm/dsh-agent-team/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { TeamModelCatalog, TeamModelEffortOption, TeamModelProviderGroup, TeamSidebarProps } from './slots.ts'
import { Button, Checkbox, IconChevronDownOutlineRegular, Input, Menu, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { mintRequestId } from './requests.ts'
import { useEditDialogSave } from './team-dialog-save.ts'
import createCss from './create.module.css'
import css from './sidebar.module.css'

/** Model option key inside one editor; opaque and resolved against the loaded groups. */
function modelKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`
}

/**
 * Shared Host catalog across the pickers: one in-flight read while pending,
 * last good value afterwards. Revalidation re-reads (a slow Host still
 * refreshes behind already-rendered rows), and a loader that starts throwing
 * keeps serving its last good value rather than blanking every picker.
 */
interface ModelCatalogCache {
  inflight?: Promise<RemoteResult<TeamModelCatalog>>
  value?: TeamModelCatalog
}

const modelCatalogCaches = new WeakMap<TeamSidebarProps['loadModels'], ModelCatalogCache>()

function peekCatalogGroups(loadModels: TeamSidebarProps['loadModels']): readonly TeamModelProviderGroup[] | undefined {
  return modelCatalogCaches.get(loadModels)?.value?.groups
}

function sharedCatalog(loadModels: TeamSidebarProps['loadModels']): Promise<RemoteResult<TeamModelCatalog>> {
  const cached = modelCatalogCaches.get(loadModels)
  if (cached?.inflight !== undefined) return cached.inflight
  const next = loadModels()
  const entry = cached ?? {}
  entry.inflight = next
  modelCatalogCaches.set(loadModels, entry)
  const forget = (result: RemoteResult<TeamModelCatalog> | undefined): void => {
    if (modelCatalogCaches.get(loadModels) === entry && entry.inflight === next) {
      delete entry.inflight
      if (result !== undefined && result.ok) entry.value = result.value
    }
  }
  next.then(
    (result) => { forget(result) },
    () => { forget(undefined) },
  )
  return next
}

/**
 * Best-effort warm of the shared catalog (the agents panel calls this while
 * the roster loads, so the pickers open with rows instead of paying the
 * first read on open). Failures belong to the picker's own error surface.
 */
export function warmModelCatalog(loadModels: TeamSidebarProps['loadModels']): void {
  try {
    void sharedCatalog(loadModels).catch(() => {
      // The picker that later reads surfaces the failure with its retry entry.
    })
  } catch {
    // Same: a synchronously refused warm leaves no trace; the picker reports it.
  }
}

/**
 * Shared provider/model dropdown for the create and edit forms. The option
 * list rides the shared Menu primitive (one leading "follow Host default"
 * row, then non-selectable provider headings) with a capped, internally
 * scrolling card so growing model catalogs cannot stretch the dialog. Mounts
 * open with the warmed value when one exists and revalidate behind it, so a
 * slow Host read delays a refresh — never the picker itself; a refused or
 * failed read with no warmed value renders a retryable error instead of
 * stranding the field on "loading".
 */
export function ModelPickerField({ model, onModelChange, loadModels, disabled, t, defaultLabel }: {
  readonly model: AgentTeamModelSelection | undefined
  readonly onModelChange: (choice: AgentTeamModelSelection | undefined) => void
  readonly loadModels: TeamSidebarProps['loadModels']
  readonly disabled: boolean
  readonly t: TeamSidebarProps['t']
  /** Overrides the follow-default option's label when the picker's fallback reads differently. */
  readonly defaultLabel?: string
}) {
  const [groups, setGroups] = useState<readonly TeamModelProviderGroup[] | undefined>(() => peekCatalogGroups(loadModels))
  const [modelsError, setModelsError] = useState<string>()
  const [reloadToken, setReloadToken] = useState(0)
  const [open, setModelOpen] = useState(false)
  const [effortOpen, setEffortOpen] = useState(false)
  useEffect(() => {
    let mounted = true
    let pending: Promise<RemoteResult<TeamModelCatalog>>
    try {
      pending = sharedCatalog(loadModels)
    } catch (error) {
      // A synchronously refused read (an undeclared remote, a dead scope)
      // used to strand the field on "loading" forever with no diagnostic;
      // surface it as the same retryable failure an answered refusal gets.
      // Last good rows stay rendered underneath, matching a refused answer.
      setModelsError(error instanceof Error ? error.message : String(error))
      return
    }
    void pending.then(
      (result) => {
        if (!mounted) return
        if (result.ok) {
          setGroups(result.value.groups)
          setModelsError(undefined)
        } else {
          setModelsError(result.error.message)
        }
      },
      (error: unknown) => {
        // A rejected read (a transport that died mid-call) previously fell
        // through as an unhandled rejection behind the same endless loading
        // line; it retries like any other failure.
        if (!mounted) return
        setModelsError(error instanceof Error ? error.message : String(error))
      },
    )
    return () => { mounted = false }
  }, [loadModels, reloadToken])

  const items: MenuEntry[] = [{ id: '', label: defaultLabel ?? t('modelFollowDefault') }]
  const byKey = new Map<string, { provider: string; id: string; name: string; efforts: readonly TeamModelEffortOption[] }>()
  for (const group of groups ?? []) {
    items.push({ type: 'label', id: `model-group:${group.id}`, text: group.name })
    for (const entry of group.models) {
      const key = modelKey(group.id, entry.id)
      byKey.set(key, { provider: group.id, id: entry.id, name: entry.name, efforts: entry.reasoning?.efforts ?? [] })
      items.push({ id: key, label: entry.name })
    }
  }
  const selectedModelKey = model === undefined ? '' : modelKey(model.provider, model.model)
  const triggerLabel = model === undefined
    ? defaultLabel ?? t('modelFollowDefault')
    : byKey.get(selectedModelKey)?.name ?? `${model.provider} / ${model.model}`
  // The effort sub-row only makes sense for a pinned model with adapter-exposed
  // efforts; following the Host default inherits the operator's whole selection.
  const efforts = model === undefined ? [] : byKey.get(selectedModelKey)?.efforts ?? []
  const effortItems: MenuEntry[] = [{ id: '', label: t('effortFollowDefault') }, ...efforts.map(effort => ({ id: effort.id, label: effort.name }))]
  const selectedEffort = model?.reasoningEffort ?? ''
  const effortTriggerLabel = model === undefined || selectedEffort === ''
    ? t('effortFollowDefault')
    : efforts.find(effort => effort.id === selectedEffort)?.name ?? selectedEffort

  return <div className={createCss.field}>
    <span>{t('memberModel')}</span>
    {groups === undefined && modelsError === undefined && <small className={css.editHint}>{t('modelsLoading')}</small>}
    {modelsError !== undefined && (
      <p className={css.editHint}>
        <span role="alert">{t('modelsLoadFailed', { message: modelsError })}</span>
        {' '}
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => { setModelsError(undefined); setReloadToken(token => token + 1) }}
        >
          {t('retry')}
        </Button>
      </p>
    )}
    {groups !== undefined && (
      <Menu
        open={open}
        portal
        className={createCss.menuCap!}
        items={items}
        selectedId={selectedModelKey}
        onSelect={key => {
          setModelOpen(false)
          const choice = byKey.get(key)
          onModelChange(choice === undefined ? undefined : { provider: choice.provider, model: choice.id })
        }}
        onClose={() => { setModelOpen(false) }}
        anchor={
          <button
            type="button"
            className={createCss.selectTrigger!}
            aria-label={t('memberModel')}
            aria-haspopup="menu"
            aria-expanded={open}
            disabled={disabled}
            onClick={() => { setModelOpen(value => !value) }}
          >
            <span className={createCss.selectValue}>{triggerLabel}</span>
            <span className={`${createCss.chevron!} ${open ? createCss.chevronOpen! : ''}`} aria-hidden><IconChevronDownOutlineRegular /></span>
          </button>
        }
      />
    )}
    {model !== undefined && efforts.length > 0 && (
      <Menu
        open={effortOpen}
        portal
        className={createCss.menuCap!}
        items={effortItems}
        selectedId={selectedEffort}
        onSelect={key => {
          setEffortOpen(false)
          onModelChange(key === ''
            ? { provider: model.provider, model: model.model }
            : { provider: model.provider, model: model.model, reasoningEffort: key as NonNullable<AgentTeamModelSelection['reasoningEffort']> })
        }}
        onClose={() => { setEffortOpen(false) }}
        anchor={
          <button
            type="button"
            className={createCss.selectTrigger!}
            aria-label={t('reasoningEffort')}
            aria-haspopup="menu"
            aria-expanded={effortOpen}
            disabled={disabled}
            onClick={() => { setEffortOpen(value => !value) }}
          >
            <span className={createCss.selectValue}>{`${t('reasoningEffort')} · ${effortTriggerLabel}`}</span>
            <span className={`${createCss.chevron!} ${effortOpen ? createCss.chevronOpen! : ''}`} aria-hidden><IconChevronDownOutlineRegular /></span>
          </button>
        }
      />
    )}
  </div>
}

/**
 * Parses the context-window override text shared by the create and edit
 * forms: empty means "follow the route window" (an absent field), a whole
 * number at the 8192 floor is a valid override, and anything else parses to
 * NaN — the caller's invalid sentinel that blocks submission. NaN stays
 * typed as a number so the payload spread needs no extra narrowing.
 */
export function parseContextWindow(text: string): number | undefined {
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined
  if (!/^\d+$/.test(trimmed)) return Number.NaN
  const parsed = Number(trimmed)
  return Number.isSafeInteger(parsed) && parsed >= 8192 ? parsed : Number.NaN
}

/**
 * Shared task-start context block for the create and edit forms: one Menu
 * row choosing between the continue and fresh start policies plus a numeric
 * context-window override that can only narrow the route window. An empty
 * window input means "follow the route window" and maps to an absent field;
 * an unparsable one renders the invalid alert and keeps the form unsubmitted.
 */
export function ContextPickerField({ policy, onPolicyChange, windowText, onWindowTextChange, invalid, disabled, t }: {
  readonly policy: 'continue' | 'fresh'
  readonly onPolicyChange: (policy: 'continue' | 'fresh') => void
  readonly windowText: string
  readonly onWindowTextChange: (text: string) => void
  /** Renders the invalid-window alert in place of the hint line. */
  readonly invalid: boolean
  readonly disabled: boolean
  readonly t: TeamSidebarProps['t']
}) {
  const [open, setPolicyOpen] = useState(false)
  const items: MenuEntry[] = [
    { id: 'continue', label: t('contextPolicyContinue') },
    { id: 'fresh', label: t('contextPolicyFresh') },
  ]
  const triggerLabel = policy === 'fresh' ? t('contextPolicyFresh') : t('contextPolicyContinue')
  return <div className={createCss.field}>
    <span>{t('memberContextPolicy')}</span>
    <Menu
      open={open}
      portal
      className={createCss.menuCap!}
      items={items}
      selectedId={policy}
      onSelect={key => {
        setPolicyOpen(false)
        if (key === 'continue' || key === 'fresh') onPolicyChange(key)
      }}
      onClose={() => { setPolicyOpen(false) }}
      anchor={
        <button
          type="button"
          className={createCss.selectTrigger!}
          aria-label={t('memberContextPolicy')}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => { setPolicyOpen(value => !value) }}
        >
          <span className={createCss.selectValue}>{triggerLabel}</span>
          <span className={`${createCss.chevron!} ${open ? createCss.chevronOpen! : ''}`} aria-hidden><IconChevronDownOutlineRegular /></span>
        </button>
      }
    />
    <small className={css.editHint}>{t('memberContextPolicyHint')}</small>
    <span>{t('memberContextWindow')}</span>
    <Input
      className={createCss.input!}
      type="number"
      min={8192}
      step={1}
      value={windowText}
      placeholder={t('contextWindowPlaceholder')}
      aria-label={t('memberContextWindow')}
      aria-invalid={invalid || undefined}
      onChange={event => onWindowTextChange(event.target.value)}
      disabled={disabled}
    />
    {invalid
      ? <p className={css.editHint} role="alert">{t('contextWindowInvalid')}</p>
      : <small className={css.editHint}>{t('memberContextWindowHint')}</small>}
  </div>
}

/**
 * Agent editor: handle, description, per-Member model selection, and the
 * task-start context control commit through one durable update. Channel
 * membership is managed from the Channel side, not here.
 */
export function AgentEditorDialog({ status, updateMember, loadModels, onCommitted, onClose, t }: {
  readonly status: AgentTeamClientMemberStatus
  readonly updateMember: TeamSidebarProps['updateMember']
  readonly loadModels: TeamSidebarProps['loadModels']
  readonly onCommitted: () => Promise<void> | void
  readonly onClose: () => void
  readonly t: TeamSidebarProps['t']
}) {
  const memberId = status.member.memberId
  const [handle, setHandle] = useState(status.member.handle)
  const [description, setDescription] = useState(status.member.description)
  const [model, setModel] = useState<AgentTeamModelSelection | undefined>(status.member.model)
  const [leader, setLeader] = useState(status.member.leader === true)
  const [policy, setPolicy] = useState<'continue' | 'fresh'>(status.member.contextStartPolicy ?? 'continue')
  const [windowText, setWindowText] = useState(status.member.contextWindow === undefined ? '' : String(status.member.contextWindow))
  const { saving, error, pendingRequest, save } = useEditDialogSave({
    save: updateMember,
    onCommitted,
    onClose,
  })
  const storedLeader = status.member.leader === true
  const parsedWindow = parseContextWindow(windowText)
  const windowInvalid = Number.isNaN(parsedWindow)
  const dirty = handle.trim() !== status.member.handle || description.trim() !== status.member.description
    || !sameModel(model, status.member.model) || leader !== storedLeader
    || policy !== (status.member.contextStartPolicy ?? 'continue') || parsedWindow !== status.member.contextWindow
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const normalizedHandle = handle.trim()
    const normalizedDescription = description.trim()
    if (saving || !dirty || normalizedHandle.length === 0 || windowInvalid) return
    const payload = {
      memberId,
      handle: normalizedHandle,
      description: normalizedDescription,
      ...(model === undefined ? {} : { model }),
      // The editor owns no capabilities UI, but an absent field would clear a
      // Remote-written override; echo the stored intent through the edit.
      ...(status.member.capabilities === undefined ? {} : { capabilities: status.member.capabilities }),
      // Same echo for the prompt profile: this editor has no profile UI yet,
      // so the stored profile rides the edit instead of being cleared by
      // omission.
      ...(status.member.prompt === undefined ? {} : { prompt: status.member.prompt }),
      // The policy is only sent when fresh: under absent-clears, omitting it
      // both clears a stored fresh policy and keeps an absent one when the
      // picker reads continue. An empty window input means the same for the
      // override.
      ...(policy === 'fresh' ? { contextStartPolicy: policy } : {}),
      ...(parsedWindow === undefined ? {} : { contextWindow: parsedWindow }),
      // Absent keeps the stored designation on the Host, so the edit always
      // echoes this checkbox rather than clearing it by omission.
      leader,
    }
    const samePending = pendingRequest.current !== undefined && pendingRequest.current.memberId === payload.memberId
      && pendingRequest.current.handle === payload.handle && pendingRequest.current.description === payload.description
      && sameModel(pendingRequest.current.model, model)
      && (pendingRequest.current.contextStartPolicy ?? 'continue') === policy
      && pendingRequest.current.contextWindow === parsedWindow
      && (pendingRequest.current.leader ?? false) === leader
    const request: AgentTeamUpdateMemberRequest = samePending ? pendingRequest.current! : {
      requestId: mintRequestId(),
      ...payload,
    }
    await save(request)
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('editAgent')}
      description={`@${status.member.handle}`}
      closeLabel={t('close')}
      contentClassName={createCss.dialogContent!}
      footer={<><Button variant="outline" disabled={saving} onClick={onClose}>{t('cancel')}</Button><Button type="submit" form="team-agent-edit-form" variant="primary" disabled={saving || !dirty || handle.trim().length === 0 || windowInvalid}>{saving ? t('editSaving') : t('editSave')}</Button></>}
    >
      <form id="team-agent-edit-form" className={createCss.form} onSubmit={event => { void submit(event) }}>
        <label className={createCss.field}>
          <span>{t('agentName')}</span>
          <Input className={createCss.input!} value={handle} onChange={event => { setHandle(event.target.value); pendingRequest.current = undefined }} disabled={saving} autoFocus />
        </label>
        <label className={createCss.field}>
          <span>{t('agentDescription')}{t('optionalSuffix')}</span>
          <Input className={createCss.input!} value={description} placeholder={t('agentDescriptionPlaceholder')} onChange={event => { setDescription(event.target.value); pendingRequest.current = undefined }} disabled={saving} />
        </label>
        <ModelPickerField model={model} onModelChange={choice => { pendingRequest.current = undefined; setModel(choice) }} loadModels={loadModels} disabled={saving} t={t} />
        <ContextPickerField
          policy={policy}
          onPolicyChange={next => { pendingRequest.current = undefined; setPolicy(next) }}
          windowText={windowText}
          onWindowTextChange={text => { pendingRequest.current = undefined; setWindowText(text) }}
          invalid={windowInvalid}
          disabled={saving}
          t={t}
        />
        <Checkbox checked={leader} onChange={next => { pendingRequest.current = undefined; setLeader(next) }} disabled={saving} label={t('memberLeader')} title={t('memberLeaderHint')} />
        {error !== undefined && <p className={createCss.error} role="alert">{error}</p>}
      </form>
    </Modal>
  )
}

export function sameModel(left: AgentTeamModelSelection | undefined, right: AgentTeamModelSelection | undefined): boolean {
  if (left === undefined && right === undefined) return true
  if (left === undefined || right === undefined) return false
  return left.provider === right.provider && left.model === right.model && left.reasoningEffort === right.reasoningEffort
}
