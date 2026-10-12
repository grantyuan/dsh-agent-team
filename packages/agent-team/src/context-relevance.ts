/**
 * Dispatch-time context relevance, decided by a model.
 *
 * A `fresh` Member (每个任务全新上下文) that finished its work keeps a live
 * Session full of the task it just closed. Renewing it before the next
 * assignment is the point of the policy — unless the next assignment really
 * continues that work, in which case the erase throws away the thing the new
 * task needs. That is a semantic question ("same lane, reworded" versus "a new
 * card in the same repository"), and a lexical measure cannot tell them apart:
 * measured against this Team's live ledger, whole-text overlap put both in the
 * same band. So the Host asks a model.
 *
 * Only one thing reaches the model: the incoming assignment against the Member's
 * recent work — its last few authored Messages plus the content of the Task it
 * most recently claimed. The answer is one bounded number, the Host applies the
 * threshold, and nothing durable is written: the judgement is an ephemeral
 * delivery decision, never a Team fact.
 *
 * This module is pure construction and parsing — the same shape the Prompt
 * dialog's curation call uses — so the prompt contract and the tolerant reply
 * parsing stay testable without a live provider.
 * @module @wowyuarm/dsh-agent-team/context-relevance
 */
import type { RequestMessage } from '@deepseek-ai/dsh-llm'

/** The model's score must reach this for the dispatch to keep the live context. */
export const CONTEXT_RELEVANCE_THRESHOLD = 0.6

/** How many of the Member's own recent Messages the judgement reads. */
export const DISPATCH_HISTORY_MESSAGE_LIMIT = 5

/** Wall-clock bound of one judgement call; a stuck provider must not pin a dispatch. */
export const RELEVANCE_JUDGE_TIMEOUT_MS = 20_000

/** The reply is one small JSON object, so the output budget stays tiny. */
export const RELEVANCE_JUDGE_MAX_TOKENS = 256

/** Per-item cap inside the judgement input; long Task bodies are read for topic, not in full. */
export const RELEVANCE_JUDGE_ITEM_CAP = 1200

/** Cap on the incoming assignment body inside the judgement input. */
export const RELEVANCE_JUDGE_TASK_CAP = 4000

/** Stable first line of the system instruction, exported for the browser e2e key. */
export const RELEVANCE_JUDGE_SYSTEM_PREFIX = 'You decide whether one new assignment continues a member\'s current work.'

/** Everything one judgement sees. */
export interface RelevanceJudgeInput {
  readonly handle: string
  /** The assignment being dispatched. */
  readonly task: string
  /** The Member's recent work, newest first: authored Messages, then its latest claimed Task. */
  readonly history: readonly string[]
}

/** One-shot model call: system line plus the single user turn carrying both sides. */
export function buildRelevanceJudge(input: RelevanceJudgeInput): { readonly system: string, readonly messages: readonly RequestMessage[] } {
  const items = input.history
    .map(item => bounded(item, RELEVANCE_JUDGE_ITEM_CAP))
    .filter(item => item.trim() !== '')
  const system = [
    `${RELEVANCE_JUDGE_SYSTEM_PREFIX} Judge only whether the new assignment depends on what the`,
    'member already holds from its recent work: the same file, module, task, decision, or open',
    'thread of investigation. Rewording does not make it a different task, and the same',
    'repository or team does not make it the same task.',
    'Answer with EXACTLY one JSON object and no prose:',
    '{"relevance": <number from 0 to 1>}',
    'where 0 is a brand-new task and 1 is the very same work continued.',
  ].join(' ')
  const turns = items.map((item, index) => `${index + 1}. ${item}`).join('\n')
  const user = [
    `Member: @${input.handle}`,
    '',
    '[New assignment]',
    bounded(input.task, RELEVANCE_JUDGE_TASK_CAP),
    '',
    '[The member\'s recent work, newest first]',
    turns,
    '',
    'How much does the new assignment depend on that recent work?',
  ].join('\n')
  return { system, messages: [{ source: 'user', content: [{ type: 'text', text: user }] } as unknown as RequestMessage] }
}

/**
 * The model's relevance score, or undefined when the reply carries no usable
 * number. Parsing is deliberately tolerant — the reply rides a normal assistant
 * turn whose trailing completion marker, prose, or markdown fence must not turn
 * a readable score into a failure — and out-of-range numbers are clamped.
 */
export function parseRelevanceScore(text: string): number | undefined {
  const candidate = firstRelevanceNumber(jsonObjects(text)) ?? proseRelevanceNumber(text)
  if (candidate === undefined || !Number.isFinite(candidate)) return undefined
  return Math.min(1, Math.max(0, candidate))
}

/** Every balanced `{...}` span in the reply, innermost first. */
function jsonObjects(text: string): string[] {
  const found: string[] = []
  let start = -1
  let depth = 0
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === '{') {
      if (depth === 0) start = index
      depth += 1
    } else if (character === '}' && depth > 0) {
      depth -= 1
      if (depth === 0 && start >= 0) found.push(text.slice(start, index + 1))
    }
  }
  return found
}

/** The `relevance` value of the first reply object that carries a usable one. */
function firstRelevanceNumber(objects: readonly string[]): number | undefined {
  for (const source of objects) {
    const match = source.match(/"relevance"\s*:\s*"?(-?\d+(?:\.\d+)?)"?/)
    const value = match?.[1]
    if (value !== undefined) return Number.parseFloat(value)
  }
  return undefined
}

/** A bare `relevance: 0.8` (or 相关性 0.8) outside any JSON object. */
function proseRelevanceNumber(text: string): number | undefined {
  const match = text.match(/(?:relevance|相关性)[^0-9-]{0,24}(-?\d+(?:\.\d+)?)/i)
  const value = match?.[1]
  return value === undefined ? undefined : Number.parseFloat(value)
}

function bounded(text: string, cap: number): string {
  const trimmed = text.trim()
  return trimmed.length <= cap ? trimmed : `${trimmed.slice(0, cap)}…`
}
