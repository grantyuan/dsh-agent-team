import { describe, expect, it } from 'vitest'
import type { AgentTeamModelSelection } from '../src/types/entities.ts'
import {
  clearRouteStreak,
  modelFailoverNoticeText,
  MODEL_FAILOVER_THRESHOLD,
  noteRouteFailure,
  routeKeyOf,
  settlePromotion,
  supervisionExhaustedNoticeText,
  type RouteFailureState,
} from '../src/model-failover.ts'

const primary = { provider: 'deepseek', model: 'deepseek-flash' } as const satisfies AgentTeamModelSelection
const backupOne = { provider: 'qwen', model: 'qwen3.8-flash' } as const satisfies AgentTeamModelSelection
const backupTwo = { provider: 'qwen', model: 'qwen3.8-27b' } as const satisfies AgentTeamModelSelection

function streakOf(route: AgentTeamModelSelection, consecutive: number, promoted = 0, switching = false): RouteFailureState {
  return { routeKey: routeKeyOf(route), consecutive, promoted, switching }
}

describe('noteRouteFailure', () => {
  it('promotes the first backup only when the streak crosses the threshold', () => {
    let state: RouteFailureState | undefined
    const fallbacks = [backupOne, backupTwo]
    for (let attempt = 1; attempt < MODEL_FAILOVER_THRESHOLD; attempt += 1) {
      const outcome = noteRouteFailure(state, primary, fallbacks)
      state = outcome.next
      expect(outcome.promote).toBeUndefined()
      expect(state.consecutive).toBe(attempt)
    }
    const third = noteRouteFailure(state, primary, fallbacks)
    expect(third.promote).toEqual(backupOne)
    expect(third.next.promoted).toBe(1)
    expect(third.next.consecutive).toBe(0)
    expect(third.next.switching).toBe(true)
  })

  it('gives each promoted route its own budget and stops at the last backup', () => {
    let state = streakOf(backupOne, 2, 1)
    const second = noteRouteFailure(state, backupOne, [backupOne, backupTwo])
    expect(second.promote).toEqual(backupTwo)
    expect(second.next.routeKey).toBe(routeKeyOf(backupOne))
    // The streak counts against the route that failed; the next error arrives
    // on the new route and restarts its own budget there.
    state = { ...second.next, routeKey: routeKeyOf(backupTwo) }
    const third = noteRouteFailure(streakOf(backupTwo, 2, 2), backupTwo, [backupOne, backupTwo])
    expect(third.promote).toBeUndefined()
    expect(third.next.consecutive).toBe(0)
  })

  it('restarts the streak when the live route changed underneath it', () => {
    const stale = streakOf(primary, 2, 0)
    const outcome = noteRouteFailure(stale, backupOne, [backupOne])
    expect(outcome.next.routeKey).toBe(routeKeyOf(backupOne))
    expect(outcome.next.consecutive).toBe(1)
    expect(outcome.promote).toBeUndefined()
  })

  it('stays quiet while a promotion is in flight', () => {
    const switching = streakOf(primary, 0, 1, true)
    const outcome = noteRouteFailure(switching, primary, [backupOne])
    expect(outcome.promote).toBeUndefined()
    expect(outcome.next.switching).toBe(true)
  })
})

describe('clearRouteStreak / settlePromotion', () => {
  it('a clean turn clears the current route streak and keeps the promoted index', () => {
    const cleared = clearRouteStreak(streakOf(primary, 2, 1), primary)
    expect(cleared).toEqual(streakOf(primary, 0, 1))
    // A streak counted on another route is not this turn's to clear.
    expect(clearRouteStreak(streakOf(backupOne, 2, 1), primary)).toBeUndefined()
  })

  it('settling releases only the switching latch', () => {
    expect(settlePromotion(streakOf(primary, 1, 2, true))).toEqual(streakOf(primary, 1, 2, false))
  })
})

describe('notice texts', () => {
  it('the failover notice names both routes, the order, and the return path', () => {
    const text = modelFailoverNoticeText({ handle: 'builder', failed: primary, promoted: backupOne, candidateIndex: 1, candidateCount: 2 })
    expect(text).toContain('@human LLM route failover: builder')
    expect(text).toContain('deepseek/deepseek-flash failed 3 turns in a row')
    expect(text).toContain('backup route 1/2: qwen/qwen3.8-flash')
    expect(text).toContain('The pinned primary is unchanged')
  })

  it('the exhausted notice states the spent remedies and the take-over routes', () => {
    const text = supervisionExhaustedNoticeText({ handle: 'builder', trigger: 'abnormal-stop' })
    expect(text).toContain('@human Supervision exhausted — builder')
    expect(text).toContain('Nothing was archived and no replacement was created')
    expect(text).toContain('recover it, clear its context, edit it')
  })
})
