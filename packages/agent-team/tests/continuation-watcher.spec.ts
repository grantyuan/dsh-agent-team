import { describe, expect, it, vi } from 'vitest'
import {
  TaskContinuationWatcher,
  continuationNudgeText,
  CONTINUATION_INTERVAL_MS,
  CONTINUATION_QUIET_MS,
  type ContinuationTask,
} from '../src/continuation-watcher.ts'
import type { AgentTeamMemberId } from '../src/types.ts'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'

const builder = 'member:builder' as AgentTeamMemberId
const reviewer = 'member:reviewer' as AgentTeamMemberId
const alpha = WorkspaceId('workspace:alpha')
const beta = WorkspaceId('workspace:beta')

const openTask = (workspaceId: WorkspaceId, taskRef: string, status = 'todo', subject = 'Ship the thing'): ContinuationTask =>
  ({ workspaceId, taskRef, taskNumber: 7, status, subject })

interface HarnessOptions {
  readonly members?: readonly AgentTeamMemberId[]
  readonly presence?: Partial<Record<AgentTeamMemberId, 'available' | 'working' | 'error' | 'unavailable'>>
  readonly tasks?: readonly ContinuationTask[]
  readonly leaders?: Partial<Record<string, { readonly memberId: AgentTeamMemberId; readonly handle: string } | undefined>>
}

/** A watcher with scripted Host hooks: every fact is fixed until a test mutates it. */
function harness(options: HarnessOptions = {}) {
  const members = options.members ?? [builder]
  const presence = new Map(Object.entries(options.presence ?? { [builder]: 'available' }).map(([memberId, value]) => [memberId as AgentTeamMemberId, value!]))
  let tasks = options.tasks ?? [openTask(alpha, 'task:alpha-1')]
  const leaders = new Map(Object.entries(options.leaders ?? { [alpha]: { memberId: builder, handle: 'builder' } }))
  let ledgerPosition = 10
  let notifyError: Error | undefined
  const notifications: Array<{ workspaceId: WorkspaceId; leader: { readonly memberId: AgentTeamMemberId; readonly handle: string }; tasks: readonly ContinuationTask[] }> = []
  const logs: string[] = []
  const watcher = new TaskContinuationWatcher({
    watchList: () => members,
    presenceOf: memberId => presence.get(memberId) ?? 'unavailable',
    incompleteTasks: () => tasks,
    leaderOf: workspaceId => leaders.get(workspaceId),
    ledgerPosition: () => ledgerPosition,
    notify: async input => {
      if (notifyError !== undefined) throw notifyError
      notifications.push(input)
    },
    log: message => { logs.push(message) },
  })
  return {
    watcher, notifications, logs,
    setPresence: (memberId: AgentTeamMemberId, value: 'available' | 'working' | 'error' | 'unavailable') => { presence.set(memberId, value) },
    setTasks: (next: readonly ContinuationTask[]) => { tasks = next },
    commit: () => { ledgerPosition += 1 },
    failDeliveries: (error: Error | undefined) => { notifyError = error },
  }
}

