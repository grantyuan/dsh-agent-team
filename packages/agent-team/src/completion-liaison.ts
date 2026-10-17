/**
 * Team-owned completion liaison.
 *
 * The continuation watcher asks one designated leader when the whole Team has
 * gone quiet. This policy covers the narrower per-Member moment the operator
 * asked for: a Member finishes its work (a `completed` stop whose last round
 * carried the 任务结束 marker) and goes idle. At that point:
 *
 * - if the Workspace has an enabled designated leader other than the Member
 *   itself, and the Member addressed no report to that leader after finishing
 *   (a Channel message naming the leader or a DM — the scan runs over the
 *   ledger tail since the completion), the Host posts one report-check notice
 *   for the leader, so unfinished coordination surfaces immediately instead
 *   of waiting for the whole Team to idle;
 * - if the Workspace has no such leader, the Host pushes the Workspace's
 *   open Tasks directly to the Member itself and lets it decide autonomously
 *   whether to continue. The push states one contract: a Member that declines
 *   begins its final reply with the exact words 拒绝继续. When that refusal
 *   lands at the Member's next marker stop, the Host stops pushing Tasks to
 *   the Member for the process lifetime and relays the Member's own feedback
 *   to `@human` in the Channel — the Human, not the policy, arbitrates next.
 *
 * Evaluation is a periodic pass (like supervision and the continuation
 * watcher), armed behind the same restore gate, so a report that arrives
 * seconds after the completion lands inside the grace window and no notice
 * fires. A cooldown latch per (Member, Workspace, branch) keeps a Member that
 * stops round after round without reporting from re-prompting every pass.
 *
 * Every state here is process-local by design — episodes, decisions, the
 * refused set, and latches are reconstructible, exactly like the watcher's
 * counters — while every effect (the posted notices and the relayed feedback)
 * is an ordinary ledger Message operation. A restart re-earns the policy's
 * memory: a previously refused Member may be pushed once more and refuses
 * again, which the operator reads as acceptable churn against the alternative
 * of a new ledger fact kind.
 * @module @wowyuarm/dsh-agent-team/completion-liaison
 */

import type { AgentTeamContextCheckpointRef, AgentTeamInterruptRef, AgentTeamMemberId } from './types.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { ContinuationTask } from './continuation-watcher.ts'
import { COMPLETION_MARKER } from './response-guard.ts'

/**
 * The exact opening words a Member must use to decline a Task push. Stable:
 * it is quoted verbatim into the push body, so the instruction the model
 * reads and the check that acts on it never drift apart.
 */
export const LIAISON_REFUSAL_PHRASE = '拒绝继续'

/** How often the liaison pass runs once the Host has restored its Members. */
export const LIAISON_INTERVAL_MS = 30 * 1000

/**
 * How long a finished Member gets to address its own report before the
 * liaison acts. Reports usually ride inside the completion round or follow a
 * breath later; the window keeps the race honest without delaying a real
 * gap by more than one pass.
 */
export const LIAISON_REPORT_GRACE_MS = 60_000

/** A repeat notice for the same (Member, Workspace, branch) never fires inside this window. */
export const LIAISON_COOLDOWN_MS = 10 * 60 * 1000

/** An unevaluated completion episode is dropped once the Member has been busy (or gone) this long. */
export const LIAISON_EPISODE_TTL_MS = 15 * 60 * 1000

/** A Task push whose decision never reached a marker stop is forgotten after this long. */
export const LIAISON_DECISION_TTL_MS = 30 * 60 * 1000

/** The refused Member's reply quoted into the `@human` feedback, bounded. */
export const LIAISON_FEEDBACK_MAX_CHARS = 400

/** Stable first lines: they name the notice in a Channel and match the watcher's marker convention. */
export const LIAISON_REPORT_CHECK_MARKER = 'Team report check:'
export const LIAISON_TASK_PUSH_MARKER = 'Task push (no Team leader designated):'
export const LIAISON_DECLINED_PUSH_MARKER = 'Task push declined:'
export const LIAISON_INTERRUPT_PUSH_MARKER = 'Interrupt resume check:'

