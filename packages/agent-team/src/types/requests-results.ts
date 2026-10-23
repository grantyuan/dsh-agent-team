import type { WorkspaceId } from "@deepseek-ai/dsh-workspace"
import type { SessionId as AgentTeamMemberSessionId, SessionLogOffset as AgentTeamMemberSessionLogOffset, SessionSeq as AgentTeamMemberSessionSeq } from "@deepseek-ai/dsh-session"
import type {
  AgentTeamActivity,
  AgentTeamAgentMember,
  AgentTeamAgentMemberStatus,
  AgentTeamAttachmentId,
  AgentTeamChannel,
  AgentTeamChannelMembership,
  AgentTeamChannelRef,
  AgentTeamClaim,
  AgentTeamClaimActivity,
  AgentTeamClaimRef,
  AgentTeamConfirmationToken,
  AgentTeamContextCheckpointRef,
  AgentTeamDirectMarker,
  AgentTeamInterruptRef,
  AgentTeamInterruptResolution,
  AgentTeamMemberCapabilities,
  AgentTeamMemberId,
  AgentTeamMemberPromptProfile,
  AgentTeamMessage,
  AgentTeamMessageRef,
  AgentTeamModelSelection,
  AgentTeamOperationId,
  AgentTeamRequestId,
  AgentTeamTask,
  AgentTeamTaskActivity,
  AgentTeamTaskRef,
  AgentTeamThread,
  AgentTeamThreadAttention,
  AgentTeamThreadAttentionKey,
  AgentTeamThreadFact,
  AgentTeamThreadReadFact,
  AgentTeamThreadRef,
} from "./entities.ts"

/** Receipt returned after an operation is durable or an identical retry resolves it. */
export interface AgentTeamOperationReceipt {
  readonly operationId: AgentTeamOperationId
  readonly requestId: AgentTeamRequestId
  readonly sequence: number
  /** Wall-clock instant of the committing operation; the one source results carry for optimistic fact instants. */
  readonly occurredAt: string
}

/** Human intent to create a Workspace Channel with its initial Members. */
export interface AgentTeamCreateChannelRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly name: string
  /** Display purpose text; may be empty and filled in later through an edit. */
  readonly description: string
  readonly memberIds?: readonly AgentTeamMemberId[]
}

/** Result of creating or idempotently resolving a Channel and its initial Members. */
export interface AgentTeamCreateChannelResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly channel: AgentTeamChannel
  readonly memberIds: readonly AgentTeamMemberId[]
}

/** Human intent to provision one team-managed Agent Member with initial Channels. */
export interface AgentTeamAddMemberRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly handle: string
  /** Display purpose text; may be empty and filled in later through an edit. */
  readonly description: string
  readonly presetId: string
  /** Absent inherits the Host default model selection. */
  readonly model?: AgentTeamModelSelection
  /** Durable capability intent; see AgentTeamMemberCapabilities. */
  readonly capabilities?: AgentTeamMemberCapabilities
  /** Durable prompt-shaping intent; see AgentTeamMemberPromptProfile. */
  readonly prompt?: AgentTeamMemberPromptProfile
  /** Task-start context policy; absent behaves as `continue`. */
  readonly contextStartPolicy?: 'continue' | 'fresh'
  /** Context-window override in tokens; absent follows the route window. */
  readonly contextWindow?: number
  /** Existing Channels in this Workspace; may be empty — the Member joins Channels later and stays reachable through its DM view. */
  readonly channelRefs: readonly AgentTeamChannelRef[]
}

/** Human intent to rename one Channel's display facts. */
export interface AgentTeamUpdateChannelRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly channelRef: AgentTeamChannelRef
  readonly name: string
  /** Display purpose text; may be empty, matching creation. */
  readonly description: string
}

/** Result of updating or idempotently resolving one Channel's display facts. */
export interface AgentTeamUpdateChannelResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly channel: AgentTeamChannel
}

/** Human intent to archive one Channel: hidden everywhere, facts kept. */
export interface AgentTeamArchiveChannelRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly channelRef: AgentTeamChannelRef
}

/**
 * Result of Channel archival: the Channel is hidden with every fact
 * recoverable. Active Claims on the Channel's Threads were released.
 */
export interface AgentTeamArchiveChannelResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly channel: AgentTeamChannel
  readonly releasedClaims: readonly AgentTeamClaim[]
}

/**
 * Human intent to edit one Member's mutable facts; absent optional facts
 * clear any override. Callers that do not manage capabilities must echo the
 * stored value back, or their edit would silently clear it.
 */
export interface AgentTeamUpdateMemberRequest {
  readonly requestId: AgentTeamRequestId
  readonly memberId: AgentTeamMemberId
  readonly handle: string
  /** Display purpose text; may be empty, matching creation. */
  readonly description: string
  readonly model?: AgentTeamModelSelection
  /** Absent clears any capability override, matching `model`. */
  readonly capabilities?: AgentTeamMemberCapabilities
  /** Absent clears any prompt-profile override, matching `model`. */
  readonly prompt?: AgentTeamMemberPromptProfile
  /** Absent clears the policy override back to continue behavior, matching `model`. */
  readonly contextStartPolicy?: 'continue' | 'fresh'
  /** Absent clears the window override back to route inheritance, matching `model`. */
  readonly contextWindow?: number
  /**
   * Designate or un-designate this Member as the Team's leader — the Member
   * the idle continuation watcher nudges when every Agent is stopped with
   * Tasks still open. Omitted keeps the stored designation.
   */
  readonly leader?: boolean
}

/** Human read of one Member's prompt profile for the Prompt dialog. */
export interface AgentTeamMemberPromptViewRequest {
  readonly memberId: AgentTeamMemberId
}

/**
 * Host view behind the Prompt dialog: the stored prompt profile, the
 * lifecycle facts the dialog renders from, and the stored overrides its
 * durable edit must echo back (absent-clears). The section list, usage
 * projection, and curation surfaces join as optional fields when the
 * prompt-profile work lands them; existing consumers stay source-compatible.
 */
/**
 * One section of a live Member's assembled prompt, as the Prompt dialog
 * renders it. Ticket 04's usage counts extend this shape with per-section
 * fields, so existing consumers stay source-compatible.
 */
export interface AgentTeamMemberPromptSectionEntry {
  readonly name: string
  /** UTF-8 byte length of the assembled text; absent for stale names (no live text). */
  readonly chars?: number
  /** The runtime drop listener removes this section from the Member's next assemblies. */
  readonly dropped: boolean
  /** Refuses drops: persona rows, the custom role paragraph, Team tool guidance. */
  readonly isProtected: boolean
  /** A stored drop the current assembly no longer knows; renders inert. */
  readonly stale: boolean
  /** No current tool name maps to this section ("no automatic signal"). */
  readonly proseOnly: boolean
  /**
   * Mapped tool calls the Member made within the usage window (the last 20
   * completed turns or 14 days, whichever closed first), summed over the
   * section's mapped tools; 0 for prose-only rows. Computed on read, never
   * persisted; absent when no usage fold ran.
   */
  readonly usage?: number
}

