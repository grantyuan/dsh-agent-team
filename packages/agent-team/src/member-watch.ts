/**
 * Team-owned Member watch monitor.
 *
 * A designated leader can place a standing watch over one teammate with the
 * `team_watch` tool. The watch itself is durable ledger state (an ordinary
 * `team/member-watch-started` operation), so a restart re-reads who is watching
 * whom instead of forgetting the leader's standing instruction; this module is
 * only the sampling policy on top of it.
 *
 * Each pass samples every active watch at its own cadence and reports back to
 * the watching leader when something the leader would want to know changed:
 *
 * - the observed state moved (healthy / settling / stopped), which covers
 *   running, idle, failed and unavailable in the vocabulary supervision uses;
 * - the state has lasted longer than the watch's stall threshold — "stopped
 *   for five minutes" is one notice, not one per pass;
 * - the target picked up or dropped running Tasks.
 *
 * Every notice is an ordinary ledger Message from the Team Assistant to the
 * leader, so it lands in the leader's Inbox and its Thread like any other Team
 * fact. Process state here (last sample, last state, per-episode stall latch)
 * is deliberately process-local and reconstructible: a restart re-samples and
 * re-reports the current state once, which reads as a fresh baseline rather
 * than as lost history.
 *
 * @module @wowyuarm/dsh-agent-team/member-watch
 */

import type { AgentTeamMemberId, AgentTeamMemberWatch, AgentTeamMemberWatchRef } from './types.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'

/** How often the watch pass runs once the Host has restored its Members. */
export const MEMBER_WATCH_PASS_INTERVAL_MS = 30 * 1000

/** Stable first line: it names the notice in the leader's Inbox and matches the other coordinator markers. */
export const MEMBER_WATCH_MARKER = 'Team watch:'

/** One running Task as the watch notice lists it. */
export interface MemberWatchTask {
  readonly taskRef: string
  readonly taskNumber?: number
  readonly status: string
  readonly subject: string
}

/** One observation of a watched Member, read fresh at each sample. */
export interface MemberWatchSample {
  /** The supervision state: the same three words the leader's supervision panel reads. */
  readonly state: 'healthy' | 'settling' | 'stopped'
  readonly presence: 'available' | 'working' | 'error' | 'unavailable'
  /** Human-readable diagnostic when the Member is not healthy. */
  readonly diagnostic?: string
  /** Tokens currently in the Member's context, when the meter could measure them. */
  readonly contextTokens?: number
  /** The route's effective context window, when it is known. */
  readonly contextWindow?: number
  /** Completed conversation turns across the Member's rollover lineage. */
  readonly turns: number
  /** The Tasks the Member currently holds, in Task-list order. */
  readonly tasks: readonly MemberWatchTask[]
}

/** One leader-facing notice the monitor emits. */
export interface MemberWatchNotice {
  readonly watch: AgentTeamMemberWatch
  readonly leaderMemberId: AgentTeamMemberId
  readonly memberId: AgentTeamMemberId
  readonly workspaceId: WorkspaceId
  /** The watching leader's handle: the notice's mention target. */
  readonly leaderHandle: string
  /** The watched Member's handle, as the notice names it. */
  readonly handle: string
  /** 'transition' | 'stalled' | 'tasks' — why this notice fired. */
  readonly reason: 'transition' | 'stalled' | 'tasks'
  readonly sample: MemberWatchSample
  /** How long the sampled state has lasted at notice time. */
  readonly stateMinutes: number
  /** True on the first sample of a process: the baseline, not a change. */
  readonly baseline: boolean
}

export interface MemberWatchMonitorOptions {
  /** Every active watch, oldest first — the durable read the pass iterates. */
  readonly watches: () => readonly AgentTeamMemberWatch[]
  /** The Member's handle for the notice body; undefined once the Member left the roster. */
  readonly handleOf: (memberId: AgentTeamMemberId) => string | undefined
  /** The watching leader's handle: the notice wakes that Member by mention. */
  readonly leaderHandleOf: (memberId: AgentTeamMemberId) => string | undefined
  /** One fresh observation of the watched Member, or undefined when it cannot be read. */
  readonly sampleOf: (memberId: AgentTeamMemberId, workspaceId: WorkspaceId) => Promise<MemberWatchSample | undefined>
  /** Post the notice to the watching leader. A throw is logged and the next pass retries. */
  readonly notify: (notice: MemberWatchNotice) => Promise<void>
  /** Log one coordinator diagnostic. */
  readonly log: (message: string) => void
  readonly intervalMs?: number
  readonly now?: () => number
}

