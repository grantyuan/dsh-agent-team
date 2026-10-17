/**
 * Model-facing context-management tools for Team Members.
 *
 * `context_rollover` and `context_checkpoint` are the published engine's tools,
 * built by `createContinuityTools`: the engine owns their argument contract, the
 * anti-forgery gate on a cited ref, the `concludeTurn()` timing, and the render
 * shapes, while the Team supplies its own vocabulary (`TEAM_CONTINUITY_TEXT`)
 * and the mechanism behind `ContinuityToolAdapter`. Hand-written copies of those
 * two descriptions used to live here and drifted from the engine's defaults, so
 * the Team's guidance now travels only through the engine's text seams.
 *
 * `context_timeline` deliberately stays Team-owned. Its render never prints a
 * ref-shaped string for a non-restorable row — a short digest names the row
 * instead, because a printed ref is exactly what a model copies into
 * `checkpointRef` — and the engine's render has no switch for that. The
 * adapter's own `timeline` member is still implemented: the engine's contract
 * requires it, and the shape it returns is the one the engine's render reads.
 * @module @wowyuarm/dsh-agent-team/context-tools
 */

import { createHash } from 'node:crypto'
import {
  createContinuityTools,
  type CheckpointToolRequest,
  type ContinuityToolAdapter,
  type ContinuityToolText,
  type RolloverToolRequest,
} from '@wowyuarm/dsh-context-continuity'
import type { AgentTeamContextCheckpointRef, AgentTeamInterruptRef, AgentTeamInterruptView, AgentTeamTaskRef, AgentTeamThreadRef } from '@wowyuarm/dsh-agent-team/types'
import { MAX_TIMELINE_LIMIT } from '@wowyuarm/dsh-agent-team/host'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { member, service } from './host-access.ts'

/**
 * Short stable identifier for one timeline row: a digest of the anchor's own
 * ref. Rows routinely share a label (`Team message` is a constant) and a price
 * (the same completed turn prices both), so without it two distinct anchors
 * read as one duplicated row. Deliberately NOT the ref and deliberately not
 * actionable: a ref only means something on a restorable row, which prints it
 * in full for `context_rollover`.
 */
function anchorId(checkpointRef: string): string {
  return createHash('sha256').update(checkpointRef).digest('hex').slice(0, 6)
}

/** The calling Agent, or a model-visible rejection — these tools only exist in a Member Session. */
function agentOf(exec: ToolRunContext) {
  const agent = exec.agent
  if (agent === undefined) throw new Error('context tool requires an Agent session')
  return agent
}

/**
 * Team's half of the engine's contract: resolve the calling execution to its
 * Member and Host, answer the ref gate from the one policy that owns it, and run
 * the effects. Every method resolves its own caller, because one adapter serves
 * all three tools.
 */
