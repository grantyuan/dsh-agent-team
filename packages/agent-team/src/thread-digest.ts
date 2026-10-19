/**
 * Pure construction and parsing for the Thread digest — the one-shot LLM call
 * that gives the Human a plain-language recap of a whole Thread, so opening a
 * message answers 「what happened and what do I need to decide」 before the
 * timeline is read. The same propose-only shape as Prompt curation: nothing
 * here touches the ledger, the digest never becomes a Team fact, and the only
 * durable action a reader can take from it is a normal reply the Client sends
 * through the existing write path.
 *
 * Inputs are injectable by design: message bodies and author handles are
 * embedded verbatim, only bounded, so a long Thread cannot grow the call
 * without bound and the tolerant reply parsing stays testable without a live
 * provider. The call is assembly-free by construction: the seam receives only
 * these two strings — the digest system instruction and the bounded
 * transcript — never tools, skills, MCP, memory or any Member's identity.
 * @module @wowyuarm/dsh-agent-team/thread-digest
 */
import type { RequestMessage } from '@deepseek-ai/dsh-llm'

/** Wall-clock bound of one digest call, raced against the client's signal. */
export const DIGEST_TIMEOUT_MS = 60_000

/** Output budget of the digest call; the recap is small by design. */
export const DIGEST_MAX_TOKENS = 1024

/** Per-message cap inside the digest input; long bodies are read for gist. */
export const DIGEST_MESSAGE_CAP = 1200

/** How many Messages the digest call reads at most, oldest first. */
export const DIGEST_MESSAGE_LIMIT = 60

/** How many final-Session transcript entries the retirement recap reads at most. */
export const DIGEST_RETIREMENT_ENTRY_LIMIT = 20

/** Caps the reply parser enforces on each digest field. */
export const DIGEST_SUMMARY_CAP = 600
export const DIGEST_KEY_POINT_LIMIT = 6
export const DIGEST_KEY_POINT_CAP = 200
export const DIGEST_QUESTION_CAP = 300
export const DIGEST_OPTION_LIMIT = 4
export const DIGEST_OPTION_CAP = 200

/** Stable first line of the system instruction, exported for the browser e2e key. */
export const DIGEST_SYSTEM_PREFIX = 'You summarize one AI team collaboration Thread for its human lead.'

/** One Thread Message as the digest call sees it. */
export interface ThreadDigestMessage {
  readonly author: string
  readonly text: string
  /** Handles this Message names, empty when it names nobody. */
  readonly mentions: readonly string[]
}

/** Everything one digest call sees. */
export interface ThreadDigestInput {
  readonly channelName?: string
  /** The Task's durable status when the Thread carries one, e.g. `in_review (awaiting acceptance)`. */
  readonly taskStatus?: string
  readonly messages: readonly ThreadDigestMessage[]
}

/** The parsed digest; `summary` is the one required field. */
export interface ThreadDigestParsed {
  readonly summary: string
  readonly keyPoints: readonly string[]
  readonly needsHumanDecision: boolean
  readonly decisionQuestion?: string
  readonly options?: readonly string[]
  /** Only alongside options: `multiple` when the model read a combinable ask. */
  readonly optionSelection?: 'single' | 'multiple'
}

function cap(text: string, cap_: number): string {
  return text.length <= cap_ ? text : `${text.slice(0, cap_)}…`
}

/**
 * Build the one-shot call: one system line plus one user turn carrying the
 * bounded transcript. The JSON shape is spelled out because the reply is
 * parsed defensively, and the model is told to answer in the language of the
 * Thread — the reader of a Chinese Thread gets a Chinese recap.
 */