/** Per-watch sampling memory: when it was last read and what it read. */
interface WatchMemory {
  sampledAt: number
  stateSince: number
  sample: MemberWatchSample
  stalledNotified: boolean
}

/**
 * The periodic watch pass. Overlapping passes are skipped, never queued — the
 * same contract every other Host pass keeps.
 */
export class MemberWatchMonitor {
  private readonly memories = new Map<AgentTeamMemberWatchRef, WatchMemory>()
  private readonly intervalMs: number
  private readonly now: () => number
  private timer: ReturnType<typeof setInterval> | undefined
  private passRunning = false
  private disposed = false

  constructor(private readonly options: MemberWatchMonitorOptions) {
    this.intervalMs = options.intervalMs ?? MEMBER_WATCH_PASS_INTERVAL_MS
    this.now = options.now ?? (() => Date.now())
  }

  /** Begin the periodic pass; called once the Host has restored every Member. */
  start(): void {
    if (this.disposed || this.timer !== undefined) return
    this.timer = setInterval(() => { void this.runPass() }, this.intervalMs)
    this.timer.unref?.()
  }

  /** One pass; a test or an operator may drive it directly with a chosen clock. */
  async runPass(now = this.now()): Promise<void> {
    if (this.disposed || this.passRunning) return
    this.passRunning = true
    try {
      const watches = this.options.watches()
      const live = new Set(watches.map(watch => watch.watchRef))
      // A cancelled watch must not keep a memory entry: the ref never returns.
      for (const watchRef of this.memories.keys()) if (!live.has(watchRef)) this.memories.delete(watchRef)
      for (const watch of watches) await this.sample(watch, now)
    } finally {
      this.passRunning = false
    }
  }

  /**
   * How long the state this process last sampled has held, in whole minutes.
   * Undefined until the first sample, so a reader can fall back to the durable
   * watch start instead of claiming an age it never observed.
   */
  sampledStateMinutes(watchRef: AgentTeamMemberWatchRef, now = this.now()): number | undefined {
    const memory = this.memories.get(watchRef)
    return memory === undefined ? undefined : Math.max(0, Math.floor((now - memory.stateSince) / 60_000))
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    this.memories.clear()
  }

