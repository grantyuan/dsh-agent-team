/**
 * The external-agent HTTP gateway: one more transport into the Team Host,
 * beside the Remote (the Web Client) and the member tools (model calls). It
 * serves external harnesses that have no live Session here — they join as
 * Members whose sessions never activate and collaborate by polling. Authority
 * stays in the ledger: every route forwards to a member-keyed Host entry
 * point (see `AgentTeamExternalCore`), and the gateway holds no Team facts of
 * its own.
 *
 * Auth rests on one boot secret. The join route demands the secret as its
 * bearer token; each Member's credential is `HMAC-SHA256(secret, memberId)` —
 * stateless, restart-stable, and per-Member, so one leaked member token
 * cannot act as another. Whoever holds the boot secret can derive any member
 * token: that is the accepted trust model for a single-operator localhost
 * deployment, and binding the listener beyond localhost means accepting it
 * for a wider network.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  AgentTeamAddExternalMemberRequest,
  AgentTeamAddMemberResult,
  AgentTeamDmRequest,
  AgentTeamDmResult,
  AgentTeamInbox,
  AgentTeamMemberId,
  AgentTeamReplyRequest,
  AgentTeamReplyResult,
  AgentTeamRequestId,
  AgentTeamSendMessageRequest,
  AgentTeamSendMessageResult,
  AgentTeamThreadHistory,
  AgentTeamThreadHistoryRequest,
  AgentTeamThreadReadRequest,
  AgentTeamThreadReadResult,
  AgentTeamView,
  AgentTeamViewRequest,
} from './types.ts'

export const EXTERNAL_API_DEFAULT_PORT = 43110

/** Body cap: team messages are prose; 1 MiB covers any legitimate send. */
const MAX_BODY_BYTES = 1024 * 1024

/** The bundle directory whose files the static client endpoints serve. */
const EXTERNAL_CLIENT_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), '..', 'external-client')

/**
 * The member-keyed Host surface the gateway forwards to — the structural
 * subset of the Team Host the gateway actually needs. The Host satisfies it
 * directly; tests substitute a ledger-backed adapter.
 */
export interface AgentTeamExternalCore {
  addExternalMember(request: AgentTeamAddExternalMemberRequest): Promise<AgentTeamAddMemberResult>
  inboxForMember(memberId: AgentTeamMemberId, request: { readonly workspaceId: AgentTeamViewRequest['workspaceId']; readonly limit?: number }): AgentTeamInbox
  viewForMember(memberId: AgentTeamMemberId, request: AgentTeamViewRequest): AgentTeamView
  readThreadForMember(memberId: AgentTeamMemberId, request: AgentTeamThreadReadRequest): Promise<AgentTeamThreadReadResult>
  threadHistoryForMember(memberId: AgentTeamMemberId, request: AgentTeamThreadHistoryRequest): AgentTeamThreadHistory
  sendMessageForMember(memberId: AgentTeamMemberId, request: AgentTeamSendMessageRequest): Promise<AgentTeamSendMessageResult>
  replyForMember(memberId: AgentTeamMemberId, request: AgentTeamReplyRequest): Promise<AgentTeamReplyResult>
  /**
   * DM commit for an external sender. A recipient with no live session yields
   * the recorded-not-delivered outcome (the tool surface's shape), never a
   * thrown delivery error: the gateway maps results to statuses, and a DM
   * that reached the ledger durably is a 200, not a failure.
   */
  dmForMember(memberId: AgentTeamMemberId, request: AgentTeamDmRequest): Promise<AgentTeamDmResult | AgentTeamExternalDmUndelivered>
}

/** One DM that reached the ledger but found no live session to wake. */
export interface AgentTeamExternalDmUndelivered {
  readonly kind: 'dm-sent'
  readonly recipientMemberId: AgentTeamMemberId
  readonly recipientHandle: string
  readonly delivered: false
  readonly deliveryNote: string
}

/** The join response: the caller's durable identity plus its derived credential. */
export interface AgentTeamExternalJoinResult {
  readonly memberId: AgentTeamMemberId
  readonly handle: string
  readonly token: string
  readonly workspaceIds: readonly string[]
}

export interface AgentTeamExternalApiOptions {
  readonly port: number
  readonly token: string
  readonly bind?: string
}

export class AgentTeamExternalApi {
  private server: Server | undefined = undefined

  constructor(private readonly core: AgentTeamExternalCore, private readonly options: AgentTeamExternalApiOptions) {}