export interface AgentTeamMemberPromptView {
  readonly memberId: AgentTeamMemberId
  readonly handle: string
  /** Display purpose text the durable edit re-commits. */
  readonly description: string
  /** Lifecycle state; suspended/archived/inactive Members render read-only. */
  readonly state: AgentTeamAgentMember['state']
  /** Stored prompt profile; absent fields are clear. */
  readonly prompt?: AgentTeamMemberPromptProfile
  /**
   * The Member's live assembled sections (the same assembly its next step
   * gets, read-only) plus inert stale drop entries; absent when the Member
   * has no live session to assemble from.
   */
  readonly sections?: readonly AgentTeamMemberPromptSectionEntry[]
  /**
   * An archived generation could not be read (or the ancestor walk hit its
   * cap) while the usage window was still open: the usage counts cover the
   * readable generations only. Present only when a fold ran and degraded.
   */
  readonly usagePartial?: boolean
  /**
   * Tool-mapped live sections with zero mapped calls inside the usage window —
   * the auto-prune candidate list. Present only while the Member's autoPrune
   * switch is on and the list is non-empty; the dialog's confirm surface
   * renders from it. Prose-only and protected sections never appear here.
   */
  readonly pruneCandidates?: readonly string[]
  /** Stored overrides the dialog's edit echoes verbatim, so absence cannot clear them. */
  readonly model?: AgentTeamModelSelection
  readonly capabilities?: AgentTeamMemberCapabilities
  readonly contextStartPolicy?: 'continue' | 'fresh'
  readonly contextWindow?: number
}

/** Human read of one Member's Session lineage for the session-history dialog. */
export interface AgentTeamMemberSessionsRequest {
  readonly memberId: AgentTeamMemberId
}

/**
 * One Session generation this Member ran, newest first. The current live
 * generation leads; earlier generations are archived logs kept by renewals,
 * rollovers, and restarts. An unreadable ancestor degrades to a flagged entry
 * where the walk stopped — the list never claims depth it could not verify.
 */
export interface AgentTeamMemberSessionSummary {
  readonly sessionId: AgentTeamMemberSessionId
  /** The live generation's Session; the dialog marks it 当前会话. */
  readonly isCurrent: boolean
  /**
   * Handle of the retired predecessor this Session was inherited from through a
   * supervision succession edge. Absent on the Member's own generations; date
   * and count stay the predecessor's own, so the page labels inherited history
   * apart from the successor's live Session.
   */
  readonly predecessorHandle?: string | undefined
  /** Creation instant (Unix ms) from the stored header; absent when unreadable. */
  readonly createdAt?: number
  /** Physical event count (fork-inherited prefix included); absent when unreadable. */
  readonly eventCount?: number
}

/** Human read of one bounded transcript page of one Member Session. */
export interface AgentTeamMemberSessionTranscriptRequest {
  readonly memberId: AgentTeamMemberId
  readonly sessionId: AgentTeamMemberSessionId
  /** Return only entries with a seq below this cursor; absent starts at the newest. */
  readonly beforeSeq?: number
}

/** One model-visible transcript line of one Member Session. */
export interface AgentTeamMemberSessionTranscriptEntry {
  readonly seq: number
  /** Wall-clock instant of the event (Unix ms). */
  readonly time: number
  /**
   * `system` is the rendered system prompt, `team` a Member-to-Member relay,
   * and `notice` a Host-injected Team notice or context envelope; the rest
   * are the ordinary conversation lanes. `error` and `warning` are outcomes
   * the stored log records outside the message surface — a turn that failed,
   * was cancelled or blocked, a model attempt that committed no reply, a
   * tool's structured failure — so the review page shows the whole real
   * process, not just the messages. The Human review surface renders every
   * role, and Markdown-bearing roles keep their line breaks.
   */
  readonly role: 'system' | 'notice' | 'team' | 'user' | 'assistant' | 'tool-call' | 'tool-result' | 'error' | 'warning'
  /** Bounded text with the stored line breaks kept; per-entry clamped. */
  readonly text: string
}

export interface AgentTeamMemberSessionTranscript {
  /** Chronological page (oldest first) of this generation's own events. */
  readonly entries: readonly AgentTeamMemberSessionTranscriptEntry[]
  /** An earlier page exists; pass `nextBeforeSeq` as the next request's cursor. */
  readonly hasEarlier: boolean
  readonly nextBeforeSeq?: number
}

/** Human intent to have the LLM draft a prompt curation proposal for one Member. */
export interface AgentTeamCurateMemberPromptRequest {
  readonly memberId: AgentTeamMemberId
  /** The Human's free-text requirements the draft must implement. */
  readonly requirements: string
}

/**
 * The one-shot call's proposed prompt edits. Propose-only: the Host never
 * persists this shape — the dialog backfills from it and the Human commits
 * (or discards) through the normal member update. Names are already
 * Host-validated against the Member's live data (protected sections and
 * unknown skills removed).
 */
export interface AgentTeamCurateMemberPromptProposal {
  /** Live, non-protected sections the LLM proposes removing from the next assemblies. */
  readonly droppedSectionNames?: readonly string[]
  /** A subset of the Member's private skills catalog the LLM proposes enabling. */
  readonly skillsAllow?: readonly string[]
  /** A rewritten custom role paragraph within the durable byte cap. */
  readonly customPrompt?: string
}

export interface AgentTeamCurateMemberPromptResult {
  readonly proposal: AgentTeamCurateMemberPromptProposal
  /** The effective route (pinned model or Host default) the call used. */
  readonly modelUsed: AgentTeamModelSelection
}

/** Human intent to suspend or resume one Agent Member. */
export interface AgentTeamSetMemberStateRequest {
  readonly requestId: AgentTeamRequestId
  readonly memberId: AgentTeamMemberId
}

/** Human intent to archive one Agent Member: hidden everywhere, data kept. */
export interface AgentTeamArchiveMemberRequest {
  readonly requestId: AgentTeamRequestId
  readonly memberId: AgentTeamMemberId
}

/**
 * Result of archival: the Member is hidden with its data recoverable. Active
 * Claims the Member held were released, so those Tasks are no longer stuck
 * in progress behind a hidden Member.
 */
export interface AgentTeamArchiveMemberResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly member: AgentTeamAgentMember
  readonly releasedClaims: readonly AgentTeamClaim[]
  readonly removedAttention: readonly AgentTeamThreadAttentionKey[]
}

/** Result of a Member lifecycle operation. */
export interface AgentTeamMemberResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly status: AgentTeamAgentMemberStatus
}

/** Result of creating a Member: lifecycle status plus the participation set the Host seeded at creation. */
export interface AgentTeamAddMemberResult extends AgentTeamMemberResult {
  /** Workspaces the new Member participates in — creation always seeds exactly the creation Workspace. */
  readonly workspaceIds: readonly WorkspaceId[]
}

/** Operator intent to nudge one error-stopped Member into continuing its work. */
export interface AgentTeamRecoverMemberRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly memberId: AgentTeamMemberId
}

/** Result of a recovery nudge; runtime-only steering, so there is no ledger receipt. */
export interface AgentTeamRecoverMemberResult {
  readonly status: AgentTeamAgentMemberStatus
}

/** Human intent to start one enabled Member's next turn from an empty context. */
export interface AgentTeamClearMemberContextRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly memberId: AgentTeamMemberId
}

/** The Member keeps identity, memory, and binding; its sessionId moves to a fresh Session and the previous log stays archived on disk. */
export interface AgentTeamClearMemberContextResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly status: AgentTeamAgentMemberStatus
}

/**
 * Human intent to have the Team doctor analyze one failed Member. The Host
 * ensures a persistent doctor Member exists (creating or renewing it as
 * needed), starts the analysis from a fresh doctor context, and hands the
 * doctor the failed Member's recent Session transcript as a bounded research
 * subject; the doctor reports its findings back to the Human.
 */
export interface AgentTeamDiagnoseMemberRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly memberId: AgentTeamMemberId
}

