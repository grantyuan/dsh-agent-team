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

  it('polls DM history per member with an exclusive sequence cursor', async () => {
    const { ledger } = await openLedger()
    const channelRef = await seedTeam(ledger)
    await addExternalMember(ledger, [channelRef])
    await ledger.sendDm({ requestId: requestId('dm-in'), workspaceId: alpha, recipientMemberId: externalId, body: 'first inbound', actor: scout })
    const out = await ledger.sendDm({ requestId: requestId('dm-out'), workspaceId: alpha, recipientMemberId: scoutId, body: 'outbound reply', actor: visitor })
    await ledger.sendDm({ requestId: requestId('dm-in-2'), workspaceId: alpha, recipientMemberId: externalId, body: 'second inbound', actor: scout })

    // Both directions, ascending, direction-labeled; peers resolve to scout.
    const all = ledger.dmsForMember(externalId, { workspaceId: alpha })
    expect(all.dms.map(entry => entry.direction)).toEqual(['in', 'out', 'in'])
    expect(all.dms.map(entry => entry.body)).toEqual(['first inbound', 'outbound reply', 'second inbound'])
    expect(all.dms.every(entry => entry.peerMemberId === scoutId)).toBe(true)
    expect(all.hasMore).toBe(false)

    // The cursor is exclusive; the limit reports hasMore.
    const afterFirst = ledger.dmsForMember(externalId, { workspaceId: alpha, afterSequence: all.dms[0]!.sequence })
    expect(afterFirst.dms.map(entry => entry.body)).toEqual(['outbound reply', 'second inbound'])
    const bounded = ledger.dmsForMember(externalId, { workspaceId: alpha, afterSequence: all.dms[0]!.sequence, limit: 1 })
    expect(bounded.dms.map(entry => entry.body)).toEqual(['outbound reply'])
    expect(bounded.hasMore).toBe(true)
    expect(ledger.dmsForMember(externalId, { workspaceId: alpha, afterSequence: out.value.receipt.sequence }).dms.map(entry => entry.body)).toEqual(['second inbound'])
    // The other side of the pair sees the same three; strangers see none.
    expect(ledger.dmsForMember(scoutId, { workspaceId: alpha }).dms).toHaveLength(3)
    expect(ledger.dmsForMember('member:agent-stranger' as AgentTeamMemberId, { workspaceId: alpha }).dms).toHaveLength(0)
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
        const member = { ...agentMember(memberId, request.handle), external: true }
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
      heartbeatForMember: async (memberId, request) => {
        const member = ledger.getMember(memberId)
        if (member === undefined || member.external !== true) throw new Error(`Agent Member '${memberId}' is not an external member`)
        return { lastBeatAt: new Date().toISOString(), ...(request.note === undefined ? {} : { note: request.note }), ...(request.entries === undefined ? {} : { entries: request.entries }) }
      },
      dmsForMember: (memberId, request) => ledger.dmsForMember(memberId, request),
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

  it('keeps two joined agents independent with per-handle state files', async () => {
    const { ledger } = await openLedger()
    const channelRef = await seedTeam(ledger)
    const api = await new AgentTeamExternalApi(ledgerCore(ledger), { port: 0, token: 'test-secret' }).start()
    cleanups.push(() => api.stop())
    const port = api.boundPort
    if (port === undefined) throw new Error('gateway did not bind')
    // A hermetic HOME: the default per-handle state path resolves under it.
    const home = await mkdtemp(join(tmpdir(), 'agent-team-home-'))
    cleanups.push(() => rm(home, { recursive: true, force: true }))
    const env = { ...process.env, HOME: home }

    const joinArgs = ['join', '--url', `http://127.0.0.1:${port}`, '--workspace', alpha, '--token', 'test-secret']
    const joinA = await run(process.execPath, [scriptPath, ...joinArgs, '--handle', 'visitor-a'], { env })
    const joinB = await run(process.execPath, [scriptPath, ...joinArgs, '--handle', 'visitor-b'], { env })
    const stateA = JSON.parse(joinA.stdout) as { memberId: string; token: string; stateFile: string }
    const stateB = JSON.parse(joinB.stdout) as { memberId: string; token: string; stateFile: string }
    // Two joins, two identities: distinct members, distinct derived tokens,
    // distinct state files — never one shared id.
    expect(stateA.memberId).not.toBe(stateB.memberId)
    expect(stateA.token).not.toBe(stateB.token)
    expect(stateA.stateFile).not.toBe(stateB.stateFile)

    // The mention routes to the member it names; B's watch stays quiet while
    // A's wakes with the facts.
    await ledger.sendMessage({ requestId: requestId('to-a'), workspaceId: alpha, channelRef,
      body: '@visitor-a only you', actor: scout })
    const quietB = await run(process.execPath, [scriptPath, 'watch', '--workspace', alpha, '--handle', 'visitor-b', '--interval', '1', '--timeout', '2'], { env })
    expect(JSON.parse(quietB.stdout)).toMatchObject({ kind: 'quiet' })
    const wakeA = await run(process.execPath, [scriptPath, 'watch', '--workspace', alpha, '--handle', 'visitor-a', '--interval', '1', '--timeout', '20'], { env })
    const wakeBody = JSON.parse(wakeA.stdout) as { kind: string; reads: { threadRef: string; baseRevision: number; facts: { body: string }[] }[] }
    expect(wakeBody.kind).toBe('messages')
    expect(wakeBody.reads[0]!.facts.some(fact => fact.body.includes('only you'))).toBe(true)

    // A replies under its own resolved identity (no --state, just --handle).
    const reply = await run(process.execPath, [scriptPath, 'send', 'reply',
      '--workspace', alpha, '--handle', 'visitor-a',
      '--thread', wakeBody.reads[0]!.threadRef, '--base-revision', String(wakeBody.reads[0]!.baseRevision),
      '--body', 'ack from visitor-a'], { env })
    expect(JSON.parse(reply.stdout)).toMatchObject({ kind: 'committed' })
    expect(ledger.inbox(scout, { workspaceId: alpha }).totalUnreadCount).toBeGreaterThan(0)
  })

  it('syncs a heartbeat snapshot and caches it for the watch piggyback', async () => {
    const { ledger } = await openLedger()
    const channelRef = await seedTeam(ledger)
    const api = await new AgentTeamExternalApi(ledgerCore(ledger), { port: 0, token: 'test-secret' }).start()
    cleanups.push(() => api.stop())
    const port = api.boundPort
    if (port === undefined) throw new Error('gateway did not bind')
    const stateFile = join(await mkdtemp(join(tmpdir(), 'agent-team-client-')), 'state.json')
    cleanups.push(() => rm(stateFile, { force: true }))

    const joinOut = await run(process.execPath, [scriptPath, 'join', '--url', `http://127.0.0.1:${port}`, '--workspace', alpha,
      '--token', 'test-secret', '--handle', 'visitor', '--state', stateFile])
    const joined = JSON.parse(joinOut.stdout) as { memberId: string }

    // A heartbeat without any payload refuses before any round trip.
    const empty = await run(process.execPath, [scriptPath, 'heartbeat', '--state', stateFile]).catch(error => error)
    expect(String(empty.stderr)).toContain('heartbeat requires --note')

    const beat = await run(process.execPath, [scriptPath, 'heartbeat', '--state', stateFile,
      '--note', 'fixing the login bug',
      '--entries', JSON.stringify([{ role: 'user', text: 'fix login' }, { role: 'assistant', text: 'on it' }])])
    const beatBody = JSON.parse(beat.stdout) as { lastBeatAt: string; note?: string }
    expect(beatBody.lastBeatAt).toBeDefined()
    expect(beatBody.note).toBe('fixing the login bug')
    // The snapshot rides the state file, so a later watch keeps presence fresh
    // with the same payload without the model doing anything.
    const state = JSON.parse(await readFile(stateFile, 'utf8')) as { lastHeartbeat?: { note?: string } }
    expect(state.lastHeartbeat?.note).toBe('fixing the login bug')

    // A quiet watch with the cached snapshot still exits quiet — the beats are
    // invisible to the inbox (they are not Team messages).
    const quiet = await run(process.execPath, [scriptPath, 'watch', '--interval', '1', '--timeout', '2', '--state', stateFile])
    expect(JSON.parse(quiet.stdout)).toMatchObject({ kind: 'quiet' })
    expect(ledger.inbox(memberActor(joined.memberId, 'visitor'), { workspaceId: alpha }).totalUnreadCount).toBe(0)
  })

  it('wakes on a DM addressed to it even with an empty inbox', async () => {
    const { ledger } = await openLedger()
    const channelRef = await seedTeam(ledger)
    const api = await new AgentTeamExternalApi(ledgerCore(ledger), { port: 0, token: 'test-secret' }).start()
    cleanups.push(() => api.stop())
    const port = api.boundPort
    if (port === undefined) throw new Error('gateway did not bind')
    const stateFile = join(await mkdtemp(join(tmpdir(), 'agent-team-client-')), 'state.json')
    cleanups.push(() => rm(stateFile, { force: true }))

    const joinOut = await run(process.execPath, [scriptPath, 'join', '--url', `http://127.0.0.1:${port}`, '--workspace', alpha,
      '--token', 'test-secret', '--handle', 'visitor', '--state', stateFile])
    const joined = JSON.parse(joinOut.stdout) as { memberId: string }

    // The bug this pins: a DM never enters the Inbox projection, and the
    // external member has no live session for the relay — the watch must
    // surface it anyway, or the message is invisible to a poller forever.
    await ledger.sendDm({ requestId: requestId('dm-wake'), workspaceId: alpha, recipientMemberId: joined.memberId as never, body: 'direct question for you', actor: scout })
    const wake = await run(process.execPath, [scriptPath, 'watch', '--interval', '1', '--timeout', '20', '--state', stateFile])
    const wakeBody = JSON.parse(wake.stdout) as { kind: string; reads: unknown[]; dms: { from: string; body: string }[] }
    expect(wakeBody.kind).toBe('messages')
    expect(wakeBody.reads).toEqual([])
    expect(wakeBody.dms).toHaveLength(1)
    expect(wakeBody.dms[0]).toMatchObject({ from: scoutId, body: 'direct question for you' })

    // The cursor advanced with the wake: the next watch is quiet again.
    const state = JSON.parse(await readFile(stateFile, 'utf8')) as { lastDmSequence?: number }
    expect(state.lastDmSequence).toBeGreaterThan(0)
    const quiet = await run(process.execPath, [scriptPath, 'watch', '--interval', '1', '--timeout', '2', '--state', stateFile])
    expect(JSON.parse(quiet.stdout)).toMatchObject({ kind: 'quiet' })

    // The standalone dms command still lists history on demand.
    const listed = await run(process.execPath, [scriptPath, 'dms', '--state', stateFile])
    expect(JSON.parse(listed.stdout).dms).toHaveLength(1)
  })
})
