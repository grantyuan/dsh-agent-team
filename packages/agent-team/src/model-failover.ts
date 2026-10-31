/**
 * LLM route failover policy for Team Members.
 *
 * A Member may pin an ordered list of backup routes (`modelFallbacks`). When
 * its live route keeps failing with provider-side errors a retry cannot fix —
 * rate limits, overload, transient network — the Host promotes the next backup
 * route on the Member's own session (`agent.model.select`), so work continues
 * on a usable API instead of burning context resets on a dead route. This
 * module owns only the counting policy and the notice texts; the Host owns the
 * session switch, the durable facts, and where the notices are posted.
 *
 * The streak is per route: switching to a backup starts that backup's own
 * budget, and a clean turn clears the current route's streak. A fresh
 * generation (activation, renewal, rollover) restarts at the pinned primary —
 * the recorded switch lives in the old session's log, not in the Member's
 * durable pin.
 *
 * @module @wowyuarm/dsh-agent-team/model-failover
 */

import type { AgentTeamModelSelection } from './types/entities.ts'

/** Consecutive recoverable route failures that trigger one promotion. */
export const MODEL_FAILOVER_THRESHOLD = 3

/** Stable first line for the failover notices, like the other coordinator markers. */
export const MODEL_FAILOVER_MARKER = 'LLM route failover:'

/** One Member's live failover memory. */
export interface RouteFailureState {
  /** `${provider}/${model}` of the route the streak counts against. */
  routeKey: string
  consecutive: number
  /** How many backups have already been promoted (also the next candidate index). */
  promoted: number
  /** True while the promotion's session switch is in flight. */
  switching: boolean
}

export function routeKeyOf(selection: AgentTeamModelSelection): string {
  return `${selection.provider}/${selection.model}`
}

/**
 * Record one recoverable route failure. Returns the backup selection to
 * promote when the streak crosses the threshold (and marks the state
 * switching), or undefined to keep retrying the current route. A route change
 * observed between errors restarts the streak on the new route.
 */
export function noteRouteFailure(
  state: RouteFailureState | undefined,
  currentRoute: AgentTeamModelSelection,
  fallbacks: readonly AgentTeamModelSelection[],
): { readonly next: RouteFailureState; readonly promote: AgentTeamModelSelection | undefined } {
  const key = routeKeyOf(currentRoute)
  const streak = state === undefined || state.routeKey !== key
    ? { routeKey: key, consecutive: 0, promoted: state?.promoted ?? 0, switching: false }
    : { ...state }
  if (streak.switching) return { next: streak, promote: undefined }
  streak.consecutive += 1
  if (streak.consecutive < MODEL_FAILOVER_THRESHOLD) return { next: streak, promote: undefined }
  const candidate = fallbacks[streak.promoted]
  if (candidate === undefined) return { next: { ...streak, consecutive: 0 }, promote: undefined }
  // The promotion owns this occurrence: the streak resets and the state is
  // latched until the session switch settles, so one failing turn cannot
  // stack a second promotion behind the first.
  return {
    next: { routeKey: key, consecutive: 0, promoted: streak.promoted + 1, switching: true },
    promote: candidate,
  }
}

/** A clean turn clears the current route's streak; the promoted index stays. */
export function clearRouteStreak(state: RouteFailureState | undefined, currentRoute: AgentTeamModelSelection): RouteFailureState | undefined {
  if (state === undefined) return undefined
  const key = routeKeyOf(currentRoute)
  if (state.routeKey !== key) return undefined
  return { ...state, consecutive: 0, switching: false }
}

/** The session switch settled: release the latch. */
export function settlePromotion(state: RouteFailureState | undefined): RouteFailureState | undefined {
  if (state === undefined) return undefined
  return { ...state, switching: false }
}

/**
 * The failover notice: what died, what replaced it, and the standing offer to
 * the Human — the pinned primary is unchanged, so a renewal or a manual edit
 * returns the Member to it. Plain text with the `@human` mention, like every
 * other coordinator notice.
 */
export function modelFailoverNoticeText(input: {
  readonly handle: string
  readonly failed: AgentTeamModelSelection
  readonly promoted: AgentTeamModelSelection
  readonly candidateIndex: number
  readonly candidateCount: number
}): string {
  return [
    `@human ${MODEL_FAILOVER_MARKER} ${input.handle}`,
    '',
    `Route ${input.failed.provider}/${input.failed.model} failed ${MODEL_FAILOVER_THRESHOLD} turns in a row with provider-side errors, so the Host switched ${input.handle} to backup route ${input.candidateIndex}/${input.candidateCount}: ${input.promoted.provider}/${input.promoted.model}.`,
    '',
    'The Member keeps working from its current context on the new route. The pinned primary is unchanged — the next fresh generation (a context renewal or rollover) or a manual model edit returns it to the primary; if every backup also fails, supervision takes over with its own remedies.',
  ].join('\n')
}

/**
 * The exhausted-latch notice: supervision's automatic remedies are spent and
 * the Member is the Human's to take over. This is the durable counterpart of
 * the process-local latch — without it the give-up would be invisible.
 */
export function supervisionExhaustedNoticeText(input: { readonly handle: string; readonly trigger: string }): string {
  return [
    `@human Supervision exhausted — ${input.handle}`,
    '',
    `${input.handle} is still failing after the Host's automatic remedies (bring-up restarts and one context reset; cause: ${input.trigger}). Nothing was archived and no replacement was created.`,
    '',
    'Supervision will spend no further automatic action on this Member until it turns healthy again or you take over: recover it, clear its context, edit it (including its model or backups), or archive it from the Team sidebar.',
  ].join('\n')
}
