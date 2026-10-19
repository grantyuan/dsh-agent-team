/**
 * Team-owned Member supervision policy.
 *
 * A Member that stops in the middle of claimed work does not bring itself back:
 * a runtime error leaves it in an error presence, a failed activation leaves it
 * with no Session at all, and `recovery.ts` stands down after three consecutive
 * recoverable failures and leaves the Member to the operator. This policy is the
 * Host's automatic last resort on top of that. Every pass looks at every enabled
 * Member, and for each one:
 *
 * - an abnormally stopped Member (including a nominally running one that has
 *   produced no durable Session event for {@link SUPERVISION_HUNG_MS} — a wedge,
 *   not work) gets one bring-up attempt per pass, up to
 *   {@link SUPERVISION_MAX_RESTART_ATTEMPTS};
 * - {@link SUPERVISION_MAX_CONSECUTIVE_FAILURES} `agent/error` occurrences with
 *   no clean turn end between them, or {@link SUPERVISION_WINDOW_FAILURES}
 *   occurrences inside {@link SUPERVISION_FAILURE_WINDOW_MS} however separated,
 *   prove it cannot make progress even while it runs. Failure counting is the
 *   Host's whole progress judgment: the context itself is never policed, so a
 *   context the route refuses is just one more failing turn, and the third one
 *   in a row ends in the same reset.
 *
 * Once proven, the Host resets the Member's context itself — the same
 * fresh-context renewal the Human menu performs, privately noticed to the
 * reset Member alone; nothing is broadcast to the Team, because the Member
 * re-orients from its memory and the durable Team history and asks its
 * teammates about whatever stays unclear. The archive-and-replace handover is
 * the last resort when that reset did not heal it: the replacement carries
 * the failed Member's role, private memory, and Channel reach — never its
 * Session log — and asks the Human admin in Channel to reassign the released
 * work.
 *
 * The chain is driven by {@link MemberSupervisor.runTick}, which the periodic
 * pass runs: the Host's open escalations advance first, so a reset that never
 * committed is retried and a reset that did not heal reaches the handover, and
 * a Member the chain already owns is left to it instead of being spent more
 * bring-up nudges. A pass that only ran the bring-up budget would keep waking a
 * Member whose chain had stalled — nudges that change nothing, forever.
 *
 * "Abnormally stopped" is deliberately the dead-or-erroring shape, not the
 * merely-unproductive one: `unavailable` (no live Session, failed activation) or
 * an error presence. A Member that is live and idle with open Claims is waiting
 * by design, and interrupting or replacing it would be a fabricated failure.
 *
 * Counters are process-local by design, exactly like the pressure policy's
 * overflow retry: a restart re-earns the budget, while every durable result
 * (the reset, archival, the new Member, the released Claims, the notice Message)
 * is an ordinary ledger operation, so a crash mid-escalation replays as a normal
 * ledger and never as a half-faked Team fact.
 * @module @wowyuarm/dsh-agent-team/supervisor
 */

import type { AgentTeamCompletedWork, AgentTeamMemberId } from './types.ts'

/** How often one supervision pass runs once the Host has restored its Members. */
export const SUPERVISION_INTERVAL_MS = 10 * 60 * 1000

/** Bring-up attempts a stopped Member gets before it is replaced instead. */
export const SUPERVISION_MAX_RESTART_ATTEMPTS = 3

/** Consecutive `agent/error` occurrences that replace a Member outright. */
export const SUPERVISION_MAX_CONSECUTIVE_FAILURES = 3

/**
 * Windowed failure rate: this many `agent/error` occurrences inside
 * {@link SUPERVISION_FAILURE_WINDOW_MS} count as "multiple failures in twenty
 * minutes" even when a clean turn separates them — a Member that keeps
 * erroring on every retry of the same work cannot make progress, however often
 * a turn technically ends.
 */
export const SUPERVISION_WINDOW_FAILURES = 3

/** The rolling window {@link SUPERVISION_WINDOW_FAILURES} failures are counted in. */
export const SUPERVISION_FAILURE_WINDOW_MS = 20 * 60 * 1000

/**
 * A Member whose Agent has been running with no durable Session event for this
 * long reads as hung ("stuck"): a healthy turn produces events continuously,
 * so half an hour of silence while nominally running is a wedge, not work.
 */
export const SUPERVISION_HUNG_MS = 30 * 60 * 1000

/** What one pass observes about one Member. */
export type MemberSupervisionState =
  /** Live and reachable: any open failure record is cleared. */
  | 'healthy'
  /** A transition the policy must not interrupt (context rollover, running turn). */
  | 'settling'
  /** Abnormally stopped: no live Session, or an error presence. */
  | 'stopped'

