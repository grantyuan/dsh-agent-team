import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { AgentTeamChannelRef, AgentTeamMemberId, AgentTeamTaskRef, AgentTeamThreadRef } from '@wowyuarm/dsh-agent-team/types'

export type TeamMode = 'conversation' | 'team'

/**
 * The Team list an open Thread was entered from. It decides where Back lands:
 * an Inbox, Tasks, or Decisions origin returns to that list, an absent origin
 * returns to the Thread's Channel through the Channel row path.
 */
export type TeamThreadOrigin = 'inbox' | 'tasks' | 'decisions'

export interface TeamNavigationSnapshot {
  mode: TeamMode
  workspaceId?: WorkspaceId
  channelRef?: AgentTeamChannelRef
  taskRef?: AgentTeamTaskRef
  threadRef?: AgentTeamThreadRef
  taskNumber?: number
  /**
   * Which Team list the open Thread was entered from. It is a durable
   * navigation fact: a Thread opened from the Inbox or Tasks list returns to
   * that list after a reload; a Thread entered from its Channel carries no
   * origin and returns there.
   */
  threadOrigin?: TeamThreadOrigin
  /**
   * Durable position of the Human mention-Inbox page (a navigation fact, not
   * an unread fact): selecting Inbox clears the Channel/Thread faces, and a
   * reload reopens the page. Read markers only move through Thread reads.
   */
  inbox?: boolean
  /** Durable position of the Human Tasks page; same face discipline as `inbox`. */
  tasks?: boolean
  /**
   * Durable position of the Human decision queue: every Thread that still waits
   * on the reader, whether it asks a question or awaits acceptance. Same face
   * discipline as `inbox` and `tasks`.
   */
  decisions?: boolean
  /**
   * Durable position of one Member's session-history review page: the Human's
   * audit target survives a reload because the lineage read takes only the
   * branded Member id. Same face discipline as `inbox` and `tasks`.
   */
  sessionHistory?: AgentTeamMemberId
  /** Runtime-only Member Session embedded in the conversation seat; never persisted. */
  memberSessionId?: SessionId
  /** Runtime-only session to restore when the Member view closes; never persisted. */
  returnToSessionId?: SessionId
}

const STORAGE_KEY = 'dsh.agent-team.navigation'

function readSnapshot(): TeamNavigationSnapshot {
  if (typeof localStorage === 'undefined') return { mode: 'conversation' }
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '') as Partial<TeamNavigationSnapshot>
    const hasThread = typeof parsed.threadRef === 'string'
    return {
      mode: parsed.mode === 'team' ? 'team' : 'conversation',
      ...(typeof parsed.workspaceId === 'string' ? { workspaceId: parsed.workspaceId as WorkspaceId } : {}),
      ...(typeof parsed.channelRef === 'string' ? { channelRef: parsed.channelRef as AgentTeamChannelRef } : {}),
      ...(parsed.inbox === true ? { inbox: true } : {}),
      ...(parsed.tasks === true ? { tasks: true } : {}),
      ...(parsed.decisions === true ? { decisions: true } : {}),
      ...(typeof parsed.sessionHistory === 'string' ? { sessionHistory: parsed.sessionHistory as AgentTeamMemberId } : {}),
      ...(hasThread ? {
        threadRef: parsed.threadRef as AgentTeamThreadRef,
        ...(parsed.threadOrigin === 'inbox' || parsed.threadOrigin === 'tasks' || parsed.threadOrigin === 'decisions' ? { threadOrigin: parsed.threadOrigin } : {}),
        ...(typeof parsed.taskRef === 'string' ? { taskRef: parsed.taskRef as AgentTeamTaskRef } : {}),
        ...(typeof parsed.taskNumber === 'number' && Number.isInteger(parsed.taskNumber) && parsed.taskNumber > 0 ? { taskNumber: parsed.taskNumber } : {}),
      } : {}),
    }
  } catch {
    return { mode: 'conversation' }
  }
}

