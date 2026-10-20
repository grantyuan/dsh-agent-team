import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { AgentTeamLedger, agentTeamHumanActor } from '../src/ledger.ts'
import { agentTeamDomainSpec } from '../src/spec.ts'
import { AGENT_TEAM_HUMAN_MEMBER_ID } from '../src/ledger.ts'
import type { AgentTeamChannelRef, AgentTeamHumanActor, AgentTeamMemberActor, AgentTeamMemberId, AgentTeamMessageRef, AgentTeamOperation, AgentTeamOperationId, AgentTeamRequestId, AgentTeamThreadFact, AgentTeamThreadRef } from '../src/types.ts'

/**
 * Human correction of one Human-sent Message: edit re-stamps the body and
 * re-delivers it to executors that already read it; recall (retract or delete)
 * kills the instruction — the body stays ledger-audit only, direct markers are
 * cleaned up, and the fact is never unread work again. Every operation must
 * survive an independent cold replay byte-for-byte.
 */

const cleanups: Array<() => Promise<void>> = []
const alpha = WorkspaceId('workspace:alpha')
const requestId = (value: string): AgentTeamRequestId => value as AgentTeamRequestId
const human = agentTeamHumanActor()

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

async function openLedger(): Promise<{ readonly ledger: AgentTeamLedger; readonly table: KvTable<AgentTeamOperationId, AgentTeamOperation> }> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  cleanups.push(async () => { await facility.closeAll() })
  const domain = await ctx.storageDomain.open(agentTeamDomainSpec)
  const table = domain.table('operations') as unknown as KvTable<AgentTeamOperationId, AgentTeamOperation>
  return { ledger: new AgentTeamLedger(table), table }
}

function memberActor(memberId: string, handle: string): AgentTeamMemberActor {
  return { kind: 'member', memberId: memberId as AgentTeamMemberId, handle }
}

