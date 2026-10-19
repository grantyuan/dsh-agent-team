/**
 * Team-owned provider-overflow recovery.
 *
 * The Team preset mounts `compaction-basic` with `auto: false`; this
 * coordinator owns the one reactive compaction entry point left. The Host
 * does not police context size: there is no pre-step usage ladder, no pressure
 * notice, no Host-forced reduction, and no request block. A Member manages its
 * own context through the rollover and checkpoint tools, and a failure that
 * actually surfaces feeds the supervision chain's failure counter — three
 * consecutive `agent/error` turns end in the fresh-context reset there.
 *
 * The one exception is the provider refusing a request because the context no
 * longer fits its route: one bounded compact-and-retry sequence per open
 * failure chain tries to save the request before the failure surfaces. The
 * retry stays bounded — one per chain, re-armed only by a successful request —
 * because each surface rewrite invalidates the provider's prompt cache, and a
 * compaction loop that never gets below the limit would re-prefill the whole
 * context per request.
 * @module @wowyuarm/dsh-agent-team/pressure-policy
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { CompactionEngine } from '@deepseek-ai/dsh-compaction'
import type { AgentTeamMemberId } from './types.ts'

export interface PressurePolicyOptions {
  /** Resolve the durable Member of one live Agent. */
  readonly memberForAgent: (agent: Agent) => { readonly memberId: AgentTeamMemberId; readonly sessionId: Agent['id'] } | undefined
  /** Resolve the Member-scoped compaction engine. */
  readonly compactionForAgent: (agent: Agent) => CompactionEngine | undefined
  /**
   * The other-LLM summarizer fallback, run when the Member-scoped engine's
   * overflow compaction throws: tries the Host catalog's other configured
   * routes (bounded) and reports whether the durable surface advanced. Absent,
   * the coordinator gives up on the original failure exactly as before.
   */
  readonly compactWithFallback?: (agent: Agent, memberId: AgentTeamMemberId, signal: AbortSignal) => Promise<boolean>
  /** Log one coordinator diagnostic. */
  readonly log: (message: string) => void
}

export class PressurePolicyCoordinator {
  /**
   * Retry budget per agent for the current provider-overflow sequence.
   * Process-only by design: a restart re-earns one sequence per chain.
   */
  private readonly overflowRetries = new Map<Agent, number>()
  /**
   * Agents whose current route refuses dsh compaction outright with the
   * `dsh_compaction_refused` marker: the routed proxy owns compression on
   * that lane and keeps requests under the real model window, so no retry is
   * attempted there and the overflow surfaces instead — the supervision
   * failure counter owns what happens next.
   */
  private readonly proxyOwnedLanes = new WeakSet<Agent>()
  private disposed = false

  constructor(private readonly options: PressurePolicyOptions) {}

  dispose(): void {
    this.disposed = true
    this.overflowRetries.clear()
  }

  /** A successful assistant response ends any open overflow-recovery sequence. */
  onAssistantMessage(agent: Agent): void {
    this.overflowRetries.delete(agent)
  }

  /**
   * Provider-overflow recovery: one bounded compact-and-retry sequence per
   * open failure chain. Returns whether the request may retry once.
   */
  async onRequestError(agent: Agent, failure: { readonly code?: string }, signal: AbortSignal): Promise<boolean> {
    if (this.disposed || signal.aborted) return false
    if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE) return false
    // A lane whose routed proxy owns compression never retries: every overflow
    // there surfaces as an ordinary failure for the supervision counter.
    if (this.proxyOwnedLanes.has(agent)) return false
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
}
