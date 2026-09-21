import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { readContextHit, searchContext } from '@wowyuarm/dsh-context-continuity'
import { createTeamContextProjectionConfig, TeamContextProjectionHost } from '../src/context-projection.ts'
import { createTeamContextSearchAdapter } from '../src/context-search.ts'

/**
 * The retrieval ladder is the engine's; Team's half is authorization. These
 * cases run the real engine against Team's adapter, so what is pinned is that
 * boundary: the Member's own Session lineage is the whole authorized set, a
 * hit or a ref outside it is refused rather than searched, and the two
 * services the adapter resolves lazily are resolved per call.
 */

const live = SessionId('session:live')
const prior = SessionId('session:prior')
const foreign = SessionId('session:foreign')
const TIME = Date.parse('2026-09-21T10:00:00Z')

/** One provider hit as the query service returns it. */
function sessionHit(sessionId: SessionId, seq: number, snippet: string) {
  return { header: { id: sessionId }, live: sessionId === live, persisted: true,
    bestMatch: { sessionId, seq, type: 'user/message', time: TIME, surface: 'message', snippet } }
}

function execFor(agent: unknown): ToolRunContext {
  return {
    callId: 'call-1', rootCallId: 'call-1', token: 'token-1', name: 'context_search', arguments: {},
    agent, signal: new AbortController().signal, deferContext() {}, concludeTurn() {},
  } as unknown as ToolRunContext
}

interface Harness {
  readonly ctx: Context
  readonly agent: { readonly session: { readonly id: SessionId } }
  readonly adapter: ReturnType<typeof createTeamContextSearchAdapter>
  readonly searched: unknown[]
}

/**
 * A Context carrying only what the adapter resolves: a Team Host double whose
 * lineage is the fixture, and a session-query double whose corpus holds one
 * generation of the Member's own lineage, one retired generation, and one
 * Session that belongs to somebody else.
 */
function harness(options: { readonly owned?: readonly SessionId[]; readonly host?: boolean; readonly query?: boolean } = {}): Harness {
  const ctx = new Context()
  const agent = { id: 'agent:member', ctx, session: { id: live, header: { id: live, parentSession: prior } } }
  const searched: unknown[] = []
  if (options.query !== false) {
    ctx.provide('sessionQuery', {
      async searchSessions(request: unknown) {
        searched.push(request)
        return { items: [sessionHit(live, 5, 'handoff prose'), sessionHit(prior, 2, 'an earlier decision'), sessionHit(foreign, 1, 'another Member\'s work')] }
      },
      async searchEvents() { return { items: [], session: { id: live } } },
      async filterEvents(sessionId: SessionId) { return sessionId === live ? [{ sessionId: live, seq: 5, type: 'user/message', time: TIME, surface: 'message', text: 'handoff prose' }] : [] },
      async readSession(sessionId: SessionId) {
        return { session: sessionId === live ? { id: live, parentSession: prior } : { id: sessionId }, inheritedEventCount: 0, events: [] }
      },
    } as never)
  }
  if (options.host !== false) {
    ctx.provide('agentTeam', {
      ownedSessionIdsForAgent: () => options.owned ?? [live, prior],
      contextFoldConfig: () => createTeamContextProjectionConfig(new TeamContextProjectionHost()),
      measureContextSourceForAgent: () => 1_000,
      contextHandoffAtForAgent: async () => 200_000,
    } as never)
  }
  return { ctx, agent, adapter: createTeamContextSearchAdapter(ctx), searched }
}

describe('Team context search authorization', () => {
  it('resolves the calling Agent as the subject and its live Session as the active generation', async () => {
    const { adapter, agent } = harness()
    const exec = execFor(agent)
    expect(await adapter.subject(exec)).toBe(agent)
    expect(await adapter.activeSessionId(exec)).toBe(live)
  })

  it('searches exactly the Member\'s own Session lineage and drops everything outside it', async () => {
    const { adapter, agent, searched } = harness()
    const result = await searchContext(adapter, { exec: execFor(agent), query: 'handoff' })
    // The authorized set reaches the provider as the query's session filter:
    // the engine never searches "everything" on the Host's behalf.
    expect(searched[0]).toMatchObject({ sessionFilters: [{ kind: 'id', values: [live, prior] }] })
    expect(result.hits.map(hit => hit.sessionId)).toEqual([live, prior])
    expect(result.hits.map(hit => hit.generation)).toEqual(['current', 'prior'])
    expect(result.hits.map(hit => hit.snippet)).toEqual(['handoff prose', 'an earlier decision'])
    // The foreign Session was returned by the provider and refused by Team's
    // scope: an out-of-scope hit is dropped loudly, never presented.
    expect(result.dropped).toEqual({ duplicate: 0, incomplete: 0, outOfScope: 1 })
    expect(result.hits.every(hit => hit.contextRef.startsWith('context-'))).toBe(true)
  })

  it('revalidates a ref against the lineage on every read', async () => {
    const { adapter, agent } = harness()
    const exec = execFor(agent)
    await expect(readContextHit(adapter, { exec, sessionId: foreign, seq: 1 }))
      .rejects.toThrow(/not part of the history this subject may read/)
    const read = await readContextHit(adapter, { exec, sessionId: live, seq: 5 })
    expect(read.generation).toBe('current')
    expect(read.events).toEqual([expect.objectContaining({ seq: 5, target: true, text: 'handoff prose' })])
  })

  it('fails closed when the Host, the query service, or the Agent is absent', async () => {
    const { adapter } = harness({ host: false })
    await expect(searchContext(adapter, { exec: execFor({ session: { id: live } }), query: 'x' }))
      .rejects.toThrow('Agent Team Host is unavailable')

    const { adapter: noQuery, agent } = harness({ query: false })
    await expect(searchContext(noQuery, { exec: execFor(agent), query: 'x' }))
      .rejects.toThrow(/requires the Harness session-query service/)

    const { adapter: ready } = harness()
    await expect(searchContext(ready, { exec: execFor(undefined), query: 'x' }))
      .rejects.toThrow('context_search requires an Agent session')
  })
})
