import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { AgentTeamChannelRef, AgentTeamMemberId, AgentTeamTaskRef, AgentTeamThreadRef } from '@wowyuarm/dsh-agent-team/types'
import type { TeamNavigationSnapshot, TeamThreadOrigin } from './navigation.ts'

/**
 * The Team page dock: the right-column pane surface that renders the Team
 * pages beside the conversation. The dock owns browser-kept presentation
 * layout only — which pages are open as tabs, how panes split, and which one
 * is maximized. What the pages show is still the navigation snapshot's faces;
 * the dock subscribes to that snapshot and never invents durable facts.
 */

export type TeamDockTabKind = 'overview' | 'inbox' | 'tasks' | 'messages' | 'channel' | 'thread' | 'sessionHistory'

/**
 * The navigation face one dock tab stands for. The same shape both directions:
 * read off the snapshot when a Team face moves (so the dock follows the
 * sidebar), and written back through `restoreTabFace` when a background tab
 * takes its pane's seat again (so the sidebar follows the dock).
 */
export interface TeamTabFace {
  readonly kind: TeamDockTabKind
  readonly workspaceId?: WorkspaceId
  readonly channelRef?: AgentTeamChannelRef
  readonly threadRef?: AgentTeamThreadRef
  readonly taskRef?: AgentTeamTaskRef
  readonly taskNumber?: number
  readonly threadOrigin?: TeamThreadOrigin
  readonly memberId?: AgentTeamMemberId
}

export interface TeamDockTab extends TeamTabFace {
  /** Stable within the dock; `#N` suffixes distinguish cloned splits. */
  readonly id: string
}

export interface TeamDockPane {
  readonly id: string
  readonly tabs: readonly TeamDockTab[]
  readonly activeTabId: string
  /** Relative flex weight against the sibling panes; the divider drag writes it. */
  readonly size: number
}

export interface TeamDockSnapshot {
  /** Whether the dock column stands beside the conversation at all. */
  readonly open: boolean
  /** Whether the dock covers the frame; derived fullscreen on narrow viewports rides the component. */
  readonly fullscreen: boolean
  readonly panes: readonly TeamDockPane[]
  /** The pane new faces open into; falls back to the last pane when unset. */
  readonly focusedPaneId?: string
  /** The pane drawn over its siblings; `undefined` restores the split. */
  readonly maximizedPaneId?: string
}

/** The read face of the dock store, as slot props carry it. */
export interface TeamDockStoreSource {
  readonly getSnapshot: () => TeamDockSnapshot
  readonly subscribe: (listener: () => void) => () => void
}

const STORAGE_KEY = 'dsh.agent-team.dock.v1'
const MIN_PANE_WEIGHT = 0.12

/** The optional pane-pointer fields a commit may drop. */
type DockPanePointerKey = 'focusedPaneId' | 'maximizedPaneId'

function tabIdOf(face: TeamTabFace): string {
  switch (face.kind) {
    case 'overview': return 'overview'
    case 'inbox': return 'inbox'
    case 'tasks': return 'tasks'
    case 'messages': return 'messages'
    case 'channel': return `channel:${face.channelRef ?? ''}`
    case 'thread': return `thread:${face.threadRef ?? ''}`
    case 'sessionHistory': return `history:${face.memberId ?? ''}`
  }
}

/** Identity of two faces for focus-or-append decisions: kind plus its key ref. */
function sameTarget(tab: TeamTabFace, face: TeamTabFace): boolean {
  if (tab.kind !== face.kind) return false
  switch (face.kind) {
    case 'overview':
    case 'inbox':
    case 'tasks':
    case 'messages':
      return true
    case 'channel': return tab.channelRef === face.channelRef
    case 'thread': return tab.threadRef === face.threadRef
    case 'sessionHistory': return tab.memberId === face.memberId
  }
}

