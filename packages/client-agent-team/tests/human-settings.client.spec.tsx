// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { zh } from '../src/client/locales.ts'
import { HumanSettingsSection } from '../src/client/HumanSettingsSection.tsx'

const t = ((key: keyof typeof zh, params?: Record<string, string | number>) => {
  let value: string = zh[key]
  for (const [name, replacement] of Object.entries(params ?? {})) value = value.replace(`{${name}}`, String(replacement))
  return value
}) as Parameters<typeof HumanSettingsSection>[0]['t']

afterEach(cleanup)

/**
 * The human settings page is a thin skeleton over three Host faces (profile
 * read, settings writes, avatar bytes) until Iris owns the visual design.
 * These tests lock the wiring only: fields render from the profile, and the
 * version footnote always carries the bundle version plus the repo link.
 */
describe('HumanSettingsSection skeleton wiring', () => {
  it('renders the name field and version footnote from the profile', async () => {
    const injected = {
      loadProfile: vi.fn(async () => ({ ok: true as const, value: { name: 'Ada', version: '0.1.13', repoUrl: 'https://github.com/wowyuarm/dsh-agent-team', updateAvailable: false as const } })),
      saveName: vi.fn(async () => undefined),
      uploadAvatar: vi.fn(async () => undefined),
      removeAvatar: vi.fn(async () => undefined),
      loadAvatarUrl: vi.fn(async () => null),
    }
    const props = { close: () => {}, t, ...injected } as unknown as Parameters<typeof HumanSettingsSection>[0]
    const { container } = render(<HumanSettingsSection {...props} />)
    await waitFor(() => {
      expect(container.querySelector('input[aria-label="名字"]')).not.toBeNull()
    })
    expect((container.querySelector('input[aria-label="名字"]') as HTMLInputElement).value).toBe('Ada')
    expect(container.textContent).toContain('版本 0.1.13')
    const link = container.querySelector('a[href="https://github.com/wowyuarm/dsh-agent-team"]')
    expect(link).not.toBeNull()
  })

  it('shows the update line only when the Host reports one', async () => {
    const base = { name: 'Ada', version: '0.1.13', repoUrl: 'https://github.com/wowyuarm/dsh-agent-team' }
    const injected = {
      loadProfile: vi.fn(async () => ({ ok: true as const, value: { ...base, updateAvailable: true as const, latestVersion: '0.2.0' } })),
      saveName: vi.fn(async () => undefined),
      uploadAvatar: vi.fn(async () => undefined),
      removeAvatar: vi.fn(async () => undefined),
      loadAvatarUrl: vi.fn(async () => null),
    }
    const props = { close: () => {}, t, ...injected } as unknown as Parameters<typeof HumanSettingsSection>[0]
    const { container } = render(<HumanSettingsSection {...props} />)
    await waitFor(() => {
      expect(container.textContent).toContain('0.2.0')
    })
  })
})