/** Why the policy gave up on one Member. */
export type SupervisionTrigger = 'abnormal-stop' | 'consecutive-failures' | 'failure-rate' | 'hung'

export interface SupervisorOptions {
  /** Every enabled Member: the watch list. */
  readonly candidates: () => readonly AgentTeamMemberId[]
  /** Current supervision state of one watched Member. */
  readonly stateOf: (memberId: AgentTeamMemberId) => MemberSupervisionState
  /** One bounded bring-up attempt; the next pass re-reads the state to judge it. */
  readonly restart: (memberId: AgentTeamMemberId) => Promise<void>
  /**
   * One proven episode: the Host opens the coercion chain with its own
   * private context reset, and the archive-and-replace handover follows on a
   * later pass only while the Member still reads abnormal. `restartAttempts`
   * is the bring-up count already spent, which the handover notice reports
   * verbatim.
   */
  readonly replace: (memberId: AgentTeamMemberId, trigger: SupervisionTrigger, restartAttempts: number) => Promise<void>
  /**
   * Advance the Host's open coercion chains, run by {@link MemberSupervisor.runTick}
   * ahead of every periodic bring-up pass: a reset that never committed retries
   * here, and a reset that did not heal becomes the handover. Absent, the tick
   * degenerates to the bring-up pass alone (a policy-only harness).
   */
  readonly advanceEscalations?: () => Promise<void>
  /**
   * Whether the coercion chain already owns this Member. While it does, the
   * pass spends no bring-up nudge: the chain's own step is the remedy, and a
   * nudge only keeps the Member running past the boundary that step waits on.
   */
  readonly escalationOpen?: (memberId: AgentTeamMemberId) => boolean
  /** Log one coordinator diagnostic. */
  readonly log: (message: string) => void
  readonly intervalMs?: number
  readonly maxRestartAttempts?: number
  readonly maxConsecutiveFailures?: number
  readonly windowFailures?: number
  readonly failureWindowMs?: number
}

interface WatchedMember {
  restartAttempts: number
  consecutiveFailures: number
  /** Timestamps of recent `agent/error` occurrences, pruned to the rolling window. */
  failureTimes: number[]
}

export class MemberSupervisor {
  private readonly watched = new Map<AgentTeamMemberId, WatchedMember>()
  private readonly intervalMs: number
  private readonly maxRestartAttempts: number
  private readonly maxConsecutiveFailures: number
  private readonly windowFailures: number
  private readonly failureWindowMs: number
  private timer: ReturnType<typeof setInterval> | undefined
  private passRunning = false
  /** Serializes the whole periodic tick (escalation advance plus bring-up pass). */
  private tickRunning = false
  private disposed = false

  constructor(private readonly options: SupervisorOptions) {
    this.intervalMs = options.intervalMs ?? SUPERVISION_INTERVAL_MS
    this.maxRestartAttempts = options.maxRestartAttempts ?? SUPERVISION_MAX_RESTART_ATTEMPTS
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? SUPERVISION_MAX_CONSECUTIVE_FAILURES
    this.windowFailures = options.windowFailures ?? SUPERVISION_WINDOW_FAILURES
    this.failureWindowMs = options.failureWindowMs ?? SUPERVISION_FAILURE_WINDOW_MS
  }

  /** Begin the periodic pass; called once the Host has restored every Member. */
  start(): void {
    if (this.disposed || this.timer !== undefined) return
    this.timer = setInterval(() => { void this.runTick() }, this.intervalMs)
    this.timer.unref?.()
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    this.watched.clear()
  }

  /**
   * Observe one `agent/error` occurrence. A Member that fails
   * {@link SUPERVISION_MAX_CONSECUTIVE_FAILURES} times without ever finishing a
   * turn cleanly starts the coercion chain on the spot — waiting for the next
   * pass would only burn more of the same failing route. The consecutive
   * streak is judged first because it is the sharper evidence; the rolling
   * window then still catches the Member that keeps failing on every retry of
   * the same work however often a turn technically ends. Only the watch list
   * is counted: an erroring Member with no open Claim has nothing to hand
   * over yet, and the pass leaves it to the operator exactly as
   * `recovery.ts` does.
   *
   * `diagnostic` is the recorded failure text, kept for future classification;
   * a caller with no text to record passes none and is judged on the failure
   * counts alone.
   */
  onError(memberId: AgentTeamMemberId, diagnostic = ''): void {
    if (this.disposed || !this.watched.has(memberId) && !this.options.candidates().includes(memberId)) return
    const watched = this.entryFor(memberId)
    const now = Date.now()
    watched.failureTimes.push(now)
    watched.failureTimes = watched.failureTimes.filter(time => now - time <= this.failureWindowMs)
    watched.consecutiveFailures += 1
    if (watched.consecutiveFailures >= this.maxConsecutiveFailures) {
      const attempts = watched.restartAttempts
      this.watched.delete(memberId)
      void this.replace(memberId, 'consecutive-failures', attempts)
      return
    }
    if (watched.failureTimes.length < this.windowFailures) return
    const attempts = watched.restartAttempts
    this.watched.delete(memberId)
    void this.replace(memberId, 'failure-rate', attempts)
  }

