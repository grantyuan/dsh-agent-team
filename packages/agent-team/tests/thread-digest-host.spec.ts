import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
// Same whole-Host harness budget as the other booting specs (member-prompt.spec.ts).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import AgentTeam from '../src/index.ts'
import { DIGEST_SYSTEM_PREFIX } from '../src/thread-digest.ts'
import type { AgentTeamMemberId, AgentTeamModelSelection, AgentTeamRequestId, AgentTeamThreadRef } from '../src/types.ts'
import { MemoryStorageBackend } from './helpers/memory-backend.ts'

const sharedCleanups: Array<() => Promise<void>> = []
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

/** Quiet stand-in for member activations: streams nothing. */
class QuietAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string) { return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 320_000 } }) }
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> { yield* [] }
}

/**
 * Answers only the digest seam (identified by the digest system prefix) with a
 * fixed JSON reply; every other stream (member activations) stays quiet. The
 * recorded digest requests are what the routing assertions read.
 */
class DigestRoutingAdapter extends QuietAdapter {
  readonly digestRequests: GenerateOptions[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (!(options.system ?? '').startsWith(DIGEST_SYSTEM_PREFIX)) return
    this.digestRequests.push(options)
    const text = JSON.stringify({ summary: '团队讨论了发布方案。', keyPoints: ['方案A：直接发布', '方案B：灰度发布'], needsHumanDecision: false })
    yield* [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text },
      { type: 'block-end', index: 0, block: { type: 'text', text } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
  }
}

async function buildSharedHarness(): Promise<{
  readonly ctx: Context
  readonly adapter: DigestRoutingAdapter
}> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-agent-team-digest-host-'))
  const project = join(root, 'project')
  const persistence = join(root, 'sessions')
  await Promise.all([mkdir(project), mkdir(persistence)])
  process.env.DSH_HOME = join(root, 'dsh-home')
  const adapter = new DigestRoutingAdapter()
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(resolve(import.meta.dirname, '../../../')).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.group = Group
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['mock'], adapter)
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
  await ctx.plugin(AgentPreset, {
    id: 'team-member',
    plugins: [
      { id: 'member-context', name: '@wowyuarm/dsh-agent-team/member-context' },
      { id: 'team-tools', name: pathToFileURL(join(import.meta.dirname, 'helpers', 'team-tools-fixture.mjs')).href },
    ],
  })
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  // Every workspace id in this file resolves to the same throwaway project, so
  // each test can hold its own Team roster in its own ledger-visible workspace.
  ctx.provide('workspaceRegistry', {
    get: (id: WorkspaceId) => ({ id, path: project, attachSession: async () => {} }),
    list: () => [],
    archiveSession: async () => {},
  })
  await ctx.plugin(AgentTeam)
  sharedCleanups.push(async () => { await ctx.fiber.dispose(); await facility.closeAll(); await rm(root, { recursive: true, force: true }) })
  return { ctx, adapter }
}

let shared: Awaited<ReturnType<typeof buildSharedHarness>>

beforeAll(async () => {
  shared = await buildSharedHarness()
})

async function addMember(ctx: Context, workspaceId: WorkspaceId, handle: string, model?: AgentTeamModelSelection): Promise<AgentTeamMemberId> {
  const added = await ctx.agentTeam.addMember({
    requestId: requestId(`add-${handle}`), workspaceId, handle, description: 'Digest routing member',
    presetId: 'team-member', channelRefs: [], ...(model === undefined ? {} : { model }),
  })
  expect(added.status.availability, JSON.stringify(added.status)).toBe('active')
  return added.status.member.memberId
}

async function designateLeader(ctx: Context, workspaceId: WorkspaceId, memberId: AgentTeamMemberId, handle: string, model?: AgentTeamModelSelection): Promise<void> {
  const updated = await ctx.agentTeam.updateMember({
    requestId: requestId(`leader-${handle}`), memberId, handle, description: 'Digest routing member',
    ...(model === undefined ? {} : { model }), leader: true,
  })
  expect(updated.status.member.leader, JSON.stringify(updated.status)).toBe(true)
}

