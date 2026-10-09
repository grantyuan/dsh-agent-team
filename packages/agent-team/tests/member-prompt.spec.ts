import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
// Every test here boots a whole Host harness over a throwaway tree; the shared
// boot carries the same timeout headroom as the other harness specs (see
// member-tool-policy.spec.ts for the timing history).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import LlmRuntime, { ToolCallId, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import AgentTeam from '../src/index.ts'
import { COMPLETION_MARKER } from '../src/response-guard.ts'
import { MEMBER_PROMPT_SECTION_NAME } from '../src/member-runtime.ts'
import type { AgentTeamMemberId, AgentTeamRequestId } from '../src/types.ts'
import { MemoryStorageBackend } from './helpers/memory-backend.ts'

const sharedCleanups: Array<() => Promise<void>> = []
/** Per-test disposers (LLM adapter registrations, ordinary sessions): drained after each test. */
let testCleanups: Array<() => Promise<void> | void> = []
const originalDshHome = process.env.DSH_HOME
const requestId = (value: string): AgentTeamRequestId => value as AgentTeamRequestId

afterEach(async () => {
  await Promise.all(testCleanups.splice(0).map(cleanup => cleanup()))
})

afterAll(async () => {
  await Promise.all(sharedCleanups.splice(0).map(cleanup => cleanup()))
  if (originalDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalDshHome
})

class EmptyAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string) { return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 320_000 } }) }
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> { yield* [] }
}

class ScriptedAdapter extends EmptyAdapter {
  readonly requests: GenerateOptions[] = []
  private readonly responses: StreamChunk[][] = []

  enqueue(response: StreamChunk[]): void {
    this.responses.push(response)
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const response = this.responses.shift()
    if (response === undefined) throw new Error('ScriptedAdapter response queue is empty')
    for (const chunk of response) yield chunk
  }
}

/** Holds the first turn open until the test releases it. */
class GatedAdapter extends ScriptedAdapter {
  private gate = Promise.withResolvers<void>()
  private first = true

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (!this.first) {
      yield* super.stream(options)
      return
    }
    this.first = false
    this.requests.push(options)
    await this.gate.promise
    for (const chunk of toolCallResponse('gated-call', 'ordinary_tool', {})) yield chunk
  }

  release(): void {
    this.gate.resolve()
  }
}

function toolCallResponse(rawCallId: string, name: string, args: object): StreamChunk[] {
  const id = ToolCallId(rawCallId)
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function closingReply(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: `${text}${COMPLETION_MARKER}` },
    { type: 'block-end', index: 0, block: { type: 'text', text: `${text}${COMPLETION_MARKER}` } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 4 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise(resolve => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject !== agent || status !== 'idle') return
      dispose()
      resolve()
    })
  })
}

function waitForRunning(ctx: Context, agent: Agent): Promise<void> {
  return new Promise(resolve => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject !== agent || status !== 'running') return
      dispose()
      resolve()
    })
  })
}

/** File-shared harness: booted once in `beforeAll`, torn down once in `afterAll`. */
async function buildSharedHarness(): Promise<{
  readonly ctx: Context
  readonly workspaceId: WorkspaceId
  readonly teamFiber: Awaited<ReturnType<Context['plugin']>>
}> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-agent-team-prompt-'))
  const project = join(root, 'project')
  const persistence = join(root, 'sessions')
  await Promise.all([mkdir(project), mkdir(persistence)])
  process.env.DSH_HOME = join(root, 'dsh-home')
  // The team-tools fixture registers the six Team tools (the team-enabled
  // preset check requires them) plus two distinguishable content tools; the
  // member-context row is the preset's real runtime plugin.
  const teamMemberPlugins = [
    { id: 'member-context', name: '@wowyuarm/dsh-agent-team/member-context' },
    { id: 'team-tools', name: pathToFileURL(join(import.meta.dirname, 'helpers', 'team-tools-fixture.mjs')).href },
  ]
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(resolve(import.meta.dirname, '../../../')).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.group = Group
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) })
  ctx.provide('tokenMeter', { measure: () => ({ totalTokens: 0 }) })
  await ctx.plugin(JsonlSessionPersistence, { root: persistence })
  await ctx.plugin(AgentPresetRegistry, { default: 'team-member' })
  await ctx.plugin(AgentPreset, { id: 'team-member', plugins: teamMemberPlugins })
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const workspaceId = WorkspaceId('workspace:prompt-test')
  ctx.provide('workspaceRegistry', {
    get: (id: WorkspaceId) => id === workspaceId ? { id, path: project, attachSession: async () => {} } : undefined,
    list: () => [],
    archiveSession: async () => {},
  })
  const teamFiber = await ctx.plugin(AgentTeam)
  sharedCleanups.push(async () => { await ctx.fiber.dispose(); await facility.closeAll(); await rm(root, { recursive: true, force: true }) })
  return { ctx, workspaceId, teamFiber }
}

