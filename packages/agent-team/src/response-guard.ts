import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { AgentTeamMemberId } from './types.ts'

/**
 * The marker a final text-only response must end with. A response that ends
 * the turn without a tool call and without this marker is a faulty model
 * round: the Member stopped without either continuing the work or announcing
 * its completion.
 */
export const COMPLETION_MARKER = '任务结束'

/**
 * Stable summary of the response-guard continuation notice. It is a durable
 * marker: the context projection reads the summary back to classify the
 * notice as a pure reminder, so the wording must not drift.
 */
export const RESPONSE_GUARD_NOTICE_SUMMARY = 'Response guard: continue the incomplete turn'

/** Consecutive faulty responses allowed before the continue nudge stands down. */
export const RESPONSE_GUARD_MAX_CONSECUTIVE = 3

/** The observable shape of one assistant response, reduced for the guard. */
export interface AssistantResponseShape {
  /** The response requested at least one tool invocation. */
  readonly hasToolCall: boolean
  /** The response carried non-empty visible text. */
  readonly hasText: boolean
  /** The visible text ends with the completion marker. */
  readonly textEndsWithMarker: boolean
}

/**
 * Reduce one assistant response's content blocks to the shape the guard reads.
 * Text is the concatenation of every `text` block; whitespace-only text counts
 * as no text.
 */
export function classifyAssistantResponse(content: readonly ContentBlock[]): AssistantResponseShape {
  let hasToolCall = false
  let text = ''
  for (const block of content) {
    if (block.type === 'tool-call') hasToolCall = true
    else if (block.type === 'text') text += block.text
  }
  const trimmed = text.trim()
  return {
    hasToolCall,
    hasText: trimmed !== '',
    textEndsWithMarker: trimmed !== '' && trimmed.endsWith(COMPLETION_MARKER),
  }
}

/**
 * The fault rule in one place: a response that ends the turn must either
 * invoke a tool (work continues) or end its visible text with the completion
 * marker (work is announced done). A response with only thinking content — or
 * any text that just trails off — fails both and is the fault this guard
 * recovers from.
 */
export function isResponseFault(shape: AssistantResponseShape): boolean {
  return !shape.hasToolCall && (!shape.hasText || !shape.textEndsWithMarker)
}

export interface ResponseGuardOptions {
  /** Deliver one "continue" nudge to the Member; throwing aborts this round's nudge. */
  readonly nudge: (memberId: AgentTeamMemberId, diagnostic: string) => void
  /** Called once when an episode reaches the faulty-response limit and the nudge stands down. */
  readonly onStandDown?: (memberId: AgentTeamMemberId, consecutiveFaults: number) => void
  /** Consecutive faulty responses allowed before the nudge stands down. */
  readonly maxConsecutive?: number
}

/**
 * Per-member LLM response-shape guard. Every completed model round that ends
 * the turn without a tool call and without the completion marker earns one
 * bounded "continue" nudge; the bound keeps a model that never converges from
 * looping forever. Any healthy response (a tool call or a proper marker
 * ending) resets the episode.
 */
export class ResponseGuardCoordinator {
  private readonly consecutiveFaults = new Map<AgentTeamMemberId, number>()
  private readonly nudge: ResponseGuardOptions['nudge']
  private readonly onStandDown: ResponseGuardOptions['onStandDown']
  private readonly maxConsecutive: number

  constructor(options: ResponseGuardOptions) {
    this.nudge = options.nudge
    this.onStandDown = options.onStandDown
    this.maxConsecutive = options.maxConsecutive ?? RESPONSE_GUARD_MAX_CONSECUTIVE
  }

  /**
   * Observe one completed assistant response. An interrupted message is a
   * cancelled turn's delivered prefix — a Human abort, not a model fault — so
   * it changes nothing.
   */
  onAssistantMessage(memberId: AgentTeamMemberId, shape: AssistantResponseShape, interrupted: boolean): void {
    if (interrupted) return
    if (!isResponseFault(shape)) {
      this.consecutiveFaults.delete(memberId)
      return
    }
    const diagnostic = shape.hasText
      ? `the response ended without a tool call and without the ${COMPLETION_MARKER} marker`
      : 'the response carried no visible text'
    const count = (this.consecutiveFaults.get(memberId) ?? 0) + 1
    this.consecutiveFaults.set(memberId, count)
    if (count > this.maxConsecutive) {
      if (count === this.maxConsecutive + 1) this.onStandDown?.(memberId, count)
      return
    }
    try {
      this.nudge(memberId, diagnostic)
    } catch {
      this.consecutiveFaults.delete(memberId)
    }
  }

  dispose(): void {
    this.consecutiveFaults.clear()
  }
}
