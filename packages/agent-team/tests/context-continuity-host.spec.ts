/**
 * Phase 1 of the Team/engine split: the message codec Team writes through, the
 * durable rollover identity the host derives, the notice rule the engine
 * consults, and the bridge from Team's fold state to the engine's read-only
 * state. The lifecycle behavior these feed — swap, carry, crash repair — stays
 * covered by the member-lifecycle and context-projection suites.
 */
import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { isDroppedNotice } from '@wowyuarm/dsh-context-continuity'
import { boundaryRefFor, checkpointRefFor, type AgentTeamContextProjectionState } from '../src/context-projection.ts'
import { AGENT_TEAM_PLUGIN_ID } from '../src/context-source.ts'
import { TEAM_CONTEXT_CODEC, TeamContextContinuityHost, toEngineProjectionState } from '../src/context-continuity-host.ts'
import type { AgentTeamAgentMember, AgentTeamMemberId } from '../src/types.ts'

const MEMBER_ID = 'member:one' as AgentTeamMemberId
const SESSION_ID = SessionId('session:one')

/** The model-facing text of one message. */
function bodyOf(message: { readonly content: readonly unknown[] }): string {
  const part = message.content[0] as { readonly type: string; readonly text: string }
  return part.text
}

/** The snapshot sections of one message, or undefined when another producer owns it. */
function sectionsOf(message: { readonly source: unknown }): readonly { readonly name: string; readonly text: string }[] | undefined {
  const source = message.source as { readonly kind?: string; readonly form?: string; readonly sections?: readonly { readonly name: string; readonly text: string }[] }
  return source.kind === 'plugin' && source.form === 'snapshot' ? source.sections : undefined
}

describe('the Team context codec', () => {
  it('writes the frozen handoff envelope byte for byte', () => {
    const message = TEAM_CONTEXT_CODEC.createHandoffMessage({
      handoff: 'Handoff prose.',
      previousSessionId: 'session:one',
      newSessionId: 'session:two',
      trigger: 'model',
      handoffEventSeq: 7,
      checkpointRef: 'context-checkpoint-abc',
      relatedFiles: [{ path: 'a/b.ts', reason: 'first' }, { path: 'c.ts', reason: 'second' }],
    })

    expect(bodyOf(message)).toBe([
      'Context handoff: you are continuing as the same Team Member in a fresh private context.',
      'Previous session: session:one',
      'New session: session:two',
      'Trigger: model',
      'Continued from checkpoint: context-checkpoint-abc',
      'Related files: a/b.ts, c.ts',
      '',
      'Your handoff from the previous context follows. Verify external state before relying on it; a context change never rolls back files, processes, Team facts, or remote side effects.',
      '',
      'Handoff prose.',
    ].join('\n'))
    expect(sectionsOf(message)).toEqual([
      { name: 'HANDOFF', text: 'Handoff prose.' },
      { name: 'Previous session', text: 'session:one' },
      { name: 'New session', text: 'session:two' },
      { name: 'Trigger', text: 'model' },
      { name: 'Handoff event seq', text: '7' },
      { name: 'Continued from checkpoint', text: 'context-checkpoint-abc' },
      { name: 'Related files', text: '["a/b.ts","c.ts"]' },
    ])
    expect((message.source as { readonly plugin?: string }).plugin).toBe(AGENT_TEAM_PLUGIN_ID)
  })

  it('writes the frozen checkpoint continuation', () => {
    const message = TEAM_CONTEXT_CODEC.createCheckpointContinuationMessage('context-checkpoint-abc')

    expect(bodyOf(message)).toBe('A context checkpoint was recorded at the end of the previous turn. Continue the work you were doing.')
    expect(sectionsOf(message)).toEqual([{ name: 'Checkpoint', text: 'context-checkpoint-abc' }])
  })

  it('reads back what it wrote, and only its own attribution', () => {
    const handoff = TEAM_CONTEXT_CODEC.createHandoffMessage({
      handoff: 'prose',
      previousSessionId: 'session:one',
      newSessionId: 'session:two',
      trigger: 'pressure',
      handoffEventSeq: 3,
    })

    expect(TEAM_CONTEXT_CODEC.isHandoffMessage(handoff)).toBe(true)
    expect(TEAM_CONTEXT_CODEC.handoffOf(handoff)?.handoffEventSeq).toBe(3)
    expect(TEAM_CONTEXT_CODEC.isContextSource(handoff)).toBe(true)
  })
})

