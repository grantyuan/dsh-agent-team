import { useEffect, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AgentTeamGatewayConfig } from '@wowyuarm/dsh-agent-team/types'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { useHumanIdentity, type TeamHumanIdentityFace } from './human-identity.ts'
import { EnvironmentCheck } from './EnvironmentCheck.tsx'
import type { TeamEnvironmentSource } from './environment-check.ts'
import { useAvatarImage } from './avatar-image.ts'
import css from './human-settings.module.css'

/**
 * The Human's own settings page: display name, avatar, the local environment
 * check, and the version footnote.
 *
 * The page owns no durable fact and no copy of one. Name, avatar, and version
 * all arrive from the shared identity projection, so a save here moves the
 * message rows and member refs at the same moment; a failed write keeps the
 * typed name in the field and reports the Host's own reason. The environment
 * check is a separate projection, read only, and belongs to the installation
 * rather than to the Human.
 */

/** Host-side avatar ceiling (`ATTACHMENT_MAX_BYTES`): the settings page refuses larger files before the round trip. */
const AVATAR_MAX_BYTES = 10 * 1024 * 1024

export interface HumanSettingsSectionInjected {
  /** The shared Human identity projection: profile facts plus post-write refresh. */
  identity: TeamHumanIdentityFace
  /** Persist one renamed display name; the failure message when the Host refuses it. */
  saveName: (name: string) => Promise<string | undefined>
  /** Upload one image file, persist its reference; the failure message when it does not stick. */
  uploadAvatar: (file: File) => Promise<string | undefined>
  /** Clear the avatar; the identity falls back to the initial. */
  removeAvatar: () => Promise<string | undefined>
  /** The local environment check, a read-only projection of the installation. */
  environment: TeamEnvironmentSource
  /**
   * The external-agent gateway controls. Reads and saves answer the Host's
   * fresh view (save resolves post-reconcile, so `listening` is what the
   * listener is doing now) and throw with the Host's own reason when refused.
   */
  gateway: TeamGatewayConfigFace
}

/** Read+write seat for the gateway's volatile settings row. */
export interface TeamGatewayConfigFace {
  read: () => Promise<AgentTeamGatewayConfig>
  save: (patch: { enabled?: boolean; port?: number; token?: string }) => Promise<AgentTeamGatewayConfig>
}

export type HumanSettingsSectionProps =
  & PropsRuntime<'settings.section'>
  & PropsLocale<'team'>
  & HumanSettingsSectionInjected

/**
 * Run one durable write and reduce every failure to the message the page
 * reports. A rejected Remote call (a dropped carrier, a refused write) is a
 * failure like any other: without this the field would sit on "saving" forever
 * and report nothing.
 */
