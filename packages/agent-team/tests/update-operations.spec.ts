import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import Storage from '@deepseek-ai/dsh-storage'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import AgentTeam from '../src/index.ts'
import { AgentTeamLedger } from '../src/ledger.ts'
import { agentTeamDomainSpec } from '../src/spec.ts'
import * as agentTeamInvariant from '../src/invariant.ts'
import type { AgentTeamChannelRef, AgentTeamOperation, AgentTeamOperationId, AgentTeamRequestId } from '../src/types.ts'

const cleanups: Array<() => Promise<void>> = []
const alpha = WorkspaceId('workspace:alpha')
const requestId = (value: string): AgentTeamRequestId => value as AgentTeamRequestId

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

async function harness(pool = new MemoryMediaPool()): Promise<{ readonly ctx: Context; readonly facility: DomainFacility }> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  ctx.provide('workspaceRegistry', {
    get: (id: WorkspaceId) => id === alpha ? { id, path: process.cwd(), attachSession: async () => {}, archiveSession: async () => {} } : undefined,
    list: () => [{ id: alpha, path: process.cwd() }],
    archiveSession: async () => {},
  })
  ctx.provide('agents', { create: async () => { throw new Error('unused') }, resume: async () => { throw new Error('unused') } })
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) })
  ctx.provide('agentPresets', { mount: async () => { throw new Error('unused') } })
  ctx.provide('tools', { schemas: () => [] })
  ctx.provide('sessionPersistence', { list: async () => [] })
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(agentTeamInvariant)
  await ctx.plugin(SessionProjectionRegistry)
  const fiber = await ctx.plugin(AgentTeam)
  cleanups.push(async () => { await fiber.dispose(); await facility.closeAll() })
  return { ctx, facility }
}

/** A cold ledger over the same table: sequential-replay validation must accept the update records. */
function replayLedger(facility: DomainFacility): AgentTeamLedger {
  return new AgentTeamLedger(facility.get('agent_team')!.table('operations') as unknown as KvTable<AgentTeamOperationId, AgentTeamOperation>)
}

/** A media pool preloaded with stored operations, standing in for Host restart. */
function storedPool(records: Array<[string, unknown]>): MemoryMediaPool {
  const pool = new MemoryMediaPool()
  pool.versions.set('agent_team', agentTeamDomainSpec.version)
  pool.media.set('agent_team', { tables: new Map([['operations', new Map(records)]]), global: null })
  return pool
}

async function seedMember(ctx: Context, channelRef: AgentTeamChannelRef, label: string) {
  return ctx.agentTeam.addMember({
    requestId: requestId(`${label}-add`), workspaceId: alpha,
    handle: label, description: `${label} member`, presetId: 'team-member',
    channelRefs: [channelRef],
  })
}

