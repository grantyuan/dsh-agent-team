import { useEffect, useRef, useState } from 'react'
import type { AgentTeamClientMemberStatus, AgentTeamMemberId, AgentTeamMemberPromptProfile, AgentTeamMemberPromptSectionEntry, AgentTeamMemberPromptView, AgentTeamModelSelection, AgentTeamUpdateMemberRequest } from '@wowyuarm/dsh-agent-team/types'
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
 * The UTF-8 byte bound of one custom role paragraph. Mirrors the Host's
 * ledger commit rule, so this live counter agrees with the Host for CJK
 * prose too: the bytes the user sees are the bytes the commit measures.
 */
export const MEMBER_PROMPT_MAX_BYTES = 8192

const promptByteEncoder = new TextEncoder()

/** UTF-8 byte length of one paragraph — the measure the Host commit rule and this counter share. */
export function utf8ByteLength(text: string): number {
  return promptByteEncoder.encode(text).length
}

/** The shared paragraph field: one textarea plus the live UTF-8 byte counter (or its over-limit alert). */
function PromptParagraphField({ text, onTextChange, disabled, t }: {
  readonly text: string
  readonly onTextChange: (text: string) => void
  readonly disabled: boolean
  readonly t: TeamSidebarProps['t']
}) {
  const bytes = utf8ByteLength(text)
  const over = bytes > MEMBER_PROMPT_MAX_BYTES
  return <div className={createCss.field}>
    <textarea
      className={createCss.textArea!}
      rows={6}
      value={text}
      placeholder={t('promptPlaceholder')}
      aria-label={t('promptDialogTitle')}
      aria-invalid={over || undefined}
      data-modal-autofocus
      onChange={event => onTextChange(event.target.value)}
      disabled={disabled}
    />
    {over
      ? <p className={css.editHint} role="alert">{t('promptBytesOver', { count: bytes, limit: MEMBER_PROMPT_MAX_BYTES })}</p>
      : <small className={css.editHint}>{t('promptBytes', { count: bytes, limit: MEMBER_PROMPT_MAX_BYTES })}</small>}
  </div>
}

/**
 * Create-form staging of the custom role paragraph: the paragraph lives in
 * the create form's local state until the member-added commit — nothing
 * durable happens here, Apply hands the draft back and closes.
 */
function StagePromptDialog({ initialText, onApply, onClose, t }: {
  readonly initialText: string
  readonly onApply: (text: string) => void
  readonly onClose: () => void
  readonly t: TeamSidebarProps['t']
}) {
  const [text, setText] = useState(initialText)
  const over = utf8ByteLength(text) > MEMBER_PROMPT_MAX_BYTES
  return (
    <Modal
      open
      onClose={onClose}
      title={t('promptDialogTitle')}
      closeLabel={t('close')}
      contentClassName={createCss.dialogContent!}
      footer={<>
        <Button variant="outline" onClick={onClose}>{t('cancel')}</Button>
        <Button variant="primary" disabled={over} onClick={() => { onApply(text); onClose() }}>{t('promptApply')}</Button>
      </>}
    >
      <PromptParagraphField text={text} onTextChange={setText} disabled={false} t={t} />
    </Modal>
  )
}

/**
 * One row of the Prompt dialog's section list: the section's keep/drop toggle
 * beside its byte size, its in-window mapped-call count, and its inert marks.
 * Protected rows always speak "kept" and refuse drops; a stale residue row (a
 * stored drop the live assembly no longer knows) stays re-checkable to purge
 * the inert name, and once purged renders checked but disabled — there is no
 * live section left to drop. Prose-only rows carry the "no automatic signal"
 * badge; the long-unused badge marks a live, kept section whose mapped tools
 * saw no calls inside the usage window.
 */