/** The doctor Member row after the analysis request was accepted. */
export interface AgentTeamDiagnoseMemberResult {
  readonly status: AgentTeamAgentMemberStatus
}

/**
 * What one Member's periodic supervision reads, as any fellow Member may see
 * it through the team_supervise tool: the pass state, the current presence,
 * the recorded failure diagnostic, and the windowed failure count the policy
 * acts on.
 */
export interface AgentTeamSupervisionStatus {
  readonly memberId: AgentTeamMemberId
  readonly handle: string
  /** The pass state: healthy, mid-transition/running, or abnormally stopped. */
  readonly state: 'healthy' | 'settling' | 'stopped'
  readonly presence: 'available' | 'working' | 'error' | 'unavailable'
  /** The recorded failure diagnostic (runtime, compaction, or activation), when any. */
  readonly diagnostic?: string
  /** `agent/error` occurrences inside the supervision failure window (20 minutes). */
  readonly recentFailureCount: number
  /** The window, in whole minutes, that {@link recentFailureCount} counts in. */
  readonly failureWindowMinutes: number
}

/** A Member-actor request to reset one abnormal fellow Member's context. */
export interface AgentTeamResetMemberRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly memberId: AgentTeamMemberId
}

/** The reset Member row after the forced context reset was committed. */
export interface AgentTeamResetMemberResult {
  readonly status: AgentTeamAgentMemberStatus
}

/**
 * Human intent to compact one enabled Member's live Session in place. The
 * Host schedules the compaction behind the Member's current activity: it runs
 * at the next true idle boundary through the public CompactionEngine, and
 * input that arrives meanwhile queues and is served after it — the request
 * neither interrupts a running turn nor blocks later conversation.
 */
export interface AgentTeamCompactMemberContextRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly memberId: AgentTeamMemberId
  /** The LLM that writes the summary; absent falls back to the Member's own routed model. */
  readonly model?: AgentTeamModelSelection
}

/** Schedule-time acknowledgement: the result carries the Member status at scheduling, not the compaction outcome. */
export interface AgentTeamCompactMemberContextResult {
  readonly status: AgentTeamAgentMemberStatus
}

/**
 * Member-authored intent (carried by its live Agent) to continue in its next
 * private context generation. The requestId and new Session id derive stably
 * from the successful `context_rollover` tool call so crash replay converges on
 * one operation and one generation.
 */
export interface AgentTeamRolloverSessionRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly memberId: AgentTeamMemberId
  /** The Session the Member must still be bound to at commit time. */
  readonly previousSessionId: AgentTeamMemberSessionId
  /** The next generation Session, derived from the successful tool call. */
  readonly newSessionId: AgentTeamMemberSessionId
  /** Seq of the successful `context_rollover` tool result in the previous Session log. */
  readonly handoffEventSeq: AgentTeamMemberSessionSeq
  /** Why the rollover happened: the model asked, or ('pressure') a historical Host order no longer produced. */
  readonly trigger: 'model' | 'pressure'
  /** Seed source Session for a checkpoint return; absent on a fresh rollover. */
  readonly sourceSessionId?: AgentTeamMemberSessionId
  /** Exclusive end of the seeded source prefix (its exact length in the source log). */
  readonly sourceThroughSeq?: AgentTeamMemberSessionLogOffset
  /** The checkpoint a return was addressed to; absent on a fresh rollover. */
  readonly checkpointRef?: AgentTeamContextCheckpointRef
}

export interface AgentTeamRolloverSessionResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly member: AgentTeamAgentMember
}

/** Human intent to remove one Agent Member from one Channel. */
export interface AgentTeamRemoveChannelMemberRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly channelRef: AgentTeamChannelRef
  readonly memberId: AgentTeamMemberId
}

/** Result of Channel-scoped member cleanup. */
export interface AgentTeamRemoveChannelMemberResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly channelRef: AgentTeamChannelRef
  readonly memberId: AgentTeamMemberId
  readonly releasedClaims: readonly AgentTeamClaim[]
  readonly removedAttention: readonly AgentTeamThreadAttentionKey[]
}

/** Human intent to join one Agent Member to one additional Workspace. */
export interface AgentTeamJoinWorkspaceRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly memberId: AgentTeamMemberId
}

export interface AgentTeamJoinWorkspaceResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly memberId: AgentTeamMemberId
  readonly workspaceId: WorkspaceId
}

/**
 * Human intent to withdraw one Agent Member from one of its non-default
 * Workspaces: participation ends, Workspace-scoped Claims release, and the
 * Member's Attention/markers on that Workspace's Threads clear.
 */
export interface AgentTeamLeaveWorkspaceRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly memberId: AgentTeamMemberId
}

export interface AgentTeamLeaveWorkspaceResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly memberId: AgentTeamMemberId
  readonly workspaceId: WorkspaceId
  readonly releasedClaims: readonly AgentTeamClaim[]
  readonly removedAttention: readonly AgentTeamThreadAttentionKey[]
}

/** Human intent to add one Agent Member to one Channel. */
export interface AgentTeamJoinChannelRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly channelRef: AgentTeamChannelRef
  readonly memberId: AgentTeamMemberId
}

export interface AgentTeamJoinChannelResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly channelRef: AgentTeamChannelRef
  readonly memberId: AgentTeamMemberId
}

/** Intent to create one top-level Message and Thread, with an optional Task. */
export interface AgentTeamSendMessageRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly channelRef: AgentTeamChannelRef
  readonly body: string
  readonly recipients?: readonly AgentTeamMemberId[]
  /** Uploaded attachments to reference; the Host resolves and verifies each id. */
  readonly attachments?: readonly AgentTeamAttachmentId[] | undefined
  /**
   * Agent-supplied absolute file paths; the Host validates each one, copies the
   * bytes into the attachment cache, and turns them into the same metadata.
   */
  readonly attachmentPaths?: readonly string[] | undefined
  readonly confirmationToken?: AgentTeamConfirmationToken
  /**
   * When false, create a taskless Thread. Omitted/true keeps the released-client
   * atomic Message+Thread+Task path. New composer/tool seams pass false explicitly.
   */
  readonly asTask?: boolean
  /**
   * Create the Task as an Agent-split sub-task of this Task. Optional, and
   * only meaningful with a Task creation (asTask omitted or true). Full or
   * unambiguous abbreviated ref; the ledger resolves it inside the workspace
   * and requires the parent to live in the same Channel.
   */
  readonly parentTaskRef?: AgentTeamTaskRef
  /**
   * The sender's fresh-context judgement for the Members this Message names:
   * when true, the fresh-start policy's dispatch gate lets THIS delivery reach
   * their live Session instead of renewing them first. A Host-consumed delivery
   * intent only — never a durable Team fact, so the ledger records nothing.
   */
  readonly keepContext?: boolean
}

/** Upload one composer attachment into the Team attachment cache. */
export interface AgentTeamPutAttachmentRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly name: string
  readonly mediaType?: string | undefined
  readonly bytesBase64: string
}

export interface AgentTeamPutAttachmentResult {
  readonly attachmentId: AgentTeamAttachmentId
  /** Absolute path members read the bytes from; stable for the cache lifetime. */
  readonly path: string
  readonly name: string
  readonly byteSize: number
  readonly mediaType: string
}

/** Read one uploaded attachment back for client-side display. */
export interface AgentTeamGetAttachmentRequest {
  readonly attachmentId: AgentTeamAttachmentId
}

export interface AgentTeamGetAttachmentResult {
  readonly name: string
  readonly mediaType: string
  readonly byteSize: number
  readonly bytesBase64: string
}