/**
 * Stable summary of the private resume notice steered into the finished
 * Member's own Session. The context projection reads it as a pure reminder —
 * it never anchors a timeline boundary — and the text restates the full
 * current stack on every delivery, so an older unread instance carries the
 * same information as the newest.
 */
export const INTERRUPT_PUSH_SUMMARY = 'Interrupt resume check: pending interrupted sessions await continuation'

/** One pending interrupt as the resume lane presents it to the Member. */
export interface LiaisonInterrupt {
  readonly interruptRef: AgentTeamInterruptRef
  readonly checkpointRef: AgentTeamContextCheckpointRef
  readonly label: string
}

/** The enabled designated leader one notice addresses. */
export interface LiaisonLeader {
  readonly memberId: AgentTeamMemberId
  readonly handle: string
}

export interface CompletionLiaisonOptions {
  /** The Workspaces one Member participates in, at evaluation time. */
  readonly workspacesOf: (memberId: AgentTeamMemberId) => readonly WorkspaceId[]
  /** Current presence of one Member. */
  readonly presenceOf: (memberId: AgentTeamMemberId) => 'available' | 'working' | 'error' | 'unavailable'
  /** The enabled designated leader of one Workspace, or undefined. */
  readonly leaderOf: (workspaceId: WorkspaceId) => LiaisonLeader | undefined
  /** True when the Member addressed the Leader (a Channel message naming them or a DM) at or after the completion. */
  readonly reportedToLeaderSince: (memberId: AgentTeamMemberId, leaderId: AgentTeamMemberId, sinceSequence: number) => boolean
  /** The Workspace's open Tasks at pass time; an empty list never pushes. */
  readonly openTasksIn: (workspaceId: WorkspaceId) => readonly ContinuationTask[]
  /**
   * The Member's pending interrupt stack, newest first — read from the
   * durable ledger projection, so the resume drive survives resets and
   * restarts. An empty list means the lane is silent for this Member.
   */
  readonly interruptsOf: (memberId: AgentTeamMemberId) => readonly LiaisonInterrupt[]
  /** The Member's handle for message bodies; undefined once the Member left the roster. */
  readonly handleOf: (memberId: AgentTeamMemberId) => string | undefined
  /**
   * Steer the private resume notice into the finished Member's own Session
   * (a runtime delivery like the context-reset notice, never a ledger
   * Message). A throw is logged and the lane stays retryable.
   */
  readonly pushInterrupts: (input: { readonly memberId: AgentTeamMemberId, readonly memberHandle: string, readonly interrupts: readonly LiaisonInterrupt[] }) => Promise<void>
  /** Post the report-check notice for the leader. A throw is logged; the cooldown still latches. */
  readonly notifyLeader: (input: { readonly memberId: AgentTeamMemberId, readonly memberHandle: string, readonly workspaceId: WorkspaceId, readonly leader: LiaisonLeader }) => Promise<void>
  /** Post the open-Task push addressed to the Member itself — only ever a Member that is not the Workspace's designated Leader. */
  readonly pushTasks: (input: { readonly memberId: AgentTeamMemberId, readonly memberHandle: string, readonly workspaceId: WorkspaceId, readonly tasks: readonly ContinuationTask[] }) => Promise<void>
  /** Relay a refusing Member's own feedback to `@human` in the Channel. */
  readonly notifyHumanFeedback: (input: { readonly memberId: AgentTeamMemberId, readonly memberHandle: string, readonly workspaceId: WorkspaceId, readonly feedbackText: string }) => Promise<void>
  /** Log one coordinator diagnostic. */
  readonly log: (message: string) => void
  readonly intervalMs?: number
  readonly graceMs?: number
  readonly cooldownMs?: number
  readonly episodeTtlMs?: number
  readonly decisionTtlMs?: number
  readonly now?: () => number
}

