/**
 * The Host half of the engine's retrieval ladder: `context_search` and
 * `context_read` are the engine's tools, and this adapter is everything Team
 * contributes to them — who the subject is, which Sessions that subject may
 * search, the fold configuration the registered projection unit uses, the
 * source meter, and the pressure budget. The ladder's argument surface,
 * budgets, refs, wording, and renders stay the engine's, so a Team Member and
 * any other subject of the engine recall history the same way.
 *
 * The Host is resolved through the tool row's own context on every call: the
 * row is mounted by the Member preset, and a preset mounted without a Host
 * must reject each call rather than fail to load.
 * @module @wowyuarm/dsh-agent-team/context-search
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ContextSearchAdapter, ContextSearchPort } from '@wowyuarm/dsh-context-continuity'
import type {} from '@deepseek-ai/dsh-session-query'
import type AgentTeam from './index.ts'

/** The Agent one call runs as; the engine's tool body never sees an Agent-less exec. */
function agentOf(exec: ToolRunContext): Agent {
  const agent = exec.agent
  if (agent === undefined) throw new Error('context_search requires an Agent session')
  return agent
}

/**
 * Build the retrieval ladder's Host half for one tool row. Every member is
 * resolved at call time — the Host and the query service are looked up
 * lazily, so nothing here depends on mount order.
 */
export function createTeamContextSearchAdapter(ctx: Context): ContextSearchAdapter<Agent> {
  const host = (): AgentTeam => {
    const service = ctx.get('agentTeam')
    if (service === undefined) throw new Error('Agent Team Host is unavailable')
    return service
  }
  return {
    subject: exec => agentOf(exec),
    activeSessionId: exec => agentOf(exec).session.id,
    // Authorization is the Member's own Session lineage: its current binding
    // plus every generation it retired, and nothing else.
    scope: { ownedSessions: agent => host().ownedSessionIdsForAgent(agent) },
    get query(): ContextSearchPort {
      const query = ctx.get('sessionQuery')
      if (query === undefined) throw new Error('context_search requires the Harness session-query service, which this profile does not provide')
      return query
    },
    get config() {
      return host().contextFoldConfig()
    },
    measureSource: (source, exec) => host().measureContextSourceForAgent(agentOf(exec), source),
    handoffAt: exec => host().contextHandoffAtForAgent(agentOf(exec)),
  }
}