function persistSnapshot(snapshot: TeamNavigationSnapshot): void {
  if (typeof localStorage === 'undefined') return
  try {
    const { mode, workspaceId, channelRef, taskRef, threadRef, taskNumber, threadOrigin, inbox, tasks, decisions, sessionHistory } = snapshot
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      mode,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(channelRef === undefined ? {} : { channelRef }),
      ...(inbox === true ? { inbox: true } : {}),
      ...(tasks === true ? { tasks: true } : {}),
      ...(decisions === true ? { decisions: true } : {}),
      ...(sessionHistory === undefined ? {} : { sessionHistory }),
      ...(taskRef === undefined ? {} : { taskRef }),
      ...(threadRef === undefined ? {} : { threadRef }),
      ...(threadOrigin === undefined ? {} : { threadOrigin }),
      ...(taskNumber === undefined ? {} : { taskNumber }),
    }))
  } catch {
    // Local persistence is a convenience; private mode and quota failures do not block navigation.
  }
}

export interface TeamNavigationActions {
  enterTeam: () => void
  leaveTeam: () => void
  selectWorkspace: (workspaceId: WorkspaceId) => void
  selectChannel: (channelRef: AgentTeamChannelRef) => void
  selectThread: (threadRef: AgentTeamThreadRef, channelRef?: AgentTeamChannelRef, taskRef?: AgentTeamTaskRef, taskNumber?: number, origin?: TeamThreadOrigin) => void
  /** Open the Human mention-Inbox page; clears the Channel/Thread faces. */
  selectInbox: () => void
  /** Open the Human Tasks page; clears the Channel/Thread faces. */
  selectTasks: () => void
  /** Open the Human decision queue; clears the Channel/Thread faces. */
  selectDecisions: () => void
  /** Open one Member's session-history review page; clears the other Team faces. */
  selectSessionHistory: (memberId: AgentTeamMemberId) => void
  /** Leave the session-history page; the Workspace face underneath takes the seat back. */
  exitSessionHistory: () => void
  /**
   * Leave the open Thread for whichever Team list it was entered from: the
   * Inbox or Tasks list when the Thread carries that origin, its Channel
   * otherwise.
   */
  backFromThread: () => void
  /** Leave the selected Channel for the workspace Channel list; keeps mode and Workspace. */
  backToChannels: () => void
  /**
   * Swap the conversation seat to a Member Session while Team chrome stays
   * mounted. `returnToSessionId` is captured once — switching between Member
   * Sessions keeps the original target.
   */
  enterMemberSession: (sessionId: SessionId, returnToSessionId?: SessionId) => void
  /** Close the embedded Member Session view and return to the Team views. */
  exitMemberSession: () => void
}

/** Root-scoped Team mode state. Slot lifetimes subscribe to this source. */
export class TeamNavigation {
  private snapshot = readSnapshot()
  private readonly listeners = new Set<() => void>()

  readonly getSnapshot = (): TeamNavigationSnapshot => this.snapshot

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  actions(): TeamNavigationActions {
    return {
      enterTeam: () => { this.clearMemberSession(); this.setMode('team') },
      leaveTeam: () => { this.setMode('conversation') },
      selectWorkspace: workspaceId => { this.clearMemberSession(); this.setWorkspace(workspaceId) },
      selectChannel: channelRef => { this.clearMemberSession(); this.setChannel(channelRef) },
      selectThread: (threadRef, channelRef, taskRef, taskNumber, origin) => { this.clearMemberSession(); this.setThread(threadRef, channelRef, taskRef, taskNumber, origin) },
      selectInbox: () => { this.clearMemberSession(); this.setInbox() },
      selectTasks: () => { this.clearMemberSession(); this.setTasks() },
      selectDecisions: () => { this.clearMemberSession(); this.setDecisions() },
      selectSessionHistory: memberId => { this.clearMemberSession(); this.setSessionHistory(memberId) },
      exitSessionHistory: () => { this.clearSessionHistory() },
      backFromThread: () => { this.clearMemberSession(); this.leaveThread() },
      backToChannels: () => { this.clearMemberSession(); this.clearChannel() },
      enterMemberSession: (sessionId, returnToSessionId) => { this.setMemberSession(sessionId, returnToSessionId) },
      exitMemberSession: () => { this.clearMemberSession() },
    }
  }

