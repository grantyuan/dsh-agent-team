import { afterEach, describe, expect, it, vi } from 'vitest'
// A Storage-backed Host boot costs seconds per test; keep headroom like the
// other ledger suites rather than betting on runner throughput.
vi.setConfig({ testTimeout: 30_000 })
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { AgentTeamExternalApi } from '../src/external-api.ts'
import type { AgentTeamExternalCore } from '../src/external-api.ts'
import { AgentTeamLedger, agentTeamHumanActor } from '../src/ledger.ts'
import type { AgentTeamLedgerOptions } from '../src/ledger.ts'
import { agentTeamDomainSpec } from '../src/spec.ts'
import type {
  AgentTeamChannelRef, AgentTeamMemberActor, AgentTeamMemberId, AgentTeamOperation,
  AgentTeamOperationId, AgentTeamRequestId,
} from '../src/types.ts'

/**
 * An external Member is a durable roster entry whose session never activates:
 * it reaches the same ledger the internal members do, only through the gateway.
 * These tests pin the ledger semantics an external member relies on (creation
 * reach, unread accumulation, the read→token→write loop, DM history) and one
 * end-to-end run of the shipped client script against the gateway.
 */

const cleanups: Array<() => Promise<void>> = []
const alpha = WorkspaceId('workspace:alpha')
const requestId = (value: string): AgentTeamRequestId => value as AgentTeamRequestId
const human = agentTeamHumanActor()

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

async function openLedger(): Promise<{ readonly ledger: AgentTeamLedger; readonly table: KvTable<AgentTeamOperationId, AgentTeamOperation> }> {
  let tick = 0
  const options: AgentTeamLedgerOptions = { occurredAt: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString() }
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  cleanups.push(async () => { await facility.closeAll() })
  const domain = await ctx.storageDomain.open(agentTeamDomainSpec)
  const table = domain.table('operations') as unknown as KvTable<AgentTeamOperationId, AgentTeamOperation>
  return { ledger: new AgentTeamLedger(table, options), table }
}

function memberActor(memberId: string, handle: string): AgentTeamMemberActor {
  return { kind: 'member', memberId: memberId as AgentTeamMemberId, handle }
}

const scoutId = 'member:agent-scout' as AgentTeamMemberId
const externalId = 'member:agent-visitor' as AgentTeamMemberId
const scout = memberActor(scoutId, 'scout')
const visitor = memberActor(externalId, 'visitor')

function agentMember(memberId: AgentTeamMemberId, handle: string) {
  return { memberId, sessionId: SessionId('session:' + memberId), workspaceId: alpha, handle,
    description: handle + ' work', presetId: 'team-member', privateMemoryPath: '/tmp/' + handle,
    state: 'enabled' as const }
}

async function seedTeam(ledger: AgentTeamLedger): Promise<AgentTeamChannelRef> {
  await ledger.initialize()
  const channel = (await ledger.createChannel({ requestId: requestId('channel-a'), workspaceId: alpha,
    name: 'alpha-one', description: 'Alpha one', memberIds: [], actor: human })).value.channel
  await ledger.addMember({ requestId: requestId('member-scout'), workspaceId: alpha, handle: 'scout',
    description: 'Scout work', presetId: 'team-member', channelRefs: [channel.channelRef], actor: human,
    member: agentMember(scoutId, 'scout') })
  return channel.channelRef
}

async function addExternalMember(ledger: AgentTeamLedger, channelRefs: readonly AgentTeamChannelRef[]): Promise<void> {
  await ledger.addMember({ requestId: requestId('member-visitor'), workspaceId: alpha, handle: 'visitor',
    description: 'An external harness agent', presetId: 'team-member', channelRefs: [...channelRefs], actor: human,
    member: { ...agentMember(externalId, 'visitor'), external: true } })
}

