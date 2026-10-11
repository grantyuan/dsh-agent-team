/**
 * Team-owned idle continuation policy.
 *
 * The supervisor repairs broken Members; this policy covers the opposite
 * failure: every Agent healthy and stopped normally, yet the Task list still
 * holds open work. Left alone, a Team can idle forever on an unfinished list
 * because the last turn ended without anyone picking the next Task up. Every
 * pass reads the same three facts, and only their combination commits:
 *
 * - every enabled Agent reads `available` presence — stopped normally, not
 *   working, not erroring, not unavailable (the supervisor's territory);
 * - at least one open Task (todo / in_progress / in_review) exists;
 * - that shape has held without any ledger write for
 *   {@link CONTINUATION_QUIET_MS} — a hold that rides out the normal gaps
 *   between turns, a Human actively reading, and a leader mid-handoff.
 *
 * When it commits, the Host posts one continuation nudge into the open work's
 * Channel naming the designated leader (`member.leader`), listing the open
 * Tasks with their statuses. The mention delivers through the ordinary Inbox
 * path, so the leader wakes into a normal turn — exactly like being mentioned
 * by a teammate.
 *
 * Every Workspace with open Tasks keeps its own independent quiet hold, so one
 * Workspace's working Agent or ledger writes never stall or reset another's
 * reminder. Latches keep a delivered nudge quiet until something meaningful
 * changes — an Agent works again, the open-Task landscape moves, or the nudge
 * has sat unheard past {@link CONTINUATION_REARM_MS}, when time alone re-arms
 * it for the next quiet period. A Workspace with no designated leader logs once
 * per episode instead of spamming every pass.
 *
 * Counters are process-local by design, exactly like the supervisor's: the
 * nudge itself is an ordinary ledger operation, so a crash around it replays
 * as a normal ledger and never as a half-faked Team fact.
 * @module @wowyuarm/dsh-agent-team/continuation-watcher
 */

import type { AgentTeamMemberId } from './types.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'

/** How long one continuation pass runs once the Host has restored its Members. */
export const CONTINUATION_INTERVAL_MS = 60 * 1000

/**
 * How long the all-idle, no-ledger-writes shape must hold before one nudge
 * commits. Long enough that a leader finishing a turn, a Human reading, or a
 * handoff in flight resets the hold instead of racing it.
 */
export const CONTINUATION_QUIET_MS = 2 * 60 * 1000

/**
 * Time-based nudge re-arm: how long a delivered nudge stays latched even though
 * the leader never worked and the open-Task landscape never changed. Time alone
 * re-arms past this window, so a leader that ignores its reminder is reminded
 * again instead of the watcher going permanently quiet.
 */
export const CONTINUATION_REARM_MS = 10 * 60 * 1000

/** One open Task the watcher may name in a continuation nudge. */
export interface ContinuationTask {
  readonly workspaceId: WorkspaceId
  readonly taskRef: string
  readonly taskNumber: number
  readonly status: string
  readonly subject: string
}

/** The designated leader one nudge addresses. */
export interface ContinuationLeader {
  readonly memberId: AgentTeamMemberId
  readonly handle: string
}

export interface ContinuationWatcherOptions {
  /** Every enabled Agent Member: the watch list. Kept for back-compat; the per-Workspace runs prefer {@link membersInWorkspace}. */
  readonly watchList: () => readonly AgentTeamMemberId[]
  /** Current presence of one watched Member. */
  readonly presenceOf: (memberId: AgentTeamMemberId) => 'available' | 'working' | 'error' | 'unavailable'
  /** Every open Task across all Workspaces, at pass time. */
  readonly incompleteTasks: () => readonly ContinuationTask[]
  /** The enabled designated leader of one Workspace, or undefined. */
  readonly leaderOf: (workspaceId: WorkspaceId) => ContinuationLeader | undefined
  /** The durable ledger position; any commit resets the quiet hold (global). */
  readonly ledgerPosition: () => number
  /** Deliver one nudge; a throw is logged and retried on a later episode. */
  readonly notify: (input: { readonly workspaceId: WorkspaceId; readonly leader: ContinuationLeader; readonly tasks: readonly ContinuationTask[] }) => Promise<void>
  /** Log one coordinator diagnostic. */
  readonly log: (message: string) => void
  readonly intervalMs?: number
  readonly quietMs?: number
  /** The enabled Members of one Workspace; defaults to {@link watchList}. */
  readonly membersInWorkspace?: (workspaceId: WorkspaceId) => readonly AgentTeamMemberId[]
  /** Committed-operation count of one Workspace; defaults to {@link ledgerPosition}. */
  readonly positionInWorkspace?: (workspaceId: WorkspaceId) => number
  /** Time-based nudge re-arm window; defaults to {@link CONTINUATION_REARM_MS}. */
  readonly rearmMs?: number
}

