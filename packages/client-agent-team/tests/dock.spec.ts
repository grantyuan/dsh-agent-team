// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { faceOfSnapshot, TEAM_DOCK_STORAGE_KEY, TeamDockStore } from '../src/client/dock.ts'
import { TeamNavigation, type TeamNavigationSnapshot } from '../src/client/navigation.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { AgentTeamChannelRef, AgentTeamMemberId, AgentTeamThreadRef } from '@wowyuarm/dsh-agent-team/types'

const channelA = 'channel:a' as AgentTeamChannelRef
const channelB = 'channel:b' as AgentTeamChannelRef
const thread1 = 'thread:1' as AgentTeamThreadRef
const builder = 'member:builder' as AgentTeamMemberId

afterEach(() => { localStorage.clear() })
beforeEach(() => { localStorage.clear() })

const w1 = 'w1' as WorkspaceId
const w2 = 'w2' as WorkspaceId

function teamSnapshot(patch: Partial<TeamNavigationSnapshot>): TeamNavigationSnapshot {
  return { mode: 'team', ...patch }
}

describe('TeamDockStore', () => {
  it('opens the first face into a new pane and reopens a closed dock', () => {
    const dock = new TeamDockStore()
    dock.setOpen(false)
    dock.openFace({ kind: 'inbox' })
    expect(dock.getSnapshot().open).toBe(true)
    expect(dock.getSnapshot().panes).toHaveLength(1)
    expect(dock.getSnapshot().panes[0]!.tabs.map(tab => tab.id)).toEqual(['inbox'])
    expect(dock.getSnapshot().panes[0]!.activeTabId).toBe('inbox')
  })

  it('focuses an existing background tab instead of duplicating it', () => {
    const dock = new TeamDockStore()
    dock.openFace({ kind: 'inbox' })
    dock.openFace({ kind: 'tasks' })
    dock.openFace({ kind: 'inbox' })
    const pane = dock.getSnapshot().panes[0]!
    expect(pane.tabs.map(tab => tab.id)).toEqual(['inbox', 'tasks'])
    expect(pane.activeTabId).toBe('inbox')
    expect(dock.getSnapshot().focusedPaneId).toBe(pane.id)
  })

  it('opens a new face into the focused pane', () => {
    const dock = new TeamDockStore()
    dock.openFace({ kind: 'inbox' })
    dock.openFace({ kind: 'channel', channelRef: channelA, workspaceId: w1 })
    const first = dock.getSnapshot().panes[0]!
    expect(first.tabs.map(tab => tab.id)).toEqual(['inbox', 'channel:channel:a'])
    // Split, which focuses the new pane carrying the clone; the next face
    // lands there beside it.
    dock.splitPane()
    dock.openFace({ kind: 'tasks' })
    const panes = dock.getSnapshot().panes
    expect(panes).toHaveLength(2)
    expect(panes[1]!.tabs.map(tab => tab.id)).toEqual(['channel:channel:a#2', 'tasks'])
    expect(panes[1]!.activeTabId).toBe('tasks')
  })

  it('closing the active tab activates its neighbor, and empty panes close', () => {
    const dock = new TeamDockStore()
    dock.openFace({ kind: 'inbox' })
    dock.openFace({ kind: 'tasks' })
    dock.openFace({ kind: 'messages' })
    const paneId = dock.getSnapshot().panes[0]!.id
    dock.closeTab(paneId, 'tasks')
    let pane = dock.getSnapshot().panes[0]!
    expect(pane.tabs.map(tab => tab.id)).toEqual(['inbox', 'messages'])
    expect(pane.activeTabId).toBe('messages')
    dock.closeTab(paneId, 'messages')
    dock.closeTab(paneId, 'inbox')
    expect(dock.getSnapshot().panes).toHaveLength(0)
    expect(dock.getSnapshot().open).toBe(false)
  })

  it('closing a pane keeps the other pane and clears its focus and maximize', () => {
    const dock = new TeamDockStore()
    dock.openFace({ kind: 'inbox' })
    dock.splitPane()
    const [, second] = dock.getSnapshot().panes
    dock.toggleMaximize(second!.id)
    expect(dock.getSnapshot().maximizedPaneId).toBe(second!.id)
    dock.closePane(second!.id)
    expect(dock.getSnapshot().panes).toHaveLength(1)
    expect(dock.getSnapshot().maximizedPaneId).toBeUndefined()
    expect(dock.getSnapshot().focusedPaneId).toBeUndefined()
  })

  it('splits the focused pane by cloning its active tab with a unique id', () => {
    const dock = new TeamDockStore()
    dock.openFace({ kind: 'channel', channelRef: channelA, workspaceId: w1 })
    dock.splitPane()
    const panes = dock.getSnapshot().panes
    expect(panes).toHaveLength(2)
    expect(panes[0]!.tabs).toHaveLength(1)
    expect(panes[1]!.tabs[0]!.id).toBe('channel:channel:a#2')
    expect(panes[1]!.tabs[0]!.channelRef).toBe('channel:a')
    expect(panes[0]!.size).toBe(0.5)
    expect(panes[1]!.size).toBe(0.5)
    expect(dock.getSnapshot().focusedPaneId).toBe(panes[1]!.id)
  })

  it('toggles pane maximize and clamps divider sizes', () => {
    const dock = new TeamDockStore()
    dock.openFace({ kind: 'inbox' })
    dock.splitPane()
    const [first, second] = dock.getSnapshot().panes
    dock.toggleMaximize(first!.id)
    expect(dock.getSnapshot().maximizedPaneId).toBe(first!.id)
    dock.toggleMaximize(first!.id)
    expect(dock.getSnapshot().maximizedPaneId).toBeUndefined()
    dock.setPaneSize(second!.id, 0.001)
    expect(dock.getSnapshot().panes[1]!.size).toBe(0.12)
  })

  it('identifies the snapshot face the sidebar names', () => {
    expect(faceOfSnapshot({ mode: 'conversation' })).toBeUndefined()
    expect(faceOfSnapshot(teamSnapshot({}))).toEqual({ kind: 'overview' })
    expect(faceOfSnapshot(teamSnapshot({ workspaceId: w1 }))).toEqual({ kind: 'overview', workspaceId: w1 })
    expect(faceOfSnapshot(teamSnapshot({ inbox: true }))).toEqual({ kind: 'inbox' })
    expect(faceOfSnapshot(teamSnapshot({ tasks: true }))).toEqual({ kind: 'tasks' })
    expect(faceOfSnapshot(teamSnapshot({ messages: true }))).toEqual({ kind: 'messages' })
    expect(faceOfSnapshot(teamSnapshot({ sessionHistory: builder }))).toEqual({ kind: 'sessionHistory', memberId: builder })
    expect(faceOfSnapshot(teamSnapshot({ workspaceId: w1, channelRef: channelA }))).toEqual({ kind: 'channel', channelRef: channelA, workspaceId: w1 })
    expect(faceOfSnapshot(teamSnapshot({ workspaceId: w1, channelRef: channelA, threadRef: thread1, threadOrigin: 'tasks', taskNumber: 3 })))
      .toEqual({ kind: 'thread', threadRef: thread1, workspaceId: w1, channelRef: channelA, taskNumber: 3, threadOrigin: 'tasks' })
  })

  it('persists mutations and restores them on reload', () => {
    const dock = new TeamDockStore()
    dock.setFullscreen(true)
    dock.openFace({ kind: 'thread', threadRef: thread1, workspaceId: w1, threadOrigin: 'inbox' })
    dock.splitPane()
    const stored = JSON.parse(localStorage.getItem(TEAM_DOCK_STORAGE_KEY) ?? '') as { v: number; panes: unknown[] }
    expect(stored.v).toBe(1)
    expect(stored.panes).toHaveLength(2)
    const reloaded = new TeamDockStore()
    const snapshot = reloaded.getSnapshot()
    expect(snapshot.open).toBe(true)
    expect(snapshot.fullscreen).toBe(true)
    expect(snapshot.panes[0]!.tabs[0]!.id).toBe('thread:thread:1')
    expect(snapshot.panes[0]!.tabs[0]!.threadRef).toBe('thread:1')
    expect(snapshot.panes[1]!.tabs[0]!.id).toBe('thread:thread:1#2')
  })

  it('drops malformed persisted panes and starts from an empty dock', () => {
    localStorage.setItem(TEAM_DOCK_STORAGE_KEY, JSON.stringify({
      v: 1, open: true, fullscreen: false,
      panes: [
        { id: 'pane-1', tabs: [{ id: 'inbox', kind: 'inbox' }], activeTabId: 'missing', size: 1 },
        { id: 'pane-2', tabs: [{ id: 'tasks', kind: 'tasks' }], activeTabId: 'tasks', size: 1 },
      ],
    }))
    const dock = new TeamDockStore()
    expect(dock.getSnapshot().panes).toHaveLength(1)
    expect(dock.getSnapshot().panes[0]!.id).toBe('pane-2')
  })

  it('keeps identical writes silent so sync effects converge', () => {
    const dock = new TeamDockStore()
    dock.openFace({ kind: 'inbox' })
    let writes = 0
    const unsubscribe = dock.subscribe(() => { writes += 1 })
    dock.openFace({ kind: 'inbox' })
    dock.focusTab(dock.getSnapshot().panes[0]!.id, 'inbox')
    expect(writes).toBe(0)
    unsubscribe()
  })
})

