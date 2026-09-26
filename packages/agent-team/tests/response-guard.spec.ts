import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  classifyAssistantResponse,
  COMPLETION_MARKER,
  isResponseFault,
  RESPONSE_GUARD_MAX_CONSECUTIVE,
  RESPONSE_GUARD_NOTICE_SUMMARY,
  ResponseGuardCoordinator,
} from '../src/response-guard.ts'
import type { AgentTeamMemberId } from '../src/types.ts'

describe('classifyAssistantResponse', () => {
  it('sees a tool call regardless of text', () => {
    const shape = classifyAssistantResponse([
      { type: 'reasoning', text: 'thinking' },
      { type: 'tool-call', id: 'call-1' as never, name: 'team_message', arguments: '{}' },
    ] satisfies ContentBlock[])
    expect(shape.hasToolCall).toBe(true)
    expect(shape.hasText).toBe(false)
  })

  it('detects the completion marker on concatenated text blocks', () => {
    const shape = classifyAssistantResponse([
      { type: 'reasoning', text: 'thinking' },
      { type: 'text', text: 'work is done.\n' },
      { type: 'text', text: COMPLETION_MARKER },
    ])
    expect(shape.hasText).toBe(true)
    expect(shape.textEndsWithMarker).toBe(true)
  })

  it('treats whitespace-only text as no text', () => {
    const shape = classifyAssistantResponse([{ type: 'text', text: '  \n' }])
    expect(shape.hasText).toBe(false)
    expect(shape.textEndsWithMarker).toBe(false)
  })
})

describe('isResponseFault', () => {
  it('passes a response that keeps working through tool calls', () => {
    expect(isResponseFault({ hasToolCall: true, hasText: false, textEndsWithMarker: false })).toBe(false)
  })

  it('passes a response that ends with the completion marker', () => {
    expect(isResponseFault({ hasToolCall: false, hasText: true, textEndsWithMarker: true })).toBe(false)
  })

  it('faults on a thinking-only response', () => {
    expect(isResponseFault({ hasToolCall: false, hasText: false, textEndsWithMarker: false })).toBe(true)
  })

  it('faults on trailing text without a marker or tool call', () => {
    expect(isResponseFault({ hasToolCall: false, hasText: true, textEndsWithMarker: false })).toBe(true)
  })
})

describe('ResponseGuardCoordinator', () => {
  const memberId = 'member:builder' as AgentTeamMemberId
  const healthy = { hasToolCall: false, hasText: true, textEndsWithMarker: true }
  const trailing = { hasToolCall: false, hasText: true, textEndsWithMarker: false }
  const working = { hasToolCall: true, hasText: false, textEndsWithMarker: false }

  function harness(overrides: Partial<ConstructorParameters<typeof ResponseGuardCoordinator>[0]> = {}) {
    const nudges: Array<{ memberId: AgentTeamMemberId; diagnostic: string }> = []
    const standDowns: Array<{ memberId: AgentTeamMemberId; faults: number }> = []
    const coordinator = new ResponseGuardCoordinator({
      nudge: (id, diagnostic) => { nudges.push({ memberId: id, diagnostic }) },
      onStandDown: (id, faults) => { standDowns.push({ memberId: id, faults }) },
      ...overrides,
    })
    return { coordinator, nudges, standDowns }
  }

  it('nudges each of the first consecutive faulty responses', () => {
    const { coordinator, nudges } = harness()
    coordinator.onAssistantMessage(memberId, trailing, false)
    coordinator.onAssistantMessage(memberId, { hasToolCall: false, hasText: false, textEndsWithMarker: false }, false)
    expect(nudges).toHaveLength(2)
    expect(nudges[1]?.diagnostic).toContain('no visible text')
  })

  it('resets the episode on any healthy response, including tool calls', () => {
    const { coordinator, nudges } = harness()
    coordinator.onAssistantMessage(memberId, trailing, false)
    coordinator.onAssistantMessage(memberId, working, false)
    coordinator.onAssistantMessage(memberId, trailing, false)
    expect(nudges).toHaveLength(2)
  })

  it('stands down once after the faulty-response budget is spent', () => {
    const { coordinator, nudges, standDowns } = harness()
    for (let i = 0; i < RESPONSE_GUARD_MAX_CONSECUTIVE + 2; i += 1) coordinator.onAssistantMessage(memberId, trailing, false)
    expect(nudges).toHaveLength(RESPONSE_GUARD_MAX_CONSECUTIVE)
    expect(standDowns).toEqual([{ memberId, faults: RESPONSE_GUARD_MAX_CONSECUTIVE + 1 }])
  })

  it('a fresh episode can open after a healthy response following a stand-down', () => {
    const { coordinator, nudges, standDowns } = harness()
    for (let i = 0; i < RESPONSE_GUARD_MAX_CONSECUTIVE + 1; i += 1) coordinator.onAssistantMessage(memberId, trailing, false)
    coordinator.onAssistantMessage(memberId, healthy, false)
    coordinator.onAssistantMessage(memberId, trailing, false)
    expect(standDowns).toHaveLength(1)
    expect(nudges).toHaveLength(RESPONSE_GUARD_MAX_CONSECUTIVE + 1)
  })

  it('ignores interrupted messages without touching the episode', () => {
    const { coordinator, nudges } = harness()
    coordinator.onAssistantMessage(memberId, trailing, false)
    coordinator.onAssistantMessage(memberId, trailing, true)
    coordinator.onAssistantMessage(memberId, trailing, false)
    expect(nudges).toHaveLength(2)
  })

  it('stops nudging when the nudge target is gone', () => {
    const coordinator = new ResponseGuardCoordinator({
      nudge: () => { throw new Error('member disposed') },
    })
    coordinator.onAssistantMessage(memberId, trailing, false)
    coordinator.onAssistantMessage(memberId, trailing, false)
    expect(coordinator['consecutiveFaults'].has(memberId)).toBe(false)
  })

  it('labels the notice as a pure reminder for the context projection', () => {
    expect(RESPONSE_GUARD_NOTICE_SUMMARY).toContain('continue')
  })

  it('dispose clears every episode', () => {
    const { coordinator } = harness()
    coordinator.onAssistantMessage(memberId, trailing, false)
    coordinator.dispose()
    expect(coordinator['consecutiveFaults'].size).toBe(0)
  })
})
