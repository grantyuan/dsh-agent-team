/**
 * Team-owned context pressure policy.
 *
 * The Team preset mounts `compaction-basic` with `auto: false`; this
 * coordinator owns both policy entry points instead — the proactive handoff
 * notice near the effective handoff budget and the forced CompactionEngine
 * reduction before any request at or above the effective hard limit — while
 * reusing the public CompactionEngine implementation. The hard-limit
 * translation lives in exactly one method; no caller re-derives it.
 *
 * The handoff-budget notice is an order, not advice. A Member that receives it
 * and keeps stepping without relieving its own context is given
 * {@link CONTEXT_PRESSURE_MANDATE_AFTER_STEPS} rounds to finish the atomic action
 * it was told to finish, then one reduction order, then
 * {@link CONTEXT_PRESSURE_ENFORCE_AFTER_STEPS} in total before the Host runs the
 * reduction itself — and a context it cannot prove back under the handoff budget
 * stops being the Member's problem to carry: the request is blocked and the
 * Member is handed to the supervision chain's fresh-context reset. Without that
 * consequence the notice was provably ignorable, and an ignoring Member burned
 * hours of failing turns before anything acted.
 *
 * Fail-closed rule: at the hard limit, a compaction that no-ops, throws, is
 * cancelled, or does not advance the durable surface must block the model
 * request (reject the step) rather than knowingly submit over the Team limit.
 * A blocked Member keeps its log and reports a recoverable error.
 * @module @wowyuarm/dsh-agent-team/pressure-policy
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { CompactionEngine } from '@deepseek-ai/dsh-compaction'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { contextPressureNoticeText as engineContextPressureNoticeText } from '@wowyuarm/dsh-context-continuity'
import type { AgentTeamMemberId } from './types.ts'
import { AGENT_TEAM_PLUGIN_ID, isAgentTeamSourceKind } from './context-source.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { advanceOwnedSessionEventCursor, type OwnedSessionEventCursor, type SessionEventFold } from './session-event-cursor.ts'

/**
 * Stable summary of the one-shot rollover pressure notice. It is a durable
 * marker: the notice's own presence in a Session's log is what latches the
 * policy, so the wording is read back and must not drift.
 */
export const CONTEXT_PRESSURE_NOTICE_SUMMARY = 'Context pressure: prepare a handoff'

/**
 * Stable summary of the mandate that follows a pressure notice the Member never
 * acted on: the same durable read-back rule as
 * {@link CONTEXT_PRESSURE_NOTICE_SUMMARY} — the mandate has been issued exactly
 * once per generation because this marker is in the Session's own log.
 */
export const CONTEXT_PRESSURE_MANDATE_SUMMARY = 'Context pressure: reduce now or be reset'

/**
 * Model steps a Member is given after the pressure notice before the Host orders
 * the reduction. The notice tells the Member to finish the atomic action it is
 * in and then reduce; three further steps cover that action plus a memory write
 * and the reduction call themselves.
 */
export const CONTEXT_PRESSURE_MANDATE_AFTER_STEPS = 3

/**
 * Model steps a Member is given, since the same notice, before the Host runs the
 * reduction itself. The count is cumulative, so the order issued past
 * {@link CONTEXT_PRESSURE_MANDATE_AFTER_STEPS} gets two steps of its own: the one
 * it names as its deadline, and one more for a reduction call that lands on a
 * step boundary.
 */
export const CONTEXT_PRESSURE_ENFORCE_AFTER_STEPS = 5

/**
 * Stable prefix of every hard-limit block diagnostic this policy records as a
 * Member failure. The policy is the only writer of these texts; the read-side
 * classifier below shares the constants so a consumer recognizes the class
 * without re-deriving the wording.
 */
const HARD_LIMIT_BLOCK_PREFIX = 'context hard limit'