/** One finished turn awaiting the report check. */
interface LiaisonEpisode {
  /** When the stop happened — the grace window measures from here. */
  readonly completedAt: number
  /** When the liaison learned of it (boot-retroactive episodes stamp this now) — the TTL expires from here. */
  readonly openedAt: number
  readonly sinceSequence: number
}

/** One delivered Task push awaiting the Member's autonomous decision. */
interface LiaisonDecision {
  readonly workspaceId: WorkspaceId
  readonly pushedAt: number
  /** The refusal reply captured so far; a marker stop with it set declines the push. */
  refusalText: string | undefined
}

/**
 * The liaison pass over the three maps above: expire stale decisions, then
 * evaluate episodes whose Member has stayed idle past the grace window.
 * Overlapping passes are skipped, never queued — like every other Host pass.
 */
export class CompletionLiaison {
  private readonly episodes = new Map<AgentTeamMemberId, LiaisonEpisode>()
  private readonly decisions = new Map<AgentTeamMemberId, LiaisonDecision>()
  private readonly refused = new Set<AgentTeamMemberId>()
  private readonly latched = new Map<string, number>()
  private readonly intervalMs: number
  private readonly graceMs: number
  private readonly cooldownMs: number
  private readonly episodeTtlMs: number
  private readonly decisionTtlMs: number
  private readonly now: () => number
  private timer: ReturnType<typeof setInterval> | undefined
  private passRunning = false
  private disposed = false

  constructor(private readonly options: CompletionLiaisonOptions) {
    this.intervalMs = options.intervalMs ?? LIAISON_INTERVAL_MS
    this.graceMs = options.graceMs ?? LIAISON_REPORT_GRACE_MS
    this.cooldownMs = options.cooldownMs ?? LIAISON_COOLDOWN_MS
    this.episodeTtlMs = options.episodeTtlMs ?? LIAISON_EPISODE_TTL_MS
    this.decisionTtlMs = options.decisionTtlMs ?? LIAISON_DECISION_TTL_MS
    this.now = options.now ?? (() => Date.now())
  }

  /** Begin the periodic pass; called once the Host has restored every Member. */
  start(): void {
    if (this.disposed || this.timer !== undefined) return
    this.timer = setInterval(() => { void this.runPass() }, this.intervalMs)
    this.timer.unref?.()
  }

  /**
   * Observe one marker-completed stop: it closes any open Task-push decision
   * (a captured refusal is relayed and suppresses all later pushes for this
   * process) and opens one fresh report-check episode. `completedAt` carries
   * the stop's own timestamp for a boot-retroactive episode — a Member whose
   * marker stop was cut across a Host restart still earns its report check
   * once the new process is watching; live callers leave it at now.
   */
  onCompletedStop(memberId: AgentTeamMemberId, sinceSequence: number, completedAt = this.now()): void {
    const decision = this.decisions.get(memberId)
    if (decision !== undefined) {
      this.decisions.delete(memberId)
      const feedback = decision.refusalText
      if (feedback !== undefined) {
        this.refused.add(memberId)
        const memberHandle = this.options.handleOf(memberId) ?? memberId
        void this.fire('declined-push feedback', () => this.options.notifyHumanFeedback({
          memberId, memberHandle, workspaceId: decision.workspaceId, feedbackText: feedback,
        }))
      }
    }
    this.episodes.set(memberId, { completedAt, openedAt: this.now(), sinceSequence })
  }

  /**
   * Observe one assistant response: while a Task push awaits its decision,
   * a reply that opens with the exact refusal phrase records the refusal
   * verbatim (bounded). Only the reply's opening carries the contract — an
   * echo of the phrase mid-sentence stays prose.
   */
  onAssistantText(memberId: AgentTeamMemberId, text: string): void {
    const decision = this.decisions.get(memberId)
    if (decision === undefined || decision.refusalText !== undefined) return
    if (!text.trimStart().startsWith(LIAISON_REFUSAL_PHRASE)) return
    decision.refusalText = text.length > LIAISON_FEEDBACK_MAX_CHARS ? `${text.slice(0, LIAISON_FEEDBACK_MAX_CHARS)}…` : text
  }