/** Human profile read: name + avatar reference + version footnote facts. */
export interface AgentTeamHumanProfileRequest {
}

export interface AgentTeamHumanProfileResult {
  readonly name: string
  readonly avatarRef?: string | undefined
  /** Bundle version shown in the settings footnote. */
  readonly version: string
  /** Repository home the footnote links to. */
  readonly repoUrl: string
  /**
   * Whether a newer release is known. Best-effort and cached Host-side
   * (npm `latest`, 12 h TTL, silent on any failure), so this stays false
   * until a background refresh actually observes one; the footnote shows
   * only the version + link until then.
   */
  readonly updateAvailable: boolean
  readonly latestVersion?: string | undefined
}

/** Local environment read: how the running DSH compares to the declared support line. */
export interface AgentTeamEnvironmentRequest {
}

/**
 * The one of three shapes the page renders. `undetermined` is the answer for
 * every fact this Host cannot establish — an unreadable runtime version, a
 * support range the manifest does not state — and never a guessed verdict; its
 * two causes are not distinguished to the reader, only recorded in `reason`.
 */
export type AgentTeamEnvironmentVerdict = 'ok' | 'out-of-range' | 'undetermined'

/** Declared DSH support line, stated in words by the page rather than as a range string. */
export interface AgentTeamEnvironmentSupportRange {
  /** Lower bound of the declared range, which is also the certified baseline. */
  readonly lower: string
  /** Exclusive upper bound of the declared range. */
  readonly upper: string
}

export interface AgentTeamEnvironmentResult {
  readonly verdict: AgentTeamEnvironmentVerdict
  /** Host-side diagnostic behind an `undetermined` verdict; not rendered as user copy. */
  readonly reason?: string | undefined
  // Every fact below is optional by contract: a missing one is never a
  // mismatch, it only withholds the line that would have stated it.
  /** Version of the bundle this Host runs from. */
  readonly bundleVersion?: string | undefined
  /**
   * The running DSH version, which is what the page states it is running.
   * Distinct from `certifiedDshVersion`: one is the environment, the other is
   * the line this bundle declares support for.
   */
  readonly dshVersion?: string | undefined
  /** Lower bound of the declared range: the certified, actually-tested DSH line. */
  readonly certifiedDshVersion?: string | undefined
  readonly supportRange?: AgentTeamEnvironmentSupportRange | undefined
}

/**
 * Human profile write: the fields the Client supplies, each one optional and
 * independent of the others.
 */
export interface AgentTeamSetHumanProfileRequest {
  /** New display name; omitted keeps the current one. */
  readonly name?: string | undefined
  /**
   * New avatar reference; `null` clears the stored one and omitted keeps it.
   * Clearing needs its own shape because a merge patch cannot remove a field.
   */
  readonly avatarRef?: string | null | undefined
}

/** Resolved Human profile after a write; the same two fields the read returns. */
export interface AgentTeamSetHumanProfileResult {
  readonly name: string
  readonly avatarRef?: string | undefined
}

/** Upload one human avatar image into the persistent avatar store. */
export interface AgentTeamPutHumanAvatarRequest {
  readonly name: string
  readonly mediaType?: string | undefined
  readonly bytesBase64: string
}

export interface AgentTeamPutHumanAvatarResult {
  readonly avatarRef: string
  /** Absolute path members read the bytes from; stable until removed. */
  readonly path: string
  readonly name: string
  readonly byteSize: number
  readonly mediaType: string
}

/** Read one human avatar back for client-side display. */
export interface AgentTeamGetHumanAvatarRequest {
  readonly avatarRef: string
}

export interface AgentTeamGetHumanAvatarResult {
  readonly name: string
  readonly mediaType: string
  readonly byteSize: number
  readonly bytesBase64: string
}

/** Remove one human avatar entry; the profile falls back to hue/initial. */
export interface AgentTeamRemoveHumanAvatarRequest {
  readonly avatarRef: string
}

export interface AgentTeamRemoveHumanAvatarResult {
  readonly removed: boolean
}

/** Intent to append one public Message to an existing Thread. */
export interface AgentTeamReplyRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly threadRef?: AgentTeamThreadRef
  readonly taskRef?: AgentTeamTaskRef
  readonly body: string
  readonly baseRevision: number
  readonly recipients?: readonly AgentTeamMemberId[]
  /** Agent-supplied absolute file paths, resolved like sendMessage's. */
  readonly attachmentPaths?: readonly string[] | undefined
  /** Attachment cache IDs from the Human picker, resolved like sendMessage's. */
  readonly attachments?: readonly AgentTeamAttachmentId[] | undefined
  readonly confirmationToken?: AgentTeamConfirmationToken
  /**
   * Same sender-side fresh-context judgement as
   * {@link AgentTeamSendMessageRequest.keepContext}: when true, the Members
   * this reply names keep their live Session for this delivery instead of
   * being renewed by the dispatch gate.
   */
  readonly keepContext?: boolean
}

/** A Human must send the same invitation one more time with this token. */
export interface AgentTeamConfirmationRequired {
  readonly kind: 'confirmation_required'
  readonly confirmationToken: AgentTeamConfirmationToken
  readonly workspaceId: WorkspaceId
  readonly channelRef: AgentTeamChannelRef
  readonly recipients: readonly AgentTeamMemberId[]
  readonly taskRef?: AgentTeamTaskRef
  readonly threadRef?: AgentTeamThreadRef
  readonly revision?: number
}

/** Existing unread work must be read before this Thread mutation can proceed. */
export interface AgentTeamUnreadRequired {
  readonly kind: 'unread_required'
  readonly taskRef?: AgentTeamTaskRef
  readonly threadRef: AgentTeamThreadRef
  readonly revision: number
  readonly unreadCount: number
  readonly directCount: number
}

/** A public Thread mutation used an obsolete optimistic-concurrency revision. */
export interface AgentTeamStaleRevision {
  readonly kind: 'stale_revision'
  readonly taskRef?: AgentTeamTaskRef
  readonly threadRef: AgentTeamThreadRef
  readonly expectedRevision: number
  readonly revision: number
}

/** An Agent tried to address an Agent who is not already following. */
export interface AgentTeamMemberNotFollowing {
  readonly kind: 'member_not_following'
  readonly memberIds: readonly AgentTeamMemberId[]
  readonly workspaceId: WorkspaceId
  readonly channelRef: AgentTeamChannelRef
  readonly taskRef?: AgentTeamTaskRef
  readonly threadRef?: AgentTeamThreadRef
  readonly revision?: number
}

export interface AgentTeamSendMessageCommittedResult {
  readonly kind: 'committed'
  readonly receipt: AgentTeamOperationReceipt
  readonly message: AgentTeamMessage
  readonly task?: AgentTeamTask
  readonly thread: AgentTeamThread
  readonly attention: readonly AgentTeamThreadAttention[]
  readonly directMarkers: readonly AgentTeamDirectMarker[]
}

export type AgentTeamSendMessageResult =
  | AgentTeamSendMessageCommittedResult
  | AgentTeamConfirmationRequired
  | AgentTeamMemberNotFollowing

export interface AgentTeamReplyCommittedResult {
  readonly kind: 'committed'
  readonly receipt: AgentTeamOperationReceipt
  readonly message: AgentTeamMessage
  readonly task?: AgentTeamTask
  readonly thread: AgentTeamThread
  readonly attention: readonly AgentTeamThreadAttention[]
  readonly directMarkers: readonly AgentTeamDirectMarker[]
  /**
   * Agents named in the body that this Thread has never carried. The Message
   * still commits; these Members simply receive no notification, and the
   * author is told so it can ask the Human to invite them.
   */
  readonly undeliveredMentions?: readonly AgentTeamMemberId[]
}