interface WorkspaceState {
  /** When this Workspace's current all-idle stretch began; undefined while any Member works, errors, or is unavailable. */
  idleSince: number | undefined
  /** A nudge committed for this episode; a working Agent, a changed open-Task landscape, or {@link CONTINUATION_REARM_MS} of silence re-arms it. */
  nudged: boolean
  /** When the last nudge landed; time-based re-arm measures back from here. */
  nudgedAt: number | undefined
  /** This Workspace's open-Task landscape; any change re-arms. */
  incompleteSignature: string
  /** Missing-leader diagnostics are logged once per episode, not every pass. */
  missingLeaderLogged: boolean
  /** This Workspace's durable position as of the last pass; only its own writes restart the hold. */
  lastLedgerPosition: number
}

export class TaskContinuationWatcher {
  private readonly intervalMs: number
  private readonly quietMs: number
  private readonly rearmMs: number
  private timer: ReturnType<typeof setInterval> | undefined
  private passRunning = false
  private disposed = false
  /** Per-Workspace, independent idle/armed state, so one Workspace's activity never stalls another's reminder. */
  private readonly states = new Map<WorkspaceId, WorkspaceState>()

  constructor(private readonly options: ContinuationWatcherOptions) {
    this.intervalMs = options.intervalMs ?? CONTINUATION_INTERVAL_MS
    this.quietMs = options.quietMs ?? CONTINUATION_QUIET_MS
    this.rearmMs = options.rearmMs ?? CONTINUATION_REARM_MS
  }