/** Read one navigation snapshot into the face its sidebar state names. */
export function faceOfSnapshot(snapshot: TeamNavigationSnapshot): TeamTabFace | undefined {
  if (snapshot.mode !== 'team') return undefined
  if (snapshot.inbox === true) return { kind: 'inbox' }
  if (snapshot.tasks === true) return { kind: 'tasks' }
  if (snapshot.messages === true) return { kind: 'messages' }
  if (snapshot.sessionHistory !== undefined) {
    return { kind: 'sessionHistory', memberId: snapshot.sessionHistory, ...(snapshot.workspaceId === undefined ? {} : { workspaceId: snapshot.workspaceId }) }
  }
  if (snapshot.threadRef !== undefined) {
    return {
      kind: 'thread',
      threadRef: snapshot.threadRef,
      ...(snapshot.workspaceId === undefined ? {} : { workspaceId: snapshot.workspaceId }),
      ...(snapshot.channelRef === undefined ? {} : { channelRef: snapshot.channelRef }),
      ...(snapshot.taskRef === undefined ? {} : { taskRef: snapshot.taskRef }),
      ...(snapshot.taskNumber === undefined ? {} : { taskNumber: snapshot.taskNumber }),
      ...(snapshot.threadOrigin === undefined ? {} : { threadOrigin: snapshot.threadOrigin }),
    }
  }
  if (snapshot.channelRef !== undefined) {
    return { kind: 'channel', channelRef: snapshot.channelRef, ...(snapshot.workspaceId === undefined ? {} : { workspaceId: snapshot.workspaceId }) }
  }
  return { kind: 'overview', ...(snapshot.workspaceId === undefined ? {} : { workspaceId: snapshot.workspaceId }) }
}

interface StoredTab {
  id: string
  kind: TeamDockTabKind
  workspaceId?: string
  channelRef?: string
  threadRef?: string
  taskRef?: string
  taskNumber?: number
  threadOrigin?: string
  memberId?: string
}

interface StoredPane {
  id: string
  tabs: StoredTab[]
  activeTabId: string
  size: number
}

interface StoredDock {
  v: 1
  open: boolean
  fullscreen: boolean
  panes: StoredPane[]
  focusedPaneId?: string
  maximizedPaneId?: string
}

const TAB_KINDS: readonly TeamDockTabKind[] = ['overview', 'inbox', 'tasks', 'messages', 'channel', 'thread', 'sessionHistory']
const THREAD_ORIGINS: readonly TeamThreadOrigin[] = ['inbox', 'tasks', 'messages']

function readTab(raw: Partial<StoredTab>): TeamDockTab | undefined {
  if (typeof raw.id !== 'string' || raw.id === '' || !TAB_KINDS.includes(raw.kind as TeamDockTabKind)) return undefined
  const kind = raw.kind as TeamDockTabKind
  if ((kind === 'channel' && typeof raw.channelRef !== 'string')
    || (kind === 'thread' && typeof raw.threadRef !== 'string')
    || (kind === 'sessionHistory' && typeof raw.memberId !== 'string')) return undefined
  return {
    id: raw.id,
    kind,
    ...(typeof raw.workspaceId === 'string' ? { workspaceId: raw.workspaceId as WorkspaceId } : {}),
    ...(typeof raw.channelRef === 'string' ? { channelRef: raw.channelRef as AgentTeamChannelRef } : {}),
    ...(typeof raw.threadRef === 'string' ? { threadRef: raw.threadRef as AgentTeamThreadRef } : {}),
    ...(typeof raw.taskRef === 'string' ? { taskRef: raw.taskRef as AgentTeamTaskRef } : {}),
    ...(typeof raw.taskNumber === 'number' && Number.isInteger(raw.taskNumber) && raw.taskNumber > 0 ? { taskNumber: raw.taskNumber } : {}),
    ...(THREAD_ORIGINS.includes(raw.threadOrigin as TeamThreadOrigin) ? { threadOrigin: raw.threadOrigin as TeamThreadOrigin } : {}),
    ...(typeof raw.memberId === 'string' ? { memberId: raw.memberId as AgentTeamMemberId } : {}),
  }
}

