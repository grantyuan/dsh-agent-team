import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { AgentTeamChannelRef, AgentTeamMemberId, AgentTeamTaskRef, AgentTeamThreadRef } from '@wowyuarm/dsh-agent-team/types'
import type { TeamTabFace } from './dock.ts'

export type TeamMode = 'conversation' | 'team'

/**
 * The Team list an open Thread was entered from. It decides where Back lands:
 * an Inbox, Tasks, or Message Center origin returns to that list, an absent
 * origin returns to the Thread's Channel through the Channel row path.
 */
export type TeamThreadOrigin = 'inbox' | 'tasks' | 'messages'

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
   * One-shot locate anchor riding `threadRef`: the Message Center's 「定位」
   * opens the Thread and asks the timeline to scroll this fact into view and
   * flash it once. It is a durable navigation fact, so a reload replays it,
   * and every path that drops `threadRef` drops it with it.
   */
  focusSequence?: number
  /**
   * Durable position of the Human mention-Inbox page (a navigation fact, not
   * an unread fact): selecting Inbox clears the Channel/Thread faces, and a
   * reload reopens the page. Read markers only move through Thread reads.
   */
  inbox?: boolean
  /** Durable position of the Human Tasks page; same face discipline as `inbox`. */
  tasks?: boolean
  /**
   * Durable position of the Human Message Center page — every discussion in
   * the Workspace beside every Message sent to or by this person. Same face
   * discipline as `inbox`.
   */
  messages?: boolean
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

/** Fact-level equality of two snapshots — every persisted navigation face. */
function sameSnapshotFacts(left: TeamNavigationSnapshot, right: TeamNavigationSnapshot): boolean {
  return left.mode === right.mode
    && left.workspaceId === right.workspaceId
    && left.channelRef === right.channelRef
    && left.taskRef === right.taskRef
    && left.threadRef === right.threadRef
    && left.taskNumber === right.taskNumber
    && left.threadOrigin === right.threadOrigin
    && left.focusSequence === right.focusSequence
    && left.inbox === right.inbox
    && left.tasks === right.tasks
    && left.messages === right.messages
    && left.sessionHistory === right.sessionHistory
}

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
      ...(parsed.messages === true ? { messages: true } : {}),
      ...(typeof parsed.sessionHistory === 'string' ? { sessionHistory: parsed.sessionHistory as AgentTeamMemberId } : {}),
      ...(hasThread ? {
        threadRef: parsed.threadRef as AgentTeamThreadRef,
        ...(parsed.threadOrigin === 'inbox' || parsed.threadOrigin === 'tasks' || parsed.threadOrigin === 'messages' ? { threadOrigin: parsed.threadOrigin } : {}),
        ...(typeof parsed.taskRef === 'string' ? { taskRef: parsed.taskRef as AgentTeamTaskRef } : {}),
        ...(typeof parsed.taskNumber === 'number' && Number.isInteger(parsed.taskNumber) && parsed.taskNumber > 0 ? { taskNumber: parsed.taskNumber } : {}),
        ...(typeof parsed.focusSequence === 'number' && Number.isInteger(parsed.focusSequence) && parsed.focusSequence > 0 ? { focusSequence: parsed.focusSequence } : {}),
      } : {}),
    }
  } catch {
    return { mode: 'conversation' }
  }
}

