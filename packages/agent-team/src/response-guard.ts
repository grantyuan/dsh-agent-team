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

/** Consecutive faulty responses allowed before the in-loop nudge stands down. */
export const RESPONSE_GUARD_MAX_CONSECUTIVE = 3

/**
 * Minimum spacing between stop-time reminders: every turn that ends with the
 * work unfinished gets a fresh continue nudge, but never more than one per
 * window. The bound keeps a model that fault-stops turn after turn from
 * hot-looping while guaranteeing the stop itself is never left unreminded.
 */
export const RESPONSE_GUARD_STOP_COOLDOWN_MS = 60_000

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
 * Trailing decoration models commonly wrap around or append after the
 * completion marker (markdown emphasis, sentence punctuation, quotation).
 * The marker must still be the last content token; only decoration past it is
 * tolerated, so "…任务结束**" closes the turn while "任务结束 and then I
 * will…" stays the faulty trailing-off round the guard recovers from.
 */
const TRAILING_DECORATION = /[\s.,;:!?'"""'`*_~\-–—…(){}\[\]。，、：；！？「」『』（）《》【】]+$/

/** Whether one trimmed visible text ends with the completion marker. */
export function endsWithCompletionMarker(trimmedText: string): boolean {
  if (trimmedText === '') return false
  if (trimmedText.endsWith(COMPLETION_MARKER)) return true
  return trimmedText.replace(TRAILING_DECORATION, '').endsWith(COMPLETION_MARKER)
}

/**
 * The visible text of one assistant response: the concatenation of every
 * `text` block, trimmed. Consumers outside the guard (the completion
 * liaison's refusal contract) read the reply prose through this single
 * extraction instead of re-walking the blocks.
 */
export function assistantPlainText(content: readonly ContentBlock[]): string {
  let text = ''
  for (const block of content) {
    if (block.type === 'text') text += block.text
  }
  return text.trim()
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
    textEndsWithMarker: endsWithCompletionMarker(trimmed),
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

/** How one stopped turn reads: it announced completion, stopped faulty, or is someone else's case. */
export type TurnStopOutcome = 'marker' | 'faulty' | 'other'

/**
 * What one completed stop's final round announces. A round ending with the
 * marker says the work is done; a text round without it (or an observed round
 * at all) says the Member stopped mid-work; a round whose last action was a
 * tool call means the loop — a context change or a hook — owned the stop,
 * which is not this guard's fault to heal.
 */
function classifyStoppedRound(shape: AssistantResponseShape | undefined): TurnStopOutcome {
  if (shape === undefined) return 'faulty'
  if (shape.textEndsWithMarker) return 'marker'
  if (shape.hasToolCall) return 'other'
  return 'faulty'
}

/** The minimal event shape the stop-tail scan reads from a stored Session log. */
interface StoppedTurnTailEvent {
  readonly type: string
  readonly seq?: number
  readonly time?: number
  readonly data?: unknown
}

/** What the last turn of one restored Session log left behind. */
export type StoppedTurnTail = 'marker' | 'faulty' | 'none'

/** One restored-tail classification: what the last turn left, and when it stopped. */
export interface StoppedTurnTailInfo {
  readonly outcome: StoppedTurnTail
  /** Millisecond stamp of the event the judgement reads; undefined when unknown. */
  readonly at: number | undefined
}

/**
 * Classify the tail of one persisted Session log after a restart: whether the
 * generation's last turn announced completion (arm the fresh-start policy),
 * stopped with the work unfinished (a recently stopped Member gets a continue
 * reminder), or left nothing the guard should act on — an intentional Human
 * abort, an error turn the recovery policy owns, or a loop-owned stop. A turn
 * whose end never landed and the synthetic `interrupted` closer resume appends
 * over a crash orphan are the restart signature and read as unfinished work;
 * `aborted` covers both a Human cancel (cause `user`/`parent`/`hook`, silence)
 * and the shutdown dispose (cause `disposed`, unfinished work).
 */
export function classifyStoppedTurnTail(events: readonly StoppedTurnTailEvent[]): StoppedTurnTailInfo {
  let lastTurnEnd: StoppedTurnTailEvent | undefined
  let lastTurnStart: StoppedTurnTailEvent | undefined
  for (const event of events) {
    if (event.type === 'turn/end') lastTurnEnd = event
    else if (event.type === 'turn/start') lastTurnStart = event
  }
  if (lastTurnEnd === undefined) {
    if (lastTurnStart === undefined) return { outcome: 'none', at: undefined }
    return { outcome: 'faulty', at: lastTurnStart.time }
  }
  const reopened = lastTurnStart !== undefined && (lastTurnStart.seq ?? 0) > (lastTurnEnd.seq ?? 0)
  const reason = (lastTurnEnd.data as { reason?: { kind?: string; reason?: { kind?: string } } } | undefined)?.reason
  if (reason?.kind === 'interrupted' || (reason?.kind === 'aborted' && reason.reason?.kind === 'disposed') || reopened) {
    return { outcome: 'faulty', at: lastTurnEnd.time }
  }
  if (reason?.kind !== 'completed') return { outcome: 'none', at: lastTurnEnd.time }
  if (reopened) return { outcome: 'faulty', at: lastTurnEnd.time }
  const shape = lastAssistantShapeBefore(events, lastTurnEnd)
  const outcome = classifyStoppedRound(shape)
  return { outcome: outcome === 'other' ? 'none' : outcome, at: lastTurnEnd.time }
}

/** The last non-interrupted assistant round of the stopped turn, newest first. */
function lastAssistantShapeBefore(events: readonly StoppedTurnTailEvent[], turnEnd: StoppedTurnTailEvent): AssistantResponseShape | undefined {
  const endSeq = turnEnd.seq ?? Number.POSITIVE_INFINITY
  for (const event of events.toReversed()) {
    if (event.type !== 'assistant/message') continue
    if ((event.seq ?? endSeq) >= endSeq) continue
    const message = (event.data as { message?: { content?: readonly ContentBlock[]; interrupted?: boolean } }).message
    if (message === undefined || message.interrupted === true) continue
    return classifyAssistantResponse(message.content ?? [])
  }
  return undefined
}

export interface ResponseGuardOptions {
  /** Deliver one "continue" nudge to the Member; throwing aborts this round's nudge. */
  readonly nudge: (memberId: AgentTeamMemberId, diagnostic: string) => void
  /** Called once when an in-loop episode reaches the faulty-response limit and the nudge stands down. */
  readonly onStandDown?: (memberId: AgentTeamMemberId, consecutiveFaults: number) => void
  /** Called when the nudge delivery itself threw; the episode is forgotten. */
  readonly onNudgeFailed?: (memberId: AgentTeamMemberId, error: unknown) => void
  /** Consecutive faulty responses allowed before the in-loop nudge stands down. */
  readonly maxConsecutive?: number
  /** Minimum spacing between stop-time reminders. */
  readonly stopCooldownMs?: number
  /** Clock seam for the stop cooldown; tests drive it directly. */
  readonly now?: () => number
}

/**
 * Per-member LLM response-shape guard with two lanes:
 *
 * - **In-loop** (`onAssistantMessage`): every completed model round that ends
 *   the turn without a tool call and without the completion marker earns one
 *   bounded "continue" nudge; the bound keeps a model that never converges
 *   from looping turn after turn within one stop.
 * - **At the stop** (`onTurnStop` / `onStoppedAtBoot`): when the turn
 *   actually ends — or a Session is restored over a turn that ended while the
 *   Host was down — the guard classifies the stop. A turn whose last round
 *   announced the marker reports `'marker'` (normal completion, and the hook
 *   the fresh-start Task policy arms on). A turn that stopped with the work
 *   unfinished reports `'faulty'` and gets a fresh continue reminder no
 *   matter how the in-loop budget was spent — the reminder that survives a
 *   stand-down — rate-limited by the stop cooldown so a stuck model is
 *   reminded at a sane cadence instead of hot-looping.
 */
export class ResponseGuardCoordinator {
  private readonly consecutiveFaults = new Map<AgentTeamMemberId, number>()
  private readonly lastRound = new Map<AgentTeamMemberId, AssistantResponseShape>()
  private readonly lastStopReminder = new Map<AgentTeamMemberId, number>()
  private readonly nudge: ResponseGuardOptions['nudge']
  private readonly onStandDown: ResponseGuardOptions['onStandDown']
  private readonly onNudgeFailed: ResponseGuardOptions['onNudgeFailed']
  private readonly maxConsecutive: number
  private readonly stopCooldownMs: number
  private readonly now: () => number

  constructor(options: ResponseGuardOptions) {
    this.nudge = options.nudge
    this.onStandDown = options.onStandDown
    this.onNudgeFailed = options.onNudgeFailed
    this.maxConsecutive = options.maxConsecutive ?? RESPONSE_GUARD_MAX_CONSECUTIVE
    this.stopCooldownMs = options.stopCooldownMs ?? RESPONSE_GUARD_STOP_COOLDOWN_MS
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * Observe one completed assistant response. An interrupted message is a
   * cancelled turn's delivered prefix — a Human abort, not a model fault — so
   * it changes nothing.
   */
  onAssistantMessage(memberId: AgentTeamMemberId, shape: AssistantResponseShape, interrupted: boolean): void {
    if (interrupted) return
    this.lastRound.set(memberId, shape)
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
    } catch (error) {
      this.onNudgeFailed?.(memberId, error)
      this.consecutiveFaults.delete(memberId)
    }
  }

  /**
   * Observe one stopped turn and heal an abnormal stop. `reasonKind` is the
   * harness turn/end reason. Only a `completed` stop is classified here: an
   * interrupted turn is a Human abort, an error turn belongs to the recovery
   * policy, and any other transition is not this guard's stop. The turn's
   * last observed round decides: the marker closes the turn normally, and a
   * stop with no continuing tool call or marker opens the next turn with a
   * continue reminder (the in-loop episode re-arms with it).
   */
  onTurnStop(memberId: AgentTeamMemberId, reasonKind: string): TurnStopOutcome {
    const last = this.lastRound.get(memberId)
    this.lastRound.delete(memberId)
    if (reasonKind !== 'completed') return 'other'
    const outcome = classifyStoppedRound(last)
    if (outcome === 'marker') {
      this.consecutiveFaults.delete(memberId)
      return 'marker'
    }
    if (outcome === 'other') return 'other'
    this.remindStoppedTurn(memberId, `the turn stopped without a tool call and without the ${COMPLETION_MARKER} marker`)
    return 'faulty'
  }

  /**
   * The restart twin of {@link onTurnStop}: a restored Session whose last
   * turn left the work unfinished gets the same rate-limited continue
   * reminder so a Member killed mid-work is brought back instead of sitting
   * stopped. A marker tail reports `'marker'` without nudging — the caller
   * arms the fresh-start policy on it.
   */
  onStoppedAtBoot(memberId: AgentTeamMemberId, tail: Exclude<StoppedTurnTail, 'none'>): TurnStopOutcome {
    if (tail === 'marker') {
      this.consecutiveFaults.delete(memberId)
      return 'marker'
    }
    this.remindStoppedTurn(memberId, `the Member was stopped with unfinished work; no reply ended with ${COMPLETION_MARKER}`)
    return 'faulty'
  }

  /** The stop-time continue reminder, bounded by the per-member cooldown. */
  private remindStoppedTurn(memberId: AgentTeamMemberId, diagnostic: string): void {
    const now = this.now()
    const previous = this.lastStopReminder.get(memberId)
    if (previous !== undefined && now - previous < this.stopCooldownMs) return
    this.lastStopReminder.set(memberId, now)
    this.consecutiveFaults.delete(memberId)
    try {
      this.nudge(memberId, diagnostic)
    } catch (error) {
      this.onNudgeFailed?.(memberId, error)
    }
  }

  dispose(): void {
    this.consecutiveFaults.clear()
    this.lastRound.clear()
    this.lastStopReminder.clear()
  }
}
