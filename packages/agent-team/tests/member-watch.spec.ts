import { describe, expect, it } from 'vitest'
import {
  MemberWatchMonitor,
  memberWatchNoticeText,
  type MemberWatchNotice,
  type MemberWatchSample,
} from '../src/member-watch.ts'
import type { AgentTeamMemberId, AgentTeamMemberWatch, AgentTeamMemberWatchRef } from '../src/types.ts'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'

const leader = 'member:leader' as AgentTeamMemberId
const builder = 'member:builder' as AgentTeamMemberId
const alpha = WorkspaceId('workspace:alpha')

const watch = (overrides: Partial<AgentTeamMemberWatch> = {}): AgentTeamMemberWatch => Object.freeze({
  watchRef: 'watch:alpha' as AgentTeamMemberWatchRef,
  leaderMemberId: leader,
  memberId: builder,
  workspaceId: alpha,
  intervalMinutes: 1,
  stalledMinutes: 5,
  startedSequence: 4,
  startedAt: '2026-10-23T00:00:00.000Z',
  ...overrides,
})

const sample = (overrides: Partial<MemberWatchSample> = {}): MemberWatchSample => Object.freeze({
  state: 'healthy',
  presence: 'working',
  turns: 3,
  tasks: [],
  ...overrides,
})

interface HarnessOptions {
  readonly watches?: readonly AgentTeamMemberWatch[]
  readonly sample?: MemberWatchSample | undefined
  readonly sampleError?: Error
  readonly notifyError?: Error
  readonly leaderHandle?: string | undefined
}

/** A monitor with scripted Host hooks: every observed fact is fixed until a test moves it. */
function harness(options: HarnessOptions = {}) {
  let watches: readonly AgentTeamMemberWatch[] = options.watches ?? [watch()]
  let observed: MemberWatchSample | undefined = 'sample' in options ? options.sample : sample()
  let sampleError = options.sampleError
  let notifyError = options.notifyError
  let leaderHandle: string | undefined = 'leaderHandle' in options ? options.leaderHandle : 'leader'
  let clock = 1_000_000
  const notices: MemberWatchNotice[] = []
  const logs: string[] = []
  const monitor = new MemberWatchMonitor({
    now: () => clock,
    watches: () => watches,
    handleOf: memberId => memberId === builder ? 'builder' : undefined,
    leaderHandleOf: () => leaderHandle,
    sampleOf: async () => {
      if (sampleError !== undefined) throw sampleError
      return observed
    },
    notify: async notice => {
      if (notifyError !== undefined) throw notifyError
      notices.push(notice)
    },
    log: message => { logs.push(message) },
  })
  return {
    monitor, notices, logs,
    setClock: (next: number) => { clock = next },
    setWatches: (next: readonly AgentTeamMemberWatch[]) => { watches = next },
    setSample: (next: MemberWatchSample | undefined) => { observed = next },
    setSampleError: (next: Error | undefined) => { sampleError = next },
    setNotifyError: (next: Error | undefined) => { notifyError = next },
    setLeaderHandle: (next: string | undefined) => { leaderHandle = next },
  }
}

const minute = 60_000