export function buildDigestMessages(input: ThreadDigestInput): { readonly system: string; readonly messages: readonly RequestMessage[] } {
  const system = [
    `${DIGEST_SYSTEM_PREFIX} Write in the same language the Thread messages are written in.`,
    'Answer with EXACTLY one JSON object and nothing else — no prose, no code fences.',
    'Shape: {"summary": string, "keyPoints": string[], "needsHumanDecision": boolean,',
    '"decisionQuestion": string, "options": string[], "optionSelection": "single"|"multiple"}.',
    '- Write for a person who never saw this system: plain everyday language, complete words,',
    '  names people use for each other. Never expose internal identifiers, refs, raw handles,',
    '  tool or protocol names, or status codes — say what something means, not what the ledger',
    '  calls it (e.g. "the rework proposal" rather than "Task task:3f9a in in_review").',
    '- summary: one plain-language paragraph (max 600 chars) a busy lead can act on without reading the Thread.',
    '- keyPoints: up to 6 lines, oldest first, each one turn that matters (max 200 chars each).',
    '- needsHumanDecision: true only when the Thread is waiting on the human: someone asked the human',
    '  to choose or approve and the human has not answered since, or a Task awaits acceptance.',
    '- decisionQuestion: what exactly the human must decide, phrased so it reads as a person asking,',
    '  not as a system prompt. Only when needsHumanDecision is true.',
    '- options: the concrete alternatives the Messages actually propose, max 4 (max 200 chars each).',
    '  Never invent options the Thread never offered; omit the field when there is no choice to pick.',
    '- optionSelection: read the semantics of the ask — "single" when the options are mutually exclusive',
    '  (pick exactly one), "multiple" when the human may combine several (approve some, defer others).',
    '  Only alongside options; omit when unsure.',
    '- Omit keyPoints, decisionQuestion or options that do not apply. summary is never empty.',
  ].join('\n')
  const lines: string[] = []
  if (input.channelName !== undefined) lines.push(`Channel: #${input.channelName}`)
  if (input.taskStatus !== undefined) lines.push(`Task status: ${input.taskStatus}`)
  lines.push('', '[Thread messages, oldest first]')
  const messages = input.messages.slice(-DIGEST_MESSAGE_LIMIT)
  messages.forEach((message, index) => {
    const named = message.mentions.length === 0 ? '' : ` [names: ${message.mentions.join(', ')}]`
    lines.push(`${index + 1}. ${message.author}: ${cap(message.text, DIGEST_MESSAGE_CAP)}${named}`)
  })
  return { system, messages: [{ role: 'user', content: [{ type: 'text', text: lines.join('\n') }] }] }
}

/** Strip one optional Markdown code fence around a JSON payload. */
function unfence(text: string): string {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(text)
  return fenced?.[1] ?? text
}

function boundedStrings(value: unknown, limit: number, cap_: number): readonly string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
    .map(entry => cap(entry.trim(), cap_))
    .slice(0, limit)
}

/**
 * Parse the model reply defensively: tolerate fences, extract the first JSON
 * object, type-guard every field, and drop anything out of contract — a
 * wrong-typed or over-cap field is trimmed or ignored rather than fatal. An
 * options list without a question is meaningless, so it is dropped together.
 * A reply with no usable summary fails loudly: without it the panel has
 * nothing to show.
 */
export function parseThreadDigest(text: string): ThreadDigestParsed {
  const unfenced = unfence(text)
  const start = unfenced.indexOf('{')
  const end = unfenced.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('digest reply contains no JSON object')
  let parsed: unknown
  try {
    parsed = JSON.parse(unfenced.slice(start, end + 1))
  } catch {
    throw new Error('digest reply is not valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object') throw new Error('digest reply is not a JSON object')
  const record = parsed as Record<string, unknown>
  const summaryRaw = record.summary
  if (typeof summaryRaw !== 'string' || summaryRaw.trim() === '') throw new Error('digest reply has no summary')
  const questionRaw = record.decisionQuestion
  const question = typeof questionRaw === 'string' && questionRaw.trim() !== '' ? cap(questionRaw.trim(), DIGEST_QUESTION_CAP) : undefined
  const needsRaw = record.needsHumanDecision
  const needsHumanDecision = needsRaw === true || (question !== undefined)
  const options = needsHumanDecision && question !== undefined ? boundedStrings(record.options, DIGEST_OPTION_LIMIT, DIGEST_OPTION_CAP) : []
  // `multiple` is the only carried override: an absent or wrong-typed field
  // reads as the single-choice default on the Client, never as a third state.
  const multiple = options.length > 0 && record.optionSelection === 'multiple'
  return Object.freeze({
    summary: cap(summaryRaw.trim(), DIGEST_SUMMARY_CAP),
    keyPoints: Object.freeze(boundedStrings(record.keyPoints, DIGEST_KEY_POINT_LIMIT, DIGEST_KEY_POINT_CAP)),
    needsHumanDecision,
    ...(question === undefined ? {} : { decisionQuestion: question }),
    ...(options.length === 0 ? {} : { options: Object.freeze(options) }),
    ...(options.length === 0 || !multiple ? {} : { optionSelection: 'multiple' as const }),
  })
}