export type AgentTeamReplyResult =
  | AgentTeamReplyCommittedResult
  | AgentTeamConfirmationRequired
  | AgentTeamUnreadRequired
  | AgentTeamStaleRevision
  | AgentTeamMemberNotFollowing

/** Human intent to correct the body of one Human-sent Message. */
export interface AgentTeamEditMessageRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly messageRef: AgentTeamMessageRef
  readonly body: string
}

export interface AgentTeamEditMessageResult {
  readonly kind: 'committed'
  readonly receipt: AgentTeamOperationReceipt
  /** The updated Message snapshot; identity facts and the original instant are unchanged. */
  readonly message: AgentTeamMessage
  readonly thread: AgentTeamThread
  /**
   * Members whose in-flight turn the Host force-stopped because it could have
   * been executing the edited instruction. Ledger results omit it — stopping a
   * turn is Host runtime work — and the Host fills it before answering; empty
   * on an idempotent retry, where the stops happened on the first commit.
   */
  readonly stoppedMembers?: readonly AgentTeamMemberId[]
}

/** Human intent to retract or delete one Human-sent Message. */
export interface AgentTeamRecallMessageRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly messageRef: AgentTeamMessageRef
  readonly mode: 'retracted' | 'deleted'
}

export interface AgentTeamRecallMessageResult {
  readonly kind: 'committed'
  readonly receipt: AgentTeamOperationReceipt
  /** The recalled Message snapshot with `recalledAt` stamped; tombstone rendering keys off it. */
  readonly message: AgentTeamMessage
  readonly thread: AgentTeamThread
  /**
   * Members whose in-flight turn the Host force-stopped because it could have
   * been executing the recalled instruction. Ledger results omit it — stopping
   * a turn is Host runtime work — and the Host fills it before answering;
   * empty on an idempotent retry, where the stops happened on the first commit.
   */
  readonly stoppedMembers?: readonly AgentTeamMemberId[]
}

/** Human Task resolution intent. */
export interface AgentTeamTaskRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly taskRef: AgentTeamTaskRef
  readonly action: 'accept' | 'close' | 'reopen'
  readonly baseRevision: number
}

export interface AgentTeamTaskCommittedResult {
  readonly kind: 'committed'
  readonly receipt: AgentTeamOperationReceipt
  readonly activity: AgentTeamTaskActivity
  readonly task: AgentTeamTask
  readonly thread: AgentTeamThread
  readonly claims: readonly AgentTeamClaim[]
}

export type AgentTeamTaskResult =
  | AgentTeamTaskCommittedResult
  | AgentTeamUnreadRequired
  | AgentTeamStaleRevision

/** Human intent to resolve several Tasks in one Host turn: batch acceptance or closing. */
export interface AgentTeamTasksBatchRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly taskRefs: readonly AgentTeamTaskRef[]
  readonly action: 'accept' | 'close'
}

/** One Task's outcome inside a batch. The ledger refuses one Task without blocking the rest. */
export type AgentTeamTaskBatchOutcome =
  | { readonly kind: 'committed'; readonly taskRef: AgentTeamTaskRef; readonly receipt: AgentTeamOperationReceipt; readonly task: AgentTeamTask; readonly thread: AgentTeamThread; readonly activity: AgentTeamTaskActivity }
  | { readonly kind: 'already_resolved'; readonly taskRef: AgentTeamTaskRef; readonly task: AgentTeamTask }
  | { readonly kind: 'failed'; readonly taskRef: AgentTeamTaskRef; readonly reason: string }

/** The batch projection: one outcome per requested Task, in request order, duplicate refs collapsed. */
export interface AgentTeamTasksBatchResult {
  readonly outcomes: readonly AgentTeamTaskBatchOutcome[]
}

/** Human intent to attach a real Task overlay to a taskless Thread. */
export interface AgentTeamPromoteThreadRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly threadRef: AgentTeamThreadRef
  readonly baseRevision: number
}

export interface AgentTeamPromoteThreadCommittedResult {
  readonly kind: 'committed'
  readonly receipt: AgentTeamOperationReceipt
  readonly activity: AgentTeamTaskActivity
  readonly task: AgentTeamTask
  readonly thread: AgentTeamThread
}

export type AgentTeamPromoteThreadResult =
  | AgentTeamPromoteThreadCommittedResult
  | AgentTeamUnreadRequired
  | AgentTeamStaleRevision

/** Human intent to permanently remove one Agent Member. */
export interface AgentTeamRemoveMemberRequest {
  readonly requestId: AgentTeamRequestId
  readonly memberId: AgentTeamMemberId
}

export interface AgentTeamRemoveMemberResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly member: AgentTeamAgentMember
  readonly releasedClaims: readonly AgentTeamClaim[]
  readonly removedAttention: readonly AgentTeamThreadAttentionKey[]
}

/** Personal Thread Attention mutation; it is exempt from public mutation fences. */
export interface AgentTeamThreadAttentionRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly threadRef?: AgentTeamThreadRef
  readonly taskRef?: AgentTeamTaskRef
  readonly action: 'follow' | 'unfollow'
}

/**
 * Agent-only direct message to one enabled Agent Member in the same
 * Workspace. Delivery is pure injection: the ledger records the send, and the
 * recipient's live session receives the body as a relay-form user message.
 */
export interface AgentTeamDmRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly recipientMemberId: AgentTeamMemberId
  readonly body: string
}

export interface AgentTeamDmResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly recipient: AgentTeamAgentMember
}

export interface AgentTeamThreadAttentionResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly task?: AgentTeamTask
  readonly thread: AgentTeamThread
  /** Present after follow, absent after unfollow. */
  readonly attention?: AgentTeamThreadAttention
}

export interface AgentTeamThreadAttentionStatus {
  readonly task?: AgentTeamTask
  readonly thread: AgentTeamThread
  readonly attention?: AgentTeamThreadAttention
}

/** Direction Claim mutation. `baseRevision` fences every non-list public mutation. */
export interface AgentTeamClaimRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly taskRef: AgentTeamTaskRef
  readonly action: 'claim' | 'done' | 'release'
  readonly baseRevision: number
  readonly direction?: string
  readonly claimRef?: AgentTeamClaimRef
}

export interface AgentTeamClaimCommittedResult {
  readonly kind: 'committed'
  readonly receipt: AgentTeamOperationReceipt
  readonly activity: AgentTeamClaimActivity
  readonly claim: AgentTeamClaim
  readonly task: AgentTeamTask
  readonly thread: AgentTeamThread
  readonly attention?: AgentTeamThreadAttention
}

export type AgentTeamClaimResult =
  | AgentTeamClaimCommittedResult
  | AgentTeamUnreadRequired
  | AgentTeamStaleRevision

export interface AgentTeamClaimList {
  readonly task: AgentTeamTask
  readonly thread: AgentTeamThread
  readonly claims: readonly AgentTeamClaim[]
}

/** Read-only, personal Workspace Inbox projection. */
export interface AgentTeamInboxRequest {
  readonly workspaceId: WorkspaceId
  readonly limit?: number
}

/**
 * One person as an Inbox row draws them: the Member id carries the shared
 * identity hue, the handle the initial. A row names who moved a Thread without
 * a per-row Member view, the same way it already carries its Channel's name.
 */
export interface AgentTeamInboxActor {
  readonly memberId: AgentTeamMemberId
  /** Public handle, or the raw Member id when the roster no longer names them. */
  readonly name: string
}

