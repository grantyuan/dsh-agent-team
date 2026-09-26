import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MemberSupervisor,
  nextReplacementHandle,
  supervisionHandoffText,
  SUPERVISION_FAILURE_WINDOW_MS,
  SUPERVISION_INTERVAL_MS,
  SUPERVISION_MAX_CONSECUTIVE_FAILURES,
  SUPERVISION_MAX_RESTART_ATTEMPTS,
  SUPERVISION_WINDOW_FAILURES,
  type MemberSupervisionState,
  type SupervisionTrigger,
} from '../src/supervisor.ts'
import type { AgentTeamMemberId } from '../src/types.ts'

const builder = 'member:builder' as AgentTeamMemberId
const helper = 'member:helper' as AgentTeamMemberId

interface HarnessOptions {
  readonly states?: Partial<Record<AgentTeamMemberId, MemberSupervisionState>>
  readonly candidates?: readonly AgentTeamMemberId[]
  readonly restartError?: Error
  readonly replaceError?: Error
}

/** A supervisor with scripted Host hooks: every action is recorded, nothing runs. */
function harness(options: HarnessOptions = {}) {
  const candidates = new Set<AgentTeamMemberId>(options.candidates ?? [builder])
  const states = new Map<AgentTeamMemberId, MemberSupervisionState>(
    Object.entries(options.states ?? {}).map(([memberId, state]) => [memberId as AgentTeamMemberId, state!]),
  )
  const restarts: AgentTeamMemberId[] = []
  const replacements: Array<{ memberId: AgentTeamMemberId; trigger: SupervisionTrigger; restartAttempts: number }> = []
  const logs: string[] = []
  const supervisor = new MemberSupervisor({
    candidates: () => [...candidates],
    stateOf: memberId => states.get(memberId) ?? 'healthy',
    restart: async memberId => {
      restarts.push(memberId)
      if (options.restartError !== undefined) throw options.restartError
    },
    replace: async (memberId, trigger, restartAttempts) => {
      if (options.replaceError !== undefined) throw options.replaceError
      replacements.push({ memberId, trigger, restartAttempts })
      candidates.delete(memberId)
    },
    log: message => { logs.push(message) },
  })
  return { supervisor, candidates, states, restarts, replacements, logs }
}

describe('replacement handle naming', () => {
  it('numbers the first generation after the archived Member keeps its own handle', () => {
    expect(nextReplacementHandle('builder', ['builder'])).toBe('builder-2')
  })

  it('skips every generation already on the roster', () => {
    expect(nextReplacementHandle('builder', ['builder', 'BUILDER-2', 'builder-3'])).toBe('builder-4')
  })

  it('derives the next generation from the failed handle itself', () => {
    expect(nextReplacementHandle('builder-2', ['builder', 'builder-2'])).toBe('builder-3')
  })
})