const adapter: ContinuityToolAdapter = {
  /**
   * One policy, two readers: a ref is restorable exactly when the Team timeline
   * — the same list the model picked from — offers it as such. The walk is asked
   * for the widest window the timeline tool can show, so any ref a timeline read
   * could have printed is answered here.
   */
  async isRestorableRef(checkpointRef, exec) {
    const agent = agentOf(exec)
    const current = member(agent)
    const timeline = await service(agent).contextTimelineForAgent(agent, { memberId: current.memberId, limit: MAX_TIMELINE_LIMIT })
    return timeline.items.some(item => item.checkpointRef === checkpointRef && item.restorable)
  },
  async requestRollover(request: RolloverToolRequest, exec) {
    const agent = agentOf(exec)
    const current = member(agent)
    // The engine already validated the argument shape and the cited ref; the
    // Host owns the durable intent and the generation swap that follows it at
    // the idle boundary.
    const outcome = await service(agent).requestNewContext(agent, {
      memberId: current.memberId,
      ...(request.checkpointRef === undefined ? {} : { checkpointRef: request.checkpointRef as AgentTeamContextCheckpointRef }),
      ...(request.relatedFiles.length === 0 ? {} : { relatedFiles: [...request.relatedFiles] }),
    })
    return { mode: outcome.mode }
  },
  async recordCheckpoint(request: CheckpointToolRequest, exec) {
    const agent = agentOf(exec)
    const current = member(agent)
    // The Host validates binding, running-turn fencing, and the name budget;
    // the durable checkpoint is the successful call/result pair the Session
    // projection folds, and the ref derives from the tool call id.
    const outcome = service(agent).recordCheckpointForAgent(agent, { memberId: current.memberId, callId: request.callId, name: request.name })
    return { checkpointRef: outcome.checkpointRef, name: outcome.name }
  },
  async timeline(request, exec) {
    const agent = agentOf(exec)
    const current = member(agent)
    const result = await service(agent).contextTimelineForAgent(agent, {
      memberId: current.memberId,
      ...(request.limit === undefined ? {} : { limit: request.limit }),
    })
    // Team's item vocabulary is its own (`agent` / `team-boundary` / `handoff` /
    // `compaction` / `head`); the engine names the same anchors in its terms —
    // four Team sources collapse onto the engine's three kinds, and the two that
    // say something a reader needs (`handoff`, `compaction`) ride its opaque
    // `kind` field rather than being flattened silently.
    return {
      usageTokens: result.usageTokens,
      handoffAt: result.handoffAt,
      hardLimit: result.hardLimit,
      items: result.items.map(item => ({
        ref: item.checkpointRef,
        label: item.name,
        source: item.source === 'agent' ? 'checkpoint' as const : item.source === 'head' ? 'head' as const : 'boundary' as const,
        ...(item.source === 'handoff' || item.source === 'compaction' ? { kind: item.source } : {}),
        retainedTokens: item.retainedTokens,
        discardedTokens: item.discardedTokens,
        affectedTopics: [...item.affectedThreads],
        restorable: item.restorable,
        ...(item.reason === undefined ? {} : { reason: item.reason }),
      })),
      ...(result.incompleteFrom === undefined ? {} : { incompleteFrom: result.incompleteFrom }),
    }
  },
}

/**
 * Team vocabulary for the engine's tools. `carriedContext` names the channels a
 * fresh generation already receives — without it the engine's "seeded only by
 * your handoff" sentence reads as "everything must be restated", which is what
 * our own corpus showed members doing. The checklist carries the one item the
 * engine's default does not ask for and the corpus showed missing: which facts
 * were verified and which were only trusted.
 */
const TEAM_CONTINUITY_TEXT: ContinuityToolText = {
  subjectNoun: 'Team Member',
  carriedContext: 'You stay the same Team Member: your @handle and role, your private memory index, your skills catalog, and the Team and Workspace instructions carry across a rollover — they are re-injected at birth — and the Team ledger (Threads, Tasks, Claims, your inbox, your owner jobs) is one query away (team_view, team_inbox). Do not restate any of it.',
  rolloverChecklist: 'the objective and the atomic action in flight; facts and evidence not already recorded elsewhere; which items you verified and which you only trusted; inferences and unresolved conflicts; current external side effects and their verification state (files, git, jobs, browser state, remote calls); one explicit next step',
  topicNoun: 'Thread',
  topicNounPlural: 'Threads',
}

const engineTools = createContinuityTools(adapter, TEAM_CONTINUITY_TEXT)