/** Stable prefix of the capacity-unknown block diagnostic; same single-writer rule as {@link HARD_LIMIT_BLOCK_PREFIX}. */
const POLICY_BLOCK_PREFIX = 'context pressure policy'

/**
 * Whether one Member failure diagnostic is a pressure-policy request block:
 * the policy itself refused the model request — an unknown route capacity, a
 * failed or refused hard-limit compaction, a spent forced-compaction budget, an
 * unproven reduction, or a handoff-budget order the Member never acted on and
 * the Host could not carry out on its behalf either. A Member carrying such a
 * diagnostic has every later turn refused before any model call, so
 * continuation nudging cannot make progress; only a fresh context generation
 * (the supervision reset) or a changed route can. The manual compaction path's
 * failures do not block requests and do not classify.
 */
export function isPressureRequestBlockDiagnostic(diagnostic: string): boolean {
  return diagnostic.startsWith(HARD_LIMIT_BLOCK_PREFIX) || diagnostic.startsWith(POLICY_BLOCK_PREFIX)
}

/**
 * Provider-side signatures that state the context itself no longer fits the
 * route: the window was exceeded, or the provider's own pre-compression could
 * not bring the payload back under it. Each of them means the same thing about
 * a stopped Member as a Team-side request block — the next turn re-sends the
 * same oversized context and fails the same way — so a bring-up nudge cannot
 * heal it and only a fresh context can. Matched conservatively on the recorded
 * diagnostic text; a bare summarizer failure is not this class.
 */
const CONTEXT_CAPACITY_FAILURE_PATTERNS = [
  /exceeds the model window/i,
  /context window exceeded/i,
  /\bCONTEXT_WINDOW_EXCEEDED\b/,
  /\bpreflight_compress_failed\b/,
]

/** Whether one failure diagnostic says the context no longer fits its route. */
export function isContextCapacityFailureDiagnostic(diagnostic: string): boolean {
  return CONTEXT_CAPACITY_FAILURE_PATTERNS.some(pattern => pattern.test(diagnostic))
}

/**
 * Whether this Session's own span already carries the pressure notice: either
 * surfaced as a `user/message` or still queued in a durable
 * `agent/inbox/spliced` insert. Expressed as a fold rather than a scan because
 * the answer is monotone — once delivered it stays delivered for the
 * generation — so the cursor only ever has to read events it has not seen.
 */
export const PRESSURE_NOTICE_FOLD: SessionEventFold<boolean, SessionEvent> = {
  start: false,
  step: (delivered, event) => {
    if (delivered) return true
    if (event.type === 'user/message' && isPressureNotice(event.data, CONTEXT_PRESSURE_NOTICE_SUMMARY)) return true
    if (event.type === 'agent/inbox/spliced' && event.data.inserted.some(message => isPressureNotice(message, CONTEXT_PRESSURE_NOTICE_SUMMARY))) return true
    return false
  },
}

/**
 * The reduction mandate's durable delivery fold — the same monotone shape as
 * {@link PRESSURE_NOTICE_FOLD}, read back under its own summary so a restart
 * never re-issues an order this generation already carries.
 */
export const PRESSURE_MANDATE_FOLD: SessionEventFold<boolean, SessionEvent> = {
  start: false,
  step: (delivered, event) => {
    if (delivered) return true
    if (event.type === 'user/message' && isPressureNotice(event.data, CONTEXT_PRESSURE_MANDATE_SUMMARY)) return true
    if (event.type === 'agent/inbox/spliced' && event.data.inserted.some(message => isPressureNotice(message, CONTEXT_PRESSURE_MANDATE_SUMMARY))) return true
    return false
  },
}

/**
 * One pressure-notice text. The wording is the engine's — the same sentence a
 * fresh-context handoff is asked for through — so the notice and the rollover
 * tool cannot drift apart; Team supplies only its own labels and input shape.
 */