describe('MemberSupervisor pass policy', () => {
  it('ignores Members outside the watch list entirely', async () => {
    const { supervisor, restarts, replacements } = harness({ candidates: [], states: { [helper]: 'stopped' } })
    await supervisor.runPass()
    await supervisor.runPass()
    await supervisor.runPass()
    await supervisor.runPass()
    expect(restarts).toEqual([])
    expect(replacements).toEqual([])
  })

  it('brings a stopped Member back once per pass and replaces it after the budget is spent', async () => {
    const { supervisor, restarts, replacements } = harness({ states: { [builder]: 'stopped' } })
    await supervisor.runPass()
    await supervisor.runPass()
    await supervisor.runPass()
    expect(restarts).toEqual([builder, builder, builder])
    expect(replacements).toEqual([])

    await supervisor.runPass()
    expect(restarts).toHaveLength(SUPERVISION_MAX_RESTART_ATTEMPTS)
    expect(replacements).toEqual([{ memberId: builder, trigger: 'abnormal-stop', restartAttempts: SUPERVISION_MAX_RESTART_ATTEMPTS }])
  })

  it('replaces nothing while a bring-up actually worked', async () => {
    const { supervisor, states, restarts, replacements } = harness({ states: { [builder]: 'stopped' } })
    await supervisor.runPass()
    await supervisor.runPass()
    states.set(builder, 'healthy')
    await supervisor.runPass()
    await supervisor.runPass()
    await supervisor.runPass()
    await supervisor.runPass()
    expect(replacements).toEqual([])
    // The healthy pass cleared the record, so the next stop starts a fresh budget.
    states.set(builder, 'stopped')
    await supervisor.runPass()
    expect(restarts).toHaveLength(SUPERVISION_MAX_RESTART_ATTEMPTS)
  })

  it('never counts or interrupts a Member that is mid-transition', async () => {
    const { supervisor, states, restarts, replacements } = harness({ states: { [builder]: 'settling' } })
    for (let pass = 0; pass < SUPERVISION_MAX_RESTART_ATTEMPTS + 2; pass += 1) await supervisor.runPass()
    expect(restarts).toEqual([])
    expect(replacements).toEqual([])

    states.set(builder, 'stopped')
    await supervisor.runPass()
    expect(restarts).toEqual([builder])
  })

  it('drops a Member from the watch list once it holds no active Claim', async () => {
    const { supervisor, candidates, states, restarts } = harness({ states: { [builder]: 'stopped' } })
    await supervisor.runPass()
    candidates.delete(builder)
    await supervisor.runPass()
    candidates.add(builder)
    states.set(builder, 'stopped')
    await supervisor.runPass()
    expect(restarts).toEqual([builder, builder])
  })

  it('a failed restart hook still consumes one attempt and is logged', async () => {
    const { supervisor, restarts, logs } = harness({ states: { [builder]: 'stopped' }, restartError: new Error('preset is gone') })
    await supervisor.runPass()
    expect(restarts).toEqual([builder])
    expect(logs.some(log => log.includes('preset is gone'))).toBe(true)
  })

  it('a failed handover is logged instead of thrown, and the pass stays usable', async () => {
    const { supervisor, restarts, logs, candidates } = harness({ states: { [builder]: 'stopped' }, replaceError: new Error('ledger is busy') })
    supervisor.onError(builder)
    supervisor.onError(builder)
    supervisor.onError(builder)
    await vi.waitFor(() => { expect(logs.filter(log => log.includes('ledger is busy'))).toHaveLength(1) })
    // Nothing was archived, so the Member is still on the watch list and the
    // next pass keeps working on it.
    expect(candidates.has(builder)).toBe(true)
    await supervisor.runPass()
    expect(restarts).toEqual([builder])
  })

  it('does not start a second pass while one is still running', async () => {
    const gate = Promise.withResolvers<void>()
    let restarts = 0
    const supervisor = new MemberSupervisor({
      candidates: () => [builder],
      stateOf: () => 'stopped',
      restart: async () => { restarts += 1; await gate.promise },
      replace: async () => {},
      log: () => {},
    })
    const first = supervisor.runPass()
    await vi.waitFor(() => { expect(restarts).toBe(1) })
    await supervisor.runPass()
    expect(restarts).toBe(1)
    gate.resolve()
    await first
    await supervisor.runPass()
    expect(restarts).toBe(2)
  })
})

