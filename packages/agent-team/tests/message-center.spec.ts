import { afterEach, describe, expect, it, vi } from 'vitest'
// A Storage-backed Host boot costs seconds per test; keep headroom like the
// other ledger suites rather than betting on runner throughput.
vi.setConfig({ testTimeout: 30_000 })
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { AgentTeamLedger, agentTeamHumanActor } from '../src/ledger.ts'
import type { AgentTeamLedgerOptions } from '../src/ledger.ts'
import { agentTeamDomainSpec } from '../src/spec.ts'
import type {
  AgentTeamChannelRef, AgentTeamMemberActor, AgentTeamMemberId, AgentTeamMessageCenter,
  AgentTeamMessageCenterMessages, AgentTeamMessageCenterTopics, AgentTeamOperation,
  AgentTeamOperationId, AgentTeamRequestId, AgentTeamSendMessageResult, AgentTeamThreadRef,
} from '../src/types.ts'

/**
 * The Message Center is a read projection over facts the ledger already holds:
 * every Thread in a Workspace, and this person's own received and sent Messages
 * with the ledger signal behind each processing trace. These tests pin the
 * membership rule, the ordering and paging keys, the search excerpts, the
 * derived processing states, and replay equivalence.
 */

const cleanups: Array<() => Promise<void>> = []
const alpha = WorkspaceId('workspace:alpha')
const beta = WorkspaceId('workspace:beta')
const requestId = (value: string): AgentTeamRequestId => value as AgentTeamRequestId
const human = agentTeamHumanActor()

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

/** A deterministic clock, so time-range filters assert instants instead of guessing them. */
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
const plannerId = 'member:agent-planner' as AgentTeamMemberId
const scout = memberActor(scoutId, 'scout')
const planner = memberActor(plannerId, 'planner')

function agentMember(memberId: AgentTeamMemberId, handle: string) {
  return { memberId, sessionId: SessionId('session:' + memberId), workspaceId: alpha, handle,
    description: handle + ' work', presetId: 'team-member', privateMemoryPath: '/tmp/' + handle,
    state: 'enabled' as const }
}

async function seedTeam(ledger: AgentTeamLedger): Promise<{
  readonly channelA: AgentTeamChannelRef; readonly channelB: AgentTeamChannelRef
}> {
  await ledger.initialize()
  const channelA = (await ledger.createChannel({ requestId: requestId('channel-a'), workspaceId: alpha,
    name: 'alpha-one', description: 'Alpha one', memberIds: [], actor: human })).value.channel
  const channelB = (await ledger.createChannel({ requestId: requestId('channel-b'), workspaceId: alpha,
    name: 'alpha-two', description: 'Alpha two', memberIds: [], actor: human })).value.channel
  await ledger.addMember({ requestId: requestId('member-scout'), workspaceId: alpha, handle: 'scout',
    description: 'Scout work', presetId: 'team-member', channelRefs: [channelA.channelRef], actor: human,
    member: agentMember(scoutId, 'scout') })
  await ledger.addMember({ requestId: requestId('member-planner'), workspaceId: alpha, handle: 'planner',
    description: 'Planner work', presetId: 'team-member', channelRefs: [channelB.channelRef], actor: human,
    member: agentMember(plannerId, 'planner') })
  return { channelA: channelA.channelRef, channelB: channelB.channelRef }
}

interface SeededThread {
  readonly threadRef: AgentTeamThreadRef
  readonly taskRef: NonNullable<AgentTeamSendMessageResult extends { readonly kind: 'committed'; readonly task?: infer T } ? T : never>
  revision: number
  readonly messageRefs: string[]
}

function topicsOf(result: AgentTeamMessageCenter): AgentTeamMessageCenterTopics {
  if (result.view !== 'topics') throw new Error('expected the topics view')
  return result
}

function messagesOf(result: AgentTeamMessageCenter): AgentTeamMessageCenterMessages {
  if (result.view !== 'messages') throw new Error('expected the messages view')
  return result
}

