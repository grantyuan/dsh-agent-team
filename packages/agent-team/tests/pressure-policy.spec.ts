import { describe, expect, it } from 'vitest'
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CompactionEngine } from '@deepseek-ai/dsh-compaction'
import { PressurePolicyCoordinator } from '../src/pressure-policy.ts'

/** One controllable fake agent exposing exactly what the policy reads. */
function fakeAgent(options?: { readonly replaceGeneration?: number; readonly tokens?: number }): {
  readonly agent: Agent
  readonly surface: { replaceGeneration: number }
  /** Mutable usage the fake meter reports; tests and the fake engine move it. */
  readonly usage: { totalTokens: number }
} {
  const surface = { replaceGeneration: options?.replaceGeneration ?? 0 }
  const usage = { totalTokens: options?.tokens ?? 0 }
  const agent = {
    id: 'session:test',
    usage,
    ctx: { get: (name: string) => (name === 'tokenMeter' ? { measure: () => ({ totalTokens: usage.totalTokens }) } : undefined) },
    session: {
      surface,
      snapshotEvents: () => [],
      ownEvents: () => [],
      inheritedEventCount: 0,
    },
  } as unknown as Agent
  return { agent, surface, usage }
}

/** A configurable fake engine recording calls and advancing the surface. */
function fakeEngine(behavior: 'advance' | 'noop' | 'throw'): { readonly engine: CompactionEngine; readonly calls: string[] } {
  const calls: string[] = []
  const engine = {
    compactIfNeeded: async (agent: Agent, trigger: string): Promise<null> => {
      calls.push(trigger)
      if (behavior === 'throw') throw new Error('engine failure')
      if (behavior === 'advance') {
        ;(agent.session.surface as { replaceGeneration: number }).replaceGeneration += 1
        // A real reduction: the rewritten surface halves the measured usage.
        const usage = (agent as { usage?: { totalTokens: number } }).usage
        if (usage !== undefined) usage.totalTokens = Math.floor(usage.totalTokens / 2)
      }
      return null
    },
    compactNow: async () => null,
    compactRegion: async () => { throw new Error('unused') },
  } as unknown as CompactionEngine
  return { engine, calls }
}

function coordinator(behavior: 'advance' | 'noop' | 'throw' = 'advance'): { policy: PressurePolicyCoordinator; engine: ReturnType<typeof fakeEngine> } {
  const engine = fakeEngine(behavior)
  const policy = new PressurePolicyCoordinator({
    memberForAgent: agent => ({ memberId: 'member:test' as never, sessionId: agent.id }),
    compactionForAgent: () => engine.engine,
    log: () => {},
  })
  return { policy, engine }
}