/** One Thread summary containing no Message bodies. */
export interface AgentTeamInboxItem {
  readonly workspaceId: WorkspaceId
  readonly channelRef: AgentTeamChannelRef
  /** The owning Channel's display name, so a row renders without a per-row Channel view. */
  readonly channelName?: string
  readonly task?: AgentTeamTask
  /** The Task's ordinal inside its home Channel; absent on taskless Threads. */
  readonly taskNumber?: number
  readonly thread: AgentTeamThread
  /** Unread facts waiting for this reader; always zero on the 「最近活跃」 slice. */
  readonly unreadCount: number
  /** How many of them name this reader; always zero on the 「最近活跃」 slice. */
  readonly directCount: number
  /**
   * The Thread's opening line, trimmed and capped at 120 characters — the same
   * bound the Thread page applies to its Task title. Row material only: it
   * never reaches model-visible notification text.
   */
  readonly previewText?: string
  /** Instant of the Thread's anchor Message — the row's creation time. */
  readonly createdOccurredAt: string
  /**
   * Instant of the newest reply — the last Message after the anchor, whoever
   * wrote it. Absent while the Thread has no reply yet, and the row falls back
   * to {@link createdOccurredAt} for its visible instant.
   */
  readonly latestReplyOccurredAt?: string
  /** The Member who authored that newest reply, absent together with its instant. */
  readonly latestReplyActor?: AgentTeamInboxActor
  /**
   * Whether the Thread holds something waiting on a Human decision: an open
   * Task awaiting acceptance, or a Message that named the Human with no Human
   * Message after it. Counted against the Human Member specifically, so an
   * Agent reader's rows do not flip on their own mentions.
   */
  readonly needsHumanDecision: boolean
  readonly newestSequence: number
  /** Instant of the newest unread fact — on the 「最近活跃」 slice, of the newest fact. */
  readonly newestOccurredAt: string
  /**
   * Who committed the fact those two fields name — the person waiting for this
   * reader on the queue, and whoever moved the Thread on the tail. Every Thread
   * fact is committed by exactly one actor, so a row always names one.
   */
  readonly newestActor: AgentTeamInboxActor
  /**
   * The people still on this Thread's Task: owners of its live Claims, in claim
   * order, deduped — the same rule, and the same words, the Channel feed's Thread
   * entry row already uses for the same Task. Resolved here because a row draws
   * handles and has no Member view of its own to turn ids into them. Empty on a
   * taskless Thread, and on a done or closed one, whose Claims are history that
   * the state word already tells.
   */
  readonly claimOwners: readonly AgentTeamInboxActor[]
  readonly attention?: AgentTeamThreadAttention
}

export interface AgentTeamInbox {
  /**
   * The ledger's Human Member id — the durable identity a row matches to know
   * which of its actors is the reader, so a seat can draw that one actor from
   * its own Human identity (name and avatar) instead of the row's initials
   * fallback. The same id `AgentTeamView` carries, from the same initialization
   * record.
   */
  readonly humanMemberId: AgentTeamMemberId
  /** The unread queue: every Thread holding at least one unread fact for this reader. */
  readonly items: readonly AgentTeamInboxItem[]
  /**
   * Human readers only: the 「最近活跃」 slice — Threads this reader took part in,
   * newest activity first, at most ten, excluding every Thread the queue above
   * already carries. Agent readers always receive an empty slice, so the
   * model-facing Inbox stays exactly the unread queue.
   */
  readonly recent: readonly AgentTeamInboxItem[]
  readonly totalUnreadCount: number
  readonly totalDirectCount: number
}

/** Human intent to read the Workspace's whole Task list with progress facts. */
export interface AgentTeamTasksRequest {
  readonly workspaceId: WorkspaceId
}

/**
 * One row of the Human Task list: a Task, its Thread identity, and the facts a
 * row draws without a per-row Member or Thread view. Status follows the same
 * derived rule the results and radar use, so the list never disagrees with a
 * Thread heading about where a Task stands.
 */
export interface AgentTeamTaskRow {
  readonly taskRef: AgentTeamTaskRef
  readonly threadRef: AgentTeamThreadRef
  readonly channelRef: AgentTeamChannelRef
  /** The Task's ordinal inside its home Channel. */
  readonly taskNumber: number
  readonly status: AgentTeamTask['status']
  readonly resolution: AgentTeamTask['resolution']
  /** The Thread's opening line, trimmed and capped at 120 characters — the same bound the Inbox row uses. */
  readonly subject: string
  /** Parent Task when this Task is an Agent-split sub-task; absent on top-level Tasks. */
  readonly parentTaskRef?: AgentTeamTaskRef
  /** Owners of the Task's live Claims, in claim order, deduped — the same rule the Inbox row uses. */
  readonly claimOwners: readonly AgentTeamInboxActor[]
  /** Instant of the newest fact on this Thread. */
  readonly lastActivityAt: string
}

/** The Human Task list projection: every Task in the Workspace, newest Channel ordinal last. */
export interface AgentTeamTasks {
  readonly humanMemberId: AgentTeamMemberId
  readonly tasks: readonly AgentTeamTaskRow[]
}

/** Human intent to read every Agent Member's working queue in one Workspace. */
export interface AgentTeamMemberTasksRequest {
  readonly workspaceId: WorkspaceId
}

/**
 * One Member's working queue: the Tasks it currently holds Claims on, and the
 * unclaimed Tasks waiting in its Channels. Rows reuse the Task-list row so a
 * Client renders both surfaces with one grammar.
 */
export interface AgentTeamMemberTaskQueue {
  readonly memberId: AgentTeamMemberId
  /** Open Tasks the Member holds a live (active or done) Claim on, newest activity first. */
  readonly current: readonly AgentTeamTaskRow[]
  /** Unclaimed `todo` Tasks in Channels the Member has joined, Channel ordinal order. */
  readonly queued: readonly AgentTeamTaskRow[]
}

/** The per-Member working-queue projection: one queue per visible Agent Member. */
export interface AgentTeamMemberTasks {
  readonly humanMemberId: AgentTeamMemberId
  readonly queues: readonly AgentTeamMemberTaskQueue[]
}

/** One Direction a Member finished (a `done` Claim) with its Task's position, for the retirement notice. */
export interface AgentTeamCompletedDirection {
  readonly direction: string
  readonly taskRef: AgentTeamTaskRef
  /** The Task's ordinal inside its home Channel; 0 when the Task's Channel is gone. */
  readonly taskNumber: number
  /** The Task's Thread opening line, bounded like an Inbox subject. */
  readonly subject: string
}

/** One Task a Member finished and the Human then accepted or closed, for the retirement notice. */
export interface AgentTeamCompletedTask {
  readonly taskRef: AgentTeamTaskRef
  readonly taskNumber: number
  readonly subject: string
  readonly resolution: 'accepted' | 'closed'
}

/**
 * The finished work one Member left behind, derived from operations — the
 * read-only input the supervision retirement notice draws its completed-work
 * section from. Participation counts Threads the Member wrote a Message in or
 * held a Claim on, the same reach the Inbox's recent slice admits.
 */
export interface AgentTeamCompletedWork {
  /** `done` Claims the Member owned, Task-number order — what it finished doing. */
  readonly finishedDirections: readonly AgentTeamCompletedDirection[]
  /** Tasks the Member finished and that reached Human acceptance or closure. */
  readonly completedTasks: readonly AgentTeamCompletedTask[]
  /** Collaboration Threads the Member took part in. */
  readonly participatedThreadCount: number
}