describe('external member ledger semantics', () => {
  it('enumerates active channels oldest-first for the join grant', async () => {
    const { ledger } = await openLedger()
    await ledger.initialize()
    const first = (await ledger.createChannel({ requestId: requestId('c1'), workspaceId: alpha,
      name: 'one', description: '', memberIds: [], actor: human })).value.channel
    const second = (await ledger.createChannel({ requestId: requestId('c2'), workspaceId: alpha,
      name: 'two', description: '', memberIds: [], actor: human })).value.channel
    await ledger.createChannel({ requestId: requestId('cb'), workspaceId: 'workspace:beta' as never,
      name: 'beta', description: '', memberIds: [], actor: human })
    await ledger.archiveChannel({ requestId: requestId('c2-archive'), workspaceId: alpha,
      channelRef: second.channelRef, actor: human })
    expect(ledger.channelsInWorkspace(alpha).map(channel => channel.channelRef)).toEqual([first.channelRef])
  })

  it('keeps the external marker durable across a restart replay and a roster edit', async () => {
    const { ledger, table } = await openLedger()
    const channelRef = await seedTeam(ledger)
    await addExternalMember(ledger, [channelRef])
    expect(ledger.getMember(externalId)?.external).toBe(true)

    // A Human roster edit must not strip the marker: absent-clears applies to
    // the overlay fields only, and the identity spread keeps the rest.
    await ledger.updateMember({ requestId: requestId('update-visitor'),
      memberId: externalId, handle: 'visitor', description: 'An external harness agent',
      actor: human })
    expect(ledger.getMember(externalId)?.external).toBe(true)

    // The restart shape: a fresh ledger over the same durable table replays
    // the whole operation chain and reads the same virtual member — enabled,
    // external, and exactly the row the restore loop must skip.
    const replayed = new AgentTeamLedger(table)
    await replayed.initialize()
    expect(replayed.getMember(externalId)?.external).toBe(true)
    expect(replayed.getMember(externalId)?.state).toBe('enabled')
  })

  it('grants a created external member its channels and accumulates mentions as unread', async () => {    const { ledger } = await openLedger()
    const channelRef = await seedTeam(ledger)
    await addExternalMember(ledger, [channelRef])
    expect(ledger.participatesIn(externalId, alpha)).toBe(true)
    expect(ledger.channelsForMember(externalId, alpha)).toEqual([channelRef])

    // An unaddressed thread message stays out of the external inbox; a direct
    // mention lands as unread with the direct marker, ready to be polled.
    await ledger.sendMessage({ requestId: requestId('start-unaddressed'), workspaceId: alpha,
      channelRef, body: 'general chatter', actor: scout })
    const quiet = ledger.inbox(visitor, { workspaceId: alpha })
    expect(quiet.totalUnreadCount).toBe(0)
    await ledger.sendMessage({ requestId: requestId('start-addressed'), workspaceId: alpha,
      channelRef, body: '@visitor planning sync at three', actor: scout })
    const inbox = ledger.inbox(visitor, { workspaceId: alpha })
    expect(inbox.totalUnreadCount).toBe(1)
    expect(inbox.totalDirectCount).toBe(1)
  })

  it('runs the read → token → write loop and rejects a premature reply', async () => {
    const { ledger } = await openLedger()
    const channelRef = await seedTeam(ledger)
    await addExternalMember(ledger, [channelRef])
    const start = await ledger.sendMessage({ requestId: requestId('start-1'), workspaceId: alpha,
      channelRef, body: '@visitor please look at this', actor: scout })
    if (start.value.kind !== 'committed') throw new Error('expected committed start')
    const threadRef = start.value.thread.threadRef

    // The unread gate fires before anything else: no reply without a drain.
    const premature = await ledger.reply({ requestId: requestId('reply-premature'), workspaceId: alpha,
      threadRef, body: 'too eager', baseRevision: start.value.thread.revision, actor: visitor })
    expect(premature.value.kind).toBe('unread_required')

    const read = await ledger.readThread({ requestId: requestId('read-1'), workspaceId: alpha,
      threadRef, actor: visitor })
    expect(read.value.facts.length).toBeGreaterThan(0)
    expect(read.value.remainingUnreadCount).toBe(0)
    expect(read.value.thread.revision).toBeGreaterThan(0)

    const reply = await ledger.reply({ requestId: requestId('reply-1'), workspaceId: alpha,
      threadRef, body: 'looked — all clear', baseRevision: read.value.thread.revision, actor: visitor })
    expect(reply.value.kind).toBe('committed')
    // The internal teammate now holds the unread side of the exchange.
    expect(ledger.inbox(scout, { workspaceId: alpha }).totalUnreadCount).toBeGreaterThan(0)
  })

  it('renders adjacent DM history between members by id, honoring the excluding cursor', async () => {
    const { ledger } = await openLedger()
    const channelRef = await seedTeam(ledger)
    await addExternalMember(ledger, [channelRef])
    const dm = await ledger.sendDm({ requestId: requestId('dm-1'), workspaceId: alpha,
      recipientMemberId: scoutId, body: 'quick sync?', actor: visitor })
    // Direction labels read from the recipient's perspective: visitor sent it, so scout reads "them → you".
    const history = ledger.dmHistoryBetweenMembers(externalId, scoutId)
    expect(history).toContain('quick sync?')
    expect(history).toContain('them → you')
    expect(ledger.dmHistoryBetweenMembers(externalId, scoutId, dm.value.receipt.operationId)).toBeUndefined()
    // The session-keyed form still resolves the same exchange for live members.
    expect(ledger.dmHistoryBetween(SessionId('session:' + externalId), scoutId)).toContain('quick sync?')
  })
})