describe('MemberSupervisor failure streaks', () => {
  it('replaces a Member that fails the whole streak without finishing a turn', () => {
    const { supervisor, replacements } = harness()
    for (let failure = 0; failure < SUPERVISION_MAX_CONSECUTIVE_FAILURES; failure += 1) supervisor.onError(builder)
    expect(replacements).toEqual([{ memberId: builder, trigger: 'consecutive-failures', restartAttempts: 0 }])
  })

  it('a clean turn ends the streak', () => {
    vi.useFakeTimers()
    try {
      const { supervisor, replacements } = harness()
      supervisor.onError(builder)
      supervisor.onError(builder)
      supervisor.onCleanTurn(builder)
      // Beyond the rolling window the earlier occurrences stop counting, so
      // the fresh post-clean-turn streak is what the policy judges.
      vi.advanceTimersByTime(SUPERVISION_FAILURE_WINDOW_MS + 1)
      for (let failure = 0; failure < SUPERVISION_MAX_CONSECUTIVE_FAILURES - 1; failure += 1) supervisor.onError(builder)
      expect(replacements).toEqual([])
      supervisor.onError(builder)
      expect(replacements).toEqual([{ memberId: builder, trigger: 'consecutive-failures', restartAttempts: 0 }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('counts failures separated by clean turns inside the rolling window', () => {
    const { supervisor, replacements } = harness()
    for (let round = 0; round < SUPERVISION_WINDOW_FAILURES; round += 1) {
      supervisor.onError(builder)
      supervisor.onCleanTurn(builder)
    }
    expect(replacements).toEqual([{ memberId: builder, trigger: 'failure-rate', restartAttempts: 0 }])
  })

  it('forgets failures that fall out of the rolling window', () => {
    vi.useFakeTimers()
    try {
      const { supervisor, replacements } = harness()
      supervisor.onError(builder)
      supervisor.onError(builder)
      vi.advanceTimersByTime(SUPERVISION_FAILURE_WINDOW_MS + 1)
      // A clean turn between them keeps the consecutive streak at one, and the
      // expired occurrences no longer feed the rolling window.
      supervisor.onCleanTurn(builder)
      supervisor.onError(builder)
      expect(replacements).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('counts the bring-ups a Member already spent into its streak record', async () => {
    const { supervisor, replacements, states } = harness({ states: { [builder]: 'stopped' } })
    await supervisor.runPass()
    supervisor.onError(builder)
    supervisor.onError(builder)
    supervisor.onError(builder)
    await vi.waitFor(() => {
      expect(replacements).toEqual([{ memberId: builder, trigger: 'consecutive-failures', restartAttempts: 1 }])
    })
    states.set(builder, 'stopped')
    // The handover succeeded, so the Member left the roster and the watch list:
    // a later pass never handovers it a second time.
    await supervisor.runPass()
    expect(replacements).toHaveLength(1)
  })

  it('ignores errors from Members nobody is watching', () => {
    const { supervisor, replacements } = harness({ candidates: [] })
    for (let failure = 0; failure < SUPERVISION_MAX_CONSECUTIVE_FAILURES + 2; failure += 1) supervisor.onError(builder)
    expect(replacements).toEqual([])
  })
})

describe('MemberSupervisor lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('arms one interval and disarms on dispose', async () => {
    const { supervisor, restarts } = harness({ states: { [builder]: 'stopped' } })
    supervisor.start()
    supervisor.start()
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(SUPERVISION_INTERVAL_MS)
    expect(restarts).toEqual([builder])

    supervisor.dispose()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(SUPERVISION_INTERVAL_MS * 3)
    expect(restarts).toHaveLength(1)
    await supervisor.runPass()
    expect(restarts).toHaveLength(1)
  })
})

describe('handover notice', () => {
  it('asks the admin in Channel to reassign each released Claim', () => {
    const body = supervisionHandoffText({
      failedHandle: 'builder',
      replacementHandle: 'builder-2',
      trigger: 'abnormal-stop',
      restartAttempts: SUPERVISION_MAX_RESTART_ATTEMPTS,
      maxRestartAttempts: SUPERVISION_MAX_RESTART_ATTEMPTS,
      maxConsecutiveFailures: SUPERVISION_MAX_CONSECUTIVE_FAILURES,
      maxWindowFailures: SUPERVISION_WINDOW_FAILURES,
      maxFailureWindowMs: SUPERVISION_FAILURE_WINDOW_MS,
      releasedClaims: [{ direction: 'implements the parser', taskRef: 'task:11111111-1111-1111-1111-111111111111' }],
    })
    expect(body).toContain('@human')
    expect(body).toContain('`builder` stopped abnormally and stayed stopped after 3/3 bring-up attempts')
    expect(body).toContain("`builder-2`, `builder`'s same-role replacement — same preset, same pinned settings, inherited private memory, and the same Channel reach")
    expect(body).toContain('- implements the parser (task:11111111-1111-1111-1111-111111111111)')
  })

  it('names the failure streak as the cause when that is what replaced the Member', () => {
    const body = supervisionHandoffText({
      failedHandle: 'builder',
      replacementHandle: 'builder-2',
      trigger: 'consecutive-failures',
      restartAttempts: 0,
      maxRestartAttempts: SUPERVISION_MAX_RESTART_ATTEMPTS,
      maxConsecutiveFailures: SUPERVISION_MAX_CONSECUTIVE_FAILURES,
      maxWindowFailures: SUPERVISION_WINDOW_FAILURES,
      maxFailureWindowMs: SUPERVISION_FAILURE_WINDOW_MS,
      releasedClaims: [],
    })
    expect(body).toContain('failed 3 turns in a row without finishing any of them')
    expect(body).toContain('- none (its Claims were already released)')
  })
})