  dispose(): void {
    this.listeners.clear()
  }

  private setMode(mode: TeamMode): void {
    if (this.snapshot.mode === mode) return
    this.snapshot = { ...this.snapshot, mode }
    this.commit()
  }

  private setMemberSession(sessionId: SessionId, returnToSessionId?: SessionId): void {
    // Re-selecting the active Member keeps the original return target.
    if (this.snapshot.memberSessionId === sessionId && this.snapshot.mode === 'team') return
    const { memberSessionId: _memberSessionId, ...base } = this.snapshot
    this.snapshot = {
      ...base,
      mode: 'team',
      memberSessionId: sessionId,
      ...(returnToSessionId === undefined ? {} : { returnToSessionId }),
    }
    this.commit()
  }

  /** Any explicit Team navigation or the footer leave closes a Member view. */
  private clearMemberSession(): void {
    if (this.snapshot.memberSessionId === undefined && this.snapshot.returnToSessionId === undefined) return
    const { memberSessionId: _memberSessionId, returnToSessionId: _returnToSessionId, ...base } = this.snapshot
    this.snapshot = base
    this.commit()
  }

  private setWorkspace(workspaceId: WorkspaceId): void {
    if (this.snapshot.workspaceId === workspaceId && this.snapshot.inbox !== true && this.snapshot.tasks !== true && this.snapshot.decisions !== true && this.snapshot.sessionHistory === undefined) return
    const { channelRef: _channelRef, taskRef: _taskRef, threadRef: _threadRef, taskNumber: _taskNumber, threadOrigin: _threadOrigin, inbox: _inbox, tasks: _tasks, decisions: _decisions, sessionHistory: _sessionHistory, ...base } = this.snapshot
    this.snapshot = { ...base, workspaceId }
    this.commit()
  }

  private setChannel(channelRef: AgentTeamChannelRef): void {
    if (this.snapshot.channelRef === channelRef && this.snapshot.threadRef === undefined && this.snapshot.inbox !== true && this.snapshot.tasks !== true && this.snapshot.decisions !== true && this.snapshot.sessionHistory === undefined) return
    const { taskRef: _taskRef, threadRef: _threadRef, taskNumber: _taskNumber, threadOrigin: _threadOrigin, inbox: _inbox, tasks: _tasks, decisions: _decisions, sessionHistory: _sessionHistory, ...base } = this.snapshot
    this.snapshot = { ...base, channelRef }
    this.commit()
  }

  /** The Inbox is a face, not workspace content: selecting a Workspace leaves it. */
  private setInbox(): void {
    if (this.snapshot.inbox === true && this.snapshot.channelRef === undefined && this.snapshot.threadRef === undefined && this.snapshot.sessionHistory === undefined) return
    const { channelRef: _channelRef, taskRef: _taskRef, threadRef: _threadRef, taskNumber: _taskNumber, threadOrigin: _threadOrigin, tasks: _tasks, decisions: _decisions, sessionHistory: _sessionHistory, ...base } = this.snapshot
    this.snapshot = { ...base, inbox: true }
    this.commit()
  }

  /** Same face discipline as the Inbox: the Tasks page owns the seat while its flag stands. */
  private setTasks(): void {
    if (this.snapshot.tasks === true && this.snapshot.channelRef === undefined && this.snapshot.threadRef === undefined && this.snapshot.sessionHistory === undefined) return
    const { channelRef: _channelRef, taskRef: _taskRef, threadRef: _threadRef, taskNumber: _taskNumber, threadOrigin: _threadOrigin, inbox: _inbox, decisions: _decisions, sessionHistory: _sessionHistory, ...base } = this.snapshot
    this.snapshot = { ...base, tasks: true }
    this.commit()
  }

