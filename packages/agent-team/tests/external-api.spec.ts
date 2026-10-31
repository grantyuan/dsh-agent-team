import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { AgentTeamExternalApi } from '../src/external-api.ts'
import type { AgentTeamExternalCore } from '../src/external-api.ts'
import type {
  AgentTeamInbox,
  AgentTeamMemberId,
  AgentTeamSendMessageResult,
  AgentTeamView,
  AgentTeamViewRequest,
} from '../src/types.ts'

/**
 * The gateway is a transport, so these tests pin the transport contract only:
 * route mapping, the two-layer credential model (boot token for join, derived
 * per-Member HMAC for member routes), body validation, and the mapping of
 * ledger rejection kinds onto statuses. The Team facts themselves stay covered
 * by the ledger suites.
 */

const TOKEN = 'boot-secret'
const alpha = 'workspace:alpha' as AgentTeamViewRequest['workspaceId']

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

function memberTokenOf(memberId: string): string {
  return createHmac('sha256', TOKEN).update(memberId).digest('hex')
}

function emptyInbox(): AgentTeamInbox {
  return { humanMemberId: 'member:human' as AgentTeamMemberId, totalUnreadCount: 0, totalDirectCount: 0, items: [], recent: [] }
}

function stubCore(overrides: Partial<AgentTeamExternalCore> = {}): AgentTeamExternalCore {
  return {
    addExternalMember: async () => ({
      receipt: { operationId: 'op:1', occurredAt: '2026-01-01T00:00:00Z', sequence: 1 },
      status: { member: { memberId: 'member:joined' as AgentTeamMemberId, handle: 'newcomer' }, availability: 'unavailable', presence: 'unavailable' },
      workspaceIds: ['workspace:alpha'],
    } as never),
    inboxForMember: () => emptyInbox(),
    viewForMember: () => ({ humanMemberId: 'member:human' }) as AgentTeamView,
    readThreadForMember: async () => ({}) as never,
    threadHistoryForMember: () => ({}) as never,
    sendMessageForMember: async () => ({ kind: 'committed' }) as AgentTeamSendMessageResult,
    replyForMember: async () => ({ kind: 'committed' }) as AgentTeamSendMessageResult,
    heartbeatForMember: async () => ({}) as never,
    dmsForMember: () => ({ dms: [], hasMore: false }),
    dmForMember: async () => ({ receipt: {}, recipient: {}, relayed: true }) as never,
    jobMessageForJob: async (jobId: string) => ({ kind: 'recorded', jobId, deliveredTo: 'channel' }) as never,
    ...overrides,
  }
}

async function startGateway(core: AgentTeamExternalCore): Promise<{ readonly api: AgentTeamExternalApi; readonly port: number }> {
  const api = await new AgentTeamExternalApi(core, { port: 0, token: TOKEN }).start()
  cleanups.push(() => api.stop())
  const port = api.boundPort
  if (port === undefined) throw new Error('gateway did not bind')
  return { api, port }
}

function memberHeaders(memberId: string, token = memberTokenOf(memberId)): Record<string, string> {
  return { 'content-type': 'application/json', 'x-agent-team-member': memberId, authorization: `Bearer ${token}` }
}

function get(port: number, path: string, headers?: Record<string, string>): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, headers === undefined ? {} : { headers })
}