describe('Member watch monitor', () => {
  it('reports the first sample as a baseline and stays quiet until its cadence elapses', async () => {
    const test = harness()
    await test.monitor.runPass()
    expect(test.notices).toHaveLength(1)
    expect(test.notices[0]).toMatchObject({ reason: 'transition', baseline: true, stateMinutes: 0, leaderHandle: 'leader', handle: 'builder' })
    // The next pass inside the watch's own interval samples nothing.
    test.setClock(1_000_000 + 30_000)
    await test.monitor.runPass()
    expect(test.notices).toHaveLength(1)
    // A cadence later the unchanged state is still not a transition.
    test.setClock(1_000_000 + minute)
    await test.monitor.runPass()
    expect(test.notices).toHaveLength(1)
    expect(test.logs).toEqual([])
  })

  it('reports a state move at the moment it happens and ages the new state from there', async () => {
    const test = harness()
    await test.monitor.runPass()
    test.setClock(1_000_000 + 2 * minute)
    test.setSample(sample({ state: 'stopped', presence: 'unavailable', diagnostic: 'runtime failure' }))
    await test.monitor.runPass()
    expect(test.notices).toHaveLength(2)
    // A transition is reported as it is observed, so its own age is zero and the
    // notice reads "just now"; the stall threshold ages the state from here.
    expect(test.notices[1]).toMatchObject({ reason: 'transition', baseline: false, stateMinutes: 0 })
    expect(test.notices[1]?.sample.diagnostic).toBe('runtime failure')
    test.setClock(1_000_000 + 3 * minute)
    await test.monitor.runPass()
    expect(test.notices).toHaveLength(2)
    test.setClock(1_000_000 + 7 * minute)
    await test.monitor.runPass()
    expect(test.notices).toHaveLength(3)
    expect(test.notices[2]).toMatchObject({ reason: 'stalled', stateMinutes: 5 })
  })

  it('reports a state that outlasts the stall threshold exactly once', async () => {
    const test = harness()
    await test.monitor.runPass()
    test.setClock(1_000_000 + 5 * minute)
    await test.monitor.runPass()
    expect(test.notices).toHaveLength(2)
    expect(test.notices[1]).toMatchObject({ reason: 'stalled', stateMinutes: 5 })
    test.setClock(1_000_000 + 8 * minute)
    await test.monitor.runPass()
    expect(test.notices).toHaveLength(2)
    // A transition re-arms the stall latch for the new state.
    test.setSample(sample({ state: 'settling', presence: 'working' }))
    test.setClock(1_000_000 + 9 * minute)
    await test.monitor.runPass()
    test.setClock(1_000_000 + 20 * minute)
    await test.monitor.runPass()
    expect(test.notices.map(notice => notice.reason)).toEqual(['transition', 'stalled', 'transition', 'stalled'])
  })

  it('ages the sampled state rather than the watch, and forgets it with the watch', async () => {
    const test = harness()
    // Nothing sampled yet: the reader keeps its own fallback.
    expect(test.monitor.sampledStateMinutes(watch().watchRef)).toBeUndefined()
    await test.monitor.runPass()
    expect(test.monitor.sampledStateMinutes(watch().watchRef)).toBe(0)
    test.setClock(1_000_000 + 3 * minute)
    await test.monitor.runPass()
    expect(test.monitor.sampledStateMinutes(watch().watchRef)).toBe(3)
    // A state move restarts the age at the moment it was observed, so a later
    // read never reports the previous state's duration.
    test.setSample(sample({ state: 'stopped', presence: 'unavailable' }))
    test.setClock(1_000_000 + 4 * minute)
    await test.monitor.runPass()
    expect(test.monitor.sampledStateMinutes(watch().watchRef)).toBe(0)
    test.setClock(1_000_000 + 9 * minute)
    expect(test.monitor.sampledStateMinutes(watch().watchRef)).toBe(5)
    // A cancelled watch keeps no memory to age.
    test.setWatches([])
    await test.monitor.runPass()
    expect(test.monitor.sampledStateMinutes(watch().watchRef)).toBeUndefined()
  })

  it('reports the Tasks a watched Member picked up or dropped', async () => {
    const test = harness()
    await test.monitor.runPass()
    test.setClock(1_000_000 + minute)
    test.setSample(sample({ tasks: [{ taskRef: 'task:alpha-7', taskNumber: 7, status: 'in_progress', subject: 'Ship the guide' }] }))
    await test.monitor.runPass()
    expect(test.notices).toHaveLength(2)
    expect(test.notices[1]).toMatchObject({ reason: 'tasks' })
    expect(test.notices[1]?.sample.tasks).toHaveLength(1)
    // The same Task in the same status is not a change.
    test.setClock(1_000_000 + 2 * minute)
    await test.monitor.runPass()
    expect(test.notices).toHaveLength(2)
  })

  it('forgets a cancelled watch and never reports it again', async () => {
    const test = harness()
    await test.monitor.runPass()
    expect(test.notices).toHaveLength(1)
    test.setWatches([])
    test.setClock(1_000_000 + 10 * minute)
    await test.monitor.runPass()
    expect(test.notices).toHaveLength(1)
    // Re-placing a watch under a new ref starts a fresh baseline.
    test.setWatches([watch({ watchRef: 'watch:beta' as AgentTeamMemberWatchRef })])
    await test.monitor.runPass()
    expect(test.notices).toHaveLength(2)
    expect(test.notices[1]?.watch.watchRef).toBe('watch:beta')
    expect(test.notices[1]?.baseline).toBe(true)
  })

  it('logs a failed sample or delivery instead of failing the pass', async () => {
    const test = harness({ sampleError: new Error('meter unavailable') })
    await test.monitor.runPass()
    expect(test.notices).toEqual([])
    expect(test.logs[0]).toContain('meter unavailable')
    test.setSampleError(undefined)
    test.setNotifyError(new Error('no Channel'))
    await test.monitor.runPass()
    expect(test.notices).toEqual([])
    expect(test.logs.some(line => line.includes('no Channel'))).toBe(true)
  })

  it('skips a Member whose handle or leader handle left the roster', async () => {
    const test = harness()
    test.setLeaderHandle(undefined)
    await test.monitor.runPass()
    expect(test.notices).toEqual([])
    test.setLeaderHandle('leader')
    test.setSample(undefined)
    await test.monitor.runPass()
    expect(test.notices).toEqual([])
  })
})

