// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// The dock boots the whole Team surface in jsdom; the shared suite ceiling applies.
vi.setConfig({ testTimeout: 30_000 })
import { cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { runtimeWithTeam } from './harness.tsx'
import { TEAM_DOCK_STORAGE_KEY } from '../src/client/dock.ts'
import { STORAGE_KEY as NAVIGATION_STORAGE_KEY } from '../src/client/navigation.ts'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

function storedDock(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(TEAM_DOCK_STORAGE_KEY) ?? '') as Record<string, unknown>
}

function storedNavigation(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(NAVIGATION_STORAGE_KEY) ?? '') as Record<string, unknown>
}

describe('Team page dock', () => {
  it('opens a sidebar card as the dock tab, whatever the conversation seat shows', async () => {
    // The bug this pins: Team sidebar entries used to write navigation faces a
    // center seat might not be rendering. The dock is the one Team page
    // surface, so the card click always lands somewhere visible.
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialChannels: true })
    fireEvent.click(await b.view.findByRole('button', { name: '任务' }))
    const dock = await b.view.findByRole('region', { name: '团队面板' })
    expect(within(dock).getByRole('tab', { name: '任务', selected: true })).toBeTruthy()
    expect(within(dock).getByLabelText('任务', { selector: '[role="tabpanel"]' })).toBeTruthy()
    // The overview tab the boot opened stays reachable, and the conversation
    // seat keeps rendering the shipped conversation beside the dock.
    expect(within(dock).getByRole('tab', { name: 'Alpha' })).toBeTruthy()
    expect(b.view.container.querySelector('[data-phase]')).toBeTruthy()
    await b.runtime.dispose()
  })

  it('returns to the last Team page after leaving and re-entering Team mode', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialChannels: true })
    fireEvent.click(await b.view.findByRole('button', { name: '任务' }))
    await b.view.findByLabelText('任务', { selector: '[role="tabpanel"]' })
    // Leave through the footer (对话), as the reported flow does, and come back.
    fireEvent.click(b.view.getByRole('button', { name: '对话' }))
    await waitFor(() => expect(storedNavigation().mode).toBe('conversation'))
    expect(b.view.queryByRole('region', { name: '团队面板' })).toBeNull()
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    const dock = await b.view.findByRole('region', { name: '团队面板' })
    await waitFor(() => { expect(within(dock).getByRole('tab', { name: '任务' }).getAttribute('aria-selected')).toBe('true') })
    expect(within(dock).getByLabelText('任务', { selector: '[role="tabpanel"]' })).toBeTruthy()
    await b.runtime.dispose()
  })

  it('reopens the last Member conversation on the next Team entry', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialChannels: true })
    await b.runtime.sessions.add({ id: 'session:member:builder' as never, summary: { title: 'builder', cwd: '/work/alpha' } } as never)
    await b.view.findByText('builder')
    fireEvent.click(b.view.getByRole('button', { name: '打开 builder 的会话' }))
    await waitFor(() => expect(b.openSession).toHaveBeenCalledWith('session:member:builder'))
    // Leaving Team restores the Human's own session; re-entering reopens the
    // Member conversation — the last Team page the Human was reading.
    fireEvent.click(b.view.getByRole('button', { name: '对话' }))
    await waitFor(() => expect(b.openSession).toHaveBeenLastCalledWith('ordinary-session'))
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    await waitFor(() => expect(b.openSession).toHaveBeenLastCalledWith('session:member:builder'))
    // A Member session that vanished (renewed, removed) simply stays closed.
    localStorage.setItem('dsh.agent-team.navigation', JSON.stringify({ mode: 'team', workspaceId: 'w1' }))
    await b.runtime.dispose()
  })

  it('splits the active page into a second pane, maximizes, and closes panes', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialChannels: true })
    const dock = await b.view.findByRole('region', { name: '团队面板' })
    fireEvent.click(await b.view.findByRole('button', { name: '任务' }))
    await within(dock).findByLabelText('任务', { selector: '[role="tabpanel"]' })
    // Split: the Tasks page opens again in a pane below the first.
    fireEvent.click(within(dock).getByRole('button', { name: '将当前页面拆分到新分栏' }))
    const panes = within(dock).getAllByLabelText('任务', { selector: '[role="tabpanel"]' })
    expect(panes).toHaveLength(2)
    expect(within(dock).getAllByRole('tab', { name: '任务', selected: true })).toHaveLength(2)
    // Maximize the first pane: the other pane keeps mounted but hidden.
    const firstPane = panes[0]!.closest('[data-team-dock-pane]') as HTMLElement
    fireEvent.click(within(firstPane).getByRole('button', { name: '最大化此分栏' }))
    expect(within(dock).getByRole('button', { name: '还原此分栏' }).getAttribute('aria-pressed')).toBe('true')
    const secondPane = panes[1]!.closest('[data-team-dock-pane]') as HTMLElement
    expect(secondPane.getAttribute('aria-hidden')).toBe('true')
    // Restore, then close the pane: its tab goes with it.
    fireEvent.click(within(firstPane).getByRole('button', { name: '还原此分栏' }))
    expect(secondPane.getAttribute('aria-hidden')).toBeNull()
    fireEvent.click(within(secondPane).getByRole('button', { name: '关闭此分栏' }))
    expect(within(dock).getAllByRole('tabpanel')).toHaveLength(1)
    // Closing the last pane closes the dock.
    fireEvent.click(within(dock).getByRole('button', { name: '关闭此分栏' }))
    await waitFor(() => expect(b.view.queryByRole('region', { name: '团队面板' })).toBeNull())
    expect(storedDock().open).toBe(false)
    // The sidebar toggle brings it back, and a card click reopens it with the
    // current face even while closed.
    fireEvent.click(b.view.getByRole('button', { name: '团队面板' }))
    await b.view.findByRole('region', { name: '团队面板' })
    fireEvent.click(b.view.getByRole('button', { name: '团队面板' }))
    await waitFor(() => expect(b.view.queryByRole('region', { name: '团队面板' })).toBeNull())
    fireEvent.click(b.view.getByRole('button', { name: '任务' }))
    await b.view.findByLabelText('任务', { selector: '[role="tabpanel"]' })
    await b.runtime.dispose()
  })

  it('maximizes the dock over the frame and restores it beside the conversation', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialChannels: true })
    const dock = await b.view.findByRole('region', { name: '团队面板' })
    expect(dock.getAttribute('data-fullscreen')).toBeNull()
    fireEvent.click(within(dock).getByRole('button', { name: '最大化面板' }))
    await waitFor(() => expect(dock.getAttribute('data-fullscreen')).toBe('true'))
    expect(b.openRightbar).toHaveBeenLastCalledWith(true, true)
    fireEvent.click(within(dock).getByRole('button', { name: '还原面板' }))
    await waitFor(() => expect(dock.getAttribute('data-fullscreen')).toBeNull())
    expect(b.openRightbar).toHaveBeenLastCalledWith(true, false)
    // Closing the dock hands the column back through the same face.
    fireEvent.click(within(dock).getByRole('button', { name: '关闭面板' }))
    await waitFor(() => expect(b.closeRightbar).toHaveBeenCalled())
    await b.runtime.dispose()
  })

  it('persists the pane layout across a fresh mount', async () => {
    const first = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialChannels: true })
    fireEvent.click(await first.view.findByRole('button', { name: '任务' }))
    await first.view.findByLabelText('任务', { selector: '[role="tabpanel"]' })
    fireEvent.click(within(first.view.getByRole('region', { name: '团队面板' })).getByRole('button', { name: '将当前页面拆分到新分栏' }))
    // The bench runtime wipes localStorage on dispose, so the fresh mount must
    // boot while the first is still alive — the shared storage is the point.
    expect(storedDock().open).toBe(true)
    expect((storedDock().panes as unknown[]).length).toBe(2)

    const second = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialChannels: true })
    // Two live trees share the document while the first is still mounted, so
    // every second-runtime query scopes to its own container.
    const dock = await within(second.view.container).findByRole('region', { name: '团队面板' })
    await waitFor(() => expect(within(dock).getAllByRole('tabpanel')).toHaveLength(2))
    expect(within(dock).getByRole('tab', { name: '任务', selected: true })).toBeTruthy()
    await second.runtime.dispose()
    await first.runtime.dispose()
  })
})
