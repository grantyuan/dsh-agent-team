import { describe, expect, it } from 'vitest'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import {
  MAX_USAGE_ANCESTORS,
  foldGenerationUsage,
  foldLineageUsage,
  emptyUsageFold,
  type UsageEvent,
  type UsageFold,
  type UsageGeneration,
} from '../src/member-section-usage.ts'

const DAY_MS = 24 * 60 * 60 * 1000
/** Fixed fold origin; the day bound measures backwards from here. */
const NOW = 1_800_000_000_000

/** Events carry the real log shape: contiguous seqs along with type/time/data. */
let nextSeq = 0

function turnStart(turn: number, time: number): UsageEvent {
  return { type: 'turn/start', seq: nextSeq++ as SessionSeq, time, data: { turn } }
}

function turnEnd(turn: number, time: number): UsageEvent {
  return { type: 'turn/end', seq: nextSeq++ as SessionSeq, time, data: { turn, reason: { kind: 'completed' } } }
}

function toolCall(name: string, time: number): UsageEvent {
  return { type: 'tool/call', seq: nextSeq++ as SessionSeq, time, data: { turn: 0, step: 1, callId: 'call' as ToolCallId, name, arguments: '{}' } }
}

/** One completed turn in log order: its start, the named calls, its end. */
function completedTurn(turn: number, startTime: number, tools: readonly string[] = []): UsageEvent[] {
  let time = startTime
  const events: UsageEvent[] = [turnStart(turn, time)]
  for (const name of tools) {
    time += 1000
    events.push(toolCall(name, time))
  }
  time += 1000
  events.push(turnEnd(turn, time))
  return events
}

/**
 * `count` completed turns numbered 0..count-1, each `TURN_SPAN` wide, ending
 * just before `endTime`. `tools[turn]` names the calls made inside that turn.
 */
const TURN_SPAN = 10_000
function generation(count: number, endTime: number, tools: readonly (readonly string[])[] = []): UsageEvent[] {
  const events: UsageEvent[] = []
  const startTime = endTime - count * TURN_SPAN
  for (let turn = 0; turn < count; turn += 1) {
    events.push(...completedTurn(turn, startTime + turn * TURN_SPAN, tools[turn] ?? []))
  }
  return events
}

function fold(events: readonly UsageEvent[]): UsageFold {
  return foldGenerationUsage(emptyUsageFold(NOW), events)
}

function countEntries(fold: UsageFold): ReadonlyArray<[string, number]> {
  return [...fold.counts.entries()].sort(([left], [right]) => left.localeCompare(right))
}

describe('foldGenerationUsage', () => {
  it('counts tool calls per name and the completed turns', () => {
    const events = [
      ...completedTurn(0, NOW - 40_000, ['alpha', 'beta', 'alpha']),
      ...completedTurn(1, NOW - 20_000, ['alpha']),
    ]
    const result = fold(events)
    expect(countEntries(result)).toEqual([['alpha', 3], ['beta', 1]])
    expect(result.turnsClosed).toBe(2)
    expect(result.closed).toBe(false)
    expect(result.partial).toBe(false)
  })

  it('ignores an empty tool name', () => {
    const events: UsageEvent[] = [
      turnStart(0, NOW - 30_000),
      { type: 'tool/call', seq: nextSeq++ as SessionSeq, time: NOW - 28_000, data: { turn: 0, step: 1, callId: 'b' as ToolCallId, name: '', arguments: '{}' } },
      turnEnd(0, NOW - 26_000),
    ]
    const result = fold(events)
    expect(result.counts.size).toBe(0)
  })

  it('counts the closing turn\'s calls and closes at its turn/start', () => {
    const tools = Array.from({ length: 20 }, (_, turn) => (turn === 19 ? ['late'] : ['old']))
    const result = fold(generation(20, NOW, tools))
    expect(countEntries(result)).toEqual([['late', 1], ['old', 19]])
    expect(result.turnsClosed).toBe(20)
    expect(result.closed).toBe(true)
  })

  it('keeps the window open below the turn bound', () => {
    const result = fold(generation(19, NOW, Array.from({ length: 19 }, () => ['old'])))
    expect(result.turnsClosed).toBe(19)
    expect(result.closed).toBe(false)
  })

  it('closes at the day bound and drops older calls', () => {
    const events = [
      ...completedTurn(0, NOW - 14 * DAY_MS - 60_000, ['ancient']),
      ...completedTurn(1, NOW - 10_000, ['recent']),
    ]
    const result = fold(events)
    expect(countEntries(result)).toEqual([['recent', 1]])
    expect(result.closed).toBe(true)
  })

  it('counts events exactly at the cutoff (the bound is exclusive only backwards)', () => {
    const result = fold(completedTurn(0, NOW - 14 * DAY_MS, ['edge']))
    expect(countEntries(result)).toEqual([['edge', 1]])
    expect(result.closed).toBe(false)
  })

  it('a truncated log that never records the closing turn/start still closes', () => {
    const events: UsageEvent[] = []
    for (let turn = 0; turn < 20; turn += 1) {
      events.push(toolCall('x', NOW - 50_000 + turn * 1000), turnEnd(turn, NOW - 50_000 + turn * 1000 + 500))
    }
    const result = fold(events)
    expect(countEntries(result)).toEqual([['x', 20]])
    expect(result.turnsClosed).toBe(20)
    expect(result.closed).toBe(true)
  })

  it('returns an already-closed fold unchanged', () => {
    const closed: UsageFold = { ...emptyUsageFold(NOW), closed: true }
    expect(foldGenerationUsage(closed, completedTurn(0, NOW - 1000, ['x']))).toBe(closed)
  })
})

