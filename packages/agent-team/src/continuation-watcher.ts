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
 * by a teammate. Latches keep it quiet afterwards: the nudge re-arms only when
 * an Agent actually works again or the open-Task landscape changes (a Task
 * added, completed, or resolved), never on the passage of time alone, and a
 * workspace with no designated leader logs once per episode instead of
 * spamming every pass.
 *
 * Counters are process-local by design, exactly like the supervisor's: the
 * nudge itself is an ordinary ledger operation, so a crash around it replays
 * as a normal ledger and never as a half-faked Team fact.
 * @module @wowyuarm/dsh-agent-team/continuation-watcher
 */

import type { AgentTeamMemberId } from './types.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'

/** How often one continuation pass runs once the Host has restored its Members. */
export const CONTINUATION_INTERVAL_MS = 60 * 1000

/**
 * How long the all-idle, no-ledger-writes shape must hold before one nudge
 * commits. Long enough that a leader finishing a turn, a Human reading, or a
 * handoff in flight resets the hold instead of racing it.
 */
export const CONTINUATION_QUIET_MS = 2 * 60 * 1000

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
  /** Every enabled Agent Member: the watch list. */
  readonly watchList: () => readonly AgentTeamMemberId[]
  /** Current presence of one watched Member. */
  readonly presenceOf: (memberId: AgentTeamMemberId) => 'available' | 'working' | 'error' | 'unavailable'
  /** Every open Task across all Workspaces, at pass time. */
  readonly incompleteTasks: () => readonly ContinuationTask[]
  /** The enabled designated leader of one Workspace, or undefined. */
  readonly leaderOf: (workspaceId: WorkspaceId) => ContinuationLeader | undefined
  /** The durable ledger position; any commit resets the quiet hold. */
  readonly ledgerPosition: () => number
  /** Deliver one nudge; a throw is logged and retried on a later episode. */
  readonly notify: (input: { readonly workspaceId: WorkspaceId; readonly leader: ContinuationLeader; readonly tasks: readonly ContinuationTask[] }) => Promise<void>
  /** Log one coordinator diagnostic. */
  readonly log: (message: string) => void
  readonly intervalMs?: number
  readonly quietMs?: number
}

export class TaskContinuationWatcher {
  private readonly intervalMs: number
  private readonly quietMs: number
  private timer: ReturnType<typeof setInterval> | undefined
  private passRunning = false
  private disposed = false
  /** When the current all-idle stretch began; undefined while any Member works, errors, or is between stretches. */
  private idleSince: number | undefined
  /** A nudge committed for this episode; time alone never re-arms it. */
  private nudged = false
  /** The open-Task landscape this episode was armed on; any change re-arms. */
  private incompleteSignature = ''
  /** Missing-leader diagnostics are logged once per episode, not every pass. */
  private missingLeaderLogged = false
  private lastLedgerPosition = -1

  constructor(private readonly options: ContinuationWatcherOptions) {
    this.intervalMs = options.intervalMs ?? CONTINUATION_INTERVAL_MS
    this.quietMs = options.quietMs ?? CONTINUATION_QUIET_MS
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

  /**
   * One continuation pass. Overlapping passes are skipped rather than queued,
   * exactly like the supervision pass: the deliver step is serialized on the
   * Host's send path anyway.
   */
  async runPass(now = Date.now()): Promise<void> {
    if (this.disposed || this.passRunning) return
    this.passRunning = true
    try {
      const watchList = this.options.watchList()
      const ledgerPosition = this.options.ledgerPosition()
      const incompleteTasks = this.options.incompleteTasks()
      const signature = incompleteTasks.map(task => `${task.workspaceId}\u0000${task.taskRef}\u0000${task.status}`).sort().join('\u0001')
      const working = watchList.some(memberId => this.options.presenceOf(memberId) === 'working')
      // Re-arm only on meaningful change: an Agent actually working again, or
      // the open-Task landscape moving. Time alone never clears the latch —
      // otherwise a leader that stays stopped would be nudged every quiet
      // period forever.
      if (working || signature !== this.incompleteSignature) this.nudged = false
      // The quiet hold (re)starts when the all-idle stretch begins and
      // restarts on any ledger commit while idle — a Human reading or writing
      // counts too, so nobody is nudged while the Human is actively managing
      // the Team. The hold also arms on the first all-idle pass with no write
      // since the last working one: an Agent's final Message commits while it
      // still reads as working, so its stop need not land a new write.
      const allIdle = watchList.length > 0 && watchList.every(memberId => this.options.presenceOf(memberId) === 'available')
      if (!allIdle) {
        this.idleSince = undefined
        this.missingLeaderLogged = false
      } else if (this.idleSince === undefined || ledgerPosition !== this.lastLedgerPosition) {
        this.idleSince = now
        this.missingLeaderLogged = false
      }
      this.lastLedgerPosition = ledgerPosition
      this.incompleteSignature = signature
      if (!allIdle || this.idleSince === undefined || this.nudged) return
      if (now - this.idleSince < this.quietMs) return
      const byWorkspace = new Map<WorkspaceId, ContinuationTask[]>()
      for (const task of incompleteTasks) {
        const bucket = byWorkspace.get(task.workspaceId)
        if (bucket === undefined) byWorkspace.set(task.workspaceId, [task])
        else bucket.push(task)
      }
      let fired = false
      for (const [workspaceId, tasks] of byWorkspace) {
        const leader = this.options.leaderOf(workspaceId)
        if (leader === undefined) {
          if (!this.missingLeaderLogged) {
            this.options.log(`continuation watcher: open Tasks remain in workspace '${workspaceId}' but no enabled Member is designated leader; nobody to nudge`)
            this.missingLeaderLogged = true
          }
          continue
        }
        try {
          await this.options.notify({ workspaceId, leader, tasks })
          fired = true
        } catch (error) {
          this.options.log(`continuation nudge for leader '${leader.handle}' failed in workspace '${workspaceId}': ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (fired) this.nudged = true
    } finally {
      this.passRunning = false
    }
  }
}

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
    `@${input.leaderHandle} Continuation check: every Agent is stopped, but these Task(s) are still open:`,
    ...input.tasks.map(task => `- ${task.taskRef}${task.taskNumber > 0 ? ` (#${task.taskNumber})` : ''} — ${task.status} — ${task.subject}`),
    'Please continue the unfinished work: pick up or reassign the Tasks above, and keep each Task\'s status current so the Human can follow progress. Mention the Human only when a decision is owed.',
  ]
  return lines.join('\n')
}
