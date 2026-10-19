// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { runtimeWithTeam } from './harness.tsx'
import { STORAGE_KEY } from '../src/client/navigation.ts'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

/** One queue row as the Host projects it; workspaceId tags the source Workspace. */
function decisionRow(workspaceId: string, overrides: Record<string, unknown> = {}): { readonly workspaceId: string } & Record<string, unknown> {
  return {
    workspaceId,
    channelRef: 'channel:engineering',
    channelName: 'engineering',
    taskNumber: 1,
    task: { taskRef: 'task:1', channelRef: 'channel:engineering', threadRef: 'thread:1', status: 'todo', resolution: 'open' },
    thread: { threadRef: 'thread:1', taskRef: 'task:1', revision: 2 },
    reason: 'decision_request',
    askText: '发布方案定了吗？请拍板',
    askOccurredAt: '2026-10-02T02:00:00.000Z',
    askActor: { memberId: 'member:builder', name: 'builder' },
    createdOccurredAt: '2026-09-13T04:00:00.000Z',
    unreadCount: 0,
    ...overrides,
  }
}

/** Enter the decision queue through the sidebar card — the same durable path a
 * reader takes — and hand back the page region. */
async function openDecisions(b: Awaited<ReturnType<typeof runtimeWithTeam>>): Promise<HTMLElement> {
  // Prefix match, not exact: the card's accessible name carries the waiting
  // count once the alert source has read the queue.
  fireEvent.click(await b.view.findByRole('button', { name: /^需要你决定/ }))
  return await waitFor(() => {
    const surface = b.view.container.querySelector('[data-team-decisions]')
    expect(surface).toBeTruthy()
    return surface as HTMLElement
  })
}

function rowsOf(page: HTMLElement): readonly HTMLElement[] {
  return [...page.querySelectorAll<HTMLElement>('[data-team-decision-row]')]
}

/** One Workspace group of the partitioned queue, in render order. */
function groupsOf(page: HTMLElement): readonly HTMLElement[] {
  return [...page.querySelectorAll<HTMLElement>('[data-team-decision-group]')]
}

