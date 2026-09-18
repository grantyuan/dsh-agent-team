import { useEffect, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AgentTeamHumanProfileResult } from '@wowyuarm/dsh-agent-team/types'

/**
 * Human settings skeleton (v1 interface wiring; copy + layout are Iris's).
 *
 * The section owns nothing durable: name + avatarRef live in the Host
 * settings namespace `agent-team-human`, avatar bytes behind the Host avatar
 * Remotes, version facts behind `humanProfile`. This page only threads those
 * three faces together so the contract is clickable before visual design.
 */
export interface HumanSettingsSectionInjected {
  /** Read the current profile (name + avatarRef + version footnote). */
  loadProfile: () => Promise<{ ok: true; value: AgentTeamHumanProfileResult } | { ok: false; error: { message: string } }>
  /** Persist one renamed display name through the settings namespace. */
  saveName: (name: string) => Promise<string | undefined>
  /** Upload one image file, persist its ref, and return the failure message if any. */
  uploadAvatar: (file: File) => Promise<string | undefined>
  /** Clear the avatar reference (bytes are removed Host-side). */
  removeAvatar: () => Promise<string | undefined>
  /** Resolve one avatarRef to a data URL for preview; null falls back to hue/initial. */
  loadAvatarUrl: (avatarRef: string) => Promise<string | null>
}

export type HumanSettingsSectionProps =
  & PropsRuntime<'settings.section'>
  & PropsLocale<'team'>
  & InjectFace<HumanSettingsSectionInjected>

export function HumanSettingsSection(props: HumanSettingsSectionProps) {
  const { t } = props
  const [profile, setProfile] = useState<AgentTeamHumanProfileResult | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void props.loadProfile().then(result => {
      if (cancelled) return
      if (result.ok) {
        setProfile(result.value)
        setName(result.value.name)
        setLoadError(null)
        if (result.value.avatarRef !== undefined) {
          void props.loadAvatarUrl(result.value.avatarRef).then(url => {
            if (!cancelled) setAvatarUrl(url)
          })
        } else {
          setAvatarUrl(null)
        }
      } else {
        setLoadError(result.error.message)
      }
    })
    return () => {
      cancelled = true
    }
  }, [props])

  const onSave = async (): Promise<void> => {
    setSaving(true)
    setNotice(null)
    const failure = await props.saveName(name)
    setSaving(false)
    if (failure !== undefined) {
      setNotice(failure)
      return
    }
    const reloaded = await props.loadProfile()
    if (reloaded.ok) {
      setProfile(reloaded.value)
      setName(reloaded.value.name)
    }
  }

  const onPickFile = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return
    setNotice(null)
    const failure = await props.uploadAvatar(file)
    if (failure !== undefined) {
      setNotice(failure)
      return
    }
    const reloaded = await props.loadProfile()
    if (reloaded.ok) {
      setProfile(reloaded.value)
      if (reloaded.value.avatarRef !== undefined) {
        setAvatarUrl(await props.loadAvatarUrl(reloaded.value.avatarRef))
      }
    }
  }

  const onRemoveAvatar = async (): Promise<void> => {
    setNotice(null)
    const failure = await props.removeAvatar()
    if (failure !== undefined) {
      setNotice(failure)
      return
    }
    setAvatarUrl(null)
    const reloaded = await props.loadProfile()
    if (reloaded.ok) setProfile(reloaded.value)
  }

  if (loadError !== null) return <div>{loadError}</div>
  if (profile === null) return <div />
  const versionLine = t('humanSettingsVersion', { version: profile.version })
  return (
    <div>
      <h2>{t('humanSettingsTitle')}</h2>
      <section>
        <h3>{t('humanSettingsName')}</h3>
        <p>{t('humanSettingsNameHint')}</p>
        <input aria-label={t('humanSettingsName')} value={name} onChange={event => { setName(event.target.value) }} />
        <button type="button" disabled={saving} onClick={() => { void onSave() }}>
          {saving ? t('humanSettingsSaving') : t('humanSettingsSave')}
        </button>
      </section>
      <section>
        <h3>{t('humanSettingsAvatar')}</h3>
        <p>{t('humanSettingsAvatarHint')}</p>
        {avatarUrl === null ? null : <img alt="" src={avatarUrl} width={64} height={64} />}
        <label>
          {t('humanSettingsUpload')}
          <input
            type="file"
            accept="image/*"
            onChange={event => {
              void onPickFile(event.target.files?.[0])
              event.target.value = ''
            }}
          />
        </label>
        {profile.avatarRef === undefined ? null : (
          <button type="button" onClick={() => { void onRemoveAvatar() }}>
            {t('humanSettingsRemoveAvatar')}
          </button>
        )}
      </section>
      <footer>
        <span>{versionLine}</span>
        <a href="https://github.com/wowyuarm/dsh-agent-team" target="_blank" rel="noreferrer">
          GitHub
        </a>
        {profile.updateAvailable && profile.latestVersion !== undefined
          ? <span>{t('humanSettingsUpdateAvailable', { version: profile.latestVersion })}</span>
          : null}
      </footer>
      {notice === null ? null : <p role="status">{notice}</p>}
    </div>
  )
}
