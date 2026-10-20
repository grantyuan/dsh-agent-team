/**
 * Team-owned output-truncation escalation.
 *
 * The response guard heals a Member that stops by itself mid-work. This policy
 * covers the stop the provider forces instead: a turn that ends at the
 * per-request output-token cap (`turn/end` reason `max-tokens`). The Member's
 * reply is cut off and the partial answer stays in its Session; the guard's
 * bounded in-loop nudges may spend themselves re-running one oversized answer
 * that hits the cap again, and when they stand down the Member simply sits
 * stopped — the same call the Web UI offers the Human as "send continue".
 * Escalation therefore wakes the Workspace's designated leader
 * (`member.leader`) to decide what happens to the Member: order a chunked
 * restart, reassign the work, or leave it stopped for the Human.
 *
 * One episode per Member: the truncation stop delivers once to every
 * Workspace where an enabled leader other than the Member herself is
 * designated, then latches per (Member, Workspace) for
 * {@link TRUNCATION_ESCALATION_COOLDOWN_MS} — a Member that keeps truncating
 * inside one window is the same unresolved situation, not new information. A
 * clean marker stop closes the episode, so the next truncation escalates
 * fresh. A Member with no eligible leader anywhere logs once per episode
 * instead of spamming every stop.
 *
 * Episodes and latches are process-local, exactly like the watcher's
 * counters, and every notice is an ordinary ledger Message, so a crash around
 * a delivery replays as a normal ledger. Deliberate boundary: the activation
 * tail-scan never re-opens a truncated turn across a restart — the cap is
 * reached while the Host is watching, and a Member restored over old
 * truncated work stays quiet until it moves again.
 * @module @wowyuarm/dsh-agent-team/truncation-escalation
 */

import type { AgentTeamMemberId } from './types.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'

/** A repeat escalation for the same (Member, Workspace) never fires inside this window. */
export const TRUNCATION_ESCALATION_COOLDOWN_MS = 10 * 60 * 1000

/**
 * Stable first-line marker of the escalation notice. It names the notice in a
 * Channel and follows the watcher's and liaison's marker convention.
 */
export const TRUNCATION_ESCALATION_MARKER = 'Output truncation check:'

/** The enabled designated leader one escalation addresses. */
export interface TruncationLeader {
  readonly memberId: AgentTeamMemberId
  readonly handle: string
}

export interface TruncationEscalationOptions {
  /** The Workspaces one Member participates in, at stop time. */
  readonly workspacesOf: (memberId: AgentTeamMemberId) => readonly WorkspaceId[]
  /** The enabled designated leader of one Workspace, or undefined. */
  readonly leaderOf: (workspaceId: WorkspaceId) => TruncationLeader | undefined
  /** The Member's handle for message bodies; undefined once the Member left the roster. */
  readonly handleOf: (memberId: AgentTeamMemberId) => string | undefined
  /** Post the escalation notice for one leader. A throw is logged; the latch still holds. */
  readonly notify: (input: { readonly memberId: AgentTeamMemberId, readonly memberHandle: string, readonly workspaceId: WorkspaceId, readonly leader: TruncationLeader }) => Promise<void>
  /** Log one coordinator diagnostic. */
  readonly log: (message: string) => void
  readonly cooldownMs?: number
  /** Clock seam for the cooldown; tests drive it directly. */
  readonly now?: () => number
}

/**
 * The event-driven policy behind {@link truncationEscalationText}: called
 * from the Host's `turn/end` observation, it never runs a pass of its own.
 */
export class TruncationEscalator {
  private readonly latched = new Map<string, number>()
  private readonly missingLeaderLogged = new Set<AgentTeamMemberId>()
  private readonly cooldownMs: number
  private readonly now: () => number
  private disposed = false

  constructor(private readonly options: TruncationEscalationOptions) {
    this.cooldownMs = options.cooldownMs ?? TRUNCATION_ESCALATION_COOLDOWN_MS
    this.now = options.now ?? (() => Date.now())
  }

  /** Observe one output-token-cap stop and escalate it to the eligible leaders. */
  onTruncatedStop(memberId: AgentTeamMemberId): void {
    if (this.disposed) return
    const memberHandle = this.options.handleOf(memberId)
    if (memberHandle === undefined) {
      this.options.log(`truncation escalation: member '${memberId}' left the roster before it could be named`)
      return
    }
    const now = this.now()
    let eligible = 0
    for (const workspaceId of this.options.workspacesOf(memberId)) {
      const leader = this.options.leaderOf(workspaceId)
      // The designated Leader's own truncation earns no self-escalation: the
      // leader decides for others, and the leader's own recovery is the
      // Human's call, exactly like the liaison's rule for leader completions.
      if (leader === undefined || leader.memberId === memberId) continue
      eligible += 1
      const key = `${memberId}\u0000${workspaceId}`
      const at = this.latched.get(key)
      if (at !== undefined && now - at < this.cooldownMs) continue
      // Latch before delivery: a Member whose notice delivery throws is still
      // one unresolved situation, and the next stop inside the window must
      // not hot-loop on failing sends.
      this.latch(key, now)
      void this.fire(memberId, memberHandle, workspaceId, leader)
    }
    if (eligible === 0 && !this.missingLeaderLogged.has(memberId)) {
      this.options.log(`truncation escalation: member '${memberHandle}' stopped at the output-token cap but no enabled Member other than itself is a designated leader in its Workspaces; nobody to escalate to`)
      this.missingLeaderLogged.add(memberId)
    }
  }

  /** A clean marker stop closes the Member's episode: the next truncation is a fresh event. */
  onCleanStop(memberId: AgentTeamMemberId): void {
    this.missingLeaderLogged.delete(memberId)
    const prefix = `${memberId}\u0000`
    for (const key of [...this.latched.keys()]) {
      if (key.startsWith(prefix)) this.latched.delete(key)
    }
  }

  dispose(): void {
    this.disposed = true
    this.latched.clear()
    this.missingLeaderLogged.clear()
  }

  private latch(key: string, now: number): void {
    this.latched.set(key, now)
  }

  /** Fire-and-forget a delivery: a throw is logged, never rethrown into the event listener. */
  private async fire(memberId: AgentTeamMemberId, memberHandle: string, workspaceId: WorkspaceId, leader: TruncationLeader): Promise<void> {
    try {
      await this.options.notify({ memberId, memberHandle, workspaceId, leader })
    } catch (error) {
      this.options.log(`truncation escalation for leader '${leader.handle}' about member '${memberHandle}' failed in workspace '${workspaceId}': ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/**
 * The escalation notice: posted by the Host in the Team Assistant's voice into
 * the leader's Channel, it names the truncated Member and states the one
 * expectation — the leader decides what happens to it. The `@` mention
 * delivers through the ordinary Inbox path, waking the leader into a turn.
 */
export function truncationEscalationText(input: { readonly leaderHandle: string, readonly memberHandle: string }): string {
  return `@${input.leaderHandle} ${TRUNCATION_ESCALATION_MARKER} ${input.memberHandle} stopped at the output-token cap: its reply was truncated and the partial answer is preserved in its Session. As the designated Team leader the decision is yours — mention ${input.memberHandle} to have it resume the work in smaller chunks (write output into files or post it part by part so it does not hit the cap again), reassign its unfinished work to another Member, or leave it stopped for the Human. Keep each Task's status current so the Human can follow progress.`
}
