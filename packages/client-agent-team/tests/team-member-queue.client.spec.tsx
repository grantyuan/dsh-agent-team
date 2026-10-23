// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { runtimeWithTeam } from './harness.tsx'
import { STORAGE_KEY } from '../src/client/navigation.ts'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

/** One Member-queue row as the Host projects it; the dialog renders these verbatim. */
function queueRow(taskRef: string, taskNumber: number, subject: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskRef,
    threadRef: taskRef.replace('task:', 'thread:'),
    channelRef: 'channel:engineering',
    taskNumber,
    status: 'in_progress',
    resolution: 'open',
    subject,
    claimOwners: [],
    lastActivityAt: '2026-09-13T04:00:00.000Z',
    ...overrides,
  }
}

/** A live Team-leader roster row the reassign consultation addresses. */
const leaderRow = {
  member: {
    memberId: 'member:lead', workspaceId: 'w1', handle: 'lead', description: 'lead description',
    presetId: 'team-member', state: 'enabled', sessionId: 'session:member:lead', leader: true,
  },
  workspaceIds: ['w1'],
  availability: 'active',
  presence: 'available',
}

describe('Member working queue', () => {
  it('lists current and queued work, and a row click follows the Task into its Thread', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    b.seedMemberTasks([{ queue: {
      memberId: 'member:builder',
      current: [queueRow('task:7', 7, '叠放校验', { claimOwners: [{ memberId: 'member:builder', name: 'builder' }] })],
      queued: [queueRow('task:9', 9, '拆分出的第一步', { status: 'todo' })],
    } }])
    await b.view.findByText('builder')
    fireEvent.click(b.view.getByRole('button', { name: 'builder 的操作' }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: '任务队列' }))
    const dialog = await b.view.findByRole('dialog', { name: '任务队列：builder' })
    expect(within(dialog).getByRole('heading', { name: '正在处理' })).toBeTruthy()
    expect(within(dialog).getByRole('heading', { name: '待领取' })).toBeTruthy()
    expect(within(dialog).getByText('该成员已加入频道中、尚无人认领的任务')).toBeTruthy()
    expect(within(dialog).getByText('由 @builder 处理')).toBeTruthy()
    fireEvent.click(within(dialog).getByTitle('叠放校验'))
    await waitFor(() => expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '')).toMatchObject({
      mode: 'team', workspaceId: 'w1', channelRef: 'channel:engineering', threadRef: 'thread:7', taskRef: 'task:7',
    }))
    await b.runtime.dispose()
  })

  it('asks the Team leader to arbitrate a reassignment through one Human Message', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialChannels: true })
    const baseMembers = b.members.getMockImplementation()
    b.members.mockImplementation((async (request: { workspaceId?: string }) => {
      const base = await baseMembers!(request) as { ok: true; value: unknown[] }
      return { ...base, value: [...base.value, leaderRow] }
    }) as never)
    b.seedChannel({ channelRef: 'channel:lead', workspaceId: 'w1', name: 'lead-room', state: 'active', createdAtSequence: 2 })
    await b.joinChannel({ requestId: 'request:join-lead', channelRef: 'channel:lead', memberId: 'member:lead' })
    b.seedMemberTasks([{ queue: {
      memberId: 'member:builder',
      current: [],
      queued: [queueRow('task:9', 9, '拆分出的第一步', { status: 'todo' })],
    } }])
    await b.view.findByText('builder')
    fireEvent.click(b.view.getByRole('button', { name: 'builder 的操作' }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: '任务队列' }))
    const queueDialog = await b.view.findByRole('dialog', { name: '任务队列：builder' })
    fireEvent.click(within(queueDialog).getByRole('button', { name: '转派' }))
    const reassign = await b.view.findByRole('dialog', { name: '申请转派 Task #9' })
    expect(within(reassign).getByText('将向团队负责人发送一条征询消息：由负责人判断是否适合转派，合适时由负责人安排。')).toBeTruthy()
    fireEvent.click(within(reassign).getByRole('button', { name: '转派给' }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: /worker/ }))
    fireEvent.change(within(reassign).getByPlaceholderText('补充说明给团队负责人，例如原因与期望'), { target: { value: 'builder 转做评审了' } })
    fireEvent.click(within(reassign).getByRole('button', { name: '发送征询' }))
    await waitFor(() => expect(b.sendMessage).toHaveBeenCalledTimes(1))
    const request = b.sendMessage.mock.calls[0]![0] as { workspaceId: string; channelRef: string; body: string; recipients: readonly string[]; asTask: boolean }
    expect(request).toMatchObject({ workspaceId: 'w1', channelRef: 'channel:lead', recipients: ['member:lead'], asTask: false })
    expect(request.body).toContain('【转派征询】Task #9：请判断是否适合转派')
    expect(request.body).toContain('希望转派给：worker')
    expect(request.body).toContain('发起人备注：builder 转做评审了')
    expect(within(reassign).getByText('已发送给团队负责人，等待其安排。')).toBeTruthy()
    await b.runtime.dispose()
  })
})