describe('TaskContinuationWatcher pass policy', () => {
  it('nudges the leader once after the quiet hold, then stays latched', async () => {
    const { watcher, notifications } = harness()
    await watcher.runPass(0)
    await watcher.runPass(CONTINUATION_QUIET_MS - 1)
    expect(notifications).toEqual([])
    await watcher.runPass(CONTINUATION_QUIET_MS)
    expect(notifications).toEqual([
      { workspaceId: alpha, leader: { memberId: builder, handle: 'builder' }, tasks: [openTask(alpha, 'task:alpha-1')] },
    ])
    // Time alone never re-arms: the leader stays quiet, so no further nudges.
    await watcher.runPass(CONTINUATION_QUIET_MS + CONTINUATION_INTERVAL_MS)
    await watcher.runPass(CONTINUATION_QUIET_MS + 10 * CONTINUATION_INTERVAL_MS)
    expect(notifications).toHaveLength(1)
  })

  it('re-arms when an Agent actually works again, and holds through its turn', async () => {
    const { watcher, notifications, setPresence, commit } = harness()
    await watcher.runPass(0)
    await watcher.runPass(CONTINUATION_QUIET_MS)
    expect(notifications).toHaveLength(1)
    // The leader wakes, works, and its turn's writes land; then it stops.
    setPresence(builder, 'working')
    await watcher.runPass(CONTINUATION_QUIET_MS + CONTINUATION_INTERVAL_MS)
    commit()
    await watcher.runPass(CONTINUATION_QUIET_MS + 2 * CONTINUATION_INTERVAL_MS)
    setPresence(builder, 'available')
    // The stop itself may land no write: the hold arms at the first all-idle pass.
    await watcher.runPass(CONTINUATION_QUIET_MS + 3 * CONTINUATION_INTERVAL_MS)
    expect(notifications).toHaveLength(1)
    await watcher.runPass(CONTINUATION_QUIET_MS + 3 * CONTINUATION_INTERVAL_MS + CONTINUATION_QUIET_MS)
    expect(notifications).toHaveLength(2)
  })

  it('re-arms when the open-Task landscape changes', async () => {
    const { watcher, notifications, setTasks, commit } = harness()
    await watcher.runPass(0)
    await watcher.runPass(CONTINUATION_QUIET_MS)
    expect(notifications).toHaveLength(1)
    // A new open Task (added through a ledger commit) re-arms the episode.
    setTasks([openTask(alpha, 'task:alpha-1'), openTask(alpha, 'task:alpha-2', 'in_progress')])
    commit()
    await watcher.runPass(CONTINUATION_QUIET_MS + CONTINUATION_INTERVAL_MS)
    expect(notifications).toHaveLength(1)
    await watcher.runPass(CONTINUATION_QUIET_MS + CONTINUATION_INTERVAL_MS + CONTINUATION_QUIET_MS)
    expect(notifications).toHaveLength(2)
    expect(notifications[1]!.tasks).toHaveLength(2)
  })

  it('restarts the quiet hold on any ledger commit while idle', async () => {
    const { watcher, notifications, commit } = harness()
    await watcher.runPass(0)
    // A Human read lands mid-hold: the stretch restarts from that instant.
    await watcher.runPass(CONTINUATION_QUIET_MS - 1_000)
    commit()
    await watcher.runPass(CONTINUATION_QUIET_MS)
    expect(notifications).toEqual([])
    await watcher.runPass(CONTINUATION_QUIET_MS + CONTINUATION_QUIET_MS - 1_000)
    expect(notifications).toEqual([])
    await watcher.runPass(CONTINUATION_QUIET_MS + 2 * CONTINUATION_QUIET_MS - 1_000)
    expect(notifications).toHaveLength(1)
  })

  it('never fires while a Member is working, erroring, or unavailable', async () => {
    for (const presence of ['working', 'error', 'unavailable'] as const) {
      const { watcher, notifications, setPresence } = harness({ presence: { [builder]: presence } })
      for (let pass = 0; pass < 5; pass += 1) await watcher.runPass(pass * CONTINUATION_QUIET_MS)
      expect(notifications).toEqual([])
      // Coming back to available arms a fresh hold; it needs the full quiet.
      setPresence(builder, 'available')
      await watcher.runPass(5 * CONTINUATION_QUIET_MS)
      expect(notifications).toEqual([])
      await watcher.runPass(5 * CONTINUATION_QUIET_MS + CONTINUATION_QUIET_MS)
      expect(notifications).toHaveLength(1)
    }
  })

  it('does not fire with no open Tasks or no watched Members', async () => {
    const quiet = harness({ tasks: [] })
    for (let pass = 0; pass < 5; pass += 1) await quiet.watcher.runPass(pass * CONTINUATION_QUIET_MS)
    expect(quiet.notifications).toEqual([])

    const empty = harness({ members: [] })
    for (let pass = 0; pass < 5; pass += 1) await empty.watcher.runPass(pass * CONTINUATION_QUIET_MS)
    expect(empty.notifications).toEqual([])
  })

  it('groups open Tasks per Workspace and nudges each designated leader', async () => {
    const { watcher, notifications } = harness({
      members: [builder, reviewer],
      presence: { [builder]: 'available', [reviewer]: 'available' },
      tasks: [openTask(alpha, 'task:alpha-1'), openTask(beta, 'task:beta-1', 'in_review'), openTask(beta, 'task:beta-2')],
      leaders: {
        [alpha]: { memberId: builder, handle: 'builder' },
        [beta]: { memberId: reviewer, handle: 'reviewer' },
      },
    })
    await watcher.runPass(0)
    await watcher.runPass(CONTINUATION_QUIET_MS)
    expect(notifications.map(notification => [notification.workspaceId, notification.leader.handle])).toEqual([['workspace:alpha', 'builder'], ['workspace:beta', 'reviewer']])
    expect(notifications[1]!.tasks.map(task => task.taskRef)).toEqual(['task:beta-1', 'task:beta-2'])
  })

  it('logs a missing leader once per episode, not once per pass', async () => {
    const { watcher, notifications, logs } = harness({ leaders: {} })
    await watcher.runPass(0)
    await watcher.runPass(CONTINUATION_QUIET_MS)
    expect(notifications).toEqual([])
    expect(logs.filter(log => log.includes('no enabled Member is designated leader'))).toHaveLength(1)
    // Later quiet passes do not repeat the diagnostic; the episode resets only
    // when the idle stretch restarts, and time alone is not such a restart.
    await watcher.runPass(CONTINUATION_QUIET_MS + CONTINUATION_INTERVAL_MS)
    expect(logs.filter(log => log.includes('no enabled Member is designated leader'))).toHaveLength(1)
  })

  it('a failed delivery is logged instead of thrown, and retries on the next pass', async () => {
    const test = harness()
    test.failDeliveries(new Error('no Channel to deliver'))
    await test.watcher.runPass(0)
    await test.watcher.runPass(CONTINUATION_QUIET_MS)
    expect(test.notifications).toEqual([])
    expect(test.logs.some(log => log.includes('continuation nudge for leader') && log.includes('no Channel to deliver'))).toBe(true)
    // Nothing was delivered, so nothing latched: the very next pass retries.
    test.failDeliveries(undefined)
    await test.watcher.runPass(CONTINUATION_QUIET_MS + CONTINUATION_INTERVAL_MS)
    expect(test.notifications).toHaveLength(1)
  })

  it('does not start a second pass while one is still running', async () => {
    const gate = Promise.withResolvers<void>()
    let deliveries = 0
    const watcher = new TaskContinuationWatcher({
      watchList: () => [builder],
      presenceOf: () => 'available',
      incompleteTasks: () => [openTask(alpha, 'task:alpha-1')],
      leaderOf: () => ({ memberId: builder, handle: 'builder' }),
      ledgerPosition: () => 1,
      notify: async () => { deliveries += 1; await gate.promise },
      log: () => {},
    })
    const first = watcher.runPass(0)
    await first
    const gated = watcher.runPass(CONTINUATION_QUIET_MS)
    await vi.waitFor(() => { expect(deliveries).toBe(1) })
    await watcher.runPass(CONTINUATION_QUIET_MS + 1)
    expect(deliveries).toBe(1)
    gate.resolve()
    await gated
    // The latch committed with the first delivery; the next pass stays quiet.
    await watcher.runPass(CONTINUATION_QUIET_MS + 2)
    expect(deliveries).toBe(1)
  })
})

describe('continuationNudgeText', () => {
  it('names the leader, lists the open Tasks, and states the expectation', () => {
    const text = continuationNudgeText({
      leaderHandle: 'builder',
      tasks: [openTask(alpha, 'task:alpha-1'), openTask(alpha, 'task:alpha-2', 'in_review', 'Review the split')],
    })
    expect(text).toContain('@builder Continuation check: every Agent is stopped, but these Task(s) are still open:')
    expect(text).toContain('- task:alpha-1 (#7) — todo — Ship the thing')
    expect(text).toContain('- task:alpha-2 (#7) — in_review — Review the split')
    expect(text).toContain('Please continue the unfinished work')
  })

  it('omits the ordinal for a Task the Channel has not numbered yet', () => {
    const text = continuationNudgeText({
      leaderHandle: 'builder',
      tasks: [{ workspaceId: alpha, taskRef: 'task:alpha-1', taskNumber: 0, status: 'todo', subject: 'Ship the thing' }],
    })
    expect(text).toContain('- task:alpha-1 — todo — Ship the thing')
  })
})