/** One taskless thread with a single Human anchor message; returns its ref. */
async function makeThread(ctx: Context, workspaceId: WorkspaceId, name: string): Promise<AgentTeamThreadRef> {
  const channel = await ctx.agentTeam.createChannel({ requestId: requestId(`${name}-channel`), workspaceId, name, description: 'Digest routing', memberIds: [] })
  const sent = await ctx.agentTeam.sendMessage({ asTask: false, requestId: requestId(`${name}-send`), workspaceId, channelRef: channel.channel.channelRef, body: '发布方案需要讨论出结论' })
  expect(sent.kind, JSON.stringify(sent)).toBe('committed')
  if (sent.kind !== 'committed') throw new Error('unreachable')
  return sent.thread.threadRef
}

describe('Agent Team digest model routing', () => {
  // Isolation invariant: the shared ledger never forgets; each test owns a
  // unique workspace so leader designations never leak between tests.
  it('runs the digest on the designated leader pinned model', async () => {
    const { ctx, adapter } = shared
    const workspaceId = WorkspaceId('workspace:digest-route-leader')
    const leaderId = await addMember(ctx, workspaceId, 'digest-leader-pinned', { provider: 'mock', model: 'leader-model' })
    await designateLeader(ctx, workspaceId, leaderId, 'digest-leader-pinned', { provider: 'mock', model: 'leader-model' })
    await addMember(ctx, workspaceId, 'digest-worker-other', { provider: 'mock', model: 'worker-model' })
    const threadRef = await makeThread(ctx, workspaceId, 'digest-route-leader')

    const result = await ctx.agentTeam.summarizeThread({ workspaceId, threadRef })
    expect(result.modelUsed).toMatchObject({ provider: 'mock', model: 'leader-model' })
    const request = adapter.digestRequests.at(-1)
    expect(request?.provider).toBe('mock')
    expect(request?.model).toBe('leader-model')
    // The one-shot carries nothing beyond the digest instruction and the
    // transcript: no tools, skills, MCP, memory or Session identity rides in.
    expect(request?.tools).toBeUndefined()
    expect(request?.sessionId).toBeUndefined()
    expect(request?.messages).toHaveLength(1)
    expect(result.digest.summary).toContain('发布方案')
  })

  it('falls back to the Host default when the designated leader pins no model', async () => {
    const { ctx, adapter } = shared
    const workspaceId = WorkspaceId('workspace:digest-route-leader-default')
    const leaderId = await addMember(ctx, workspaceId, 'digest-leader-unpinned')
    await designateLeader(ctx, workspaceId, leaderId, 'digest-leader-unpinned')
    await addMember(ctx, workspaceId, 'digest-worker-pinned-x', { provider: 'mock', model: 'worker-x' })
    const threadRef = await makeThread(ctx, workspaceId, 'digest-route-leader-default')

    const result = await ctx.agentTeam.summarizeThread({ workspaceId, threadRef })
    expect(result.modelUsed).toMatchObject({ provider: 'mock', model: 'mock' })
    expect(adapter.digestRequests.at(-1)?.model).toBe('mock')
  })

  it('uses any member pinned model when no leader is designated', async () => {
    const { ctx, adapter } = shared
    const workspaceId = WorkspaceId('workspace:digest-route-no-leader')
    await addMember(ctx, workspaceId, 'digest-plain-first')
    await addMember(ctx, workspaceId, 'digest-plain-pinned', { provider: 'mock', model: 'team-member-model' })
    const threadRef = await makeThread(ctx, workspaceId, 'digest-route-no-leader')

    const result = await ctx.agentTeam.summarizeThread({ workspaceId, threadRef })
    expect(result.modelUsed).toMatchObject({ provider: 'mock', model: 'team-member-model' })
    expect(adapter.digestRequests.at(-1)?.model).toBe('team-member-model')
  })

  it('reaches the Host default only when nobody in the Team pinned a model', async () => {
    const { ctx, adapter } = shared
    const workspaceId = WorkspaceId('workspace:digest-route-all-default')
    await addMember(ctx, workspaceId, 'digest-bare-member')
    const threadRef = await makeThread(ctx, workspaceId, 'digest-route-all-default')

    const result = await ctx.agentTeam.summarizeThread({ workspaceId, threadRef })
    expect(result.modelUsed).toMatchObject({ provider: 'mock', model: 'mock' })
    expect(adapter.digestRequests.at(-1)?.model).toBe('mock')
  })
})