  /** Begin the periodic pass; called once the Host has restored every Member. */
  start(): void {
    if (this.disposed || this.timer !== undefined) return
    this.timer = setInterval(() => { void this.runPass() }, this.intervalMs)
    this.timer.unref?.()
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  /** The enabled Members of one Workspace, defaulting to the global watch list. */
  private membersIn(workspaceId: WorkspaceId): readonly AgentTeamMemberId[] {
    return this.options.membersInWorkspace !== undefined
      ? this.options.membersInWorkspace(workspaceId)
      : this.options.watchList()
  }

  /** The committed-operation position of one Workspace, defaulting to the global position. */
  private positionIn(workspaceId: WorkspaceId): number {
    return this.options.positionInWorkspace !== undefined
      ? this.options.positionInWorkspace(workspaceId)
      : this.options.ledgerPosition()
  }

  /**
   * One continuation pass. Overlapping passes are skipped rather than queued,
   * exactly like the supervision pass: the deliver step is serialized on the
   * Host's send path anyway.
   */
  async runPass(now = Date.now()): Promise<void> {
    if (this.disposed || this.passRunning) return
    this.passRunning = true
    try {
      const byWorkspace = new Map<WorkspaceId, ContinuationTask[]>()
      for (const task of this.options.incompleteTasks()) {
        const bucket = byWorkspace.get(task.workspaceId)
        if (bucket === undefined) byWorkspace.set(task.workspaceId, [task])
        else bucket.push(task)
      }
      // Forget progress for Workspaces whose open Tasks are all gone.
      for (const workspaceId of [...this.states.keys()]) {
        if (!byWorkspace.has(workspaceId)) this.states.delete(workspaceId)
      }
      for (const [workspaceId, tasks] of byWorkspace) {
        await this.passForWorkspace(now, workspaceId, tasks)
      }
    } finally {
      this.passRunning = false
    }
  }

  private async passForWorkspace(now: number, workspaceId: WorkspaceId, tasks: readonly ContinuationTask[]): Promise<void> {
    let state = this.states.get(workspaceId)
    if (state === undefined) {
      state = { idleSince: undefined, nudged: false, nudgedAt: undefined, incompleteSignature: '', missingLeaderLogged: false, lastLedgerPosition: -1 }
      this.states.set(workspaceId, state)
    }
    const members = this.membersIn(workspaceId)
    const signature = tasks.map(task => `${task.workspaceId}\u0000${task.taskRef}\u0000${task.status}`).sort().join('\u0001')
    const working = members.some(memberId => this.options.presenceOf(memberId) === 'working')
    const position = this.positionIn(workspaceId)
    // Re-arm on meaningful change: an Agent actually working again, the open-Task
    // landscape moving, or a nudge that has sat unheard for {@link rearmMs} —
    // time re-arms so a leader that stays stopped is still reminded, just not
    // every quiet period in a row.
    if (working || signature !== state.incompleteSignature || (state.nudged && state.nudgedAt !== undefined && now - state.nudgedAt > this.rearmMs)) {
      state.nudged = false
      state.nudgedAt = undefined
    }
    // The per-Workspace quiet hold (re)starts when that Workspace's own all-idle
    // stretch begins and restarts only on that Workspace's own commits — activity
    // in unrelated Workspaces must never stall or restretch it.
    const allIdle = members.length > 0 && members.every(memberId => this.options.presenceOf(memberId) === 'available')
    if (!allIdle) {
      state.idleSince = undefined
      state.missingLeaderLogged = false
    } else if (state.idleSince === undefined || position !== state.lastLedgerPosition) {
      state.idleSince = now
      state.missingLeaderLogged = false
    }
    state.lastLedgerPosition = position
    state.incompleteSignature = signature

    const leader = this.options.leaderOf(workspaceId)
    let fired = false
    if (allIdle && state.idleSince !== undefined && !state.nudged && now - state.idleSince >= this.quietMs) {
      if (leader === undefined) {
        if (!state.missingLeaderLogged) {
          this.options.log(`continuation watcher: open Tasks remain in workspace '${workspaceId}' but no enabled Member is designated leader; nobody to nudge`)
          state.missingLeaderLogged = true
        }
      } else {
        try {
          await this.options.notify({ workspaceId, leader, tasks })
          fired = true
          state.nudged = true
          state.nudgedAt = now
        } catch (error) {
          this.options.log(`continuation nudge for leader '${leader.handle}' failed in workspace '${workspaceId}': ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    if (!fired) this.logHoldReason(now, workspaceId, members, allIdle, state)
  }

  /** One compact diagnostic line per non-firing pass, so host logs show which condition blocks a reminder. */
  private logHoldReason(now: number, workspaceId: WorkspaceId, members: readonly AgentTeamMemberId[], allIdle: boolean, state: WorkspaceState): void {
    const available = members.reduce((count, memberId) => this.options.presenceOf(memberId) === 'available' ? count + 1 : count, 0)
    const holdRemainingMs = allIdle && state.idleSince !== undefined
      ? Math.max(0, this.quietMs - (now - state.idleSince))
      : undefined
    this.options.log(
      `continuation watcher diagnostics: workspace '${workspaceId}' members=${members.length} available=${available} all-idle=${allIdle}` +
      ` holdRemainingMs=${holdRemainingMs ?? '-'} nudged=${state.nudged}`,
    )
  }
}

/**
 * The stable first line of every continuation nudge, carried verbatim into the
 * posted Message. The Inbox notification projection matches it to recognize
 * nudges whose newer delivery has superseded them, so the generator and that
 * matcher share one definition.
 */
export const CONTINUATION_NUDGE_MARKER = 'Continuation check: every Agent is stopped, but these Task(s) are still open:'

/**
 * The continuation nudge: posted by the Host under the Human admin's voice
 * into the open work's Channel, it names the leader, lists every open Task
 * with its standing, and states the one expectation — keep the Team moving.
 * The `@` mention is what delivers the Message and wakes the leader.
 */
export function continuationNudgeText(input: {
  readonly leaderHandle: string
  readonly tasks: readonly ContinuationTask[]
}): string {
  const lines = [
    `@${input.leaderHandle} ${CONTINUATION_NUDGE_MARKER}`,
    ...input.tasks.map(task => `- ${task.taskRef}${task.taskNumber > 0 ? ` (#${task.taskNumber})` : ''} — ${task.status} — ${task.subject}`),
    'Please continue the unfinished work: pick up or reassign the Tasks above, and keep each Task\'s status current so the Human can follow progress. Mention the Human only when a decision is owed.',
  ]
  return lines.join('\n')
}
