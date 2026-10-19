import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MemberSupervisor,
  nextReplacementHandle,
  supervisionRetirementNotice,
  SUPERVISION_FAILURE_WINDOW_MS,
  SUPERVISION_INTERVAL_MS,
  SUPERVISION_MAX_CONSECUTIVE_FAILURES,
  SUPERVISION_MAX_RESTART_ATTEMPTS,
  SUPERVISION_WINDOW_FAILURES,
  type MemberSupervisionState,
  type SupervisionTrigger,
} from '../src/supervisor.ts'
import type { AgentTeamCompletedWork, AgentTeamMemberId, AgentTeamTaskRef } from '../src/types.ts'

const builder = 'member:builder' as AgentTeamMemberId
const helper = 'member:helper' as AgentTeamMemberId

interface HarnessOptions {
  readonly states?: Partial<Record<AgentTeamMemberId, MemberSupervisionState>>
  readonly candidates?: readonly AgentTeamMemberId[]
  readonly restartError?: Error
  readonly replaceError?: Error
  /** Members the coercion chain already owns. */
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
  const replacements: Array<{ memberId: AgentTeamMemberId; trigger: SupervisionTrigger; restartAttempts: number }> = []
  const advances: number[] = []
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
    advanceEscalations: async () => {
      advances.push(advances.length)
      if (options.advanceError !== undefined) throw options.advanceError
    },
    escalationOpen: memberId => opened.has(memberId),
    log: message => { logs.push(message) },
  })
  return { supervisor, candidates, states, opened, restarts, replacements, advances, logs }
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

describe('MemberSupervisor tick', () => {
  it('advances the Host chain before any bring-up budget is spent', async () => {
    const { supervisor, advances, restarts } = harness({ states: { [builder]: 'stopped' } })
    await supervisor.runTick()
    expect(advances).toHaveLength(1)
    expect(restarts).toEqual([builder])
  })

  it('leaves a Member the chain already owns to the chain instead of nudging it', async () => {
    const { supervisor, states, opened, restarts, advances } = harness({ states: { [builder]: 'stopped' }, escalationOpen: [builder] })
    await supervisor.runTick()
    await supervisor.runTick()
    // The chain drives the Member; the bring-up lane spends nothing on it, so a
    // stalled chain can no longer turn into an endless stream of continues.
    expect(advances).toHaveLength(2)
    expect(restarts).toEqual([])
    opened.delete(builder)
    states.set(builder, 'stopped')
    await supervisor.runTick()
    expect(restarts).toEqual([builder])
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

describe('retirement notice', () => {
  const taskRef = 'task:11111111-1111-1111-1111-111111111111' as AgentTeamTaskRef
  const work: AgentTeamCompletedWork = {
    finishedDirections: [{ direction: 'implements the parser', taskRef, taskNumber: 7, subject: 'Parse the input' }],
    completedTasks: [{ taskRef, taskNumber: 7, subject: 'Parse the input', resolution: 'accepted' }],
    participatedThreadCount: 4,
  }
  const noWork: AgentTeamCompletedWork = { finishedDirections: [], completedTasks: [], participatedThreadCount: 0 }

  it('heads the notice with the cause, lists the completed work, and asks the addressed handle to reassign each released Claim', () => {
    const body = supervisionRetirementNotice({
      failedHandle: 'builder',
      replacementHandle: 'builder-2',
      addressedHandle: 'human',
      trigger: 'abnormal-stop',
      restartAttempts: SUPERVISION_MAX_RESTART_ATTEMPTS,
      maxRestartAttempts: SUPERVISION_MAX_RESTART_ATTEMPTS,
      maxConsecutiveFailures: SUPERVISION_MAX_CONSECUTIVE_FAILURES,
      maxWindowFailures: SUPERVISION_WINDOW_FAILURES,
      maxFailureWindowMs: SUPERVISION_FAILURE_WINDOW_MS,
      completedWork: work,
      releasedClaims: [{ direction: 'implements the parser', taskNumber: 9 }],
    })
    expect(body).toContain('Supervision retirement — builder')
    expect(body).toContain('builder stopped abnormally and stayed stopped after 3/3 bring-up attempts and was archived.')
    expect(body).toContain('Completed work in service:')
    expect(body).toContain('- implements the parser (task #7)')
    expect(body).toContain('Completed tasks: 1')
    expect(body).toContain('Participated Threads: 4')
    expect(body).toContain('- implements the parser (task #9)')
    expect(body).toContain('@human please reassign the items above to builder-2.')
    expect(body).toContain("Succession: builder-2 is builder's same-role replacement: same preset, same pinned settings, inherited private memory, and the same Channel reach.")
  })

  it('addresses the reassignment ask to the designated leader when the notice is delivered to them', () => {
    const body = supervisionRetirementNotice({
      failedHandle: 'builder',
      replacementHandle: 'builder-2',
      addressedHandle: 'chief',
      trigger: 'abnormal-stop',
      restartAttempts: SUPERVISION_MAX_RESTART_ATTEMPTS,
      maxRestartAttempts: SUPERVISION_MAX_RESTART_ATTEMPTS,
      maxConsecutiveFailures: SUPERVISION_MAX_CONSECUTIVE_FAILURES,
      maxWindowFailures: SUPERVISION_WINDOW_FAILURES,
      maxFailureWindowMs: SUPERVISION_FAILURE_WINDOW_MS,
      completedWork: noWork,
      releasedClaims: [{ direction: 'implements the parser', taskNumber: 7 }],
    })
    expect(body).toContain('@chief please reassign the items above to builder-2.')
    expect(body).not.toContain('@human')
  })

  it('names the failure streak as the cause when that is what replaced the Member', () => {
    const body = supervisionRetirementNotice({
      failedHandle: 'builder',
      replacementHandle: 'builder-2',
      addressedHandle: 'human',
      trigger: 'consecutive-failures',
      restartAttempts: 0,
      maxRestartAttempts: SUPERVISION_MAX_RESTART_ATTEMPTS,
      maxConsecutiveFailures: SUPERVISION_MAX_CONSECUTIVE_FAILURES,
      maxWindowFailures: SUPERVISION_WINDOW_FAILURES,
      maxFailureWindowMs: SUPERVISION_FAILURE_WINDOW_MS,
      completedWork: noWork,
      releasedClaims: [],
    })
    expect(body).toContain('failed 3 turns in a row without finishing any of them and was archived.')
    expect(body).toContain('- none recorded')
    expect(body).toContain('- none (its Claims were already released)')
  })

  it('names the failure rate as the cause when that is what replaced the Member', () => {
    const body = supervisionRetirementNotice({
      failedHandle: 'builder',
      replacementHandle: 'builder-2',
      addressedHandle: 'human',
      trigger: 'failure-rate',
      restartAttempts: 0,
      maxRestartAttempts: SUPERVISION_MAX_RESTART_ATTEMPTS,
      maxConsecutiveFailures: SUPERVISION_MAX_CONSECUTIVE_FAILURES,
      maxWindowFailures: SUPERVISION_WINDOW_FAILURES,
      maxFailureWindowMs: SUPERVISION_FAILURE_WINDOW_MS,
      completedWork: noWork,
      releasedClaims: [],
    })
    expect(body).toContain('builder failed 3 times within 20 minutes and was archived.')
  })
})