function post(port: number, path: string, headers?: Record<string, string>, body?: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    ...(headers === undefined ? {} : { headers }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

describe('external gateway — static client files', () => {
  it('serves the bundled client script and skill verbatim', async () => {
    const { port } = await startGateway(stubCore())
    const script = await get(port, '/agent-team/client/agent-team.mjs')
    expect(script.status).toBe(200)
    expect(await script.text()).toContain('run_in_background')
    const skill = await get(port, '/agent-team/client/SKILL.md')
    expect(skill.status).toBe(200)
    expect(skill.headers.get('content-type')).toContain('text/markdown')
    expect(await skill.text()).toContain('agent-team-collaborator')
  })

  it('refuses unknown client files', async () => {
    const { port } = await startGateway(stubCore())
    expect((await get(port, '/agent-team/client/boot-token.txt')).status).toBe(404)
  })
})

describe('external gateway — join', () => {
  it('requires the boot token and returns the derived member credential', async () => {
    const addExternalMember = vi.fn(stubCore().addExternalMember)
    const { port } = await startGateway(stubCore({ addExternalMember }))

    const anonymous = await post(port, `/agent-team/${encodeURIComponent(alpha)}/members`, { 'content-type': 'application/json' }, { handle: 'newcomer' })
    expect(anonymous.status).toBe(401)
    const wrongToken = await post(port, `/agent-team/${encodeURIComponent(alpha)}/members`, { 'content-type': 'application/json', authorization: 'Bearer nope' }, { handle: 'newcomer' })
    expect(wrongToken.status).toBe(401)

    const joined = await post(port, `/agent-team/${encodeURIComponent(alpha)}/members`,
      { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, { handle: 'newcomer', description: 'external helper' })
    expect(joined.status).toBe(200)
    const body = await joined.json() as { memberId: string; token: string; workspaceIds: string[] }
    expect(body.memberId).toBe('member:joined')
    expect(body.token).toBe(memberTokenOf('member:joined'))
    expect(body.workspaceIds).toEqual(['workspace:alpha'])
    expect(addExternalMember).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: alpha, handle: 'newcomer', description: 'external helper' }))

    const noHandle = await post(port, `/agent-team/${encodeURIComponent(alpha)}/members`, { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, {})
    expect(noHandle.status).toBe(400)
  })
})

describe('external gateway — member credential', () => {
  it('rejects calls without the paired member header and token', async () => {
    const { port } = await startGateway(stubCore())
    const noHeader = await get(port, `/agent-team/${encodeURIComponent(alpha)}/view`, { authorization: `Bearer ${memberTokenOf('member:a')}` })
    expect(noHeader.status).toBe(401)
    const wrongToken = await get(port, `/agent-team/${encodeURIComponent(alpha)}/view`, memberHeaders('member:a', memberTokenOf('member:b')))
    expect(wrongToken.status).toBe(401)
    const badHex = await get(port, `/agent-team/${encodeURIComponent(alpha)}/view`, memberHeaders('member:a', 'zz-not-hex'))
    expect(badHex.status).toBe(401)
  })
})

describe('external gateway — read routes', () => {
  it('forwards the directory view with the tool-identical flags', async () => {
    const viewForMember = vi.fn(stubCore().viewForMember)
    const { port } = await startGateway(stubCore({ viewForMember }))
    const response = await get(port, `/agent-team/${encodeURIComponent(alpha)}/view`, memberHeaders('member:a'))
    expect(response.status).toBe(200)
    expect(viewForMember).toHaveBeenCalledWith('member:a', expect.objectContaining({ workspaceId: alpha, topLevelOnly: true, includeActivities: false, direction: 'before' }))
  })

  it('parses the inbox limit and rejects a bad one', async () => {
    const inboxForMember = vi.fn(stubCore().inboxForMember)
    const { port } = await startGateway(stubCore({ inboxForMember }))
    await get(port, `/agent-team/${encodeURIComponent(alpha)}/inbox?limit=7`, memberHeaders('member:a'))
    expect(inboxForMember).toHaveBeenCalledWith('member:a', expect.objectContaining({ workspaceId: alpha, limit: 7 }))
    const bad = await get(port, `/agent-team/${encodeURIComponent(alpha)}/inbox?limit=zero`, memberHeaders('member:a'))
    expect(bad.status).toBe(400)
  })

  it('maps thread reads to the core and refuses a request without any ref', async () => {
    const readThreadForMember = vi.fn(stubCore().readThreadForMember)
    const { port } = await startGateway(stubCore({ readThreadForMember }))
    const missing = await post(port, `/agent-team/${encodeURIComponent(alpha)}/threads/read`, memberHeaders('member:a'), {})
    expect(missing.status).toBe(400)
    const read = await post(port, `/agent-team/${encodeURIComponent(alpha)}/threads/read`, memberHeaders('member:a'), { threadRef: 'thread:abc123' })
    expect(read.status).toBe(200)
    expect(readThreadForMember).toHaveBeenCalledWith('member:a', expect.objectContaining({ workspaceId: alpha, threadRef: 'thread:abc123' }))
  })

  it('forwards history paging arguments', async () => {
    const threadHistoryForMember = vi.fn(stubCore().threadHistoryForMember)
    const { port } = await startGateway(stubCore({ threadHistoryForMember }))
    const response = await post(port, `/agent-team/${encodeURIComponent(alpha)}/threads/history`, memberHeaders('member:a'),
      { threadRef: 'thread:abc123', beforeSequence: 40, limit: 10 })
    expect(response.status).toBe(200)
    expect(threadHistoryForMember).toHaveBeenCalledWith('member:a', expect.objectContaining({ threadRef: 'thread:abc123', beforeSequence: 40, limit: 10 }))
  })
})

describe('external gateway — messages', () => {
  it('commits a start and hands the structured outcome through', async () => {
    const { port } = await startGateway(stubCore())
    const response = await post(port, `/agent-team/${encodeURIComponent(alpha)}/messages`, memberHeaders('member:a'),
      { action: 'start', channelRef: 'channel:abc123', body: 'starting work', asTask: true })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ kind: 'committed' })
  })

  it('keeps ledger rejection kinds on 409', async () => {
    const replyForMember = vi.fn(async () => ({ kind: 'unread_required', threadRef: 'thread:abc123', revision: 9, unreadCount: 2, directCount: 1 }) as never)
    const { port } = await startGateway(stubCore({ replyForMember }))
    const response = await post(port, `/agent-team/${encodeURIComponent(alpha)}/messages`, memberHeaders('member:a'),
      { action: 'reply', threadRef: 'thread:abc123', body: 'premature', baseRevision: 9 })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ kind: 'unread_required', unreadCount: 2 })
  })

  it('refuses replies without a drained-read token and sends with attachments', async () => {
    const { port } = await startGateway(stubCore())
    const noToken = await post(port, `/agent-team/${encodeURIComponent(alpha)}/messages`, memberHeaders('member:a'),
      { action: 'reply', threadRef: 'thread:abc123', body: 'no token' })
    expect(noToken.status).toBe(400)
    const withAttachments = await post(port, `/agent-team/${encodeURIComponent(alpha)}/messages`, memberHeaders('member:a'),
      { action: 'start', channelRef: 'channel:abc123', body: 'x', attachments: ['/tmp/a.png'] })
    expect(withAttachments.status).toBe(400)
  })

  it('reports a DM to a member without a live session as a delivered:false result', async () => {
    const dmForMember = vi.fn(async () => ({ kind: 'dm-sent', recipientMemberId: 'member:sleepy', recipientHandle: 'sleepy', delivered: false, deliveryNote: 'no live session' }) as never)
    const { port } = await startGateway(stubCore({ dmForMember }))
    const response = await post(port, `/agent-team/${encodeURIComponent(alpha)}/messages`, memberHeaders('member:a'),
      { action: 'dm', memberRef: 'member:sleepy', body: 'psst' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ kind: 'dm-sent', delivered: false })
  })

  it('namespaces clientRequestId per member and repeats it for retries', async () => {
    const sendMessageForMember = vi.fn(stubCore().sendMessageForMember)
    const { port } = await startGateway(stubCore({ sendMessageForMember }))
    const payload = { action: 'start', channelRef: 'channel:abc123', body: 'retry me', clientRequestId: 'attempt-1' }
    await post(port, `/agent-team/${encodeURIComponent(alpha)}/messages`, memberHeaders('member:a'), payload)
    await post(port, `/agent-team/${encodeURIComponent(alpha)}/messages`, memberHeaders('member:a'), payload)
    const [first, second] = sendMessageForMember.mock.calls as unknown as [[string, { requestId: string }], [string, { requestId: string }]]
    expect(first![1].requestId).toBe(`agent-team:http:member:a:attempt-1`)
    expect(second![1].requestId).toBe(first![1].requestId)
  })
})

