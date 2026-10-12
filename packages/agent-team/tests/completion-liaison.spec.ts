import { describe, expect, it } from 'vitest'
import {
  CompletionLiaison,
  LIAISON_COOLDOWN_MS,
  LIAISON_DECISION_TTL_MS,
  LIAISON_EPISODE_TTL_MS,
  LIAISON_REFUSAL_PHRASE,
  LIAISON_REPORT_GRACE_MS,
  liaisonFeedbackText,
  liaisonReportCheckText,
  liaisonTaskPushText,
} from '../src/completion-liaison.ts'
import type { ContinuationTask } from '../src/continuation-watcher.ts'
import type { AgentTeamMemberId } from '../src/types.ts'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'

const builder = 'member:builder' as AgentTeamMemberId
const reviewer = 'member:reviewer' as AgentTeamMemberId
const alpha = WorkspaceId('workspace:alpha')

const openTask = (taskRef: string): ContinuationTask =>
  ({ workspaceId: alpha, taskRef, taskNumber: 3, status: 'todo', subject: 'Write the guide' })

interface HarnessOptions {
  readonly leader?: { readonly memberId: AgentTeamMemberId; readonly handle: string } | undefined
  readonly presence?: 'available' | 'working' | 'error' | 'unavailable'
  readonly tasks?: readonly ContinuationTask[]
  readonly workspaces?: readonly WorkspaceId[]
}

/** A liaison with scripted Host hooks: every fact is fixed until a test moves it. */
function harness(options: HarnessOptions = {}) {
  // `leader: undefined` is a deliberate leaderless Workspace, so an explicit
  // key must beat the default — `??` would silently re-add the reviewer.
  let leader: { readonly memberId: AgentTeamMemberId; readonly handle: string } | undefined = 'leader' in options ? options.leader : { memberId: reviewer, handle: 'reviewer' }
  let presence = options.presence ?? 'available'
  let tasks: readonly ContinuationTask[] = options.tasks ?? [openTask('task:alpha-3')]
  let reported = false
  const workspaces = options.workspaces ?? [alpha]
  const leaderNotices: Array<{ memberId: AgentTeamMemberId, memberHandle: string, workspaceId: WorkspaceId, leader: { memberId: AgentTeamMemberId, handle: string } }> = []
  const pushes: Array<{ memberId: AgentTeamMemberId, memberHandle: string, workspaceId: WorkspaceId, tasks: readonly ContinuationTask[] }> = []
  const feedbacks: Array<{ memberId: AgentTeamMemberId, memberHandle: string, workspaceId: WorkspaceId, feedbackText: string }> = []
  const logs: string[] = []
  let pushError: Error | undefined
  let feedbackError: Error | undefined
  // The liaison stamps episodes with its injected clock; the test drives one
  // shared timeline so runPass(now) compares against the same axis.
  let clock = 0
  const liaison = new CompletionLiaison({
    now: () => clock,
    workspacesOf: () => workspaces,
    presenceOf: () => presence,
    leaderOf: () => leader,
    reportedToLeaderSince: () => reported,
    openTasksIn: () => tasks,
    handleOf: memberId => memberId === builder ? 'builder' : 'reviewer',
    notifyLeader: async input => { leaderNotices.push(input) },
    pushTasks: async input => {
      if (pushError !== undefined) throw pushError
      pushes.push(input)
    },
    notifyHumanFeedback: async input => {
      if (feedbackError !== undefined) throw feedbackError
      feedbacks.push(input)
    },
    log: message => { logs.push(message) },
  })
  return {
    liaison, leaderNotices, pushes, feedbacks, logs,
    setClock: (next: number) => { clock = next },
    setLeader: (next: typeof leader) => { leader = next },
    setPresence: (next: 'available' | 'working' | 'error' | 'unavailable') => { presence = next },
    setTasks: (next: readonly ContinuationTask[]) => { tasks = next },
    setReported: (next: boolean) => { reported = next },
    failPushes: (error: Error | undefined) => { pushError = error },
    failFeedbacks: (error: Error | undefined) => { feedbackError = error },
  }
}

