// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { runtimeWithTeam } from './harness.tsx'
import { STORAGE_KEY } from '../src/client/navigation.ts'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

/** One Inbox row as the Host emits it; workspaceId tags the source Workspace. */
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
    // The row's own clocks the Host computes from the Thread: the anchor's
    // instant, the newest reply after it with its author, and whether the
    // Thread still waits on the Human.
    createdOccurredAt: '2026-09-12T08:00:00.000Z',
    latestReplyOccurredAt: '2026-09-13T04:00:00.000Z',
    latestReplyActor: { memberId: 'member:iris', name: 'iris' },
    needsHumanDecision: true,
    newestSequence: 9,
    newestOccurredAt: '2026-09-13T04:00:00.000Z',
    // The Host resolves who the row's instant came from, so a row never needs a
    // Member view of its own to name them.
    newestActor: { memberId: 'member:iris', name: 'iris' },
    // Nor a roster to draw a Task's live owners: the Host resolves those too, and
    // an Inbox row leads with them the same way the Channel feed's entry does.
    claimOwners: [],
    ...overrides,
  }
}

/** The one count capsule a queue row may hold, by the attribute every capsule carries. */
function capsuleOf(row: HTMLElement): HTMLElement | null {
  return row.querySelector('[data-team-count-badge]')
}

/** The one unread dot the Inbox entry may hold, by the attribute the mark carries. */
function dotOf(card: HTMLElement): HTMLElement | null {
  return card.querySelector('[data-team-inbox-dot]')
}

/**
 * The Inbox entry's visible statement is a dot, so the quantity a spec used to
 * wait on moved to the one place it still is: the control's own name. Waiting on
 * the name is the stronger sync point — it fails while the count is stale — and
 * the dot is asserted with it, since a name that says "unread" over a sidebar
 * showing nothing is exactly the drift this pair catches. Count zero is the
 * absence of both.
 */
async function waitForEntryUnread(entry: HTMLElement, count: number): Promise<void> {
  await waitFor(() => expect(entry.getAttribute('aria-label')).toBe(count === 0 ? '收件箱' : `收件箱，${count} 条未读`))
  expect(dotOf(entry) === null).toBe(count === 0)
}

/** The leading Member circle every row holds, whatever it does or does not count. */
function actorOf(row: HTMLElement): HTMLElement | null {
  return row.querySelector('[role="img"][aria-label^="最新来自"]')
}