describe('the Team context-continuity host', () => {
  const member = { memberId: MEMBER_ID, sessionId: SESSION_ID } as AgentTeamAgentMember
  const agent = { id: 'agent:one' } as Agent

  it('derives the durable rollover identity unchanged', () => {
    const host = new TeamContextContinuityHost({
      agentForMember: () => undefined,
      memberForAgent: () => undefined,
      projectionForMember: () => undefined,
      executeTransition: () => Promise.resolve(),
      log: () => {},
    })

    const identity = host.rolloverIdentity(SessionId('session:one'), 'call-1')

    // The naming scheme is durable: in-flight rollover recovery converges on
    // it, and the ledger records the request id.
    const digest = '57207ab4cee751e63f481d7e232f2ba9a73efdacd4a0021173b874998bd38dc4'
    expect(identity.newSessionId).toBe(`agent-team-rollover-${digest}`)
    expect(identity.requestId).toBe(`agent-team:rollover:${digest}`)
  })

  it('resolves subjects and Agents in both directions', () => {
    const host = new TeamContextContinuityHost({
      agentForMember: id => (id === MEMBER_ID ? agent : undefined),
      memberForAgent: candidate => (candidate === agent ? member : undefined),
      projectionForMember: () => undefined,
      executeTransition: () => Promise.resolve(),
      log: () => {},
    })

    expect(host.agentForSubject(MEMBER_ID)).toBe(agent)
    expect(host.subjectForAgent(agent)).toEqual({ id: MEMBER_ID, sessionId: SESSION_ID })
    expect(host.subjectForAgent({ id: 'agent:other' } as Agent)).toBeUndefined()
  })

  it('treats Team notices as rederived and foreign messages as real input', () => {
    const host = new TeamContextContinuityHost({
      agentForMember: () => undefined,
      memberForAgent: () => undefined,
      projectionForMember: () => undefined,
      executeTransition: () => Promise.resolve(),
      log: () => {},
    })
    const teamNotice = createUserMessage({
      content: [{ type: 'text', text: 'inbox notice' }],
      source: { kind: 'plugin', plugin: AGENT_TEAM_PLUGIN_ID, form: 'notice', summary: 'notice' },
    })
    const foreign = createUserMessage({
      content: [{ type: 'text', text: 'operator input' }],
      source: { kind: 'plugin', plugin: '@wowyuarm/someone-else', form: 'notice', summary: 'notice' },
    })
    const handoff = TEAM_CONTEXT_CODEC.createHandoffMessage({
      handoff: 'prose',
      previousSessionId: 'session:one',
      newSessionId: 'session:two',
      trigger: 'model',
      handoffEventSeq: 1,
    })

    expect(host.isEphemeralNotice(teamNotice)).toBe(true)
    expect(host.isEphemeralNotice(foreign)).toBe(false)
    // The engine excludes its own envelopes before the host's judgement runs,
    // so a handoff is carried, never dropped as a stale notice.
    expect(isDroppedNotice(TEAM_CONTEXT_CODEC, host, handoff)).toBe(false)
    expect(isDroppedNotice(TEAM_CONTEXT_CODEC, host, teamNotice)).toBe(true)
    expect(isDroppedNotice(TEAM_CONTEXT_CODEC, host, foreign)).toBe(false)
  })
})

describe('the projection bridge', () => {
  it('maps the Team fold state onto the engine state', () => {
    const checkpointRef = checkpointRefFor('session:one', 'call-cp')
    const queued = createUserMessage({
      content: [{ type: 'text', text: 'operator input' }],
      source: { kind: 'plugin', plugin: '@wowyuarm/someone-else', form: 'notice', summary: 'notice' },
    })
    const state: AgentTeamContextProjectionState = {
      checkpoints: [{ checkpointRef, name: 'anchor', resultSeq: 4, turn: 1, turnEndSeq: 6 }],
      pending: { handoff: 'prose', toolCallId: 'call-roll', resultSeq: 9, turn: 2, turnEndSeq: -1, relatedFiles: [] },
      continuations: [{ checkpointRef, deliveredSeq: 8 }],
      carriedCandidates: [{ message: queued, surfacedTurn: 3, consumed: false }],
      lastTurn: 3,
      openCalls: [{ callId: 'call-open', name: 'context_checkpoint', arguments: '{}' }],
      boundaries: [{ key: boundaryRefFor('session:one', 2), source: 'team-boundary', label: 'Thread facts', seq: 2, turn: 0, turnEndSeq: 5 }],
      seenThreads: ['thread:abc'],
      lastTurnEndSeq: 6,
    }

    const engineState = toEngineProjectionState({ state, inheritedEventCount: 3 }, SESSION_ID)

    expect(engineState.sessionId).toBe('session:one')
    expect(engineState.inheritedEventCount).toBe(3)
    expect(engineState.checkpoints).toEqual(state.checkpoints)
    expect(engineState.pending).toEqual(state.pending)
    expect(engineState.continuations).toEqual(state.continuations)
    expect(engineState.carriedCandidates).toEqual([{ messageId: queued.id, surfacedTurn: 3, consumed: false }])
    expect(engineState.lastTurn).toBe(3)
    expect(engineState.openCalls).toEqual(state.openCalls)
    // Team's boundary key is a Session-local anchor, not a topic: the engine's
    // default-anchor policy sees no attribution until phase 2 supplies it.
    expect(engineState.boundaries).toEqual([
      { kind: 'team-boundary', label: 'Thread facts', resultSeq: 2, turn: 0, turnEndSeq: 5, attributions: [] },
    ])
    expect(engineState.seenTopics).toEqual(['thread:abc'])
    expect(engineState.lastTurnEndSeq).toBe(6)
  })

  it('is what the host hands the engine, and nothing when the fold has no state', () => {
    const state = {
      checkpoints: [], pending: null, continuations: [], carriedCandidates: [], lastTurn: 0,
      openCalls: [], boundaries: [], seenThreads: [], lastTurnEndSeq: -1,
    } satisfies AgentTeamContextProjectionState
    const host = new TeamContextContinuityHost({
      agentForMember: () => undefined,
      memberForAgent: () => undefined,
      projectionForMember: (memberId, sessionId) => (memberId === MEMBER_ID && sessionId === SESSION_ID ? { state, inheritedEventCount: 0 } : undefined),
      executeTransition: () => Promise.resolve(),
      log: () => {},
    })

    expect(host.projectionForSubject(MEMBER_ID, SESSION_ID)?.sessionId).toBe('session:one')
    expect(host.projectionForSubject(MEMBER_ID, SessionId('session:two'))).toBeUndefined()
  })
})