export function contextPressureNoticeText(input: {
  readonly usageTokens: number
  readonly handoffAt: number
  readonly hardLimit: number
  readonly activeClaims: readonly string[]
  readonly runningJobs: readonly string[]
}): string {
  return `${engineContextPressureNoticeText(
    {
      usageTokens: input.usageTokens,
      handoffAt: input.handoffAt,
      hardLimit: input.hardLimit,
      inHand: input.activeClaims,
      jobs: input.runningJobs,
    },
    { inHandLabel: 'Active Claims', jobsLabel: 'Owner jobs' },
  )} This notice is binding: persist what must outlive this context into your private memory, then reduce it — compact it, or hand off with context_rollover — within your next few steps. A Member that keeps stepping above the handoff budget is issued a formal order, and after that the Host acts on the context itself.`
}

/**
 * The reduction order that follows a pressure notice the Member never acted on.
 * Team's own wording, because the consequence is Team's: the notice asked, this
 * commands, and it names the two things the Member owes before its next model
 * step — persist what must survive, then reduce the context — and what happens
 * when a second warning is ignored as well.
 */
export function contextPressureMandateText(input: {
  readonly usageTokens: number
  readonly handoffAt: number
  readonly hardLimit: number
  readonly activeClaims: readonly string[]
  readonly runningJobs: readonly string[]
}): string {
  const claims = input.activeClaims.length === 0 ? 'none' : input.activeClaims.join(', ')
  const jobs = input.runningJobs.length === 0 ? 'none' : `${input.runningJobs.length} running (collect or stop them before switching)`
  return [
    `Context pressure order: ${input.usageTokens} tokens against a handoff budget of ${input.handoffAt} (hard limit ${input.hardLimit}). You were already advised to reduce this context and did not.`,
    `Still held: ${claims}. Owner jobs: ${jobs}.`,
    'Before your next model step, do both of these: write what must outlive this context into your private memory (memory.md and notes/ under the paths in your private-memory block) — durable conclusions, verified facts, and open questions a fresh generation could not reconstruct on its own; then reduce this context, by calling context_rollover with a handoff, or by running the compression your own route provides.',
    'The Host stops asking after this order: it runs the reduction itself on a context you leave above this budget, and a context that cannot be brought back under it is retired in favor of a fresh generation, which re-orients from your private memory and the Team history.',
  ].join('\n')
}

export interface PressurePolicyOptions {
  /** Resolve the live Agent of one Member. */
  readonly agentForMember: (memberId: AgentTeamMemberId) => Agent | undefined
  /** Resolve the durable Member of one live Agent. */
  readonly memberForAgent: (agent: Agent) => { readonly memberId: AgentTeamMemberId; readonly sessionId: Agent['id'] } | undefined
  /** Resolve the Member-scoped compaction engine. */
  readonly compactionForAgent: (agent: Agent) => CompactionEngine | undefined
  /** Effective budgets for one Member's current route; undefined means the route window is unknown. */
  readonly limitsForAgent: (agent: Agent) => Promise<{ readonly usageTokens: number; readonly hardLimit: number; readonly handoffAt: number } | undefined> | { readonly usageTokens: number; readonly hardLimit: number; readonly handoffAt: number } | undefined
  /** The model-visible active-Claim labels for one Member's notice. */
  readonly activeClaimLabels: (memberId: AgentTeamMemberId) => readonly string[]
  /** The model-visible running-job labels for one Member's notice. */
  readonly runningJobLabels: (memberId: AgentTeamMemberId) => readonly string[]
  /** Report a Member failure with a recoverable diagnostic. */
  readonly failed: (memberId: AgentTeamMemberId, sessionId: Agent['id'], diagnostic: string) => void
  /**
   * Report that a recorded request block has ended: a pre-step proved the
   * pressure receded below the hard limit, so a hard-limit block no longer
   * describes this Member's live Session. Absent, stale block records persist.
   */
  readonly healed?: (memberId: AgentTeamMemberId) => void
  /**
   * Hand a Member whose context the Host cannot reduce in place to the
   * supervision coercion chain: the forced reduction failed, was refused by the
   * route, or left the pressure at or above the budget the Member was ordered to
   * get back under. The chain's step is the Host's fresh-context reset, so an
   * ignored warning ends with a new generation rather than another turn into the
   * same oversized context. Absent, the policy only blocks the request and waits
   * for the supervision pass to read the block.
   */
  readonly escalate?: (memberId: AgentTeamMemberId, diagnostic: string) => void
  /**
   * The other-LLM summarizer fallback, run when the Member-scoped engine's
   * forced reduction throws: tries the Host catalog's other configured routes
   * (bounded) and reports whether the durable surface advanced. Absent, the
   * coordinator fails closed on the original failure exactly as before.
   */
  readonly compactWithFallback?: (agent: Agent, memberId: AgentTeamMemberId, signal: AbortSignal) => Promise<boolean>
  /** Log one coordinator diagnostic. */
  readonly log: (message: string) => void
}