describe('Team Inbox surfaces', () => {
  it('marks the cross-Workspace unread on the wide card with a dot and hides it at zero', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    const card = await b.view.findByRole('button', { name: '收件箱' })
    expect(card.getAttribute('aria-current')).toBeNull()
    // Zero is the absence of a mark rather than a mark standing there empty, and
    // the quantity the dot replaced is not gone: it is the control's own name, so
    // the sidebar stays quiet and still answers "how much" when asked.
    expect(dotOf(card)).toBeNull()
    expect(card.getAttribute('aria-label')).toBe('收件箱')
    // The scaffold's parked first probe consumes one publish; the second wakes.
    // The second row carries more unread than mentions, so the name can only
    // read 6 by counting the whole unread slice rather than the mentions.
    b.seedInbox([inboxRow('w1', 'thread:w1'), inboxRow('w2', 'thread:w2', { directCount: 2, unreadCount: 5 })])
    b.seedInbox([inboxRow('w1', 'thread:w1'), inboxRow('w2', 'thread:w2', { directCount: 2, unreadCount: 5 })])
    await waitForEntryUnread(card, 6)
    await b.runtime.dispose()
  })

  it('opens the Inbox page from the card with rows and marks the card as the current page', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    const card = await b.view.findByRole('button', { name: '收件箱' })
    b.seedInbox([inboxRow('w2', 'thread:w2')])
    b.seedInbox([inboxRow('w2', 'thread:w2')])
    await waitForEntryUnread(card, 1)
    fireEvent.click(card)
    // The row replaces the empty state, and where it lives is stated above it:
    // the Workspace is one heading, the Channel a nested one, so no row repeats
    // either name and the identity line keeps its first position for what varies.
    expect(await b.view.findByRole('heading', { name: /^Beta/ })).toBeTruthy()
    expect(b.view.getByRole('heading', { name: /#engineering/ })).toBeTruthy()
    const row = await b.view.findByRole('button', { name: /Decision needed on the rollout/ })
    expect(row.textContent).toContain('Task #1')
    expect(row.textContent).toContain('Decision needed on the rollout')
    // Every row leads with the person its instant came from, and the row that
    // named the reader closes its identity line with the queue's own quantity:
    // the mention split behind that count is not a second visible count, it
    // rides the capsule's name, which the control's accessible name inherits.
    expect(actorOf(row)?.getAttribute('aria-label')).toBe('最新来自 @iris')
    const capsule = capsuleOf(row)!
    expect(capsule.textContent).toBe('1')
    expect(capsule.getAttribute('aria-label')).toBe('1 条未读，其中 1 条提及')
    expect(capsule.getAttribute('title')).toBe('1 条未读，其中 1 条提及')
    expect(row.textContent).not.toContain('提及')
    expect(row.textContent).not.toContain('@1')
    expect(b.view.container.querySelector('[data-team-inbox] time')?.getAttribute('dateTime')).toBe('2026-09-13T04:00:00.000Z')
    expect(b.view.queryByText('收件箱是空的')).toBeNull()
    // The queue carries the same header band as Channel and Thread: its name
    // plus what the queue currently holds, as segments the reader scans rather
    // than a clause to parse.
    expect(b.view.getByRole('heading', { name: '收件箱' })).toBeTruthy()
    expect(b.view.getByText('1 个 Thread')).toBeTruthy()
    expect(b.view.getByText('1 条未读')).toBeTruthy()
    expect(b.view.getByText('1 条提及')).toBeTruthy()
    await waitFor(() => expect(card.getAttribute('aria-current')).toBe('page'))
    await b.runtime.dispose()
  })

  it('drops the header count line while the queue is empty', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    fireEvent.click(await b.view.findByRole('button', { name: '收件箱' }))
    expect(await b.view.findByText('收件箱是空的')).toBeTruthy()
    expect(b.view.getByRole('heading', { name: '收件箱' })).toBeTruthy()
    expect(b.view.queryByText(/条未读/)).toBeNull()
    expect(b.view.queryByText(/个 Thread/)).toBeNull()
    await b.runtime.dispose()
  })

  it("draws the reader's own picture and name where a row names the Human", async () => {
    // The Host projects the row's actor, and for the Human that projection can
    // only ever carry the durable id: the Agent roster it resolves handles from
    // does not hold them. The Client's identity projection is what every other
    // seat draws the Human from, so the row reads it too — the same face the
    // timeline shows, and the profile's own initial when those bytes fail.
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', humanProfile: { name: 'Ada', avatarRef: 'avatar:1' } })
    const card = await b.view.findByRole('button', { name: '收件箱' })
    const rows = [inboxRow('w1', 'thread:human', { newestActor: { memberId: 'member:human', name: 'member:human' } })]
    b.seedInbox(rows)
    b.seedInbox(rows)
    await waitForEntryUnread(card, 1)
    fireEvent.click(card)
    const row = await b.view.findByRole('button', { name: /Decision needed on the rollout/ })
    const actor = actorOf(row)!
    expect(actor.getAttribute('aria-label')).toBe('最新来自 @Ada')
    const image = await waitFor(() => {
      const node = actor.querySelector('img')
      if (node === null) throw new Error('row avatar image not mounted')
      return node
    })
    expect(image.getAttribute('src')).toBe('data:image/png;base64,AAAA')
    expect(b.getHumanAvatar).toHaveBeenCalledWith({ avatarRef: 'avatar:1' })
    fireEvent.error(image)
    await waitFor(() => { expect(actor.textContent).toBe('A') })
    expect(actor.querySelector('img')).toBeNull()
    await b.runtime.dispose()
  })

  it('marks the Thread that named the reader with the shared capsule, and one that merely moved with a hairline', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    const card = await b.view.findByRole('button', { name: '收件箱' })
    const rows = [
      inboxRow('w1', 'thread:named', { previewText: 'named row' }),
      inboxRow('w1', 'thread:ambient', { channelName: 'delivery', previewText: 'ambient row', taskNumber: undefined, directCount: 0, unreadCount: 4, newestSequence: 12 }),
      inboxRow('w1', 'thread:capped', { channelName: 'general', previewText: 'capped row', taskNumber: undefined, directCount: 3, unreadCount: 150, newestSequence: 13 }),
    ]
    b.seedInbox(rows)
    b.seedInbox(rows)
    await waitFor(() => expect(card.getAttribute('aria-label')).toBe('收件箱，155 条未读'))
    fireEvent.click(card)
    const named = await b.view.findByRole('button', { name: /named row/ })
    const ambient = await b.view.findByRole('button', { name: /ambient row/ })
    const capped = await b.view.findByRole('button', { name: /capped row/ })
    // The ink is the whole difference: the row that names the reader wears the
    // solid fill the sidebar's unread dot and the Channel entry's count both
    // speak, and the row that merely moved keeps a hairline in the same geometry.
    expect(named.hasAttribute('data-named')).toBe(true)
    expect(ambient.hasAttribute('data-named')).toBe(false)
    expect(capsuleOf(named)?.getAttribute('aria-label')).toBe('1 条未读，其中 1 条提及')
    expect(capsuleOf(ambient)?.getAttribute('aria-label')).toBe('4 条未读')
    expect(ambient.textContent).not.toContain('提及')
    // A queue's counts are unbounded; the capsule is not.
    expect(capsuleOf(capped)?.textContent).toBe('99+')
    expect(capsuleOf(capped)?.getAttribute('aria-label')).toBe('150 条未读，其中 3 条提及')
    // The header counts the whole slice and drops the mention segment when the
    // queue holds no mention at all.
    expect(b.view.getByText('3 个 Thread')).toBeTruthy()
    expect(b.view.getByText('155 条未读')).toBeTruthy()
    expect(b.view.getByText('4 条提及')).toBeTruthy()
    await b.runtime.dispose()
  })

  it('leads a row with the Task\'s live owners in the Channel feed\'s own words, and with its newest actor when there are none', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    const card = await b.view.findByRole('button', { name: '收件箱' })
    const rows = [
      inboxRow('w1', 'thread:owned', { previewText: 'owner stack row', claimOwners: [
        { memberId: 'member:reviewer', name: 'reviewer' },
        { memberId: 'member:builder', name: 'builder' },
      ] }),
      inboxRow('w1', 'thread:taskless', { channelName: 'delivery', previewText: 'taskless row', task: undefined, taskNumber: undefined }),
      // The tail answers 「谁在这个 Task 上」 exactly as the queue does: which cluster
      // a row leads with is the Thread's own fact, never the section's, or a
      // Thread would change shape on its way from the queue into the tail.
      inboxRow('w1', 'thread:read', { channelName: 'general', previewText: 'read tail row', directCount: 0, unreadCount: 0, newestSequence: 2,
        claimOwners: [{ memberId: 'member:vera', name: 'vera' }] }),
    ]
    b.seedInbox(rows)
    b.seedInbox(rows)
    await waitForEntryUnread(card, 2)
    fireEvent.click(card)
    // One language for 「谁在这个 Task 上」 across both surfaces: the same stack, the
    // same rule, and the same words the Channel feed's Thread entry row uses.
    const owned = await b.view.findByRole('button', { name: /owner stack row/ })
    expect(owned.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('由 @reviewer, @builder 处理')
    expect(owned.querySelectorAll('[role="img"] > span')).toHaveLength(2)
    // A Thread nobody has claimed has no roster to lead with, so the row falls
    // back to the one person it can always name: whoever moved it last.
    const taskless = b.view.getByRole('button', { name: /taskless row/ })
    expect(taskless.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('最新来自 @iris')
    const tail = b.view.getByRole('button', { name: /read tail row/ })
    expect(tail.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('由 @vera 处理')
    await b.runtime.dispose()
  })

  it('drops the mention segment from the header when no row names the reader', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    const card = await b.view.findByRole('button', { name: '收件箱' })
    const rows = [inboxRow('w1', 'thread:ambient', { directCount: 0, unreadCount: 2 })]
    b.seedInbox(rows)
    b.seedInbox(rows)
    await waitForEntryUnread(card, 2)
    fireEvent.click(card)
    expect(await b.view.findByText('1 个 Thread')).toBeTruthy()
    expect(b.view.getByText('2 条未读')).toBeTruthy()
    expect(b.view.queryByText(/条提及/)).toBeNull()
    await b.runtime.dispose()
  })

  it('renders the unread queue and the recently-active tail as two sections, and a read row carries no count', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    const card = await b.view.findByRole('button', { name: '收件箱' })
    const rows = [
      inboxRow('w1', 'thread:open', { previewText: 'still waiting' }),
      // Nothing unread can only come from the tail: the Host admitted this row
      // for participation, so the page renders a Thread rather than a quantity.
      inboxRow('w1', 'thread:read', { channelName: 'delivery', previewText: 'already handled', taskNumber: undefined, directCount: 0, unreadCount: 0, newestSequence: 3 }),
    ]
    b.seedInbox(rows)
    b.seedInbox(rows)
    await waitForEntryUnread(card, 1)
    fireEvent.click(card)
    expect(await b.view.findByText('需要我')).toBeTruthy()
    expect(b.view.getByText('最近活跃')).toBeTruthy()
    // Each heading carries its own section's count, so a reader never counts
    // rows to find out how much a section holds — and the capped tail says how
    // much of itself is on screen.
    expect(b.view.getByText('需要我').textContent).toBe('需要我1')
    expect(b.view.getByText('最近活跃').textContent).toBe('最近活跃1')
    const open = b.view.getByRole('button', { name: /still waiting/ })
    expect(capsuleOf(open)?.textContent).toBe('1')
    // Zero is the absence of a badge, not a badge reading zero — the rule the
    // Channel feed's own Thread entry already follows. The row still names who
    // moved it: the leading circle is what every row has, the count is not.
    const read = b.view.getByRole('button', { name: /already handled/ })
    expect(capsuleOf(read)).toBeNull()
    expect(actorOf(read)?.getAttribute('aria-label')).toBe('最新来自 @iris')
    // The header counts the queue; the tail is a way back in, not work waiting.
    expect(b.view.getByText('1 个 Thread')).toBeTruthy()
    expect(b.view.getByText('1 条未读')).toBeTruthy()
    await b.runtime.dispose()
  })

  it('keeps the tail at five rows across Workspaces', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    fireEvent.click(await b.view.findByRole('button', { name: '收件箱' }))
    const tailRows = (workspaceId: string, prefix: string) => Array.from({ length: 6 }, (_, index) =>
      inboxRow(workspaceId, `thread:${prefix}${index}`, { channelName: prefix, previewText: `${prefix} ${index}`, taskNumber: undefined, directCount: 0, unreadCount: 0,
        newestSequence: index + 1, newestOccurredAt: `2026-09-13T0${index}:00:00.000Z` }))
    const rows = [...tailRows('w1', 'a'), ...tailRows('w2', 'b')]
    b.seedInbox(rows)
    b.seedInbox(rows)
    const section = await waitFor(() => {
      const heading = b.view.getByText('最近活跃').closest('section')
      expect(heading).toBeTruthy()
      return heading as HTMLElement
    })
    // The tail is a way back into work rather than a second queue: five rows is
    // the whole of it, however many Workspaces are feeding it.
    expect(within(section).getAllByRole('button')).toHaveLength(5)
    await b.runtime.dispose()
  })

  it('partitions the queue by Workspace and then by Channel, never merging the rows flat', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    const card = await b.view.findByRole('button', { name: '收件箱' })
    const rows = [
      inboxRow('w1', 'thread:a', { previewText: 'alpha engineering' }),
      inboxRow('w1', 'thread:b', { channelRef: 'channel:delivery', channelName: 'delivery', previewText: 'alpha delivery' }),
      inboxRow('w2', 'thread:c', { previewText: 'beta engineering' }),
      inboxRow('w2', 'thread:d', { channelRef: 'channel:delivery', channelName: 'delivery', previewText: 'beta delivery' }),
    ]
    b.seedInbox(rows)
    b.seedInbox(rows)
    await waitForEntryUnread(card, 4)
    fireEvent.click(card)
    const page = await waitFor(() => {
      const surface = b.view.container.querySelector('[data-team-inbox]')
      expect(surface).toBeTruthy()
      return surface as HTMLElement
    })
    const groups = [...page.querySelectorAll<HTMLElement>('[data-team-inbox-group]')]
    // One group per Workspace, in the visible roster's own order, each naming the
    // Workspace once and its Channels under it — so a Thread always lands under
    // the same two names instead of the reader reading them off the row.
    expect(groups.map(group => group.querySelector('h3')!.textContent)).toEqual(['Alpha2', 'Beta2'])
    expect([...groups[0]!.querySelectorAll('h4')].map(heading => heading.textContent)).toEqual(['#delivery1', '#engineering1'])
    expect([...groups[1]!.querySelectorAll('h4')].map(heading => heading.textContent)).toEqual(['#delivery1', '#engineering1'])
    // Every row stays inside its own group: the previews read in group order, and
    // a Beta row is never interleaved among Alpha's.
    expect([...page.querySelectorAll('[class*="rowPreview"]')].map(node => node.textContent))
      .toEqual(['alpha delivery', 'alpha engineering', 'beta delivery', 'beta engineering'])
    await b.runtime.dispose()
  })

  it('clears the queue with 「全部已读」, reading each row that holds unread through once', async () => {
    // The seed gives the bench a Thread for every read to land on: a read whose
    // Thread the bench cannot resolve is refused, and the sweep would stop on it.
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', seededMessages: [{ body: 'Thread opener', occurredAt: '2026-09-13T04:00:00.000Z' }] })
    const card = await b.view.findByRole('button', { name: '收件箱' })
    b.seedInbox([inboxRow('w1', 'thread:a', { previewText: 'alpha' }), inboxRow('w1', 'thread:b', { previewText: 'beta' })])
    b.seedInbox([inboxRow('w1', 'thread:a', { previewText: 'alpha' }), inboxRow('w1', 'thread:b', { previewText: 'beta' })])
    await waitForEntryUnread(card, 2)
    fireEvent.click(card)
    const page = await waitFor(() => {
      const surface = b.view.container.querySelector('[data-team-inbox]')
      expect(surface).toBeTruthy()
      return surface as HTMLElement
    })
    const markAll = within(page).getByRole('button', { name: '全部已读' }) as HTMLButtonElement
    // The page-wide action reads the same fact the rows do, so a queue holding
    // unread can be cleared in one go instead of Thread by Thread.
    expect(markAll.disabled).toBe(false)
    fireEvent.click(markAll)
    await waitFor(() => expect(b.readThread).toHaveBeenCalledTimes(2))
    expect(b.readThread).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'w1', threadRef: 'thread:a' }))
    expect(b.readThread).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'w1', threadRef: 'thread:b' }))
    // A queue is what holds unread, so the drain empties it: the entry's own
    // count follows the completed reads down, and the page, which now holds no
    // unread row, has nothing left for the action to do.
    await waitForEntryUnread(card, 0)
    await waitFor(() => expect((within(page).getByRole('button', { name: '全部已读' }) as HTMLButtonElement).disabled).toBe(true))
    expect(page.textContent).toContain('收件箱是空的')
    await b.runtime.dispose()
  })

  it('shows the empty state while nothing needs the Human', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    fireEvent.click(await b.view.findByRole('button', { name: '收件箱' }))
    expect(await b.view.findByText('收件箱是空的')).toBeTruthy()
    expect(b.view.getByText('你参与的 Thread 有新活动、或有人提到你时，会出现在这里')).toBeTruthy()
    await b.runtime.dispose()
  })

  it('opens the row Thread through selectWorkspace + selectThread, drops the unread dot, and lands Back on the Inbox list', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', seededMessages: [{ body: 'Thread opener', occurredAt: '2026-09-13T03:00:00.000Z' }], remainingUnreadCounts: [0], initialChannels: true, seedThreadRef: 'thread:w2' })
    const card = await b.view.findByRole('button', { name: '收件箱' })
    b.seedInbox([inboxRow('w2', 'thread:w2')])
    b.seedInbox([inboxRow('w2', 'thread:w2')])
    await waitForEntryUnread(card, 1)
    fireEvent.click(card)
    const row = await b.view.findByRole('button', { name: /Decision needed on the rollout/ })
    fireEvent.click(row)
    // The row's own Workspace is selected first, then the Thread: the durable
    // read consumes the mention, and the persisted location keeps the Thread
    // and its Channel plus the Inbox origin it was entered from.
    await waitFor(() => expect(b.readThread).toHaveBeenCalled())
    // The dot drops from the completed read itself — reads never ride a
    // changes wake.
    await waitForEntryUnread(card, 0)
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '')).toMatchObject({ mode: 'team', workspaceId: 'w2', channelRef: 'channel:engineering', threadRef: 'thread:w2', threadOrigin: 'inbox' })
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '')).not.toHaveProperty('inbox')
    // Back goes to the Inbox list this Thread was entered from.
    fireEvent.click(await b.view.findByRole('button', { name: '返回收件箱列表' }))
    await waitFor(() => expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '')).toMatchObject({ mode: 'team', workspaceId: 'w2', inbox: true }))
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '')).not.toHaveProperty('threadRef')
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '')).not.toHaveProperty('threadOrigin')
    await b.view.findByText('收件箱是空的')
    expect(b.view.container.querySelector('[data-team-inbox]')).toBeTruthy()
    await b.runtime.dispose()
  })

  it('orders the narrow rail Inbox → Tasks → Channels → Agents with the unread dot on the Inbox icon', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    // Collapse the fixture sidebar to the narrow rail.
    fireEvent.click(b.view.container.querySelector('[data-test-control]')!)
    const rail = await waitFor(() => {
      const nav = b.view.container.querySelector('nav[class*="railWorkspace"]')
      expect(nav).toBeTruthy()
      return nav as HTMLElement
    })
    const labels = [...rail.querySelectorAll('button')].map(button => button.getAttribute('aria-label'))
    expect(labels).toEqual(['收件箱', '任务', '频道', 'Agents'])
    b.seedInbox([inboxRow('w1', 'thread:w1')])
    b.seedInbox([inboxRow('w1', 'thread:w1')])
    const inboxButton = within(rail).getByRole('button', { name: '收件箱' })
    await waitForEntryUnread(inboxButton, 1)
    // The rail icon is a destination: clicking it opens the Inbox page and
    // asks the shell to expand the sidebar again.
    fireEvent.click(inboxButton)
    await waitFor(() => expect(b.view.container.querySelector('[data-team-inbox]')).toBeTruthy())
    await b.runtime.dispose()
  })

  it('reads the whole unread slice — no mention-only flag — for the dot and the Inbox page', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    const card = await b.view.findByRole('button', { name: '收件箱' })
    b.seedInbox([inboxRow('w1', 'thread:w1')])
    b.seedInbox([inboxRow('w1', 'thread:w1')])
    await waitForEntryUnread(card, 1)
    fireEvent.click(card)
    await waitFor(() => expect(b.view.getByRole('button', { name: /Decision needed on the rollout/ })).toBeTruthy())
    // The Host projects one unread slice now; a caller that still narrowed the
    // call to mentions would fail here, and so would the dot, which counts
    // every unread fact the slice reports.
    expect(b.inbox.mock.calls.length).toBeGreaterThan(0)
    for (const [request] of b.inbox.mock.calls) expect((request as { directOnly?: boolean }).directOnly).toBeUndefined()
    // The fan-out still covers every visible Workspace: the dot reads one
    // slice per Workspace and merges the totals.
    expect(new Set(b.inbox.mock.calls.map(([request]) => request.workspaceId))).toEqual(new Set(['w1', 'w2']))
    await b.runtime.dispose()
  })

  it("keeps the Host's own admission order inside a group while each Workspace stays its own group", async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    const card = await b.view.findByRole('button', { name: '收件箱' })
    // Every row carries the same clocks, so the reader's own key ties and the
    // Host's keys decide: the mentioned row leads the merely newer one, and the
    // two Workspaces stay separate groups rather than one merged list.
    const rows = [
      inboxRow('w1', 'thread:w1-old', { previewText: 'mentioned', directCount: 2, newestSequence: 3 }),
      inboxRow('w1', 'thread:w1-mid', { previewText: 'middle', directCount: 0, newestSequence: 9 }),
      inboxRow('w2', 'thread:w2-new', { previewText: 'newest', directCount: 0, newestSequence: 40 }),
    ]
    b.seedInbox(rows)
    b.seedInbox(rows)
    await waitForEntryUnread(card, 3)
    fireEvent.click(card)
    await waitFor(() => expect(b.view.container.querySelectorAll('[data-team-inbox] button[class*="row"]').length).toBe(3))
    const previews = [...b.view.container.querySelectorAll('[data-team-inbox] button[class*="row"] [class*="rowPreview"]')].map(node => node.textContent)
    // Group order leads: Alpha's two rows in the Host's own order, then Beta's.
    expect(previews).toEqual(['mentioned', 'middle', 'newest'])
    await b.runtime.dispose()
  })

  it('names today and yesterday on a row and dates older mentions', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    const card = await b.view.findByRole('button', { name: '收件箱' })
    const today = new Date()
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1, 14, 5)
    const older = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6, 9, 30)
    b.seedInbox([
      inboxRow('w1', 'thread:w1-today', { previewText: 'today row', newestSequence: 3, newestOccurredAt: today.toISOString() }),
      inboxRow('w1', 'thread:w1-yesterday', { previewText: 'yesterday row', newestSequence: 4, newestOccurredAt: yesterday.toISOString() }),
      inboxRow('w1', 'thread:w1-older', { previewText: 'older row', newestSequence: 5, newestOccurredAt: older.toISOString() }),
    ])
    b.seedInbox([
      inboxRow('w1', 'thread:w1-today', { previewText: 'today row', newestSequence: 3, newestOccurredAt: today.toISOString() }),
      inboxRow('w1', 'thread:w1-yesterday', { previewText: 'yesterday row', newestSequence: 4, newestOccurredAt: yesterday.toISOString() }),
      inboxRow('w1', 'thread:w1-older', { previewText: 'older row', newestSequence: 5, newestOccurredAt: older.toISOString() }),
    ])
    await waitForEntryUnread(card, 3)
    fireEvent.click(card)
    const rowFor = async (preview: string): Promise<HTMLElement> => await b.view.findByRole('button', { name: new RegExp(preview) })
    const clock = (date: Date): string => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
    expect((await rowFor('today row')).querySelector('time')?.textContent).toBe(clock(today))
    expect((await rowFor('yesterday row')).querySelector('time')?.textContent).toBe(`昨天 ${clock(yesterday)}`)
    const olderTime = (await rowFor('older row')).querySelector('time')
    expect(olderTime?.textContent).toMatch(/^\d{2}-\d{2} 09:30$/)
    // The precise instant stays on the element behind the relative label.
    expect(olderTime?.getAttribute('title')).toMatch(/^\d{4}-\d{2}-\d{2} 09:30$/)
    expect(olderTime?.getAttribute('dateTime')).toBe(older.toISOString())
    await b.runtime.dispose()
  })

  it('draws the row clocks — created, newest reply with its author — and the decision chip only when the Thread waits', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    const card = await b.view.findByRole('button', { name: '收件箱' })
    b.seedInbox([
      inboxRow('w1', 'thread:meta-waiting', { previewText: 'waiting row' }),
      inboxRow('w1', 'thread:meta-quiet', { previewText: 'quiet row', needsHumanDecision: false }),
      inboxRow('w1', 'thread:meta-unanswered', { previewText: 'no reply yet', needsHumanDecision: false, latestReplyOccurredAt: undefined, latestReplyActor: undefined }),
    ])
    fireEvent.click(card)
    const metaRow = await b.view.findByRole('button', { name: /waiting row/ })
    expect(metaRow.textContent).toContain('创建于')
    expect(metaRow.textContent).toContain('@iris 回复于')
    expect(metaRow.textContent).toContain('待你决策')
    // A Thread that waits on nobody prints no chip, and one without a reply
    // prints no reply segment — zero is the absence of the mark.
    const quietRow = await b.view.findByRole('button', { name: /quiet row/ })
    expect(quietRow.textContent).not.toContain('待你决策')
    const unanswered = await b.view.findByRole('button', { name: /no reply yet/ })
    expect(unanswered.textContent).not.toContain('回复于')
    expect(unanswered.textContent).toContain('创建于')
    await b.runtime.dispose()
  })

  it("leads the queue by newest reply and re-lays it under the reader's own key, kept in this browser", async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    const card = await b.view.findByRole('button', { name: '收件箱' })
    b.seedInbox([
      inboxRow('w1', 'thread:sort-created', { previewText: 'created newest', directCount: 0, newestSequence: 30, createdOccurredAt: '2026-09-14T02:00:00.000Z', latestReplyOccurredAt: '2026-09-10T02:00:00.000Z' }),
      inboxRow('w1', 'thread:sort-reply', { previewText: 'reply newest', directCount: 0, newestSequence: 20, createdOccurredAt: '2026-09-01T02:00:00.000Z', latestReplyOccurredAt: '2026-09-15T02:00:00.000Z' }),
    ])
    fireEvent.click(card)
    const previews = async (): Promise<readonly (string | null | undefined)[]> => {
      await waitFor(() => expect(b.view.container.querySelectorAll('[data-team-inbox] button[class*="row"]')).toHaveLength(2))
      return [...b.view.container.querySelectorAll('[data-team-inbox] button[class*="row"] [class*="rowPreview"]')].map(node => node.textContent)
    }
    // Default: the newest reply leads, even though the other row is the newer
    // Thread and carries the higher ledger sequence.
    expect(await previews()).toEqual(['reply newest', 'created newest'])
    const sort = b.view.getByLabelText('排序') as HTMLSelectElement
    expect(sort.value).toBe('latestReply')
    fireEvent.change(sort, { target: { value: 'created' } })
    expect(await previews()).toEqual(['created newest', 'reply newest'])
    // The taste rides this browser's storage, and a returning reader gets it
    // back without touching the control again.
    expect(localStorage.getItem('dsh.agent-team.inbox-sort')).toBe('created')
    fireEvent.click(b.view.getByRole('button', { name: '任务' }))
    fireEvent.click(b.view.getByRole('button', { name: '收件箱' }))
    expect(((await b.view.findByLabelText('排序')) as HTMLSelectElement).value).toBe('created')
    expect(await previews()).toEqual(['created newest', 'reply newest'])
    await b.runtime.dispose()
  })
})