  /** Bind and listen; a bind failure propagates so the Host boot fails fast. */
  async start(): Promise<this> {
    const server = createServer((request, response) => {
      this.handle(request, response).catch(error => {
        this.respond(response, 500, { error: { kind: 'internal', message: errorMessage(error) } })
      })
    })
    const bind = this.options.bind ?? '127.0.0.1'
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(this.options.port, bind, resolveListen)
    })
    server.on('error', error => { throw new Error(`agent-team external gateway cannot listen: ${errorMessage(error)}`) })
    this.server = server
    return this
  }

  /** The resolved listen port once bound (an ephemeral port resolves at listen time). */
  get boundPort(): number | undefined {
    const address = this.server?.address()
    return typeof address === 'object' && address !== null ? address.port : undefined
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = undefined
    if (server === undefined) return
    await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
  }

  /** The per-Member credential: stateless, so it survives restarts without a token store. */
  private memberToken(memberId: AgentTeamMemberId): string {
    return createHmac('sha256', this.options.token).update(memberId).digest('hex')
  }

  /** One external operation id, namespaced per Member; `clientRequestId` makes a retried send land once. */
  private requestId(memberId: AgentTeamMemberId, clientRequestId: unknown): AgentTeamRequestId {
    if (clientRequestId === undefined) return `agent-team:http:${memberId}:${randomUUID()}` as AgentTeamRequestId
    if (typeof clientRequestId !== 'string' || /^[\w.-]{1,128}$/.test(clientRequestId) === false) {
      throw new RequestError(400, 'bad-request', 'clientRequestId must be 1-128 characters of [A-Za-z0-9_.-]')
    }
    return `agent-team:http:${memberId}:${clientRequestId}` as AgentTeamRequestId
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const segments = url.pathname.split('/').filter(part => part !== '')
    try {
      // GET /agent-team/client/<file> — the bootstrap downloads; public by design.
      if (request.method === 'GET' && segments[0] === 'agent-team' && segments[1] === 'client' && segments.length === 3) {
        return await this.serveClientFile(segments[2]!, response)
      }
      if (segments[0] !== 'agent-team' || segments[1] === undefined || segments.length < 3) return this.respond(response, 404, { error: { kind: 'not-found', message: 'unknown route' } })
      const workspaceId = decodeURIComponent(segments[1]!) as AgentTeamViewRequest['workspaceId']
      if (request.method === 'POST' && segments[2] === 'members' && segments.length === 3) {
        return await this.join(workspaceId, request, response)
      }
      const memberId = this.authenticate(request)
      if (request.method === 'GET' && segments[2] === 'view' && segments.length === 3) {
        // The directory flags mirror the team_view tool exactly, so an
        // external caller reads the same bounded address book a model reads.
        return this.respond(response, 200, this.core.viewForMember(memberId, { workspaceId, topLevelOnly: true, includeActivities: false, direction: 'before' } as AgentTeamViewRequest))
      }
      if (request.method === 'GET' && segments[2] === 'inbox' && segments.length === 3) {
        const limit = url.searchParams.get('limit')
        return this.respond(response, 200, this.core.inboxForMember(memberId, {
          workspaceId, ...(limit === null ? {} : { limit: this.positiveInt(limit, 'limit') }),
        }))
      }
      if (request.method === 'POST' && segments[2] === 'threads' && segments.length === 4) {
        const body = await this.readJsonBody(request)
        if (segments[3] === 'read') return this.respond(response, 200, await this.core.readThreadForMember(memberId, this.threadRequest(memberId, workspaceId, body)))
        if (segments[3] === 'history') {
          const beforeSequence = this.optionalPositiveInt(body.beforeSequence, 'beforeSequence')
          const limit = this.optionalPositiveInt(body.limit, 'limit')
          return this.respond(response, 200, this.core.threadHistoryForMember(memberId, {
            ...this.threadRequest(memberId, workspaceId, body),
            ...(beforeSequence === undefined ? {} : { beforeSequence }),
            ...(limit === undefined ? {} : { limit }),
          }))
        }
      }
      if (request.method === 'POST' && segments[2] === 'messages' && segments.length === 3) {
        return await this.sendMessage(memberId, workspaceId, await this.readJsonBody(request), response)
      }
      this.respond(response, 404, { error: { kind: 'not-found', message: 'unknown route' } })
    } catch (error) {
      if (error instanceof RequestError) return this.respond(response, error.status, { error: { kind: error.kind, message: error.message } })
      // A thrown Host fence is a refusal the caller can act on; the message
      // carries the recovery route exactly as the tool renders do.
      this.respond(response, 403, { error: { kind: 'refused', message: errorMessage(error) } })
    }
  }

  /** Constant-time credential checks; the member header and bearer must pair. */
  private authenticate(request: IncomingMessage): AgentTeamMemberId {
    const memberId = request.headers['x-agent-team-member']
    const bearer = this.bearerOf(request)
    if (typeof memberId !== 'string' || memberId === '' || bearer === undefined) throw new RequestError(401, 'unauthorized', 'send X-Agent-Team-Member and a Bearer member token')
    const expected = Buffer.from(this.memberToken(memberId as AgentTeamMemberId), 'hex')
    let provided: Buffer
    try {
      provided = Buffer.from(bearer, 'hex')
    } catch {
      throw new RequestError(401, 'unauthorized', 'the member token is not valid hexadecimal')
    }
    if (provided.length !== expected.length || timingSafeEqual(provided, expected) === false) {
      throw new RequestError(401, 'unauthorized', 'the member token does not match this member; join again or ask the operator')
    }
    return memberId as AgentTeamMemberId
  }

  private bearerOf(request: IncomingMessage): string | undefined {
    const header = request.headers.authorization
    if (typeof header !== 'string' || header.startsWith('Bearer ') === false) return undefined
    const token = header.slice('Bearer '.length).trim()
    return token === '' ? undefined : token
  }

  private async join(workspaceId: AgentTeamViewRequest['workspaceId'], request: IncomingMessage, response: ServerResponse): Promise<void> {
    const bearer = this.bearerOf(request)
    const expected = Buffer.from(this.options.token)
    if (bearer === undefined || bearer.length !== expected.length || timingSafeEqual(Buffer.from(bearer), expected) === false) {
      throw new RequestError(401, 'unauthorized', 'join requires the operator boot token as its Bearer credential')
    }
    const body = await this.readJsonBody(request)
    const handle = body.handle
    if (typeof handle !== 'string' || handle.trim() === '') throw new RequestError(400, 'bad-request', 'join requires a non-empty handle')
    const joinRequest: AgentTeamAddExternalMemberRequest = {
      requestId: `agent-team:http:join:${randomUUID()}` as AgentTeamRequestId,
      workspaceId,
      handle,
      ...(typeof body.description === 'string' ? { description: body.description } : {}),
      ...(Array.isArray(body.channelRefs) ? { channelRefs: body.channelRefs.filter((ref): ref is string => typeof ref === 'string') as unknown as NonNullable<AgentTeamAddExternalMemberRequest['channelRefs']> } : {}),
    }
    const result = await this.core.addExternalMember(joinRequest)
    this.respond(response, 200, {
      memberId: result.status.member.memberId,
      handle: result.status.member.handle,
      token: this.memberToken(result.status.member.memberId),
      workspaceIds: result.workspaceIds,
    } satisfies AgentTeamExternalJoinResult)
  }

  private async sendMessage(memberId: AgentTeamMemberId, workspaceId: AgentTeamViewRequest['workspaceId'], body: Record<string, unknown>, response: ServerResponse): Promise<void> {
    if (body.attachments !== undefined) throw new RequestError(400, 'bad-request', 'attachments are not supported over the gateway yet; share file paths in the body instead')
    const clientRequestId = body.clientRequestId
    if (body.action === 'start') {
      if (typeof body.channelRef !== 'string' || typeof body.body !== 'string' || body.body.trim() === '') {
        throw new RequestError(400, 'bad-request', 'start requires channelRef and a non-empty body')
      }
      const parentTaskRef = typeof body.parentTaskRef === 'string' ? body.parentTaskRef as NonNullable<AgentTeamSendMessageRequest['parentTaskRef']> : undefined
      const request: AgentTeamSendMessageRequest = {
        requestId: this.requestId(memberId, clientRequestId),
        workspaceId,
        channelRef: body.channelRef as NonNullable<AgentTeamSendMessageRequest['channelRef']>,
        body: body.body,
        asTask: body.asTask === true,
        ...(parentTaskRef === undefined ? {} : { parentTaskRef }),
        ...(body.keepContext === true ? { keepContext: true } : {}),
      }
      return this.messageOutcome(await this.core.sendMessageForMember(memberId, request), response)
    }
    if (body.action === 'dm') {
      if (typeof body.memberRef !== 'string' || typeof body.body !== 'string' || body.body.trim() === '') {
        throw new RequestError(400, 'bad-request', 'dm requires memberRef and a non-empty body')
      }
      const request: AgentTeamDmRequest = {
        requestId: this.requestId(memberId, clientRequestId),
        workspaceId,
        recipientMemberId: body.memberRef as NonNullable<AgentTeamDmRequest['recipientMemberId']>,
        body: body.body,
      }
      return this.respond(response, 200, await this.core.dmForMember(memberId, request))
    }
    if (typeof body.body !== 'string' || body.body.trim() === '' || typeof body.baseRevision !== 'number'
      || !Number.isSafeInteger(body.baseRevision) || body.baseRevision < 1) {
      throw new RequestError(400, 'bad-request', 'reply requires a non-empty body and a positive baseRevision from a fully drained read')
    }
    if (typeof body.threadRef !== 'string' && typeof body.taskRef !== 'string') {
      throw new RequestError(400, 'bad-request', 'reply requires threadRef (or taskRef)')
    }
    const request: AgentTeamReplyRequest = {
      requestId: this.requestId(memberId, clientRequestId),
      workspaceId,
      ...(typeof body.threadRef === 'string' ? { threadRef: body.threadRef as NonNullable<AgentTeamReplyRequest['threadRef']> } : {}),
      ...(typeof body.taskRef === 'string' ? { taskRef: body.taskRef as NonNullable<AgentTeamReplyRequest['taskRef']> } : {}),
      ...(body.keepContext === true ? { keepContext: true } : {}),
      body: body.body,
      baseRevision: body.baseRevision,
    }
    return this.messageOutcome(await this.core.replyForMember(memberId, request), response)
  }

  /** A committed send is 200; every ledger rejection keeps its kind on 409. */
  private messageOutcome(result: AgentTeamSendMessageResult | AgentTeamReplyResult, response: ServerResponse): void {
    if (result.kind === 'committed') return this.respond(response, 200, result)
    this.respond(response, 409, result)
  }

  private threadRequest(memberId: AgentTeamMemberId, workspaceId: AgentTeamViewRequest['workspaceId'], body: Record<string, unknown>): AgentTeamThreadReadRequest {
    if (typeof body.threadRef !== 'string' && typeof body.taskRef !== 'string') {
      throw new RequestError(400, 'bad-request', 'thread routes require threadRef (or taskRef)')
    }
    return {
      requestId: this.requestId(memberId, body.clientRequestId),
      workspaceId,
      ...(typeof body.threadRef === 'string' ? { threadRef: body.threadRef as NonNullable<AgentTeamThreadReadRequest['threadRef']> } : {}),
      ...(typeof body.taskRef === 'string' ? { taskRef: body.taskRef as NonNullable<AgentTeamThreadReadRequest['taskRef']> } : {}),
    }
  }

  private async serveClientFile(name: string, response: ServerResponse): Promise<void> {
    if (name !== 'agent-team.mjs' && name !== 'SKILL.md') {
      return this.respond(response, 404, { error: { kind: 'not-found', message: 'unknown client file' } })
    }
    try {
      const body = await readFile(join(EXTERNAL_CLIENT_DIRECTORY, name))
      response.writeHead(200, { 'content-type': name.endsWith('.md') ? 'text/markdown; charset=utf-8' : 'text/javascript; charset=utf-8' })
      response.end(body)
    } catch {
      this.respond(response, 404, { error: { kind: 'not-found', message: 'client file is not installed with this bundle' } })
    }
  }

  private async readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of request) {
      size += (chunk as Buffer).length
      if (size > MAX_BODY_BYTES) throw new RequestError(413, 'payload-too-large', 'the request body exceeds 1 MiB')
      chunks.push(chunk as Buffer)
    }
    const raw = Buffer.concat(chunks).toString('utf8')
    if (raw.trim() === '') return {}
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new RequestError(400, 'bad-request', 'the request body must be a JSON object')
      return parsed as Record<string, unknown>
    } catch (error) {
      if (error instanceof RequestError) throw error
      throw new RequestError(400, 'bad-request', `the request body is not valid JSON: ${errorMessage(error)}`)
    }
  }

  private positiveInt(value: string, field: string): number {
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed < 1) throw new RequestError(400, 'bad-request', `${field} must be a positive integer`)
    return parsed
  }

  private optionalPositiveInt(value: unknown, field: string): number | undefined {
    if (value === undefined) return undefined
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new RequestError(400, 'bad-request', `${field} must be a positive integer`)
    return value
  }

  private respond(response: ServerResponse, status: number, body: unknown): void {
    if (response.writableEnded) return
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(body, undefined, 2))
  }
}

/** A client-visible rejection with its HTTP status decided at the boundary. */
export class RequestError extends Error {
  constructor(readonly status: number, readonly kind: string, message: string) {
    super(message)
    this.name = 'RequestError'
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