/** Whether one user message is one of this policy's own notices with the given summary. */
function isPressureNotice(message: { readonly source?: unknown }, summary: string): boolean {
  // The source arrives untyped from the inbox; identity is matched by exact
  // kind — the shape written now and the read-time conversion's V3 rename.
  const source = message.source as { readonly kind?: string; readonly summary?: string } | undefined
  return isAgentTeamSourceKind(source?.kind) && source?.summary === summary
}

export class PressurePolicyCoordinator {
  /**
   * Retry budget per agent for the current provider-overflow sequence.
   * Process-only by design: a restart re-earns one sequence per chain.
   */
  private readonly overflowRetries = new Map<Agent, number>()
  /**
   * Forced hard-limit compactions already spent per agent in the current
   * recovery chain. Each successful model request or any observed dip below
   * the hard limit re-arms the budget; while the chain stays open, at most one
   * surface rewrite is attempted. Bounding the rewrite cadence is what keeps a
   * hard-limit Member from compacting on every step — each rewrite invalidates
   * the provider's prompt cache, so a compaction loop that never gets below the
   * limit would re-prefill the whole context per request.
   */
  private readonly forcedCompactions = new WeakMap<Agent, number>()
  /**
   * Agents whose current route refuses dsh compaction outright with the
   * `dsh_compaction_refused` marker: the routed proxy owns compression on
   * that lane and keeps requests under the real model window, so the policy
   * submits without dsh compaction instead of failing closed on a proof the
   * lane can never produce (raw dsh-side tokens never drop there).
   */
  private readonly proxyOwnedLanes = new WeakSet<Agent>()
  /**
   * Whether the one-shot notice was already delivered, folded incrementally per
   * Member. The scan below is a monotone "has this ever happened" fold over the
   * Session's own events, so a cursor can replace re-scanning the whole log on
   * every step; identity guarding falls back to a cold fold when the Member's
   * Session changed under the entry.
   */
  private readonly noticeSeen = new Map<AgentTeamMemberId, OwnedSessionEventCursor<boolean>>()
  /** The reduction order's own durable delivery latch, same fold idiom. */
  private readonly mandateSeen = new Map<AgentTeamMemberId, OwnedSessionEventCursor<boolean>>()
  /**
   * Model steps this policy has seen at or above the handoff budget since the
   * notice landed, per agent. Process-only by design like the retry budgets: a
   * restart re-earns the allowance, while the order and the enforcement it gates
   * stay durable facts of the Session through their own folds.
   */
  private readonly overBudgetSteps = new WeakMap<Agent, number>()
  /** Forced handoff-budget reductions already spent per agent in this episode. */
  private readonly forcedHandoffReductions = new WeakMap<Agent, number>()
  private disposed = false

  constructor(private readonly options: PressurePolicyOptions) {}

