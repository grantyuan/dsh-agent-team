import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MemberSupervisor,
  supervisionResetNotice,
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
  readonly escalateError?: Error
  /** Members the Host's chain already owns (open escalation, or the Human latch). */
  readonly escalationOpen?: readonly AgentTeamMemberId[]
  /** When set, the escalation-advance hook throws it. */
  readonly advanceError?: Error
}

/** A supervisor with scripted Host hooks: every action is recorded, nothing runs. */
function harness(options: HarnessOptions = {}) {
  const candidates = new Set<AgentTeamMemberId>(options.candidates ?? [builder])
  const states = new Map<AgentTeamMemberId, MemberSupervisionState>(
    Object.entries(options.states ?? {}).map(([memberId, state]) => [memberId as AgentTeamMemberId, state!]),
  )
  const opened = new Set<AgentTeamMemberId>(options.escalationOpen ?? [])
  const restarts: AgentTeamMemberId[] = []
  const escalations: Array<{ memberId: AgentTeamMemberId; trigger: SupervisionTrigger; restartAttempts: number }> = []
  const advances: number[] = []
  const logs: string[] = []
  const supervisor = new MemberSupervisor({
    candidates: () => [...candidates],
    stateOf: memberId => states.get(memberId) ?? 'healthy',
    restart: async memberId => {
      restarts.push(memberId)
      if (options.restartError !== undefined) throw options.restartError
    },
    escalate: async (memberId, trigger, restartAttempts) => {
      if (options.escalateError !== undefined) throw options.escalateError
      escalations.push({ memberId, trigger, restartAttempts })
      // The Host answers an escalation by owning the Member: the chain opens,
      // and once the reset fails to heal it the Member stays owned as the
      // Human-facing latch.
      opened.add(memberId)
    },
    advanceEscalations: async () => {
      advances.push(advances.length)
      if (options.advanceError !== undefined) throw options.advanceError
    },
    escalationOpen: memberId => opened.has(memberId),
    log: message => { logs.push(message) },
  })
  return { supervisor, candidates, states, opened, restarts, escalations, advances, logs }
}