describe('Member watch notice text', () => {
  const notice = (overrides: Partial<MemberWatchNotice> = {}): MemberWatchNotice => Object.freeze({
    watch: watch(), leaderMemberId: leader, memberId: builder, workspaceId: alpha,
    leaderHandle: 'leader', handle: 'builder', reason: 'transition', sample: sample(), stateMinutes: 5, baseline: false,
    ...overrides,
  })

  it('mentions the watching leader, names the state age, and teaches the cancel call', () => {
    const text = memberWatchNoticeText(notice())
    expect(text.split('\n')[0]).toBe('@leader Team watch: builder moved to healthy (working) for 5 minutes.')
    expect(text).toContain('Context: unavailable; 3 completed turn(s).')
    expect(text).toContain('Running Tasks: none.')
    expect(text).toContain('Watching every 1 minute(s) with a 5-minute stall threshold.')
    expect(text).toContain('team_watch action=stop watchRef=watch:alpha')
  })

  it('reads a measured context and a held Task with its number', () => {
    const text = memberWatchNoticeText(notice({
      sample: sample({
        contextTokens: 120_000, contextWindow: 200_000, turns: 12,
        tasks: [{ taskRef: 'task:alpha-7', taskNumber: 7, status: 'in_progress', subject: 'Ship the guide' }],
      }),
    }))
    expect(text).toContain('Context: 120000 / 200000 tokens; 12 completed turn(s).')
    expect(text).toContain('Running Tasks: task:alpha-7 (#7) — in_progress — Ship the guide')
  })

  it('names a baseline, a stall, and a Task change in their own words', () => {
    expect(memberWatchNoticeText(notice({ baseline: true })).split('\n')[0])
      .toContain('is the baseline for your watch')
    expect(memberWatchNoticeText(notice({ reason: 'stalled' })).split('\n')[0])
      .toContain('past the 5-minute stall threshold you set')
    expect(memberWatchNoticeText(notice({ reason: 'tasks' })).split('\n')[0])
      .toContain('changed the Tasks it holds')
  })

  it('neutralizes an authored mention inside a quoted subject or diagnostic', () => {
    const text = memberWatchNoticeText(notice({
      sample: sample({
        diagnostic: 'failed for @reviewer',
        tasks: [{ taskRef: 'task:alpha-7', status: 'todo', subject: 'Ask @human about it' }],
      }),
    }))
    expect(text).toContain('failed for ＠reviewer')
    expect(text).toContain('Ask ＠human about it')
    expect(text).not.toContain('@reviewer')
    expect(text).not.toContain('@human')
  })
})