const contextTimeline = defineTool({
  name: 'context_timeline',
  description: 'Inspect the bounded structural timeline of this Member\'s context lineage: named checkpoints you recorded, Team boundaries (effect anchors: a committed team_message, a successful team_claim mutation, a follow/unfollow — rendered as `Team message`, `Team task claim change`, `Team attention change`; plus a Thread\'s first delivered notice, rendered as `First arrival: <refs>`), handoff and compaction boundaries, and the current head — across the current generation and its archived ancestors. Only the first delivery of a Thread\'s facts anchors; later re-deliveries and reminders produce no boundary. Returns approximate retained/discarded token estimates, current usage against the pressure budget, the Threads whose facts entered your context by each anchor, and which anchors are restorable. A Team boundary is a selectable default checkpoint exactly when the retained prefix through it stays inside one Thread and the return would shrink the working set below the handoff budget; a boundary spanning several Threads, or attributable to none, states its reason instead. Every row carries a short `anchor` id: it distinguishes rows that share a label and a price, and it is NOT a ref — only the `checkpointRef` printed on a restorable row may be cited to context_rollover. Structural only: no transcript content. A fresh context_rollover (no checkpointRef) never requires consulting this timeline first — call it directly. Use this tool only when you specifically intend a checkpointRef return: to pick the smallest sufficient ref, or to confirm that a fresh handoff is the better path when every anchor is marked non-restorable.',
  parameters: {
    limit: { type: 'number', description: 'Maximum number of items to return (default 12, at most 24).' },
  },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: {
      usageTokens: { type: 'number', required: true },
      hardLimit: { type: 'number', required: true },
      handoffAt: { type: 'number', required: true },
      items: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        checkpointRef: { type: 'string', required: true },
        name: { type: 'string', required: true },
        source: { type: 'string', required: true },
        retainedTokens: { type: 'number', required: true },
        discardedTokens: { type: 'number', required: true },
        affectedThreads: { type: 'array', required: true, items: { type: 'string' } },
        restorable: { type: 'boolean', required: true },
        reason: { type: 'string' },
        sourceSessionId: { type: 'string' },
      } } },
      incompleteFrom: { type: 'object', additionalProperties: false, properties: {
        sessionId: { type: 'string', required: true },
        reason: { type: 'string', required: true },
      } },
    } },
    // The item list is the whole decision surface: without each anchor's
    // ref, label, source, size estimates, affected Threads, and
    // restorable/reason verdict, the model cannot pick a `checkpointRef` for
    // `context_rollover` — the summary line alone left the tool unusable for
    // seeded returns. The short anchor id distinguishes rows that share a
    // label and a price without ever printing a ref that is not usable. The
    // Host bounds items (default 12, at most 24), so the list cannot grow
    // unbounded. `incompleteFrom` states where and why the lineage walk
    // stopped early, so history read up to that ancestor is known to be a
    // truncation, not everything that exists.
    render: (_args, value) => {
      const lines = [`Context timeline: ${value.usageTokens} tokens used (handoff at ${value.handoffAt}, hard limit ${value.hardLimit}). ${value.items.length} item(s):`]
      for (const item of value.items) {
        const threads = item.affectedThreads.length === 0 ? 'no Threads' : `Threads ${item.affectedThreads.join(', ')}`
        const size = `retained ~${item.retainedTokens}, discarded ~${item.discardedTokens}`
        const restorable = item.restorable
          ? `restorable — ref: ${item.checkpointRef}`
          : `not restorable — ${item.reason ?? 'no reason given'}`
        lines.push(`- ${item.name} [source: ${item.source}; anchor ${anchorId(item.checkpointRef)}] (${size}; ${threads}) — ${restorable}`)
      }
      if (value.incompleteFrom !== undefined) {
        lines.push(`History incomplete: the lineage walk stopped at Session ${value.incompleteFrom.sessionId} (${value.incompleteFrom.reason}); ancestors before it could not be read and are not reflected above.`)
      }
      return [{ type: 'text', text: lines.join('\n') }]
    },
  },
  async execute(args, exec) {
    const agent = exec.agent
    if (agent === undefined) throw new Error('context_timeline requires an Agent session')
    const current = member(agent)
    const host = service(agent)
    const limit = typeof args.limit === 'number' ? args.limit : undefined
    const result = await host.contextTimelineForAgent(agent, { memberId: current.memberId, ...(limit === undefined ? {} : { limit }) })
    // The Host result is deeply immutable; the tool output contract carries
    // plain arrays, so re-shape without any semantic change.
    return {
      usageTokens: result.usageTokens,
      hardLimit: result.hardLimit,
      handoffAt: result.handoffAt,
      items: result.items.map(item => ({ ...item, affectedThreads: [...item.affectedThreads] })),
      ...(result.incompleteFrom === undefined ? {} : { incompleteFrom: result.incompleteFrom }),
    }
  },
})

