import { describe, expect, it } from 'vitest'
import {
  TruncationEscalator,
  truncationEscalationText,
  TRUNCATION_ESCALATION_COOLDOWN_MS,
  TRUNCATION_ESCALATION_MARKER,
  type TruncationLeader,
} from '../src/truncation-escalation.ts'
import type { AgentTeamMemberId } from '../src/types.ts'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'

const builder = 'member:builder' as AgentTeamMemberId
const leadA = 'member:lead-a' as AgentTeamMemberId
const leadB = 'member:lead-b' as AgentTeamMemberId
const alpha = WorkspaceId('workspace:alpha')
const beta = WorkspaceId('workspace:beta')

interface HarnessOptions {
  readonly workspaces?: Partial<Record<AgentTeamMemberId, readonly WorkspaceId[]>>
  readonly leaders?: Partial<Record<string, TruncationLeader | undefined>>
  readonly handles?: Partial<Record<AgentTeamMemberId, string>>
}

/** An escalator with scripted Host hooks: every fact is fixed until a test mutates it. */
function harness(options: HarnessOptions = {}) {
  const workspaces = new Map<AgentTeamMemberId, readonly WorkspaceId[]>(Object.entries(options.workspaces ?? { [builder]: [alpha] }).map(([memberId, value]) => [memberId as AgentTeamMemberId, value as readonly WorkspaceId[]]))
  const leaders = new Map<string, TruncationLeader | undefined>(Object.entries(options.leaders ?? { [alpha]: { memberId: leadA, handle: 'lead-a' } }))
  const handles = new Map<AgentTeamMemberId, string | undefined>(Object.entries(options.handles ?? { [builder]: 'builder', [leadA]: 'lead-a', [leadB]: 'lead-b' }).map(([memberId, value]) => [memberId as AgentTeamMemberId, value as string | undefined]))
  let clock = 0
  let notifyError: Error | undefined
  const notifications: Array<{ memberId: AgentTeamMemberId, memberHandle: string, workspaceId: WorkspaceId, leader: TruncationLeader }> = []
  const logs: string[] = []
  const escalator = new TruncationEscalator({
    workspacesOf: memberId => workspaces.get(memberId) ?? [],
    leaderOf: workspaceId => leaders.get(workspaceId),
    handleOf: memberId => handles.get(memberId),
    notify: async input => {
      if (notifyError !== undefined) throw notifyError
      notifications.push(input)
    },
    log: message => { logs.push(message) },
    now: () => clock,
  })
  return {
    escalator, notifications, logs,
    advance: (ms: number) => { clock += ms },
    setLeader: (workspaceId: WorkspaceId, leader: TruncationLeader | undefined) => { leaders.set(workspaceId, leader) },
    failDeliveries: (error: Error | undefined) => { notifyError = error },
  }
}

describe('TruncationEscalator episode policy', () => {
  it('escalates the designated leader once, then latches inside the cooldown window', () => {
    const { escalator, notifications, advance } = harness()
    escalator.onTruncatedStop(builder)
    expect(notifications).toEqual([
      { memberId: builder, memberHandle: 'builder', workspaceId: alpha, leader: { memberId: leadA, handle: 'lead-a' } },
    ])
    // The same Member truncating again inside the window is one unresolved
    // situation, not new information.
    advance(TRUNCATION_ESCALATION_COOLDOWN_MS - 1)
    escalator.onTruncatedStop(builder)
    expect(notifications).toHaveLength(1)
    // Time alone re-arms the branch for the next truncation.
    advance(1)
    escalator.onTruncatedStop(builder)
    expect(notifications).toHaveLength(2)
  })

  it('escalates the leader of every Workspace holding a different enabled leader', () => {
    const { escalator, notifications } = harness({
      workspaces: { [builder]: [alpha, beta] },
      leaders: { [alpha]: { memberId: leadA, handle: 'lead-a' }, [beta]: { memberId: leadB, handle: 'lead-b' } },
    })
    escalator.onTruncatedStop(builder)
    expect(notifications.map(delivery => delivery.workspaceId)).toEqual([alpha, beta])
    // Each (Member, Workspace) branch latches on its own.
    escalator.onTruncatedStop(builder)
    expect(notifications).toHaveLength(2)
  })

  it('never escalates to the truncated Member itself and logs a missing leader once per episode', () => {
    const { escalator, notifications, logs } = harness({
      leaders: { [alpha]: { memberId: builder, handle: 'builder' } },
    })
    escalator.onTruncatedStop(builder)
    expect(notifications).toEqual([])
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('no enabled Member other than itself is a designated leader')
    escalator.onTruncatedStop(builder)
    expect(logs).toHaveLength(1)
  })

  it('a leaderless Workspace logs once, and designating a leader makes the next stop escalate', () => {
    const { escalator, notifications, logs, setLeader } = harness({ leaders: { [alpha]: undefined } })
    escalator.onTruncatedStop(builder)
    expect(notifications).toEqual([])
    expect(logs).toHaveLength(1)
    setLeader(alpha, { memberId: leadA, handle: 'lead-a' })
    escalator.onTruncatedStop(builder)
    expect(notifications).toHaveLength(1)
  })

  it('a clean marker stop closes the episode so the next truncation escalates fresh', () => {
    const { escalator, notifications } = harness()
    escalator.onTruncatedStop(builder)
    expect(notifications).toHaveLength(1)
    escalator.onCleanStop(builder)
    escalator.onTruncatedStop(builder)
    expect(notifications).toHaveLength(2)
  })

  it('a failed delivery logs and the latch still holds until the window passes', async () => {
    const { escalator, notifications, logs, failDeliveries, advance } = harness()
    failDeliveries(new Error('channel unreachable'))
    escalator.onTruncatedStop(builder)
    // The delivery throw surfaces on the fire-and-forget lane a microtask
    // later; drain it before reading the log.
    await new Promise(resolve => { setImmediate(resolve) })
    expect(notifications).toEqual([])
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('failed in workspace')
    // No immediate retry storm: the next stop inside the window is latched.
    escalator.onTruncatedStop(builder)
    expect(logs).toHaveLength(1)
    failDeliveries(undefined)
    advance(TRUNCATION_ESCALATION_COOLDOWN_MS)
    escalator.onTruncatedStop(builder)
    expect(notifications).toHaveLength(1)
  })

  it('a Member that left the roster logs instead of naming an unknown handle', () => {
    const { escalator, notifications, logs } = harness({ handles: { [builder]: undefined } })
    escalator.onTruncatedStop(builder)
    expect(notifications).toEqual([])
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('left the roster')
  })

  it('dispose silences later stops', () => {
    const { escalator, notifications } = harness()
    escalator.dispose()
    escalator.onTruncatedStop(builder)
    expect(notifications).toEqual([])
  })
})

describe('truncationEscalationText', () => {
  it('names the leader, the truncated Member, and the decision it owes', () => {
    const text = truncationEscalationText({ leaderHandle: 'lead-a', memberHandle: 'builder' })
    expect(text.startsWith(`@lead-a ${TRUNCATION_ESCALATION_MARKER}`)).toBe(true)
    expect(text).toContain('builder stopped at the output-token cap')
    expect(text).toContain('the decision is yours')
    expect(text).toContain('smaller chunks')
    expect(text).toContain('reassign')
  })
})
