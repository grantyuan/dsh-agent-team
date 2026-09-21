/**
 * Team's binding of the context-continuity engine: the message codec Team
 * writes through, the durable rollover identity the host derives, the notice
 * rule the engine consults, and the projection state the host hands back
 * untranslated. The lifecycle behavior these feed — swap, carry, crash repair —
 * stays covered by the member-lifecycle and context-projection suites.
 */
import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { isDroppedNotice, type ContextProjectionState } from '@wowyuarm/dsh-context-continuity'
import { AGENT_TEAM_PLUGIN_ID } from '../src/context-source.ts'
import { TEAM_CONTEXT_CODEC, TeamContextContinuityHost } from '../src/context-continuity-host.ts'
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

describe('the projection read', () => {
  it('hands the engine the registered unit\'s own state, with no translation layer', () => {
    // The engine's fold is the only fold: the host returns the very state the
    // registered projection unit produced, never a mapped copy. A translation
    // would be a second authority for the same facts.
    const state: ContextProjectionState = {
      sessionId: 'session:one',
      inheritedEventCount: 3,
      checkpoints: [{ checkpointRef: 'context-checkpoint-' + 'a'.repeat(64), name: 'anchor', resultSeq: 4, turn: 1, turnEndSeq: 6 }],
      pending: null,
      continuations: [],
      carriedCandidates: [],
      lastTurn: 3,
      openCalls: [],
      boundaries: [{ kind: 'team-boundary', label: 'Thread facts', resultSeq: 2, turn: 0, turnEndSeq: 5, attributions: ['thread:abc'] }],
      seenTopics: ['thread:abc'],
      lastTurnEndSeq: 6,
    }
    const host = new TeamContextContinuityHost({
      agentForMember: () => undefined,
      memberForAgent: () => undefined,
      projectionForMember: (memberId, sessionId) => (memberId === MEMBER_ID && sessionId === SESSION_ID ? state : undefined),
      executeTransition: () => Promise.resolve(),
      log: () => {},
    })

    expect(host.projectionForSubject(MEMBER_ID, SESSION_ID)).toBe(state)
    expect(host.projectionForSubject(MEMBER_ID, SessionId('session:two'))).toBeUndefined()
  })
})
