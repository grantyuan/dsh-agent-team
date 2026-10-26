// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { runtimeWithTeam } from './harness.tsx'
import { STORAGE_KEY } from '../src/client/navigation.ts'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

/** One topics row as the Host emits it; workspaceId tags the source Workspace. */
function topicRow(workspaceId: string, threadRef: string, overrides: Record<string, unknown> = {}): { readonly workspaceId: string } & Record<string, unknown> {
  return {
    workspaceId,
    channelRef: 'channel:engineering',
    channelName: 'engineering',
    threadRef,
    subject: 'Roll out the new billing flow',
    openedAt: '2026-09-12T08:00:00.000Z',
    lastOccurredAt: '2026-09-13T04:00:00.000Z',
    lastActor: { memberId: 'member:iris', name: 'iris' },
    messageCount: 4,
    participantCount: 2,
    participants: [{ memberId: 'member:human', name: 'human' }, { memberId: 'member:iris', name: 'iris' }],
    unreadCount: 1,
    iParticipated: true,
    needsHumanDecision: false,
    claimOwners: [],
    newestSequence: 9,
    ...overrides,
  }
}

/** One 「我的消息」 row; the sequence is the row's own ledger position. */
function messageRow(workspaceId: string, sequence: number, overrides: Record<string, unknown> = {}): { readonly workspaceId: string } & Record<string, unknown> {
  return {
    workspaceId,
    channelRef: 'channel:engineering',
    channelName: 'engineering',
    threadRef: 'thread:w1',
    threadSubject: 'Roll out the new billing flow',
    messageRef: `message:${sequence}`,
    sequence,
    occurredAt: '2026-09-13T04:00:00.000Z',
    sender: { memberId: 'member:builder', name: 'builder' },
    recipients: [{ memberId: 'member:human', name: 'human' }],
    excerpt: 'Decision needed on the rollout',
    direction: 'received',
    via: 'thread',
    processing: { state: 'pending', basis: 'derived', evidence: [] },
    ...overrides,
  }
}

/** The rows one panel currently shows, in DOM order. */
function rowsOf(view: { container: HTMLElement }, marker: string): readonly HTMLElement[] {
  return [...view.container.querySelectorAll<HTMLElement>(`[${marker}]`)]
}

/** The first 「我的消息」 row after the tab switch, waited into existence. */
async function firstMessageRow(b: Awaited<ReturnType<typeof runtimeWithTeam>>): Promise<HTMLElement> {
  return waitFor(() => {
    const found = rowsOf(b.view, 'data-team-messages-message')[0]
    expect(found).toBeTruthy()
    return found!
  })
}

async function openCenter(b: Awaited<ReturnType<typeof runtimeWithTeam>>): Promise<void> {
  const card = await b.view.findByRole('button', { name: '消息中心' })
  fireEvent.click(card)
  await waitFor(() => expect(b.view.container.querySelector('[data-team-messages]')).toBeTruthy())
}