  /** Same face discipline as the Inbox: the decision queue owns the seat while its flag stands. */
  private setDecisions(): void {
    if (this.snapshot.decisions === true && this.snapshot.channelRef === undefined && this.snapshot.threadRef === undefined && this.snapshot.sessionHistory === undefined) return
    const { channelRef: _channelRef, taskRef: _taskRef, threadRef: _threadRef, taskNumber: _taskNumber, threadOrigin: _threadOrigin, inbox: _inbox, tasks: _tasks, sessionHistory: _sessionHistory, ...base } = this.snapshot
    this.snapshot = { ...base, decisions: true }
    this.commit()
  }

  /** Same face discipline as the Inbox: one Member's history page owns the seat while its flag stands. */
  private setSessionHistory(memberId: AgentTeamMemberId): void {
    if (this.snapshot.sessionHistory === memberId && this.snapshot.channelRef === undefined && this.snapshot.threadRef === undefined) return
    const { channelRef: _channelRef, taskRef: _taskRef, threadRef: _threadRef, taskNumber: _taskNumber, threadOrigin: _threadOrigin, inbox: _inbox, tasks: _tasks, decisions: _decisions, ...base } = this.snapshot
    this.snapshot = { ...base, sessionHistory: memberId }
    this.commit()
  }

  private clearSessionHistory(): void {
    if (this.snapshot.sessionHistory === undefined) return
    const { sessionHistory: _sessionHistory, ...base } = this.snapshot
    this.snapshot = base
    this.commit()
  }

  private clearChannel(): void {
    const { channelRef: _channelRef, ...base } = this.snapshot
    if (this.snapshot.channelRef === undefined) return
    this.snapshot = base
    this.commit()
  }

  private setThread(threadRef: AgentTeamThreadRef | undefined, channelRef?: AgentTeamChannelRef, taskRef?: AgentTeamTaskRef, taskNumber?: number, origin?: TeamThreadOrigin): void {
    if (this.snapshot.threadRef === threadRef && this.snapshot.taskRef === taskRef && this.snapshot.channelRef === channelRef && this.snapshot.taskNumber === taskNumber && this.snapshot.threadOrigin === origin && this.snapshot.inbox !== true && this.snapshot.tasks !== true && this.snapshot.decisions !== true && this.snapshot.sessionHistory === undefined) return
    if (threadRef === undefined) {
      const { taskRef: _taskRef, threadRef: _threadRef, taskNumber: _taskNumber, threadOrigin: _threadOrigin, sessionHistory: _sessionHistory, ...base } = this.snapshot
      this.snapshot = base
    } else {
      const { channelRef: _channelRef, taskRef: _taskRef, threadRef: _threadRef, taskNumber: _taskNumber, threadOrigin: _threadOrigin, inbox: _inbox, tasks: _tasks, decisions: _decisions, sessionHistory: _sessionHistory, ...base } = this.snapshot
      this.snapshot = {
        ...base,
        threadRef,
        ...(channelRef === undefined ? {} : { channelRef }),
        ...(taskRef === undefined ? {} : { taskRef }),
        ...(taskNumber === undefined ? {} : { taskNumber }),
        ...(origin === undefined ? {} : { threadOrigin: origin }),
      }
    }
    this.commit()
  }

  /** Back from the open Thread to the list it was entered from, else its Channel. */
  private leaveThread(): void {
    const origin = this.snapshot.threadOrigin
    if (origin === 'inbox') { this.setInbox(); return }
    if (origin === 'tasks') { this.setTasks(); return }
    if (origin === 'decisions') { this.setDecisions(); return }
    this.setThread(undefined)
  }

  private commit(): void {
    persistSnapshot(this.snapshot)
    for (const listener of this.listeners) listener()
  }

}

export { STORAGE_KEY }