describe('external gateway — heartbeat', () => {
  it('forwards a bounded heartbeat and answers with the stored snapshot', async () => {
    const heartbeatForMember = vi.fn(async () => ({ lastBeatAt: '2026-01-01T00:00:00Z', note: 'working' }) as never)
    const { port } = await startGateway(stubCore({ heartbeatForMember }))
    const response = await post(port, `/agent-team/${encodeURIComponent(alpha)}/heartbeat`, memberHeaders('member:a'),
      { note: 'working', entries: [{ role: 'user', text: 'fix the bug' }, { role: 'assistant', text: 'on it' }] })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ lastBeatAt: '2026-01-01T00:00:00Z' })
    expect(heartbeatForMember).toHaveBeenCalledWith('member:a', { note: 'working', entries: [{ role: 'user', text: 'fix the bug' }, { role: 'assistant', text: 'on it' }] })
  })

  it('refuses an oversized note, too many turns, or a malformed entry with 400', async () => {
    const heartbeatForMember = vi.fn(stubCore().heartbeatForMember)
    const { port } = await startGateway(stubCore({ heartbeatForMember }))
    const headers = memberHeaders('member:a')
    const longNote = await post(port, `/agent-team/${encodeURIComponent(alpha)}/heartbeat`, headers, { note: 'x'.repeat(1001) })
    expect(longNote.status).toBe(400)
    const manyTurns = await post(port, `/agent-team/${encodeURIComponent(alpha)}/heartbeat`, headers,
      { entries: Array.from({ length: 31 }, () => ({ role: 'user', text: 'x' })) })
    expect(manyTurns.status).toBe(400)
    const badEntry = await post(port, `/agent-team/${encodeURIComponent(alpha)}/heartbeat`, headers, { entries: [{ role: 'user' }] })
    expect(badEntry.status).toBe(400)
    expect(heartbeatForMember).not.toHaveBeenCalled()
  })
})