function PromptSectionRow({ section, dropped, candidate, onToggle, disabled, t }: {
  readonly section: AgentTeamMemberPromptSectionEntry
  readonly dropped: boolean
  /** Zero mapped calls inside the usage window on a live, protected-free, kept section. */
  readonly candidate: boolean
  /** Receives the section name and the requested drop state (true = remove from the next assembly). */
  readonly onToggle: (name: string, drop: boolean) => void
  readonly disabled: boolean
  readonly t: TeamSidebarProps['t']
}) {
  return (
    <li className={createCss.sectionRow!} data-team-prompt-section={section.name}>
      {/* The checkbox speaks "kept": a live section renders checked, dropping
          unchecks it, and a purged stale residue stays checked but disabled. */}
      <Checkbox
        checked={section.isProtected || !dropped}
        disabled={disabled || section.isProtected || (section.stale && !dropped)}
        label={section.name}
        onChange={next => onToggle(section.name, !next)}
      />
      {section.chars !== undefined && <small className={css.editHint}>{t('promptSectionBytes', { count: section.chars })}</small>}
      {!section.proseOnly && section.usage !== undefined && <small className={css.editHint}>{t('promptSectionUsage', { count: section.usage })}</small>}
      {section.isProtected && <span className={createCss.badge!}>{t('promptSectionProtected')}</span>}
      {section.stale && <span className={createCss.badge!}>{t('promptSectionStale')}</span>}
      {!section.isProtected && !section.stale && section.proseOnly && <span className={createCss.badge!}>{t('promptSectionNoSignal')}</span>}
      {candidate && <span className={createCss.badge!}>{t('promptSectionUnused')}</span>}
    </li>
  )
}

/**
 * Durable edit of one Member's custom role paragraph: a fresh
 * memberPromptView read fills the textarea, the section list, and the
 * auto-prune switches, and the save commits one echo-complete member update —
 * absent-clears makes echoing the stored model/capabilities/context overrides
 * mandatory, and the other prompt subfields merge from the read plus the
 * section toggles instead of being replaced. The auto-prune confirm surface
 * (the Host's candidate list) commits through the same payload path, merging
 * the candidates into the drops. A non-enabled Member renders read-only, and
 * a Member without a live session renders no section list at all.
 */