async function failureOf(action: () => Promise<string | undefined>): Promise<string | undefined> {
  try {
    return await action()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** First visible character of a display name, or the neutral `H` before one is known. */
function avatarInitial(name: string | undefined): string {
  const trimmed = (name ?? '').replace(/^@/, '').trim()
  return trimmed === '' ? 'H' : trimmed.slice(0, 1).toUpperCase()
}

export function HumanSettingsSection(props: HumanSettingsSectionProps) {
  const { t, identity } = props
  const profile = useHumanIdentity(identity)
  // Undefined means "follow the Host value": the field re-syncs whenever the
  // profile changes underneath, without a background read clobbering a name
  // the reader is still editing.
  const [draft, setDraft] = useState<string | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const filePicker = useRef<HTMLInputElement | null>(null)

  const name = draft ?? profile.name ?? ''
  const dirty = draft !== undefined && draft.trim() !== (profile.name ?? '')
  const emptyName = draft !== undefined && draft.trim() === ''
  const hasAvatar = profile.avatarRef !== undefined
  // The circle answers to decoded bytes, not to a stored reference: the Host
  // accepts any `image/…` payload, so a file this browser cannot read has to
  // fall back to the initial exactly as a removed one does.
  const avatar = useAvatarImage(profile.avatarUrl)

  // The gateway row loads once and then edits against the loaded view; the
  // draft is undefined until the reader touches a control, so a background
  // refresh can never clobber what they are typing.
  const [gateway, setGateway] = useState<AgentTeamGatewayConfig | undefined>(undefined)
  const [gatewayError, setGatewayError] = useState<string | null>(null)
  const [gatewayDraft, setGatewayDraft] = useState<{ enabled: boolean; port: string; token: string } | undefined>(undefined)
  const [savingGateway, setSavingGateway] = useState(false)
  useEffect(() => {
    let alive = true
    props.gateway.read().then(view => {
      if (alive) { setGateway(view); setGatewayError(null) }
    }).catch(error => {
      if (alive) setGatewayError(error instanceof Error ? error.message : String(error))
    })
    return () => { alive = false }
  }, [props.gateway])

  const gatewayDraftOf = (view: AgentTeamGatewayConfig): { enabled: boolean; port: string; token: string } =>
    ({ enabled: view.enabled, port: String(view.port), token: view.token })
  const gatewayCurrent = gatewayDraft ?? (gateway === undefined ? undefined : gatewayDraftOf(gateway))
  const gatewayDirty = gateway !== undefined && gatewayDraft !== undefined
    && (gatewayDraft.enabled !== gateway.enabled || gatewayDraft.port !== String(gateway.port) || gatewayDraft.token !== gateway.token)
  const gatewayPortInvalid = gatewayCurrent === undefined || !/^\d+$/u.test(gatewayCurrent.port) || Number(gatewayCurrent.port) < 1 || Number(gatewayCurrent.port) > 65535
  const gatewaySaveDisabled = !gatewayDirty || savingGateway || gatewayPortInvalid
    || (gatewayCurrent?.enabled === true && gatewayCurrent.token.trim() === '')

  const submitGateway = async (): Promise<void> => {
    if (gateway === undefined || gatewayDraft === undefined || !gatewayDirty || savingGateway) return
    const port = Number(gatewayDraft.port)
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return
    if (gatewayDraft.enabled && gatewayDraft.token.trim() === '') {
      setNotice(t('humanSettingsGatewayNeedsToken'))
      return
    }
    const patch: { enabled?: boolean; port?: number; token?: string } = {}
    if (gatewayDraft.enabled !== gateway.enabled) patch.enabled = gatewayDraft.enabled
    if (port !== gateway.port) patch.port = port
    if (gatewayDraft.token !== gateway.token) patch.token = gatewayDraft.token.trim()
    setSavingGateway(true)
    setNotice(null)
    try {
      const saved = await props.gateway.save(patch)
      setGateway(saved)
      setGatewayDraft(undefined)
    } catch (error) {
      setNotice(t('humanSettingsGatewayFailed', { message: error instanceof Error ? error.message : String(error) }))
    } finally {
      setSavingGateway(false)
    }
  }

  const submitName = async (): Promise<void> => {
    if (!dirty || emptyName || saving) return
    setSaving(true)
    setNotice(null)
    const failure = await failureOf(() => props.saveName(name.trim()))
    setSaving(false)
    if (failure !== undefined) {
      setNotice(t('humanSettingsNameFailed', { message: failure }))
      return
    }
    setDraft(undefined)
  }

  const pickAvatar = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return
    setNotice(null)
    if (!file.type.startsWith('image/')) {
      setNotice(t('humanSettingsAvatarNotImage'))
      return
    }
    if (file.size > AVATAR_MAX_BYTES) {
      setNotice(t('humanSettingsAvatarTooLarge'))
      return
    }
    setUploading(true)
    const failure = await failureOf(() => props.uploadAvatar(file))
    setUploading(false)
    if (failure !== undefined) setNotice(t('humanSettingsAvatarFailed', { message: failure }))
  }

  const removeAvatar = async (): Promise<void> => {
    setNotice(null)
    const failure = await failureOf(() => props.removeAvatar())
    if (failure !== undefined) setNotice(t('humanSettingsAvatarFailed', { message: failure }))
  }

  // The page says what it is before it says what happened: the settings nav
  // lists it beside the Harness's own pages, so the title alone leaves "whose
  // profile is this, and where does it apply?" unanswered — and every state,
  // including a failed read, has to answer it.
  const pageHeader = <>
    <h2 className={css.heading}>{t('humanSettingsTitle')}</h2>
    <p className={css.intro}>{t('humanSettingsIntro')}</p>
  </>

  if (profile.status === 'loading' && profile.name === undefined) {
    return <div className={css.section}>
      {pageHeader}
      <p className={css.state} role="status">{t('humanSettingsLoading')}</p>
    </div>
  }

  if (profile.name === undefined) {
    return <div className={css.section}>
      {pageHeader}
      <p className={css.state} role="alert">{t('humanSettingsUnavailable', { message: profile.error ?? '' })}</p>
      <div className={css.stateAction}>
        <Button variant="outline" onClick={() => { void identity.refresh() }}>{t('retry')}</Button>
      </div>
    </div>
  }

  return (
    <div className={css.section}>
      {pageHeader}
      <div className={css.rows}>
        <div className={css.row}>
          <div className={css.rowText}>
            <div className={css.title}>{t('humanSettingsName')}</div>
            <div className={css.desc}>{t('humanSettingsNameHint')}</div>
          </div>
          <form
            className={css.controls}
            onSubmit={(event) => {
              event.preventDefault()
              void submitName()
            }}
          >
            <Input
              className={css.nameInput!}
              aria-label={t('humanSettingsName')}
              aria-invalid={emptyName || undefined}
              value={name}
              disabled={saving}
              onChange={(event) => { setDraft(event.target.value) }}
            />
            <Button type="submit" variant="primary" disabled={saving || !dirty || emptyName}>
              {saving ? t('humanSettingsSaving') : t('humanSettingsSave')}
            </Button>
          </form>
        </div>
        <div className={css.row}>
          <div className={css.rowText}>
            <div className={css.title}>{t('humanSettingsAvatar')}</div>
            <div className={css.desc}>{t('humanSettingsAvatarHint')}</div>
          </div>
          <div className={css.controls}>
            {avatar.src === undefined
              ? <span className={`${css.identity} ${css.identityFallback}`} data-avatar="initial" aria-hidden="true">{avatarInitial(profile.name)}</span>
              : <img className={`${css.identity} ${css.identityImage}`} data-avatar="image" src={avatar.src} alt="" onError={avatar.failed} />}
            <input
              ref={filePicker}
              type="file"
              accept="image/*"
              tabIndex={-1}
              aria-hidden="true"
              hidden
              onChange={(event) => {
                void pickAvatar(event.target.files?.[0])
                event.target.value = ''
              }}
            />
            <Button
              variant="outline"
              disabled={uploading}
              onClick={() => { filePicker.current?.click() }}
            >
              {uploading ? t('humanSettingsUploading') : hasAvatar ? t('humanSettingsReplace') : t('humanSettingsUpload')}
            </Button>
            {hasAvatar && <Button disabled={uploading} onClick={() => { void removeAvatar() }}>{t('humanSettingsRemoveAvatar')}</Button>}
          </div>
        </div>
        <div className={`${css.row} ${css.gatewayRow}`}>
          <div className={css.rowText}>
            <div className={css.title}>{t('humanSettingsGateway')}</div>
            <div className={css.desc}>{t('humanSettingsGatewayHint')}</div>
            {gatewayError !== null
              ? <p className={css.notice} role="alert">{t('humanSettingsGatewayLoadFailed', { message: gatewayError })}</p>
              : gateway === undefined
                ? <p className={css.state} role="status">{t('humanSettingsLoading')}</p>
                : <p className={css.gatewayState} data-listening={gateway.listening}>
                    {gateway.listening ? t('humanSettingsGatewayStatusOn', { port: gateway.boundPort ?? gateway.port }) : t('humanSettingsGatewayStatusOff')}
                  </p>}
            {gatewayError === null && gatewayCurrent?.enabled === true && gatewayCurrent.token.trim() === ''
              ? <p className={css.notice}>{t('humanSettingsGatewayNeedsToken')}</p>
              : null}
          </div>
          <div className={css.gatewayControls}>
            <label className={css.gatewayCheck}>
              <input
                type="checkbox"
                aria-label={t('humanSettingsGatewayEnable')}
                disabled={gateway === undefined || savingGateway}
                checked={gatewayCurrent?.enabled === true}
                onChange={(event) => { setGatewayDraft({ ...(gatewayCurrent ?? { enabled: false, port: '43110', token: '' }), enabled: event.target.checked }) }}
              />
              <span>{t('humanSettingsGatewayEnable')}</span>
            </label>
            <Input
              className={css.gatewayPort!}
              type="number"
              min={1}
              max={65535}
              aria-label={t('humanSettingsGatewayPort')}
              aria-invalid={gatewayPortInvalid || undefined}
              value={gatewayCurrent?.port ?? ''}
              disabled={gateway === undefined || savingGateway}
              onChange={(event) => { setGatewayDraft({ ...(gatewayCurrent ?? { enabled: false, port: '43110', token: '' }), port: event.target.value }) }}
            />
            <Input
              className={css.gatewayToken!}
              aria-label={t('humanSettingsGatewayToken')}
              value={gatewayCurrent?.token ?? ''}
              disabled={gateway === undefined || savingGateway}
              onChange={(event) => { setGatewayDraft({ ...(gatewayCurrent ?? { enabled: false, port: '43110', token: '' }), token: event.target.value }) }}
            />
            <Button
              variant="primary"
              disabled={gatewaySaveDisabled}
              onClick={() => { void submitGateway() }}
            >
              {savingGateway ? t('humanSettingsSaving') : t('humanSettingsGatewaySave')}
            </Button>
          </div>
        </div>
      </div>
      <EnvironmentCheck t={t} environment={props.environment} />
      <div className={css.footnote}>
        <span>{t('humanSettingsVersion', { version: profile.version ?? '' })}</span>
        <span aria-hidden="true">·</span>
        <a className={css.link} href={profile.repoUrl ?? ''} target="_blank" rel="noreferrer">GitHub</a>
        {profile.updateAvailable && profile.latestVersion !== undefined
          ? <a
              className={css.link}
              href={`${profile.repoUrl ?? ''}/releases`}
              target="_blank"
              rel="noreferrer"
            >{t('humanSettingsUpdateAvailable', { version: profile.latestVersion })}</a>
          : null}
      </div>
      {emptyName && <p className={css.notice}>{t('humanSettingsNameEmpty')}</p>}
      {notice === null ? null : <p className={css.notice} role="alert">{notice}</p>}
    </div>
  )
}