/** Request to atomically receive and acknowledge one contiguous Thread batch. */
export interface AgentTeamThreadReadRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly threadRef?: AgentTeamThreadRef
  readonly taskRef?: AgentTeamTaskRef
}

/**
 * Private, read-time context guidance for one acceptance the reading Member
 * just acknowledged. Host-computed after the durable read committed; never a
 * ledger fact, never persisted, and absent unless this read acknowledged an
 * unread acceptance of a Task that is still done.
 */
export interface AgentTeamContextAdvice {
  /** Current measured usage of the reading Member's context; absent when unmeasured. */
  readonly usageTokens?: number | undefined
  /** Usage at or above which a fresh rollover is advised; min(128K, handoffAt); absent when unmeasured. */
  readonly taskBoundaryThreshold?: number | undefined
  /** Effective handoff budget of the Member's current route; absent when unmeasured. */
  readonly handoffAt?: number | undefined
  /** Effective hard limit of the Member's current route; absent when unmeasured. */
  readonly hardLimit?: number | undefined
  /** keep | rollover | handoff-now | unavailable. */
  readonly action: 'keep' | 'rollover' | 'handoff-now' | 'unavailable'
  readonly guidance: string
  /**
   * How many interrupted sessions the reading Member has pinned and not yet
   * resumed or released; absent when zero or unmeasurable. A closing Task is
   * the natural moment to run the pre-completion analysis, so the count rides
   * the same private advice instead of a second nudge.
   */
  readonly pendingInterrupts?: number | undefined
}

export interface AgentTeamThreadReadResult {
  /**
   * Receipt of the durable read this response committed; absent when the read
   * made no progress — an already-read Thread whose watermark did not move —
   * so no operation was appended and there is nothing to point at.
   */
  readonly receipt?: AgentTeamOperationReceipt
  readonly task?: AgentTeamTask
  readonly thread: AgentTeamThread
  readonly claims: readonly AgentTeamClaim[]
  readonly anchor: AgentTeamMessage
  /** Structured Member refs of the anchor Message, from its originating send operation. */
  readonly anchorMentions: readonly AgentTeamMemberId[]
  readonly facts: readonly AgentTeamThreadReadFact[]
  readonly readThroughSequence: number
  /** Number of unread facts left after this bounded read. */
  readonly remainingUnreadCount: number
  /**
   * Public Thread facts that precede the watermark this read reaches — where
   * the reader now stands in the Thread, and how much of it that position has
   * never shown it. A returning reader's batch answers with the newest facts
   * alone, so this is the span it is not looking at; the count never depends on
   * whether this particular response happened to carry background. Zero means
   * the Thread holds nothing before the reader's position. Absent on a legacy
   * read snapshot, whose stored shape stays frozen.
   */
  readonly earlierFactCount?: number
  readonly attention?: AgentTeamThreadAttention
  readonly consumedDirectMarkers: readonly AgentTeamDirectMarker[]
  /** Present only when this read acknowledged an unread acceptance of a still-done Task. */
  readonly contextAdvice?: AgentTeamContextAdvice
}

/** Non-mutating Thread history request. */
export interface AgentTeamThreadHistoryRequest {
  readonly workspaceId: WorkspaceId
  readonly threadRef?: AgentTeamThreadRef
  readonly taskRef?: AgentTeamTaskRef
  readonly beforeSequence?: number
  readonly limit?: number
}

export interface AgentTeamThreadHistory {
  readonly task?: AgentTeamTask
  readonly thread: AgentTeamThread
  readonly anchor: AgentTeamMessage
  /** Structured Member refs of the anchor Message, from its originating send operation. */
  readonly anchorMentions: readonly AgentTeamMemberId[]
  readonly claims: readonly AgentTeamClaim[]
  readonly facts: readonly AgentTeamThreadFact[]
  readonly cursor: number
  readonly hasMore: boolean
}

/** Human request for the plain-language digest of one Thread. Ephemeral: it
 * commits nothing, the same propose-only shape as prompt curation. */
export interface AgentTeamSummarizeThreadRequest {
  readonly workspaceId: WorkspaceId
  readonly threadRef: AgentTeamThreadRef
}

/**
 * Plain-language recap of a whole Thread: what was asked, what has happened,
 * and what (if anything) is waiting on the Human. `options` only accompanies a
 * `decisionQuestion` the Thread's own Messages actually put alternatives to.
 */
export interface AgentTeamThreadDigest {
  /** One short plain-language paragraph a reader can act on without opening the timeline. */
  readonly summary: string
  /** The turns that matter, oldest first, each one line. */
  readonly keyPoints: readonly string[]
  readonly needsHumanDecision: boolean
  readonly decisionQuestion?: string
  readonly options?: readonly string[]
  /** Whether the options are mutually exclusive or combinable; absent reads as `single`. */
  readonly optionSelection?: 'single' | 'multiple'
}

export interface AgentTeamSummarizeThreadResult {
  readonly digest: AgentTeamThreadDigest
  /** The Team's configured route the one-shot call used (see the digest routing in the Host). */
  readonly modelUsed: AgentTeamModelSelection
  /** Thread revision the digest was read at, so the Client can cache per revision. */
  readonly revision: number
}

/** Human-only observation of a durable personal Attention change. */
export interface AgentTeamThreadAttentionObservation {
  readonly sequence: number
  readonly threadRef: AgentTeamThreadRef
  readonly taskRef?: AgentTeamTaskRef
  readonly memberId: AgentTeamMemberId
  readonly action: 'follow' | 'unfollow'
}

export interface AgentTeamThreadObservationsRequest {
  readonly workspaceId: WorkspaceId
  readonly threadRef?: AgentTeamThreadRef
  readonly taskRef?: AgentTeamTaskRef
  readonly limit?: number
}

export interface AgentTeamThreadObservations {
  readonly items: readonly AgentTeamThreadAttentionObservation[]
  /** Members whose Attention currently follows the Thread — the state the replayed observations lead to. */
  readonly followers: readonly AgentTeamMemberId[]
}

/** One bounded Workspace view item. */
export interface AgentTeamViewItem {
  readonly message: AgentTeamMessage
  /** Structured Member refs of this Message, from its originating send operation. */
  readonly mentions: readonly AgentTeamMemberId[]
  readonly task?: AgentTeamTask
  readonly thread: AgentTeamThread
  readonly taskNumber?: number
  /**
   * The people still on this item's Task: owners of its live Claims, in claim
   * order, deduped — the same rule, and the same words, the Inbox row already
   * uses for the same Task, resolved here because a feed entry draws handles
   * and has no Member view of its own. Empty on a taskless item, and on a done
   * or closed one, whose Claims are history that the state word already tells.
   */
  readonly claimOwners: readonly AgentTeamInboxActor[]
  readonly messageCount: number
  /** Instant of the latest fact on this Thread (message or activity), projected from its committing operation. */
  readonly lastActivityAt: string
}

/**
 * One in-flight Task Thread for the team_view「活跃 task thread」radar: work a
 * reader can see is already claimed and moving, so an unexpected Workspace edit
 * or a Task they were about to pick up resolves to "someone is on this" instead
 * of a mystery. Unlike the Human Inbox's 「最近活跃」 slice, admission is not
 * participation — every active Task Thread in the reader's authorized Channels
 * appears, whether or not they took part — and a Thread still holding unread is
 * not excluded, because this radar answers "who is on what" independently of
 * the reader's own unread queue.
 */