describe('CompletionLiaison report-check branch', () => {
  it('prompts the leader once past the grace window when a finished Member stayed idle without reporting', async () => {
    const { liaison, leaderNotices } = harness()
    liaison.onCompletedStop(builder, 10)
    await liaison.runPass(LIAISON_REPORT_GRACE_MS - 1)
    expect(leaderNotices).toEqual([])
    await liaison.runPass(LIAISON_REPORT_GRACE_MS)
    expect(leaderNotices).toEqual([{ memberId: builder, memberHandle: 'builder', workspaceId: alpha, leader: { memberId: reviewer, handle: 'reviewer' } }])
    await liaison.runPass(LIAISON_REPORT_GRACE_MS + 1)
    expect(leaderNotices).toHaveLength(1)
  })

  it('stays silent when the Member addressed the leader after finishing', async () => {
    const { liaison, leaderNotices, setReported } = harness()
    setReported(true)
    liaison.onCompletedStop(builder, 10)
    await liaison.runPass(LIAISON_REPORT_GRACE_MS + 1)
    expect(leaderNotices).toEqual([])
  })

  it('waits while the Member works and acts once it really settled', async () => {
    const { liaison, leaderNotices, setPresence } = harness({ presence: 'working' })
    liaison.onCompletedStop(builder, 10)
    await liaison.runPass(LIAISON_REPORT_GRACE_MS + 1)
    expect(leaderNotices).toEqual([])
    setPresence('available')
    await liaison.runPass(LIAISON_REPORT_GRACE_MS + 2)
    expect(leaderNotices).toHaveLength(1)
  })

  it('drops an episode that never settled before the TTL', async () => {
    const { liaison, leaderNotices, setPresence } = harness({ presence: 'working' })
    liaison.onCompletedStop(builder, 10)
    await liaison.runPass(LIAISON_EPISODE_TTL_MS + 1)
    expect(leaderNotices).toEqual([])
    setPresence('available')
    await liaison.runPass(LIAISON_EPISODE_TTL_MS + 2)
    expect(leaderNotices).toEqual([])
  })

  it('refires after the cooldown window on a later completion', async () => {
    const { liaison, leaderNotices } = harness()
    liaison.onCompletedStop(builder, 10)
    await liaison.runPass(LIAISON_REPORT_GRACE_MS)
    expect(leaderNotices).toHaveLength(1)
    liaison.onCompletedStop(builder, 11)
    await liaison.runPass(LIAISON_REPORT_GRACE_MS + LIAISON_COOLDOWN_MS - 1)
    expect(leaderNotices).toHaveLength(1)
    liaison.onCompletedStop(builder, 12)
    await liaison.runPass(LIAISON_REPORT_GRACE_MS + LIAISON_COOLDOWN_MS + 1)
    expect(leaderNotices).toHaveLength(2)
  })

  it('evaluates a boot-retroactive episode at once even when the stop predates the TTL', async () => {
    const { liaison, leaderNotices, setClock } = harness()
    // The Host restarts long after the Member's marker stop (here: past the
    // episode TTL from the stop itself). The boot scan opens the episode with
    // its own clock; the grace already elapsed and the TTL measures from the
    // open, so the first pass prompts the leader instead of dropping it.
    setClock(2 * LIAISON_EPISODE_TTL_MS)
    liaison.onCompletedStop(builder, 10, LIAISON_EPISODE_TTL_MS - 5_000)
    await liaison.runPass(2 * LIAISON_EPISODE_TTL_MS)
    expect(leaderNotices).toHaveLength(1)
  })
})