  /**
   * The one-shot pressure notice is durable Session evidence, not process
   * state: a `CONTEXT_PRESSURE_NOTICE_SUMMARY` notice already surfaced as a
   * `user/message`, or still queued in a durable `agent/inbox/spliced`
   * insert (a steered notice surfaces only at the next step boundary, and a
   * Host restart replays the splice before surfacing), marks the current
   * generation as already notified. A resume or restart stays quiet; a
   * rollover starts a fresh Session whose own event span has no notice yet,
   * which is exactly the documented re-arm.
   */
  private noticeDelivered(agent: Agent, memberId: AgentTeamMemberId): boolean {
    return this.advanceLatch(this.noticeSeen, agent, memberId, PRESSURE_NOTICE_FOLD)
  }

  /** Whether this generation already carries the reduction order. */
  private mandateDelivered(agent: Agent, memberId: AgentTeamMemberId): boolean {
    return this.advanceLatch(this.mandateSeen, agent, memberId, PRESSURE_MANDATE_FOLD)
  }

  /** Advance one durable-delivery latch and return its folded value. */
  private advanceLatch(
    latches: Map<AgentTeamMemberId, OwnedSessionEventCursor<boolean>>,
    agent: Agent,
    memberId: AgentTeamMemberId,
    fold: SessionEventFold<boolean, SessionEvent>,
  ): boolean {
    const owned = advanceOwnedSessionEventCursor(
      latches.get(memberId),
      agent.session.id,
      fold,
      agent.session.ownEvents(),
      agent.session.inheritedEventCount,
    )
    latches.set(memberId, owned)
    return owned.cursor.value
  }

  dispose(): void {
    this.disposed = true
    this.overflowRetries.clear()
    this.noticeSeen.clear()
    this.mandateSeen.clear()
  }

  /** A successful assistant response ends any open overflow-recovery sequence. */
  onAssistantMessage(agent: Agent): void {
    this.overflowRetries.delete(agent)
    // The request got through, so the previous forced compaction was a real
    // reduction: the next hard-limit crossing opens a fresh chain.
    this.forcedCompactions.delete(agent)
  }

