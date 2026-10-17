// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { runtimeWithTeam } from './harness.tsx'
import { STORAGE_KEY } from '../src/client/navigation.ts'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

/** One Task-list row as the Host projects it; workspaceId tags the source Workspace. */
function taskRow(workspaceId: string, taskRef: string, overrides: Record<string, unknown> = {}): { readonly workspaceId: string; readonly row: Record<string, unknown> } {
  return {
    workspaceId,
    row: {
      taskRef,
      threadRef: taskRef.replace('task:', 'thread:'),
      channelRef: 'channel:engineering',
      taskNumber: Number(taskRef.replace('task:', '')),
      status: 'in_progress',
      resolution: 'open',
      subject: 'Ship the rollout',
      claimOwners: [],
      lastActivityAt: '2026-09-13T04:00:00.000Z',
      ...overrides,
    },
  }
}

describe('Team Tasks surfaces', () => {
  it('selects open rows, shows the batch bar, and resolves the selection through one changeTasks call', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    b.seedTasks([taskRow('w1', 'task:1'), taskRow('w1', 'task:2')])
    fireEvent.click(await b.view.findByRole('button', { name: '任务' }))
    // The checkbox sits outside the row button, so a select never opens the
    // Thread; the bar names the running count the checkboxes hold.
    fireEvent.click(await b.view.findByRole('checkbox', { name: '选择任务 1' }))
    fireEvent.click(b.view.getByRole('checkbox', { name: '选择任务 2' }))
    const bar = await b.view.findByRole('toolbar', { name: '已选 2 项' })
    expect(within(bar).getByText('已选 2 项')).toBeTruthy()
    fireEvent.click(within(bar).getByRole('button', { name: '验收所选' }))
    await waitFor(() => expect(b.changeTasks).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'w1', taskRefs: ['task:1', 'task:2'], action: 'accept' })))
    // The accepted rows move to the done section, the selection clears with the
    // bar, and the note names what the batch committed as one status line.
    await waitFor(() => expect(b.view.getByRole('heading', { name: /已完成/ })).toBeTruthy())
    expect(b.view.queryByRole('toolbar')).toBeNull()
    expect(b.view.queryByRole('checkbox', { name: '选择任务 1' })).toBeNull()
    expect(b.view.getByRole('status').textContent).toBe('已提交 2 项')
    await b.runtime.dispose()
  })

  it('reports already-resolved rows in the note while the rest commits', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    b.seedTasks([taskRow('w1', 'task:1'), taskRow('w1', 'task:2')])
    fireEvent.click(await b.view.findByRole('button', { name: '任务' }))
    fireEvent.click(await b.view.findByRole('checkbox', { name: '选择任务 1' }))
    fireEvent.click(b.view.getByRole('checkbox', { name: '选择任务 2' }))
    const bar = await b.view.findByRole('toolbar', { name: '已选 2 项' })
    b.changeTasks.mockResolvedValueOnce({ ok: true as const, value: { outcomes: [
      { kind: 'committed' as const, taskRef: 'task:1', receipt: {}, task: {}, thread: {}, activity: {} },
      { kind: 'already_resolved' as const, taskRef: 'task:2' },
    ] } } as never)
    fireEvent.click(within(bar).getByRole('button', { name: '验收所选' }))
    // One line, both facts: what committed and what the Host refused to touch.
    expect(await b.view.findByText('已提交 1 项；1 项已是终态，未变更')).toBeTruthy()
    await b.runtime.dispose()
  })

  it('keeps the selection and shows the failure when the batch call itself fails', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    b.seedTasks([taskRow('w1', 'task:1')])
    fireEvent.click(await b.view.findByRole('button', { name: '任务' }))
    fireEvent.click(await b.view.findByRole('checkbox', { name: '选择任务 1' }))
    const bar = await b.view.findByRole('toolbar', { name: '已选 1 项' })
    b.changeTasks.mockResolvedValueOnce({ ok: false as const, error: { message: 'transport down' } } as never)
    fireEvent.click(within(bar).getByRole('button', { name: '关闭所选' }))
    // A failed run commits nothing, so the checkout survives: the reader can
    // retry the same selection without rebuilding it.
    expect(await within(bar).findByText('transport down')).toBeTruthy()
    expect(b.view.getByRole('checkbox', { name: '选择任务 1' })).toBeTruthy()
    await b.runtime.dispose()
  })

  it('opens a Task row and lands Back on the Tasks list it was entered from', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', seededMessages: [{ body: 'Thread opener', occurredAt: '2026-09-13T04:00:00.000Z' }], seedTaskRef: 'task:1', seedThreadRef: 'thread:1' })
    b.seedTasks([taskRow('w1', 'task:1')])
    fireEvent.click(await b.view.findByRole('button', { name: '任务' }))
    const row = await b.view.findByRole('button', { name: /Ship the rollout/ })
    fireEvent.click(row)
    // The row's Workspace is selected, then the Thread carries the Tasks origin:
    // the persisted location names the Thread and remembers the list behind it.
    await waitFor(() => expect(b.readThread).toHaveBeenCalled())
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '')).toMatchObject({ mode: 'team', workspaceId: 'w1', channelRef: 'channel:engineering', threadRef: 'thread:1', threadOrigin: 'tasks' })
    // Back goes to the Tasks list this Thread was entered from.
    fireEvent.click(await b.view.findByRole('button', { name: '返回任务列表' }))
    await waitFor(() => expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '')).toMatchObject({ mode: 'team', workspaceId: 'w1', tasks: true }))
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '')).not.toHaveProperty('threadRef')
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '')).not.toHaveProperty('threadOrigin')
    await b.view.findByRole('button', { name: /Ship the rollout/ })
    expect(b.view.container.querySelector('[data-team-tasks]')).toBeTruthy()
    await b.runtime.dispose()
  })
})