/**
 * Team's own interrupt stack: pins an unfinished session onto a resolved
 * checkpoint so the Member (or any later generation after a reset) can pick
 * it back up, lists the stack newest-first with live restorable verdicts, and
 * releases entries that will not be returned to. The swap itself stays
 * exclusively `context_rollover`'s: resuming is citing a listed anchor ref
 * there, and the Host closes the matching entry inside that transition —
 * this tool never moves a context.
 */
const contextInterrupt = defineTool({
  name: 'context_interrupt',
  description: 'Manage your interrupted-session stack: work you stopped before completion, pinned to a restorable context checkpoint. `record` pins a checkpoint you just recorded (context_checkpoint resolves at its turn end, so record lands in the FOLLOWING turn — the engine\'s quiet continuation carries you there) with a short semantic label and a bounded incomplete-state note (what remains, where you stopped, what was verified vs merely trusted); pass notePath when the detail lives in a private note. A recorded interrupt protects the unfinished state: while an entry is pending you may take any new (temporary) task as usual; when it completes, resume the NEWEST pending entry first (LIFO), then the next — so several interruptions unwound one by one. `list` returns the stack newest-first with live verdicts: restorable entries resume by calling context_rollover citing that entry\'s anchor ref exactly — the Host closes the entry when the return commits; a not-restorable verdict states its reason (budget or lineage moved), and then you read your note, carry the unfinished state into a fresh handoff, and `release` the entry. Prefer the checkpoint return over the fresh handoff when resuming: the return keeps your raw prefix — and the provider prompt cache behind it — while a fresh handoff discards both. `release` closes one entry without returning (superseded, done by someone else, or carried into a fresh handoff); the stack is bounded, so do not sit on entries you will not return to. Never synthesize refs: checkpoint refs come only from context_checkpoint or context_timeline, interrupt refs only from record and list. Entries are private context structure — no teammate sees them; the durable shared record of the work itself stays in Threads.',
  parameters: {
    action: { type: 'string', required: true, description: 'record | list | release.' },
    checkpointRef: { type: 'string', description: 'record: the checkpoint this work is pinned to, exactly as context_checkpoint returned it or context_timeline printed it.' },
    label: { type: 'string', description: 'record: short semantic name for the interrupted work (at most 120 characters).' },
    incompleteState: { type: 'string', description: 'record: what remains and where you stopped (at most 2000 characters); the full detail belongs in your private note.' },
    notePath: { type: 'string', description: 'record: path of the private note that holds the detailed unfinished state.' },
    taskRef: { type: 'string', description: 'record: the Task being interrupted, if any, as bare task:<uuid>.' },
    threadRef: { type: 'string', description: 'record: the Thread the interrupted work belongs to, if any, as bare thread:<uuid>.' },
    interruptRef: { type: 'string', description: 'release: the entry to close, exactly as record or list returned it.' },
    reason: { type: 'string', description: 'release: one line on why it no longer needs returning.' },
  },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: {
      kind: { type: 'string', required: true },
      interruptRef: { type: 'string' },
      recordedSequence: { type: 'number' },
      items: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
        interruptRef: { type: 'string', required: true },
        label: { type: 'string', required: true },
        incompleteState: { type: 'string', required: true },
        checkpointRef: { type: 'string', required: true },
        recordedAt: { type: 'string', required: true },
        taskRef: { type: 'string' },
        threadRef: { type: 'string' },
        restorable: { type: 'boolean', required: true },
        reason: { type: 'string' },
      } } },
    } },
    render: (args, value) => {
      if (value.kind === 'listed') {
        if (value.items === undefined || value.items.length === 0) return [{ type: 'text', text: 'Interrupt stack empty: nothing is pinned for continuation.' }]
        const lines = [`Interrupt stack: ${value.items.length} pending, newest first (resume in this order once current work closes):`]
        for (const item of value.items) {
          const work = item.taskRef === undefined ? '' : ` task ${item.taskRef}`
          const verdict = item.restorable
            ? `restorable — resume with context_rollover citing ${item.checkpointRef}`
            : `not restorable — ${item.reason ?? 'no reason given'}; carry its state into a fresh handoff, then release`
          lines.push(`- ${item.label} (ref ${item.interruptRef};${work}; pinned ${item.recordedAt}) — ${verdict}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      }
      if (value.kind === 'recorded') {
        const label = typeof args.label === 'string' ? args.label : 'interrupted work'
        return [{ type: 'text', text: `Interrupt recorded: ${label} (ref ${value.interruptRef}). The unfinished session is pinned; take the temporary task now, and resume this entry via context_rollover with its anchor ref once that work closes.` }]
      }
      return [{ type: 'text', text: `Interrupt released (${value.interruptRef}). It no longer waits on a continuation.` }]
    },
  },
  async execute(args, exec) {
    const agent = exec.agent
    if (agent === undefined) throw new Error('context_interrupt requires an Agent session')
    const host = service(agent)
    const action = typeof args.action === 'string' ? args.action : ''
    if (action === 'list') {
      const outcome = await host.listInterruptsForAgent(agent)
      return { kind: 'listed', items: outcome.items.map(toInterruptViewItem) }
    }
    if (action === 'record') {
      const checkpointRef = requireString(args.checkpointRef, 'checkpointRef')
      const label = requireString(args.label, 'label')
      const incompleteState = requireString(args.incompleteState, 'incompleteState')
      const outcome = await host.recordInterruptForAgent(agent, {
        callId: exec.callId,
        checkpointRef: checkpointRef as AgentTeamContextCheckpointRef,
        label,
        incompleteState,
        ...(typeof args.notePath === 'string' && args.notePath !== '' ? { notePath: args.notePath } : {}),
        ...(typeof args.taskRef === 'string' && args.taskRef !== '' ? { taskRef: args.taskRef as AgentTeamTaskRef } : {}),
        ...(typeof args.threadRef === 'string' && args.threadRef !== '' ? { threadRef: args.threadRef as AgentTeamThreadRef } : {}),
      })
      return { kind: 'recorded', interruptRef: outcome.interruptRef, recordedSequence: outcome.recordedSequence }
    }
    if (action === 'release') {
      const interruptRef = requireString(args.interruptRef, 'interruptRef')
      const outcome = await host.releaseInterruptForAgent(agent, {
        callId: exec.callId,
        interruptRef: interruptRef as AgentTeamInterruptRef,
        ...(typeof args.reason === 'string' && args.reason !== '' ? { reason: args.reason } : {}),
      })
      return { kind: 'released', interruptRef: outcome.interruptRef }
    }
    throw new Error('context_interrupt action must be record, list, or release')
  },
})

/** Non-blank string argument, or a rejection naming the field the model missed. */
function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`context_interrupt requires a non-empty ${name}`)
  return value
}

/** The listed item as the tool output schema declares it (plain strings across the seam). */
interface InterruptViewItem {
  readonly interruptRef: string
  readonly label: string
  readonly incompleteState: string
  readonly checkpointRef: string
  readonly recordedAt: string
  readonly restorable: boolean
  readonly taskRef?: string
  readonly threadRef?: string
  readonly reason?: string
}

/** The Host result is deeply immutable; the tool output contract carries plain values. */
function toInterruptViewItem(item: AgentTeamInterruptView): InterruptViewItem {
  return {
    interruptRef: item.interruptRef,
    label: item.label,
    incompleteState: item.incompleteState,
    checkpointRef: item.checkpointRef,
    recordedAt: item.recordedAt,
    restorable: item.restorable,
    ...(item.taskRef === undefined ? {} : { taskRef: item.taskRef }),
    ...(item.threadRef === undefined ? {} : { threadRef: item.threadRef }),
    ...(item.reason === undefined ? {} : { reason: item.reason }),
  }
}

export function registerContextTools(ctx: { readonly tools: { register(tool: unknown): void } }): void {
  // The engine's two, then the Team's own timeline and interrupt stack: one
  // registration each, and the roster the Host validates against stays the
  // same four names.
  ctx.tools.register(engineTools.rollover)
  ctx.tools.register(engineTools.checkpoint)
  ctx.tools.register(contextTimeline)
  ctx.tools.register(contextInterrupt)
}