  /**
   * Pre-step policy for one Member agent: below the handoff budget nothing
   * happens; at the handoff budget one structured notice per generation is
   * steered into the running turn; past the notice's allowance an order follows
   * that commands the reduction and the memory write; past the order's
   * allowance the Host runs the reduction itself; at the hard limit the request
   * is forced through compaction first and fails closed when that cannot be
   * proven. Returns the decision for the step: `continue` forwards, `reject`
   * blocks.
   */
  async onPreStep(agent: Agent, signal: AbortSignal): Promise<{ readonly kind: 'continue' | 'reject' | 'notice' }> {
    if (this.disposed || signal.aborted) return { kind: 'continue' }
    const member = this.options.memberForAgent(agent)
    if (member === undefined) return { kind: 'continue' }
    const limits = await this.options.limitsForAgent(agent)
    if (limits === undefined) {
      // A missing route capacity must be explicit, never an accidental
      // unlimited policy: reject the step with a recoverable diagnostic.
      const diagnostic = `${POLICY_BLOCK_PREFIX}: the routed model capacity is unknown; refusing to forward a request without a bounded context budget`
      this.options.failed(member.memberId, member.sessionId, diagnostic)
      return { kind: 'reject' }
    }
    const { usageTokens, hardLimit, handoffAt } = limits
    if (usageTokens >= hardLimit) {
      const outcome = await this.enforceHardLimit(agent, member.memberId, member.sessionId, hardLimit, signal)
      return outcome ? { kind: 'continue' } : { kind: 'reject' }
    }
    // Pressure receded below the hard limit: whatever reduced it (compaction,
    // rollover, manual action) closed the current recovery chain — and proved
    // any recorded hard-limit block stale for this generation.
    this.forcedCompactions.delete(agent)
    this.options.healed?.(member.memberId)
    if (usageTokens < handoffAt) {
      // Back under the budget, so the next crossing starts a fresh allowance and
      // a fresh order may be issued for it.
      this.overBudgetSteps.delete(agent)
      this.forcedHandoffReductions.delete(agent)
      return { kind: 'continue' }
    }
    if (!this.noticeDelivered(agent, member.memberId)) {
      this.overBudgetSteps.delete(agent)
      this.steerPressure(agent, member.memberId, {
        summary: CONTEXT_PRESSURE_NOTICE_SUMMARY,
        text: contextPressureNoticeText({
          usageTokens, handoffAt, hardLimit,
          activeClaims: this.options.activeClaimLabels(member.memberId),
          runningJobs: this.options.runningJobLabels(member.memberId),
        }),
      })
      return { kind: 'notice' }
    }
    // The advice is on the record and this step still reads over the budget: the
    // Member is spending the allowance, and past it the policy stops advising.
    const overSteps = (this.overBudgetSteps.get(agent) ?? 0) + 1
    this.overBudgetSteps.set(agent, overSteps)
    if (!this.mandateDelivered(agent, member.memberId)) {
      if (overSteps <= CONTEXT_PRESSURE_MANDATE_AFTER_STEPS) return { kind: 'continue' }
      this.steerPressure(agent, member.memberId, {
        summary: CONTEXT_PRESSURE_MANDATE_SUMMARY,
        text: contextPressureMandateText({
          usageTokens, handoffAt, hardLimit,
          activeClaims: this.options.activeClaimLabels(member.memberId),
          runningJobs: this.options.runningJobLabels(member.memberId),
        }),
      })
      return { kind: 'notice' }
    }
    if (overSteps <= CONTEXT_PRESSURE_ENFORCE_AFTER_STEPS) return { kind: 'continue' }
    const reduced = await this.enforceHandoffReduction(agent, member.memberId, member.sessionId, handoffAt, signal)
    return reduced ? { kind: 'continue' } : { kind: 'reject' }
  }

