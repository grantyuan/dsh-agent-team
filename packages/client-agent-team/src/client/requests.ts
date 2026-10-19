import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  AgentTeamAttachmentId, AgentTeamPutAttachmentRequest, AgentTeamPutAttachmentResult, AgentTeamRequestId,
  AgentTeamThreadReadRequest, AgentTeamThreadReadResult,
} from '@wowyuarm/dsh-agent-team/types'
import { bytesToBase64 } from './attachment-preview.ts'

/** Fresh idempotency identity for one Client-initiated durable request. */
export const mintRequestId = (): AgentTeamRequestId => crypto.randomUUID() as AgentTeamRequestId

/**
 * One read acknowledges at most a bounded batch, so this caps a Thread whose
 * backlog grows faster than it is read. It is the count of reads, not of facts:
 * a reader never meets it outside a feed that outruns them.
 */
const MAX_DRAIN_ROUNDS = 50

/**
 * Read one Thread through until the reader holds nothing unread on it — the one
 * durable read behind 「已读」, behind opening a Thread, and behind the read that
 * every Thread write needs first, because the Host refuses a write while the
 * writer still holds unread work. The revision a drained read returns is what a
 * caller fences its write against; `refused` carries the Host's own message,
 * and `capped` means the backlog outran the loop.
 */
export const drainThreadUnread = async (
  readThread: (request: AgentTeamThreadReadRequest) => Promise<RemoteResult<AgentTeamThreadReadResult>>,
  request: Omit<AgentTeamThreadReadRequest, 'requestId'>,
): Promise<{ readonly kind: 'drained'; readonly revision: AgentTeamThreadReadResult['thread']['revision'] } | { readonly kind: 'refused'; readonly message: string } | { readonly kind: 'capped' }> => {
  for (let round = 1; round <= MAX_DRAIN_ROUNDS; round += 1) {
    const result = await readThread({ requestId: mintRequestId(), ...request })
    if (!result.ok) return { kind: 'refused', message: result.error.message }
    if (result.value.remainingUnreadCount <= 0) return { kind: 'drained', revision: result.value.thread.revision }
  }
  return { kind: 'capped' }
}

/**
 * Upload composer files in order. One failure stops with the error text; the
 * caller keeps its chips so a retry uploads only the still-pending files.
 */
export const uploadComposerFiles = async (
  putAttachment: (request: AgentTeamPutAttachmentRequest) => Promise<RemoteResult<AgentTeamPutAttachmentResult>>,
  workspaceId: AgentTeamPutAttachmentRequest['workspaceId'],
  files: readonly File[],
): Promise<{ ok: true; attachmentIds: readonly AgentTeamAttachmentId[] } | { ok: false; error: string }> => {
  const attachmentIds: AgentTeamAttachmentId[] = []
  for (const file of files) {
    const uploaded = await putAttachment({
      requestId: mintRequestId(), workspaceId,
      name: file.name,
      mediaType: file.type === '' ? undefined : file.type,
      bytesBase64: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
    })
    if (!uploaded.ok) return { ok: false, error: uploaded.error.message }
    attachmentIds.push(uploaded.value.attachmentId)
  }
  return { ok: true, attachmentIds }
}
