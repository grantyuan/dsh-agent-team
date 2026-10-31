/**
 * Team-owned background job registry.
 *
 * A Member starts a long-running script through the `team_job` tool; this
 * registry spawns the process, watches it, and turns its lifecycle into Team
 * facts: a bounded output tail, script-posted progress messages through the
 * gateway, and one completion notice that wakes the owner to handle the
 * result. The registry itself is deliberately process-local — the durable
 * record of a job's life is the Messages it produces, exactly like an
 * external Member's heartbeat cadence staying out of the ledger — so a Host
 * shutdown kills its children instead of pretending to adopt strangers.
 *
 * Authority stays in the Host: the registry never touches the ledger. It
 * reports outcomes through the callbacks the Host wires, and the gateway only
 * forwards a job-token-authenticated script message back here.
 *
 * @module @wowyuarm/dsh-agent-team/background-jobs
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { AgentTeamMemberId } from './types/entities.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'

/** How many live jobs one Member may hold at once. */
export const BACKGROUND_JOB_MAX_PER_MEMBER = 4

/** How many live jobs the whole Host may hold at once. */
export const BACKGROUND_JOB_MAX_TOTAL = 16

/** Bytes of combined output kept for the completion notice and status reads. */
export const BACKGROUND_JOB_OUTPUT_TAIL_BYTES = 8 * 1024

/** Grace between SIGTERM and SIGKILL when a job is cancelled or the Host stops. */
export const BACKGROUND_JOB_KILL_GRACE_MS = 5 * 1000

/** Stable first line: it names the notice in the owner's Inbox like the other coordinator markers. */
export const BACKGROUND_JOB_MARKER = 'Team job:'

export type BackgroundJobStatus = 'running' | 'exited' | 'failed' | 'cancelled'

/** One live or just-finished background job. */
export interface BackgroundJob {
  readonly jobId: string
  readonly workspaceId: WorkspaceId
  readonly ownerMemberId: AgentTeamMemberId
  readonly ownerHandle: string
  readonly name: string
  /** The display form of the command (program + args); never re-executed. */
  readonly command: string
  readonly startedAt: number
  status: BackgroundJobStatus
  /** The process exit code once the child is gone; undefined while running. */
  exitCode?: number
  /** Seconds the job ran, filled at finish. */
  ranSeconds?: number
  /** One bounded progress line the script posted through the gateway. */
  lastScriptMessage?: string
}

export interface BackgroundJobStartInput {
  readonly workspaceId: WorkspaceId
  readonly ownerMemberId: AgentTeamMemberId
  readonly ownerHandle: string
  readonly name: string
  readonly program: string
  readonly args?: readonly string[]
  readonly cwd?: string
  /** Extra environment for the child, merged over the inherited one. */
  readonly env?: Readonly<Record<string, string>>
}

export interface BackgroundJobRegistryOptions {
  /** The one completion/outcome callback per job (exit, cancel, or spawn failure). */
  readonly onFinished: (job: BackgroundJob) => Promise<void>
  /** A script posted a progress message; the Host turns it into a Team Message. */
  readonly onScriptMessage: (job: BackgroundJob, body: string) => Promise<void>
  /** Log one registry diagnostic. */
  readonly log: (message: string) => void
  /** Spawn seam; tests substitute a fake child. */
  readonly spawn?: (program: string, args: readonly string[], options: {
    readonly cwd?: string
    readonly env: NodeJS.ProcessEnv
    readonly stdio: ['ignore', 'pipe', 'pipe']
    readonly detached: false
  }) => ChildProcessWithoutNullStreams
  readonly now?: () => number
  readonly maxPerMember?: number
  readonly maxTotal?: number
  readonly tailBytes?: number
  readonly killGraceMs?: number
}

/** Per-job process memory: the child, its tail, and the one-time finish latch. */
interface JobProcess {
  readonly job: BackgroundJob
  readonly token: string
  child: ChildProcessWithoutNullStreams | undefined
  readonly tail: Buffer[]
  tailBytes: number
  finished: boolean
  killTimer: ReturnType<typeof setTimeout> | undefined
}