describe('CompletionLiaison task-push branch', () => {
  it('pushes the open Tasks to the Member itself when the Workspace has no leader', async () => {
    const { liaison, pushes, leaderNotices } = harness({ leader: undefined })
    liaison.onCompletedStop(builder, 10)
    await liaison.runPass(LIAISON_REPORT_GRACE_MS)
    expect(leaderNotices).toEqual([])
    expect(pushes).toEqual([{ memberId: builder, memberHandle: 'builder', workspaceId: alpha, tasks: [openTask('task:alpha-3')] }])
  })

  it('never wakes the designated Leader for their own completed stop', async () => {
    // The Leader's report surface is the Human; the liaison neither pushes
    // Tasks back at them nor checks up on themselves. Failures of the Leader
    // travel the guard/supervision paths instead.
    const { liaison, pushes, leaderNotices } = harness({ leader: { memberId: builder, handle: 'builder' } })
    liaison.onCompletedStop(builder, 10)
    await liaison.runPass(LIAISON_REPORT_GRACE_MS)
    expect(leaderNotices).toEqual([])
    expect(pushes).toEqual([])
  })

  it('never pushes when no Task is open', async () => {
    const { liaison, pushes } = harness({ leader: undefined, tasks: [] })
    liaison.onCompletedStop(builder, 10)
    await liaison.runPass(LIAISON_REPORT_GRACE_MS)
    expect(pushes).toEqual([])
  })

  it('relays a refusal captured during the decision round and stops pushing afterwards', async () => {
    const { liaison, pushes, feedbacks } = harness({ leader: undefined })
    liaison.onCompletedStop(builder, 10)
    await liaison.runPass(LIAISON_REPORT_GRACE_MS)
    expect(pushes).toHaveLength(1)
    liaison.onAssistantText(builder, `${LIAISON_REFUSAL_PHRASE}：我本周没有余力，这些任务需要重新派工。任务结束`)
    liaison.onCompletedStop(builder, 12)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(feedbacks).toHaveLength(1)
    expect(feedbacks[0]?.feedbackText.startsWith(LIAISON_REFUSAL_PHRASE)).toBe(true)
    // A later completion never pushes the refused Member again this process.
    liaison.onCompletedStop(builder, 20)
    await liaison.runPass(LIAISON_REPORT_GRACE_MS + LIAISON_COOLDOWN_MS + 10)
    expect(pushes).toHaveLength(1)
    expect(feedbacks).toHaveLength(1)
  })

  it('a marker stop without a refusal closes the decision and keeps later pushes alive', async () => {
    const { liaison, pushes, feedbacks } = harness({ leader: undefined })
    liaison.onCompletedStop(builder, 10)
    await liaison.runPass(LIAISON_REPORT_GRACE_MS)
    liaison.onAssistantText(builder, '好的，我来接手 task:alpha-3 并推进。任务结束')
    liaison.onCompletedStop(builder, 14)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(feedbacks).toEqual([])
    liaison.onCompletedStop(builder, 20)
    await liaison.runPass(LIAISON_REPORT_GRACE_MS + LIAISON_COOLDOWN_MS + 1)
    expect(pushes).toHaveLength(2)
  })

  it('reads the refusal phrase mid-sentence as prose, not a decision', async () => {
    const { liaison, feedbacks } = harness({ leader: undefined })
    liaison.onCompletedStop(builder, 10)
    await liaison.runPass(LIAISON_REPORT_GRACE_MS)
    liaison.onAssistantText(builder, `推送里说的"${LIAISON_REFUSAL_PHRASE}"我只在引用它；任务结束`)
    liaison.onCompletedStop(builder, 14)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(feedbacks).toEqual([])
  })

  it('forgets a decision whose Member never returned a completed stop', async () => {
    const { liaison, feedbacks } = harness({ leader: undefined })
    liaison.onCompletedStop(builder, 10)
    await liaison.runPass(LIAISON_REPORT_GRACE_MS)
    liaison.onAssistantText(builder, `${LIAISON_REFUSAL_PHRASE}，我不继续。任务结束`)
    await liaison.runPass(LIAISON_REPORT_GRACE_MS + LIAISON_DECISION_TTL_MS + 1)
    liaison.onCompletedStop(builder, 30)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(feedbacks).toEqual([])
  })

  it('a failed push logs, opens no decision, and stays retryable', async () => {
    const { liaison, pushes, logs, failPushes } = harness({ leader: undefined })
    failPushes(new Error('no channel'))
    liaison.onCompletedStop(builder, 10)
    await liaison.runPass(LIAISON_REPORT_GRACE_MS)
    expect(pushes).toEqual([])
    expect(logs.some(line => line.includes('no channel'))).toBe(true)
    failPushes(undefined)
    liaison.onCompletedStop(builder, 11)
    await liaison.runPass(LIAISON_REPORT_GRACE_MS + 1)
    expect(pushes).toHaveLength(1)
  })

  it('suppresses even when the feedback relay itself failed', async () => {
    const { liaison, pushes, feedbacks, logs, failFeedbacks } = harness({ leader: undefined })
    liaison.onCompletedStop(builder, 10)
    await liaison.runPass(LIAISON_REPORT_GRACE_MS)
    failFeedbacks(new Error('relay down'))
    liaison.onAssistantText(builder, `${LIAISON_REFUSAL_PHRASE}。任务结束`)
    liaison.onCompletedStop(builder, 14)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(logs.some(line => line.includes('relay down'))).toBe(true)
    failFeedbacks(undefined)
    liaison.onCompletedStop(builder, 20)
    await liaison.runPass(LIAISON_REPORT_GRACE_MS + LIAISON_COOLDOWN_MS + 1)
    expect(pushes).toHaveLength(1)
    expect(feedbacks).toEqual([])
  })
})

describe('liaison notice texts', () => {
  it('carries the stable first-line markers and the refusal contract verbatim', () => {
    expect(liaisonReportCheckText({ leaderHandle: 'reviewer', memberHandle: 'builder' }).startsWith('@reviewer Team report check:')).toBe(true)
    const push = liaisonTaskPushText({ memberHandle: 'builder', tasks: [openTask('task:alpha-3')] })
    expect(push.startsWith('@builder Task push (no Team leader designated):')).toBe(true)
    expect(push).toContain('- task:alpha-3 (#3) — todo — Write the guide')
    expect(push).toContain(LIAISON_REFUSAL_PHRASE)
    expect(push).toContain('任务结束')
    expect(push).toContain('@human')
    // A quoted Task subject naming a Member must not re-resolve as an
    // authored mention and escalate a bystander into this message's recipient.
    const quoted = liaisonTaskPushText({ memberHandle: 'builder', tasks: [{ ...openTask('task:alpha-4'), subject: '@chief 请复核启动测试' }] })
    expect(quoted).toContain('＠chief 请复核启动测试')
    expect(quoted).not.toContain(' @chief')
    const relay = liaisonFeedbackText({ feedbackText: 'already covered by @chief' })
    expect(relay).toContain('already covered by ＠chief')
    const feedback = liaisonFeedbackText({ feedbackText: '拒绝继续：没有余力' })
    expect(feedback.startsWith('@human Task push declined:')).toBe(true)
    expect(feedback).toContain('拒绝继续：没有余力')
  })
})
