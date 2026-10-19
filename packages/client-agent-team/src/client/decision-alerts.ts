import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  AgentTeamPendingDecision,
  AgentTeamPendingDecisions,
  AgentTeamPendingDecisionsRequest,
} from '@wowyuarm/dsh-agent-team/types'
import type { TeamChangeListener } from './team-changes.ts'

/**
 * How often a same-burst wake may start a refresh. Wakes arrive in clusters —
 * one commit wakes every scope — and each refresh costs one read per visible
 * Workspace, so they coalesce behind the same short debounce the sidebar badge
 * already uses.
 */
const REFRESH_DEBOUNCE_MS = 200

/**
 * What identifies one waiting decision across refreshes. The Thread says which
 * work is waiting, the ask's instant says which ask it is waiting on: a Thread
 * the reader already answered and an Agent asked about again is a new decision
 * and announces itself again, while a row that merely survived a refresh — or
 * moved position — stays quiet.
 */
function decisionKey(item: AgentTeamPendingDecision): string {
  return `${item.thread.threadRef}\u0000${item.askOccurredAt}\u0000${item.reason}`
}

type AudioContextConstructor = new () => AudioContext

let audioContext: AudioContext | undefined

/**
 * The context is created once, lazily, and never torn down: it is inert until a
 * chime rides it. Browsers start it suspended and only a user gesture may
 * resume it, so this returns the context whatever its state and leaves the
 * decision to the caller.
 */
function sharedAudioContext(): AudioContext | undefined {
  if (audioContext !== undefined) return audioContext
  const scope = globalThis as { AudioContext?: AudioContextConstructor; webkitAudioContext?: AudioContextConstructor }
  const Constructor = scope.AudioContext ?? scope.webkitAudioContext
  if (Constructor === undefined) return undefined
  try {
    audioContext = new Constructor()
    return audioContext
  } catch {
    // A blocked or exhausted audio device costs the sound, never the page.
    return undefined
  }
}

/** One sine note with a short attack and an exponential tail. */
function scheduleNote(context: AudioContext, frequency: number, startAt: number, duration: number): void {
  const oscillator = context.createOscillator()
  const envelope = context.createGain()
  oscillator.type = 'sine'
  oscillator.frequency.value = frequency
  envelope.gain.setValueAtTime(0, startAt)
  envelope.gain.linearRampToValueAtTime(0.16, startAt + 0.012)
  envelope.gain.exponentialRampToValueAtTime(0.0001, startAt + duration)
  oscillator.connect(envelope)
  envelope.connect(context.destination)
  oscillator.start(startAt)
  oscillator.stop(startAt + duration + 0.02)
}

/**
 * The two-note cue the decision queue announces a new ask with — a descending
 * doorbell rather than an alarm, because it reports work waiting rather than
 * anything wrong. Synthesized rather than shipped as an audio file: no binary
 * asset, no fetch on a path that must never fail the page, and nothing to
 * preload. A context still suspended by the autoplay policy is resumed and this
 * one cue is dropped; from the reader's first gesture on, every cue is heard.
 */
export function playDecisionChime(): void {
  const context = sharedAudioContext()
  if (context === undefined) return
  if (context.state === 'suspended') {
    void context.resume().catch(() => undefined)
    return
  }
  try {
    const start = context.currentTime
    scheduleNote(context, 880, start, 0.17)
    scheduleNote(context, 587, start + 0.13, 0.2)
  } catch {
    // The queue the cue announces is already on screen; the sound is a nicety.
  }
}

export interface TeamDecisionAlertDeps {
  /** Every Workspace this Client can see; the queue is a union across them. */
  readonly workspaceIds: () => readonly WorkspaceId[]
  readonly loadPendingDecisions: (request: AgentTeamPendingDecisionsRequest) => Promise<RemoteResult<AgentTeamPendingDecisions>>
  readonly subscribeChanges: (listener: TeamChangeListener) => () => void
}

/**
 * The Client's one cross-Workspace view of what still waits on the Human. It
 * answers two questions from one read per Workspace: how many decisions are
 * waiting (the sidebar entry's mark) and whether an ask arrived that the reader
 * has not seen yet (the cue). Both ride the Host's own `pendingDecisions`
 * projection, so neither surface can disagree with the queue page.
 *
 * Only a commit can change the queue — a Thread read moves a private watermark
 * and no decision with it — so the change stream is the whole wake source.
 * A failed refresh keeps the previous keys and count rather than reporting a
 * shrinkage the Host never committed: a transient read failure must not make
 * the whole queue look answered, nor its return look like a new arrival.
 */
export class TeamDecisionAlerts {
  private keys = new Set<string>()
  private waiting = 0
  /** The first successful read establishes the baseline: existing backlog never chimes. */
  private seeded = false
  private started = false
  private scheduled: ReturnType<typeof setTimeout> | undefined
  private unsubscribe: (() => void) | undefined
  private readonly listeners = new Set<() => void>()

  constructor(private readonly deps: TeamDecisionAlertDeps) {}

  readonly getSnapshot = (): number => this.waiting

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Begin watching; safe to call once. The first read seeds without any cue. */
  start(): void {
    if (this.started) return
    this.started = true
    this.unsubscribe = this.deps.subscribeChanges(update => {
      if (update.type === 'changed') this.schedule()
    })
    void this.refresh()
  }

  dispose(): void {
    this.started = false
    if (this.scheduled !== undefined) clearTimeout(this.scheduled)
    this.scheduled = undefined
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.listeners.clear()
  }

  private schedule(): void {
    if (this.scheduled !== undefined) return
    this.scheduled = setTimeout(() => { this.scheduled = undefined; void this.refresh() }, REFRESH_DEBOUNCE_MS)
  }

  private async refresh(): Promise<void> {
    const results = await Promise.all(this.deps.workspaceIds().map(workspaceId => this.deps.loadPendingDecisions({ workspaceId })))
    // One unreadable Workspace makes the whole picture uncertain; the previous
    // picture stands until every Workspace answers again.
    if (results.some(result => !result.ok)) return
    const keys = new Set<string>()
    let waiting = 0
    for (const result of results) {
      if (!result.ok) continue
      for (const item of result.value.items) {
        keys.add(decisionKey(item))
        waiting += 1
      }
    }
    const arrived = [...keys].some(key => !this.keys.has(key))
    const changed = waiting !== this.waiting
    this.keys = keys
    this.waiting = waiting
    if (!this.seeded) this.seeded = true
    else if (arrived) playDecisionChime()
    if (changed) for (const listener of this.listeners) listener()
  }
}
