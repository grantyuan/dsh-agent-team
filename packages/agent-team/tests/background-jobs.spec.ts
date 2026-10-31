import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { BackgroundJobRegistry, backgroundJobNoticeText, type BackgroundJob } from '../src/background-jobs.ts'
import type { AgentTeamMemberId } from '../src/types.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'

/** A controllable fake child: the tests drive close/error/kill by hand. */
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly signals: string[] = []
  kill(signal?: string): boolean {
    this.signals.push(signal ?? 'SIGTERM')
    return true
  }
}

function harness(options: { maxPerMember?: number; maxTotal?: number; tailBytes?: number } = {}) {
  const finished: BackgroundJob[] = []
  const scriptMessages: Array<{ job: BackgroundJob; body: string }> = []
  const children: FakeChild[] = []
  let clock = 1_000_000
  const registry = new BackgroundJobRegistry({
    onFinished: async job => { finished.push(job) },
    onScriptMessage: async (job, body) => { scriptMessages.push({ job, body }) },
    log: () => {},
    spawn: (_program, _args, _options) => {
      const child = new FakeChild()
      children.push(child)
      return child as never
    },
    now: () => { clock += 1000; return clock },
    ...options,
  })
  const start = (overrides: { name?: string } = {}) => registry.start({
    workspaceId: 'workspace:alpha' as WorkspaceId,
    ownerMemberId: 'member:builder' as AgentTeamMemberId,
    ownerHandle: 'builder',
    name: overrides.name ?? 'nightly build',
    program: 'sh',
    args: ['-c', 'sleep 1'],
  })
  return { registry, finished, scriptMessages, children, start }
}

describe('BackgroundJobRegistry', () => {
  it('runs a job to a clean exit and reports the outcome once', async () => {
    const h = harness()
    const { job, token } = h.start()
    expect(job.status).toBe('running')
    expect(token).toMatch(/^[0-9a-f]{48}$/)
    h.children[0]!.stdout.write('building…\n')
    h.children[0]!.emit('close', 0)
    await vi.waitFor(() => expect(h.finished).toHaveLength(1))
    expect(h.finished[0]!.status).toBe('exited')
    expect(h.finished[0]!.exitCode).toBe(0)
    expect(h.registry.tailOf(job.jobId)).toContain('building…')
    // A second close must not double-notify.
    h.children[0]!.emit('close', 0)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(h.finished).toHaveLength(1)
  })

  it('classifies a nonzero exit as failed and keeps the tail bounded', async () => {
    const h = harness({ tailBytes: 16 })
    const { job } = h.start()
    h.children[0]!.stderr.write('a'.repeat(40))
    h.children[0]!.emit('close', 2)
    await vi.waitFor(() => expect(h.finished).toHaveLength(1))
    expect(h.finished[0]!.status).toBe('failed')
    expect(h.finished[0]!.exitCode).toBe(2)
    expect(h.registry.tailOf(job.jobId).length).toBeLessThanOrEqual(16)
  })

  it('finishes a spawn that throws immediately as failed', async () => {
    const finished: BackgroundJob[] = []
    const registry = new BackgroundJobRegistry({
      onFinished: async job => { finished.push(job) },
      onScriptMessage: async () => {},
      log: () => {},
      spawn: () => { throw new Error('ENOENT') },
    })
    registry.start({
      workspaceId: 'workspace:alpha' as WorkspaceId,
      ownerMemberId: 'member:builder' as AgentTeamMemberId,
      ownerHandle: 'builder',
      name: 'ghost',
      program: 'definitely-not-installed',
    })
    await vi.waitFor(() => expect(finished).toHaveLength(1))
    expect(finished[0]!.status).toBe('failed')
  })

  it('cancels a running job with SIGTERM and reports it once', async () => {
    const h = harness()
    const { job } = h.start()
    expect(h.registry.cancel(job.jobId)).toBe(true)
    await vi.waitFor(() => expect(h.finished).toHaveLength(1))
    expect(h.finished[0]!.status).toBe('cancelled')
    expect(h.children[0]!.signals).toContain('SIGTERM')
    // Cancelling again is a no-op the caller can report honestly.
    expect(h.registry.cancel(job.jobId)).toBe(false)
    expect(h.finished).toHaveLength(1)
  })

  it('refuses a script report with the wrong token and accepts the right one', async () => {
    const h = harness()
    const { job, token } = h.start()
    await expect(h.registry.scriptMessage(job.jobId, 'deadbeef', 'halfway')).rejects.toThrow(/token/)
    const reported = await h.registry.scriptMessage(job.jobId, token, 'halfway there')
    expect(reported.lastScriptMessage).toBe('halfway there')
    expect(h.scriptMessages).toHaveLength(1)
    // A finished job takes no further reports.
    h.children[0]!.emit('close', 0)
    await vi.waitFor(() => expect(h.finished).toHaveLength(1))
    await expect(h.registry.scriptMessage(job.jobId, token, 'too late')).rejects.toThrow(/already/)
  })

  it('enforces the per-Member and total budgets', () => {
    const h = harness({ maxPerMember: 2, maxTotal: 3 })
    h.start()
    h.start()
    expect(() => h.start()).toThrow(/already holds 2 running background jobs/)
    // Another Member shares the total cap only.
    const other = () => h.registry.start({
      workspaceId: 'workspace:alpha' as WorkspaceId,
      ownerMemberId: 'member:reviewer' as AgentTeamMemberId,
      ownerHandle: 'reviewer',
      name: 'other',
      program: 'sh',
    })
    other()
    expect(() => other()).toThrow(/already running 3 background jobs/)
    expect(h.registry.capacityForMember('member:builder' as AgentTeamMemberId)).toBe(0)
  })

  it('lists a Member\'s jobs newest first and forgets nothing on dispose until killed', async () => {
    const h = harness()
    const first = h.start({ name: 'first' })
    const second = h.start({ name: 'second' })
    const rows = h.registry.listForMember('member:builder' as AgentTeamMemberId)
    expect(rows.map(row => row.name)).toEqual(['second', 'first'])
    h.registry.dispose()
    // Dispose SIGKILLs live children; the finish latch means no notices fire.
    expect(h.children[0]!.signals).toContain('SIGKILL')
    expect(h.children[1]!.signals).toContain('SIGKILL')
    expect(h.finished).toHaveLength(0)
  })
})

describe('backgroundJobNoticeText', () => {
  it('names the outcome, sanitizes mentions, and points at team_job status', () => {
    const job: BackgroundJob = {
      jobId: 'job:1', workspaceId: 'workspace:alpha' as WorkspaceId,
      ownerMemberId: 'member:builder' as AgentTeamMemberId, ownerHandle: 'builder',
      name: 'nightly build', command: 'sh -c echo @someone', startedAt: 0,
      status: 'exited', exitCode: 0, ranSeconds: 65, lastScriptMessage: 'step 2 done',
    }
    const text = backgroundJobNoticeText(job)
    expect(text).toContain('@builder Team job: your background job “nightly build” finished with exit code 0 after 1 minute')
    expect(text).toContain('＠someone')
    expect(text).not.toContain('echo @someone')
    expect(text).toContain('Last progress report from the script: step 2 done')
    expect(text).toContain('team_job action=status')
  })
})
