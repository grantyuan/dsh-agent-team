import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'

/** Stable identifier of one Agent Team operation. */
export type AgentTeamOperationId = Branded<'AgentTeamOperationId'>

/** Caller-supplied idempotency identifier for one business operation. */
export type AgentTeamRequestId = Branded<'AgentTeamRequestId'>

/** Stable identifier of one uploaded composer attachment (cache, not archive). */
export type AgentTeamAttachmentId = Branded<'AgentTeamAttachmentId'>

/** Stable identifier of one Team member. */
export type AgentTeamMemberId = Branded<'AgentTeamMemberId'>

/** Stable identifier of one Workspace-scoped Channel. */
export type AgentTeamChannelRef = Branded<'AgentTeamChannelRef'>

/** Stable identifier of one immutable Message. */
export type AgentTeamMessageRef = Branded<'AgentTeamMessageRef'>

/** Stable identifier of one Task. */
export type AgentTeamTaskRef = Branded<'AgentTeamTaskRef'>

/** Stable identifier of one Thread. */
export type AgentTeamThreadRef = Branded<'AgentTeamThreadRef'>

/** Stable identifier of one Claim. */
export type AgentTeamClaimRef = Branded<'AgentTeamClaimRef'>

/** Stable identifier of one public Thread Activity. */
export type AgentTeamActivityRef = Branded<'AgentTeamActivityRef'>

/**
 * Opaque, restorable reference to one completed-turn context checkpoint in a
 * Member's private Session lineage. Selection authority is the ref itself;
 * the human-readable name is display data only.
 */
export type AgentTeamContextCheckpointRef = Branded<'AgentTeamContextCheckpointRef'>

/** Stable identifier of one recorded interrupted session awaiting continuation. */
export type AgentTeamInterruptRef = Branded<'AgentTeamInterruptRef'>

/** How one interrupt left the pending stack. */
export type AgentTeamInterruptResolution = 'resumed' | 'released'

/**
 * One Member session that was stopped before its work completed and pinned
 * to a restorable context checkpoint: the durable pointer that lets the
 * Member (or its next generation after a context reset) pick the interrupted
 * work back up once whatever interrupted it is finished. The entry is
 * Member-scoped coordination bookkeeping — the semantic label and bounded
 * incomplete-state note describe what remains; the full private handoff
 * stays in the Member's own checkpoint lineage and memory, never here.
 */
export interface AgentTeamMemberInterrupt {
  readonly interruptRef: AgentTeamInterruptRef
  readonly memberId: AgentTeamMemberId
  readonly workspaceId: WorkspaceId
  /** The restorable checkpoint this work was pinned to; the resume cite. */
  readonly checkpointRef: AgentTeamContextCheckpointRef
  /** The checkpoint's owning Session at record time — lineage context, not a selection key. */
  readonly sessionId: SessionId
  /** Short semantic label naming the interrupted work. */
  readonly label: string
  /** Bounded summary of the incomplete state: where it stopped and what remains. */
  readonly incompleteState: string
  /** The Task the interrupted work served, when it served one. */
  readonly taskRef?: AgentTeamTaskRef
  /** The Thread the interrupted work belonged to, when it belonged to one. */
  readonly threadRef?: AgentTeamThreadRef
  /** Optional pointer into the Member's own private notes for the detailed state. */
  readonly notePath?: string
  /** Ledger sequence of the recording operation — the stack's durable order. */
  readonly recordedSequence: number
  readonly recordedAt: string
}

/** Process-local one-use authorization for one Human invitation. */
export type AgentTeamConfirmationToken = Branded<'AgentTeamConfirmationToken'>

/** Snapshot of the Human authority authorized for an operation. */
export interface AgentTeamHumanActor {
  readonly kind: 'human'
  readonly memberId: AgentTeamMemberId
  readonly handle: string
}

/**
 * Snapshot of the fixed Team Assistant authority: the Team Host's own
 * supervision voice. The Host alone constructs it, and it may only speak —
 * deliver Message facts — never administer. The Human actor stays reserved
 * for the real user's own sends.
 */
export interface AgentTeamAssistantActor {
  readonly kind: 'assistant'
  readonly memberId: AgentTeamMemberId
  readonly handle: string
}

/** Snapshot of the exact Agent Member authorized by its live Agent binding. */
export interface AgentTeamMemberActor {
  readonly kind: 'member'
  readonly memberId: AgentTeamMemberId
  readonly handle: string
}

export type AgentTeamActor = AgentTeamHumanActor | AgentTeamAssistantActor | AgentTeamMemberActor