describe('restoreTabFace', () => {
  it('moves the Workspace and restores the leaf face in one commit', () => {
    const navigation = new TeamNavigation()
    navigation.actions().enterTeam()
    navigation.actions().selectWorkspace(w1)
    navigation.actions().selectInbox()
    let commits = 0
    const unsubscribe = navigation.subscribe(() => { commits += 1 })
    navigation.actions().restoreTabFace({ kind: 'channel', channelRef: channelB, workspaceId: w2 })
    unsubscribe()
    expect(commits).toBe(1)
    const snapshot = navigation.getSnapshot()
    expect(snapshot.workspaceId).toBe(w2)
    expect(snapshot.channelRef).toBe('channel:b')
    expect(snapshot.inbox).toBeUndefined()
    expect(JSON.parse(localStorage.getItem('dsh.agent-team.navigation') ?? '')).toMatchObject({ workspaceId: 'w2', channelRef: channelB })
  })

  it('restores a Thread with its origin payload but without the one-shot focus', () => {
    const navigation = new TeamNavigation()
    navigation.actions().enterTeam()
    navigation.actions().selectWorkspace(w1)
    navigation.actions().restoreTabFace({ kind: 'thread', threadRef: thread1, workspaceId: w1, channelRef: channelA, taskNumber: 7, threadOrigin: 'messages' })
    const snapshot = navigation.getSnapshot()
    expect(snapshot.threadRef).toBe('thread:1')
    expect(snapshot.channelRef).toBe('channel:a')
    expect(snapshot.taskNumber).toBe(7)
    expect(snapshot.threadOrigin).toBe('messages')
    expect(snapshot.focusSequence).toBeUndefined()
  })

  it('keeps the current Workspace for the global list faces', () => {
    const navigation = new TeamNavigation()
    navigation.actions().enterTeam()
    navigation.actions().selectWorkspace(w1)
    navigation.actions().selectChannel(channelA)
    navigation.actions().restoreTabFace({ kind: 'tasks' })
    const snapshot = navigation.getSnapshot()
    expect(snapshot.tasks).toBe(true)
    expect(snapshot.workspaceId).toBe(w1)
    expect(snapshot.channelRef).toBeUndefined()
  })

  it('restores the overview face by clearing the leaf faces only', () => {
    const navigation = new TeamNavigation()
    navigation.actions().enterTeam()
    navigation.actions().selectWorkspace(w1)
    navigation.actions().selectChannel(channelA)
    navigation.actions().restoreTabFace({ kind: 'overview' })
    const snapshot = navigation.getSnapshot()
    expect(snapshot.workspaceId).toBe(w1)
    expect(snapshot.channelRef).toBeUndefined()
    expect(snapshot.inbox).toBeUndefined()
  })

  it('stays silent when the face already stands', () => {
    const navigation = new TeamNavigation()
    navigation.actions().enterTeam()
    navigation.actions().selectWorkspace(w1)
    navigation.actions().selectChannel(channelA)
    let commits = 0
    const unsubscribe = navigation.subscribe(() => { commits += 1 })
    navigation.actions().restoreTabFace({ kind: 'channel', channelRef: channelA, workspaceId: w1 })
    unsubscribe()
    expect(commits).toBe(0)
  })
})
