import { describe, expect, it } from 'vitest'
import {
  buildDigestMessages,
  DIGEST_KEY_POINT_LIMIT,
  DIGEST_MESSAGE_CAP,
  DIGEST_SUMMARY_CAP,
  DIGEST_SYSTEM_PREFIX,
  parseThreadDigest,
} from '../src/thread-digest.ts'

const MESSAGES = [
  { author: 'human', text: '评估一下发布走 A 方案还是 B 方案', mentions: ['builder'] },
  { author: 'builder', text: 'A 方案稳，B 方案快但需要迁移数据', mentions: ['human'] },
]

describe('Thread digest construction', () => {
  it('asks for exactly one JSON digest and the no-invented-options rule', () => {
    const { system } = buildDigestMessages({ messages: MESSAGES })
    expect(system.startsWith(DIGEST_SYSTEM_PREFIX)).toBe(true)
    expect(system).toContain('"summary": string')
    expect(system).toContain('Never invent options the Thread never offered')
    expect(system).toContain('"optionSelection"')
  })

  it('puts channel, task status, and the bounded transcript into the one user turn', () => {
    const { messages } = buildDigestMessages({ channelName: 'delivery', taskStatus: 'in_review (awaiting Human acceptance)', messages: MESSAGES })
    const text = JSON.stringify(messages)
    expect(text).toContain('Channel: #delivery')
    expect(text).toContain('awaiting Human acceptance')
    expect(text).toContain('1. human: 评估一下发布走 A 方案还是 B 方案 [names: builder]')
    expect(text).toContain('2. builder: A 方案稳')
  })

  it('caps each message body and keeps the newest window', () => {
    const long = Array.from({ length: 70 }, (_, index) => ({ author: `m${index}`, text: `${index % 10}${'x'.repeat(DIGEST_MESSAGE_CAP)}`, mentions: [] }))
    const { messages } = buildDigestMessages({ messages: long })
    const text = JSON.stringify(messages)
    // One digit leads every body, so a capped line shows exactly CAP-1 x's and
    // the ellipsis; the window drops the oldest ten turns.
    expect(text).toContain(`${'x'.repeat(DIGEST_MESSAGE_CAP - 1)}…`)
    expect(text).not.toContain('x'.repeat(DIGEST_MESSAGE_CAP))
    expect(text).not.toContain('m0:')
    expect(text).toContain('60. m69:')
  })
})

describe('Thread digest parsing', () => {
  it('reads a clean or fenced object', () => {
    expect(parseThreadDigest('{"summary": "发布方案讨论中", "keyPoints": ["human 发起评估", "builder 给出两案"]}')).toEqual({
      summary: '发布方案讨论中',
      keyPoints: ['human 发起评估', 'builder 给出两案'],
      needsHumanDecision: false,
    })
    const fenced = parseThreadDigest('```json\n{"summary": "ok", "needsHumanDecision": true, "decisionQuestion": "走哪个方案?", "options": ["A", "B"]}\n```')
    expect(fenced).toMatchObject({ needsHumanDecision: true, decisionQuestion: '走哪个方案?', options: ['A', 'B'] })
  })

  it('derives the decision flag from a question even when the field lies', () => {
    const parsed = parseThreadDigest('{"summary": "ok", "needsHumanDecision": false, "decisionQuestion": "批准吗?"}')
    expect(parsed.needsHumanDecision).toBe(true)
    expect(parsed.decisionQuestion).toBe('批准吗?')
  })

  it('drops options without a question, trims entries, and enforces caps', () => {
    const orphaned = parseThreadDigest(`{"summary": "ok", "options": ["A", "B"]}`)
    expect(orphaned.options).toBeUndefined()
    const padded = parseThreadDigest(JSON.stringify({
      summary: 'y'.repeat(DIGEST_SUMMARY_CAP + 40),
      keyPoints: Array.from({ length: DIGEST_KEY_POINT_LIMIT + 4 }, (_, index) => `点${index}  `).concat(['', '  ']),
    }))
    expect(padded.summary.length).toBe(DIGEST_SUMMARY_CAP + 1)
    expect(padded.keyPoints).toHaveLength(DIGEST_KEY_POINT_LIMIT)
    expect(padded.keyPoints[0]).toBe('点0')
  })

  it('fails loudly when there is no usable summary', () => {
    expect(() => parseThreadDigest('一切顺利，无需决策。')).toThrow(/no JSON object/)
    expect(() => parseThreadDigest('{"summary": "  "}')).toThrow(/no summary/)
    expect(() => parseThreadDigest('{"summary": {}}')).toThrow(/no summary/)
  })

  it("carries the multi-select read only when it is real and options exist", () => {
    const combinable = parseThreadDigest('{"summary": "ok", "decisionQuestion": "先做哪些?", "options": ["A", "B"], "optionSelection": "multiple"}')
    expect(combinable.optionSelection).toBe('multiple')
    // `single` and out-of-contract values never reach the Client as a third state.
    const exclusive = parseThreadDigest('{"summary": "ok", "decisionQuestion": "走哪个?", "options": ["A", "B"], "optionSelection": "single"}')
    expect(exclusive.optionSelection).toBeUndefined()
    const garbage = parseThreadDigest('{"summary": "ok", "decisionQuestion": "走哪个?", "options": ["A"], "optionSelection": "choose-two"}')
    expect(garbage.optionSelection).toBeUndefined()
    // A selection mode without an options list is dropped with it.
    const orphaned = parseThreadDigest('{"summary": "ok", "needsHumanDecision": true, "optionSelection": "multiple"}')
    expect(orphaned.options).toBeUndefined()
    expect(orphaned.optionSelection).toBeUndefined()
  })
})
