import { describe, expect, it } from 'vitest'
import { deriveContextPressureBudget } from '../src/index.ts'

describe('route-derived context pressure budget', () => {
  it('the floor reserves reproduce the narrow-route budgets of the old fixed formula', () => {
    // 200K route: output reserve 16K floor (4% is exactly 8K at this window) —
    // 184000 / 176000, the deepseek numbers every current Member lives on.
    expect(deriveContextPressureBudget(200_000)).toEqual({ hardLimit: 184_000, handoffAt: 176_000 })
    // A model whose default output cap is smaller than the floor still pays the
    // floor: the reserve never goes below the safety minimum.
    expect(deriveContextPressureBudget(200_000, 8_000)).toEqual({ hardLimit: 184_000, handoffAt: 176_000 })
    // 112K narrow route: 96000 / 88000, unchanged as well.
    expect(deriveContextPressureBudget(112_000)).toEqual({ hardLimit: 96_000, handoffAt: 88_000 })
  })

  it('a wide route is no longer truncated by a product cap: 262K keeps 209K inside budget', () => {
    // The dev-judy-3 route: window 262000, model default output cap 32000.
    // Old formula capped handoffAt at 200000 and burned a Member at 209668
    // tokens with the hard limit still 36K away. Derived from the route, the
    // handoff reserve scales with the window (4%), so 209K stays under budget.
    expect(deriveContextPressureBudget(262_000, 32_000)).toEqual({ hardLimit: 230_000, handoffAt: 219_520 })
    // No defaultMaxTokens disclosed: the floor reserve prices the same route.
    expect(deriveContextPressureBudget(262_000)).toEqual({ hardLimit: 246_000, handoffAt: 235_520 })
  })

  it('a large model-disclosed output cap is reserved in full, shrinking the input budget', () => {
    // 320K route with a 64K default output cap: the request really can spend
    // 64K on the answer, so the context must stop 64K short of the window.
    expect(deriveContextPressureBudget(320_000, 64_000)).toEqual({ hardLimit: 256_000, handoffAt: 243_200 })
  })

  it('a degenerate route floors both budgets at zero instead of going negative', () => {
    expect(deriveContextPressureBudget(20_000, 32_000)).toEqual({ hardLimit: 0, handoffAt: 0 })
  })
})