  /** Steer one of this policy's own notices; a failed steer is logged, never fatal to the step. */
  private steerPressure(agent: Agent, memberId: AgentTeamMemberId, notice: { readonly summary: string; readonly text: string }): void {
    try {
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: notice.text }],
        source: { kind: AGENT_TEAM_PLUGIN_ID, form: 'notice', summary: notice.summary },
      }))
    } catch (error) {
      this.options.log(`context pressure notice '${notice.summary}' failed: ${error instanceof Error ? error.message : String(error)} (member ${memberId})`)
    }
  }

  /**
   * The consequence of an ignored order: the Host runs the reduction the Member
   * would not run itself and requires the same proof every continuing request
   * needs — the measured pressure is now below the handoff budget. A lane whose
   * proxy owns compression is left alone, because its raw reading never drops
   * and the provider's own oversize refusal is what names a context there that
   * truly no longer fits; the supervision chain resets that one. Everywhere else
   * a reduction that throws, no-ops, cannot be measured, or lands still over the
   * budget blocks the request and hands the Member to that chain on the spot: a
   * Member that will not give its context up, and cannot be shrunk in place, is
   * given a fresh one rather than another turn into the same wall.
   * @returns whether the request may proceed.
   */
  private async enforceHandoffReduction(agent: Agent, memberId: AgentTeamMemberId, sessionId: Agent['id'], handoffAt: number, signal: AbortSignal): Promise<boolean> {
    if (this.proxyOwnedLanes.has(agent)) return true
    if ((this.forcedHandoffReductions.get(agent) ?? 0) >= 1) {
      this.blockUnreducedContext(memberId, sessionId, 'the forced reduction for this order is already spent and this step is still at or above the handoff budget')
      return false
    }
    this.forcedHandoffReductions.set(agent, 1)
    const engine = this.options.compactionForAgent(agent)
    if (engine === undefined) {
      this.blockUnreducedContext(memberId, sessionId, 'no CompactionEngine is available in the Member scope to carry the reduction out')
      return false
    }
    const meter = agent.ctx.get('tokenMeter')
    try {
      await engine.compactIfNeeded(agent, 'pressure', signal)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('dsh_compaction_refused')) {
        // The route owns compression on this lane; the order stands but the Host
        // does not rewrite a context it cannot measure downward.
        this.proxyOwnedLanes.add(agent)
        this.options.log(`${POLICY_BLOCK_PREFIX}: the reduction the Member was ordered to run is refused on this lane (dsh compaction refused); leaving the context to the route (member ${memberId})`)
        return true
      }
      // The other configured LLM routes get the same last resort the hard limit
      // grants, and a fallback that advanced the surface still owes the proof.
      const fell = !signal.aborted && this.options.compactWithFallback !== undefined
        && await this.options.compactWithFallback(agent, memberId, signal)
      if (!fell) {
        this.blockUnreducedContext(memberId, sessionId, `the forced reduction threw: ${message}`)
        return false
      }
    }
    if (signal.aborted) return false
    const after = meter?.measure(agent.session)?.totalTokens
    if (after === undefined || after >= handoffAt) {
      // No meter or a reduction that did not clear the budget: the same
      // fail-closed proof the hard limit demands, one threshold earlier.
      this.blockUnreducedContext(memberId, sessionId, after === undefined
        ? 'the forced reduction left the context pressure unmeasurable'
        : `the forced reduction left ${after} tokens at or above the ${handoffAt} handoff budget`)
      return false
    }
    // The budget is met again: the order's episode is over, and the next
    // crossing re-earns both the allowance and one forced reduction.
    this.overBudgetSteps.delete(agent)
    this.forcedHandoffReductions.delete(agent)
    return true
  }

  /** Record the block this policy refuses the request with, and open the coercion chain on it. */
  private blockUnreducedContext(memberId: AgentTeamMemberId, sessionId: Agent['id'], reason: string): void {
    const diagnostic = `${POLICY_BLOCK_PREFIX}: the handoff-budget order was not honored and ${reason}; the request was blocked and the Member's context is being reset`
    this.options.failed(memberId, sessionId, diagnostic)
    this.options.escalate?.(memberId, diagnostic)
  }

  /**
   * Provider-overflow recovery: one bounded compact-and-retry sequence per
   * open failure chain. Returns whether the request may retry once.
   */
  async onRequestError(agent: Agent, failure: { readonly code?: string }, signal: AbortSignal): Promise<boolean> {
    if (this.disposed || signal.aborted) return false
    if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE) return false
    const member = this.options.memberForAgent(agent)
    if (member === undefined) return false
    const retries = this.overflowRetries.get(agent) ?? 0
    if (retries >= 1) return false
    const engine = this.options.compactionForAgent(agent)
    if (engine === undefined) return false
    const generation = agent.session.surface.replaceGeneration
    try {
      await engine.compactIfNeeded(agent, 'context-overflow', signal)
    } catch (error) {
      // Durable prune progress before a later summary failure justifies the
      // single retry; cancellation never does.
      if (!signal.aborted && agent.session.surface.replaceGeneration > generation) {
        this.overflowRetries.set(agent, retries + 1)
        return true
      }
      this.options.log(`context-overflow recovery failed: ${error instanceof Error ? error.message : String(error)} (member ${member.memberId})`)
      if (error instanceof Error ? error.message.includes('dsh_compaction_refused') : String(error).includes('dsh_compaction_refused')) {
        // The routed proxy owns compression on this lane: never compact on the
        // fallback routes either; surface the overflow instead.
        this.proxyOwnedLanes.add(agent)
        return false
      }
      // Last resort on the primary engine's failure: the other configured LLM
      // routes. A fallback that advances the surface earns the same single
      // retry the prune-progress path grants.
      const fell = !signal.aborted && this.options.compactWithFallback !== undefined
        && await this.options.compactWithFallback(agent, member.memberId, signal)
      if (fell && agent.session.surface.replaceGeneration > generation) {
        this.overflowRetries.set(agent, retries + 1)
        return true
      }
      return false
    }
    if (signal.aborted || agent.session.surface.replaceGeneration <= generation) return false
    this.overflowRetries.set(agent, retries + 1)
    return true
  }

  /**
   * The one Team hard-limit translation: force a CompactionEngine reduction in
   * the current Agent/Session and prove the pressure actually dropped below the
   * hard limit before continuing. One rewrite is attempted per recovery chain —
   * a chain closes on a successful request or on any observed dip below the
   * limit — and a compaction that leaves the context at or above the limit
   * fails closed: submitting anyway would exceed the Team limit with a cache
   * the next rewrite invalidates, compounding into the compact-per-step loop
   * this bound exists to prevent. Background jobs are untouched — compaction
   * never cancels or discards them.
   * @returns whether the request may proceed.
   */
  private async enforceHardLimit(agent: Agent, memberId: AgentTeamMemberId, sessionId: Agent['id'], hardLimit: number, signal: AbortSignal): Promise<boolean> {
    if (this.proxyOwnedLanes.has(agent)) return true
    const engine = this.options.compactionForAgent(agent)
    if (engine === undefined) {
      const diagnostic = `${HARD_LIMIT_BLOCK_PREFIX} reached and compaction is unavailable in the Member scope; the request was blocked`
      this.options.failed(memberId, sessionId, diagnostic)
      return false
    }
    if ((this.forcedCompactions.get(agent) ?? 0) >= 1) {
      const diagnostic = `${HARD_LIMIT_BLOCK_PREFIX} reached and the forced-compaction budget for this recovery chain is already spent; the request was blocked`
      this.options.failed(memberId, sessionId, diagnostic)
      return false
    }
    this.forcedCompactions.set(agent, 1)
    const meter = agent.ctx.get('tokenMeter')
    try {
      await engine.compactIfNeeded(agent, 'context-overflow', signal)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('dsh_compaction_refused')) {
        // The routed proxy owns compression on this lane and refuses dsh
        // compaction outright; the raw-token proof below is unattainable and
        // unnecessary there, so submit and stop forcing on this agent.
        this.proxyOwnedLanes.add(agent)
        this.options.log(`${HARD_LIMIT_BLOCK_PREFIX} reached, but the routed proxy owns compression on this lane (dsh compaction refused); submitting without dsh compaction (member ${memberId})`)
        return true
      }
      this.options.log(`${HARD_LIMIT_BLOCK_PREFIX} compaction failed: ${message}; trying fallback LLM routes (member ${memberId})`)
      // Last resort before failing closed: the other configured LLM routes. A
      // fallback that advanced the surface still has to pass the same measured
      // below-limit proof every continuing request needs.
      const fell = !signal.aborted && this.options.compactWithFallback !== undefined
        && await this.options.compactWithFallback(agent, memberId, signal)
      if (!fell) {
        const diagnostic = `${HARD_LIMIT_BLOCK_PREFIX} compaction failed: ${error instanceof Error ? error.message : String(error)}; the request was blocked`
        this.options.failed(memberId, sessionId, diagnostic)
        return false
      }
    }
    if (signal.aborted) return false
    const after = meter?.measure(agent.session)?.totalTokens
    if (after === undefined || after >= hardLimit) {
      // No meter or an unproven reduction: fail closed rather than knowingly
      // submit over the Team limit.
      const diagnostic = after === undefined
        ? `${HARD_LIMIT_BLOCK_PREFIX} compaction left the context pressure unmeasurable; the request was blocked`
        : `${HARD_LIMIT_BLOCK_PREFIX} compaction left ${after} tokens at or above the ${hardLimit} hard limit; the request was blocked`
      this.options.failed(memberId, sessionId, diagnostic)
      return false
    }
    return true
  }
}