// Isolation invariant: the shared ledger never forgets, so every handle and
// every requestId in this file must be unique per test (suffixed t1..t5).
let shared: Awaited<ReturnType<typeof buildSharedHarness>>

beforeAll(async () => {
  shared = await buildSharedHarness()
})

/** Register one adapter for this test only; disposed in `afterEach`. */
function useAdapter(adapter: LlmAdapter): void {
  const dispose = shared.ctx.llm.registerAdapter(['mock'], adapter)
  testCleanups.push(() => { dispose() })
}

interface MemberFacts {
  readonly memberId: AgentTeamMemberId
  readonly sessionId: SessionId
  readonly handle: string
}

async function addMember(ctx: Context, workspaceId: WorkspaceId, handle: string, customPrompt?: string): Promise<MemberFacts> {
  const added = await ctx.agentTeam.addMember({
    requestId: requestId(`add-${handle}`), workspaceId, handle, description: 'Prompt member',
    presetId: 'team-member', channelRefs: [], ...(customPrompt === undefined ? {} : { prompt: { customPrompt } }),
  })
  expect(added.status.availability, JSON.stringify(added.status)).toBe('active')
  return { memberId: added.status.member.memberId, sessionId: added.status.member.sessionId, handle }
}

function liveAgent(ctx: Context, facts: MemberFacts): Agent {
  const agent = ctx.agents.get(facts.sessionId)
  expect(agent).toBeDefined()
  return agent!
}

/** The prompt assembly as the Member's own scope sees it. */
async function memberAssembly(ctx: Context, facts: MemberFacts) {
  return ctx.systemPrompt.assemble({ scope: scopeOf(liveAgent(ctx, facts).ctx)! })
}

function memberSection(assembly: { readonly sections: ReadonlyArray<{ readonly name: string; readonly text: string }> }): { readonly name: string; readonly text: string } | undefined {
  return assembly.sections.find(section => section.name === MEMBER_PROMPT_SECTION_NAME)
}