describe('Agent Team provider-overflow recovery', () => {
  it('provider overflow compacts and retries once; a second overflow in the sequence falls through', async () => {
    const { policy, engine } = coordinator('advance')
    const { agent } = fakeAgent()
    const first = await policy.onRequestError(agent, { code: CONTEXT_WINDOW_EXCEEDED_CODE }, new AbortController().signal)
    expect(first).toBe(true)
    expect(engine.calls).toEqual(['context-overflow'])
    // Same open sequence: no second retry.
    const second = await policy.onRequestError(agent, { code: CONTEXT_WINDOW_EXCEEDED_CODE }, new AbortController().signal)
    expect(second).toBe(false)
    expect(engine.calls).toHaveLength(1)
    // A successful assistant response re-arms the sequence.
    policy.onAssistantMessage(agent)
    const third = await policy.onRequestError(agent, { code: CONTEXT_WINDOW_EXCEEDED_CODE }, new AbortController().signal)
    expect(third).toBe(true)
  })

  it('overflow recovery that fails after durable prune progress still earns the single retry', async () => {
    const policy = new PressurePolicyCoordinator({
      memberForAgent: agent => ({ memberId: 'member:test' as never, sessionId: agent.id }),
      compactionForAgent: () => {
        // The engine throws, but only after durable surface progress.
        const wrapper = {
          compactIfNeeded: async (agent: Agent): Promise<null> => {
            ;(agent.session.surface as { replaceGeneration: number }).replaceGeneration += 1
            throw new Error('summary failed after prune')
          },
        } as unknown as CompactionEngine
        return wrapper
      },
      log: () => {},
    })
    const { agent } = fakeAgent()
    const retry = await policy.onRequestError(agent, { code: CONTEXT_WINDOW_EXCEEDED_CODE }, new AbortController().signal)
    expect(retry).toBe(true)
  })

  it('a compaction that throws without surface progress does not earn the retry', async () => {
    const logs: string[] = []
    const policy = new PressurePolicyCoordinator({
      memberForAgent: agent => ({ memberId: 'member:test' as never, sessionId: agent.id }),
      compactionForAgent: () => {
        const engine = {
          compactIfNeeded: async (): Promise<null> => { throw new Error('engine failure') },
        } as unknown as CompactionEngine
        return engine
      },
      log: message => { logs.push(message) },
    })
    const { agent } = fakeAgent()
    const retry = await policy.onRequestError(agent, { code: CONTEXT_WINDOW_EXCEEDED_CODE }, new AbortController().signal)
    expect(retry).toBe(false)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('engine failure')
  })

  it('a lane whose proxy owns compression never retries and surfaces the overflow', async () => {
    const logs: string[] = []
    const calls: string[] = []
    const policy = new PressurePolicyCoordinator({
      memberForAgent: agent => ({ memberId: 'member:test' as never, sessionId: agent.id }),
      compactionForAgent: () => {
        const engine = {
          compactIfNeeded: async (): Promise<null> => {
            calls.push('context-overflow')
            throw new Error('422: {"code":"dsh_compaction_refused","message":"dsh native compaction call refused: the proxy owns compression on this lane"}')
          },
        } as unknown as CompactionEngine
        return engine
      },
      log: message => { logs.push(message) },
    })
    const { agent } = fakeAgent()
    expect(await policy.onRequestError(agent, { code: CONTEXT_WINDOW_EXCEEDED_CODE }, new AbortController().signal)).toBe(false)
    expect(calls).toEqual(['context-overflow'])
    // Marked as a proxy lane: later overflows on the same agent skip the
    // compaction attempt entirely and surface as ordinary failures.
    expect(await policy.onRequestError(agent, { code: CONTEXT_WINDOW_EXCEEDED_CODE }, new AbortController().signal)).toBe(false)
    expect(calls).toHaveLength(1)
    expect(logs).toHaveLength(1)
  })

  it('a compaction that advanced the surface but was aborted by the signal does not retry', async () => {
    const policy = new PressurePolicyCoordinator({
      memberForAgent: agent => ({ memberId: 'member:test' as never, sessionId: agent.id }),
      compactionForAgent: () => {
        const engine = {
          compactIfNeeded: async (): Promise<null> => { throw new Error('aborted mid-compaction') },
        } as unknown as CompactionEngine
        return engine
      },
      log: () => {},
    })
    const { agent } = fakeAgent({ replaceGeneration: 1 })
    const controller = new AbortController()
    controller.abort()
    expect(await policy.onRequestError(agent, { code: CONTEXT_WINDOW_EXCEEDED_CODE }, controller.signal)).toBe(false)
  })

  it('non-overflow failures and unknown members fall through untouched', async () => {
    const { policy, engine } = coordinator('advance')
    const { agent } = fakeAgent()
    expect(await policy.onRequestError(agent, { code: 'SOME_OTHER_CODE' }, new AbortController().signal)).toBe(false)
    expect(engine.calls).toEqual([])
    const detached = new PressurePolicyCoordinator({
      memberForAgent: () => undefined,
      compactionForAgent: () => fakeEngine('advance').engine,
      log: () => {},
    })
    expect(await detached.onRequestError(agent, { code: CONTEXT_WINDOW_EXCEEDED_CODE }, new AbortController().signal)).toBe(false)
  })
})
