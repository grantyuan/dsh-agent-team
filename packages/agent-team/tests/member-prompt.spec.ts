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
import { CURATE_MAX_TOKENS, CURATE_REQUIREMENTS_CAP, CURATE_SECTION_TEXT_CAP, buildCurateMessages, parseCurateProposal } from '../src/member-prompt-curation.ts'
import { MEMBER_PROMPT_SECTION_NAME, isProtectedPromptSection, sectionToolMapping } from '../src/member-runtime.ts'
import type { AgentTeamChannelRef, AgentTeamInboxItem, AgentTeamMemberId, AgentTeamRequestId } from '../src/types.ts'
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
    { id: 'usage-sections', name: pathToFileURL(join(import.meta.dirname, 'helpers', 'usage-section-fixture.mjs')).href },
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
// every requestId in this file must be unique per test (suffixed t1..t10).
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

/** The prompt assembly as the Member's own scope sees it (read-side shape: no turn signal). */
async function memberAssembly(ctx: Context, facts: MemberFacts) {
  return ctx.systemPrompt.assemble({ scope: scopeOf(liveAgent(ctx, facts).ctx)! })
}

/** The assembly a model turn would get: the loop assembles steps with the turn's signal. */
async function memberTurnAssembly(ctx: Context, facts: MemberFacts) {
  return ctx.systemPrompt.assemble({ scope: scopeOf(liveAgent(ctx, facts).ctx)!, signal: new AbortController().signal })
}

function memberSection(assembly: { readonly sections: ReadonlyArray<{ readonly name: string; readonly text: string }> }): { readonly name: string; readonly text: string } | undefined {
  return assembly.sections.find(section => section.name === MEMBER_PROMPT_SECTION_NAME)
}

