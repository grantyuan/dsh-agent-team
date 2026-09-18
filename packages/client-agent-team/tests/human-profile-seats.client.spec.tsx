// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { runtimeWithTeam } from './harness.tsx'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

/** Open the seeded Channel in Team mode: the surface that names and draws the Human. */
async function openSeededChannel(options?: Parameters<typeof runtimeWithTeam>[0]) {
  const b = await runtimeWithTeam({
    initialChannels: true,
    seededMessages: [{ body: 'human note', occurredAt: '2026-08-21T10:00:00.000Z', sender: 'human' }],
    ...options,
  })
  fireEvent.click(b.view.getByRole('button', { name: '团队' }))
  fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
  const page = await waitFor(() => {
    const node = b.view.container.querySelector('[data-team-channel]') as HTMLElement | null
    if (node === null) throw new Error('channel page not mounted')
    return node
  })
  return { b, page }
}

describe('Human identity in the Team surfaces', () => {
  it('names the Human by the profile name the Host reports', async () => {
    const { page } = await openSeededChannel({ humanProfile: { name: 'Ada' } })
    await waitFor(() => { expect(within(page).getByText('Ada')).toBeTruthy() })
    expect(within(page).queryByText('Human')).toBeNull()
    expect(page.querySelector('img')).toBeNull()
  })

  it('keeps the localized name when the profile cannot be read', async () => {
    const { page } = await openSeededChannel({ humanProfileFailure: 'host offline' })
    await waitFor(() => { expect(within(page).getByText('Human')).toBeTruthy() })
  })

  it('draws the uploaded avatar in the message identity seat', async () => {
    const { b, page } = await openSeededChannel({ humanProfile: { name: 'Ada', avatarRef: 'avatar:1' } })
    await waitFor(() => { expect(page.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA') })
    expect(b.getHumanAvatar).toHaveBeenCalledWith({ avatarRef: 'avatar:1' })
  })
})