  /** One pass; a test or an operator may drive it directly with a chosen clock. */
  async runPass(now = this.now()): Promise<void> {
    if (this.disposed || this.passRunning) return
    this.passRunning = true
    try {
      for (const [memberId, decision] of [...this.decisions]) {
        if (now - decision.pushedAt > this.decisionTtlMs) this.decisions.delete(memberId)
      }
      for (const [memberId, episode] of [...this.episodes]) {
        if (now - episode.openedAt > this.episodeTtlMs) {
          this.episodes.delete(memberId)
          continue
        }
        if (this.options.presenceOf(memberId) !== 'available') continue
        if (now - episode.completedAt < this.graceMs) continue
        this.episodes.delete(memberId)
        await this.evaluateNow(memberId, episode, now)
      }
    } finally {
      this.passRunning = false
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    this.episodes.clear()
    this.decisions.clear()
    this.refused.clear()
    this.latched.clear()
  }

  /** The per-Workspace branch for one finished Member. */
  private async evaluateNow(memberId: AgentTeamMemberId, episode: LiaisonEpisode, now: number): Promise<void> {
    const memberHandle = this.options.handleOf(memberId)
    if (memberHandle === undefined) return
    // The resume lane is per Member, not per Workspace: whatever just
    // finished, the Member's own pinned stack is what it owes next. It runs
    // before (and independently of) the leader branches, because resuming
    // interrupted work is never the leader's report to chase.
    const interrupts = this.options.interruptsOf(memberId)
    if (interrupts.length > 0 && !this.latchedFor(memberId, '', 'resume', now)) {
      this.latch(memberId, '', 'resume', now)
      await this.fire('interrupt resume push', () => this.options.pushInterrupts({ memberId, memberHandle, interrupts }))
    }
    for (const workspaceId of this.options.workspacesOf(memberId)) {
      const leader = this.options.leaderOf(workspaceId)
      // The designated Leader's own completion earns no forced wake: their
      // reporting surface is the Human, and a leader who breaks is handled by
      // the response guard and supervision, not by this liaison. The episode
      // simply consumes itself here.
      if (leader !== undefined && leader.memberId === memberId) continue
      if (leader !== undefined) {
        if (this.options.reportedToLeaderSince(memberId, leader.memberId, episode.sinceSequence)) continue
        if (this.latchedFor(memberId, workspaceId, 'report', now)) continue
        this.latch(memberId, workspaceId, 'report', now)
        await this.fire('report-check notice', () => this.options.notifyLeader({ memberId, memberHandle, workspaceId, leader }))
        continue
      }
      if (this.refused.has(memberId)) continue
      if (this.latchedFor(memberId, workspaceId, 'push', now)) continue
      const tasks = this.options.openTasksIn(workspaceId)
      if (tasks.length === 0) continue
      try {
        await this.options.pushTasks({ memberId, memberHandle, workspaceId, tasks })
      } catch (error) {
        this.options.log(`task push for member '${memberHandle}' in workspace '${workspaceId}' failed: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      // Only a delivered push opens the decision and latches the branch: a
      // failed push stays retryable on the next episode instead of silence.
      this.latch(memberId, workspaceId, 'push', now)
      this.decisions.set(memberId, { workspaceId, pushedAt: now, refusalText: undefined })
    }
  }

  private latchedFor(memberId: AgentTeamMemberId, workspaceId: WorkspaceId | '', kind: string, now: number): boolean {
    const at = this.latched.get(`${memberId}\u0000${workspaceId}\u0000${kind}`)
    return at !== undefined && now - at < this.cooldownMs
  }

  private latch(memberId: AgentTeamMemberId, workspaceId: WorkspaceId | '', kind: string, now: number): void {
    this.latched.set(`${memberId}\u0000${workspaceId}\u0000${kind}`, now)
  }

  /** Fire-and-forget a delivery: a throw is logged, never rethrown into the pass. */
  private async fire(kind: string, run: () => Promise<void>): Promise<void> {
    try {
      await run()
    } catch (error) {
      this.options.log(`completion liaison: ${kind} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/**
 * Quoted text (Task subjects, a Member's own feedback) inside a generated
 * notice must not re-resolve as an authored mention: a subject that opens
 * with `@SomeMember` would otherwise escalate a bystander into a direct
 * recipient of THIS message. Full-width `＠` reads identically to the model
 * yet stays invisible to the mention scanner. The notice's own addressed
 * `@handle` prefixes are authored here intentionally and never pass through.
 */
function sanitizeQuotedText(value: string): string {
  return value.replace(/@/g, '＠')
}

/** The report-check notice: the leader is told a teammate finished, idled, and owes a report. */
export function liaisonReportCheckText(input: { readonly leaderHandle: string, readonly memberHandle: string }): string {
  return `@${input.leaderHandle} ${LIAISON_REPORT_CHECK_MARKER} ${input.memberHandle} finished its latest work and has gone idle without reporting to you as the designated Team leader. Review its recent Tasks and ask it for a status report, or reassign what still needs moving — keep each Task's status current so the Human can follow progress.`
}

/**
 * The private resume notice: the Member that just closed a task is told its
 * own interrupted stack, newest first — the LIFO order the persona's
 * interruption protocol resumes in. The refs are printed bare (never in the
 * `Thread: <ref>` shape a boundary fold would anchor on), and every delivery
 * restates the full current stack.
 */
export function liaisonResumePushText(input: { readonly interrupts: readonly LiaisonInterrupt[] }): string {
  const lines = [
    `${LIAISON_INTERRUPT_PUSH_MARKER} you closed your current work while ${input.interrupts.length} interrupted session(s) remain pinned, newest first:`,
    ...input.interrupts.map(interrupt => `- ${sanitizeQuotedText(interrupt.label)} (ref ${interrupt.interruptRef}; anchor ${interrupt.checkpointRef})`),
    `Pre-completion analysis now: if you have not yet posted the completion report for the work you just finished, post it first. Then resume the newest entry — collect or stop your jobs and call context_rollover citing that entry's anchor ref exactly: the Host closes the entry when the return commits. If an anchor no longer returns (budget or lineage moved), read your memory note for that work, write a fresh handoff carrying its unfinished state, then release the entry with context_interrupt. Do not start unrelated follow-up work before the stack is empty; release anything you will not return to.`,
  ]
  return lines.join('\n')
}

/** The Task push: the Member owns the decision to continue. */
export function liaisonTaskPushText(input: { readonly memberHandle: string, readonly tasks: readonly ContinuationTask[] }): string {
  const lines = [
    `@${input.memberHandle} ${LIAISON_TASK_PUSH_MARKER} this Workspace has no designated Team leader, and these Task(s) are still open:`,
    ...input.tasks.map(task => `- ${task.taskRef}${task.taskNumber > 0 ? ` (#${task.taskNumber})` : ''} — ${task.status} — ${sanitizeQuotedText(task.subject)}`),
    `Decide on your own whether to continue this work. If you take it up, claim and progress the Tasks and keep their status current. If you decline, begin your final reply with the exact words ${LIAISON_REFUSAL_PHRASE} (still closing it with the ${COMPLETION_MARKER} marker as usual): the Team will stop pushing Tasks to you and will relay your feedback to @human in this Channel instead.`,
  ]
  return lines.join('\n')
}

/**
 * The @human relay of a declined push, quoting the Member's own feedback. It
 * posts under the refusing Member's own voice (the auto-prune notice shape):
 * a Human-voiced message could never deliver an `@human` mention to itself,
 * and the decision being relayed is the Member's own.
 */
export function liaisonFeedbackText(input: { readonly feedbackText: string }): string {
  return `@human ${LIAISON_DECLINED_PUSH_MARKER} I declined the Task push for this Workspace. My feedback: "${sanitizeQuotedText(input.feedbackText)}". The Team will stop pushing open Tasks to me — reassign the work or direct me as you see fit.`
}