  private async sample(watch: AgentTeamMemberWatch, now: number): Promise<void> {
    const previous = this.memories.get(watch.watchRef)
    if (previous !== undefined && now - previous.sampledAt < watch.intervalMinutes * 60_000) return
    let sample: MemberWatchSample | undefined
    try {
      sample = await this.options.sampleOf(watch.memberId, watch.workspaceId)
    } catch (error) {
      this.options.log(`member watch sample for '${watch.memberId}' failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (sample === undefined) return
    const handle = this.options.handleOf(watch.memberId)
    if (handle === undefined) return
    const leaderHandle = this.options.leaderHandleOf(watch.leaderMemberId)
    if (leaderHandle === undefined) return
    if (previous === undefined) {
      // The first sample of this process is the baseline: it reports the
      // current state once so the leader knows what is being watched, and it
      // never claims a transition it did not observe.
      this.memories.set(watch.watchRef, { sampledAt: now, stateSince: now, sample, stalledNotified: false })
      await this.fire(watch, handle, leaderHandle, 'transition', sample, 0, true)
      return
    }
    const changed = previous.sample.state !== sample.state || previous.sample.presence !== sample.presence
      || previous.sample.diagnostic !== sample.diagnostic
    const stateSince = changed ? now : previous.stateSince
    const stateMinutes = Math.max(0, Math.floor((now - stateSince) / 60_000))
    const stalled = !changed && !previous.stalledNotified && stateMinutes >= watch.stalledMinutes
    const tasksChanged = !this.sameTasks(previous.sample.tasks, sample.tasks)
    this.memories.set(watch.watchRef, {
      sampledAt: now, stateSince, sample,
      stalledNotified: changed ? false : previous.stalledNotified || stalled,
    })
    if (changed) {
      await this.fire(watch, handle, leaderHandle, 'transition', sample, stateMinutes, false)
      return
    }
    if (stalled) {
      await this.fire(watch, handle, leaderHandle, 'stalled', sample, stateMinutes, false)
      return
    }
    if (tasksChanged) await this.fire(watch, handle, leaderHandle, 'tasks', sample, stateMinutes, false)
  }

  private sameTasks(left: readonly MemberWatchTask[], right: readonly MemberWatchTask[]): boolean {
    return left.length === right.length && left.every((task, index) => task.taskRef === right[index]?.taskRef && task.status === right[index]?.status)
  }

  /** Fire one notice: a throw is logged, never rethrown into the pass. */
  private async fire(watch: AgentTeamMemberWatch, handle: string, leaderHandle: string,
    reason: MemberWatchNotice['reason'], sample: MemberWatchSample, stateMinutes: number, baseline: boolean): Promise<void> {
    try {
      await this.options.notify({
        watch, leaderMemberId: watch.leaderMemberId, memberId: watch.memberId, workspaceId: watch.workspaceId,
        leaderHandle, handle, reason, sample, stateMinutes, baseline,
      })
    } catch (error) {
      this.options.log(`member watch notice for '${handle}' failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/**
 * Quoted Task subjects must not re-resolve as an authored mention: the same
 * full-width substitution the liaison uses keeps a subject starting with
 * `@Someone` from escalating a bystander into a recipient of this notice.
 */
function sanitizeQuotedText(value: string): string {
  return value.replace(/@/g, '＠')
}

/** The leader-facing watch notice: one line naming the reason, then the observed facts. */
export function memberWatchNoticeText(input: MemberWatchNotice): string {
  const duration = input.stateMinutes <= 0 ? 'just now' : `for ${input.stateMinutes} minute${input.stateMinutes === 1 ? '' : 's'}`
  const opening = input.baseline
    ? `@${input.leaderHandle} ${MEMBER_WATCH_MARKER} ${input.handle} is ${input.sample.state} (${input.sample.presence}); this is the baseline for your watch.`
    : input.reason === 'stalled'
      ? `@${input.leaderHandle} ${MEMBER_WATCH_MARKER} ${input.handle} has stayed ${input.sample.state} (${input.sample.presence}) ${duration}, which is past the ${input.watch.stalledMinutes}-minute stall threshold you set.`
      : input.reason === 'tasks'
        ? `@${input.leaderHandle} ${MEMBER_WATCH_MARKER} ${input.handle} changed the Tasks it holds.`
        : `@${input.leaderHandle} ${MEMBER_WATCH_MARKER} ${input.handle} moved to ${input.sample.state} (${input.sample.presence}) ${duration}.`
  const lines = [opening]
  if (input.sample.diagnostic !== undefined) lines.push(`Diagnostic: ${sanitizeQuotedText(input.sample.diagnostic)}`)
  const context = input.sample.contextTokens === undefined
    ? 'Context: unavailable'
    : input.sample.contextWindow === undefined
      ? `Context: ${input.sample.contextTokens} tokens`
      : `Context: ${input.sample.contextTokens} / ${input.sample.contextWindow} tokens`
  lines.push(`${context}; ${input.sample.turns} completed turn(s).`)
  lines.push(input.sample.tasks.length === 0
    ? 'Running Tasks: none.'
    : `Running Tasks: ${input.sample.tasks.map(task => `${task.taskRef}${task.taskNumber === undefined ? '' : ` (#${task.taskNumber})`} — ${task.status} — ${sanitizeQuotedText(task.subject)}`).join('; ')}`)
  lines.push(`Watching every ${input.watch.intervalMinutes} minute(s) with a ${input.watch.stalledMinutes}-minute stall threshold. Cancel with team_watch action=stop watchRef=${input.watch.watchRef} when it is no longer needed.`)
  return lines.join('\n')
}