function persistSnapshot(snapshot: TeamNavigationSnapshot): void {
  if (typeof localStorage === 'undefined') return
  try {
    const { mode, workspaceId, channelRef, taskRef, threadRef, taskNumber, threadOrigin, focusSequence, inbox, tasks, messages, sessionHistory } = snapshot
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      mode,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(channelRef === undefined ? {} : { channelRef }),
      ...(inbox === true ? { inbox: true } : {}),
      ...(tasks === true ? { tasks: true } : {}),
      ...(messages === true ? { messages: true } : {}),
      ...(sessionHistory === undefined ? {} : { sessionHistory }),
      ...(taskRef === undefined ? {} : { taskRef }),
      ...(threadRef === undefined ? {} : { threadRef }),
      ...(threadOrigin === undefined ? {} : { threadOrigin }),
      ...(taskNumber === undefined ? {} : { taskNumber }),
      ...(threadRef !== undefined && focusSequence !== undefined ? { focusSequence } : {}),
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
  selectThread: (threadRef: AgentTeamThreadRef, channelRef?: AgentTeamChannelRef, taskRef?: AgentTeamTaskRef, taskNumber?: number, origin?: TeamThreadOrigin, focusSequence?: number) => void
  /** Open the Human mention-Inbox page; clears the Channel/Thread faces. */
  selectInbox: () => void
  /** Open the Human Tasks page; clears the Channel/Thread faces. */
  selectTasks: () => void
  /** Open the Human Message Center page; clears the Channel/Thread faces. */
  selectMessages: () => void
  /** Open one Member's session-history review page; clears the other Team faces. */
  selectSessionHistory: (memberId: AgentTeamMemberId) => void
  /** Leave the session-history page; the Workspace face underneath takes the seat back. */
  exitSessionHistory: () => void
  /**
   * Leave the open Thread for whichever Team list it was entered from: the
   * Inbox, Tasks, or Message Center list when the Thread carries that origin,
   * its Channel otherwise.
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
  /**
   * Restore one dock tab's navigation face in a single commit: the Workspace
   * the tab was opened under (when it carries one and it differs) plus the
   * leaf face itself. A background tab taking its seat back must not publish
   * the intermediate Workspace-overview state, so the Workspace move and the
   * leaf selection land as one durable navigation write.
   */
  restoreTabFace: (face: TeamTabFace) => void
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
      selectThread: (threadRef, channelRef, taskRef, taskNumber, origin, focusSequence) => { this.clearMemberSession(); this.setThread(threadRef, channelRef, taskRef, taskNumber, origin, focusSequence) },
      selectInbox: () => { this.clearMemberSession(); this.setInbox() },
      selectTasks: () => { this.clearMemberSession(); this.setTasks() },
      selectMessages: () => { this.clearMemberSession(); this.setMessages() },
      selectSessionHistory: memberId => { this.clearMemberSession(); this.setSessionHistory(memberId) },
      exitSessionHistory: () => { this.clearSessionHistory() },
      backFromThread: () => { this.clearMemberSession(); this.leaveThread() },
      backToChannels: () => { this.clearMemberSession(); this.clearChannel() },
      enterMemberSession: (sessionId, returnToSessionId) => { this.setMemberSession(sessionId, returnToSessionId) },
      exitMemberSession: () => { this.clearMemberSession() },
      restoreTabFace: face => { this.applyTabFace(face) },
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
    if (this.snapshot.workspaceId === workspaceId && this.snapshot.inbox !== true && this.snapshot.tasks !== true && this.snapshot.messages !== true && this.snapshot.sessionHistory === undefined) return
    const { channelRef: _channelRef, taskRef: _taskRef, threadRef: _threadRef, taskNumber: _taskNumber, threadOrigin: _threadOrigin, focusSequence: _focusSequence, inbox: _inbox, tasks: _tasks, messages: _messages, sessionHistory: _sessionHistory, ...base } = this.snapshot
    this.snapshot = { ...base, workspaceId }
    this.commit()
  }

  private setChannel(channelRef: AgentTeamChannelRef): void {
    if (this.snapshot.channelRef === channelRef && this.snapshot.threadRef === undefined && this.snapshot.inbox !== true && this.snapshot.tasks !== true && this.snapshot.messages !== true && this.snapshot.sessionHistory === undefined) return
    const { taskRef: _taskRef, threadRef: _threadRef, taskNumber: _taskNumber, threadOrigin: _threadOrigin, focusSequence: _focusSequence, inbox: _inbox, tasks: _tasks, messages: _messages, sessionHistory: _sessionHistory, ...base } = this.snapshot
    this.snapshot = { ...base, channelRef }
    this.commit()
  }

  /** The Inbox is a face, not workspace content: selecting a Workspace leaves it. */
  private setInbox(): void {
    if (this.snapshot.inbox === true && this.snapshot.channelRef === undefined && this.snapshot.threadRef === undefined && this.snapshot.messages !== true && this.snapshot.sessionHistory === undefined) return
    const { channelRef: _channelRef, taskRef: _taskRef, threadRef: _threadRef, taskNumber: _taskNumber, threadOrigin: _threadOrigin, focusSequence: _focusSequence, tasks: _tasks, messages: _messages, sessionHistory: _sessionHistory, ...base } = this.snapshot
    this.snapshot = { ...base, inbox: true }
    this.commit()
  }

  /** Same face discipline as the Inbox: the Tasks page owns the seat while its flag stands. */
  private setTasks(): void {
    if (this.snapshot.tasks === true && this.snapshot.channelRef === undefined && this.snapshot.threadRef === undefined && this.snapshot.messages !== true && this.snapshot.sessionHistory === undefined) return
    const { channelRef: _channelRef, taskRef: _taskRef, threadRef: _threadRef, taskNumber: _taskNumber, threadOrigin: _threadOrigin, focusSequence: _focusSequence, inbox: _inbox, messages: _messages, sessionHistory: _sessionHistory, ...base } = this.snapshot
    this.snapshot = { ...base, tasks: true }
    this.commit()
  }

  /** Same face discipline as the Inbox: the Message Center owns the seat while its flag stands. */
  private setMessages(): void {
    if (this.snapshot.messages === true && this.snapshot.channelRef === undefined && this.snapshot.threadRef === undefined && this.snapshot.inbox !== true && this.snapshot.tasks !== true && this.snapshot.sessionHistory === undefined) return
    const { channelRef: _channelRef, taskRef: _taskRef, threadRef: _threadRef, taskNumber: _taskNumber, threadOrigin: _threadOrigin, focusSequence: _focusSequence, inbox: _inbox, tasks: _tasks, sessionHistory: _sessionHistory, ...base } = this.snapshot
    this.snapshot = { ...base, messages: true }
    this.commit()
  }

  /** Same face discipline as the Inbox: one Member's history page owns the seat while its flag stands. */
  private setSessionHistory(memberId: AgentTeamMemberId): void {
    if (this.snapshot.sessionHistory === memberId && this.snapshot.channelRef === undefined && this.snapshot.threadRef === undefined && this.snapshot.messages !== true) return
    const { channelRef: _channelRef, taskRef: _taskRef, threadRef: _threadRef, taskNumber: _taskNumber, threadOrigin: _threadOrigin, focusSequence: _focusSequence, inbox: _inbox, tasks: _tasks, messages: _messages, ...base } = this.snapshot
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

  private setThread(threadRef: AgentTeamThreadRef | undefined, channelRef?: AgentTeamChannelRef, taskRef?: AgentTeamTaskRef, taskNumber?: number, origin?: TeamThreadOrigin, focusSequence?: number): void {
    if (this.snapshot.threadRef === threadRef && this.snapshot.taskRef === taskRef && this.snapshot.channelRef === channelRef && this.snapshot.taskNumber === taskNumber && this.snapshot.threadOrigin === origin && this.snapshot.focusSequence === focusSequence && this.snapshot.inbox !== true && this.snapshot.tasks !== true && this.snapshot.messages !== true && this.snapshot.sessionHistory === undefined) return
    if (threadRef === undefined) {
      const { taskRef: _taskRef, threadRef: _threadRef, taskNumber: _taskNumber, threadOrigin: _threadOrigin, focusSequence: _focusSequence, sessionHistory: _sessionHistory, ...base } = this.snapshot
      this.snapshot = base
    } else {
      const { channelRef: _channelRef, taskRef: _taskRef, threadRef: _threadRef, taskNumber: _taskNumber, threadOrigin: _threadOrigin, focusSequence: _focusSequence, inbox: _inbox, tasks: _tasks, messages: _messages, sessionHistory: _sessionHistory, ...base } = this.snapshot
      this.snapshot = {
        ...base,
        threadRef,
        ...(channelRef === undefined ? {} : { channelRef }),
        ...(taskRef === undefined ? {} : { taskRef }),
        ...(taskNumber === undefined ? {} : { taskNumber }),
        ...(origin === undefined ? {} : { threadOrigin: origin }),
        ...(focusSequence === undefined ? {} : { focusSequence }),
      }
    }
    this.commit()
  }

  /** Back from the open Thread to the list it was entered from, else its Channel. */
  private leaveThread(): void {
    const origin = this.snapshot.threadOrigin
    if (origin === 'inbox') { this.setInbox(); return }
    if (origin === 'tasks') { this.setTasks(); return }
    if (origin === 'messages') { this.setMessages(); return }
    this.setThread(undefined)
  }

  /**
   * One dock tab's face restored as one durable write: the tab's Workspace
   * (when it carries one and it differs — which also drops every leaf face,
   * since faces never cross Workspaces) and then the leaf face itself. The
   * global list faces keep the current Workspace, like their own actions do.
   */
  private applyTabFace(face: TeamTabFace): void {
    const base = this.snapshot
    const moveWorkspace = face.workspaceId !== undefined && base.workspaceId !== face.workspaceId
    let next: TeamNavigationSnapshot
    if (moveWorkspace || face.kind === 'overview') {
      const { channelRef: _channelRef, taskRef: _taskRef, threadRef: _threadRef, taskNumber: _taskNumber, threadOrigin: _threadOrigin, focusSequence: _focusSequence, inbox: _inbox, tasks: _tasks, messages: _messages, sessionHistory: _sessionHistory, ...rest } = base
      next = { ...rest, ...(face.workspaceId === undefined ? {} : { workspaceId: face.workspaceId }) }
    } else {
      const { channelRef: _channelRef, taskRef: _taskRef, threadRef: _threadRef, taskNumber: _taskNumber, threadOrigin: _threadOrigin, focusSequence: _focusSequence, inbox: _inbox, tasks: _tasks, messages: _messages, sessionHistory: _sessionHistory, ...rest } = base
      next = rest
    }
    switch (face.kind) {
      case 'overview': break
      case 'inbox': next = { ...next, inbox: true }; break
      case 'tasks': next = { ...next, tasks: true }; break
      case 'messages': next = { ...next, messages: true }; break
      case 'channel':
        next = { ...next, ...(face.channelRef === undefined ? {} : { channelRef: face.channelRef }) }
        break
      case 'thread':
        next = {
          ...next,
          ...(face.threadRef === undefined ? {} : { threadRef: face.threadRef }),
          ...(face.channelRef === undefined ? {} : { channelRef: face.channelRef }),
          ...(face.taskRef === undefined ? {} : { taskRef: face.taskRef }),
          ...(face.taskNumber === undefined ? {} : { taskNumber: face.taskNumber }),
          ...(face.threadOrigin === undefined ? {} : { threadOrigin: face.threadOrigin }),
        }
        break
      case 'sessionHistory':
        next = { ...next, ...(face.memberId === undefined ? {} : { sessionHistory: face.memberId }) }
        break
    }
    if (sameSnapshotFacts(base, next)) return
    this.snapshot = next
    this.commit()
  }

  private commit(): void {
    persistSnapshot(this.snapshot)
    for (const listener of this.listeners) listener()
  }

}

export { STORAGE_KEY }