describe('Message Center projection', () => {
  it('lists every visible Thread newest-first with this reader own relation to it', async () => {
    const { ledger } = await openLedger()
    const { channelA, channelB } = await seedTeam(ledger)
    const betaChannel = (await ledger.createChannel({ requestId: requestId('channel-beta'), workspaceId: beta,
      name: 'beta-one', description: 'Beta one', memberIds: [], actor: human })).value.channel

    const humanStart = await ledger.sendMessage({ requestId: requestId('start-human'), workspaceId: alpha,
      channelRef: channelA, body: 'Human asks\nsecond line ignored', actor: human })
    if (humanStart.value.kind !== 'committed') throw new Error('expected committed start')
    const agentStart = await ledger.sendMessage({ requestId: requestId('start-agent'), workspaceId: alpha,
      channelRef: channelB, body: 'Agent reports @human', actor: planner })
    if (agentStart.value.kind !== 'committed') throw new Error('expected committed start')
    await ledger.sendMessage({ requestId: requestId('start-beta'), workspaceId: beta, channelRef: betaChannel.channelRef,
      body: 'Beta only', actor: human })

    const topics = topicsOf(ledger.messageCenter(human, { workspaceId: alpha, view: 'topics' }))
    expect(topics.humanMemberId).toBe('member:human')
    // Newest fact first; the beta Workspace Thread never leaks into alpha.
    expect(topics.topics.map(row => row.threadRef)).toEqual([agentStart.value.thread.threadRef, humanStart.value.thread.threadRef])
    expect(topics.hasMore).toBe(false)
    expect(topics.cursor).toBe(humanStart.value.message.sequence)

    const [agentRow, humanRow] = topics.topics
    expect(agentRow).toMatchObject({ workspaceId: alpha, channelRef: channelB, channelName: 'alpha-two',
      subject: 'Agent reports @human', messageCount: 1, participantCount: 1, unreadCount: 1,
      iParticipated: false, needsHumanDecision: false, taskNumber: 1 })
    expect(agentRow!.lastActor.name).toBe('planner')
    expect(agentRow!.claimOwners).toEqual([])
    expect(humanRow).toMatchObject({ channelName: 'alpha-one', subject: 'Human asks',
      messageCount: 1, unreadCount: 0, iParticipated: true, taskNumber: 1 })

    // A Member only sees Channels it belongs to, and 「我参与过」 follows who wrote.
    const scoutTopics = topicsOf(ledger.messageCenter(scout, { workspaceId: alpha, view: 'topics' }))
    expect(scoutTopics.topics.map(row => row.threadRef)).toEqual([humanStart.value.thread.threadRef])
    expect(scoutTopics.topics[0]!.iParticipated).toBe(false)
  })

  it('searches subjects, bodies and sender names, and pages by the newest sequence', async () => {
    const { ledger } = await openLedger()
    const { channelA, channelB } = await seedTeam(ledger)
    const started = await ledger.sendMessage({ requestId: requestId('start-search'), workspaceId: alpha,
      channelRef: channelA, body: 'Release checklist', actor: human })
    if (started.value.kind !== 'committed') throw new Error('expected committed start')
    const revision = started.value.thread.revision
    const replied = await ledger.reply({ requestId: requestId('reply-search'), workspaceId: alpha,
      taskRef: started.value.task!.taskRef, body: 'the needle line\nsecond line', baseRevision: revision, actor: scout })
    if (replied.value.kind !== 'committed') throw new Error('expected committed reply')
    await ledger.sendMessage({ requestId: requestId('start-other'), workspaceId: alpha, channelRef: channelB,
      body: 'Unrelated thread', actor: human })

    const byBody = topicsOf(ledger.messageCenter(human, { workspaceId: alpha, view: 'topics', query: 'NEEDLE' }))
    expect(byBody.topics).toHaveLength(1)
    expect(byBody.topics[0]!.matchExcerpt).toBe('the needle line')

    const bySender = topicsOf(ledger.messageCenter(human, { workspaceId: alpha, view: 'topics', query: 'scout' }))
    expect(bySender.topics.map(row => row.threadRef)).toEqual([started.value.thread.threadRef])

    const bySubject = topicsOf(ledger.messageCenter(human, { workspaceId: alpha, view: 'topics', query: 'release' }))
    expect(bySubject.topics[0]!.matchExcerpt).toBe('Release checklist')

    const byChannel = topicsOf(ledger.messageCenter(human, { workspaceId: alpha, view: 'topics', channelRef: channelB }))
    expect(byChannel.topics.map(row => row.channelName)).toEqual(['alpha-two'])

    const all = topicsOf(ledger.messageCenter(human, { workspaceId: alpha, view: 'topics' }))
    expect(all.topics).toHaveLength(2)
    const firstPage = topicsOf(ledger.messageCenter(human, { workspaceId: alpha, view: 'topics', limit: 1 }))
    expect(firstPage.topics).toHaveLength(1)
    expect(firstPage.hasMore).toBe(true)
    const secondPage = topicsOf(ledger.messageCenter(human, { workspaceId: alpha, view: 'topics', limit: 1, cursor: firstPage.cursor! }))
    expect(secondPage.topics).toHaveLength(1)
    expect(secondPage.topics[0]!.threadRef).toBe(all.topics[1]!.threadRef)
    expect(secondPage.hasMore).toBe(false)

    // Time bounds are inclusive and read the fact instant, not the row's arrival.
    const newest = all.topics[0]!.lastOccurredAt
    const older = all.topics[1]!.lastOccurredAt
    const bounded = topicsOf(ledger.messageCenter(human, { workspaceId: alpha, view: 'topics', until: older }))
    expect(bounded.topics.map(row => row.threadRef)).toEqual([all.topics[1]!.threadRef])
    const after = topicsOf(ledger.messageCenter(human, { workspaceId: alpha, view: 'topics', since: newest }))
    expect(after.topics.map(row => row.threadRef)).toEqual([all.topics[0]!.threadRef])
  })

  it('rejects an out-of-range page, an unparseable bound, and an unknown direction', async () => {
    const { ledger } = await openLedger()
    await seedTeam(ledger)
    expect(() => ledger.messageCenter(human, { workspaceId: alpha, view: 'topics', limit: 0 }))
      .toThrow('message center limit must be an integer between 1 and 100')
    expect(() => ledger.messageCenter(human, { workspaceId: alpha, view: 'topics', limit: 101 }))
      .toThrow('message center limit must be an integer between 1 and 100')
    expect(() => ledger.messageCenter(human, { workspaceId: alpha, view: 'topics', cursor: 0 }))
      .toThrow('message center cursor must be a positive integer')
    expect(() => ledger.messageCenter(human, { workspaceId: alpha, view: 'messages', direction: 'both' as never }))
      .toThrow('message center direction must be received, sent, or all')
    expect(() => ledger.messageCenter(human, { workspaceId: alpha, view: 'topics', since: 'yesterday' }))
      .toThrow('message center since must be an ISO instant')
    expect(() => ledger.messageCenter(human, { workspaceId: alpha, view: 'topics', until: 'soon' }))
      .toThrow('message center until must be an ISO instant')
  })

  it('keeps only the Messages that named this reader or were written by it', async () => {
    const { ledger } = await openLedger()
    const { channelA, channelB } = await seedTeam(ledger)
    const started = await ledger.sendMessage({ requestId: requestId('start-mine'), workspaceId: alpha,
      channelRef: channelA, body: 'Please review @scout', actor: human })
    if (started.value.kind !== 'committed') throw new Error('expected committed start')
    // The mention marked the Thread unread for scout, so it reads before writing.
    const scoutRead = await ledger.readThread({ requestId: requestId('read-scout'), workspaceId: alpha,
      taskRef: started.value.task!.taskRef, actor: scout })
    const replied = await ledger.reply({ requestId: requestId('reply-at-human'), workspaceId: alpha,
      taskRef: started.value.task!.taskRef, body: 'Done @human', baseRevision: scoutRead.value.thread.revision, actor: scout })
    if (replied.value.kind !== 'committed') throw new Error('expected committed reply')
    // A Thread this reader neither wrote in nor was named by stays out.
    await ledger.sendMessage({ requestId: requestId('start-unrelated'), workspaceId: alpha, channelRef: channelB,
      body: 'Nobody here', actor: planner })

    const messages = messagesOf(ledger.messageCenter(human, { workspaceId: alpha, view: 'messages' }))
    expect(messages.messages.map(row => row.direction)).toEqual(['received', 'sent'])
    const [received, sent] = messages.messages
    expect(received).toMatchObject({ via: 'thread', channelName: 'alpha-one', threadSubject: 'Please review @scout',
      excerpt: 'Done @human', direction: 'received' })
    expect(received!.sender.name).toBe('scout')
    expect(received!.recipients.map(recipient => recipient.name)).toEqual(['human'])
    expect(received!.processing).toBeUndefined()
    expect(sent).toMatchObject({ direction: 'sent', excerpt: 'Please review @scout' })
    expect(sent!.recipients.map(recipient => recipient.name)).toEqual(['scout'])
    expect(sent!.messageRef).toBe(started.value.message.messageRef)

    const sentOnly = messagesOf(ledger.messageCenter(human, { workspaceId: alpha, view: 'messages', direction: 'sent' }))
    expect(sentOnly.messages).toHaveLength(1)
    expect(sentOnly.messages[0]!.messageRef).toBe(started.value.message.messageRef)
    const receivedOnly = messagesOf(ledger.messageCenter(human, { workspaceId: alpha, view: 'messages', direction: 'received' }))
    expect(receivedOnly.messages).toHaveLength(1)
    expect(receivedOnly.messages[0]!.messageRef).toBe(replied.value.message.messageRef)

    const searched = messagesOf(ledger.messageCenter(human, { workspaceId: alpha, view: 'messages', query: 'done' }))
    expect(searched.messages.map(row => row.direction)).toEqual(['received'])
    expect(searched.messages[0]!.matchExcerpt).toBe('Done @human')
  })

  it('derives pending, acknowledged and resolved from facts the ledger already holds', async () => {
    const { ledger } = await openLedger()
    const { channelA } = await seedTeam(ledger)
    const start = async (label: string, body: string) => {
      const started = await ledger.sendMessage({ requestId: requestId('start-' + label), workspaceId: alpha,
        channelRef: channelA, body, actor: human })
      if (started.value.kind !== 'committed') throw new Error('expected committed start')
      return started.value
    }
    const pending = await start('pending', 'Nothing follows this')
    const read = await start('read', 'Read only @scout')
    const replied = await start('replied', 'Reply expected @scout')
    const closed = await start('closed', 'Close the loop @scout')

    // Reading is the precondition of every Agent write, so each trace starts there.
    await ledger.readThread({ requestId: requestId('read-read'), workspaceId: alpha, taskRef: read.task!.taskRef, actor: scout })
    await ledger.readThread({ requestId: requestId('read-replied'), workspaceId: alpha, taskRef: replied.task!.taskRef, actor: scout })
    await ledger.reply({ requestId: requestId('reply-replied'), workspaceId: alpha, taskRef: replied.task!.taskRef,
      body: 'On it', baseRevision: replied.thread.revision, actor: scout })
    await ledger.readThread({ requestId: requestId('read-closed'), workspaceId: alpha, taskRef: closed.task!.taskRef, actor: scout })
    const claimed = await ledger.changeClaim({ requestId: requestId('claim-closed'), workspaceId: alpha,
      taskRef: closed.task!.taskRef, action: 'claim', direction: 'review', baseRevision: closed.thread.revision, actor: scout })
    expect(claimed.committed).toBe(true)
    if (claimed.value.kind !== 'committed') throw new Error('expected committed claim')
    await ledger.readThread({ requestId: requestId('read-human'), workspaceId: alpha, taskRef: closed.task!.taskRef, actor: human })
    const accepted = await ledger.changeTask({ requestId: requestId('accept-closed'), workspaceId: alpha,
      taskRef: closed.task!.taskRef, action: 'accept', baseRevision: claimed.value.thread.revision, actor: human })
    expect(accepted.committed).toBe(true)

    const messages = messagesOf(ledger.messageCenter(human, { workspaceId: alpha, view: 'messages' })).messages
    const byRef = new Map(messages.map(row => [row.messageRef, row]))
    const pendingRow = byRef.get(pending.message.messageRef)!.processing!
    expect(pendingRow).toMatchObject({ state: 'pending', basis: 'derived' })
    expect(pendingRow.evidence).toEqual([])

    const readRow = byRef.get(read.message.messageRef)!.processing!
    expect(readRow.state).toBe('acknowledged')
    expect(readRow.evidence).toEqual([{ kind: 'read', memberId: scoutId }])

    const repliedRow = byRef.get(replied.message.messageRef)!.processing!
    expect(repliedRow.state).toBe('acknowledged')
    expect(repliedRow.evidence.map(item => item.kind)).toEqual(['read', 'replied'])
    expect(repliedRow.evidence[1]!.messageRef).toBeDefined()

    const closedRow = byRef.get(closed.message.messageRef)!.processing!
    expect(closedRow.state).toBe('resolved')
    expect(closedRow.evidence.map(item => item.kind)).toEqual(['read', 'claimed', 'task-closed'])
    expect(closedRow.evidence[2]!.taskRef).toBe(closed.task!.taskRef)
  })

  it('names the nearest earlier other-author Message as reply context, never an exact target', async () => {
    const { ledger } = await openLedger()
    const { channelA } = await seedTeam(ledger)
    const started = await ledger.sendMessage({ requestId: requestId('start-context'), workspaceId: alpha,
      channelRef: channelA, body: 'Thread opener @scout', actor: human })
    if (started.value.kind !== 'committed') throw new Error('expected committed start')
    const taskRef = started.value.task!.taskRef
    await ledger.readThread({ requestId: requestId('read-1'), workspaceId: alpha, taskRef, actor: scout })
    const agentReply = await ledger.reply({ requestId: requestId('reply-1'), workspaceId: alpha, taskRef,
      body: 'Agent first', baseRevision: started.value.thread.revision, actor: scout })
    if (agentReply.value.kind !== 'committed') throw new Error('expected committed reply')
    await ledger.readThread({ requestId: requestId('read-2'), workspaceId: alpha, taskRef, actor: human })
    const humanReply = await ledger.reply({ requestId: requestId('reply-2'), workspaceId: alpha, taskRef,
      body: 'Human second', baseRevision: agentReply.value.thread.revision, actor: human })
    if (humanReply.value.kind !== 'committed') throw new Error('expected committed reply')

    const messages = messagesOf(ledger.messageCenter(human, { workspaceId: alpha, view: 'messages' })).messages
    const byRef = new Map(messages.map(row => [row.messageRef, row]))
    expect(byRef.get(started.value.message.messageRef)!.replyContext).toBeUndefined()
    const context = byRef.get(humanReply.value.message.messageRef)!.replyContext!
    expect(context.relation).toBe('previous-in-thread')
    expect(context.sender.name).toBe('scout')
    expect(context.excerpt).toBe('Agent first')
    expect(context.messageRef).toBe(agentReply.value.message.messageRef)
  })

  it('caps every preview and search excerpt at the Inbox bound', async () => {
    const { ledger } = await openLedger()
    const { channelA } = await seedTeam(ledger)
    const long = 'x'.repeat(200)
    const started = await ledger.sendMessage({ requestId: requestId('start-long'), workspaceId: alpha,
      channelRef: channelA, body: long + '\ntail line', actor: human })
    if (started.value.kind !== 'committed') throw new Error('expected committed start')

    const topics = topicsOf(ledger.messageCenter(human, { workspaceId: alpha, view: 'topics' }))
    expect(topics.topics[0]!.subject).toHaveLength(120)
    expect(topics.topics[0]!.subject.endsWith('…')).toBe(true)
    const matched = topicsOf(ledger.messageCenter(human, { workspaceId: alpha, view: 'topics', query: 'xxx' }))
    expect(matched.topics[0]!.matchExcerpt).toHaveLength(120)
    const messages = messagesOf(ledger.messageCenter(human, { workspaceId: alpha, view: 'messages' })).messages
    expect(messages[0]!.excerpt).toHaveLength(120)
  })

  it('keeps archived Channels out unless the read opts in', async () => {
    const { ledger } = await openLedger()
    const { channelA, channelB } = await seedTeam(ledger)
    await ledger.sendMessage({ requestId: requestId('start-archived'), workspaceId: alpha, channelRef: channelA,
      body: 'Archived thread', actor: human })
    await ledger.sendMessage({ requestId: requestId('start-live'), workspaceId: alpha, channelRef: channelB,
      body: 'Live thread', actor: human })
    await ledger.archiveChannel({ requestId: requestId('archive-a'), workspaceId: alpha, channelRef: channelA, actor: human })

    const live = topicsOf(ledger.messageCenter(human, { workspaceId: alpha, view: 'topics' }))
    expect(live.topics.map(row => row.channelName)).toEqual(['alpha-two'])
    const all = topicsOf(ledger.messageCenter(human, { workspaceId: alpha, view: 'topics', includeArchived: true }))
    expect(all.topics.map(row => row.channelName)).toEqual(['alpha-two', 'alpha-one'])
    expect(() => ledger.messageCenter(human, { workspaceId: alpha, view: 'topics', channelRef: channelA }))
      .toThrow(/is archived and no longer accepts Team work/)
    const opted = topicsOf(ledger.messageCenter(human, { workspaceId: alpha, view: 'topics', channelRef: channelA, includeArchived: true }))
    expect(opted.topics.map(row => row.channelName)).toEqual(['alpha-one'])
  })

  it('reaches a direct Message only through an Agent reader', async () => {
    const { ledger } = await openLedger()
    await seedTeam(ledger)
    const sent = await ledger.sendDm({ requestId: requestId('dm-1'), workspaceId: alpha, recipientMemberId: plannerId,
      body: 'Direct line', actor: scout })
    expect(sent.committed).toBe(true)

    const received = messagesOf(ledger.messageCenter(planner, { workspaceId: alpha, view: 'messages' })).messages
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ via: 'dm', direction: 'received', excerpt: 'Direct line' })
    expect(received[0]!.dmPartner!.name).toBe('scout')
    expect(received[0]!.channelRef).toBeUndefined()
    expect(received[0]!.threadRef).toBeUndefined()
    expect(received[0]!.dmOperationId).toBe(sent.value.receipt.operationId)
    const sender = messagesOf(ledger.messageCenter(scout, { workspaceId: alpha, view: 'messages', direction: 'sent' })).messages
    expect(sender.map(row => row.via)).toEqual(['dm'])
    // The ledger refuses a Human on both sides of a DM, so this view never shows one.
    const humanView = messagesOf(ledger.messageCenter(human, { workspaceId: alpha, view: 'messages' })).messages
    expect(humanView.filter(row => row.via === 'dm')).toEqual([])
  })

  it('answers the same projection from a replay of the operation table', async () => {
    const { ledger, table } = await openLedger()
    const { channelA } = await seedTeam(ledger)
    const started = await ledger.sendMessage({ requestId: requestId('start-replay'), workspaceId: alpha,
      channelRef: channelA, body: 'Replay me @scout', actor: human })
    if (started.value.kind !== 'committed') throw new Error('expected committed start')
    await ledger.readThread({ requestId: requestId('read-replay'), workspaceId: alpha, taskRef: started.value.task!.taskRef, actor: scout })
    await ledger.reply({ requestId: requestId('reply-replay'), workspaceId: alpha, taskRef: started.value.task!.taskRef,
      body: 'Replayed reply', baseRevision: started.value.thread.revision, actor: scout })
    expect(() => ledger.validate()).not.toThrow()

    const liveTopics = ledger.messageCenter(human, { workspaceId: alpha, view: 'topics' })
    const liveMessages = ledger.messageCenter(human, { workspaceId: alpha, view: 'messages' })
    const replayed = new AgentTeamLedger(table)
    expect(replayed.messageCenter(human, { workspaceId: alpha, view: 'topics' })).toEqual(liveTopics)
    expect(replayed.messageCenter(human, { workspaceId: alpha, view: 'messages' })).toEqual(liveMessages)
  })
})