describe('Team decision queue', () => {
  it('lists what waits on the reader across Workspaces, partitioned by Workspace then Channel, and answers one row in place', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', seededMessages: [{ body: 'Thread opener', occurredAt: '2026-09-13T04:00:00.000Z' }] })
    b.seedDecisions([
      decisionRow('w1', { thread: { threadRef: 'thread:1', taskRef: 'task:1', revision: 2 }, askText: '方案 A 还是 B？请拍板' }),
      decisionRow('w1', {
        channelRef: 'channel:ops', channelName: 'ops', taskNumber: 3, askText: '发布窗口要不要顺延？',
        task: { taskRef: 'task:3', channelRef: 'channel:ops', threadRef: 'thread:3', status: 'todo', resolution: 'open' },
        thread: { threadRef: 'thread:3', taskRef: 'task:3', revision: 5 },
      }),
      decisionRow('w2', {
        channelRef: 'channel:engineering', taskNumber: 2, askText: '上线前请确认数据口径',
        askOccurredAt: '2026-10-01T02:00:00.000Z',
        task: { taskRef: 'task:2', channelRef: 'channel:engineering', threadRef: 'thread:2', status: 'todo', resolution: 'open' },
        thread: { threadRef: 'thread:2', taskRef: 'task:2', revision: 3 },
      }),
    ])
    const page = await openDecisions(b)
    // The page reads every visible Workspace, so one entry point covers them all.
    expect(b.pendingDecisions).toHaveBeenCalledWith({ workspaceId: 'w1' })
    expect(b.pendingDecisions).toHaveBeenCalledWith({ workspaceId: 'w2' })
    // Rows are partitioned, never merged flat: each Workspace is a heading and
    // each Channel inside it is a nested one, so a Thread always lands under the
    // same two names instead of the reader reading them off the row itself. The
    // group order is the visible roster's own — Alpha leads Beta.
    const groups = groupsOf(page)
    expect(groups).toHaveLength(2)
    expect(within(groups[0]!).getByRole('heading', { name: /^Alpha/ })).toBeTruthy()
    expect(within(groups[1]!).getByRole('heading', { name: /^Beta/ })).toBeTruthy()
    expect(rowsOf(groups[0]!)).toHaveLength(2)
    expect(rowsOf(groups[1]!)).toHaveLength(1)
    // Within Alpha the Channels are the second level, one group each.
    expect(within(groups[0]!).getByRole('heading', { name: /#engineering/ })).toBeTruthy()
    expect(within(groups[0]!).getByRole('heading', { name: /#ops/ })).toBeTruthy()
    expect(within(groups[1]!).queryByRole('heading', { name: /#ops/ })).toBeNull()
    const alphaEngineering = within(groups[0]!).getByRole('heading', { name: /#engineering/ }).parentElement!
    const alphaOps = within(groups[0]!).getByRole('heading', { name: /#ops/ }).parentElement!
    const betaRow = rowsOf(groups[1]!)[0]!
    expect(rowsOf(alphaEngineering)[0]!.textContent).toContain('方案 A 还是 B？请拍板')
    expect(rowsOf(alphaOps)[0]!.textContent).toContain('发布窗口要不要顺延？')
    expect(betaRow.textContent).toContain('上线前请确认数据口径')
    expect(within(betaRow).getByText('等待你的答复')).toBeTruthy()
    // The ask speaks for itself: the row says who is waiting and states the ask
    // in the author's own words rather than an internal ref.
    expect(within(betaRow).getByRole('img', { name: '@builder 在等你' })).toBeTruthy()
    // Answering from the queue drains the reader's own backlog first, then
    // commits against the revision that read returned.
    fireEvent.click(within(betaRow).getByRole('button', { name: '回复' }))
    fireEvent.change(within(betaRow).getByLabelText('回复内容'), { target: { value: '口径按上个季度的来' } })
    fireEvent.click(within(betaRow).getByRole('button', { name: '发送答复' }))
    await waitFor(() => expect(b.reply).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'w2', threadRef: 'thread:2', body: '口径按上个季度的来', recipients: [], baseRevision: 2,
    })))
    // The sent row closes its composer instead of keeping a half-written draft
    // around next to the answer that already left.
    await waitFor(() => expect(within(betaRow).queryByLabelText('回复内容')).toBeNull())
    expect((within(betaRow).getByRole('button', { name: '回复' }))).toBeTruthy()
    // A row leaves only when the Host stops reporting it, never because the
    // reader looked at it.
    b.seedDecisions([])
    await waitFor(() => expect(b.view.getByText('暂时没有需要你决定的事')).toBeTruthy())
    await b.runtime.dispose()
  })

  it("orders the rows inside each Channel group by the reader's own key, newest message first by default", async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', seededMessages: [{ body: 'Thread opener', occurredAt: '2026-09-13T04:00:00.000Z' }] })
    b.seedDecisions([
      // Same Workspace and Channel: only the reader's key may separate them, and
      // the two keys disagree so a re-sort is visible.
      decisionRow('w1', {
        askText: '旧回复但新创建', createdOccurredAt: '2026-10-01T02:00:00.000Z', latestReplyOccurredAt: '2026-10-05T02:00:00.000Z',
      }),
      decisionRow('w1', {
        thread: { threadRef: 'thread:2', taskRef: 'task:2', revision: 3 },
        task: { taskRef: 'task:2', channelRef: 'channel:engineering', threadRef: 'thread:2', status: 'todo', resolution: 'open' },
        taskNumber: 2, askText: '新回复但旧创建', createdOccurredAt: '2026-09-13T04:00:00.000Z', latestReplyOccurredAt: '2026-10-07T02:00:00.000Z',
      }),
    ])
    const page = await openDecisions(b)
    // Default: the newest message leads, whichever row it belongs to.
    expect(rowsOf(page).map(row => row.textContent)).toEqual([expect.stringContaining('新回复但旧创建'), expect.stringContaining('旧回复但新创建')])
    expect((within(page).getByLabelText('排序') as HTMLSelectElement).value).toBe('latestReply')
    // The reader's pick re-lays the rows inside the group and rides this
    // browser's storage, so the taste survives the page being reopened.
    fireEvent.change(within(page).getByLabelText('排序'), { target: { value: 'created' } })
    expect(rowsOf(page).map(row => row.textContent)).toEqual([expect.stringContaining('旧回复但新创建'), expect.stringContaining('新回复但旧创建')])
    expect(localStorage.getItem('dsh.agent-team.decisions-sort')).toBe('created')
    // Group order itself never moves with the sort key.
    expect(groupsOf(page).map(group => group.querySelector('h2')!.textContent)).toEqual(['Alpha2'])
    await b.runtime.dispose()
  })

  it('clears the reader’s own unread with 「已读」 without dropping the row, and toggles Attention with 「关注/取消关注」', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', seededMessages: [{ body: 'Thread opener', occurredAt: '2026-09-13T04:00:00.000Z' }] })
    b.seedDecisions([decisionRow('w1', { unreadCount: 3 })])
    const page = await openDecisions(b)
    const row = rowsOf(page)[0]!
    // Unread is derived from Attention, so the two marks complement each other:
    // a row holding unread can clear it, and a row with none can only be
    // followed. Neither ever answers the ask, so the row stays either way.
    expect((within(row).getByRole('button', { name: '已读' }) as HTMLButtonElement).disabled).toBe(false)
    expect(within(row).getByRole('button', { name: '关注' })).toBeTruthy()
    fireEvent.click(within(row).getByRole('button', { name: '关注' }))
    await waitFor(() => expect(b.changeAttention).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'w1', threadRef: 'thread:1', action: 'follow' })))
    // The Host's refusal is never shown: the row re-reads the queue instead, and
    // the label follows the Attention the Host now reports.
    await waitFor(() => expect(within(row).getByRole('button', { name: '取消关注' })).toBeTruthy())
    fireEvent.click(within(row).getByRole('button', { name: '取消关注' }))
    await waitFor(() => expect(b.changeAttention).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'w1', threadRef: 'thread:1', action: 'unfollow' })))
    await waitFor(() => expect(within(row).getByRole('button', { name: '关注' })).toBeTruthy())
    await b.runtime.dispose()
  })

  it('clears unread on a row that holds some, and keeps the row because the ask still waits', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', seededMessages: [{ body: 'Thread opener', occurredAt: '2026-09-13T04:00:00.000Z' }] })
    b.seedDecisions([decisionRow('w1', { unreadCount: 2 })])
    const page = await openDecisions(b)
    const row = rowsOf(page)[0]!
    expect((within(row).getByRole('button', { name: '已读' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(within(row).getByRole('button', { name: '已读' }))
    // The durable read is the same one an answer performs; the row itself stays
    // until the Host stops reporting the ask.
    await waitFor(() => expect(b.readThread).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'w1', threadRef: 'thread:1' })))
    await waitFor(() => expect(b.pendingDecisions.mock.calls.length).toBeGreaterThan(1))
    b.seedDecisions([decisionRow('w1', { unreadCount: 0 })])
    await waitFor(() => expect((within(rowsOf(page)[0]!).getByRole('button', { name: '已读' }) as HTMLButtonElement).disabled).toBe(true))
    expect(rowsOf(page)).toHaveLength(1)
    await b.runtime.dispose()
  })

  it('clears the whole queue with 「全部已读」, reading each Thread that holds unread through once', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', seededMessages: [{ body: 'Thread opener', occurredAt: '2026-09-13T04:00:00.000Z' }] })
    b.seedDecisions([
      decisionRow('w1', { unreadCount: 2 }),
      decisionRow('w1', { unreadCount: 1, thread: { threadRef: 'thread:2', taskRef: 'task:2', revision: 3 }, task: { taskRef: 'task:2', channelRef: 'channel:engineering', threadRef: 'thread:2', status: 'todo', resolution: 'open' } }),
    ])
    const page = await openDecisions(b)
    const markAll = within(page).getByRole('button', { name: '全部已读' }) as HTMLButtonElement
    // The page-wide action reads the same fact the rows do, so a queue with
    // unread in it can be cleared in one go rather than row by row.
    expect(markAll.disabled).toBe(false)
    fireEvent.click(markAll)
    await waitFor(() => expect(b.readThread).toHaveBeenCalledTimes(2))
    expect(b.readThread).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'w1', threadRef: 'thread:1' }))
    expect(b.readThread).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'w1', threadRef: 'thread:2' }))
    await waitFor(() => expect(b.pendingDecisions.mock.calls.length).toBeGreaterThan(1))
    // The queue itself is not what the drain empties — an ask nobody answered
    // still waits — so the rows stay and only their unread marks go, and the
    // button stands down until something holds unread again.
    b.seedDecisions([decisionRow('w1', { unreadCount: 0 })])
    await waitFor(() => expect((within(page).getByRole('button', { name: '全部已读' }) as HTMLButtonElement).disabled).toBe(true))
    expect(rowsOf(page)).toHaveLength(1)
    await b.runtime.dispose()
  })

  it('accepts work awaiting review, and offers no acceptance where the ask is a plain question', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', seededMessages: [{ body: 'Thread opener', occurredAt: '2026-09-13T04:00:00.000Z' }] })
    b.seedDecisions([
      decisionRow('w1', { reason: 'task_review', askText: '接口已按新规范改完', task: { taskRef: 'task:1', channelRef: 'channel:engineering', threadRef: 'thread:1', status: 'in_review', resolution: 'open' } }),
      decisionRow('w1', { thread: { threadRef: 'thread:9', taskRef: 'task:9', revision: 4 }, task: { taskRef: 'task:9', channelRef: 'channel:engineering', threadRef: 'thread:9', status: 'todo', resolution: 'open' }, askOccurredAt: '2026-10-03T02:00:00.000Z', askText: '要不要一起改日志？' }),
    ])
    const page = await openDecisions(b)
    const rows = rowsOf(page)
    // The chip and the acceptance action both follow the reason, so a question
    // never offers a button that would commit the wrong kind of answer.
    expect(within(rows[0]!).getByText('等待你验收')).toBeTruthy()
    expect(within(rows[1]!).getByText('等待你的答复')).toBeTruthy()
    expect(within(rows[0]!).getByRole('button', { name: '验收通过' })).toBeTruthy()
    expect(within(rows[1]!).queryByRole('button', { name: '验收通过' })).toBeNull()
    fireEvent.click(within(rows[0]!).getByRole('button', { name: '验收通过' }))
    await waitFor(() => expect(b.changeTask).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'w1', taskRef: 'task:1', action: 'accept', baseRevision: 2,
    })))
    await b.runtime.dispose()
  })

  it("keeps the Host's refusal on the row and re-reads the queue", async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', seededMessages: [{ body: 'Thread opener', occurredAt: '2026-09-13T04:00:00.000Z' }] })
    b.seedDecisions([decisionRow('w1')])
    const page = await openDecisions(b)
    const row = rowsOf(page)[0]!
    b.reply.mockResolvedValueOnce({ ok: true as const, value: { kind: 'unread_required' as const, threadRef: 'thread:1', revision: 2, unreadCount: 3, directCount: 0 } } as never)
    fireEvent.click(within(row).getByRole('button', { name: '回复' }))
    fireEvent.change(within(row).getByLabelText('回复内容'), { target: { value: '就走 B 方案' } })
    fireEvent.click(within(row).getByRole('button', { name: '发送答复' }))
    // The refusal stays next to the ask it belongs to, said in the reader's
    // language rather than as a status code.
    expect(await within(row).findByRole('alert')).toBeTruthy()
    expect(within(row).getByRole('alert').textContent).toContain('请先读取 3 条未读更新')
    // The queue is re-read so the row reflects whatever the Host now reports.
    await waitFor(() => expect(b.pendingDecisions.mock.calls.length).toBeGreaterThan(1))
    await b.runtime.dispose()
  })

  it('opens the Thread from its row and lands Back on the decision list', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', seededMessages: [{ body: 'Thread opener', occurredAt: '2026-09-13T04:00:00.000Z' }] })
    b.seedDecisions([decisionRow('w1')])
    const page = await openDecisions(b)
    fireEvent.click(within(rowsOf(page)[0]!).getByRole('button', { name: '打开讨论' }))
    await waitFor(() => expect(b.readThread).toHaveBeenCalled())
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '')).toMatchObject({ mode: 'team', workspaceId: 'w1', channelRef: 'channel:engineering', threadRef: 'thread:1', threadOrigin: 'decisions' })
    fireEvent.click(await b.view.findByRole('button', { name: '返回待决定列表' }))
    await waitFor(() => expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '')).toMatchObject({ mode: 'team', decisions: true }))
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '')).not.toHaveProperty('threadRef')
    await b.runtime.dispose()
  })

  it('shows how much is waiting on the sidebar card, across every Workspace', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    b.seedDecisions([decisionRow('w1'), decisionRow('w2', { thread: { threadRef: 'thread:2', taskRef: 'task:2', revision: 3 } })])
    // One queue read feeds both the count and the arrival signal, so the card
    // that says how much is waiting is the same fact the chime rings for.
    const card = await b.view.findByRole('button', { name: '需要你决定，2 件事在等你' })
    expect(card.querySelector('[data-team-decisions-dot]')).toBeTruthy()
    await b.runtime.dispose()
  })
})
