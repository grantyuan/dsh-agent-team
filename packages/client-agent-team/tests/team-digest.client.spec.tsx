// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { runtimeWithTeam } from './harness.tsx'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

/** The queue row that leads the reader into the Thread under test. Every test
 * owns its own threadRef: the panel remembers one recap per Thread revision,
 * and distinct refs keep that memory from crossing test boundaries. */
function inboxRow(workspaceId: string, threadRef: string): { readonly workspaceId: string } & Record<string, unknown> {
  return {
    workspaceId,
    channelRef: 'channel:engineering',
    channelName: 'engineering',
    taskNumber: 1,
    task: { taskRef: 'task:1', channelRef: 'channel:engineering', threadRef, status: 'todo', resolution: 'open' },
    thread: { threadRef, taskRef: 'task:1', revision: 2 },
    unreadCount: 1,
    directCount: 0,
    previewText: '评估发布方案',
    createdOccurredAt: '2026-10-01T02:00:00.000Z',
    latestReplyOccurredAt: '2026-10-02T02:00:00.000Z',
    latestReplyActor: { memberId: 'member:builder', name: 'builder' },
    needsHumanDecision: false,
    newestSequence: 2,
    newestOccurredAt: '2026-10-02T02:00:00.000Z',
    newestActor: { memberId: 'member:builder', name: 'builder' },
    claimOwners: [],
  }
}

/** Open the bench Workspace's seeded Thread through the Inbox row — the same
 * durable path a reader takes — and hand back the digest panel region. */