describe('external gateway — failure mapping', () => {
  it('maps thrown fences to 403 refused with the recovery message', async () => {
    const viewForMember = vi.fn(() => { throw new Error('Member cannot view another Workspace') })
    const { port } = await startGateway(stubCore({ viewForMember }))
    const response = await get(port, `/agent-team/${encodeURIComponent('workspace:elsewhere')}/view`, memberHeaders('member:a'))
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { kind: 'refused', message: 'Member cannot view another Workspace' } })
  })

  it('answers 404 for unknown routes and 400 for malformed JSON', async () => {
    const { port } = await startGateway(stubCore())
    expect((await get(port, '/agent-team/unknown/route', memberHeaders('member:a'))).status).toBe(404)
    const malformed = await fetch(`http://127.0.0.1:${port}/agent-team/${encodeURIComponent(alpha)}/threads/read`, {
      method: 'POST', headers: memberHeaders('member:a'), body: '{not json',
    })
    expect(malformed.status).toBe(400)
  })
})

describe('external gateway — background job reports', () => {
  it('forwards a job-token report to the Host surface', async () => {
    const jobMessageForJob = vi.fn(async (jobId: string, token: string, body: string) => ({ kind: 'recorded' as const, jobId, deliveredTo: 'channel' as const, seenToken: token, seenBody: body }))
    const { port } = await startGateway(stubCore({ jobMessageForJob }))
    const response = await post(port, `/agent-team/${encodeURIComponent(alpha)}/jobs/job%3Aabc/message`,
      { 'content-type': 'application/json', authorization: 'Bearer jobsecret' }, { body: 'halfway there' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ kind: 'recorded', jobId: 'job:abc' })
    expect(jobMessageForJob).toHaveBeenCalledWith('job:abc', 'jobsecret', 'halfway there')
  })

  it('refuses a report without a bearer, with an empty body, or past the bound', async () => {
    const { port } = await startGateway(stubCore())
    expect((await post(port, `/agent-team/${encodeURIComponent(alpha)}/jobs/job%3A1/message`, { 'content-type': 'application/json' }, { body: 'x' })).status).toBe(401)
    expect((await post(port, `/agent-team/${encodeURIComponent(alpha)}/jobs/job%3A1/message`, { 'content-type': 'application/json', authorization: 'Bearer t' }, { body: '  ' })).status).toBe(400)
    expect((await post(port, `/agent-team/${encodeURIComponent(alpha)}/jobs/job%3A1/message`, { 'content-type': 'application/json', authorization: 'Bearer t' }, { body: 'x'.repeat(2001) })).status).toBe(400)
  })

  it('maps a Host token refusal to 401 so the script can act on it', async () => {
    const { port } = await startGateway(stubCore({
      jobMessageForJob: async () => { throw new Error('the job token does not match this job') },
    }))
    const response = await post(port, `/agent-team/${encodeURIComponent(alpha)}/jobs/job%3A1/message`,
      { 'content-type': 'application/json', authorization: 'Bearer wrong' }, { body: 'x' })
    expect(response.status).toBe(401)
    expect((await response.json()).error.message).toContain('token')
  })
})