function EditPromptDialog({ memberId, loadPromptView, updateMember, onCommitted, onClose, t }: {
  readonly memberId: AgentTeamMemberId
  readonly loadPromptView: TeamSidebarProps['loadPromptView']
  readonly updateMember: TeamSidebarProps['updateMember']
  /** Receives the committed prompt profile (undefined = cleared) once the update lands. */
  readonly onCommitted: (prompt: AgentTeamMemberPromptProfile | undefined) => Promise<void> | void
  readonly onClose: () => void
  readonly t: TeamSidebarProps['t']
}) {
  const [view, setView] = useState<AgentTeamMemberPromptView>()
  const [loadError, setLoadError] = useState<string>()
  const [reloadToken, setReloadToken] = useState(0)
  const [text, setText] = useState('')
  const [drops, setDrops] = useState<readonly string[]>([])
  const [autoPrune, setAutoPrune] = useState(false)
  const [autoExecutePrune, setAutoExecutePrune] = useState(false)
  useEffect(() => {
    let mounted = true
    setLoadError(undefined)
    loadPromptView({ memberId }).then(
      result => {
        if (!mounted) return
        if (result.ok) {
          setView(result.value)
          setText(result.value.prompt?.customPrompt ?? '')
          setDrops(result.value.prompt?.droppedSections ?? [])
          setAutoPrune(result.value.prompt?.autoPrune ?? false)
          setAutoExecutePrune(result.value.prompt?.autoExecutePrune ?? false)
        } else {
          setLoadError(result.error.message)
        }
      },
      (cause: unknown) => {
        if (!mounted) return
        setLoadError(cause instanceof Error ? cause.message : String(cause))
      },
    )
    return () => { mounted = false }
  }, [loadPromptView, memberId, reloadToken])
  // The profile this dialog's update will have committed, handed to
  // onCommitted after the Host confirms — the still-open editor dialog echoes
  // it instead of a row snapshot that may predate the commit.
  const committedRef = useRef<AgentTeamMemberPromptProfile | undefined>(undefined)
  const { saving, error, pendingRequest, save } = useEditDialogSave({
    save: updateMember,
    onCommitted: () => onCommitted(committedRef.current),
    onClose,
  })
  if (view === undefined) {
    return (
      <Modal
        open
        onClose={onClose}
        title={t('promptDialogTitle')}
        closeLabel={t('close')}
        contentClassName={createCss.dialogContent!}
        footer={<Button variant="outline" onClick={onClose}>{t('cancel')}</Button>}
      >
        {loadError === undefined
          ? <p className={createCss.state}>{t('promptLoading')}</p>
          : (
            <div className={createCss.failure}>
              <p className={createCss.error} role="alert">{t('promptLoadFailed', { message: loadError })}</p>
              <Button size="sm" variant="outline" onClick={() => setReloadToken(token => token + 1)}>{t('retry')}</Button>
            </div>
          )}
      </Modal>
    )
  }
  const stored = view.prompt
  const paragraph = text.trim() === '' ? undefined : text
  const over = utf8ByteLength(text) > MEMBER_PROMPT_MAX_BYTES
  const readonly = view.state !== 'enabled'
  const toggleDrop = (name: string, drop: boolean): void => {
    pendingRequest.current = undefined
    setDrops(current => drop ? [...current, name] : current.filter(existing => existing !== name))
  }
  // Merge, never replace: the stored profile's other subfields survive an
  // edit that only touches the paragraph, the toggled section list replaces
  // the stored drops (toggling everything back off stores an absent field),
  // the auto-prune switches echo from local state (an off switch clears a
  // stored on), and a profile left without any field stores as absent.
  const buildPrompt = (dropList: readonly string[]): AgentTeamMemberPromptProfile | undefined =>
    paragraph === undefined && stored === undefined && dropList.length === 0 && !autoPrune && !autoExecutePrune
      ? undefined
      : {
        ...(dropList.length === 0 ? {} : { droppedSections: dropList }),
        ...(paragraph === undefined ? {} : { customPrompt: paragraph }),
        ...(autoPrune ? { autoPrune: true } : {}),
        ...(autoExecutePrune ? { autoExecutePrune: true } : {}),
      }
  const mergedPrompt = buildPrompt(drops)
  const storedDrops = stored?.droppedSections ?? []
  const dropsChanged = drops.length !== storedDrops.length || drops.some(name => !storedDrops.includes(name))
  const dirty = paragraph !== stored?.customPrompt || dropsChanged
    || autoPrune !== (stored?.autoPrune ?? false)
    || autoExecutePrune !== (stored?.autoExecutePrune ?? false)
  const commit = async (prompt: AgentTeamMemberPromptProfile | undefined): Promise<void> => {
    // A full-auto sweep can commit while this dialog stands open; the stale
    // local echo must never restore what the Host already dropped. Re-read
    // the stored drop list right before saving and merge it in — Human
    // additions stay, Host removals stay removed, and the rows re-render the
    // reconciled state. A failed re-read saves the local list unchanged; the
    // update itself surfaces any real failure.
    let reconciled = prompt
    if (prompt !== undefined) {
      const fresh = await loadPromptView({ memberId: view.memberId })
      if (fresh.ok) {
        const hostDrops = fresh.value.prompt?.droppedSections ?? []
        const known = new Set(prompt.droppedSections ?? [])
        if (hostDrops.some(name => !known.has(name))) {
          const merged = [...new Set([...(prompt.droppedSections ?? []), ...hostDrops])].sort()
          reconciled = { ...prompt, droppedSections: merged }
          setDrops(merged)
        }
      }
    }
    const payload = {
      requestId: mintRequestId(),
      memberId: view.memberId,
      handle: view.handle,
      description: view.description,
      ...(reconciled === undefined ? {} : { prompt: reconciled }),
      // Echo the stored overrides: an absent field would clear them, and
      // this dialog edits the paragraph, the section list, and the
      // auto-prune switches only.
      ...(view.model === undefined ? {} : { model: view.model }),
      ...(view.capabilities === undefined ? {} : { capabilities: view.capabilities }),
      ...(view.contextStartPolicy === undefined ? {} : { contextStartPolicy: view.contextStartPolicy }),
      ...(view.contextWindow === undefined ? {} : { contextWindow: view.contextWindow }),
    }
    const previous = pendingRequest.current
    const samePending = previous !== undefined && previous.memberId === payload.memberId
      && previous.handle === payload.handle && previous.description === payload.description
      && (previous.prompt === undefined) === (payload.prompt === undefined)
      && JSON.stringify(previous.prompt?.droppedSections ?? []) === JSON.stringify(payload.prompt?.droppedSections ?? [])
      && previous.prompt?.autoPrune === payload.prompt?.autoPrune
      && previous.prompt?.autoExecutePrune === payload.prompt?.autoExecutePrune
      && previous.prompt?.customPrompt === payload.prompt?.customPrompt
      && previous.model === payload.model && previous.capabilities === payload.capabilities
      && (previous.contextStartPolicy ?? undefined) === (payload.contextStartPolicy ?? undefined)
      && (previous.contextWindow ?? undefined) === (payload.contextWindow ?? undefined)
    committedRef.current = reconciled
    await save(samePending ? previous : payload)
  }
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (saving || readonly || over || !dirty) return
    void commit(mergedPrompt)
  }
  // The confirm surface commits the dialog's current profile with the Host's
  // candidate list merged into the drops (deduped, sorted) — the same
  // echo-complete shape as the save button, so no second commit path exists.
  // The upgrade additionally turns both auto-prune switches on in the
  // committed profile.
  const confirmPrune = (upgrade: boolean): void => {
    if (saving || readonly || over || view.pruneCandidates === undefined) return
    const merged = [...new Set([...drops, ...view.pruneCandidates])].sort()
    const base = buildPrompt(merged)
    // Unreachable: the candidate list is non-empty, so the built profile
    // always carries the merged drops.
    if (base === undefined) return
    void commit(upgrade ? { ...base, autoPrune: true, autoExecutePrune: true } : base)
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={t('promptDialogTitle')}
      description={`@${view.handle}`}
      closeLabel={t('close')}
      contentClassName={createCss.dialogContent!}
      footer={<>
        <Button variant="outline" disabled={saving} onClick={onClose}>{t('cancel')}</Button>
        <Button type="submit" form="team-member-prompt-form" variant="primary" disabled={saving || readonly || over || !dirty}>{saving ? t('editSaving') : t('editSave')}</Button>
      </>}
    >
      <form id="team-member-prompt-form" className={createCss.form} onSubmit={event => { void submit(event) }}>
        {readonly && <p className={createCss.notice}>{t('promptReadonly')}</p>}
        <div className={createCss.field}>
          <span>{t('promptSectionsTitle')}</span>
          {view.sections === undefined
            ? <small className={css.editHint}>{t('promptSectionsUnavailable')}</small>
            : view.sections.length === 0
              ? <small className={css.editHint}>{t('promptSectionsEmpty')}</small>
              : (
                <ul className={createCss.sectionList!}>
                  {view.sections.map(section => (
                    <PromptSectionRow
                      key={section.name}
                      section={section}
                      dropped={drops.includes(section.name)}
                      candidate={section.usage === 0 && !section.proseOnly && !section.isProtected && !section.stale && !drops.includes(section.name)}
                      onToggle={toggleDrop}
                      disabled={saving || readonly}
                      t={t}
                    />
                  ))}
                </ul>
              )}
          {view.usagePartial === true && <small className={css.editHint}>{t('promptUsagePartial')}</small>}
          <small className={css.editHint}>{t('promptSectionsHint')}</small>
          {!readonly && view.pruneCandidates !== undefined && view.pruneCandidates.length > 0 && (
            <div className={createCss.prunePanel!} data-team-prompt-prune role="group" aria-label={t('promptPruneTitle')}>
              <span>{t('promptPruneTitle')}</span>
              <small className={css.editHint}>{t('promptPruneHint')}</small>
              <ul className={createCss.sectionList!}>
                {view.pruneCandidates.map(name => <li key={name}>{name}</li>)}
              </ul>
              <div className={createCss.pruneActions!}>
                <Button size="sm" variant="primary" disabled={saving || over} onClick={() => confirmPrune(false)}>{t('promptPruneConfirm')}</Button>
                <Button size="sm" variant="outline" disabled={saving || over} onClick={() => confirmPrune(true)}>{t('promptPruneConfirmAuto')}</Button>
              </div>
            </div>
          )}
        </div>
        <PromptParagraphField text={text} onTextChange={next => { pendingRequest.current = undefined; setText(next) }} disabled={saving || readonly} t={t} />
        <div className={createCss.field}>
          <Checkbox
            checked={autoPrune}
            disabled={saving || readonly}
            label={t('promptAutoPrune')}
            onChange={next => { pendingRequest.current = undefined; setAutoPrune(next); if (!next) setAutoExecutePrune(false) }}
          />
          <small className={css.editHint}>{t('promptAutoPruneHint')}</small>
          <Checkbox
            checked={autoExecutePrune}
            disabled={saving || readonly || !autoPrune}
            label={t('promptAutoExecutePrune')}
            onChange={next => { pendingRequest.current = undefined; setAutoExecutePrune(next) }}
          />
          <small className={css.editHint}>{t('promptAutoExecutePruneHint')}</small>
        </div>
        {error !== undefined && <p className={createCss.error} role="alert">{error}</p>}
      </form>
    </Modal>
  )
}

