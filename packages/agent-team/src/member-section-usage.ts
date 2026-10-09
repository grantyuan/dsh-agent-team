/**
 * The Member prompt section-usage projection: how often one Member actually
 * called the tools a prompt section describes, folded on demand from the
 * Member's own session logs across the rollover lineage.
 *
 * The projection is never persisted — the Prompt dialog and the auto-prune
 * sweep compute it when they run, from the same events the session reader
 * already serves. A "turn" is the session log's own `turn/start`/`turn/end`
 * pair, so completed turns are read, not guessed. The candidate window folds
 * backwards from now and closes at whichever limit the walk hits first: the
 * last {@link PRUNE_WINDOW_TURNS} completed turns or
 * {@link PRUNE_WINDOW_DAYS} days. An unreadable archived generation (or an
 * ancestor walk that hits the depth cap while the window is still open) degrades
 * the fold to what was readable and flags it `partial` — a partial fold must
 * never drive an automatic drop, because unreadable history can only ever
 * under-count.
 *
 * @module @wowyuarm/dsh-agent-team/member-section-usage
 */

/**
 * Candidate-window turn depth: zero mapped calls within the last 20 completed
 * turns makes a tool-mapped section a prune candidate. Fixed here with the day
 * bound — the one place the window is defined.
 */
export const PRUNE_WINDOW_TURNS = 20

/**
 * Candidate-window time depth in days: the shorter of the two bounds closes
 * the window, whichever the backward walk reaches first.
 */
export const PRUNE_WINDOW_DAYS = 14

/** Milliseconds in one candidate-window day. */
const PRUNE_WINDOW_MS = PRUNE_WINDOW_DAYS * 24 * 60 * 60 * 1000

/**
 * How many archived generations one usage walk may read. Deep lineages bound
 * the walk the way the continuity timeline bounds its own; a window still open
 * past the cap is reported partial rather than silently truncated.
 */
export const MAX_USAGE_ANCESTORS = 16

/** One session event, narrowed to the shape the fold reads (mirrors SessionEvent). */
export interface UsageEvent {
  readonly type: string
  readonly time: number
  readonly data?: unknown
}

/** One lineage generation's OWN events (the inherited prefix excluded) and its lineage parent, if any. */
export interface UsageGeneration {
  readonly ownEvents: readonly UsageEvent[]
  readonly parentSession?: string
}

/** The one generation read the walker needs; `ok: false` is the degrade path. */
export type UsageAncestorRead =
  | { readonly ok: true; readonly generation: UsageGeneration }
  | { readonly ok: false }

/**
 * Running state of one backward usage fold. `counts` accumulates `tool/call`
 * names within the window; `turnsClosed` counts the completed turns the walk
 * has passed; `closed` ends the walk (the window boundary was reached);
 * `partial` marks a fold that could not prove completeness inside the window.
 */
export interface UsageFold {
  readonly counts: ReadonlyMap<string, number>
  readonly turnsClosed: number
  readonly closed: boolean
  readonly partial: boolean
  /** Fold origin instant; the day bound measures backwards from here. */
  readonly now: number
}

export function emptyUsageFold(now: number): UsageFold {
  return { counts: new Map(), turnsClosed: 0, closed: false, partial: false, now }
}

function turnNumberOf(event: UsageEvent): number | undefined {
  const turn = (event.data as { readonly turn?: unknown } | undefined)?.turn
  return typeof turn === 'number' && Number.isInteger(turn) ? turn : undefined
}

/**
 * Fold one generation's own events into the walk. Events arrive in log order
 * (oldest first) and are consumed newest-first, so the window closes at the
 * first boundary the backward walk reaches: an event older than the day bound,
 * or the turn/start that opens the {@link PRUNE_WINDOW_TURNS}-th completed
 * turn. That closing turn's own calls stay inside the window — the window is
 * the 20 most recent completed turns in full — so the walk continues one
 * turn-span past the closing `turn/end`. Turn numbers restart per generation,
 * so the seen-turn set is generation-local; the only state carried across
 * generations is the remaining turn budget.
 */
export function foldGenerationUsage(fold: UsageFold, events: readonly UsageEvent[]): UsageFold {
  if (fold.closed) return fold
  const cutoff = fold.now - PRUNE_WINDOW_MS
  const counts = new Map(fold.counts)
  let turnsClosed = fold.turnsClosed
  const seenTurns = new Set<number>()
  // Set when the turn budget is spent: the walk keeps consuming this turn's
  // calls and closes when its turn/start passes (or at the generation's end).
  let closingTurn: number | undefined
  let closed = false
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.time < cutoff) {
      closed = true
      break
    }
    if (event.type === 'tool/call') {
      const name = (event.data as { readonly name?: unknown } | undefined)?.name
      if (typeof name === 'string' && name !== '') counts.set(name, (counts.get(name) ?? 0) + 1)
      continue
    }
    if (event.type === 'turn/end') {
      const turn = turnNumberOf(event)
      if (turn !== undefined && !seenTurns.has(turn)) {
        seenTurns.add(turn)
        turnsClosed += 1
        if (turnsClosed >= PRUNE_WINDOW_TURNS) closingTurn = turn
      }
      continue
    }
    if (event.type === 'turn/start' && closingTurn !== undefined && turnNumberOf(event) === closingTurn) {
      closed = true
      break
    }
  }
  // A truncated log that never recorded the closing turn's start still ends
  // the window: the budget is spent and nothing older belongs inside it.
  if (closingTurn !== undefined) closed = true
  return {
    counts,
    turnsClosed,
    closed,
    partial: fold.partial,
    now: fold.now,
  }
}

/**
 * Walk one Member's lineage newest-first and fold the candidate window's tool
 * calls. The walk stops at the window boundary, an exhausted parent chain
 * (complete — everything the lineage holds is folded), a failed ancestor read
 * (partial — degrade to what was readable), or the ancestor cap while the
 * window is still open (partial — the same under-count risk as a failed read).
 */
export async function foldLineageUsage(
  start: UsageGeneration,
  readAncestor: (sessionId: string) => Promise<UsageAncestorRead>,
  now: number,
): Promise<UsageFold> {
  let fold = foldGenerationUsage(emptyUsageFold(now), start.ownEvents)
  let parent = start.parentSession
  let depth = 0
  while (!fold.closed && parent !== undefined && depth < MAX_USAGE_ANCESTORS) {
    const read = await readAncestor(parent)
    if (!read.ok) return { ...fold, partial: true }
    fold = foldGenerationUsage(fold, read.generation.ownEvents)
    parent = read.generation.parentSession
    depth += 1
  }
  if (!fold.closed && parent !== undefined) return { ...fold, partial: true }
  return fold
}