describe('Team Message Center surfaces', () => {
  it('groups topics by Workspace and Channel and opens a row Thread with the messages origin', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    b.seedMessageCenterTopics([topicRow('w1', 'thread:w1'), topicRow('w2', 'thread:w2', { subject: 'Second workspace topic' })])
    await openCenter(b)
    // The Workspace is one heading and the Channel a nested one, so no row
    // repeats either name; the counts ride the headings, not the rows.
    expect(b.view.getByRole('heading', { name: /Alpha/ })).toBeTruthy()
    expect(b.view.getByRole('heading', { name: /Beta/ })).toBeTruthy()
    expect(b.view.getAllByRole('heading', { name: /engineering/ })).toHaveLength(2)
    const rows = rowsOf(b.view, 'data-team-messages-topic')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.textContent).toContain('Roll out the new billing flow')
    expect(rows[1]!.textContent).toContain('Second workspace topic')
    expect(rows[0]!.textContent).toContain('我参与过')

    // A topic row opens its Thread with the Message Center as the origin, so
    // Back lands back here instead of on a Workspace overview.
    fireEvent.click(rows[0]!)
    await waitFor(() => expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '')).toMatchObject({ threadRef: 'thread:w1', threadOrigin: 'messages' }))
    await b.runtime.dispose()
  })

  it('lists the addressed and sent Messages newest first with their processing trace', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    b.seedMessageCenterMessages([
      messageRow('w1', 12, { direction: 'sent', sender: { memberId: 'member:human', name: 'human' } }),
      messageRow('w1', 9, { processing: { state: 'acknowledged', basis: 'derived', evidence: [{ kind: 'read', memberId: 'member:builder' }] } }),
      messageRow('w1', 7, { via: 'dm', dmPartner: { memberId: 'member:builder', name: 'builder' }, channelRef: undefined, channelName: undefined, threadRef: undefined, threadSubject: undefined, messageRef: undefined, dmOperationId: 'op:1' }),
    ])
    await openCenter(b)
    fireEvent.click(b.view.getByRole('tab', { name: '我的消息' }))
    const rows = await waitFor(() => {
      const found = rowsOf(b.view, 'data-team-messages-message')
      expect(found).toHaveLength(3)
      return found
    })
    // One global order, the ledger's own: newest sequence first. The direct
    // Message rides its own Channel group, so the two Thread rows are judged
    // in their own order and the DM row only by its lane.
    const threadRows = rows.filter(row => row.textContent.includes('私信') === false)
    expect(threadRows.map(row => row.getAttribute('data-direction'))).toEqual(['sent', 'received'])
    expect(threadRows[0]!.textContent).toContain('我发出的')
    expect(threadRows[1]!.textContent).toContain('发给我的')
    // The derived trace renders as a pill, worded as a state the reader can
    // act on; the ledger basis stays an inference, never a confirmation.
    expect(threadRows[0]!.textContent).toContain('待处理')
    expect(threadRows[1]!.textContent).toContain('已响应')
    // A direct Message names its lane and offers no Thread lane at all: no
    // locate and no inline reply, because the ledger holds no Thread for it.
    const dmRow = rows.find(row => row.textContent.includes('私信'))!
    expect(dmRow).toBeTruthy()
    expect(dmRow.querySelectorAll('button')).toHaveLength(0)
    await b.runtime.dispose()
  })

  it('shares one search box across tabs and passes the query to both reads', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    b.seedMessageCenterTopics([topicRow('w1', 'thread:w1')])
    b.seedMessageCenterMessages([messageRow('w1', 5)])
    await openCenter(b)
    const callsBefore = b.messageCenter.mock.calls.length
    fireEvent.change(b.view.getByLabelText('搜索'), { target: { value: 'rollout' } })
    // The debounced query reaches the Host for the face on screen…
    await waitFor(() => {
      const applied = b.messageCenter.mock.calls.slice(callsBefore).map(([request]) => request as { query?: string; view: string })
      expect(applied.some(request => request.view === 'topics' && request.query === 'rollout')).toBe(true)
    })
    // …and switching faces re-reads with the same query: the box is one
    // filter over two views, not two filters.
    const callsAtSwitch = b.messageCenter.mock.calls.length
    fireEvent.click(b.view.getByRole('tab', { name: '我的消息' }))
    await waitFor(() => {
      const applied = b.messageCenter.mock.calls.slice(callsAtSwitch).map(([request]) => request as { query?: string; view: string })
      expect(applied.some(request => request.view === 'messages' && request.query === 'rollout')).toBe(true)
    })
    expect((b.view.getByLabelText('搜索') as HTMLInputElement).value).toBe('rollout')
    await b.runtime.dispose()
  })

  it('renders the failed read with a retry and the empty read with its own words', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    b.failMessageCenter('ledger offline')
    await openCenter(b)
    // A face that never arrived is a refusal, not an empty queue: it carries
    // the Host's own message and a retry.
    const alert = await b.view.findByRole('alert')
    expect(alert.textContent).toContain('读取消息中心失败：ledger offline')
    const retry = b.view.getByRole('button', { name: '重试' })
    b.failMessageCenter(undefined)
    b.seedMessageCenterTopics([topicRow('w1', 'thread:w1')])
    fireEvent.click(retry)
    await waitFor(() => expect(b.view.getByRole('heading', { name: /Alpha/ })).toBeTruthy())
    // An arrived face with no rows says what emptiness means, per tab.
    fireEvent.click(b.view.getByRole('tab', { name: '我的消息' }))
    await waitFor(() => expect(b.view.getByText('还没有你的消息')).toBeTruthy())
    await b.runtime.dispose()
  })

  it('locates a message row in its Thread through the persisted sequence anchor', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    b.seedMessageCenterMessages([messageRow('w1', 12)])
    await openCenter(b)
    fireEvent.click(b.view.getByRole('tab', { name: '我的消息' }))
    const row = await firstMessageRow(b)
    fireEvent.click(within(row).getByRole('button', { name: '定位到讨论' }))
    // The anchor is a durable navigation fact: the Thread page walks its
    // history to this sequence, and a reload replays the same scroll.
    await waitFor(() => expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '')).toMatchObject({
      threadRef: 'thread:w1', threadOrigin: 'messages', focusSequence: 12,
    }))
    await b.runtime.dispose()
  })

  it('answers a row inline through the reply path and reports the commit on the row', async () => {
    // The bench Thread backing the reply: readThread anchors the revision on it.
    const b = await runtimeWithTeam({
      mode: 'team', workspaceId: 'w1', initialChannels: true,
      seededMessages: [{ body: 'seeded opener', occurredAt: '2026-09-12T00:00:00.000Z', sender: 'agent' as const }],
    })
    b.seedMessageCenterMessages([messageRow('w1', 12)])
    await openCenter(b)
    fireEvent.click(b.view.getByRole('tab', { name: '我的消息' }))
    const row = await firstMessageRow(b)
    fireEvent.click(within(row).getByRole('button', { name: '回复' }))
    const area = await b.view.findByRole('textbox', { name: '回复' })
    fireEvent.change(area, { target: { value: 'on it now' } })
    const readsBeforeSend = b.readThread.mock.calls.length
    // Enter sends: the keyboard completes the whole reply.
    fireEvent.keyDown(area, { key: 'Enter' })
    await waitFor(() => expect(b.reply).toHaveBeenCalled())
    // The reply anchors on the Thread's current revision, names the row's
    // sender, and commits the typed body.
    const request = b.reply.mock.calls.at(-1)![0] as { threadRef: string; body: string; baseRevision: number; recipients: readonly string[] }
    expect(request.threadRef).toBe('thread:w1')
    expect(request.body).toBe('on it now')
    expect(request.baseRevision).toBe(2)
    expect(request.recipients).toEqual(['member:builder'])
    expect(b.readThread.mock.calls.length).toBe(readsBeforeSend + 1)
    // The commit closes the composer, states the outcome on the row, and
    // re-reads so the 「我发出的」 row appears without a manual refresh.
    await waitFor(() => expect(within(row).queryByText('回复已发出')).toBeTruthy())
    expect(b.view.queryByRole('textbox', { name: '回复' })).toBeNull()
    await waitFor(() => expect(b.messageCenter.mock.calls.length).toBeGreaterThan(0))
    await b.runtime.dispose()
  })

  it('keeps the composer open with the failure on a refused reply', async () => {
    const b = await runtimeWithTeam({
      mode: 'team', workspaceId: 'w1', initialChannels: true,
      seededMessages: [{ body: 'seeded opener', occurredAt: '2026-09-12T00:00:00.000Z', sender: 'agent' as const }],
    })
    b.seedMessageCenterMessages([messageRow('w1', 12)])
    await openCenter(b)
    fireEvent.click(b.view.getByRole('tab', { name: '我的消息' }))
    const row = await firstMessageRow(b)
    b.reply.mockImplementationOnce(async () => ({ ok: false as const, error: { message: 'ledger offline' } }) as unknown as Awaited<ReturnType<typeof b.reply>>)
    fireEvent.click(within(row).getByRole('button', { name: '回复' }))
    const area = await b.view.findByRole('textbox', { name: '回复' })
    fireEvent.change(area, { target: { value: 'still here' } })
    fireEvent.click(b.view.getByRole('button', { name: '发送回复' }))
    const alert = await b.view.findByRole('alert')
    expect(alert.textContent).toBe('回复失败：ledger offline')
    // The draft and the composer survive the refusal: the reader edits and
    // resends instead of retyping.
    expect((b.view.getByRole('textbox', { name: '回复' }) as HTMLTextAreaElement).value).toBe('still here')
    await b.runtime.dispose()
  })
})