describe('foldLineageUsage', () => {
  it('folds a single generation without reading ancestors', async () => {
    const result = await foldLineageUsage(
      { ownEvents: generation(3, NOW, [['a'], ['b'], ['a']]) },
      async () => { throw new Error('this walk must not read ancestors') },
      NOW,
    )
    expect(countEntries(result)).toEqual([['a', 2], ['b', 1]])
    expect(result.closed).toBe(false)
    expect(result.partial).toBe(false)
  })

  it('carries the turn budget across generations and counts ancestor calls', async () => {
    const readParents: string[] = []
    const result = await foldLineageUsage(
      { ownEvents: generation(8, NOW, Array.from({ length: 8 }, () => ['child'])), parentSession: 'parent' },
      async sessionId => {
        readParents.push(sessionId)
        return { ok: true, generation: { ownEvents: generation(15, NOW - 60_000, Array.from({ length: 15 }, () => ['parent'])) } }
      },
      NOW,
    )
    // 8 child turns + 12 of the parent's 15: the window closes mid-parent.
    expect(countEntries(result)).toEqual([['child', 8], ['parent', 12]])
    expect(result.turnsClosed).toBe(20)
    expect(result.closed).toBe(true)
    expect(result.partial).toBe(false)
    expect(readParents).toEqual(['parent'])
  })

  it('never reads ancestors once the window closed in the start generation', async () => {
    const result = await foldLineageUsage(
      { ownEvents: generation(25, NOW), parentSession: 'parent' },
      async () => { throw new Error('the window closed before any ancestor read') },
      NOW,
    )
    expect(result.closed).toBe(true)
    expect(result.partial).toBe(false)
  })

  it('flags a failed ancestor read as partial and keeps the readable counts', async () => {
    const result = await foldLineageUsage(
      { ownEvents: generation(2, NOW, [['child'], ['child']]), parentSession: 'unreadable' },
      async () => ({ ok: false }),
      NOW,
    )
    expect(countEntries(result)).toEqual([['child', 2]])
    expect(result.closed).toBe(false)
    expect(result.partial).toBe(true)
  })

  it('flags an exhausted ancestor cap as partial while the window is still open', async () => {
    const generations = new Map<string, UsageGeneration>()
    const depth = MAX_USAGE_ANCESTORS + 4
    for (let index = 0; index < depth; index += 1) {
      generations.set(`gen-${index}`, {
        ownEvents: completedTurn(0, NOW - (index + 1) * 60_000, [`tool-${index}`]),
        ...(index === 0 ? {} : { parentSession: `gen-${index - 1}` }),
      })
    }
    const readParents: string[] = []
    const result = await foldLineageUsage(
      { ownEvents: generations.get(`gen-${depth - 1}`)!.ownEvents, parentSession: `gen-${depth - 2}` },
      async sessionId => {
        readParents.push(sessionId)
        const generation = generations.get(sessionId)
        return generation === undefined ? { ok: false } : { ok: true, generation }
      },
      NOW,
    )
    // 1 start generation + 16 ancestors = 17 turns, window still open, and a
    // parent remains: the walk reports partial rather than silently stopping.
    expect(readParents).toHaveLength(MAX_USAGE_ANCESTORS)
    expect(result.turnsClosed).toBe(MAX_USAGE_ANCESTORS + 1)
    expect(result.closed).toBe(false)
    expect(result.partial).toBe(true)
  })

  it('closes at the day bound across generations without marking partial', async () => {
    const result = await foldLineageUsage(
      { ownEvents: generation(1, NOW, [['child']]), parentSession: 'ancient' },
      async () => ({ ok: true, generation: { ownEvents: generation(3, NOW - 20 * DAY_MS, [['ancient']]) } }),
      NOW,
    )
    expect(countEntries(result)).toEqual([['child', 1]])
    expect(result.closed).toBe(true)
    expect(result.partial).toBe(false)
  })

  it('treats turn numbers as generation-local (they restart per rollover)', async () => {
    // Both generations number their turns 0..n; the count must not dedupe the
    // reused numbers — the seen-turn set resets per generation.
    const child = generation(10, NOW, Array.from({ length: 10 }, () => ['child']))
    const result = await foldLineageUsage(
      { ownEvents: child, parentSession: 'parent' },
      async () => ({ ok: true, generation: { ownEvents: generation(10, NOW - 60_000, Array.from({ length: 10 }, () => ['parent'])) } }),
      NOW,
    )
    expect(result.turnsClosed).toBe(20)
    expect(result.closed).toBe(true)
    expect(countEntries(result)).toEqual([['child', 10], ['parent', 10]])
  })
})