describe('Agent Team member custom role paragraph', () => {
  it('registers the paragraph at activation for its Member only and renders it into the prompt', async () => {
    useAdapter(new EmptyAdapter())
    const { ctx, workspaceId } = shared
    const plain = await addMember(ctx, workspaceId, 't1-plain')
    const prompted = await addMember(ctx, workspaceId, 't1-prompted', 'Always answer in Chinese.')

    // The section is scoped: only the Member with a paragraph carries it, and
    // the plain sibling's assembly is untouched.
    expect(memberSection(await memberAssembly(ctx, plain))).toBeUndefined()
    const promptedSection = memberSection(await memberAssembly(ctx, prompted))
    expect(promptedSection?.text).toBe('Always answer in Chinese.')
    expect(renderPrompt(await memberAssembly(ctx, prompted))).toContain('Always answer in Chinese.')

    // The stored profile round-trips through the Human read.
    const view = ctx.agentTeam.memberPromptView({ memberId: prompted.memberId })
    expect(view.prompt).toEqual({ customPrompt: 'Always answer in Chinese.' })
  })

  it('swaps the paragraph at the turn boundary in the same Session and releases it when cleared', async () => {
    useAdapter(new EmptyAdapter())
    const { ctx, workspaceId } = shared
    const member = await addMember(ctx, workspaceId, 't2-swap', 'First paragraph.')

    // An idle edit lands immediately: same Session, new text visible to the
    // next assembly.
    const edited = await ctx.agentTeam.updateMember({
      requestId: requestId('swap'), memberId: member.memberId, handle: member.handle, description: 'Prompt member',
      prompt: { customPrompt: 'Second paragraph.' },
    })
    expect(edited.status.member.sessionId).toBe(member.sessionId)
    expect(edited.status.member.prompt).toEqual({ customPrompt: 'Second paragraph.' })
    expect(memberSection(await memberAssembly(ctx, member))?.text).toBe('Second paragraph.')

    // Clearing the paragraph (absent profile) releases the section entirely.
    const cleared = await ctx.agentTeam.updateMember({
      requestId: requestId('clear'), memberId: member.memberId, handle: member.handle, description: 'Prompt member',
    })
    expect(cleared.status.member.prompt).toBeUndefined()
    expect(memberSection(await memberAssembly(ctx, member))).toBeUndefined()
    expect(renderPrompt(await memberAssembly(ctx, member))).not.toContain('Second paragraph.')
  })

  it('waits for a running turn, then swaps the paragraph in the same Session', async () => {
    const adapter = new GatedAdapter()
    useAdapter(adapter)
    const { ctx, workspaceId } = shared
    const member = await addMember(ctx, workspaceId, 't3-wait', 'First paragraph.')
    const agent = liveAgent(ctx, member)

    // Open a held turn so the edit lands while the agent is running.
    const turnDone = waitForIdle(ctx, agent)
    const running = waitForRunning(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run' }], source: { kind: 'user' } }))
    await running

    const edit = ctx.agentTeam.updateMember({
      requestId: requestId('swap-wait'), memberId: member.memberId, handle: member.handle, description: 'Prompt member',
      prompt: { customPrompt: 'Second paragraph.' },
    })
    // The edit is parked behind the running turn: it cannot resolve while the
    // agent is still working.
    const raced = await Promise.race([edit.then(() => 'settled'), new Promise<string>(resolve => { setTimeout(() => resolve('pending'), 50) })])
    expect(raced).toBe('pending')

    // Release the turn: the boundary applies the swap in the same Session,
    // and the closing reply needs its queued response.
    adapter.release()
    adapter.enqueue(closingReply('done'))
    const settled = await edit
    expect(settled.status.availability).toBe('active')
    expect(settled.status.member.sessionId).toBe(member.sessionId)
    expect(memberSection(await memberAssembly(ctx, member))?.text).toBe('Second paragraph.')
    await turnDone
  })

  it('adds no section for a whitespace-only paragraph and never registers an empty text', async () => {
    useAdapter(new EmptyAdapter())
    const { ctx, workspaceId } = shared
    // The blank paragraph normalizes to an absent profile on the Host, so the
    // activation sees no customPrompt and registers nothing.
    const blank = await addMember(ctx, workspaceId, 't4-blank', '   ')
    expect(ctx.agentTeam.memberPromptView({ memberId: blank.memberId }).prompt).toBeUndefined()
    expect(memberSection(await memberAssembly(ctx, blank))).toBeUndefined()
  })

  it('bails the parked swap silently when the handle goes stale during the boundary wait', async () => {
    const adapter = new GatedAdapter()
    useAdapter(adapter)
    const { ctx, workspaceId } = shared
    const member = await addMember(ctx, workspaceId, 't5-stale', 'First paragraph.')
    const agent = liveAgent(ctx, member)
    // The cancel path is reachable only through an external dispose the Team
    // lifecycle queue never sees, so the test simulates the queue's missing
    // bookkeeping (the handles entry drop) directly on the service instance.
    const internals = ctx.agentTeam as unknown as {
      handles: Map<string, AgentHandle>
      memberRuntime: { memberPromptSections: Map<string, unknown> }
    }

    // Open a held turn so the edit parks: capabilities and prompt change
    // together, so the capability edit owns the boundary wait and the prompt
    // swap runs against whatever that wait leaves behind.
    const running = waitForRunning(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run' }], source: { kind: 'user' } }))
    await running
    const edit = ctx.agentTeam.updateMember({
      requestId: requestId('stale'), memberId: member.memberId, handle: member.handle, description: 'Prompt member',
      capabilities: { skills: { allow: ['example'] } },
      prompt: { customPrompt: 'Second paragraph.' },
    })
    const raced = await Promise.race([edit.then(() => 'settled'), new Promise<string>(resolve => { setTimeout(() => resolve('pending'), 50) })])
    expect(raced).toBe('pending')

    // The out-of-queue destroy: the handles entry goes first (strictly before
    // any wait can settle), then the held turn ends cleanly — the idle status
    // event settles the parked wait with the entry already gone.
    const stale = internals.handles.get(member.memberId)
    expect(stale).toBeDefined()
    internals.handles.delete(member.memberId)
    adapter.enqueue(closingReply('done'))
    adapter.release()

    // The edit settles without surfacing the stale generation: the prompt swap
    // bails instead of re-registering over a moved-on handle.
    const settled = await edit
    expect(settled.status.member.prompt).toEqual({ customPrompt: 'Second paragraph.' })
    // The bail left the old generation's own registration untouched — no leak,
    // no second registration — and the ledger intent is not rolled back.
    expect(internals.memberRuntime.memberPromptSections.has(member.memberId)).toBe(true)
    expect(memberSection(await memberAssembly(ctx, member))?.text).toBe('First paragraph.')
    expect(ctx.agentTeam.memberPromptView({ memberId: member.memberId }).prompt).toEqual({ customPrompt: 'Second paragraph.' })

    // The next activation re-applies the committed paragraph from the ledger.
    await stale!.dispose()
    const recovered = await ctx.agentTeam.recoverMember({ requestId: requestId('recover-stale'), memberId: member.memberId, workspaceId })
    expect(recovered.status.availability).toBe('active')
    expect(memberSection(await memberAssembly(ctx, member))?.text).toBe('Second paragraph.')
  })
})