/**
 * One Prompt dialog behind both entry points: the create form stages a local
 * paragraph (`stage` mode — nothing durable until the member-added commit),
 * the editor commits a durable echo-complete member update (`edit` mode).
 */
export function MemberPromptDialog(props: {
  readonly t: TeamSidebarProps['t']
  readonly onClose: () => void
} & (
  | {
    readonly mode: 'stage'
    readonly initialText: string
    readonly onApply: (text: string) => void
  }
  | {
    readonly mode: 'edit'
    readonly memberId: AgentTeamMemberId
    readonly loadPromptView: TeamSidebarProps['loadPromptView']
    readonly updateMember: TeamSidebarProps['updateMember']
    readonly onCommitted: (prompt: AgentTeamMemberPromptProfile | undefined) => Promise<void> | void
  }
)) {
  if (props.mode === 'stage') {
    return <StagePromptDialog initialText={props.initialText} onApply={props.onApply} onClose={props.onClose} t={props.t} />
  }
  return (
    <EditPromptDialog
      memberId={props.memberId}
      loadPromptView={props.loadPromptView}
      updateMember={props.updateMember}
      onCommitted={props.onCommitted}
      onClose={props.onClose}
      t={props.t}
    />
  )
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
export function AgentEditorDialog({ status, updateMember, loadPromptView, loadModels, onCommitted, onClose, t }: {
  readonly status: AgentTeamClientMemberStatus
  readonly updateMember: TeamSidebarProps['updateMember']
  readonly loadPromptView: TeamSidebarProps['loadPromptView']
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
  const [promptOpen, setPromptOpen] = useState(false)
  // The profile the Prompt dialog last committed, kept separate from the row
  // snapshot: between the dialog's durable commit and the next roster
  // refresh, `status` still holds the older profile and echoing it would
  // silently revert the paragraph. Undefined means the dialog has not run.
  const [promptEcho, setPromptEcho] = useState<{ readonly prompt: AgentTeamMemberPromptProfile | undefined }>()
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
      // Same echo for the prompt profile: the Prompt dialog commits its own
      // durable edit and hands back the committed profile, so this editor
      // echoes the newer of that commit and the row snapshot — an edit never
      // clears the paragraph by omission.
      ...(promptEcho !== undefined
        ? (promptEcho.prompt === undefined ? {} : { prompt: promptEcho.prompt })
        : (status.member.prompt === undefined ? {} : { prompt: status.member.prompt })),
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
        <div className={createCss.field}>
          <span>{t('memberPrompt')}</span>
          <Button variant="outline" disabled={saving} onClick={() => { setPromptOpen(true) }}>{t('memberPromptEdit')}</Button>
          <small className={css.editHint}>{t('memberPromptHint')}</small>
        </div>
        <Checkbox checked={leader} onChange={next => { pendingRequest.current = undefined; setLeader(next) }} disabled={saving} label={t('memberLeader')} title={t('memberLeaderHint')} />
        {error !== undefined && <p className={createCss.error} role="alert">{error}</p>}
      </form>
      {promptOpen && (
        <MemberPromptDialog
          mode="edit"
          memberId={memberId}
          loadPromptView={loadPromptView}
          updateMember={updateMember}
          onCommitted={prompt => {
            setPromptEcho({ prompt })
            // The dialog's durable commit supersedes any failed editor retry
            // request still held for idempotent replay — replaying it would
            // carry the pre-commit prompt echo.
            pendingRequest.current = undefined
            return onCommitted()
          }}
          onClose={() => { setPromptOpen(false) }}
          t={t}
        />
      )}
    </Modal>
  )
}

export function sameModel(left: AgentTeamModelSelection | undefined, right: AgentTeamModelSelection | undefined): boolean {
  if (left === undefined && right === undefined) return true
  if (left === undefined || right === undefined) return false
  return left.provider === right.provider && left.model === right.model && left.reasoningEffort === right.reasoningEffort
}
