import { beforeEach, describe, expect, it, vi } from 'vitest'
import { STORAGE_KEY, TeamNavigation } from '../src/client/navigation.ts'

function storage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => { values.clear() },
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(key) },
    setItem: (key, value) => { values.set(key, value) },
  }
}

describe('TeamNavigation', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', storage())
  })

  it('enters and leaves Team mode while preserving the selected Workspace', () => {
    const navigation = new TeamNavigation()
    const changes: string[] = []
    const off = navigation.subscribe(() => { changes.push(navigation.getSnapshot().mode) })

    navigation.actions().selectWorkspace('workspace:one' as never)
    navigation.actions().enterTeam()
    navigation.actions().leaveTeam()

    expect(navigation.getSnapshot()).toEqual({ mode: 'conversation', workspaceId: 'workspace:one' })
    expect(changes).toEqual(['conversation', 'team', 'conversation'])
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '')).toEqual({
      mode: 'conversation', workspaceId: 'workspace:one',
    })
    off()
  })

  it('rehydrates the last Team location while ignoring unknown persisted fields', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      mode: 'team', workspaceId: 'workspace:old', channelRef: 'channel:old',
      taskRef: 'task:old', threadRef: 'thread:old', taskNumber: 7, activeTab: 'inbox',
    }))
    const navigation = new TeamNavigation()
    expect(navigation.getSnapshot()).toEqual({
      mode: 'team', workspaceId: 'workspace:old', channelRef: 'channel:old',
      taskRef: 'task:old', threadRef: 'thread:old', taskNumber: 7,
    })

    navigation.actions().selectWorkspace('workspace:existing' as never)
    expect(navigation.getSnapshot()).toEqual({ mode: 'team', workspaceId: 'workspace:existing' })
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '')).toEqual({ mode: 'team', workspaceId: 'workspace:existing' })
  })

  it('persists Channel and Thread location across a new navigation instance', () => {
    const navigation = new TeamNavigation()
    navigation.actions().selectWorkspace('workspace:one' as never)
    navigation.actions().enterTeam()
    navigation.actions().selectThread('thread:1' as never, 'channel:1' as never, 'task:1' as never, 7)

    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '')).toEqual({
      mode: 'team', workspaceId: 'workspace:one', channelRef: 'channel:1',
      taskRef: 'task:1', threadRef: 'thread:1', taskNumber: 7,
    })
    expect(new TeamNavigation().getSnapshot()).toEqual({
      mode: 'team', workspaceId: 'workspace:one', channelRef: 'channel:1',
      taskRef: 'task:1', threadRef: 'thread:1', taskNumber: 7,
    })
  })

  it('persists a taskless Thread with threadRef as the stable key', () => {
    const navigation = new TeamNavigation()
    navigation.actions().selectWorkspace('workspace:one' as never)
    navigation.actions().enterTeam()
    navigation.actions().selectThread('thread:plain' as never, 'channel:1' as never)

    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '')).toEqual({
      mode: 'team', workspaceId: 'workspace:one', channelRef: 'channel:1',
      threadRef: 'thread:plain',
    })
    expect(new TeamNavigation().getSnapshot()).toEqual({
      mode: 'team', workspaceId: 'workspace:one', channelRef: 'channel:1',
      threadRef: 'thread:plain',
    })
  })

  it('ignores malformed and incomplete persisted state', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      mode: 'team', workspaceId: 'workspace:one', channelRef: 'channel:1',
      threadRef: 'thread:plain',
    }))
    expect(new TeamNavigation().getSnapshot()).toEqual({
      mode: 'team', workspaceId: 'workspace:one', channelRef: 'channel:1',
      threadRef: 'thread:plain',
    })

    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      mode: 'team', workspaceId: 'workspace:one', channelRef: 'channel:1',
      taskRef: 'task:orphaned', taskNumber: 7,
    }))
    expect(new TeamNavigation().getSnapshot()).toEqual({
      mode: 'team', workspaceId: 'workspace:one', channelRef: 'channel:1',
    })

    localStorage.setItem(STORAGE_KEY, '{broken')
    expect(new TeamNavigation().getSnapshot()).toEqual({ mode: 'conversation' })
  })

  it('overlays a runtime-only Member Session without losing the Team location', () => {
    const navigation = new TeamNavigation()
    navigation.actions().selectWorkspace('workspace:one' as never)
    navigation.actions().enterTeam()
    navigation.actions().selectThread('thread:1' as never, 'channel:1' as never, 'task:1' as never, 7)
    navigation.actions().enterMemberSession('session:builder' as never, 'session:return' as never)

    expect(navigation.getSnapshot()).toEqual({
      mode: 'team', workspaceId: 'workspace:one', channelRef: 'channel:1',
      taskRef: 'task:1', threadRef: 'thread:1', taskNumber: 7,
      memberSessionId: 'session:builder', returnToSessionId: 'session:return',
    })
    // Only the Member overlay is runtime state; a reload restores the Team location below it.
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '')).toEqual({
      mode: 'team', workspaceId: 'workspace:one', channelRef: 'channel:1',
      taskRef: 'task:1', threadRef: 'thread:1', taskNumber: 7,
    })
    expect(new TeamNavigation().getSnapshot()).toEqual({
      mode: 'team', workspaceId: 'workspace:one', channelRef: 'channel:1',
      taskRef: 'task:1', threadRef: 'thread:1', taskNumber: 7,
    })
  })

  it('keeps the original return target when another Member is selected', () => {
    const navigation = new TeamNavigation()
    navigation.actions().enterTeam()
    navigation.actions().enterMemberSession('session:builder' as never, 'session:return' as never)
    // While the Member view is open the shell current session is the Member's
    // own, so re-entering without a fresh target must not steal the return.
    navigation.actions().enterMemberSession('session:reviewer' as never)

    expect(navigation.getSnapshot()).toEqual({
      mode: 'team', memberSessionId: 'session:reviewer', returnToSessionId: 'session:return',
    })
  })

  it('closes the Member view on any explicit Team navigation or the exit action', () => {
    const reopen = (navigation: TeamNavigation): void => {
      navigation.actions().enterTeam()
      navigation.actions().enterMemberSession('session:builder' as never, 'session:return' as never)
    }
    const steps: Array<(navigation: TeamNavigation) => void> = [
      navigation => { navigation.actions().selectWorkspace('workspace:two' as never) },
      navigation => { navigation.actions().selectChannel('channel:2' as never) },
      navigation => { navigation.actions().selectThread('thread:9' as never) },
      // The Inbox entry is Team navigation too, and the one face an Agent
      // overlay can be opened from: asking for the page closes the overlay.
      navigation => { navigation.actions().selectInbox() },
      navigation => { navigation.actions().selectDecisions() },
      navigation => { navigation.actions().backToChannels() },
      navigation => { navigation.actions().backFromThread() },
      navigation => { navigation.actions().enterTeam() },
      navigation => { navigation.actions().exitMemberSession() },
    ]
    for (const step of steps) {
      const navigation = new TeamNavigation()
      reopen(navigation)
      step(navigation)
      const snapshot = navigation.getSnapshot()
      expect(snapshot.memberSessionId).toBeUndefined()
      expect(snapshot.returnToSessionId).toBeUndefined()
      expect(snapshot.mode).toBe('team')
    }
  })

  it('opens the Inbox page as a durable location and returns a Thread entered there', () => {
    const navigation = new TeamNavigation()
    navigation.actions().selectWorkspace('workspace:one' as never)
    navigation.actions().enterTeam()
    navigation.actions().selectInbox()
    expect(navigation.getSnapshot()).toEqual({ mode: 'team', workspaceId: 'workspace:one', inbox: true })
    // The Inbox position is a navigation fact, not an unread fact: a reload reopens the page.
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '')).toEqual({ mode: 'team', workspaceId: 'workspace:one', inbox: true })
    expect(new TeamNavigation().getSnapshot()).toEqual({ mode: 'team', workspaceId: 'workspace:one', inbox: true })
    // Re-selecting the open page spams nobody.
    navigation.actions().selectInbox()
    expect(navigation.getSnapshot()).toEqual({ mode: 'team', workspaceId: 'workspace:one', inbox: true })

    // Selecting a Thread from an Inbox row clears the Inbox face while the row's
    // list stays the Thread's origin: Back returns to the Inbox list.
    navigation.actions().selectThread('thread:1' as never, 'channel:1' as never, undefined, undefined, 'inbox')
    expect(navigation.getSnapshot()).toEqual({ mode: 'team', workspaceId: 'workspace:one', channelRef: 'channel:1', threadRef: 'thread:1', threadOrigin: 'inbox' })
    navigation.actions().backFromThread()
    expect(navigation.getSnapshot()).toEqual({ mode: 'team', workspaceId: 'workspace:one', inbox: true })

    // A Thread entered from its Channel carries no origin, so Back lands on the
    // Channel timeline as before.
    navigation.actions().selectChannel('channel:1' as never)
    navigation.actions().selectThread('thread:2' as never, 'channel:1' as never)
    expect(navigation.getSnapshot()).toEqual({ mode: 'team', workspaceId: 'workspace:one', channelRef: 'channel:1', threadRef: 'thread:2' })
    navigation.actions().backFromThread()
    expect(navigation.getSnapshot()).toEqual({ mode: 'team', workspaceId: 'workspace:one', channelRef: 'channel:1' })

    // A Channel or Workspace selection leaves the Inbox face as well.
    navigation.actions().selectInbox()
    navigation.actions().selectChannel('channel:2' as never)
    expect(navigation.getSnapshot().inbox).toBeUndefined()
    navigation.actions().selectInbox()
    navigation.actions().selectWorkspace('workspace:two' as never)
    expect(navigation.getSnapshot()).toEqual({ mode: 'team', workspaceId: 'workspace:two' })
  })

  it('opens the decision queue as a durable location and returns a Thread entered there', () => {
    const navigation = new TeamNavigation()
    navigation.actions().selectWorkspace('workspace:one' as never)
    navigation.actions().enterTeam()
    navigation.actions().selectDecisions()
    expect(navigation.getSnapshot()).toEqual({ mode: 'team', workspaceId: 'workspace:one', decisions: true })
    // Where the reader stands is a navigation fact, not a waiting count: a
    // reload reopens the queue it was left on.
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '')).toEqual({ mode: 'team', workspaceId: 'workspace:one', decisions: true })
    expect(new TeamNavigation().getSnapshot()).toEqual({ mode: 'team', workspaceId: 'workspace:one', decisions: true })
    navigation.actions().selectDecisions()
    expect(navigation.getSnapshot()).toEqual({ mode: 'team', workspaceId: 'workspace:one', decisions: true })

    // A row's Thread keeps the queue as its origin, so Back returns to the
    // queue rather than to the Channel behind it.
    navigation.actions().selectThread('thread:1' as never, 'channel:1' as never, undefined, undefined, 'decisions')
    expect(navigation.getSnapshot()).toEqual({ mode: 'team', workspaceId: 'workspace:one', channelRef: 'channel:1', threadRef: 'thread:1', threadOrigin: 'decisions' })
    navigation.actions().backFromThread()
    expect(navigation.getSnapshot()).toEqual({ mode: 'team', workspaceId: 'workspace:one', decisions: true })

    // Any other face takes the seat back.
    navigation.actions().selectInbox()
    expect(navigation.getSnapshot()).toEqual({ mode: 'team', workspaceId: 'workspace:one', inbox: true })
    navigation.actions().selectDecisions()
    navigation.actions().selectChannel('channel:1' as never)
    expect(navigation.getSnapshot()).toEqual({ mode: 'team', workspaceId: 'workspace:one', channelRef: 'channel:1' })
  })

  it('restores the Thread origin across a reload and lets a Tasks origin own Back', () => {
    const navigation = new TeamNavigation()
    navigation.actions().selectWorkspace('workspace:one' as never)
    navigation.actions().enterTeam()
    navigation.actions().selectThread('thread:5' as never, 'channel:1' as never, 'task:5' as never, 5, 'tasks')

    expect(navigation.getSnapshot()).toEqual({ mode: 'team', workspaceId: 'workspace:one', channelRef: 'channel:1', taskRef: 'task:5', threadRef: 'thread:5', taskNumber: 5, threadOrigin: 'tasks' })
    // The origin is durable: a reload reopens the Thread and still knows Back
    // belongs to the Tasks list.
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '')).toMatchObject({ threadOrigin: 'tasks' })
    const restored = new TeamNavigation()
    expect(restored.getSnapshot().threadOrigin).toBe('tasks')
    restored.actions().backFromThread()
    expect(restored.getSnapshot()).toEqual({ mode: 'team', workspaceId: 'workspace:one', tasks: true })
  })

  it('drops a persisted origin that has no Thread to return from', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode: 'team', workspaceId: 'workspace:one', channelRef: 'channel:1', threadOrigin: 'inbox' }))
    expect(new TeamNavigation().getSnapshot()).toEqual({ mode: 'team', workspaceId: 'workspace:one', channelRef: 'channel:1' })
  })

})