describe('Agent Team display-fact updates', () => {
  it('renames a Channel durably, resolves retries by request id, and replays cleanly', async () => {
    const { ctx, facility } = await harness()
    const created = await ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })

    // The rename keeps the Channel's immutable identity facts intact.
    const renamed = await ctx.agentTeam.updateChannel({ requestId: requestId('rename'), workspaceId: alpha, channelRef: created.channel.channelRef, name: 'platform', description: 'Infrastructure work' })
    expect(renamed.channel.name).toBe('platform')
    expect(renamed.channel.description).toBe('Infrastructure work')
    expect(renamed.channel.channelRef).toBe(created.channel.channelRef)
    expect(renamed.channel.createdAtSequence).toBe(created.channel.createdAtSequence)

    // Same request id with the same payload resolves without a second record;
    // reusing it with different content collides loudly instead.
    const retried = await ctx.agentTeam.updateChannel({ requestId: requestId('rename'), workspaceId: alpha, channelRef: created.channel.channelRef, name: 'platform', description: 'Infrastructure work' })
    expect(retried.channel.name).toBe('platform')
    await expect(ctx.agentTeam.updateChannel({ requestId: requestId('rename'), workspaceId: alpha, channelRef: created.channel.channelRef, name: 'other', description: 'Infrastructure work' })).rejects.toThrow(/was reused with a different operation or payload/)

    const view = await ctx.agentTeam.view({ workspaceId: alpha, topLevelOnly: true, limit: 10 })
    expect(view.channels.find(channel => channel.channelRef === created.channel.channelRef)?.name).toBe('platform')

    // A cold replay accepts the update record and reproduces the projection.
    const replayed = replayLedger(facility)
    expect(() => replayed.validate()).not.toThrow()
    const replayView = replayed.view({ workspaceId: alpha, topLevelOnly: true })
    expect(replayView.channels.find(channel => channel.channelRef === created.channel.channelRef)).toMatchObject({ name: 'platform', description: 'Infrastructure work' })

    // Blank display facts and unknown refs are rejected before any record lands;
    // clearing the description is a legal edit, matching optional creation.
    await expect(ctx.agentTeam.updateChannel({ requestId: requestId('blank-name'), workspaceId: alpha, channelRef: created.channel.channelRef, name: '   ', description: 'x' })).rejects.toThrow(/name must not be empty/)
    await expect(ctx.agentTeam.updateChannel({ requestId: requestId('unknown-ref'), workspaceId: alpha, channelRef: 'channel:missing' as AgentTeamChannelRef, name: 'x', description: 'y' })).rejects.toThrow(/unknown Channel ref/)
    const cleared = await ctx.agentTeam.updateChannel({ requestId: requestId('clear-description'), workspaceId: alpha, channelRef: created.channel.channelRef, name: 'platform', description: '' })
    expect(cleared.channel.description).toBe('')
    const replayedCleared = replayLedger(facility)
    expect(() => replayedCleared.validate()).not.toThrow()
    expect(replayedCleared.view({ workspaceId: alpha, topLevelOnly: true }).channels.find(channel => channel.channelRef === created.channel.channelRef)).toMatchObject({ name: 'platform', description: '' })
  })

  it('creates a Channel with an empty description and no initial Members', async () => {
    const { ctx } = await harness()
    const created = await ctx.agentTeam.createChannel({ requestId: requestId('bare-channel'), workspaceId: alpha, name: 'ops', description: '' })
    expect(created.channel.description).toBe('')
    expect(created.memberIds).toEqual([])
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('edits Member facts with handle uniqueness, model pinning, and replay validation', async () => {
    const { ctx, facility } = await harness()
    const created = await ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const builder = await seedMember(ctx, created.channel.channelRef, 'builder')
    const reviewer = await seedMember(ctx, created.channel.channelRef, 'reviewer')

    // One durable edit renames the handle, updates the description, and pins
    // a per-Member model while identity and memory paths stay untouched.
    const edited = await ctx.agentTeam.updateMember({ requestId: requestId('edit-builder'), memberId: builder.status.member.memberId, handle: 'architect', description: 'System design owner', model: { provider: 'mock', model: 'pinned' } })
    expect(edited.status.member.handle).toBe('architect')
    expect(edited.status.member.model).toEqual({ provider: 'mock', model: 'pinned' })
    expect(edited.status.member.presetId).toBe(builder.status.member.presetId)
    expect(edited.status.member.sessionId).toBe(builder.status.member.sessionId)
    expect(edited.status.member.privateMemoryPath).toBe(builder.status.member.privateMemoryPath)

    // Handle uniqueness covers every other live Member, case-insensitively;
    // keeping one's own handle is not a collision.
    await expect(ctx.agentTeam.updateMember({ requestId: requestId('collide'), memberId: reviewer.status.member.memberId, handle: 'ARCHITECT', description: 'x' })).rejects.toThrow(/is already active in Workspace/)
    const kept = await ctx.agentTeam.updateMember({ requestId: requestId('keep-handle'), memberId: builder.status.member.memberId, handle: 'architect', description: 'Designs systems' })
    expect(kept.status.member.description).toBe('Designs systems')

    // An absent model clears any override back to Host-default inheritance.
    const cleared = await ctx.agentTeam.updateMember({ requestId: requestId('clear-model'), memberId: builder.status.member.memberId, handle: 'architect', description: 'Designs systems' })
    expect(cleared.status.member.model).toBeUndefined()

    // Retry semantics mirror every other op: same payload replays, drift collides.
    const retried = await ctx.agentTeam.updateMember({ requestId: requestId('clear-model'), memberId: builder.status.member.memberId, handle: 'architect', description: 'Designs systems' })
    expect(retried.status.member.model).toBeUndefined()
    await expect(ctx.agentTeam.updateMember({ requestId: requestId('clear-model'), memberId: builder.status.member.memberId, handle: 'architect', description: 'Changed after commit' })).rejects.toThrow(/was reused with a different operation or payload/)
    // Clearing the description is a legal edit, matching optional creation.
    const clearedDescription = await ctx.agentTeam.updateMember({ requestId: requestId('clear-description'), memberId: builder.status.member.memberId, handle: 'architect', description: '' })
    expect(clearedDescription.status.member.description).toBe('')

    // A pinned reasoning effort rides the model selection and clears with it.
    const pinned = await ctx.agentTeam.updateMember({ requestId: requestId('pin-effort'), memberId: builder.status.member.memberId, handle: 'architect', description: 'Designs systems', model: { provider: 'mock', model: 'pinned', reasoningEffort: 'high' as ReasoningEffortId } })
    expect(pinned.status.member.model).toEqual({ provider: 'mock', model: 'pinned', reasoningEffort: 'high' })
    // A cold replay must preserve a selected effort; this is the path used by
    // Host restart before any Member can be activated again.
    const replayedWithEffort = replayLedger(facility)
    expect(() => replayedWithEffort.validate()).not.toThrow()
    expect(replayedWithEffort.getMember(builder.status.member.memberId)?.model).toEqual({ provider: 'mock', model: 'pinned', reasoningEffort: 'high' })
    const unpinned = await ctx.agentTeam.updateMember({ requestId: requestId('unpin-effort'), memberId: builder.status.member.memberId, handle: 'architect', description: 'Designs systems' })
    expect(unpinned.status.member.model).toBeUndefined()

    // A removed Member freezes against further edits, including its old handle.
    await ctx.agentTeam.removeMember({ requestId: requestId('remove-reviewer'), memberId: reviewer.status.member.memberId })
    await expect(ctx.agentTeam.updateMember({ requestId: requestId('edit-inactive'), memberId: reviewer.status.member.memberId, handle: 'reviewer2', description: 'x' })).rejects.toThrow(/is inactive and can no longer be edited/)

    const replayed = replayLedger(facility)
    expect(() => replayed.validate()).not.toThrow()
    const stored = replayed.listMembers().find(member => member.memberId === builder.status.member.memberId)
    expect(stored).toMatchObject({ handle: 'architect', description: 'Designs systems' })
    expect(stored?.model).toBeUndefined()
    expect(replayed.listMembers().find(member => member.memberId === reviewer.status.member.memberId)?.state).toBe('inactive')
  })

  it('carries Member capabilities through lifecycle operations, edits, replay, and Host restart', async () => {
    const { ctx, facility } = await harness()
    const created = await ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const capabilities = {
      tools: { allow: ['bash', 'read', 'web-search'] },
      skills: { allow: ['code-review'] },
    } as const
    const added = await ctx.agentTeam.addMember({
      requestId: requestId('capabilities-add'), workspaceId: alpha, handle: 'builder', description: 'Builds changes',
      presetId: 'team-member', channelRefs: [created.channel.channelRef], capabilities,
    })
    const memberId = added.status.member.memberId
    expect(added.status.member.capabilities).toEqual(capabilities)

    // Pure intent: unknown tool names commit anyway (divergence is derived at
    // activation, never rejected here), and the status projection exposes the
    // warnings channel empty while capabilities resolve cleanly.
    const hostile = await ctx.agentTeam.addMember({
      requestId: requestId('drift-add'), workspaceId: alpha, handle: 'drift', description: 'Old ledger entry',
      presetId: 'team-member', channelRefs: [], capabilities: { tools: { allow: ['tool-renamed-away'] } },
    })
    expect(hostile.status.member.capabilities).toEqual({ tools: { allow: ['tool-renamed-away'] } })
    expect(hostile.status.capabilityWarnings).toBeUndefined()

    // Lifecycle operations carry the overlay verbatim: suspend and resume
    // rebuild the entity without dropping or duplicating capabilities.
    const suspended = await ctx.agentTeam.suspendMember({ requestId: requestId('suspend'), memberId })
    expect(suspended.status.member.capabilities).toEqual(capabilities)
    const resumed = await ctx.agentTeam.resumeMember({ requestId: requestId('resume'), memberId })
    expect(resumed.status.member.capabilities).toEqual(capabilities)

    // An edit echoing the stored overlay keeps it; the collision guard
    // compares capabilities like model drift.
    const echoed = await ctx.agentTeam.updateMember({ requestId: requestId('echo'), memberId, handle: 'builder', description: 'Still builds', capabilities })
    expect(echoed.status.member.capabilities).toEqual(capabilities)
    await expect(ctx.agentTeam.updateMember({ requestId: requestId('echo'), memberId, handle: 'builder', description: 'Different after commit', capabilities })).rejects.toThrow(/was reused with a different operation or payload/)

    // Absent capabilities clear the override, mirroring the model semantics;
    // a second update then re-pins a skills-only overlay.
    const cleared = await ctx.agentTeam.updateMember({ requestId: requestId('clear-capabilities'), memberId, handle: 'builder', description: 'Still builds' })
    expect(cleared.status.member.capabilities).toBeUndefined()
    const pinned = await ctx.agentTeam.updateMember({ requestId: requestId('pin-skills'), memberId, handle: 'builder', description: 'Still builds', capabilities: { skills: { allow: ['code-review'] } } })
    expect(pinned.status.member.capabilities).toEqual({ skills: { allow: ['code-review'] } })

    // Whitespace-only allow-list names are rejected before any record lands.
    await expect(ctx.agentTeam.updateMember({ requestId: requestId('blank-name'), memberId, handle: 'builder', description: 'Still builds', capabilities: { skills: { allow: ['   '] } } })).rejects.toThrow(/must not be empty/)

    // Cold replay reproduces the overlay and validates the update records.
    const replayed = replayLedger(facility)
    expect(() => replayed.validate()).not.toThrow()
    expect(replayed.getMember(memberId)?.capabilities).toEqual({ skills: { allow: ['code-review'] } })
    expect(replayed.getMember(hostile.status.member.memberId)?.capabilities).toEqual({ tools: { allow: ['tool-renamed-away'] } })

    // Host restart: a fresh process replays the same ledger and restores the
    // durable intent, warnings channel still absent.
    const records = [...facility.get('agent_team')!.table('operations').entries()] as Array<[string, unknown]>
    const revived = await harness(storedPool(records))
    expect(revived.ctx.agentTeam.status()).toMatchObject({ agentMemberCount: 2 })
    const restored = revived.ctx.agentTeam.membersForClient({ workspaceId: alpha }).find(status => status.member.memberId === memberId)
    expect(restored?.member.capabilities).toEqual({ skills: { allow: ['code-review'] } })
    expect(restored?.capabilityWarnings).toBeUndefined()
    expect(() => replayLedger(revived.facility).validate()).not.toThrow()
  })

  it('carries Member prompt profile and context control through lifecycle operations, edits, replay, and Host restart', async () => {
    const { ctx, facility } = await harness()
    const created = await ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const prompt = { droppedSections: ['skills'], customPrompt: 'Prefer exhaustive test coverage.', autoPrune: true } as const
    const added = await ctx.agentTeam.addMember({
      requestId: requestId('context-add'), workspaceId: alpha, handle: 'builder', description: 'Builds changes',
      presetId: 'team-member', channelRefs: [created.channel.channelRef], prompt, contextStartPolicy: 'fresh', contextWindow: 128_000,
    })
    const memberId = added.status.member.memberId
    expect(added.status.member.prompt).toEqual(prompt)
    expect(added.status.member.contextStartPolicy).toBe('fresh')
    expect(added.status.member.contextWindow).toBe(128_000)

    // Lifecycle operations carry the context facts verbatim, like capabilities.
    const suspended = await ctx.agentTeam.suspendMember({ requestId: requestId('suspend'), memberId })
    expect(suspended.status.member.prompt).toEqual(prompt)
    expect(suspended.status.member.contextStartPolicy).toBe('fresh')
    expect(suspended.status.member.contextWindow).toBe(128_000)
    const resumed = await ctx.agentTeam.resumeMember({ requestId: requestId('resume'), memberId })
    expect(resumed.status.member.contextStartPolicy).toBe('fresh')

    // An edit echoing the stored facts keeps them; the collision guard
    // compares them like model drift.
    const echoed = await ctx.agentTeam.updateMember({ requestId: requestId('echo'), memberId, handle: 'builder', description: 'Still builds', prompt, contextStartPolicy: 'fresh', contextWindow: 128_000 })
    expect(echoed.status.member.contextWindow).toBe(128_000)
    await expect(ctx.agentTeam.updateMember({ requestId: requestId('echo'), memberId, handle: 'builder', description: 'Different after commit', contextWindow: 128_000 })).rejects.toThrow(/was reused with a different operation or payload/)

    // Absent fields clear the overrides, mirroring the model semantics.
    const cleared = await ctx.agentTeam.updateMember({ requestId: requestId('clear'), memberId, handle: 'builder', description: 'Still builds' })
    expect(cleared.status.member.prompt).toBeUndefined()
    expect(cleared.status.member.contextStartPolicy).toBeUndefined()
    expect(cleared.status.member.contextWindow).toBeUndefined()

    // The window override is an integer of at least 8192 tokens.
    for (const invalid of [0, -16_000, 8191, 8192.5]) {
      await expect(ctx.agentTeam.updateMember({ requestId: requestId(`window-${invalid}`), memberId, handle: 'builder', description: 'Still builds', contextWindow: invalid })).rejects.toThrow(/context window/)
    }
    const floor = await ctx.agentTeam.updateMember({ requestId: requestId('window-floor'), memberId, handle: 'builder', description: 'Still builds', contextWindow: 8192 })
    expect(floor.status.member.contextWindow).toBe(8192)

    // The start policy is the closed continue/fresh pair.
    await expect(ctx.agentTeam.updateMember({ requestId: requestId('policy-bad'), memberId, handle: 'builder', description: 'Still builds', contextStartPolicy: 'whenever' as never })).rejects.toThrow(/context start policy/)

    // The profile is shape-checked at this layer: blank section names are
    // intent errors, and the paragraph is bounded in UTF-8 bytes — not code
    // units — with the exact boundary value accepted.
    await expect(ctx.agentTeam.updateMember({ requestId: requestId('prompt-blank'), memberId, handle: 'builder', description: 'Still builds', prompt: { droppedSections: ['   '] } })).rejects.toThrow(/must not be empty/)
    await expect(ctx.agentTeam.updateMember({ requestId: requestId('prompt-over'), memberId, handle: 'builder', description: 'Still builds', prompt: { customPrompt: '段'.repeat(2731) } })).rejects.toThrow(/must not exceed 8192 UTF-8 bytes/)
    const boundary = await ctx.agentTeam.updateMember({ requestId: requestId('prompt-boundary'), memberId, handle: 'builder', description: 'Still builds', prompt: { customPrompt: `${'段'.repeat(2730)}ab` } })
    expect(boundary.status.member.prompt).toEqual({ customPrompt: `${'段'.repeat(2730)}ab` })

    // A whitespace-only paragraph normalizes to an absent profile on both
    // write paths, and the idempotent-retry comparison normalizes the request
    // the same way: differently-spaced blanks resolve, real drift collides.
    const blank = await ctx.agentTeam.addMember({
      requestId: requestId('blank-add'), workspaceId: alpha, handle: 'blank', description: 'Blank paragraph',
      presetId: 'team-member', channelRefs: [], prompt: { customPrompt: '   ' },
    })
    expect(blank.status.member.prompt).toBeUndefined()
    const blankEdit = await ctx.agentTeam.updateMember({ requestId: requestId('blank-edit'), memberId, handle: 'builder', description: 'Still builds', prompt: { droppedSections: ['skills'], customPrompt: '\n\t' } })
    expect(blankEdit.status.member.prompt).toEqual({ droppedSections: ['skills'] })
    const blankRetry = await ctx.agentTeam.updateMember({ requestId: requestId('blank-edit'), memberId, handle: 'builder', description: 'Still builds', prompt: { droppedSections: ['skills'], customPrompt: '   ' } })
    expect(blankRetry.status.member.prompt).toEqual({ droppedSections: ['skills'] })
    await expect(ctx.agentTeam.updateMember({ requestId: requestId('blank-edit'), memberId, handle: 'builder', description: 'Still builds', prompt: { droppedSections: ['skills'], customPrompt: 'Different' } })).rejects.toThrow(/was reused with a different operation or payload/)

    // Re-pin for the replay and restart assertions below.
    await ctx.agentTeam.updateMember({ requestId: requestId('repin'), memberId, handle: 'builder', description: 'Still builds', prompt, contextStartPolicy: 'fresh', contextWindow: 96_000 })

    // The Human read behind the Prompt dialog mirrors the stored profile plus
    // the echo inputs its durable edit re-commits.
    const promptView = ctx.agentTeam.memberPromptView({ memberId })
    expect(promptView.prompt).toEqual(prompt)
    expect(promptView.handle).toBe('builder')
    expect(promptView.description).toBe('Still builds')
    expect(promptView.state).toBe('enabled')
    expect(promptView.contextStartPolicy).toBe('fresh')
    expect(promptView.contextWindow).toBe(96_000)
    expect(promptView.model).toBeUndefined()
    expect(promptView.capabilities).toBeUndefined()

    // A Member written before the fields existed replays without them.
    const legacy = await seedMember(ctx, created.channel.channelRef, 'legacy')
    expect(legacy.status.member.prompt).toBeUndefined()
    expect(legacy.status.member.contextStartPolicy).toBeUndefined()
    expect(legacy.status.member.contextWindow).toBeUndefined()

    const replayed = replayLedger(facility)
    expect(() => replayed.validate()).not.toThrow()
    expect(replayed.getMember(memberId)?.prompt).toEqual(prompt)
    expect(replayed.getMember(memberId)?.contextStartPolicy).toBe('fresh')
    expect(replayed.getMember(memberId)?.contextWindow).toBe(96_000)
    expect(replayed.getMember(legacy.status.member.memberId)?.contextStartPolicy).toBeUndefined()

    // Host restart: a fresh process replays the same ledger and restores the
    // durable context facts, legacy Member still field-free.
    const records = [...facility.get('agent_team')!.table('operations').entries()] as Array<[string, unknown]>
    const revived = await harness(storedPool(records))
    expect(revived.ctx.agentTeam.status()).toMatchObject({ agentMemberCount: 3 })
    const restored = revived.ctx.agentTeam.membersForClient({ workspaceId: alpha }).find(status => status.member.memberId === memberId)
    expect(restored?.member.prompt).toEqual(prompt)
    expect(restored?.member.contextStartPolicy).toBe('fresh')
    expect(restored?.member.contextWindow).toBe(96_000)
    const restoredBlank = revived.ctx.agentTeam.membersForClient({ workspaceId: alpha }).find(status => status.member.memberId === blank.status.member.memberId)
    expect(restoredBlank?.member.prompt).toBeUndefined()
    const restoredLegacy = revived.ctx.agentTeam.membersForClient({ workspaceId: alpha }).find(status => status.member.memberId === legacy.status.member.memberId)
    expect(restoredLegacy?.member.contextStartPolicy).toBeUndefined()
    expect(restoredLegacy?.member.contextWindow).toBeUndefined()
    expect(() => replayLedger(revived.facility).validate()).not.toThrow()
  })
})