/** Provider route plus provider-owned model id one Member can be pinned to. */
export interface AgentTeamModelSelection {
  readonly provider: string
  readonly model: string
  /** Adapter-owned reasoning effort, or the model's provider/default behavior when absent. */
  readonly reasoningEffort?: ReasoningEffortId
}

/**
 * Durable capability intent of one Member, carried verbatim on the Member
 * entity through every lifecycle operation. Pure intent: names are not
 * validated against any known-tool list at commit time, so a Harness upgrade
 * that renames or removes tools can never make an old ledger unreplayable.
 * Divergence surfaces at activation as runtime-derived warnings, never as
 * persisted facts (stale persisted warnings would lie after Host restart or
 * Harness upgrades).
 */
export interface AgentTeamMemberCapabilities {
  /**
   * Deliberate interface reservation, no UI writes it today: Runtime Revision
   * manifests depend on this seam — do not remove during cleanup.
   * Absent = the Member sees all standard tools; present = the activation
   * allow-list (unknown names drop with a warning; the Host always unions
   * the five Team tools over it).
   */
  readonly tools?: { readonly allow?: readonly string[] } | undefined
  /**
   * Absent = auto-load every skill in the Member's private skills directory;
   * present = only the listed skill names.
   */
  readonly skills?: { readonly allow?: readonly string[] } | undefined
}

/**
 * Durable prompt-shaping intent of one Member, carried verbatim like
 * capabilities. Pure intent: this layer round-trips the shape through the
 * ledger only — section filtering, custom-prompt registration, and pruning
 * are prompt-profile work and must not be derived here.
 */
export interface AgentTeamMemberPromptProfile {
  /** Shared section names to drop from this Member's assembly (default: none). */
  readonly droppedSections?: readonly string[]
  /** Bounded custom role paragraph appended to the system prompt (max 8 KiB). */
  readonly customPrompt?: string
  /** Auto-prune long-unused tool-mapped sections at task start; default off. */
  readonly autoPrune?: boolean
  /**
   * Upgrade of `autoPrune`: the Host itself commits the window's zero-use
   * candidates as a durable member update at the task-start trigger, instead
   * of only notifying the Human inbox and listing them for confirmation.
   * Absent (default) is ask mode: candidates wait for Human confirmation.
   */
  readonly autoExecutePrune?: boolean
}

/** Durable identity and lifecycle intent of one team-managed Agent. */
export interface AgentTeamAgentMember {
  readonly memberId: AgentTeamMemberId
  readonly sessionId: SessionId
  /**
   * Supervision succession edge: the Member this one replaced when supervision
   * archived an unrecoverable predecessor and put a same-role generation in its
   * place. Present only on handover successors; it widens this Member's Session
   * lineage to include the predecessor's history. Members written before the
   * edge existed omit the field.
   */
  readonly predecessorMemberId?: AgentTeamMemberId | undefined
  readonly workspaceId: WorkspaceId
  readonly handle: string
  readonly description: string
  readonly presetId: string
  /** Absent inherits the Host default model selection at every activation. */
  readonly model?: AgentTeamModelSelection | undefined
  /** Durable capability intent; see AgentTeamMemberCapabilities. */
  readonly capabilities?: AgentTeamMemberCapabilities | undefined
  /** Durable prompt-shaping intent; see AgentTeamMemberPromptProfile. */
  readonly prompt?: AgentTeamMemberPromptProfile | undefined
  /** Host-internal namespace; never exposed through Client projections. */
  readonly privateMemoryPath: string
  /**
   * Durable designation as the Team's leader — the Member the Host's idle
   * continuation watcher nudges when every Agent is stopped with Tasks still
   * open. Members written before the designation existed omit the field.
   */
  readonly leader?: boolean | undefined
  /**
   * Task-start context policy. `fresh` renews the Member's context through
   * the serialized lifecycle queue at every claim and Human atomic-start
   * boundary; absent (and `continue`) keeps the current Session across Task
   * boundaries. Members written before the policy existed omit the field.
   */
  readonly contextStartPolicy?: 'continue' | 'fresh' | undefined
  /**
   * Per-Member context-window override in tokens (integer, floor 8192). It
   * caps — never raises — the routed model's capacity inside the pressure
   * budget derivation; absent follows the route window.
   */
  readonly contextWindow?: number | undefined
  /**
   * Durable lifecycle state. `enabled`/`suspended` are the reversible working
   * pair; `archived` hides the Member from every surface while keeping its
   * Session log and private memory recoverable (no restore entry point yet,
   * mirroring archived dsh sessions); `inactive` is irreversible removal with
   * data cleanup.
   */
  readonly state: 'enabled' | 'suspended' | 'inactive' | 'archived'
}

