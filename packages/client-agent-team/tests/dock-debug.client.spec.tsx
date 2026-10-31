// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.setConfig({ testTimeout: 30_000 })
import { cleanup, fireEvent, waitFor } from '@testing-library/react'
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

describe('debug inbox back', () => {
  it('walks the flow with markers', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', seededMessages: [{ body: 'Thread opener', occurredAt: '2026-09-13T03:00:00.000Z' }], remainingUnreadCounts: [0], initialChannels: true, seedThreadRef: 'thread:w2' })
    const card = await b.view.findByRole('button', { name: '收件箱' })
    b.seedInbox([inboxRow('w2', 'thread:w2')])
    b.seedInbox([inboxRow('w2', 'thread:w2')])
    await new Promise(resolve => setTimeout(resolve, 200))
    console.log('step1 dock:', b.view.container.innerHTML.includes('data-team-dock'))
    fireEvent.click(card)
    await new Promise(resolve => setTimeout(resolve, 200))
    console.log('step2 dock:', b.view.container.innerHTML.includes('data-team-dock'), 'tabs:', [...b.view.container.querySelectorAll('[role="tab"]')].map(tab => `${tab.textContent}:${tab.getAttribute('aria-selected')}`))
    const row = await b.view.findByRole('button', { name: /Decision needed on the rollout/ })
    fireEvent.click(row)
    await waitFor(() => expect(b.readThread).toHaveBeenCalled())
    await new Promise(resolve => setTimeout(resolve, 200))
    console.log('step3 dock:', b.view.container.innerHTML.includes('data-team-dock'), 'tabs:', [...b.view.container.querySelectorAll('[role="tab"]')].map(tab => `${tab.textContent}:${tab.getAttribute('aria-selected')}`))
    fireEvent.click(await b.view.findByRole('button', { name: '返回收件箱列表' }))
    await new Promise(resolve => setTimeout(resolve, 300))
    console.log('step4 dock:', b.view.container.innerHTML.includes('data-team-dock'), 'tabs:', [...b.view.container.querySelectorAll('[role="tab"]')].map(tab => `${tab.textContent}:${tab.getAttribute('aria-selected')}`), 'empty:', b.view.queryByText('收件箱是空的') !== null)
    expect(true).toBe(true)
    await b.runtime.dispose()
  })
})
