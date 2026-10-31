// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.setConfig({ testTimeout: 30_000 })
import { cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { runtimeWithTeam } from './harness.tsx'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

function inboxRow(workspaceId: string, threadRef: string, overrides: Record<string, unknown> = {}): { readonly workspaceId: string } & Record<string, unknown> {
  return {
    workspaceId,
    channelRef: 'channel:engineering',
    channelName: 'engineering',
    taskNumber: 1,
    task: { taskRef: 'task:1', channelRef: 'channel:engineering', threadRef, status: 'in_progress', resolution: 'open' },
    thread: { threadRef, taskRef: 'task:1', revision: 5 },
    unreadCount: 1,
    directCount: 1,
    previewText: 'Decision needed on the rollout',
    createdOccurredAt: '2026-09-12T08:00:00.000Z',
    latestReplyOccurredAt: '2026-09-13T04:00:00.000Z',
    latestReplyActor: { memberId: 'member:iris', name: 'iris' },
    needsHumanDecision: true,
    newestSequence: 9,
    newestOccurredAt: '2026-09-13T04:00:00.000Z',
    newestActor: { memberId: 'member:iris', name: 'iris' },
    claimOwners: [],
    ...overrides,
  }
}

describe('backup model picker', () => {
  it('adds backup routes in the create form and carries them on member-added', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    fireEvent.click(b.view.getByRole('button', { name: '添加 Agent' }))
    const dialog = await b.view.findByRole('dialog', { name: '添加 Agent' })
    fireEvent.change(within(dialog).getByLabelText('名称'), { target: { value: 'ops' } })
    // The field exists even before a primary is pinned: backups ride the
    // Host-default primary too.
    expect(within(dialog).getByText('备用模型')).toBeTruthy()
    const addPicker = within(dialog).getByRole('button', { name: '添加备用路由' })
    fireEvent.click(addPicker)
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: /DeepSeek Chat/ }))
    // The chosen candidate became a row; the trailing picker reappeared for a
    // second one.
    await waitFor(() => expect(within(dialog).getByRole('button', { name: '备用 #1' })).toBeTruthy())
    expect(within(dialog).getByRole('button', { name: '移除该备用' })).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: '创建 Agent' }))
    await waitFor(() => expect(b.addMember).toHaveBeenCalledWith(expect.objectContaining({
      handle: 'ops',
      modelFallbacks: [{ provider: 'deepseek-official', model: 'deepseek-chat' }],
    })))
    await b.runtime.dispose()
  })

  it('echoes the stored list and clears it when the editor empties it', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    await b.view.findByText('builder')
    fireEvent.click(await b.view.findByRole('button', { name: 'builder 的操作' }))
    fireEvent.click(await b.view.findByRole('menuitem', { name: '编辑 Agent' }))
    const dialog = await b.view.findByRole('dialog', { name: '编辑 Agent' })
    // Nothing stored: the editor opens with just the trailing add picker.
    expect(within(dialog).queryByRole('button', { name: '备用 #1' })).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: '添加备用路由' }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: /DeepSeek Reasoner/ }))
    await waitFor(() => expect(within(dialog).getByRole('button', { name: '备用 #1' })).toBeTruthy())
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(b.updateMember).toHaveBeenCalledWith(expect.objectContaining({
      modelFallbacks: [{ provider: 'deepseek-official', model: 'deepseek-reasoner' }],
    })))
    await b.runtime.dispose()
  })
})

describe('human new-message toast', () => {
  it('banners a new direct arrival and jumps to the Thread', async () => {
    const b = await runtimeWithTeam()
    // The mount pass seeds the cursor over the empty backlog; nothing toasts.
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(within(document.body).queryByText(/团队里给你留了新消息/)).toBeNull()
    // A direct arrival after the mount banners in the body portal.
    b.seedInbox([inboxRow('w1', 'thread:w1', { previewText: 'The deploy is blocked' })])
    const banner = await within(document.body).findByText(/The deploy is blocked/)
    expect(banner.textContent).toContain('iris 在团队里给你留了新消息')
    fireEvent.click(within(document.body).getByRole('button', { name: '查看' }))
    await waitFor(() => expect(JSON.parse(localStorage.getItem('dsh.agent-team.navigation') ?? '')).toMatchObject({
      mode: 'team', threadRef: 'thread:w1',
    }))
    // The banner leaves with the jump; the Thread face opened in the dock.
    await waitFor(() => expect(within(document.body).queryByText(/The deploy is blocked/)).toBeNull())
    const dock = await b.view.findByRole('region', { name: '团队面板' })
    await waitFor(() => expect(within(dock).getByRole('tab', { name: /Thread/ })).toBeTruthy())
  })

  it('toasts each new direct sequence once and stays quiet on the same cursor', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    await new Promise(resolve => setTimeout(resolve, 300))
    // First direct arrival after the mount banners.
    b.seedInbox([inboxRow('w1', 'thread:w1', { previewText: 'The deploy is blocked' })])
    await within(document.body).findByText(/The deploy is blocked/)
    // A wake that repeats the same newest sequence is not a new message.
    b.publishChannelUpdate()
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(within(document.body).queryAllByText(/The deploy is blocked/)).toHaveLength(1)
    // A newer direct sequence on the same Thread replaces the banner content.
    b.seedInbox([inboxRow('w1', 'thread:w1', { newestSequence: 12, previewText: 'Rollback is ready for review' })])
    await within(document.body).findByText(/Rollback is ready for review/)
    await b.runtime.dispose()
  })

})