  /** A turn that ended without an error: the failure streak is over. */
  onCleanTurn(memberId: AgentTeamMemberId): void {
    const watched = this.watched.get(memberId)
    if (watched === undefined) return
    watched.consecutiveFailures = 0
  }

  /**
   * One periodic supervision tick: the Host's open coercion chains advance
   * first, then the bring-up pass runs. The whole tick is serialized like a
   * single pass — a slow chain step skips its turn rather than queueing another
   * tick behind it — so escalation and bring-up never run concurrently for the
   * same Member.
   */
  async runTick(): Promise<void> {
    if (this.disposed || this.tickRunning) return
    this.tickRunning = true
    try {
      if (this.options.advanceEscalations !== undefined) {
        try {
          await this.options.advanceEscalations()
        } catch (error) {
          this.options.log(`supervision escalation advance threw: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      await this.runPass()
    } finally {
      this.tickRunning = false
    }
  }

  /**
   * One supervision pass. Overlapping passes are skipped rather than queued: a
   * pass that is still running when the timer fires is doing its job, and the
   * handover it performs is serialized on the Host's lifecycle queue anyway.
   */
  async runPass(): Promise<void> {
    if (this.disposed || this.passRunning) return
    this.passRunning = true
    try {
      const candidates = new Set(this.options.candidates())
      for (const memberId of [...this.watched.keys()]) {
        if (!candidates.has(memberId)) this.watched.delete(memberId)
      }
      for (const memberId of candidates) {
        if (this.disposed) return
        const watched = this.entryFor(memberId)
        const state = this.options.stateOf(memberId)
        if (state === 'settling') continue
        if (state === 'healthy') {
          this.watched.delete(memberId)
          continue
        }
        // A Member the coercion chain already owns waits on the chain's next
        // step, not on another nudge: bring-up attempts spent while a reset is
        // pending only keep the Member running past the boundary that reset
        // needs.
        if (this.options.escalationOpen?.(memberId) === true) continue
        if (watched.restartAttempts >= this.maxRestartAttempts) {
          const attempts = watched.restartAttempts
          this.watched.delete(memberId)
          await this.replace(memberId, 'abnormal-stop', attempts)
          continue
        }
        watched.restartAttempts += 1
        try {
          await this.options.restart(memberId)
        } catch (error) {
          this.options.log(`supervision restart failed for member '${memberId}': ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    } finally {
      this.passRunning = false
    }
  }

  private entryFor(memberId: AgentTeamMemberId): WatchedMember {
    const existing = this.watched.get(memberId)
    if (existing !== undefined) return existing
    const created: WatchedMember = { restartAttempts: 0, consecutiveFailures: 0, failureTimes: [] }
    this.watched.set(memberId, created)
    return created
  }

  /**
   * How many `agent/error` occurrences one Member recorded inside `windowMs`.
   * The Host's status surface reports this so a supervisor tool can show the
   * same "multiple failures in twenty minutes" evidence the policy acts on.
   */
  recentFailureCount(memberId: AgentTeamMemberId, windowMs: number): number {
    const watched = this.watched.get(memberId)
    if (watched === undefined) return 0
    const now = Date.now()
    return watched.failureTimes.filter(time => now - time <= windowMs).length
  }

  private async replace(memberId: AgentTeamMemberId, trigger: SupervisionTrigger, restartAttempts: number): Promise<void> {
    if (this.disposed) return
    try {
      await this.options.replace(memberId, trigger, restartAttempts)
    } catch (error) {
      // A failed handover leaves the Member exactly as it was: archived or not by
      // the ledger's own facts, and the next pass sees the same stopped state.
      this.options.log(`supervision handover failed for member '${memberId}' (${trigger}): ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/**
 * The next generation handle for a replaced Member: `<role>-2`, `<role>-3`, …
 *
 * Archival hides a Member without releasing its handle (an archived Member still
 * claims its name in the ledger's uniqueness check), so a replacement always
 * takes a numbered generation. The numbering is per role, not per failure: a
 * trailing `-N` on the failed handle is read as its generation and the next one
 * follows it, so a role that keeps dying walks `builder-2 → builder-3` instead of
 * stacking `builder-2-2-2`. Every earlier generation — archived or live — is
 * skipped, and comparison follows the ledger's own handle normalization so a
 * replacement can never fork the `@` namespace.
 */
export function nextReplacementHandle(base: string, takenHandles: Iterable<string>): string {
  const taken = new Set<string>()
  for (const handle of takenHandles) taken.add(handle.normalize('NFKC').trim().toLowerCase())
  const stem = base.normalize('NFKC').trim()
  const generation = /^(.*)-(\d+)$/.exec(stem)
  const role = generation === null || generation[1] === '' ? stem : generation[1]!
  const first = generation === null ? 2 : Number(generation[2]) + 1
  if (!Number.isSafeInteger(first)) throw new Error(`'${base}' has no usable generation number`)
  for (let next = first; ; next += 1) {
    const candidate = `${role}-${next}`
    if (!taken.has(candidate.normalize('NFKC').trim().toLowerCase())) return candidate
  }
}

/** One released Claim summarized for the admin handover notice. */
export interface SupervisionReleasedClaim {
  readonly direction: string
  readonly taskNumber: number
}

/**
 * A best-effort plain-language recap of the retired Member's final Session,
 * produced by the one-shot propose-only digest. It is not a Team fact: it is
 * appended to the retirement notice only when the call resolved in time.
 */
export interface SupervisionSessionRecap {
  readonly summary: string
  readonly keyPoints: readonly string[]
}

/**
 * The structured retirement notice posted into the affected business Channel
 * when a Member is archived and replaced. It is a plain-text headed block — the
 * Human admin's voice renders literally in the Client, so the body carries no
 * Markdown — listing the retirement cause, the work the Member finished in
 * service (from the ledger projection), the work left unclaimed again (the
 * released Claims), and the succession line.
 *
 * `sessionRecap` is optional and best-effort: when the retired Member's final
 * Session was recapable, its summary rides the notice as a `Final Session
 * recap` block; when the call timed out, aborted, or failed, the notice is
 * unchanged apart from the missing block.
 *
 * `addressedHandle` names who the reassignment ask mentions — the designated
 * leader when the notice is delivered to them, `human` when it falls back to a
 * Channel broadcast — so the same body reaches whoever is expected to act.
 */
export function supervisionRetirementNotice(input: {
  readonly failedHandle: string
  readonly replacementHandle: string
  readonly addressedHandle: string
  readonly trigger: SupervisionTrigger
  readonly restartAttempts: number
  readonly maxRestartAttempts: number
  readonly maxConsecutiveFailures: number
  readonly maxWindowFailures: number
  readonly maxFailureWindowMs: number
  readonly completedWork: AgentTeamCompletedWork
  readonly releasedClaims: readonly SupervisionReleasedClaim[]
  readonly sessionRecap?: SupervisionSessionRecap
}): string {
  const cause = input.trigger === 'abnormal-stop'
    ? `stopped abnormally and stayed stopped after ${input.restartAttempts}/${input.maxRestartAttempts} bring-up attempts`
    : input.trigger === 'failure-rate'
      ? `failed ${input.maxWindowFailures} times within ${Math.round(input.maxFailureWindowMs / 60000)} minutes`
      : `failed ${input.maxConsecutiveFailures} turns in a row without finishing any of them`
  const finished = input.completedWork.finishedDirections.length === 0
    ? '- none recorded'
    : input.completedWork.finishedDirections.map(direction => `- ${direction.direction} (task #${direction.taskNumber})`).join('\n')
  const released = input.releasedClaims.length === 0
    ? '- none (its Claims were already released)'
    : input.releasedClaims.map(claim => `- ${claim.direction} (task #${claim.taskNumber})`).join('\n')
  const recap = input.sessionRecap === undefined
    ? []
    : [
        '',
        'Final Session recap:',
        input.sessionRecap.summary,
        ...input.sessionRecap.keyPoints.map(point => `- ${point}`),
      ]
  return [
    `Supervision retirement — ${input.failedHandle}`,
    '',
    `Cause: ${input.failedHandle} ${cause} and was archived.`,
    '',
    'Completed work in service:',
    'Finished directions:',
    finished,
    `Completed tasks: ${input.completedWork.completedTasks.length}`,
    `Participated Threads: ${input.completedWork.participatedThreadCount}`,
    ...recap,
    '',
    'Released work now unclaimed:',
    released,
    `@${input.addressedHandle} please reassign the items above to ${input.replacementHandle}.`,
    '',
    `Succession: ${input.replacementHandle} is ${input.failedHandle}'s same-role replacement: same preset, same pinned settings, inherited private memory, and the same Channel reach.`,
  ].join('\n')
}