function sectionNames(assembly: { readonly sections: ReadonlyArray<{ readonly name: string }> }): readonly string[] {
  return assembly.sections.map(section => section.name)
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
    const view = await ctx.agentTeam.memberPromptView({ memberId: prompted.memberId })
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
    expect((await ctx.agentTeam.memberPromptView({ memberId: blank.memberId })).prompt).toBeUndefined()
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
    expect((await ctx.agentTeam.memberPromptView({ memberId: member.memberId })).prompt).toEqual({ customPrompt: 'Second paragraph.' })

    // The next activation re-applies the committed paragraph from the ledger.
    await stale!.dispose()
    const recovered = await ctx.agentTeam.recoverMember({ requestId: requestId('recover-stale'), memberId: member.memberId, workspaceId })
    expect(recovered.status.availability).toBe('active')
    expect(memberSection(await memberAssembly(ctx, member))?.text).toBe('Second paragraph.')
  })

  it('drops a section for its Member only, flags prose-only sections, and restores on toggle-off', async () => {
    useAdapter(new EmptyAdapter())
    const { ctx, workspaceId } = shared
    const member = await addMember(ctx, workspaceId, 't6-drop', 'Always answer in Chinese.')
    const sibling = await addMember(ctx, workspaceId, 't6-sibling')
    const before = await ctx.agentTeam.memberPromptView({ memberId: member.memberId })
    const identity = before.sections!.find(section => section.name === 'harness:identity')
    expect(identity).toBeDefined()
    expect(identity!.dropped).toBe(false)
    expect(identity!.isProtected).toBe(false)
    expect(identity!.chars).toBeGreaterThan(0)
    // The custom paragraph maps to no current tool name: prose-only.
    expect(before.sections!.find(section => section.name === MEMBER_PROMPT_SECTION_NAME)?.proseOnly).toBe(true)

    const edited = await ctx.agentTeam.updateMember({
      requestId: requestId('drop'), memberId: member.memberId, handle: member.handle, description: 'Prompt member',
      prompt: { customPrompt: 'Always answer in Chinese.', droppedSections: ['harness:identity'] },
    })
    expect(edited.status.member.prompt).toEqual({ customPrompt: 'Always answer in Chinese.', droppedSections: ['harness:identity'] })
    // The scoped listener filters the Member's turn assemblies; the sibling
    // and a scope-less global assemble keep the section, and the Member's own
    // read-side assembly (the view's shape) still sees it.
    expect(sectionNames(await memberTurnAssembly(ctx, member))).not.toContain('harness:identity')
    expect(sectionNames(await memberTurnAssembly(ctx, sibling))).toContain('harness:identity')
    expect(sectionNames(await ctx.systemPrompt.assemble())).toContain('harness:identity')
    expect(sectionNames(await memberAssembly(ctx, member))).toContain('harness:identity')
    // The paragraph rode along untouched.
    expect(memberSection(await memberAssembly(ctx, member))?.text).toBe('Always answer in Chinese.')
    // The view read reflects the drop; the sibling's read carries none.
    const after = await ctx.agentTeam.memberPromptView({ memberId: member.memberId })
    expect(after.sections!.find(section => section.name === 'harness:identity')?.dropped).toBe(true)
    const siblingView = await ctx.agentTeam.memberPromptView({ memberId: sibling.memberId })
    expect(siblingView.sections!.find(section => section.name === 'harness:identity')?.dropped).toBe(false)

    // Toggling back on restores the section and stores an absent drop field.
    const restored = await ctx.agentTeam.updateMember({
      requestId: requestId('undrop'), memberId: member.memberId, handle: member.handle, description: 'Prompt member',
      prompt: { customPrompt: 'Always answer in Chinese.' },
    })
    expect(restored.status.member.prompt).toEqual({ customPrompt: 'Always answer in Chinese.' })
    expect(sectionNames(await memberAssembly(ctx, member))).toContain('harness:identity')
  })

  it('refuses protected drops at consumption and marks them protected in the view', async () => {
    useAdapter(new EmptyAdapter())
    const { ctx, workspaceId } = shared
    const member = await addMember(ctx, workspaceId, 't7-protect', 'Own paragraph.')
    // Ledger validation only rejects blank names, so a stale ledger can carry
    // protected names; the listener must still not drop them.
    await ctx.agentTeam.updateMember({
      requestId: requestId('protect'), memberId: member.memberId, handle: member.handle, description: 'Prompt member',
      prompt: { customPrompt: 'Own paragraph.', droppedSections: ['deployment:persona-prefix', 'harness:identity', MEMBER_PROMPT_SECTION_NAME, 'tool:team_inbox'] },
    })
    const names = sectionNames(await memberTurnAssembly(ctx, member))
    expect(names).toContain('deployment:persona-prefix')
    expect(names).toContain(MEMBER_PROMPT_SECTION_NAME)
    expect(names).not.toContain('harness:identity')
    const view = await ctx.agentTeam.memberPromptView({ memberId: member.memberId })
    const persona = view.sections!.find(section => section.name === 'deployment:persona-prefix')
    expect(persona?.isProtected).toBe(true)
    expect(persona?.dropped).toBe(false)
    const paragraph = view.sections!.find(section => section.name === MEMBER_PROMPT_SECTION_NAME)
    expect(paragraph?.isProtected).toBe(true)
    expect(paragraph?.dropped).toBe(false)
    // The unprotected request still dropped.
    expect(view.sections!.find(section => section.name === 'harness:identity')?.dropped).toBe(true)
  })

  it('keeps stale drop names inert beside the live section list', async () => {
    useAdapter(new EmptyAdapter())
    const { ctx, workspaceId } = shared
    const member = await addMember(ctx, workspaceId, 't8-stale')
    await ctx.agentTeam.updateMember({
      requestId: requestId('stale-name'), memberId: member.memberId, handle: member.handle, description: 'Prompt member',
      prompt: { droppedSections: ['harness:identity', 'gone-section'] },
    })
    expect(sectionNames(await memberTurnAssembly(ctx, member))).not.toContain('harness:identity')
    const view = await ctx.agentTeam.memberPromptView({ memberId: member.memberId })
    const gone = view.sections!.find(section => section.name === 'gone-section')
    expect(gone?.stale).toBe(true)
    expect(gone?.dropped).toBe(true)
    expect(gone?.chars).toBeUndefined()
    // The live entry is a normal drop, not a stale one.
    const identity = view.sections!.find(section => section.name === 'harness:identity')
    expect(identity?.dropped).toBe(true)
    expect(identity?.stale).toBe(false)
    expect(identity?.chars).toBeGreaterThan(0)
  })

  it('replays the drop list from the ledger across a suspend/resume cycle', async () => {
    useAdapter(new EmptyAdapter())
    const { ctx, workspaceId } = shared
    const member = await addMember(ctx, workspaceId, 't9-replay')
    await ctx.agentTeam.updateMember({
      requestId: requestId('drop-replay'), memberId: member.memberId, handle: member.handle, description: 'Prompt member',
      prompt: { droppedSections: ['harness:identity'] },
    })
    expect(sectionNames(await memberTurnAssembly(ctx, member))).not.toContain('harness:identity')
    // The restart path: the re-activation that backs a resume re-applies the
    // stored drop list from ledger replay.
    await ctx.agentTeam.suspendMember({ requestId: requestId('suspend-replay'), memberId: member.memberId })
    const resumed = await ctx.agentTeam.resumeMember({ requestId: requestId('resume-replay'), memberId: member.memberId })
    expect(resumed.status.availability).toBe('active')
    expect(resumed.status.member.sessionId).toBe(member.sessionId)
    expect(sectionNames(await memberTurnAssembly(ctx, member))).not.toContain('harness:identity')
  })

  it('swaps the drop list at the turn boundary in the same Session', async () => {
    const adapter = new GatedAdapter()
    useAdapter(adapter)
    const { ctx, workspaceId } = shared
    const member = await addMember(ctx, workspaceId, 't10-boundary', 'First paragraph.')
    const agent = liveAgent(ctx, member)

    const running = waitForRunning(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run' }], source: { kind: 'user' } }))
    await running
    const edit = ctx.agentTeam.updateMember({
      requestId: requestId('drop-wait'), memberId: member.memberId, handle: member.handle, description: 'Prompt member',
      prompt: { customPrompt: 'First paragraph.', droppedSections: ['harness:identity'] },
    })
    const raced = await Promise.race([edit.then(() => 'settled'), new Promise<string>(resolve => { setTimeout(() => resolve('pending'), 50) })])
    expect(raced).toBe('pending')
    // The running turn's next assembly still carries the section.
    expect(sectionNames(await memberTurnAssembly(ctx, member))).toContain('harness:identity')

    adapter.enqueue(closingReply('done'))
    adapter.release()
    const settled = await edit
    expect(settled.status.member.sessionId).toBe(member.sessionId)
    expect(sectionNames(await memberTurnAssembly(ctx, member))).not.toContain('harness:identity')
    expect(memberSection(await memberAssembly(ctx, member))?.text).toBe('First paragraph.')
  })

  it('maps section text to mentioned tools whole-word for the prose-only mark', () => {
    const mapping = sectionToolMapping([
      { name: 'mentions', text: 'use team_inbox to triage arrivals' },
      { name: 'glued', text: 'the container team_inboxx is not a mention' },
      { name: 'prose', text: 'plain prose names nothing' },
    ], ['team_inbox'])
    expect(mapping.get('mentions')).toEqual(['team_inbox'])
    expect(mapping.get('glued')).toEqual([])
    expect(mapping.get('prose')).toEqual([])
  })
})