describe('MemberSupervisor pass policy', () => {
  it('ignores Members outside the watch list entirely', async () => {
    const { supervisor, restarts, escalations } = harness({ candidates: [], states: { [helper]: 'stopped' } })
    await supervisor.runPass()
    await supervisor.runPass()
    await supervisor.runPass()
    await supervisor.runPass()
    expect(restarts).toEqual([])
    expect(escalations).toEqual([])
  })

  it('brings a stopped Member back once per pass and escalates it after the budget is spent', async () => {
    const { supervisor, restarts, escalations } = harness({ states: { [builder]: 'stopped' } })
    await supervisor.runPass()
    await supervisor.runPass()
    await supervisor.runPass()
    expect(restarts).toEqual([builder, builder, builder])
    expect(escalations).toEqual([])

    await supervisor.runPass()
    expect(restarts).toHaveLength(SUPERVISION_MAX_RESTART_ATTEMPTS)
    expect(escalations).toEqual([{ memberId: builder, trigger: 'abnormal-stop', restartAttempts: SUPERVISION_MAX_RESTART_ATTEMPTS }])

    // The escalation owns the Member now: no further pass spends a restart or
    // re-escalates it — the Host's own step is the only remedy in flight.
    await supervisor.runPass()
    await supervisor.runPass()
    expect(restarts).toHaveLength(SUPERVISION_MAX_RESTART_ATTEMPTS)
    expect(escalations).toHaveLength(1)
  })

  it('escalates nothing while a bring-up actually worked', async () => {
    const { supervisor, states, restarts, escalations } = harness({ states: { [builder]: 'stopped' } })
    await supervisor.runPass()
    await supervisor.runPass()
    states.set(builder, 'healthy')
    await supervisor.runPass()
    await supervisor.runPass()
    await supervisor.runPass()
    await supervisor.runPass()
    expect(escalations).toEqual([])
    // The healthy pass cleared the record, so the next stop starts a fresh budget.
    states.set(builder, 'stopped')
    await supervisor.runPass()
    expect(restarts).toHaveLength(SUPERVISION_MAX_RESTART_ATTEMPTS)
  })

  it('never counts or interrupts a Member that is mid-transition', async () => {
    const { supervisor, states, restarts, escalations } = harness({ states: { [builder]: 'settling' } })
    for (let pass = 0; pass < SUPERVISION_MAX_RESTART_ATTEMPTS + 2; pass += 1) await supervisor.runPass()
    expect(restarts).toEqual([])
    expect(escalations).toEqual([])

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

  it('a failed escalation is logged instead of thrown, and the pass stays usable', async () => {
    const { supervisor, restarts, logs, candidates } = harness({ states: { [builder]: 'stopped' }, escalateError: new Error('ledger is busy') })
    supervisor.onError(builder)
    supervisor.onError(builder)
    supervisor.onError(builder)
    await vi.waitFor(() => { expect(logs.filter(log => log.includes('ledger is busy'))).toHaveLength(1) })
    // The Host refused the escalation, so the Member is unowned and still on
    // the watch list: the next pass keeps working on it.
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
      escalate: async () => {},
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
  it('escalates a Member that fails the whole streak without finishing a turn', () => {
    const { supervisor, escalations } = harness()
    for (let failure = 0; failure < SUPERVISION_MAX_CONSECUTIVE_FAILURES; failure += 1) supervisor.onError(builder)
    expect(escalations).toEqual([{ memberId: builder, trigger: 'consecutive-failures', restartAttempts: 0 }])
  })

  it('a clean turn ends the streak', () => {
    vi.useFakeTimers()
    try {
      const { supervisor, escalations } = harness()
      supervisor.onError(builder)
      supervisor.onError(builder)
      supervisor.onCleanTurn(builder)
      // Beyond the rolling window the earlier occurrences stop counting, so
      // the fresh post-clean-turn streak is what the policy judges.
      vi.advanceTimersByTime(SUPERVISION_FAILURE_WINDOW_MS + 1)
      for (let failure = 0; failure < SUPERVISION_MAX_CONSECUTIVE_FAILURES - 1; failure += 1) supervisor.onError(builder)
      expect(escalations).toEqual([])
      supervisor.onError(builder)
      expect(escalations).toEqual([{ memberId: builder, trigger: 'consecutive-failures', restartAttempts: 0 }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('counts failures separated by clean turns inside the rolling window', () => {
    const { supervisor, escalations } = harness()
    for (let round = 0; round < SUPERVISION_WINDOW_FAILURES; round += 1) {
      supervisor.onError(builder)
      supervisor.onCleanTurn(builder)
    }
    expect(escalations).toEqual([{ memberId: builder, trigger: 'failure-rate', restartAttempts: 0 }])
  })

  it('forgets failures that fall out of the rolling window', () => {
    vi.useFakeTimers()
    try {
      const { supervisor, escalations } = harness()
      supervisor.onError(builder)
      supervisor.onError(builder)
      vi.advanceTimersByTime(SUPERVISION_FAILURE_WINDOW_MS + 1)
      // A clean turn between them keeps the consecutive streak at one, and the
      // expired occurrences no longer feed the rolling window.
      supervisor.onCleanTurn(builder)
      supervisor.onError(builder)
      expect(escalations).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('counts the bring-ups a Member already spent into its streak record', async () => {
    const { supervisor, escalations, states } = harness({ states: { [builder]: 'stopped' } })
    await supervisor.runPass()
    supervisor.onError(builder)
    supervisor.onError(builder)
    supervisor.onError(builder)
    await vi.waitFor(() => {
      expect(escalations).toEqual([{ memberId: builder, trigger: 'consecutive-failures', restartAttempts: 1 }])
    })
    states.set(builder, 'stopped')
    // The escalation owns the Member now, so a later pass neither nudges nor
    // re-escalates it a second time.
    await supervisor.runPass()
    expect(escalations).toHaveLength(1)
  })

  it('ignores errors from Members nobody is watching', () => {
    const { supervisor, escalations } = harness({ candidates: [] })
    for (let failure = 0; failure < SUPERVISION_MAX_CONSECUTIVE_FAILURES + 2; failure += 1) supervisor.onError(builder)
    expect(escalations).toEqual([])
  })

  it('does not re-escalate a Member whose escalation is already open', () => {
    const { supervisor, escalations } = harness({ escalationOpen: [builder] })
    for (let failure = 0; failure < SUPERVISION_MAX_CONSECUTIVE_FAILURES + 2; failure += 1) supervisor.onError(builder)
    expect(escalations).toEqual([])
  })
})

describe('MemberSupervisor tick', () => {
  it('advances the Host chain before any bring-up budget is spent', async () => {
    const { supervisor, advances, restarts } = harness({ states: { [builder]: 'stopped' } })
    await supervisor.runTick()
    expect(advances).toHaveLength(1)
    expect(restarts).toEqual([builder])
  })

  it('leaves a Member the chain already owns to the chain instead of nudging it', async () => {
    const { supervisor, states, opened, restarts, escalations, advances } = harness({ states: { [builder]: 'stopped' }, escalationOpen: [builder] })
    await supervisor.runTick()
    await supervisor.runTick()
    // The chain drives the Member; the bring-up lane spends nothing on it, so a
    // stalled chain can no longer turn into an endless stream of continues.
    expect(advances).toHaveLength(2)
    expect(restarts).toEqual([])
    expect(escalations).toEqual([])
    opened.delete(builder)
    states.set(builder, 'stopped')
    await supervisor.runTick()
    expect(restarts).toEqual([builder])
  })

  it('an exhausted Member gets no restarts and no escalations from any pass', async () => {
    // The exhausted latch is Host-owned and reaches the policy through the same
    // escalationOpen predicate: the Member reads stopped, but the Host has
    // already spent its reset, so every pass must skip it entirely.
    const { supervisor, states, restarts, escalations } = harness({ states: { [builder]: 'stopped' }, escalationOpen: [builder] })
    for (let pass = 0; pass < SUPERVISION_MAX_RESTART_ATTEMPTS + 3; pass += 1) await supervisor.runPass()
    expect(restarts).toEqual([])
    expect(escalations).toEqual([])
    states.set(builder, 'healthy')
    await supervisor.runPass()
    // Nothing lingers: a healthy read would re-arm a fresh budget (the Host
    // clears its latch on the same healthy read).
    expect(escalations).toEqual([])
  })

  it('still runs the bring-up pass when the chain advance throws', async () => {
    const { supervisor, restarts, logs } = harness({ states: { [builder]: 'stopped' }, advanceError: new Error('ledger is fenced') })
    await supervisor.runTick()
    expect(restarts).toEqual([builder])
    expect(logs.some(log => log.includes('ledger is fenced'))).toBe(true)
  })

  it('spends no escalation advance on a pass driven directly', async () => {
    const { supervisor, advances, restarts } = harness({ states: { [builder]: 'stopped' } })
    await supervisor.runPass()
    expect(advances).toHaveLength(0)
    expect(restarts).toEqual([builder])
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
    const { supervisor, restarts, advances } = harness({ states: { [builder]: 'stopped' } })
    supervisor.start()
    supervisor.start()
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(SUPERVISION_INTERVAL_MS)
    expect(restarts).toEqual([builder])
    // The timer drives the whole tick: a pass that only brought Members up would
    // leave an opened coercion chain stalled and nudge the Member forever.
    expect(advances).toHaveLength(1)

    supervisor.dispose()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(SUPERVISION_INTERVAL_MS * 3)
    expect(restarts).toHaveLength(1)
    await supervisor.runPass()
    expect(restarts).toHaveLength(1)
  })
})

describe('supervision reset notice', () => {
  const baseInput = {
    handle: 'builder',
    restartAttempts: SUPERVISION_MAX_RESTART_ATTEMPTS,
    maxRestartAttempts: SUPERVISION_MAX_RESTART_ATTEMPTS,
    maxConsecutiveFailures: SUPERVISION_MAX_CONSECUTIVE_FAILURES,
    maxWindowFailures: SUPERVISION_WINDOW_FAILURES,
    maxFailureWindowMs: SUPERVISION_FAILURE_WINDOW_MS,
  } as const

  it('heads the notice with the cause and states what the reset preserved', () => {
    const body = supervisionResetNotice({ ...baseInput, trigger: 'abnormal-stop' })
    expect(body).toContain('Supervision reset — builder')
    expect(body).toContain('builder stopped abnormally and stayed stopped after 3/3 bring-up attempts.')
    expect(body).toContain('same Member, same handle, same preset and pinned settings, same private memory, and the same Claims')
    expect(body).toContain('Nothing was archived and no replacement was created')
  })

  it('asks the Human to take over manually if the Member keeps failing', () => {
    const body = supervisionResetNotice({ ...baseInput, trigger: 'abnormal-stop' })
    expect(body).toContain('@human')
    expect(body).toContain('recover it, clear its context, or archive it')
  })

  it('names the failure streak as the cause when that is what escalated the Member', () => {
    const body = supervisionResetNotice({ ...baseInput, trigger: 'consecutive-failures', restartAttempts: 0 })
    expect(body).toContain('builder failed 3 turns in a row without finishing any of them.')
  })

  it('names the failure rate as the cause when that is what escalated the Member', () => {
    const body = supervisionResetNotice({ ...baseInput, trigger: 'failure-rate', restartAttempts: 0 })
    expect(body).toContain('builder failed 3 times within 20 minutes.')
  })
})