describe('client script end-to-end', () => {
  /**
   * The gateway core the script runs against: the same member-keyed ledger
   * calls the Host's ForMember methods make, without a live Host to bind
   * them to. This is the test seam's adapter, not a second authority —
   * production wires the real Host object in.
   */
  function ledgerCore(ledger: AgentTeamLedger): AgentTeamExternalCore {
    const actorOf = (memberId: AgentTeamMemberId): AgentTeamMemberActor => {
      const member = ledger.getMember(memberId)
      if (member === undefined) throw new Error(`unknown member '${memberId}'`)
      return { kind: 'member', memberId: member.memberId, handle: member.handle }
    }
    return {
      addExternalMember: async request => {
        const memberId = `member:${randomUUID()}` as AgentTeamMemberId
        const member = agentMember(memberId, request.handle)
        const result = await ledger.addMember({
          requestId: request.requestId, workspaceId: request.workspaceId, handle: request.handle,
          description: request.description ?? '', presetId: member.presetId,
          channelRefs: request.channelRefs ?? ledger.channelsInWorkspace(request.workspaceId).map(channel => channel.channelRef),
          actor: human, member,
        })
        return { receipt: result.value.receipt, status: { member: result.value.member, availability: 'unavailable', presence: 'unavailable' }, workspaceIds: ledger.workspacesOf(memberId) } as never
      },
      inboxForMember: (memberId, request) => ledger.inbox(actorOf(memberId), request),
      viewForMember: (memberId, request) => ledger.view(request, memberId),
      readThreadForMember: async (memberId, request) => (await ledger.readThread({ ...request, actor: actorOf(memberId) })).value,
      threadHistoryForMember: (memberId, request) => ledger.threadHistory(actorOf(memberId), request),
      sendMessageForMember: async (memberId, request) => (await ledger.sendMessage({ ...request, actor: actorOf(memberId) })).value,
      replyForMember: async (memberId, request) => (await ledger.reply({ ...request, actor: actorOf(memberId) })).value,
      dmForMember: async (memberId, request) => (await ledger.sendDm({ ...request, actor: actorOf(memberId) })).value,
    }
  }

  const run = promisify(execFile)
  const scriptPath = join(import.meta.dirname, '../external-client/agent-team.mjs')

  it('joins, wakes on a teammate message, and replies with the drained token', async () => {
    const { ledger } = await openLedger()
    const channelRef = await seedTeam(ledger)
    const api = await new AgentTeamExternalApi(ledgerCore(ledger), { port: 0, token: 'test-secret' }).start()
    cleanups.push(() => api.stop())
    const port = api.boundPort
    if (port === undefined) throw new Error('gateway did not bind')
    const stateFile = join(await mkdtemp(join(tmpdir(), 'agent-team-client-')), 'state.json')
    cleanups.push(() => rm(stateFile, { force: true }))

    const joinOut = await run(process.execPath, [scriptPath, 'join',
      '--url', `http://127.0.0.1:${port}`, '--workspace', alpha, '--token', 'test-secret',
      '--handle', 'visitor', '--description', 'script test', '--state', stateFile])
    const joined = JSON.parse(joinOut.stdout) as { kind: string; memberId: string }
    expect(joined.kind).toBe('joined')
    expect(await readFile(stateFile, 'utf8')).toContain(joined.memberId)

    // Quiet before traffic; the wake prints facts plus the write token.
    const quiet = await run(process.execPath, [scriptPath, 'watch', '--interval', '1', '--timeout', '2', '--state', stateFile])
    expect(JSON.parse(quiet.stdout)).toMatchObject({ kind: 'quiet' })

    await ledger.sendMessage({ requestId: requestId('wake'), workspaceId: alpha, channelRef,
      body: '@visitor hello from the team', actor: scout })
    const wake = await run(process.execPath, [scriptPath, 'watch', '--interval', '1', '--timeout', '20', '--state', stateFile])
    const wakeBody = JSON.parse(wake.stdout) as { kind: string; reads: { threadRef: string; baseRevision: number; facts: { body: string }[] }[] }
    expect(wakeBody.kind).toBe('messages')
    expect(wakeBody.reads[0]!.facts.some(fact => fact.body.includes('hello from the team'))).toBe(true)

    const reply = await run(process.execPath, [scriptPath, 'send', 'reply',
      '--thread', wakeBody.reads[0]!.threadRef, '--base-revision', String(wakeBody.reads[0]!.baseRevision),
      '--body', 'ack from the external harness', '--state', stateFile])
    expect(JSON.parse(reply.stdout)).toMatchObject({ kind: 'committed' })
    expect(ledger.inbox(scout, { workspaceId: alpha }).totalUnreadCount).toBeGreaterThan(0)

    // A thread ref also round-trips through the explicit read command.
    const read = await run(process.execPath, [scriptPath, 'read', '--thread', wakeBody.reads[0]!.threadRef, '--state', stateFile])
    expect(JSON.parse(read.stdout)).toMatchObject({ thread: { threadRef: wakeBody.reads[0]!.threadRef } })
  })
})