async function openThread(b: Awaited<ReturnType<typeof runtimeWithTeam>>, threadRef: string): Promise<HTMLElement> {
  b.seedInbox([inboxRow('w1', threadRef)])
  // Prefix match, not exact: once the reader has visited a Thread and come
  // back, the sidebar card carries its unread count inside the button, and
  // the accessible name grows with it.
  const card = await b.view.findByRole('button', { name: /^收件箱/ })
  fireEvent.click(card)
  // The row is looked up inside the Inbox page itself: the sidebar's Channel
  // row names the same #engineering and would answer first from outside it.
  const inboxPage = await waitFor(() => {
    const surface = b.view.container.querySelector('[data-team-inbox]')
    expect(surface).toBeTruthy()
    return surface as HTMLElement
  })
  const row = await within(inboxPage).findByRole('button', { name: /#engineering/ })
  fireEvent.click(row)
  return await b.view.findByRole('region', { name: '速览' })
}

/** Leave the open Thread through its own Back control, so the next
 * `openThread` starts from a page that carries the Inbox entry again. */
async function backFromThread(b: Awaited<ReturnType<typeof runtimeWithTeam>>): Promise<void> {
  const back = await b.view.findByRole('button', { name: /返回/ })
  fireEvent.click(back)
  await waitFor(() => expect(b.view.container.querySelector('[data-team-digest]')).toBeNull())
}

describe('Team Thread digest', () => {
  it('asks the Host for one recap when the Thread opens, and leads the column with it', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialChannels: true, seedThreadRef: 'thread:d-read', seededMessages: [{ body: '评估发布方案', occurredAt: '2026-10-01T02:00:00.000Z' }], remainingUnreadCounts: [0] })
    const panel = await openThread(b, 'thread:d-read')
    expect(panel.textContent).toContain('测试速览')
    await waitFor(() => expect(b.summarizeThread).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'w1', threadRef: 'thread:d-read' }), expect.any(AbortSignal)))
    // A recap that waits on nobody draws no decision band at all.
    expect(within(panel).queryByRole('radio')).toBeNull()
    await b.runtime.dispose()
  })

  it("offers the Thread's own options as the decision and sends the picked one through the durable reply", async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialChannels: true, seedThreadRef: 'thread:d-choice', seededMessages: [{ body: '评估发布方案', occurredAt: '2026-10-01T02:00:00.000Z' }], remainingUnreadCounts: [0] })
    b.seedDigest({ summary: '发布方案讨论待你拍板', needsHumanDecision: true, decisionQuestion: '走哪个方案？', options: ['方案A：直接发布', '方案B：灰度发布'] })
    const panel = await openThread(b, 'thread:d-choice')
    expect(within(panel).getByText('走哪个方案？')).toBeTruthy()
    expect(within(panel).getByText('发布方案讨论待你拍板')).toBeTruthy()
    const radiogroup = within(panel).getByRole('radiogroup', { name: '需要你决策' })
    expect(within(radiogroup).getAllByRole('radio')).toHaveLength(2)
    expect(within(panel).getByRole('button', { name: '发送意见' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(within(radiogroup).getByRole('radio', { name: '方案B：灰度发布' }))
    fireEvent.click(within(panel).getByRole('button', { name: '发送所选方案' }))
    await waitFor(() => expect(b.reply).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'w1', threadRef: 'thread:d-choice', body: '我的决定：方案B：灰度发布', recipients: [], baseRevision: 2,
    })))
    expect(await within(panel).findByText('你的决定已发送')).toBeTruthy()
    // Picking lands the answer as one ordinary Message; the panel does not
    // keep the choice pressed after it was sent.
    expect(within(radiogroup).getByRole('radio', { name: '方案B：灰度发布' }).getAttribute('aria-checked')).toBe('false')
    await b.runtime.dispose()
  })

  it('sends every ticked option together when the digest read the ask as combinable', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialChannels: true, seedThreadRef: 'thread:d-multi', seededMessages: [{ body: '评估发布方案', occurredAt: '2026-10-01T02:00:00.000Z' }], remainingUnreadCounts: [0] })
    b.seedDigest({ summary: '改进项等你勾选', needsHumanDecision: true, decisionQuestion: '先做哪些？', options: ['加超时重试', '补发布回滚', '收紧日志'], optionSelection: 'multiple' })
    const panel = await openThread(b, 'thread:d-multi')
    // The hint tells the reader this ask takes more than one pick, and the
    // band offers checkboxes where a single-choice ask offered radios.
    expect(within(panel).getByText('可勾选多个方案一并发送，或写下你的意见')).toBeTruthy()
    const group = within(panel).getByRole('group', { name: '需要你决策' })
    const boxes = within(group).getAllByRole('checkbox')
    expect(boxes).toHaveLength(3)
    // Tick order must not reorder the answer: options land in the digest's own order.
    fireEvent.click(boxes[1])
    fireEvent.click(boxes[0])
    expect(boxes[1].getAttribute('aria-checked')).toBe('true')
    fireEvent.click(boxes[1])
    expect(boxes[1].getAttribute('aria-checked')).toBe('false')
    fireEvent.click(boxes[2])
    fireEvent.click(within(panel).getByRole('button', { name: '发送所选方案' }))
    await waitFor(() => expect(b.reply).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'w1', threadRef: 'thread:d-multi', body: '我的决定：加超时重试；收紧日志', recipients: [], baseRevision: 2,
    })))
    await b.runtime.dispose()
  })

  it("writes the reader's own opinion instead of the picked option when they say so", async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialChannels: true, seedThreadRef: 'thread:d-opinion', seededMessages: [{ body: '评估发布方案', occurredAt: '2026-10-01T02:00:00.000Z' }], remainingUnreadCounts: [0] })
    b.seedDigest({ summary: '发布方案讨论待你拍板', needsHumanDecision: true, decisionQuestion: '走哪个方案？', options: ['方案A：直接发布', '方案B：灰度发布'] })
    const panel = await openThread(b, 'thread:d-opinion')
    const radiogroup = within(panel).getByRole('radiogroup', { name: '需要你决策' })
    fireEvent.click(within(radiogroup).getByRole('radio', { name: '方案A：直接发布' }))
    fireEvent.change(within(panel).getByLabelText('其它意见'), { target: { value: '两个都不行，先冻结发布' } })
    // Written words outrank the pressed option, and the button says so.
    fireEvent.click(within(panel).getByRole('button', { name: '发送意见' }))
    await waitFor(() => expect(b.reply).toHaveBeenCalledWith(expect.objectContaining({ body: '两个都不行，先冻结发布', threadRef: 'thread:d-opinion' })))
    await b.runtime.dispose()
  })

  it('answers a reopen at the same revision from browser storage without a second model call', async () => {
    localStorage.setItem('dsh.agent-team.thread-digest', JSON.stringify({
      'thread:d-stored:2': { summary: '存好的速览', keyPoints: ['上次的要点'], needsHumanDecision: false },
    }))
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialChannels: true, seedThreadRef: 'thread:d-stored', seededMessages: [{ body: '评估发布方案', occurredAt: '2026-10-01T02:00:00.000Z' }], remainingUnreadCounts: [0] })
    const panel = await openThread(b, 'thread:d-stored')
    // The recap a previous visit left in the browser lands whole — the refresh
    // never loses it — and the model seam is not paid again for the same revision.
    expect(within(panel).getByText('存好的速览')).toBeTruthy()
    expect(b.summarizeThread).not.toHaveBeenCalled()
    await b.runtime.dispose()
  })

  it('keeps the recap across remounts, and an entry from an older revision never answers', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialChannels: true, seedThreadRef: 'thread:d-keep', seededMessages: [{ body: '评估发布方案', occurredAt: '2026-10-01T02:00:00.000Z' }], remainingUnreadCounts: [0] })
    const first = await openThread(b, 'thread:d-keep-a')
    expect(await within(first).findByText('测试速览')).toBeTruthy()
    await backFromThread(b)
    const second = await openThread(b, 'thread:d-keep-b')
    expect(await within(second).findByText('测试速览')).toBeTruthy()
    await waitFor(() => expect(b.summarizeThread).toHaveBeenCalledTimes(2))
    // Back to the first Thread: its seat remounts, the stored recap answers,
    // and no third call is paid for facts that have not moved.
    await backFromThread(b)
    const again = await openThread(b, 'thread:d-keep-a')
    expect(within(again).getByText('测试速览')).toBeTruthy()
    await new Promise(resolve => { setTimeout(resolve, 50) })
    expect(b.summarizeThread).toHaveBeenCalledTimes(2)
    // An entry kept from revision 1 must not speak for a Thread at revision 2.
    await backFromThread(b)
    localStorage.setItem('dsh.agent-team.thread-digest', JSON.stringify({
      'thread:d-old:1': { summary: '过期的速览', keyPoints: [], needsHumanDecision: false },
    }))
    const stale = await openThread(b, 'thread:d-old')
    expect(await within(stale).findByText('测试速览')).toBeTruthy()
    expect(within(stale).queryByText('过期的速览')).toBeNull()
    await waitFor(() => expect(b.summarizeThread).toHaveBeenCalledTimes(3))
    await b.runtime.dispose()
  })

  it('degrades the panel to a retry surface when the digest call fails, and recovers on the next answer', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialChannels: true, seedThreadRef: 'thread:d-fail', seededMessages: [{ body: '评估发布方案', occurredAt: '2026-10-01T02:00:00.000Z' }], remainingUnreadCounts: [0] })
    b.failDigest()
    const panel = await openThread(b, 'thread:d-fail')
    expect(within(panel).getByRole('alert').textContent).toContain('速览暂时无法生成')
    // The timeline is the Thread's own truth and never waits on the recap.
    expect(b.view.getAllByText('评估发布方案').length).toBeGreaterThan(0)
    b.seedDigest({ summary: '恢复后的速览' })
    fireEvent.click(within(panel).getByRole('button', { name: '重试' }))
    expect(await within(panel).findByText('恢复后的速览')).toBeTruthy()
    await b.runtime.dispose()
  })
})