/** One channel with two agent members: 'scout' and 'planner', both enabled. */
async function seedChannel(ledger: AgentTeamLedger): Promise<AgentTeamChannelRef> {
  const channel = (await ledger.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work', memberIds: [], actor: human })).value.channel
  const member = (memberId: string, handle: string) => ({
    memberId: memberId as AgentTeamMemberId, sessionId: SessionId(`session:${memberId}`), workspaceId: alpha, handle,
    description: `${handle} description`, presetId: 'team-member', privateMemoryPath: `/tmp/${handle}`, state: 'enabled' as const,
  })
  await ledger.addMember({ requestId: requestId('member-scout'), workspaceId: alpha, handle: 'scout', description: 'Scout work', presetId: 'team-member', channelRefs: [channel.channelRef], actor: human, member: member('member:scout', 'scout') })
  await ledger.addMember({ requestId: requestId('member-planner'), workspaceId: alpha, handle: 'planner', description: 'Planner work', presetId: 'team-member', channelRefs: [channel.channelRef], actor: human, member: member('member:planner', 'planner') })
  return channel.channelRef
}

function messageFacts(ledger: AgentTeamLedger, threadRef: AgentTeamThreadRef): Array<Extract<AgentTeamThreadFact, { kind: 'message' }>> {
  return ledger.threadHistory(human, { workspaceId: alpha, threadRef, limit: 100 }).facts
    .filter((fact): fact is Extract<AgentTeamThreadFact, { kind: 'message' }> => fact.kind === 'message')
}

describe('Human Message edit', () => {
  it('re-stamps the body, re-delivers to read executors, keeps unread markers for others, and replays cleanly', async () => {
    const { ledger, table } = await openLedger()
    await ledger.initialize()
    const channelRef = await seedChannel(ledger)
    const scout = 'member:scout' as AgentTeamMemberId
    const planner = 'member:planner' as AgentTeamMemberId

    // One instruction naming both agents; scout reads it, planner does not.
    const sent = await ledger.sendMessage({ requestId: requestId('send'), workspaceId: alpha, channelRef, body: '@scout and @planner investigate the export path', actor: human })
    if (sent.value.kind !== 'committed') throw new Error(`expected committed send, received ${sent.value.kind}`)
    const messageRef = sent.value.message.messageRef
    const threadRef = sent.value.thread.threadRef
    const revisionBefore = sent.value.thread.revision
    await ledger.readThread({ requestId: requestId('scout-read'), workspaceId: alpha, threadRef: sent.value.thread.threadRef, actor: memberActor(scout, 'scout') })

    const edited = await ledger.editMessage({ requestId: requestId('edit-1'), workspaceId: alpha, messageRef, body: '  investigate the import path instead  ', actor: human })
    if (edited.value.kind !== 'committed') throw new Error(`expected committed edit, received ${edited.value.kind}`)

    // The commit re-stamps the body (trimmed), keeps every identity fact, and
    // advances the Thread revision exactly one sequence.
    expect(edited.value.message).toMatchObject({ messageRef, body: 'investigate the import path instead', sender: AGENT_TEAM_HUMAN_MEMBER_ID })
    expect(edited.value.message.occurredAt).toBe(sent.value.message.occurredAt)
    expect(edited.value.thread.revision).toBeGreaterThan(revisionBefore)
    const history = messageFacts(ledger, sent.value.thread.threadRef)
    expect(history.find(fact => fact.message.messageRef === messageRef)?.message.body).toBe('investigate the import path instead')

    // The read executor is re-delivered: a fresh direct marker puts the edited
    // instruction back in front of scout. The unread member keeps the original
    // marker — one marker, never a duplicate pair.
    const inbox = (memberId: AgentTeamMemberId) => {
      const rows = ledger.inbox(memberActor(memberId, memberId === scout ? 'scout' : 'planner'), { workspaceId: alpha, limit: 100 }).items
      return rows.find(row => row.thread.threadRef === threadRef)
    }
    expect(inbox(scout)).toMatchObject({ unreadCount: 1, directCount: 1 })
    expect(inbox(planner)).toMatchObject({ unreadCount: 1, directCount: 1 })

    // The read executor set is exactly the mentioned members that read through
    // the message — the set the Host force-stops on the commit.
    expect(ledger.executorsOfMessage(messageRef)).toEqual([scout])

    // An idempotent retry resolves without a second operation or a second wake.
    const retry = await ledger.editMessage({ requestId: requestId('edit-1'), workspaceId: alpha, messageRef, body: 'investigate the import path instead', actor: human })
    expect(retry.committed).toBe(false)
    expect(retry.value.message.body).toBe('investigate the import path instead')

    // Cold replay accepts the operation and rebuilds identical projections.
    expect(() => ledger.validate()).not.toThrow()
    const fresh = new AgentTeamLedger(table)
    expect(messageFacts(fresh, sent.value.thread.threadRef).find(fact => fact.message.messageRef === messageRef)?.message.body).toBe('investigate the import path instead')
    expect(fresh.inbox(memberActor(scout, 'scout'), { workspaceId: alpha, limit: 100 }).items).toEqual(ledger.inbox(memberActor(scout, 'scout'), { workspaceId: alpha, limit: 100 }).items)
  })

  it('rejects edits that are not the Human correcting its own live Message', async () => {
    const { ledger } = await openLedger()
    await ledger.initialize()
    const channelRef = await seedChannel(ledger)
    const scout = 'member:scout' as AgentTeamMemberId

    const sent = await ledger.sendMessage({ requestId: requestId('send'), workspaceId: alpha, channelRef, body: 'Human instruction', actor: human })
    if (sent.value.kind !== 'committed') throw new Error('expected committed send')
    const messageRef = sent.value.message.messageRef
    await ledger.readThread({ requestId: requestId('scout-read'), workspaceId: alpha, threadRef: sent.value.thread.threadRef, actor: memberActor(scout, 'scout') })
    const replied = await ledger.reply({ requestId: requestId('scout-reply'), workspaceId: alpha, threadRef: sent.value.thread.threadRef, body: 'Scout progress note', baseRevision: sent.value.thread.revision, actor: memberActor(scout, 'scout') })
    if (replied.value.kind !== 'committed') throw new Error('expected committed reply')

    // Someone else's Message, an unknown ref, a no-op body, a non-Human actor,
    // and a recalled Message all refuse to commit.
    await expect(ledger.editMessage({ requestId: requestId('edit-agent'), workspaceId: alpha, messageRef: replied.value.message.messageRef, body: 'hijacked', actor: human })).rejects.toThrow('only your own Messages can be edited')
    await expect(ledger.editMessage({ requestId: requestId('edit-unknown'), workspaceId: alpha, messageRef: 'message:missing' as AgentTeamMessageRef, body: 'anything', actor: human })).rejects.toThrow("unknown Message 'message:missing'")
    await expect(ledger.editMessage({ requestId: requestId('edit-same'), workspaceId: alpha, messageRef, body: 'Human instruction', actor: human })).rejects.toThrow('identical to the current body')
    // The authorized request type pins actor to the Human — only the Host's
    // Human service reaches this method — so the ledger's runtime guard is
    // defense in depth, exercised here through a deliberate cast.
    const memberEditActor = memberActor(scout, 'scout') as unknown as AgentTeamHumanActor
    await expect(ledger.editMessage({ requestId: requestId('edit-agent-actor'), workspaceId: alpha, messageRef, body: 'from the agent', actor: memberEditActor })).rejects.toThrow()
    await expect(ledger.editMessage({ requestId: requestId('edit-empty'), workspaceId: alpha, messageRef, body: '   ', actor: human })).rejects.toThrow('must not be empty')

    await ledger.recallMessage({ requestId: requestId('recall-for-edit'), workspaceId: alpha, messageRef, mode: 'retracted', actor: human })
    await expect(ledger.editMessage({ requestId: requestId('edit-recalled'), workspaceId: alpha, messageRef, body: 'too late', actor: human })).rejects.toThrow('a recalled Message cannot be edited')
  })
})

describe('Human Message recall', () => {
  it('retracts: stamps recalledAt, cleans direct markers, never counts as unread again, and replays cleanly', async () => {
    const { ledger, table } = await openLedger()
    await ledger.initialize()
    const channelRef = await seedChannel(ledger)
    const scout = 'member:scout' as AgentTeamMemberId

    // The instruction names scout, who never reads it: the direct marker sits
    // unread until the recall cleans it up.
    const sent = await ledger.sendMessage({ requestId: requestId('send'), workspaceId: alpha, channelRef, body: '@scout deploy the staging build', actor: human })
    if (sent.value.kind !== 'committed') throw new Error('expected committed send')
    const messageRef = sent.value.message.messageRef
    const threadRef = sent.value.thread.threadRef
    const revisionBefore = sent.value.thread.revision
    expect(ledger.inbox(memberActor(scout, 'scout'), { workspaceId: alpha, limit: 100 }).items).toEqual([
      expect.objectContaining({ thread: expect.objectContaining({ threadRef }), unreadCount: 1, directCount: 1 }),
    ])

    const recalled = await ledger.recallMessage({ requestId: requestId('recall-1'), workspaceId: alpha, messageRef, mode: 'retracted' , actor: human })
    if (recalled.value.kind !== 'committed') throw new Error(`expected committed recall, received ${recalled.value.kind}`)
    expect(recalled.value.message.recalledAt).toEqual(expect.any(String))
    expect(recalled.value.message.body).toBe('@scout deploy the staging build')
    expect(recalled.value.thread.revision).toBeGreaterThan(revisionBefore)

    // The tombstone fact stays for audit, but it is dead work: the row leaves
    // the scout's inbox, and a later read acknowledges nothing at all.
    expect(ledger.inbox(memberActor(scout, 'scout'), { workspaceId: alpha, limit: 100 }).items).toEqual([])
    const read = await ledger.readThread({ requestId: requestId('scout-read'), workspaceId: alpha, threadRef, actor: memberActor(scout, 'scout') })
    expect(read.committed).toBe(false)
    expect(read.value.remainingUnreadCount).toBe(0)

    // Retry resolves; a second recall under a fresh request id refuses.
    const retry = await ledger.recallMessage({ requestId: requestId('recall-1'), workspaceId: alpha, messageRef, mode: 'retracted' , actor: human })
    expect(retry.committed).toBe(false)
    await expect(ledger.recallMessage({ requestId: requestId('recall-2'), workspaceId: alpha, messageRef, mode: 'retracted', actor: human })).rejects.toThrow('already recalled')

    expect(() => ledger.validate()).not.toThrow()
    const fresh = new AgentTeamLedger(table)
    const replayed = messageFacts(fresh, threadRef).find(fact => fact.message.messageRef === messageRef)?.message
    expect(replayed?.recalledAt).toEqual(expect.any(String))
    expect(fresh.inbox(memberActor(scout, 'scout'), { workspaceId: alpha, limit: 100 }).items).toEqual([])
  })

  it('deletes: removes the fact from every timeline surface, refuses anchor deletion, and replays cleanly', async () => {
    const { ledger, table } = await openLedger()
    await ledger.initialize()
    const channelRef = await seedChannel(ledger)
    const scout = 'member:scout' as AgentTeamMemberId

    const sent = await ledger.sendMessage({ requestId: requestId('send'), workspaceId: alpha, channelRef, body: 'Human starts the thread', actor: human })
    if (sent.value.kind !== 'committed') throw new Error('expected committed send')
    const threadRef = sent.value.thread.threadRef
    await ledger.readThread({ requestId: requestId('scout-read'), workspaceId: alpha, threadRef, actor: memberActor(scout, 'scout') })
    const replied = await ledger.reply({ requestId: requestId('scout-reply'), workspaceId: alpha, threadRef, body: 'Scout progress note', baseRevision: sent.value.thread.revision, actor: memberActor(scout, 'scout') })
    if (replied.value.kind !== 'committed') throw new Error('expected committed reply')
    await ledger.readThread({ requestId: requestId('human-read'), workspaceId: alpha, threadRef, actor: human })
    const followUp = await ledger.reply({ requestId: requestId('human-reply'), workspaceId: alpha, threadRef, body: 'temporary side instruction', baseRevision: replied.value.thread.revision, actor: human })
    if (followUp.value.kind !== 'committed') throw new Error('expected committed Human reply')
    const followUpRef = followUp.value.message.messageRef

    const before = messageFacts(ledger, threadRef)
    expect(before.map(fact => fact.message.messageRef)).toEqual([sent.value.message.messageRef, replied.value.message.messageRef, followUpRef])

    const deleted = await ledger.recallMessage({ requestId: requestId('recall-delete'), workspaceId: alpha, messageRef: followUpRef, mode: 'deleted' , actor: human })
    if (deleted.value.kind !== 'committed') throw new Error('expected committed delete')

    // The fact is gone from the Thread history, the directory, and the
    // executor set; the Thread count drops by one.
    expect(messageFacts(ledger, threadRef).map(fact => fact.message.messageRef)).toEqual([sent.value.message.messageRef, replied.value.message.messageRef])
    expect(ledger.view({ workspaceId: alpha, channelRef, limit: 100 }).items.map(item => item.message.messageRef)).toEqual([sent.value.message.messageRef, replied.value.message.messageRef])
    expect(ledger.executorsOfMessage(followUpRef)).toEqual([])
    const thread = ledger.view({ workspaceId: alpha, limit: 1 }).threads.find(candidate => candidate.threadRef === threadRef)
    expect(thread?.revision).toBe(deleted.value.thread.revision)

    // The anchor defines the Thread on every surface; deleting it refuses.
    await expect(ledger.recallMessage({ requestId: requestId('recall-anchor'), workspaceId: alpha, messageRef: sent.value.message.messageRef, mode: 'deleted', actor: human })).rejects.toThrow('anchor Message')
    // Retraction stays available for the anchor.
    await expect(ledger.recallMessage({ requestId: requestId('recall-anchor-retract'), workspaceId: alpha, messageRef: sent.value.message.messageRef, mode: 'retracted', actor: human })).resolves.toMatchObject({ value: { kind: 'committed' } })

    expect(() => ledger.validate()).not.toThrow()
    const fresh = new AgentTeamLedger(table)
    expect(messageFacts(fresh, threadRef).map(fact => fact.message.messageRef)).toEqual([sent.value.message.messageRef, replied.value.message.messageRef])
    expect(fresh.view({ workspaceId: alpha, channelRef, limit: 100 }).items.map(item => item.message.messageRef)).toEqual([sent.value.message.messageRef, replied.value.message.messageRef])
  })

  it('computes the executor set as mentioned members that read through the Message, never the Human', async () => {
    const { ledger } = await openLedger()
    await ledger.initialize()
    const channelRef = await seedChannel(ledger)
    const scout = 'member:scout' as AgentTeamMemberId
    const planner = 'member:planner' as AgentTeamMemberId

    const sent = await ledger.sendMessage({ requestId: requestId('send'), workspaceId: alpha, channelRef, body: '@scout and @planner pair up', actor: human })
    if (sent.value.kind !== 'committed') throw new Error('expected committed send')
    const messageRef = sent.value.message.messageRef
    const threadRef = sent.value.thread.threadRef

    // Nobody has read through the Message yet: no executor can be executing it.
    expect(ledger.executorsOfMessage(messageRef)).toEqual([])

    // Scout reads through; planner stays behind. Only scout is a candidate.
    await ledger.readThread({ requestId: requestId('scout-read'), workspaceId: alpha, threadRef, actor: memberActor(scout, 'scout') })
    expect(ledger.executorsOfMessage(messageRef)).toEqual([scout])
    await ledger.readThread({ requestId: requestId('planner-read'), workspaceId: alpha, threadRef, actor: memberActor(planner, 'planner') })
    expect(ledger.executorsOfMessage(messageRef)).toEqual([planner, scout].sort())

    // An agent reply naming the Human never lists the Human as an executor.
    const replied = await ledger.reply({ requestId: requestId('scout-reply'), workspaceId: alpha, threadRef, body: 'noting the operator', baseRevision: sent.value.thread.revision, actor: memberActor(scout, 'scout'), recipients: [AGENT_TEAM_HUMAN_MEMBER_ID] })
    if (replied.value.kind !== 'committed') throw new Error('expected committed reply')
    expect(ledger.executorsOfMessage(replied.value.message.messageRef)).toEqual([])
  })
})