/**
 * Runtime-derived capability divergence between a Member's persisted intent
 * and the names known at activation time (for example after a Harness
 * upgrade renamed or removed a tool). Derived state only — never persisted;
 * recomputed at every activation so warnings never go stale.
 */
export interface AgentTeamCapabilityWarning {
  /** The persisted allow-list entry that resolved to no known capability. */
  readonly name: string
  /** Digest of the names that were known when the entry was dropped. */
  readonly knownNames: readonly string[]
}

/**
 * Host projection combining durable intent with process-local availability.
 * The optional diagnostic is structured: `class` routes which action actually
 * helps (restart heals, restart is useless, transient), `detail` is the
 * human-readable reason, and a refused session carries its artifact location.
 */
export interface AgentTeamAgentMemberStatus {
  readonly member: AgentTeamAgentMember
  readonly availability: 'active' | 'suspended' | 'inactive' | 'archived' | 'unavailable'
  readonly presence: 'available' | 'working' | 'error' | 'unavailable'
  readonly diagnostic?: AgentTeamMemberDiagnostic
  /**
   * Runtime-derived, activation-scoped capability warnings (see
   * AgentTeamCapabilityWarning); empty while capabilities resolve cleanly.
   */
  readonly capabilityWarnings?: readonly AgentTeamCapabilityWarning[] | undefined
}

/** Which action actually helps an unavailable or erroring Member; the diagnostic's policy axis. */
export type AgentTeamMemberDiagnosticClass =
  | 'session-refused' // deterministic format refusal of a Session the activation needed
  | 'session-unreadable' // missing, corrupt, io, or unknown Session read failure
  | 'preset-composition' // preset mount/validation failure (often an install/runtime split)
  | 'rollover' // transient context-rollover window
  | 'runtime' // live runtime or compaction failure
  | 'activation' // unclassified activation failure

/** One Member failure's structured reason; rendered, never persisted. */
export interface AgentTeamMemberDiagnostic {
  readonly class: AgentTeamMemberDiagnosticClass
  readonly detail: string
  /** The refused artifact's location, when a format refusal reported one. */
  readonly location?: { readonly kind: string; readonly path: string }
  /** The Session the failure is about, when it is about one. */
  readonly sessionId?: SessionId
}

/** Browser-safe Member identity with Host-only paths removed. */
export type AgentTeamClientMember = Omit<AgentTeamAgentMember, 'privateMemoryPath'>

/** Browser-safe lifecycle projection. */
export interface AgentTeamClientMemberStatus extends Omit<AgentTeamAgentMemberStatus, 'member'> {
  readonly member: AgentTeamClientMember
  readonly workspaceIds: readonly WorkspaceId[]
}

/** Human roster: omit Workspace to select from the global Member catalog. */
export interface AgentTeamMembersRequest {
  readonly workspaceId?: WorkspaceId
}

/** Look up navigation facts for branded Task refs found in message bodies. */
export interface AgentTeamResolveTaskRefsRequest {
  readonly workspaceId: WorkspaceId
  readonly taskRefs: readonly AgentTeamTaskRef[]
}

/** One resolved Task; refs that do not exist in the workspace are omitted. */
export interface AgentTeamResolvedTaskRef {
  readonly taskRef: AgentTeamTaskRef
  readonly channelRef: AgentTeamChannelRef
  readonly threadRef: AgentTeamThreadRef
  readonly taskNumber: number
}

export interface AgentTeamResolveTaskRefsResult {
  readonly resolved: readonly AgentTeamResolvedTaskRef[]
}

/** Look up navigation facts for branded Thread refs found in message bodies. */
export interface AgentTeamResolveThreadRefsRequest {
  readonly workspaceId: WorkspaceId
  readonly threadRefs: readonly AgentTeamThreadRef[]
}

/** One resolved Thread; refs that do not exist in the workspace are omitted. */
export interface AgentTeamResolvedThreadRef {
  readonly threadRef: AgentTeamThreadRef
  readonly channelRef: AgentTeamChannelRef
  readonly taskRef?: AgentTeamTaskRef
  readonly taskNumber?: number
  /** Opening-line gist distinguishing one Thread chip from another: first line, trimmed, capped at 40 characters. */
  readonly title: string
}

export interface AgentTeamResolveThreadRefsResult {
  readonly resolved: readonly AgentTeamResolvedThreadRef[]
}