/** The one-line duration a notice uses. */
function ranFor(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`
  return `${Math.floor(minutes / 60)} hour${Math.floor(minutes / 60) === 1 ? '' : 's'} ${minutes % 60} minute${minutes % 60 === 1 ? '' : 's'}`
}

/**
 * The owner-facing completion notice: one line naming the outcome, the bounded
 * output tail, and the pointer back to the tool. Plain text — the Team
 * Assistant's voice renders literally in the Client, like every other
 * coordinator notice.
 */
export function backgroundJobNoticeText(job: BackgroundJob): string {
  const outcome = job.status === 'exited'
    ? `finished with exit code ${job.exitCode ?? 0}`
    : job.status === 'failed'
      ? `ended with exit code ${job.exitCode ?? 'unknown'}`
      : 'was cancelled'
  const lines = [
    `@${job.ownerHandle} ${BACKGROUND_JOB_MARKER} your background job “${job.name}” ${outcome}${job.ranSeconds === undefined ? '' : ` after ${ranFor(job.ranSeconds)}`}.`,
    `Command: ${sanitizeQuotedText(job.command)}`,
  ]
  if (job.lastScriptMessage !== undefined) lines.push(`Last progress report from the script: ${sanitizeQuotedText(job.lastScriptMessage)}`)
  lines.push('Read the output tail with team_job action=status jobRef=… and continue the work this job was serving.')
  return lines.join('\n')
}

/** Quoted text must not re-resolve as an authored mention (the liaison's rule). */
function sanitizeQuotedText(value: string): string {
  return value.replace(/@/g, '＠')
}

/**
 * The live-job registry. Every mutation is serialized on the Host's lifecycle
 * queue by its caller; the registry itself only guards its own map.
 */
export class BackgroundJobRegistry {
  private readonly jobs = new Map<string, JobProcess>()
  private readonly maxPerMember: number
  private readonly maxTotal: number
  private readonly tailBytes: number
  private readonly killGraceMs: number
  private readonly now: () => number
  private readonly spawnFn: NonNullable<BackgroundJobRegistryOptions['spawn']>
  private disposed = false

  constructor(private readonly options: BackgroundJobRegistryOptions) {
    this.maxPerMember = options.maxPerMember ?? BACKGROUND_JOB_MAX_PER_MEMBER
    this.maxTotal = options.maxTotal ?? BACKGROUND_JOB_MAX_TOTAL
    this.tailBytes = options.tailBytes ?? BACKGROUND_JOB_OUTPUT_TAIL_BYTES
    this.killGraceMs = options.killGraceMs ?? BACKGROUND_JOB_KILL_GRACE_MS
    this.now = options.now ?? (() => Date.now())
    this.spawnFn = options.spawn ?? ((program, args, spawnOptions) => nodeSpawn(program, [...args], spawnOptions) as unknown as ChildProcessWithoutNullStreams)
  }

  /**
   * Spawn one job. A rejected budget or an unknown member is a thrown refusal
   * the tool renders; a child that fails to spawn finishes the job immediately
   * as failed with the spawn error in the tail.
   */
  start(input: BackgroundJobStartInput): { readonly job: BackgroundJob; readonly token: string } {
    if (this.disposed) throw new Error('the Team Host is stopping; no new background jobs')
    const liveForMember = [...this.jobs.values()].filter(entry => entry.job.ownerMemberId === input.ownerMemberId && entry.job.status === 'running')
    if (liveForMember.length >= this.maxPerMember) {
      throw new Error(`this Member already holds ${this.maxPerMember} running background jobs; cancel one with team_job action=cancel first`)
    }
    if ([...this.jobs.values()].filter(entry => entry.job.status === 'running').length >= this.maxTotal) {
      throw new Error(`the Team is already running ${this.maxTotal} background jobs; wait for one to finish or cancel it`)
    }
    const job: BackgroundJob = {
      jobId: `job:${randomUUID()}`,
      workspaceId: input.workspaceId,
      ownerMemberId: input.ownerMemberId,
      ownerHandle: input.ownerHandle,
      name: input.name,
      command: [input.program, ...(input.args ?? [])].join(' '),
      startedAt: this.now(),
      status: 'running',
    }
    const token = randomBytes(24).toString('hex')
    const entry: JobProcess = { job, token, child: undefined, tail: [], tailBytes: 0, finished: false, killTimer: undefined }
    this.jobs.set(job.jobId, entry)
    try {
      const child = this.spawnFn(input.program, input.args ?? [], {
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        env: {
          ...process.env,
          ...input.env,
          AGENT_TEAM_JOB_ID: job.jobId,
          AGENT_TEAM_JOB_TOKEN: token,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      })
      entry.child = child
      child.stdout.on('data', chunk => this.appendTail(entry, chunk))
      child.stderr.on('data', chunk => this.appendTail(entry, chunk))
      child.once('error', error => {
        this.appendTail(entry, Buffer.from(`\n[spawn error] ${error.message}\n`, 'utf8'))
        void this.finish(entry, 'failed')
      })
      child.once('close', code => {
        void this.finish(entry, code === 0 ? 'exited' : 'failed', code ?? undefined)
      })
    } catch (error) {
      this.appendTail(entry, Buffer.from(`\n[spawn error] ${error instanceof Error ? error.message : String(error)}\n`, 'utf8'))
      void this.finish(entry, 'failed')
    }
    return { job, token }
  }

  /** One job's record, or undefined once it was forgotten. */
  get(jobId: string): BackgroundJob | undefined {
    return this.jobs.get(jobId)?.job
  }

  /** The output tail captured so far (bounded; empty for a finished-then-forgotten job). */
  tailOf(jobId: string): string {
    const entry = this.jobs.get(jobId)
    if (entry === undefined) return ''
    return Buffer.concat(entry.tail).toString('utf8')
  }

  /** Every job owned by one Member, newest first. */
  listForMember(memberId: AgentTeamMemberId): readonly BackgroundJob[] {
    return [...this.jobs.values()]
      .filter(entry => entry.job.ownerMemberId === memberId)
      .map(entry => entry.job)
      .sort((left, right) => right.startedAt - left.startedAt)
  }

  /** How many jobs this Member may still start right now. */
  capacityForMember(memberId: AgentTeamMemberId): number {
    const live = [...this.jobs.values()].filter(entry => entry.job.ownerMemberId === memberId && entry.job.status === 'running').length
    return Math.max(0, this.maxPerMember - live)
  }

  /**
   * Cancel one running job: SIGTERM, then SIGKILL after the grace. The finish
   * notice rides whichever signal actually ends it; cancelling a finished or
   * unknown job is a no-op the tool reports.
   */
  cancel(jobId: string): boolean {
    const entry = this.jobs.get(jobId)
    if (entry === undefined || entry.job.status !== 'running' || entry.child === undefined) return false
    void this.finish(entry, 'cancelled', undefined, entry.child)
    return true
  }

  /**
   * A script reported progress. The job token is the only credential; a
   * mismatch is a refusal the gateway maps to 401. The body is bounded here so
   * the Host-side post never carries an unbounded payload.
   */
  async scriptMessage(jobId: string, token: string, body: string): Promise<BackgroundJob> {
    const entry = this.jobs.get(jobId)
    if (entry === undefined) throw new Error(`unknown background job '${jobId}'`)
    if (timingSafeHexEqual(entry.token, token) === false) throw new Error('the job token does not match this job')
    if (entry.job.status !== 'running') throw new Error(`background job '${jobId}' already ${entry.job.status}; a finished job takes no further reports`)
    const trimmed = body.trim()
    if (trimmed === '') throw new Error('a job message needs a non-empty body')
    entry.job.lastScriptMessage = trimmed.length <= 1000 ? trimmed : `${trimmed.slice(0, 999)}…`
    await this.options.onScriptMessage(entry.job, entry.job.lastScriptMessage)
    return entry.job
  }

  /** Kill every live child and stop accepting work; called on Host dispose. */
  dispose(): void {
    this.disposed = true
    for (const entry of this.jobs.values()) {
      if (entry.job.status !== 'running' || entry.child === undefined) continue
      try {
        entry.child.kill('SIGKILL')
      } catch (error) {
        this.options.log(`background job '${entry.job.jobId}' kill on dispose failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /** One finish: latch, classify, signal the child if a cancel drove it, then notify. */
  private async finish(entry: JobProcess, status: BackgroundJobStatus, exitCode?: number, killChild?: ChildProcessWithoutNullStreams): Promise<void> {
    if (entry.finished) return
    entry.finished = true
    entry.job.status = status
    if (exitCode !== undefined) entry.job.exitCode = exitCode
    entry.job.ranSeconds = Math.max(0, Math.round((this.now() - entry.job.startedAt) / 1000))
    if (entry.killTimer !== undefined) { clearTimeout(entry.killTimer); entry.killTimer = undefined }
    if (killChild !== undefined) {
      // A cancel: give the child a graceful window, then end it. The notice
      // still fires now — the outcome is decided, the kill is cleanup.
      try {
        killChild.kill('SIGTERM')
        const timer = setTimeout(() => {
          entry.killTimer = undefined
          try { killChild.kill('SIGKILL') } catch { /* the child is already gone */ }
        }, this.killGraceMs)
        timer.unref?.()
        entry.killTimer = timer
      } catch { /* the child is already gone */ }
    }
    try {
      await this.options.onFinished(entry.job)
    } catch (error) {
      this.options.log(`background job notice for '${entry.job.jobId}' failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Append one output chunk, keeping only the last `tailBytes`. */
  private appendTail(entry: JobProcess, chunk: Buffer): void {
    entry.tail.push(chunk)
    entry.tailBytes += chunk.length
    while (entry.tailBytes > this.tailBytes && entry.tail.length > 0) {
      const dropped = entry.tail.shift()
      if (dropped !== undefined) entry.tailBytes -= dropped.length
    }
    if (entry.tail.length > 0 && entry.tailBytes > this.tailBytes) {
      // A single oversized chunk: keep its tail slice only.
      const last = entry.tail[entry.tail.length - 1]!
      if (last.length > this.tailBytes) {
        entry.tail[entry.tail.length - 1] = last.subarray(last.length - this.tailBytes)
        entry.tailBytes = this.tailBytes
      }
    }
  }
}

/** Constant-time comparison of two hex tokens. */
function timingSafeHexEqual(expected: string, provided: string): boolean {
  if (expected.length !== provided.length) return false
  let diff = 0
  for (let index = 0; index < expected.length; index += 1) {
    diff |= expected.charCodeAt(index) ^ provided.charCodeAt(index)
  }
  return diff === 0
}
