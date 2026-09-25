/**
 * Team-owned Member supervision policy.
 *
 * A Member that stops in the middle of claimed work does not bring itself back:
 * a runtime error leaves it in an error presence, a failed activation leaves it
 * with no Session at all, and `recovery.ts` stands down after three consecutive
 * recoverable failures and leaves the Member to the operator. This policy is the
 * Host's automatic last resort on top of that. Every pass looks only at enabled
 * Members that still hold active Claims (an idle Member, or one whose work is
 * finished, is nobody's problem), and for each one:
 *
 * - an abnormally stopped Member gets one bring-up attempt per pass, up to
 *   {@link SUPERVISION_MAX_RESTART_ATTEMPTS}; still being stopped afterwards
 *   proves the restart path cannot heal it.
 * - {@link SUPERVISION_MAX_CONSECUTIVE_FAILURES} `agent/error` occurrences with
 *   no clean turn end between them prove it cannot make progress even while it
 *   runs.
 *
 * Either condition hands the work over: the Host archives the failed Member
 * (which releases its Claims publicly), activates a same-role replacement under
 * a `-N` handle carrying the failed Member's private memory and Channel
 * participation, and has the replacement ask the Human admin in Channel to
 * reassign the released work.
 *
 * "Abnormally stopped" is deliberately the dead-or-erroring shape, not the
 * merely-unproductive one: `unavailable` (no live Session, failed activation) or
 * an error presence. A Member that is live and idle with open Claims is waiting
 * by design, and interrupting or replacing it would be a fabricated failure.
 *
 * Counters are process-local by design, exactly like the pressure policy's
 * overflow retry: a restart re-earns the budget, while every durable result
 * (archival, the new Member, the released Claims, the notice Message) is an
 * ordinary ledger operation, so a crash mid-handover replays as a normal ledger
 * and never as a half-faked Team fact.
 * @module @wowyuarm/dsh-agent-team/supervisor
 */

import type { AgentTeamMemberId } from './types.ts'

/** How often one supervision pass runs once the Host has restored its Members. */
export const SUPERVISION_INTERVAL_MS = 10 * 60 * 1000

/** Bring-up attempts a stopped Member gets before it is replaced instead. */
export const SUPERVISION_MAX_RESTART_ATTEMPTS = 3

/** Consecutive `agent/error` occurrences that replace a Member outright. */
export const SUPERVISION_MAX_CONSECUTIVE_FAILURES = 3

/** What one pass observes about one Member. */
export type MemberSupervisionState =
  /** Live and reachable: any open failure record is cleared. */
  | 'healthy'
  /** A transition the policy must not interrupt (context rollover, running turn). */
  | 'settling'
  /** Abnormally stopped: no live Session, or an error presence. */
  | 'stopped'

/** Why the policy gave up on one Member. */
export type SupervisionTrigger = 'abnormal-stop' | 'consecutive-failures'

export interface SupervisorOptions {
  /** Enabled Members with at least one active Claim: the only watch list. */
  readonly candidates: () => readonly AgentTeamMemberId[]
  /** Current supervision state of one watched Member. */
  readonly stateOf: (memberId: AgentTeamMemberId) => MemberSupervisionState
  /** One bounded bring-up attempt; the next pass re-reads the state to judge it. */
  readonly restart: (memberId: AgentTeamMemberId) => Promise<void>
  /**
   * Archive the failed Member and hand its work to a same-role replacement.
   * `restartAttempts` is the bring-up count already spent, which the notice
   * reports verbatim.
   */
  readonly replace: (memberId: AgentTeamMemberId, trigger: SupervisionTrigger, restartAttempts: number) => Promise<void>
  /** Log one coordinator diagnostic. */
  readonly log: (message: string) => void
  readonly intervalMs?: number
  readonly maxRestartAttempts?: number
  readonly maxConsecutiveFailures?: number
}

interface WatchedMember {
  restartAttempts: number
  consecutiveFailures: number
}

export class MemberSupervisor {
  private readonly watched = new Map<AgentTeamMemberId, WatchedMember>()
  private readonly intervalMs: number
  private readonly maxRestartAttempts: number
  private readonly maxConsecutiveFailures: number
  private timer: ReturnType<typeof setInterval> | undefined
  private passRunning = false
  private disposed = false

  constructor(private readonly options: SupervisorOptions) {
    this.intervalMs = options.intervalMs ?? SUPERVISION_INTERVAL_MS
    this.maxRestartAttempts = options.maxRestartAttempts ?? SUPERVISION_MAX_RESTART_ATTEMPTS
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? SUPERVISION_MAX_CONSECUTIVE_FAILURES
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
   * turn cleanly is replaced on the spot — waiting for the next pass would only
   * burn more of the same failing route. Only the watch list is counted: an
   * erroring Member with no open Claim has nothing to hand over yet, and the
   * pass leaves it to the operator exactly as `recovery.ts` does.
   */
  onError(memberId: AgentTeamMemberId): void {
    if (this.disposed || !this.watched.has(memberId) && !this.options.candidates().includes(memberId)) return
    const watched = this.entryFor(memberId)
    watched.consecutiveFailures += 1
    if (watched.consecutiveFailures < this.maxConsecutiveFailures) return
    const attempts = watched.restartAttempts
    this.watched.delete(memberId)
    void this.replace(memberId, 'consecutive-failures', attempts)
  }

  /** A turn that ended without an error: the failure streak is over. */
  onCleanTurn(memberId: AgentTeamMemberId): void {
    const watched = this.watched.get(memberId)
    if (watched === undefined) return
    watched.consecutiveFailures = 0
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
    const created: WatchedMember = { restartAttempts: 0, consecutiveFailures: 0 }
    this.watched.set(memberId, created)
    return created
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
  readonly releasedClaims: readonly SupervisionReleasedClaim[]
}): string {
  const cause = input.trigger === 'abnormal-stop'
    ? `stopped abnormally and stayed stopped after ${input.restartAttempts}/${input.maxRestartAttempts} bring-up attempts`
    : `failed ${input.maxConsecutiveFailures} turns in a row without finishing any of them`
  const claims = input.releasedClaims.length === 0
    ? '- none (its Claims were already released)'
    : input.releasedClaims.map(claim => `- ${claim.direction}${claim.taskRef === undefined ? '' : ` (${claim.taskRef})`}`).join('\n')
  return [
    `@human Supervision handover: \`${input.failedHandle}\` ${cause} and was archived.`,
    `I am \`${input.replacementHandle}\`, the same role with its private memory inherited, and I am now on the team.`,
    'Work it left behind is unclaimed again:',
    claims,
    `@human please reassign the items above to \`${input.replacementHandle}\`.`,
  ].join('\n')
}
