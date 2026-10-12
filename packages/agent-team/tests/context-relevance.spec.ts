import { describe, expect, it } from 'vitest'
import {
  buildRelevanceJudge,
  CONTEXT_RELEVANCE_THRESHOLD,
  parseRelevanceScore,
  RELEVANCE_JUDGE_ITEM_CAP,
  RELEVANCE_JUDGE_SYSTEM_PREFIX,
} from '../src/context-relevance.ts'

const HISTORY = '装配 kv_cache_unified.rs 的 KvCacheUnifiedConfig 三跳配置完成，收线跑 cargo test --features kv-cache protocol-redis 全量门 0 failed'
const TASK = '接着补 kv_cache_unified.rs 的第四跳 KvCacheUnifiedConfig'

describe('dispatch relevance judge', () => {
  it('asks for exactly one bounded JSON answer', () => {
    const { system } = buildRelevanceJudge({ handle: 'worker', task: TASK, history: [HISTORY] })
    expect(system.startsWith(RELEVANCE_JUDGE_SYSTEM_PREFIX)).toBe(true)
    expect(system).toContain('{"relevance": <number from 0 to 1>}')
    // The prompt refuses the failure mode the lexical measure had: same repo,
    // same team, same polite boilerplate all reading as continuity.
    expect(system).toContain('the same')
  })

  it('puts the assignment and the member window into the one user turn', () => {
    const { messages } = buildRelevanceJudge({ handle: 'worker', task: TASK, history: [HISTORY, '第二项近期工作'] })
    const text = JSON.stringify(messages)
    expect(text).toContain('New assignment')
    expect(text).toContain(TASK)
    expect(text).toContain('1. 装配 kv_cache_unified.rs')
    expect(text).toContain('2. 第二项近期工作')
    expect(text).toContain('@worker')
  })

  it('bounds each input piece and skips empty history items', () => {
    const { messages } = buildRelevanceJudge({ handle: 'worker', task: TASK, history: ['x'.repeat(RELEVANCE_JUDGE_ITEM_CAP + 900), '   '] })
    const text = JSON.stringify(messages)
    expect(text).toContain(`${'x'.repeat(RELEVANCE_JUDGE_ITEM_CAP)}…`)
    expect(text).not.toContain('x'.repeat(RELEVANCE_JUDGE_ITEM_CAP + 1))
    expect(text).not.toContain('2.')
  })

  it('reads the score out of a clean, fenced, or rambling reply', () => {
    expect(parseRelevanceScore('{"relevance": 0.87}')).toBe(0.87)
    expect(parseRelevanceScore('```json\n{"relevance": "0.8"}\n```')).toBe(0.8)
    expect(parseRelevanceScore('Same lane as the wiring task.\n{"reason": "same file", "relevance": 0.72}')).toBe(0.72)
    expect(parseRelevanceScore('{"relevance": 0.9}')).toBe(0.9)
    expect(parseRelevanceScore('relevance: 0.4')).toBe(0.4)
    expect(parseRelevanceScore('相关性 0.35')).toBe(0.35)
  })

  it('clamps out-of-range scores and refuses to invent one', () => {
    expect(parseRelevanceScore('{"relevance": 7}')).toBe(1)
    expect(parseRelevanceScore('{"relevance": -2}')).toBe(0)
    expect(parseRelevanceScore('I cannot decide without more context.')).toBeUndefined()
    expect(parseRelevanceScore('')).toBeUndefined()
    expect(parseRelevanceScore('{"confidence": 0.9}')).toBeUndefined()
  })

  it('keeps at or above the threshold and renews below it', () => {
    const input = { handle: 'worker', task: TASK, history: [HISTORY] }
    expect(CONTEXT_RELEVANCE_THRESHOLD).toBe(0.6)
    expect(parseRelevanceScore('{"relevance": 0.6}')! >= CONTEXT_RELEVANCE_THRESHOLD).toBe(true)
    expect(parseRelevanceScore('{"relevance": 0.59}')! >= CONTEXT_RELEVANCE_THRESHOLD).toBe(false)
    expect(input.task).toBe(TASK)
  })
})