function readStored(): TeamDockSnapshot {
  if (typeof localStorage === 'undefined') return { open: true, fullscreen: false, panes: [] }
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '') as Partial<StoredDock>
    if (parsed.v !== 1 || typeof parsed.open !== 'boolean' || typeof parsed.fullscreen !== 'boolean' || !Array.isArray(parsed.panes)) {
      return { open: true, fullscreen: false, panes: [] }
    }
    const panes: TeamDockPane[] = []
    for (const raw of parsed.panes) {
      if (typeof raw !== 'object' || raw === null || typeof (raw as StoredPane).id !== 'string') continue
      const candidate = raw as StoredPane
      if (!Array.isArray(candidate.tabs) || typeof candidate.activeTabId !== 'string' || typeof candidate.size !== 'number') continue
      const tabs = candidate.tabs.map(readTab).filter((tab): tab is TeamDockTab => tab !== undefined)
      if (tabs.length === 0 || !tabs.some(tab => tab.id === candidate.activeTabId)) continue
      panes.push({ id: candidate.id, tabs, activeTabId: candidate.activeTabId, size: Math.max(MIN_PANE_WEIGHT, candidate.size) })
    }
    const focusedExists = typeof parsed.focusedPaneId === 'string' && panes.some(pane => pane.id === parsed.focusedPaneId)
    const maximizedExists = typeof parsed.maximizedPaneId === 'string' && panes.some(pane => pane.id === parsed.maximizedPaneId)
    return {
      open: parsed.open,
      fullscreen: parsed.fullscreen,
      panes,
      ...(focusedExists ? { focusedPaneId: parsed.focusedPaneId } : {}),
      ...(maximizedExists ? { maximizedPaneId: parsed.maximizedPaneId } : {}),
    }
  } catch {
    // Local persistence is a convenience; malformed content just starts empty.
    return { open: true, fullscreen: false, panes: [] }
  }
}