/**
 * Poll until the probe observes its value or the deadline passes — the sweep
 * is a fire-and-forget background body, so tests observe its effects.
 */
async function until<T>(probe: () => T | undefined, label: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`not observed before deadline: ${label}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

function probeInbox(ctx: Context, workspaceId: WorkspaceId, channelRef: AgentTeamChannelRef, prefix: string): AgentTeamInboxItem | undefined {
  // Channel-scoped: the shared ledger never forgets, so an unscoped Human
  // inbox probe would match earlier tests' notices.
  return ctx.agentTeam.inbox({ workspaceId }).items.find(item => item.channelRef === channelRef && item.previewText?.startsWith(prefix))
}

/** One Human task start that @mentions the Member — the atomic-start boundary the sweep rides. */
async function startTaskFor(ctx: Context, workspaceId: WorkspaceId, channelRef: AgentTeamChannelRef, label: string, handle: string): Promise<void> {
  await ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId(label), workspaceId, channelRef, body: `@${handle} please look into this` })
}

describe('Agent Team member section usage and auto-prune', () => {
  it('projects per-section usage numbers and candidates on the view without auto-pruning by default', async () => {
    useAdapter(new EmptyAdapter())
    const { ctx, workspaceId } = shared
    const member = await addMember(ctx, workspaceId, 'u1-view')
    const view = await ctx.agentTeam.memberPromptView({ memberId: member.memberId })
    // Every live section carries its in-window count; zero mapped calls with
    // no prose mark is the long-unused shape, but the switch-off default
    // exposes no candidate list and never prunes.
    const mapped = view.sections!.find(section => section.name === 'usage:mapped')
    expect(mapped?.usage).toBe(0)
    expect(mapped?.proseOnly).toBe(false)
    expect(view.sections!.find(section => section.name === 'usage:prose')?.proseOnly).toBe(true)
    expect(view.pruneCandidates).toBeUndefined()
    expect(view.usagePartial).toBeUndefined()
    expect(view.prompt).toBeUndefined()
  })

  it('ask mode: the task-start sweep posts the inbox notice and leaves the drop to Human confirmation', async () => {
    useAdapter(new EmptyAdapter())
    const { ctx, workspaceId } = shared
    const member = await addMember(ctx, workspaceId, 'u2-ask')
    await ctx.agentTeam.updateMember({
      requestId: requestId('u2-opt-in'), memberId: member.memberId, handle: member.handle, description: 'Prompt member',
      prompt: { autoPrune: true },
    })
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('u2-channel'), workspaceId, name: 'usage-ask', description: 'Ask mode', memberIds: [member.memberId] })
    const before = await ctx.agentTeam.memberPromptView({ memberId: member.memberId })
    expect(before.pruneCandidates).toEqual(['usage:mapped'])

    await startTaskFor(ctx, workspaceId, channel.channel.channelRef, 'u2-start', member.handle)
    const notice = await until(() => probeInbox(ctx, workspaceId, channel.channel.channelRef, 'Auto-prune notice:'), 'ask-mode notice')
    expect(notice.channelRef).toBe(channel.channel.channelRef)
    // The sweep asked; the ledger stayed untouched.
    const unchanged = await ctx.agentTeam.memberPromptView({ memberId: member.memberId })
    expect(unchanged.prompt).toEqual({ autoPrune: true })
    expect(sectionNames(await memberTurnAssembly(ctx, member))).toContain('usage:mapped')

    // The Human confirmation commits the drop through the same durable edit.
    await ctx.agentTeam.updateMember({
      requestId: requestId('u2-confirm'), memberId: member.memberId, handle: member.handle, description: 'Prompt member',
      prompt: { autoPrune: true, droppedSections: ['usage:mapped'] },
    })
    expect(sectionNames(await memberTurnAssembly(ctx, member))).not.toContain('usage:mapped')
    expect(sectionNames(await memberTurnAssembly(ctx, member))).toContain('usage:prose')
  })

  it('full-auto mode: the upgrade commits the drop, live-applies it, and still announces', async () => {
    useAdapter(new EmptyAdapter())
    const { ctx, workspaceId } = shared
    const member = await addMember(ctx, workspaceId, 'u3-full')
    await ctx.agentTeam.updateMember({
      requestId: requestId('u3-opt-in'), memberId: member.memberId, handle: member.handle, description: 'Prompt member',
      prompt: { autoPrune: true, autoExecutePrune: true },
    })
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('u3-channel'), workspaceId, name: 'usage-full', description: 'Full auto', memberIds: [member.memberId] })

    await startTaskFor(ctx, workspaceId, channel.channel.channelRef, 'u3-start', member.handle)
    await until(() => probeInbox(ctx, workspaceId, channel.channel.channelRef, 'Auto-prune executed:'), 'full-auto notice')
    const view = await ctx.agentTeam.memberPromptView({ memberId: member.memberId })
    expect(view.prompt).toEqual({ autoPrune: true, autoExecutePrune: true, droppedSections: ['usage:mapped'] })
    expect(sectionNames(await memberTurnAssembly(ctx, member))).not.toContain('usage:mapped')
    expect(sectionNames(await memberTurnAssembly(ctx, member))).toContain('usage:prose')
  })

  it('the switch-off default never sweeps, though the view still shows the numbers', async () => {
    useAdapter(new EmptyAdapter())
    const { ctx, workspaceId } = shared
    const member = await addMember(ctx, workspaceId, 'u4-off')
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('u4-channel'), workspaceId, name: 'usage-off', description: 'Switch off', memberIds: [member.memberId] })

    await startTaskFor(ctx, workspaceId, channel.channel.channelRef, 'u4-start', member.handle)
    // The sweep (if any) is quick; a grace wait bounds the negative assertion.
    await new Promise(resolve => setTimeout(resolve, 1500))
    expect(probeInbox(ctx, workspaceId, channel.channel.channelRef, 'Auto-prune')).toBeUndefined()
    const after = await ctx.agentTeam.memberPromptView({ memberId: member.memberId })
    expect(after.prompt).toBeUndefined()
    expect(sectionNames(await memberTurnAssembly(ctx, member))).toContain('usage:mapped')
  })

  it('counts the member\'s mapped tool calls into the view and out of the candidates', async () => {
    const adapter = new GatedAdapter()
    useAdapter(adapter)
    const { ctx, workspaceId } = shared
    const member = await addMember(ctx, workspaceId, 'u6-count')
    const agent = liveAgent(ctx, member)

    // One held turn that calls ordinary_tool — the section's mapped tool.
    const idle = waitForIdle(ctx, agent)
    const running = waitForRunning(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run' }], source: { kind: 'user' } }))
    await running
    adapter.enqueue(closingReply('done'))
    adapter.release()
    await idle

    const view = await ctx.agentTeam.memberPromptView({ memberId: member.memberId })
    expect(view.sections!.find(section => section.name === 'usage:mapped')?.usage).toBe(1)
    expect(view.sections!.find(section => section.name === 'usage:prose')?.usage).toBe(0)
    expect(view.pruneCandidates).toBeUndefined()
  })

  it('a partial usage fold degrades the view and downgrades full-auto to ask', async () => {
    useAdapter(new EmptyAdapter())
    const { ctx, workspaceId } = shared
    const member = await addMember(ctx, workspaceId, 'u5-partial')
    await ctx.agentTeam.updateMember({
      requestId: requestId('u5-opt-in'), memberId: member.memberId, handle: member.handle, description: 'Prompt member',
      prompt: { autoPrune: true, autoExecutePrune: true },
    })
    // Build a lineage: the Human context reset parents the new generation at
    // the archived one, so the fold has an ancestor to read.
    await ctx.agentTeam.clearMemberContext({ requestId: requestId('u5-reset'), workspaceId, memberId: member.memberId })

    // Unreadable archives: the fold degrades instead of guessing. The reader
    // is an instance field, so the patch shadows the prototype method and the
    // restore hands the walk back to the real stored-session read.
    const reader = (ctx.agentTeam as unknown as { sessionReader: { read: (sessionId: SessionId) => Promise<unknown> } }).sessionReader
    const original = reader.read
    reader.read = async () => ({ ok: false })
    try {
      const view = await ctx.agentTeam.memberPromptView({ memberId: member.memberId })
      expect(view.usagePartial).toBe(true)
      expect(view.pruneCandidates).toEqual(['usage:mapped'])

      // The full-auto trigger runs, but the partial fold downgrades it to ask
      // mode: unreadable history can only under-count, so it never drives an
      // automatic drop.
      const channel = await ctx.agentTeam.createChannel({ requestId: requestId('u5-channel'), workspaceId, name: 'usage-partial', description: 'Partial', memberIds: [member.memberId] })
      await startTaskFor(ctx, workspaceId, channel.channel.channelRef, 'u5-start', member.handle)
      await until(() => probeInbox(ctx, workspaceId, channel.channel.channelRef, 'Auto-prune notice:'), 'degraded ask-mode notice')
      const after = await ctx.agentTeam.memberPromptView({ memberId: member.memberId })
      expect(after.prompt).toEqual({ autoPrune: true, autoExecutePrune: true })
      expect(after.usagePartial).toBe(true)
    } finally {
      reader.read = original
    }
  })
})

describe('Agent Team member prompt LLM curation', () => {
  it('builds one bounded call from the live assembly and returns a re-validated, propose-only draft', async () => {
    const adapter = new ScriptedAdapter()
    useAdapter(adapter)
    const { ctx, workspaceId } = shared
    const member = await addMember(ctx, workspaceId, 'c1-live', 'Stored paragraph.')
    adapter.enqueue(closingReply(JSON.stringify({
      droppedSectionNames: ['usage:prose', 'team:member-prompt', 'hallucinated:section'],
      skillsAllow: ['member-memory-manager', 'not-a-skill', 'member-memory-manager'],
      customPrompt: '  Curated paragraph.  ',
      ignoreMe: 42,
    })))

    const result = await ctx.agentTeam.curateMemberPrompt({ memberId: member.memberId, requirements: 'Focus on code review.' })
    // No per-Member pin here, so the effective route is the harness default —
    // the same route the one-shot call must have used.
    expect(result.modelUsed).toEqual({ provider: 'mock', model: 'mock' })
    // Host-side re-validation: protected and hallucinated section names never
    // reach the dialog, off-catalog skills are dropped, the paragraph trims,
    // and unknown reply fields vanish.
    expect(result.proposal).toEqual({
      droppedSectionNames: ['usage:prose'],
      skillsAllow: ['member-memory-manager'],
      customPrompt: 'Curated paragraph.',
    })

    expect(adapter.requests).toHaveLength(1)
    const request = adapter.requests[0]!
    expect(request.provider).toBe('mock')
    expect(request.model).toBe('mock')
    expect(request.maxTokens).toBe(CURATE_MAX_TOKENS)
    expect(request.system).toContain('propose edits only')
    const userText = (request.messages[0]!.content[0] as { readonly text: string }).text
    expect(userText).toContain('Member handle: c1-live')
    expect(userText).toContain('Member description: Prompt member')
    expect(userText).toContain('Current custom role paragraph: Stored paragraph.')
    expect(userText).toContain('usage:mapped')
    expect(userText).toContain('usage:prose (prose-only: maps no tool)')
    expect(userText).toContain('team:member-prompt (protected — never propose dropping)')
    expect(userText).toContain('member-memory-manager')
    expect(userText).toContain('member-skill-manager')
    expect(userText).toContain('Human requirements:')
    expect(userText).toContain('Focus on code review.')

    // Propose-only: the stored prompt survives the curation call untouched.
    const view = await ctx.agentTeam.memberPromptView({ memberId: member.memberId })
    expect(view.prompt).toEqual({ customPrompt: 'Stored paragraph.' })
  })

  it('surfaces a malformed reply as an error instead of a partial proposal', async () => {
    const adapter = new ScriptedAdapter()
    useAdapter(adapter)
    const { ctx, workspaceId } = shared
    const member = await addMember(ctx, workspaceId, 'c2-garbage')
    adapter.enqueue(closingReply('The curated prompt would be shorter, but there is no JSON today.'))
    await expect(ctx.agentTeam.curateMemberPrompt({ memberId: member.memberId, requirements: 'trim it' }))
      .rejects.toThrow('no JSON object')
    // The failed pass left no trace on the stored profile.
    const view = await ctx.agentTeam.memberPromptView({ memberId: member.memberId })
    expect(view.prompt).toBeUndefined()
  })

  it('never returns a proposal once the caller cancelled, even when the stream completed', async () => {
    const adapter = new ScriptedAdapter()
    useAdapter(adapter)
    const { ctx, workspaceId } = shared
    const member = await addMember(ctx, workspaceId, 'c3-cancel')
    adapter.enqueue(closingReply(JSON.stringify({ customPrompt: 'Too late.' })))
    const controller = new AbortController()
    controller.abort()
    await expect(ctx.agentTeam.curateMemberPrompt({ memberId: member.memberId, requirements: 'trim it' }, controller.signal))
      .rejects.toThrow('cancelled or timed out')
  })

  it('refuses a non-enabled Member before any model call', async () => {
    const adapter = new ScriptedAdapter()
    useAdapter(adapter)
    const { ctx, workspaceId } = shared
    const member = await addMember(ctx, workspaceId, 'c4-suspended')
    await ctx.agentTeam.suspendMember({ requestId: requestId('c4-suspend'), memberId: member.memberId })
    await expect(ctx.agentTeam.curateMemberPrompt({ memberId: member.memberId, requirements: 'trim it' }))
      .rejects.toThrow('only enabled Members can curate')
    expect(adapter.requests).toHaveLength(0)
  })

  it('propagates a mid-call adapter failure as the curation error', async () => {
    const adapter = new ScriptedAdapter()
    useAdapter(adapter)
    const { ctx, workspaceId } = shared
    const member = await addMember(ctx, workspaceId, 'c5-stream-fail')
    // No enqueued response: the adapter throws while streaming.
    await expect(ctx.agentTeam.curateMemberPrompt({ memberId: member.memberId, requirements: 'trim it' }))
      .rejects.toThrow('response queue is empty')
  })
})

describe('member prompt curation input and parsing', () => {
  it('caps the bounded input pieces and renders absent facts as explicit none markers', () => {
    const longText = 'x'.repeat(2000)
    const { system, messages } = buildCurateMessages({
      handle: 'builder',
      description: 'Builds changes',
      skills: [],
      sections: [{ name: 'section:long', text: longText, isProtected: false, proseOnly: true }],
      requirements: 'y'.repeat(5000),
    })
    expect(system).toContain('propose edits only')
    expect(system).toContain('"droppedSectionNames"')
    const userText = (messages[0]!.content[0] as { readonly text: string }).text
    expect(userText).toContain('Current custom role paragraph: (none)')
    expect(userText).toContain('Private skills catalog (names only): (none)')
    // Both caps bite exactly: the truncation ellipsis, never the full text.
    expect(userText).toContain(`text: ${'x'.repeat(CURATE_SECTION_TEXT_CAP)}…`)
    expect(userText).not.toContain('x'.repeat(CURATE_SECTION_TEXT_CAP + 1))
    expect(userText).toContain(`${'y'.repeat(CURATE_REQUIREMENTS_CAP)}…`)
    expect(userText).not.toContain('y'.repeat(CURATE_REQUIREMENTS_CAP + 1))
  })

  it('parses a fenced reply, dedupes and sorts the name lists, and filters protected drops', () => {
    const fenced = '```json\n' + JSON.stringify({
      droppedSectionNames: ['b:section', 'team:member-prompt', 'a:section', 'b:section'],
      skillsAllow: ['z-skill', 'a-skill'],
      customPrompt: '  Kept.  ',
    }) + '\n```'
    expect(parseCurateProposal(fenced, isProtectedPromptSection)).toEqual({
      droppedSectionNames: ['a:section', 'b:section'],
      skillsAllow: ['a-skill', 'z-skill'],
      customPrompt: 'Kept.',
    })
  })

  it('keeps every list field absent when the reply is empty, and fails loudly on the contract breaks', () => {
    expect(parseCurateProposal('{}', isProtectedPromptSection)).toEqual({})
    expect(parseCurateProposal('{"droppedSectionNames": [], "skillsAllow": ["  "], "customPrompt": "   "}', isProtectedPromptSection)).toEqual({})
    // The parse function runs eagerly, so the failure cases pass thunks.
    expect(() => parseCurateProposal('no object', isProtectedPromptSection)).toThrowError(/no JSON object/)
    expect(() => parseCurateProposal('{not json}', isProtectedPromptSection)).toThrowError(/not valid JSON/)
    expect(() => parseCurateProposal('{"customPrompt": 42}', isProtectedPromptSection)).toThrowError(/customPrompt is not a string/)
    const oversized = JSON.stringify({ customPrompt: '长'.repeat(3000) })
    expect(() => parseCurateProposal(oversized, isProtectedPromptSection)).toThrowError(/exceeds the 8192-byte limit/)
    // A wrong-typed list field drops instead of failing — the model is
    // unreliable, the dialog stays safe.
    expect(parseCurateProposal('{"droppedSectionNames": "everything", "skillsAllow": 7}', isProtectedPromptSection)).toEqual({})
  })

  it('filters deployment persona drops too — any protected name dies at parse time', () => {
    const parsed = parseCurateProposal(
      JSON.stringify({ droppedSectionNames: ['deployment:persona-coder', 'usage:prose'] }),
      isProtectedPromptSection,
    )
    expect(parsed.droppedSectionNames).toEqual(['usage:prose'])
  })
})