export interface AgentTeamOperationBase {
  readonly sequence: number
  readonly operationId: AgentTeamOperationId
  readonly requestId: AgentTeamRequestId
  readonly occurredAt: string
  readonly actor: AgentTeamActor
  readonly previousOperationId: AgentTeamOperationId | null
}

/** One Workspace-scoped collaboration Channel. */
export interface AgentTeamChannel {
  readonly channelRef: AgentTeamChannelRef
  readonly workspaceId: WorkspaceId
  readonly name: string
  readonly description: string
  readonly createdAtSequence: number
  /**
   * Durable lifecycle state. `archived` hides the Channel and its Threads from
   * every surface while keeping all facts recoverable (no restore entry point
   * yet, mirroring archived dsh sessions). Ledgers written before Channel
   * archival existed omit the field; the record schema normalizes it to
   * `active` at load time.
   */
  readonly state: 'active' | 'archived'
}

/** One durable Channel membership fact derived from the operation ledger. */
export interface AgentTeamChannelMembership {
  readonly channelRef: AgentTeamChannelRef
  readonly memberId: AgentTeamMemberId
}

/** One immutable top-level or reply Message. */
export interface AgentTeamMessageAttachment {
  readonly attachmentId: AgentTeamAttachmentId
  readonly name: string
  readonly byteSize: number
  readonly mediaType: string
}

export interface AgentTeamMessage {
  readonly messageRef: AgentTeamMessageRef
  readonly channelRef: AgentTeamChannelRef
  readonly threadRef: AgentTeamThreadRef
  /** Absent on Messages committed while the Thread had no Task; promotion does not rewrite prior Messages. */
  readonly taskRef?: AgentTeamTaskRef
  readonly sender: AgentTeamMemberId
  readonly body: string
  readonly attachments?: readonly AgentTeamMessageAttachment[] | undefined
  readonly topLevel: boolean
  readonly sequence: number
  /** Wall-clock instant of the wrapping ledger operation; pre-occurredAt ledgers normalize on replay. */
  readonly occurredAt: string
}

/** Task overlay created by an atomic start or Human promotion. */
export interface AgentTeamTask {
  readonly taskRef: AgentTeamTaskRef
  readonly channelRef: AgentTeamChannelRef
  readonly threadRef: AgentTeamThreadRef
  readonly status: 'todo' | 'in_progress' | 'in_review' | 'done' | 'closed'
  readonly resolution: 'open' | 'accepted' | 'closed'
  /**
   * Parent Task when this Task was created as an Agent-split sub-task.
   * Ledgers written before sub-tasks existed omit the field; the parent lives
   * in the same Channel and is resolved at creation time only.
   */
  readonly parentTaskRef?: AgentTeamTaskRef | undefined
}

/** Current projection of one collaboration Thread. */
export interface AgentTeamThread {
  readonly threadRef: AgentTeamThreadRef
  /** Present after atomic Task creation or Human promotion; absent on taskless Threads. */
  readonly taskRef?: AgentTeamTaskRef
  /** Last public Message, Claim, or Task-resolution sequence. */
  readonly revision: number
}

/**
 * A Member's current attention period for one Thread.
 *
 * Its absence means the Member is not following. Read state is compact: all
 * follower-visible facts from `startSequence` through `readThroughSequence`
 * are acknowledged, except for sparse direct markers retained separately.
 */
export interface AgentTeamThreadAttention {
  readonly memberId: AgentTeamMemberId
  readonly threadRef: AgentTeamThreadRef
  readonly startSequence: number
  readonly readThroughSequence: number
}

/** Identity of one Member × Thread attention period. */
export interface AgentTeamThreadAttentionKey {
  readonly memberId: AgentTeamMemberId
  readonly threadRef: AgentTeamThreadRef
}

/** Sparse direct-priority marker for one structured Message mention. */
export interface AgentTeamDirectMarker {
  readonly memberId: AgentTeamMemberId
  readonly threadRef: AgentTeamThreadRef
  readonly messageRef: AgentTeamMessageRef
  readonly sequence: number
}

/** Sparse marker retaining a relevant Task or Claim Activity after Attention ends. */
export interface AgentTeamActivityMarker {
  readonly memberId: AgentTeamMemberId
  readonly threadRef: AgentTeamThreadRef
  readonly activityRef: AgentTeamActivityRef
  readonly sequence: number
}

/** Durable changes to private Member inbox state carried by one operation. */
export interface AgentTeamInboxDelta {
  readonly attention: {
    /** New or replacement current Attention records. */
    readonly set: readonly AgentTeamThreadAttention[]
    /** Attention periods ended by this operation. */
    readonly removed: readonly AgentTeamThreadAttentionKey[]
  }
  readonly directMarkers: {
    readonly added: readonly AgentTeamDirectMarker[]
    readonly removed: readonly AgentTeamDirectMarker[]
  }
  readonly activityMarkers: {
    readonly added: readonly AgentTeamActivityMarker[]
    readonly removed: readonly AgentTeamActivityMarker[]
  }
}