function persistStored(snapshot: TeamDockSnapshot): void {
  if (typeof localStorage === 'undefined') return
  try {
    const panes: StoredPane[] = snapshot.panes.map(pane => ({
      id: pane.id,
      activeTabId: pane.activeTabId,
      size: pane.size,
      tabs: pane.tabs.map(tab => ({
        id: tab.id,
        kind: tab.kind,
        ...(tab.workspaceId === undefined ? {} : { workspaceId: tab.workspaceId }),
        ...(tab.channelRef === undefined ? {} : { channelRef: tab.channelRef }),
        ...(tab.threadRef === undefined ? {} : { threadRef: tab.threadRef }),
        ...(tab.taskRef === undefined ? {} : { taskRef: tab.taskRef }),
        ...(tab.taskNumber === undefined ? {} : { taskNumber: tab.taskNumber }),
        ...(tab.threadOrigin === undefined ? {} : { threadOrigin: tab.threadOrigin }),
        ...(tab.memberId === undefined ? {} : { memberId: tab.memberId }),
      })),
    }))
    const payload: StoredDock = {
      v: 1,
      open: snapshot.open,
      fullscreen: snapshot.fullscreen,
      panes,
      ...(snapshot.focusedPaneId === undefined ? {} : { focusedPaneId: snapshot.focusedPaneId }),
      ...(snapshot.maximizedPaneId === undefined ? {} : { maximizedPaneId: snapshot.maximizedPaneId }),
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // Private mode and quota failures do not block docking.
  }
}

/**
 * Root-scoped dock layout, one instance per Client context (provided next to
 * the navigation service). Every mutation commits once — persist, then notify
 * — and identical writes stay silent so sync effects converge without loops.
 */
export class TeamDockStore {
  private snapshot: TeamDockSnapshot = readStored()
  private readonly listeners = new Set<() => void>()
  private paneCounter = 0

  readonly getSnapshot = (): TeamDockSnapshot => this.snapshot

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  dispose(): void {
    this.listeners.clear()
  }

  /** Test seam: forget everything, including what localStorage still holds. */
  reset(): void {
    this.snapshot = { open: true, fullscreen: false, panes: [] }
    if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_KEY)
    for (const listener of this.listeners) listener()
  }

  /** Re-read persisted content — what a fresh page load starts from. */
  reload(): void {
    this.snapshot = readStored()
    for (const listener of this.listeners) listener()
  }

  /**
   * Follow the navigation snapshot's face: focus the tab that already stands
   * for it — in whichever pane — or open it into the focused pane, reopening
   * the dock when it was closed. Sidebar cards, Thread rows, and the pages'
   * own Back buttons all arrive here, so the dock answers every one of them.
   */
  openFace(face: TeamTabFace): void {
    for (const pane of this.snapshot.panes) {
      const tab = pane.tabs.find(candidate => sameTarget(candidate, face))
      if (tab === undefined) continue
      this.focusTab(pane.id, tab.id)
      return
    }
    const target = this.targetPane()
    if (target === undefined) {
      const pane = this.newPane([this.newTab(face)])
      this.commit({ open: true, panes: [pane], focusedPaneId: pane.id })
      return
    }
    const tab = this.newTab(face)
    const panes = this.snapshot.panes.map(pane => pane.id === target.id
      ? { ...pane, tabs: [...pane.tabs, tab], activeTabId: tab.id }
      : pane)
    this.commit({ panes, focusedPaneId: target.id, open: true })
  }

  /** Focus one tab inside its pane; the component restores the face through navigation. */
  focusTab(paneId: string, tabId: string): void {
    const pane = this.snapshot.panes.find(candidate => candidate.id === paneId)
    if (pane === undefined || !pane.tabs.some(tab => tab.id === tabId)) return
    if (pane.activeTabId === tabId && this.snapshot.focusedPaneId === paneId) return
    this.commit({
      panes: this.snapshot.panes.map(candidate => candidate.id === paneId ? { ...candidate, activeTabId: tabId } : candidate),
      focusedPaneId: paneId,
    })
  }

  closeTab(paneId: string, tabId: string): void {
    const pane = this.snapshot.panes.find(candidate => candidate.id === paneId)
    if (pane === undefined || !pane.tabs.some(tab => tab.id === tabId)) return
    if (pane.tabs.length === 1) {
      this.closePane(paneId)
      return
    }
    const index = pane.tabs.findIndex(tab => tab.id === tabId)
    const tabs = pane.tabs.filter(tab => tab.id !== tabId)
    const activeTabId = pane.activeTabId === tabId ? (tabs[index] ?? tabs[tabs.length - 1]!).id : pane.activeTabId
    // Closing a maximized pane's last visible tab leaves no pane on screen, so
    // the maximize falls with it; an unaffected maximize survives the close.
    const maximizeFalls = this.snapshot.maximizedPaneId === paneId && pane.activeTabId === tabId
    this.commit({
      panes: this.snapshot.panes.map(candidate => candidate.id === paneId ? { ...candidate, tabs, activeTabId } : candidate),
    }, maximizeFalls ? ['maximizedPaneId'] : [])
  }

  closePane(paneId: string): void {
    const panes = this.snapshot.panes.filter(pane => pane.id !== paneId)
    if (panes.length === this.snapshot.panes.length) return
    if (panes.length === 0) {
      this.commit({ panes, open: false }, ['focusedPaneId', 'maximizedPaneId'])
      return
    }
    this.commit({ panes }, [
      ...(this.snapshot.focusedPaneId === paneId ? ['focusedPaneId'] as const : []),
      ...(this.snapshot.maximizedPaneId === paneId ? ['maximizedPaneId'] as const : []),
    ])
  }

  /**
   * Split the focused pane: its active page opens again in a new pane placed
   * right below, and the two share the row heights evenly. The source pane
   * keeps its tab — the split is a copy, never a move, so a single-tab pane
   * splits instead of collapsing.
   */
  splitPane(): void {
    const source = this.targetPane()
    if (source === undefined) return
    const active = source.tabs.find(tab => tab.id === source.activeTabId)
    if (active === undefined) return
    const tab = this.newTab(active)
    const pane = this.newPane([tab], source.size / 2)
    const index = this.snapshot.panes.findIndex(candidate => candidate.id === source.id)
    const panes = [
      ...this.snapshot.panes.slice(0, index),
      { ...source, size: source.size / 2 },
      pane,
      ...this.snapshot.panes.slice(index + 1),
    ]
    this.commit({ panes, focusedPaneId: pane.id }, ['maximizedPaneId'])
  }

  toggleMaximize(paneId: string): void {
    if (this.snapshot.maximizedPaneId === paneId) {
      this.commit({}, ['maximizedPaneId'])
      return
    }
    this.commit({ maximizedPaneId: paneId })
  }

  setPaneSize(paneId: string, size: number): void {
    if (!this.snapshot.panes.some(pane => pane.id === paneId)) return
    const clamped = Math.max(MIN_PANE_WEIGHT, size)
    if (this.snapshot.panes.find(pane => pane.id === paneId)!.size === clamped) return
    this.commit({ panes: this.snapshot.panes.map(pane => pane.id === paneId ? { ...pane, size: clamped } : pane) })
  }

  setOpen(open: boolean): void {
    if (this.snapshot.open === open) return
    this.commit({ open })
  }

  toggleOpen(): void {
    this.setOpen(!this.snapshot.open)
  }

  setFullscreen(fullscreen: boolean): void {
    if (this.snapshot.fullscreen === fullscreen) return
    this.commit({ fullscreen })
  }

  private targetPane(): TeamDockPane | undefined {
    return this.snapshot.panes.find(pane => pane.id === this.snapshot.focusedPaneId) ?? this.snapshot.panes[this.snapshot.panes.length - 1]
  }

  private newPane(tabs: readonly TeamDockTab[], size = 1): TeamDockPane {
    this.paneCounter += 1
    return { id: `pane-${this.paneCounter}`, tabs: [...tabs], activeTabId: tabs[0]!.id, size }
  }

  private newTab(face: TeamTabFace): TeamTabFace & { id: string } {
    const base = tabIdOf(face)
    const taken = new Set(this.snapshot.panes.flatMap(pane => pane.tabs.map(tab => tab.id)))
    if (!taken.has(base)) return { ...face, id: base }
    let clone = 2
    while (taken.has(`${base}#${clone}`)) clone += 1
    return { ...face, id: `${base}#${clone}` }
  }

  /**
   * One mutation, one commit: `patch` merges over the snapshot, and the named
   * optional pointers drop from it entirely (an `undefined` value under
   * exactOptionalPropertyTypes is not writable, and clearing must stay a
   * distinct act from leaving a field untouched).
   */
  private commit(patch: Partial<TeamDockSnapshot>, drop: readonly DockPanePointerKey[] = []): void {
    let next: TeamDockSnapshot = { ...this.snapshot }
    for (const key of drop) {
      if (key === 'focusedPaneId') {
        const { focusedPaneId: _focusedPaneId, ...rest } = next
        next = rest
      } else {
        const { maximizedPaneId: _maximizedPaneId, ...rest } = next
        next = rest
      }
    }
    next = { ...next, ...patch }
    // An empty pane list drops the pane pointers, but `open` survives: a
    // reopened dock with no pane yet takes its first tab from the current
    // navigation face (the seat's sync effect), and only the explicit
    // closePane/openFace paths write `open` themselves.
    if (next.panes.length === 0) {
      const { focusedPaneId: _focusedPaneId, maximizedPaneId: _maximizedPaneId, ...rest } = next
      next = rest
    }
    this.snapshot = next
    persistStored(next)
    for (const listener of this.listeners) listener()
  }
}

export { STORAGE_KEY as TEAM_DOCK_STORAGE_KEY }