export interface AgentTeamActiveTaskThread {
  readonly taskRef: AgentTeamTaskRef
  readonly threadRef: AgentTeamThreadRef
  readonly channelRef: AgentTeamChannelRef
  /** The Task's ordinal inside its home Channel. */
  readonly taskNumber?: number
  /** Always `in_progress` or `in_review` — the two states a live Claim keeps a Task in. */
  readonly status: AgentTeamTask['status']
  /** The Thread's opening line, trimmed and capped at 120 characters — the same bound the Inbox row uses. */
  readonly subject: string
  /** Owners of the Task's live Claims, in claim order, deduped — the same rule the Inbox row and Channel feed use. */
  readonly members: readonly AgentTeamInboxActor[]
  /** Instant of the newest fact on this Thread. */
  readonly lastActivityAt: string
}

export interface AgentTeamViewRequest {
  readonly workspaceId: WorkspaceId
  readonly channelRef?: AgentTeamChannelRef
  readonly threadRef?: AgentTeamThreadRef
  readonly limit?: number
  readonly cursor?: number
  /** Read facts after the cursor (Agent default) or the latest facts before it (Client history). */
  readonly direction?: 'after' | 'before'
  /** Exclude Thread replies from a top-level-only projection. */
  readonly topLevelOnly?: boolean
  /** Include public Claim and Task activities in the bounded stream (default true). */
  readonly includeActivities?: boolean
}

/** Bounded public collaboration facts plus a continuation sequence. */
export interface AgentTeamView {
  readonly humanMemberId: AgentTeamMemberId
  /** Every Workspace the viewing Member participates in — the address book for the optional `workspace` selector; `default` marks the Workspace its Session roots in. */
  readonly workspaces: readonly AgentTeamWorkspaceParticipation[]
  readonly channels: readonly AgentTeamChannel[]
  readonly members: readonly AgentTeamChannelMembership[]
  readonly tasks: readonly AgentTeamTask[]
  readonly threads: readonly AgentTeamThread[]
  readonly taskNumbers: readonly { readonly taskRef: AgentTeamTaskRef; readonly taskNumber: number }[]
  readonly items: readonly AgentTeamViewItem[]
  /**
   * The「活跃 task thread」radar: every in_progress / in_review Task Thread in
   * the reader's authorized Channels of this Workspace, newest activity first.
   * Independent of the reader's participation and unread state — its job is to
   * surface who is already on what, so re-entry and pre-claim/pre-commit checks
   * do not mistake in-flight work for a conflict.
   */
  readonly activeTaskThreads: readonly AgentTeamActiveTaskThread[]
  readonly claims: readonly AgentTeamClaim[]
  readonly activities: readonly AgentTeamActivity[]
  readonly cursor: number
  readonly hasMore: boolean
}

/** One Workspace a Member participates in, as exposed to the Member-facing view. */
export interface AgentTeamWorkspaceParticipation {
  readonly workspaceId: WorkspaceId
  /** Registry display title; absent when the Workspace is already gone from the registry (a dangling participation pending cleanup). */
  readonly title?: string | undefined
  readonly default: boolean
}

/** One projection slice a Client can wait on; events wake only matching waiters. */
export type AgentTeamChangeScope =
  | { readonly kind: 'workspace'; readonly workspaceId: WorkspaceId }
  | { readonly kind: 'channel'; readonly channelRef: AgentTeamChannelRef }
  | { readonly kind: 'thread'; readonly threadRef: AgentTeamThreadRef }
  /**
   * Presence-only lifecycle wake (Agent running/idle/failure) with no ledger
   * commit behind it: members/presence subscribers refresh their rows, while
   * workspace catalog and scope-less Inbox subscribers stay parked because no
   * durable projection changed.
   */
  | { readonly kind: 'presence'; readonly workspaceId: WorkspaceId }

/** Subscribe to lightweight invalidations; each connection starts with a current baseline. */
export interface AgentTeamChangesRequest {
  /** Omit to observe every shared projection change. */
  readonly scope?: AgentTeamChangeScope
}

/** Invalidation, not a history record: intermediate versions may be coalesced. */
export interface AgentTeamChangesResult {
  /** Presence uses a process-local epoch; other scopes use the shared projection's ledger position. */
  readonly version: number
}

/** Human-facing summary of the current Team projection. */
export interface AgentTeamStatus {
  readonly initialized: true
  readonly sequence: number
  readonly operationCount: number
  readonly channelCount: number
  readonly agentMemberCount: number
  readonly humanMemberId: AgentTeamMemberId
}

/* ------------------------------------------------------------------ *
 * Interrupted-session stack (one Member's pending continuations)
 * ------------------------------------------------------------------ */

/**
 * A Member records an interrupt through its own running turn (the model-facing
 * `context_interrupt` tool); the Human never records one directly, so this
 * request carries no actor and no Workspace — the Host derives the calling
 * Member, its actor, and its default Workspace. The tool-call id makes the
 * commit idempotent: a retried provider call with the same id resolves to
 * the entry already on the stack. Label and state are size-bounded at the
 * ledger commit.
 */
export interface AgentTeamRecordInterruptToolRequest {
  /** The calling tool invocation's id; the stable idempotency key of this record. */
  readonly callId: string
  /** The restorable checkpoint this work is pinned to, exactly as context_timeline printed it. */
  readonly checkpointRef: AgentTeamContextCheckpointRef
  readonly label: string
  readonly incompleteState: string
  readonly taskRef?: AgentTeamTaskRef
  readonly threadRef?: AgentTeamThreadRef
  /** Optional path into the Member's own private notes; never read or validated by the Host. */
  readonly notePath?: string
}

export interface AgentTeamRecordInterruptToolOutcome {
  readonly interruptRef: AgentTeamInterruptRef
  readonly recordedSequence: number
}

/** One pending interrupt as the stack read renders it, newest first. */
export interface AgentTeamInterruptView {
  readonly interruptRef: AgentTeamInterruptRef
  readonly label: string
  readonly incompleteState: string
  readonly checkpointRef: AgentTeamContextCheckpointRef
  readonly recordedAt: string
  readonly taskRef?: AgentTeamTaskRef
  readonly threadRef?: AgentTeamThreadRef
  /**
   * Whether citing this entry's checkpointRef in a context_rollover would
   * currently resolve — read live from the Member's lineage, so a stale pin
   * states false and the Member carries its state into a fresh handoff instead.
   */
  readonly restorable: boolean
  /** Why not restorable; absent when it is. */
  readonly reason?: string
}

export interface AgentTeamListInterruptsToolOutcome {
  readonly items: readonly AgentTeamInterruptView[]
}

/** Release one pending interrupt without returning to it. */
export interface AgentTeamReleaseInterruptToolRequest {
  /** The calling tool invocation's id; the stable idempotency key of this release. */
  readonly callId: string
  readonly interruptRef: AgentTeamInterruptRef
  readonly reason?: string
}

export interface AgentTeamReleaseInterruptToolOutcome {
  readonly interruptRef: AgentTeamInterruptRef
  readonly resolution: 'released'
}

/** Human read of one Member's pending interrupts, newest first. */
export interface AgentTeamMemberInterruptsRequest {
  readonly workspaceId: WorkspaceId
  readonly memberId: AgentTeamMemberId
}

export interface AgentTeamMemberInterrupts {
  readonly memberId: AgentTeamMemberId
  readonly items: readonly AgentTeamInterruptView[]
}

/** Human release of one Member's pending interrupt. */
export interface AgentTeamResolveMemberInterruptRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly memberId: AgentTeamMemberId
  readonly interruptRef: AgentTeamInterruptRef
  readonly reason?: string
}

export interface AgentTeamResolveMemberInterruptResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly interruptRef: AgentTeamInterruptRef
  readonly resolution: AgentTeamInterruptResolution
}