/** One Direction Claim retained as Task progress history. */
export interface AgentTeamClaim {
  readonly claimRef: AgentTeamClaimRef
  readonly taskRef: AgentTeamTaskRef
  readonly threadRef: AgentTeamThreadRef
  readonly owner: AgentTeamMemberId
  readonly direction: string
  readonly normalizedDirection: string
  readonly state: 'active' | 'done' | 'released'
}

interface AgentTeamActivityBase {
  readonly activityRef: AgentTeamActivityRef
  readonly taskRef: AgentTeamTaskRef
  readonly threadRef: AgentTeamThreadRef
  readonly actor: AgentTeamMemberId
  readonly sequence: number
}

export interface AgentTeamClaimActivity extends AgentTeamActivityBase {
  readonly kind: 'claim' | 'done' | 'release'
  readonly claimRef: AgentTeamClaimRef
}

export interface AgentTeamTaskActivity extends AgentTeamActivityBase {
  readonly kind: 'promote' | 'accept' | 'close' | 'reopen'
  /** Claims atomically released by close; absent for other Task transitions. */
  readonly releasedClaimRefs?: readonly AgentTeamClaimRef[] | undefined
  /** Active claims the Human acceptance completed alongside the Task; absent when none were active. */
  readonly completedClaimRefs?: readonly AgentTeamClaimRef[] | undefined
  /**
   * Every done Claim at acceptance time, including pre-finished ones — the
   * durable discriminator accept markers deliver from. Always present on
   * new accepts (possibly empty); legacy records predate it and keep the
   * completed-only wake semantics.
   */
  readonly acceptedClaimRefs?: readonly AgentTeamClaimRef[] | undefined
}

/** One automatic, public release summary caused by a membership lifecycle action. */
export interface AgentTeamClaimsReleasedActivity extends AgentTeamActivityBase {
  readonly kind: 'claims_released'
  readonly claimRefs: readonly AgentTeamClaimRef[]
}

/** One ordered public Thread Activity. */
export type AgentTeamActivity = AgentTeamClaimActivity | AgentTeamTaskActivity | AgentTeamClaimsReleasedActivity

/** One public, revisioned fact in a Thread timeline. */
export type AgentTeamThreadFact =
  | {
    readonly kind: 'message'
    readonly sequence: number
    readonly message: AgentTeamMessage
    /** Structured Member refs from the originating send operation; empty when the Message mentions nobody. */
    readonly mentions: readonly AgentTeamMemberId[]
    /** Wall-clock instant of the committing ledger operation; message facts read through to their Message. */
    readonly occurredAt: string
  }
  | { readonly kind: 'activity'; readonly sequence: number; readonly activity: AgentTeamActivity
    /** Wall-clock instant of the committing ledger operation; activities have no instant of their own. */
    readonly occurredAt: string }

/** One fact returned by a durable Thread read. */
export interface AgentTeamThreadReadFact {
  readonly fact: AgentTeamThreadFact
  /** This fact was part of the unread batch advanced by this read. */
  readonly unread: boolean
  /** This fact carries one of the recipient's structured direct mentions. */
  readonly direct: boolean
}

/** Stored form of a Message inside durable operations; pre-occurredAt ledgers omit it and normalize on load. */
export type AgentTeamStoredMessage = Omit<AgentTeamMessage, 'occurredAt'> & { readonly occurredAt?: string | undefined }

/** Stored form of one Thread timeline fact; mirrors AgentTeamThreadFact with stored messages. */
export type AgentTeamStoredThreadFact =
  | { readonly kind: 'message'; readonly sequence: number; readonly message: AgentTeamStoredMessage;
    readonly mentions: readonly AgentTeamMemberId[]
    /** Ledger-operation instant; pre-envelope ledgers omit it and normalize on load. */
    readonly occurredAt?: string | undefined }
  | { readonly kind: 'activity'; readonly sequence: number; readonly activity: AgentTeamActivity
    /** Ledger-operation instant; pre-envelope ledgers omit it and normalize on load. */
    readonly occurredAt?: string | undefined }

/** Stored form of one durable Thread read fact. */
export interface AgentTeamStoredThreadReadFact {
  readonly fact: AgentTeamStoredThreadFact
  readonly unread: boolean
  readonly direct: boolean
}

