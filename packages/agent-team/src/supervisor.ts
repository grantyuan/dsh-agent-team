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
 *   prove it cannot make progress even while it runs;
 * - a stopped Member whose failure signature proves the bring-up nudge futile
 *   — its own context policy refusing every model request — skips the nudge
 *   and enters the chain on the spot via {@link onBlockedStop}.
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

import type { AgentTeamMemberId } from './types.ts'

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
export type SupervisionTrigger = 'abnormal-stop' | 'consecutive-failures' | 'failure-rate' | 'context-oversize' | 'hung'

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
    this.timer = setInterval(() => { void this.runPass() }, this.intervalMs)
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
   */
  onError(memberId: AgentTeamMemberId): void {
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
   * One proven un-bring-up-able stop, reported by the Host when a stopped
   * Member's failure signature proves a continuation nudge cannot heal it:
   * the Member's own context policy is refusing every model request (a failed
   * or refused hard-limit compaction, a spent forced-compaction budget, an
   * unknown route capacity — see `isPressureRequestBlockDiagnostic`). The next
   * turn is refused before any model call, so the gentle bring-up is skipped
   * and the coercion chain starts on the spot, exactly like a fully spent
   * failure streak: the Host's private context reset first, the
   * archive-and-replace handover only while the Member still reads abnormal
   * afterwards.
   */
  onBlockedStop(memberId: AgentTeamMemberId): void {
    if (this.disposed || !this.watched.has(memberId) && !this.options.candidates().includes(memberId)) return
    const attempts = this.watched.get(memberId)?.restartAttempts ?? 0
    this.watched.delete(memberId)
    void this.replace(memberId, 'context-oversize', attempts)
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
  readonly taskRef?: string
}

/**
 * The public handover notice a replacement Member posts in the failed Member's
 * Channel. It is authored by the replacement, so the Channel sees the new owner
 * asking for the work, and `@human` is the permanent admin alias that carries
 * the ask into the admin's Inbox.
 */
export function supervisionHandoffText(input: {
  readonly failedHandle: string
  readonly replacementHandle: string
  readonly trigger: SupervisionTrigger
  readonly restartAttempts: number
  readonly maxRestartAttempts: number
  readonly maxConsecutiveFailures: number
  readonly maxWindowFailures: number
  readonly maxFailureWindowMs: number
  readonly releasedClaims: readonly SupervisionReleasedClaim[]
}): string {
  const cause = input.trigger === 'abnormal-stop'
    ? `stopped abnormally and stayed stopped after ${input.restartAttempts}/${input.maxRestartAttempts} bring-up attempts`
    : input.trigger === 'failure-rate'
      ? `failed ${input.maxWindowFailures} times within ${Math.round(input.maxFailureWindowMs / 60000)} minutes`
      : input.trigger === 'context-oversize'
        ? 'kept having every model request blocked by its own context pressure policy'
        : `failed ${input.maxConsecutiveFailures} turns in a row without finishing any of them`
  const claims = input.releasedClaims.length === 0
    ? '- none (its Claims were already released)'
    : input.releasedClaims.map(claim => `- ${claim.direction}${claim.taskRef === undefined ? '' : ` (${claim.taskRef})`}`).join('\n')
  return [
    `@human Supervision handover: \`${input.failedHandle}\` ${cause} and was archived.`,
    `I am \`${input.replacementHandle}\`, \`${input.failedHandle}\`'s same-role replacement — same preset, same pinned settings, inherited private memory, and the same Channel reach — and I am now on the team.`,
    'Work it left behind is unclaimed again:',
    claims,
    `@human please reassign the items above to \`${input.replacementHandle}\`.`,
  ].join('\n')
}
