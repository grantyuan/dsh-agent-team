/**
 * Durable Agent Team Host capability.
 *
 * The Host owns the append-only collaboration ledger and all Member lifecycle
 * effects. Session history and browser state are projections, never Team facts.
 * @module @wowyuarm/dsh-agent-team
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { Context, Service, type Volatile } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type AgentHandle, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-app-boot'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { Session, SessionId, SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type {} from '@deepseek-ai/dsh-tools'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { ATTACHMENT_MAX_BYTES, attachmentPayloadPath, attachmentsRoot, copyPathAttachment, newAttachmentId, readAttachment, sanitizeMediaType, sweepAttachmentCache, validatePathAttachment, writeAttachment } from './attachments.ts'
import { reportEnvironment } from './environment-check.ts'
import { HUMAN_PROFILE_DEFAULT_NAME, HUMAN_PROFILE_REPO_URL, HUMAN_PROFILE_SETTINGS_NAMESPACE, HUMAN_PROFILE_SETTINGS_SCHEMA, HUMAN_PROFILE_VERSION, assertValidHumanName, normalizeHumanName, parseLegacyHumanProfile, planLegacyAdoption, type LegacyHumanProfileFields } from './human-profile.ts'
import { humanAvatarsRoot, readHumanAvatar, removeHumanAvatar, writeHumanAvatar } from './human-avatar.ts'
import { createHumanUpdateChecker } from './human-update-check.ts'
import { PressurePolicyCoordinator } from './pressure-policy.ts'
import { CONTEXT_CONTINUITY_PROJECTION_KEY, readContextTimeline, type ContextProjectionConfig, type ContextTimelineItem, type ContextTimelineSource, type TransitionPlan } from '@wowyuarm/dsh-context-continuity'
import { createTeamContextManagement, TEAM_CONTEXT_CODEC } from './context-continuity-host.ts'
import { AGENT_TEAM_PLUGIN_ID, isAgentTeamSource } from './context-source.ts'
import { boundaryByRef, carriedInputOf, checkpointByRef, checkpointRefFor, createTeamContextProjectionConfig, createTeamContextProjectionDefinition, foldTeamContextProjection, retainedTopicsThrough, TeamContextProjectionHost } from './context-projection.ts'
import { AGENT_TEAM_HUMAN_HANDLE, AGENT_TEAM_HUMAN_MEMBER_ID, AGENT_TEAM_ASSISTANT_HANDLE, AGENT_TEAM_ASSISTANT_MEMBER_ID, AGENT_TEAM_RECALLED_BODY_TOMBSTONE, AgentTeamLedger, agentTeamAssistantActor, agentTeamHumanActor, type AgentTeamDurableMemberResult } from './ledger.ts'
import { LedgerFence, ledgerFenceFor } from './ledger-fence.ts'
import { AGENT_TEAM_TOOL_NAMES, BUNDLED_SKILLS_DIRECTORY, deepCopyCapabilities, deepCopyPrompt, isProtectedPromptSection, memberMemoryDirectoryName, memberMemoryDirectoryPath, MemberRuntime, promptSectionByteLength, sectionToolMapping } from './member-runtime.ts'
import { PRUNE_WINDOW_DAYS, PRUNE_WINDOW_TURNS, countLineageTurns, foldLineageUsage, type UsageFold } from './member-section-usage.ts'
import { CURATE_MAX_TOKENS, CURATE_TIMEOUT_MS, buildCurateMessages, parseCurateProposal, type CuratePromptInput } from './member-prompt-curation.ts'
import { DIGEST_MAX_TOKENS, DIGEST_MESSAGE_LIMIT, DIGEST_RETIREMENT_ENTRY_LIMIT, DIGEST_TIMEOUT_MS, buildDigestMessages, parseThreadDigest, type ThreadDigestMessage } from './thread-digest.ts'
import { listPrivateSkillNames } from './member-skills.ts'
import { BlockAssembler, LlmError } from '@deepseek-ai/dsh-llm'
import type { MemberSkillSelectionRef } from './member-skills.ts'
import { classifyRecoverableError, RecoveryCoordinator, RECOVERY_MAX_CONSECUTIVE_ERRORS } from './recovery.ts'
import { assistantPlainText, classifyAssistantResponse, classifyStoppedTurnTail, COMPLETION_MARKER, RESPONSE_GUARD_MAX_CONSECUTIVE, RESPONSE_GUARD_NOTICE_SUMMARY, ResponseGuardCoordinator } from './response-guard.ts'
import { buildRelevanceJudge, CONTEXT_RELEVANCE_THRESHOLD, DISPATCH_HISTORY_MESSAGE_LIMIT, parseRelevanceScore, RELEVANCE_JUDGE_MAX_TOKENS, RELEVANCE_JUDGE_TIMEOUT_MS } from './context-relevance.ts'
import { MemberSupervisor, nextReplacementHandle, supervisionRetirementNotice, SUPERVISION_FAILURE_WINDOW_MS, SUPERVISION_HUNG_MS, SUPERVISION_MAX_CONSECUTIVE_FAILURES, SUPERVISION_MAX_RESTART_ATTEMPTS, SUPERVISION_WINDOW_FAILURES, type MemberSupervisionState, type SupervisionSessionRecap, type SupervisionTrigger } from './supervisor.ts'
import { CONTINUATION_NUDGE_MARKER, TaskContinuationWatcher, continuationNudgeText, type ContinuationLeader, type ContinuationTask } from './continuation-watcher.ts'
import { CompletionLiaison, INTERRUPT_PUSH_SUMMARY, liaisonFeedbackText, liaisonReportCheckText, liaisonResumePushText, liaisonTaskPushText, type LiaisonInterrupt, type LiaisonLeader } from './completion-liaison.ts'
import { TruncationEscalator, truncationEscalationText, type TruncationLeader } from './truncation-escalation.ts'
import { MemberWatchMonitor, memberWatchNoticeText, type MemberWatchNotice, type MemberWatchSample, type MemberWatchTask } from './member-watch.ts'
import { StoredSessionReadError, StoredSessionReader, sessionFailureOf } from './stored-session-reader.ts'
import { doctorAnalysisPrompt, humanTranscriptEntriesOf, renderFailureTranscript, type TranscriptEntry, type TranscriptEvent } from './failure-transcript.ts'
import { agentTeamDomainSpec } from './spec.ts'
import { formatTeamTimestamp } from './time-format.ts'
import type {
  AgentTeamAddMemberRequest,
  AgentTeamAddMemberResult,
  AgentTeamAgentMember,
  AgentTeamAgentMemberStatus,
  AgentTeamArchiveChannelRequest,
  AgentTeamArchiveChannelResult,
  AgentTeamArchiveMemberRequest,
  AgentTeamArchiveMemberResult,
  AgentTeamChangeScope,
  AgentTeamChannelRef,
  AgentTeamChangesRequest,
  AgentTeamChangesResult,
  AgentTeamActivity,
  AgentTeamClaimList,
  AgentTeamClaimRequest,
  AgentTeamClaimResult,
  AgentTeamClientMemberStatus,
  AgentTeamContextCheckpointRef,
  AgentTeamAttachmentId,
  AgentTeamModelSelection,
  AgentTeamCreateChannelRequest,
  AgentTeamCreateChannelResult,
  AgentTeamDiagnoseMemberRequest,
  AgentTeamDiagnoseMemberResult,
  AgentTeamEnvironmentRequest,
  AgentTeamEnvironmentResult,
  AgentTeamResetMemberRequest,
  AgentTeamResetMemberResult,
  AgentTeamSupervisionStatus,
  AgentTeamGetAttachmentRequest,
  AgentTeamGetAttachmentResult,
  AgentTeamGetHumanAvatarRequest,
  AgentTeamGetHumanAvatarResult,
  AgentTeamHumanProfileRequest,
  AgentTeamHumanProfileResult,
  AgentTeamPutHumanAvatarRequest,
  AgentTeamPutHumanAvatarResult,
  AgentTeamRemoveHumanAvatarRequest,
  AgentTeamRemoveHumanAvatarResult,
  AgentTeamInbox,
  AgentTeamInboxRequest,
  AgentTeamJoinChannelRequest,
  AgentTeamJoinChannelResult,
  AgentTeamJoinWorkspaceRequest,
  AgentTeamJoinWorkspaceResult,
  AgentTeamLeaveWorkspaceRequest,
  AgentTeamLeaveWorkspaceResult,
  AgentTeamHumanActor,
  AgentTeamAssistantActor,
  AgentTeamDirectMarker,
  AgentTeamInterruptView,
  AgentTeamMemberActor,
  AgentTeamMemberInterrupt,
  AgentTeamMessageAttachment,
  AgentTeamMemberId,
  AgentTeamMemberInterrupts,
  AgentTeamMemberInterruptsRequest,
  AgentTeamResolveMemberInterruptRequest,
  AgentTeamResolveMemberInterruptResult,
  AgentTeamRecordInterruptToolRequest,
  AgentTeamRecordInterruptToolOutcome,
  AgentTeamListInterruptsToolOutcome,
  AgentTeamReleaseInterruptToolRequest,
  AgentTeamReleaseInterruptToolOutcome,
  AgentTeamMemberPromptSectionEntry,
  AgentTeamMemberPromptView,
  AgentTeamMemberPromptViewRequest,
  AgentTeamMemberSessionsRequest,
  AgentTeamMemberSessionSummary,
  AgentTeamMemberSessionTranscriptRequest,
  AgentTeamMemberSessionTranscript,
  AgentTeamMemberSessionTranscriptEntry,
  AgentTeamCurateMemberPromptRequest,
  AgentTeamCurateMemberPromptResult,
  AgentTeamCurateMemberPromptProposal,
  AgentTeamMemberResult,
  AgentTeamMembersRequest,
  AgentTeamResolveTaskRefsRequest,
  AgentTeamResolveTaskRefsResult,
  AgentTeamResolveThreadRefsRequest,
  AgentTeamResolveThreadRefsResult,
  AgentTeamTaskRef,
  AgentTeamThreadRef,
  AgentTeamEditMessageRequest,
  AgentTeamEditMessageResult,
  AgentTeamOperationReceipt,
  AgentTeamPromoteThreadRequest,
  AgentTeamPromoteThreadResult,
  AgentTeamPutAttachmentRequest,
  AgentTeamPutAttachmentResult,
  AgentTeamRecallMessageRequest,
  AgentTeamRecallMessageResult,
  AgentTeamRecoverMemberRequest,
  AgentTeamRecoverMemberResult,
  AgentTeamClearMemberContextRequest,
  AgentTeamClearMemberContextResult,
  AgentTeamCompactMemberContextRequest,
  AgentTeamCompactMemberContextResult,
  AgentTeamRolloverSessionRequest,
  AgentTeamDmRequest,
  AgentTeamDmResult,
  AgentTeamMemberWatch,
  AgentTeamMemberWatchSnapshot,
  AgentTeamWatchMemberRequest,
  AgentTeamWatchMemberResult,
  AgentTeamUnwatchMemberRequest,
  AgentTeamUnwatchMemberResult,

  AgentTeamOperationId,
  AgentTeamRemoveChannelMemberRequest,
  AgentTeamRemoveChannelMemberResult,
  AgentTeamRequestId,
  AgentTeamRemoveMemberRequest,
  AgentTeamRemoveMemberResult,
  AgentTeamReplyRequest,
  AgentTeamReplyResult,
  AgentTeamSendMessageRequest,
  AgentTeamSendMessageResult,
  AgentTeamSetHumanProfileRequest,
  AgentTeamSetHumanProfileResult,
  AgentTeamSetMemberStateRequest,
  AgentTeamStatus,
  AgentTeamTask,
  AgentTeamTaskRequest,
  AgentTeamTaskResult,
  AgentTeamTasks,
  AgentTeamTasksBatchRequest,
  AgentTeamTasksBatchResult,
  AgentTeamTasksRequest,
  AgentTeamMemberTasks,
  AgentTeamMemberTasksRequest,
  AgentTeamSummarizeThreadRequest,
  AgentTeamSummarizeThreadResult,
  AgentTeamThreadAttentionRequest,
  AgentTeamThreadAttentionResult,
  AgentTeamThreadAttentionStatus,
  AgentTeamThreadFact,
  AgentTeamThreadDigest,
  AgentTeamThreadHistory,
  AgentTeamThreadHistoryRequest,
  AgentTeamThreadReadFact,
  AgentTeamStoredThreadFact,
  AgentTeamThreadReadRequest,
  AgentTeamThreadReadResult,
  AgentTeamContextAdvice,
  AgentTeamMemberDiagnostic,
  AgentTeamThreadObservations,
  AgentTeamThreadObservationsRequest,
  AgentTeamUpdateChannelRequest,
  AgentTeamUpdateChannelResult,
  AgentTeamUpdateMemberRequest,
  AgentTeamView,
  AgentTeamViewRequest,
} from './types.ts'

export { agentTeamDomainSpec, agentTeamOperationSchema } from './spec.ts'
export type * from './types.ts'
export { AGENT_TEAM_HUMAN_HANDLE, AGENT_TEAM_HUMAN_MEMBER_ID, AGENT_TEAM_ASSISTANT_HANDLE, AGENT_TEAM_ASSISTANT_MEMBER_ID, AGENT_TEAM_INITIALIZE_REQUEST_ID, AGENT_TEAM_RECALLED_BODY_TOMBSTONE } from './ledger.ts'
export { HUMAN_PROFILE_DEFAULT_NAME, HUMAN_PROFILE_REPO_URL, HUMAN_PROFILE_SETTINGS_NAMESPACE, HUMAN_PROFILE_SETTINGS_SCHEMA, HUMAN_PROFILE_VERSION, assertValidHumanName, normalizeHumanName } from './human-profile.ts'
export { humanAvatarsRoot } from './human-avatar.ts'
export { AGENT_TEAM_TOOL_NAMES } from './member-runtime.ts'

/** Process-stable marker carried by the final Team message tool definition. */
export const AGENT_TEAM_PRESET_MARKER = Symbol.for('@wowyuarm/dsh-agent-team.preset')


const INBOX_NOTICE_SUMMARY = 'Team Inbox has unread work.'
const RECOVERY_NOTICE_SUMMARY = 'Recovery: continue your interrupted work.'
const RESET_NOTICE_SUMMARY = 'Context reset: your Session was renewed.'
/**
 * The first-line prefix of the retired context-reset Channel broadcast, kept
 * so the Inbox notification projection still recognizes those ledger Messages
 * in ledgers that recorded them and folds their stale unread instances.
 */
const CONTEXT_RESET_NOTICE_MARKER = 'Context reset notice:'
const ORPHANED_MEMBER_DIAGNOSTIC = 'Member preset composition was lost after a reload; its tools are unavailable. Resume rebuilds the member in place.'

/** One recorded Member failure and the Session generation it happened in. */
interface AgentTeamMemberFailureRecord {
  readonly message: string
  readonly sessionId?: SessionId
}

/** Idle-boundary attempts one scheduled background compaction gets before conversation wins and the request is dropped. */
const MEMBER_COMPACT_BUSY_ATTEMPTS = 3

/**
 * Turn-boundary re-bindings one scheduled fresh-start reset may follow (a
 * rollover or restart swaps the live generation while the body waits): the
 * armed reset for a dispatched task survives a bounded number of context
 * swaps instead of silently dropping with the handle it was scheduled on.
 */
const POLICY_RESET_MAX_BINDINGS = 5

/**
 * How recently a restored Member must have stopped for the boot-time continue
 * reminder to fire: only work the last Host generation was cut into gets
 * brought back; a Member that finished (faultily) long before this boot stays
 * stopped until real work arrives. A marker tail arms regardless of age.
 */
const BOOT_FAULT_REMINDER_WINDOW_MS = 6 * 60 * 60 * 1000

/**
 * Other-LLM summarizer attempts one failed compaction gets after its primary
 * route failed: the Host catalog's configured provider/model pairs, excluding
 * the Member's current route, tried in catalog order.
 */
const MAX_COMPACTION_FALLBACK_ATTEMPTS = 3

/**
 * The persistent diagnostic Member: a same-preset teammate whose only job is
 * analyzing a failed Member's session transcript on the Human's ask. It holds
 * exactly the failed Member's Channel memberships (the report goes out as a
 * Human direct message plus a trace Thread there) and is reset to an empty
 * context at the start of every dispatch.
 */
const DOCTOR_HANDLE = 'doctor'
const DOCTOR_PRESET_ID = 'team-member'
const DOCTOR_DESCRIPTION = 'Team doctor: diagnoses a failed Member on the Human\'s ask and reports the root cause by direct message and a Thread in the failed Member\'s Channel.'
const DOCTOR_DIAGNOSTIC_SUMMARY = 'Doctor dispatch: analyze a failed Member'

/**
 * A preset mount/validation failure during activation, carrying its own class
 * so the activation diagnostic can route preset-composition failures (the
 * install/runtime split failure mode) without matching message text.
 */
class PresetCompositionError extends Error {
  constructor(message: string, options: ErrorOptions) {
    super(message, options)
    this.name = 'PresetCompositionError'
  }
}

/** Longest accepted model-supplied checkpoint display name. */
const MAX_CHECKPOINT_NAME_CHARS = 120
/** Default and maximum number of timeline items one query returns. */
const DEFAULT_TIMELINE_LIMIT = 12
/** The widest timeline window there is; the ref gate reads at this width so no printed ref is unreachable. */
export const MAX_TIMELINE_LIMIT = 24
/**
 * Archived generations the timeline and seed resolution walk: the timeline
 * reads this many ancestors behind the current generation, and the seed guard
 * resolves a cited ref through the same depth, so the two surfaces cannot
 * disagree about where history ends.
 */
const MAX_TIMELINE_ANCESTORS = 8
/** Session-history dialog page budgets: rendered lines and characters per read. */
const SESSION_TRANSCRIPT_PAGE_ENTRIES = 150
const SESSION_TRANSCRIPT_PAGE_CHARS = 24_000
/** The digest author label for one folded final-Session transcript entry. */
function retirementRecapAuthor(role: TranscriptEntry['role']): string {
  switch (role) {
    case 'user': return AGENT_TEAM_HUMAN_HANDLE
    case 'team': return 'teammate'
    case 'notice':
    case 'system': return 'notice'
    case 'error':
    case 'warning': return 'outcome'
    case 'tool-call':
    case 'tool-result': return 'tool'
    default: return 'member'
  }
}
/**
 * Fold one retired Member's final-Session transcript into the digest's message
 * shape: the newest {@link DIGEST_RETIREMENT_ENTRY_LIMIT} entries, the Member's
 * own turns labelled by its handle, everyone else by lane.
 */
export function retirementRecapDigestMessages(handle: string, entries: readonly TranscriptEntry[]): readonly ThreadDigestMessage[] {
  return Object.freeze(entries.slice(-DIGEST_RETIREMENT_ENTRY_LIMIT).map(entry => Object.freeze({
    author: entry.role === 'assistant' ? handle : retirementRecapAuthor(entry.role),
    text: entry.text,
    mentions: [] as readonly string[],
  })))
}
/**
 * Pressure budget reserves (see docs/team-collaboration/README.md). Budgets
 * are priced from the live route's own model information — the context window
 * and the adapter's default per-request output cap — never fixed product
 * caps; the constants below are floors for what the route does not disclose.
 */
const CONTEXT_MIN_OUTPUT_RESERVE = 16_000
const CONTEXT_MIN_HANDOFF_RESERVE = 8_000
const CONTEXT_HANDOFF_RESERVE_OF_WINDOW = 0.04
/**
 * Usage at or above this share of the route's handoff budget, an acknowledged
 * acceptance advises a fresh rollover instead of keeping the context. A
 * fixed token number here would price wide routes too late and narrow ones
 * not at all, so the boundary follows the derived budget.
 */
const CONTEXT_ACCEPT_ADVICE_OF_HANDOFF = 0.64
/**
 * The conservative route a tool path assumes when it cannot read the live
 * budget: the narrowest common class of deployed routes, never a cap that
 * would masquerade as the real budget.
 */
const CONTEXT_FALLBACK_ROUTE_WINDOW = 128_000

/**
 * Derive one route's pressure budgets from its model information:
 * `hardLimit = window − outputReserve` where the reserve is the model's
 * disclosed default per-request output cap floored at 16K — a request that
 * may spend that many tokens on the answer cannot also fill the window with
 * context; `handoffAt = hardLimit − handoffReserve` where the reserve is
 * `max(8K, 4% of window)` — the deeper the window, the more room a single
 * forced compaction must leave behind, since one reduction is not guaranteed
 * to clear an arbitrary overrun. Both floors at zero: a route narrower than
 * its reserves prices no usable budget instead of a negative one.
 */
export function deriveContextPressureBudget(routeWindow: number, defaultMaxTokens?: number): { readonly hardLimit: number; readonly handoffAt: number } {
  const outputReserve = Math.max(CONTEXT_MIN_OUTPUT_RESERVE, defaultMaxTokens ?? 0)
  const hardLimit = Math.max(0, routeWindow - outputReserve)
  const handoffReserve = Math.max(CONTEXT_MIN_HANDOFF_RESERVE, Math.floor(routeWindow * CONTEXT_HANDOFF_RESERVE_OF_WINDOW))
  return { hardLimit, handoffAt: Math.max(0, hardLimit - handoffReserve) }
}

const FALLBACK_PRESSURE_BUDGET = deriveContextPressureBudget(CONTEXT_FALLBACK_ROUTE_WINDOW)

/** One live invalidation subscription, restricted to its declared scope. */
interface ChangeWaiter {
  readonly scope: AgentTeamChangeScope | undefined
  wake(version: number): void
}

function sameChangeScope(left: AgentTeamChangeScope, right: AgentTeamChangeScope): boolean {
  if (left.kind === 'workspace' && right.kind === 'workspace') return left.workspaceId === right.workspaceId
  if (left.kind === 'channel' && right.kind === 'channel') return left.channelRef === right.channelRef
  if (left.kind === 'thread' && right.kind === 'thread') return left.threadRef === right.threadRef
  if (left.kind === 'presence' && right.kind === 'presence') return left.workspaceId === right.workspaceId
  return false
}

/** Mark the preset's `team_message` definition as an Agent Team consumer. */
export function markAgentTeamPreset<T extends object>(definition: T): T {
  Object.defineProperty(definition, AGENT_TEAM_PRESET_MARKER, { value: true })
  return definition
}

/**
 * Whether the running dsh loads workspace packages from source via tsx.
 *
 * The Harness `tsconfig.base.json` maps `@deepseek-ai/*` package names onto
 * `src/` directories; tsx honors those paths, so a CLI launched with
 * `node --import tsx/esm apps/cli/src/bin.ts` imports `@deepseek-ai/dsh-scope`
 * from `src/index.ts` while a profile-installed bundle resolves the compiled
 * `lib/index.js` — two module instances with independent scope keys.
 */
export function isTsxDevMode(): boolean {
  const flags = [...process.execArgv]
  const nodeOptions = process.env.NODE_OPTIONS
  if (nodeOptions !== undefined) flags.push(...nodeOptions.split(/\s+/))
  return flags.some(flag => flag.includes('tsx'))
}

/**
 * The activation diagnostic for a dsh-scope module-instance mismatch.
 *
 * `agentPresets.mount` already rejected an unscoped context, so a scope key
 * the harness sees but this bundle does not can only mean the two sides
 * loaded different physical copies of `@deepseek-ai/dsh-scope`.
 */
export function teamPresetScopeMismatchMessage(tsxDevMode: boolean): string {
  if (tsxDevMode) {
    return 'selected preset is not team-enabled: the dsh CLI is running from source via tsx (tsconfig paths resolve @deepseek-ai/dsh-scope to src/), so the harness and this bundle load different module instances; start dsh with the compiled CLI instead (pnpm dsh, node apps/cli/lib/bin.js, or npx @deepseek-ai/dsh)'
  }
  return 'selected preset is not team-enabled: this bundle and the harness resolved different physical copies of @deepseek-ai/dsh-scope; run pnpm install in the profile directory so node_modules matches the lockfile, then restart'
}

export interface AgentTeamCommitted {
  readonly receipt: AgentTeamOperationReceipt
}

/**
 * A DM was durably recorded but its session injection could not run (no live
 * handle, or the wake itself failed). The recorded DM stays durable; the
 * sender should not blindly retry — the recipient recovers it through its DM
 * history once its session is live again.
 */
export class AgentTeamDmDeliveryError extends Error {
  constructor(readonly recipientMemberId: AgentTeamMemberId, readonly recipientHandle: string, message: string) {
    super(message)
    this.name = 'AgentTeamDmDeliveryError'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentTeam: AgentTeam
  }

  interface Events {
    /** One new Team operation is durable and visible through Host projections. */
    'agent-team/committed'(event: AgentTeamCommitted): void
  }
}

/** Tool-side request for one context rollover; the Host validates without side effects. */
export interface AgentTeamNewContextToolRequest {
  readonly memberId: AgentTeamMemberId
  /** Selected checkpoint ref from `context_timeline`; absent means fresh. */
  readonly checkpointRef?: AgentTeamContextCheckpointRef
  readonly relatedFiles?: readonly { readonly path: string; readonly reason: string }[]
}

/** Tool-side validation outcome: which rollover mode a successful call will take. */
export interface AgentTeamNewContextToolOutcome {
  readonly mode: 'fresh' | 'from-checkpoint'
}

/** Tool-side request for one explicit checkpoint; the Host validates without side effects. */
export interface AgentTeamCheckpointToolRequest {
  readonly memberId: AgentTeamMemberId
  /** Provider-issued call id of this tool call; the stable ref derives from it. */
  readonly callId: string
  readonly name: string
}

/** Tool-side checkpoint validation outcome: the deterministic ref the result will carry. */
export interface AgentTeamCheckpointToolOutcome {
  readonly checkpointRef: AgentTeamContextCheckpointRef
  readonly name: string
}

/** Tool-side request for the bounded structural context timeline. */
export interface AgentTeamTimelineToolRequest {
  readonly memberId: AgentTeamMemberId
  readonly limit?: number
}

/** One structural timeline item: a checkpoint or boundary candidate with pricing. */
export interface AgentTeamTimelineItem {
  /** Opaque stable ref; the selection surface for `context_rollover.checkpointRef`. */
  readonly checkpointRef: string
  /** Semantic label: the model-supplied checkpoint name or boundary label. */
  readonly name: string
  /** Which structural source produced this item. */
  readonly source: 'agent' | 'team-boundary' | 'handoff' | 'compaction' | 'head'
  /** Approximate tokens a return would retain (the prefix through this anchor). */
  readonly retainedTokens: number
  /** Approximate tokens a return would discard (the suffix after this anchor). */
  readonly discardedTokens: number
  /**
   * Threads whose facts entered this Session's model context by this anchor
   * (delivered Team notices only — never unread ledger activity). Empty when
   * nothing attributable was delivered.
   */
  readonly affectedThreads: readonly string[]
  /** Whether `context_rollover` accepts this ref as a seed target. */
  readonly restorable: boolean
  /** When not restorable, the concise reason. */
  readonly reason?: string
  /** Session the candidate anchors in; present for non-current-generation sources. */
  readonly sourceSessionId?: SessionId
}

/** Tool-side timeline outcome: usage plus the bounded structural candidate list. */
export interface AgentTeamTimelineToolResult {
  readonly usageTokens: number
  readonly hardLimit: number
  readonly handoffAt: number
  readonly items: readonly AgentTeamTimelineItem[]
  /**
   * The unreadable ancestor that ended the lineage walk early, when one did:
   * history is complete through the last listed source and provably absent
   * beyond it. Never a Member-availability fact.
   */
  readonly incompleteFrom?: { readonly sessionId: SessionId; readonly reason: string }
}

/** One resolved checkpoint seed: the exact balanced prefix plus its source. */
interface CheckpointSeed {
  readonly checkpointRef: AgentTeamContextCheckpointRef
  /** Session the checkpoint was recorded in; the child's lineage parent. */
  readonly sourceSessionId: SessionId
  /** Exclusive end of the seed prefix: its exact length in the source log. */
  readonly sourceThroughSeq: SessionLogOffset
  /** Contiguous events from seq 0 through the checkpoint's completed turn. */
  readonly prefix: readonly SessionEvent[]
}

/** One folded prompt-section projection: the dialog entries plus the auto-prune candidates and partial flag. */
interface PromptSectionProjection {
  readonly entries: readonly AgentTeamMemberPromptSectionEntry[]
  readonly candidates: readonly string[]
  readonly usagePartial: boolean
}

/**
 * Config of the Team Host row: the Human profile (see human-profile.ts) plus
 * the composition-only `ledgerDirectory`. The settings service derives every
 * form from the owning plugin's Config, so the profile is this plugin's own
 * config rather than a section of its own; both profile fields arrive volatile,
 * which is what lets an edit reach the running Host without remounting it.
 * `ledgerDirectory` is static boot input naming the directory that holds the
 * shared SQLite ledger file, where the Host claims its single-writer lock (see
 * ledger-fence.ts); a Host never told it (test harnesses, non-file media) runs
 * unfenced. The row is presentation-owned (`auto: false`), so it renders no
 * settings control.
 */
export interface Config {
  name: Volatile<string>
  avatarRef: Volatile<string | undefined>
  ledgerDirectory?: string
}

/** Host owner of the single Agent Team in one dshHome. */
export default class AgentTeam extends TypertRemoteService {
  static Config = HUMAN_PROFILE_SETTINGS_SCHEMA
  static inject = [
    'storageDomain',
    'workspaceRegistry',
    'agents',
    'agentDefaultModel',
    'agentPresets',
    'systemPrompt',
    'tools',
    'sessionPersistence',
    'sessionProjections',
  ]

  private domain?: Domain<typeof agentTeamDomainSpec>
  private ledger?: AgentTeamLedger
  private readonly handles = new Map<AgentTeamMemberId, AgentHandle>()
  /** Live Member per session id; drives the root session/event listener. */
  private readonly memberBySessionId = new Map<SessionId, AgentTeamMemberId>()
  /** Live selection refs let model edits take effect without disposing the Session. */
  private readonly modelSelections = new Map<AgentTeamMemberId, ModelSelectionRef>()
  /** Agent ids with a turn in flight; restarts must wait for the boundary. */
  private readonly runningAgents = new Set<SessionId>()
  /** Per-Member runtime state: tool restrictions, skill mounts, warnings, private memory. */
  private readonly memberRuntime = new MemberRuntime({
    // Deferred field access: the constructor runs before `handles` is
    // populated, so the resolver must dereference at call time.
    ctx: this.ctx,
    liveMemberContext: memberId => {
      const handle = this.handles.get(memberId)
      if (handle === undefined) throw new Error(`Agent Member '${this.memberLabel(memberId)}' has no live session for a tool-policy update`)
      return handle.agent.ctx
    },
    runningAgents: this.runningAgents,
  })
  /**
   * The single seam for every per-Session stored read: handle lifecycle and
   * failure normalization live here, so a DSH persistence-interface change is
   * adapted once, and consumers choose policy by failure category instead of
   * matching error text.
   */
  private readonly sessionReader = new StoredSessionReader(this.ctx)
  /**
   * Why one Member shows error presence, per failure source. Reads prefer
   * activation, then runtime, then compaction; slots clear independently, so
   * a recovered runtime error re-reveals an outstanding compaction failure.
   * Keyed by Member rather than Session so a restarted Session cannot leak
   * stale keys; each runtime/compaction record carries the Session it
   * happened in, so a record left over from an earlier generation can be
   * recognized as stale instead of reading as the Member's current state.
   */
  private readonly memberFailures = new Map<AgentTeamMemberId, {
    /** Activation failed; the Member has no live Session to recover into. */
    activation?: AgentTeamMemberDiagnostic
    /** The Member Session reported agent/error. */
    runtime?: AgentTeamMemberFailureRecord
    /** Last non-busy automatic-compaction failure; entered transactions retain additional Session history. */
    compaction?: AgentTeamMemberFailureRecord
  }>()
  /**
   * Last durable Session-event timestamp per Member, process-local. Hung
   * detection reads it: a Member whose Agent stays `running` while this
   * timestamp ages past the supervision threshold is stuck, not working.
   */
  private readonly memberActivity = new Map<AgentTeamMemberId, number>()
  /**
   * How far the supervision escalation chain has advanced per flagged Member,
   * process-local like the counters it extends. Step one posts the alert so
   * any fellow Member (or the Human) can act through `team_supervise`; step
   * two is the Host's own fallback context reset; step three is the
   * archive-and-replace last resort. Steps advance one per supervision pass
   * while the Member stays abnormal, and an entry is dropped as soon as the
   * Member reads healthy again.
   */
  private readonly supervisionEscalation = new Map<AgentTeamMemberId, { trigger: SupervisionTrigger; restartAttempts: number; reset: boolean }>()
  /**
   * The best-effort final-Session recap per Member in the coercion chain. The
   * digest runs outside the ledger queue from the give-up onward and drops its
   * result into a mutable slot that the later handover reads without waiting;
   * an entry lives only while its escalation does.
   */
  private readonly retirementRecaps = new Map<AgentTeamMemberId, { recap?: SupervisionSessionRecap }>()
  private readonly pressurePolicy: PressurePolicyCoordinator
  private readonly notifiedInbox = new Map<AgentTeamMemberId, string>()
  private attachmentGcTimer?: ReturnType<typeof setInterval> | undefined
  /**
   * New-release check behind the settings footnote. Memory-only and
   * background-refreshed, so the profile read path never waits on the
   * network and every failure settles as "no update known".
   */
  private readonly humanUpdateCheck = createHumanUpdateChecker({ currentVersion: HUMAN_PROFILE_VERSION })

  private readonly recovery = new RecoveryCoordinator({
    wake: memberId => {
      this.ctx.logger.info(`agent-team: automatic recovery wakeup for member '${this.memberLabel(memberId)}' after consecutive recoverable failures`)
      this.injectRecovery(memberId)
    },
    onStandDown: (memberId, consecutiveFailures) => {
      this.ctx.logger.warn(`agent-team: member '${this.memberLabel(memberId)}' reached ${consecutiveFailures}/${RECOVERY_MAX_CONSECUTIVE_ERRORS} consecutive recoverable failures; leaving it in error for the operator`)
    },
  })
  /**
   * LLM response-shape guard: a completed model round that ends the turn with
   * no tool call and no proper completion marker is a faulty round, and a
   * bounded "continue" nudge keeps the Member going. See `response-guard.ts`.
   */
  private readonly responseGuard = new ResponseGuardCoordinator({
    nudge: (memberId, diagnostic) => {
      const handle = this.handles.get(memberId)
      if (handle === undefined) throw new Error(`member '${memberId}' has no active session`)
      // The guard observes the assistant message inside its append publish;
      // any inbox mutation here would re-enter that append and be rejected,
      // so the delivery waits for the next tick — by then the model loop has
      // finalized the faulting turn and the continue opens the next one.
      setImmediate(() => {
        const agent = this.handles.get(memberId)?.agent
        if (agent === undefined) return
        // Directive rather than a bare "continue": the live lane showed a
        // model that answers a one-word nudge with another tool-less text
        // round, spending the budget on narration. The reminder names both
        // exits the protocol allows — keep working, or close with the marker.
        const message = createUserMessage({
          content: [{ type: 'text', text: `Your last response ended the turn without a tool call and without the ${COMPLETION_MARKER} closing marker, so the Team guard reads your work as unfinished. If work remains, make your next tool call now and keep going. If everything you owe is already delivered where your teammates can see it, post the completion record in the relevant Thread, then end your reply with ${COMPLETION_MARKER}.` }],
          source: { kind: AGENT_TEAM_PLUGIN_ID, form: 'notice', summary: RESPONSE_GUARD_NOTICE_SUMMARY },
        })
        try {
          // The idle/carried-input split mirrors the DM relay: an idle
          // Member gets one ordinary turn; a busy one is steered into its
          // current turn. Queued user input also takes the followup lane so
          // the continue never leapfrogs it.
          if (agent.status === 'idle' || agent.inbox.nextTurn.some(queued => queued.source.kind === 'user')) agent.followup(message)
          else agent.steer(message)
        } catch (error) {
          this.ctx.logger.warn(`agent-team: response-guard continue for member '${this.memberLabel(memberId)}' was not delivered: ${error instanceof Error ? error.message : String(error)}`)
          return
        }
        this.ctx.logger.warn(`agent-team: response guard nudged member '${this.memberLabel(memberId)}' to continue (${diagnostic})`)
      })
    },
    onNudgeFailed: (memberId, error) => {
      this.ctx.logger.warn(`agent-team: response-guard continue for member '${this.memberLabel(memberId)}' was not delivered: ${error instanceof Error ? error.message : String(error)}`)
    },
    onStandDown: (memberId, consecutiveFaults) => {
      this.ctx.logger.warn(`agent-team: member '${this.memberLabel(memberId)}' produced ${consecutiveFaults}/${RESPONSE_GUARD_MAX_CONSECUTIVE + 1} consecutive faulty responses; standing down the continue nudge`)
    },
  })
  /**
   * The automatic last resort behind {@link recovery}: a Member that still holds
   * active Claims and cannot be brought back is archived and replaced by a
   * same-role generation that inherits its private memory and Channels, and asks
   * the Human admin in Channel to reassign the released work. See
   * `supervisor.ts` for the pass policy.
   */
  private readonly supervisor = new MemberSupervisor({
    candidates: () => {
      const ledger = this.ledger
      if (ledger === undefined) return []
      return ledger.listMembers()
        .filter(member => member.state === 'enabled')
        .map(member => member.memberId)
    },
    stateOf: memberId => this.supervisionStateOf(memberId),
    restart: async memberId => { await this.restartMemberUnderSupervision(memberId) },
    replace: async (memberId, trigger, restartAttempts) => { await this.escalateSupervisedMember(memberId, trigger, restartAttempts) },
    // The periodic tick is the chain's only driver in production: it advances
    // every open escalation (retrying a reset that never committed, then handing
    // over a Member the reset did not heal) before any fresh bring-up budget is
    // spent. A pass that only brought Members up would keep nudging a Member
    // whose chain had already opened and stalled.
    advanceEscalations: () => this.advanceSupervisionEscalations(),
    escalationOpen: memberId => this.supervisionEscalation.has(memberId),
    log: message => { this.ctx.logger.warn(`agent-team: ${message}`) },
  })
  /**
   * The idle-continuation policy behind the Task list: when every enabled
   * Agent sits `available`, open Tasks remain, and no ledger write landed for
   * the quiet hold, it fires one nudge per episode at the Workspace's
   * designated leader (`member.leader`). See `continuation-watcher.ts` for the
   * pass policy and `announceContinuationNudge` for the delivery; the read
   * lambdas all guard the pre-restore window where `this.ledger` is still
   * unset, reading as "nothing to watch".
   */
  private readonly continuationWatcher = new TaskContinuationWatcher({
    watchList: () => {
      const ledger = this.ledger
      if (ledger === undefined) return []
      return ledger.listMembers()
        .filter(member => member.state === 'enabled')
        .map(member => member.memberId)
    },
    membersInWorkspace: workspaceId => {
      const ledger = this.ledger
      if (ledger === undefined) return []
      return ledger.listMembers()
        .filter(member => member.state === 'enabled' && ledger.workspacesOf(member.memberId).includes(workspaceId))
        .map(member => member.memberId)
    },
    positionInWorkspace: workspaceId => this.ledger?.positionInWorkspace(workspaceId) ?? -1,
    presenceOf: memberId => {
      const member = this.ledger?.getMember(memberId)
      return member === undefined ? 'unavailable' : this.memberStatus(member).presence
    },
    incompleteTasks: () => this.ledger?.incompleteTasksForWatch() ?? [],
    leaderOf: workspaceId => {
      const ledger = this.ledger
      if (ledger === undefined) return undefined
      const leader = ledger.listMembers().find(member =>
        member.state === 'enabled' && member.leader === true && ledger.workspacesOf(member.memberId).includes(workspaceId))
      return leader === undefined ? undefined : { memberId: leader.memberId, handle: leader.handle }
    },
    ledgerPosition: () => this.ledger?.position() ?? -1,
    notify: async input => { await this.announceContinuationNudge(input) },
    log: message => { this.ctx.logger.warn(`agent-team: ${message}`) },
  })
  /**
   * The per-Member completion liaison: a Member that finishes on the 任务结束
   * marker and stays idle gets checked — report to the designated leader, or
   * an open-Task push to the Member itself when the Workspace has no leader,
   * whose explicit refusal (a reply opening with 拒绝继续) is relayed to
   * `@human`. See `completion-liaison.ts` for the pass policy and the three
   * `*Liaison*` deliveries below for the message shapes; the read lambdas
   * guard the pre-restore window exactly like the watcher's, and
   * `reportedToLeaderSince` reads `true` (nothing to do) before the ledger
   * exists.
   */
  private readonly completionLiaison = new CompletionLiaison({
    workspacesOf: memberId => this.ledger?.workspacesOf(memberId) ?? [],
    presenceOf: memberId => {
      const member = this.ledger?.getMember(memberId)
      return member === undefined ? 'unavailable' : this.memberStatus(member).presence
    },
    leaderOf: workspaceId => {
      const ledger = this.ledger
      if (ledger === undefined) return undefined
      const leader = ledger.listMembers().find(member =>
        member.state === 'enabled' && member.leader === true && ledger.workspacesOf(member.memberId).includes(workspaceId))
      return leader === undefined ? undefined : { memberId: leader.memberId, handle: leader.handle }
    },
    reportedToLeaderSince: (memberId, leaderId, sinceSequence) => this.ledger?.memberReportedToSince(memberId, leaderId, sinceSequence) ?? true,
    openTasksIn: workspaceId => (this.ledger?.incompleteTasksForWatch() ?? []).filter(task => task.workspaceId === workspaceId),
    interruptsOf: memberId => (this.ledger?.pendingInterruptsForMember(memberId) ?? []).map(interrupt => ({
      interruptRef: interrupt.interruptRef,
      checkpointRef: interrupt.checkpointRef,
      label: interrupt.label,
    })),
    handleOf: memberId => this.ledger?.getMember(memberId)?.handle,
    pushInterrupts: async input => { await this.pushLiaisonInterrupts(input) },
    notifyLeader: async input => { await this.notifyLiaisonLeader(input) },
    pushTasks: async input => { await this.pushLiaisonTasks(input) },
    notifyHumanFeedback: async input => { await this.notifyLiaisonFeedback(input) },
    log: message => { this.ctx.logger.warn(`agent-team: ${message}`) },
  })
  /**
   * Output-truncation escalation: a turn the provider cut off at the
   * output-token cap leaves the Member idle on a truncated answer, and the
   * designated leader — not the Host — decides how to proceed. See
   * `truncation-escalation.ts` for the episode policy and
   * `notifyLeaderOfTruncation` for the delivery; the read lambdas guard the
   * pre-restore window exactly like the watcher's and the liaison's.
   */
  private readonly truncationEscalation = new TruncationEscalator({
    workspacesOf: memberId => this.ledger?.workspacesOf(memberId) ?? [],
    leaderOf: workspaceId => {
      const ledger = this.ledger
      if (ledger === undefined) return undefined
      const leader = ledger.listMembers().find(member =>
        member.state === 'enabled' && member.leader === true && ledger.workspacesOf(member.memberId).includes(workspaceId))
      return leader === undefined ? undefined : { memberId: leader.memberId, handle: leader.handle }
    },
    handleOf: memberId => this.ledger?.getMember(memberId)?.handle,
    notify: async input => { await this.notifyLeaderOfTruncation(input) },
    log: message => { this.ctx.logger.warn(`agent-team: ${message}`) },
  })
  /**
   * The leader's standing watches, sampled on their own cadence. The watch
   * rows are durable ledger facts (`team/member-watch-started`), so a restart
   * re-reads who is watching whom; this coordinator owns only the sampling
   * policy and its reconstructible per-episode memory. Every notice is an
   * ordinary Team Assistant Message to the watching leader, which is what
   * puts the observation in the leader's Inbox instead of a private channel.
   */
  private readonly memberWatch = new MemberWatchMonitor({
    watches: () => this.ledger?.activeWatches() ?? [],
    handleOf: memberId => this.ledger?.getMember(memberId)?.handle,
    leaderHandleOf: memberId => this.ledger?.getMember(memberId)?.handle,
    sampleOf: async (memberId, workspaceId) => this.watchSampleOf(memberId, workspaceId),
    notify: async notice => { await this.notifyLeaderOfWatch(notice) },
    log: message => { this.ctx.logger.warn(`agent-team: ${message}`) },
  })
  /**
   * Team's domain half of the continuity projection: the durable ref naming,
   * the Team-notice rule, and the boundary judgement (committed messages,
   * claim changes, first Thread arrivals). Its claim attribution resolves the
   * Task's Thread through the ledger, which is why the resolver reads
   * `this.ledger` lazily — the fold may run before the domain is open, and an
   * unattributed boundary is still a valid anchor.
   */
  private readonly contextProjectionHost = new TeamContextProjectionHost({
    threadForTask: taskRef => this.ledger?.threadForTask(taskRef),
  })
  /**
   * Context self-management: the one deep module that turns a Member's
   * successful `context_rollover` tool result into its next private context
   * generation. The ledger owns the binding audit, the engine's projection
   * unit owns intent, and this coordinator owns only reconstructible process
   * state. See docs/architecture/README.md and docs/team-collaboration/README.md.
   */
  private readonly contextManagement = createTeamContextManagement({
    agentForMember: memberId => this.handles.get(memberId)?.agent,
    memberForAgent: agent => this.memberForAgent(agent),
    projectionForMember: (memberId, sessionId) => {
      const handle = this.handles.get(memberId)
      if (handle === undefined || handle.agent.session.id !== sessionId) return undefined
      // The engine's registered unit folds this Session's durable log (replay
      // on attach, then incrementally per committed event) and keys every ref
      // to the Session that recorded it; the registry materializes the cell
      // lazily, so a Member that has not folded yet is built on this read.
      return this.ctx.sessionProjections.stateOf(handle.agent.session, CONTEXT_CONTINUITY_PROJECTION_KEY)
    },
    executeTransition: (memberId, plan) => this.executeMemberTransition(memberId, plan),
    log: message => { this.ctx.logger.warn(`agent-team: ${message}`) },
  })
  private lifecycleTail: Promise<void> = Promise.resolve()
  private accepting = true
  /**
   * Single-writer claim on the ledger's file medium, taken in `init` and
   * released on dispose. A leaked patch-reload survivor of an earlier mount
   * sees itself superseded here and stops committing before it can fork the
   * chain; see ledger-fence.ts. Undefined for hosts whose ledger medium is not
   * the shared SQLite file (memory-backend test harnesses), which own the
   * ledger in-process and must not touch the DSH home.
   */
  private fence: LedgerFence | undefined
  /** One adoption attempt per boot: the two readiness edges fire once each, and this keeps their attempt single. */
  private legacyAdoptionStarted = false
  /**
   * Members with one scheduled background compaction. The remote rejects a
   * second schedule per Member while one is pending; membership clears when
   * the background body settles (ran, dropped, or failed).
   */
  private readonly pendingCompactions = new Set<AgentTeamMemberId>()
  /**
   * Members with one scheduled fresh-start context reset (task-start
   * policy). Claim and atomic-start boundaries schedule; the dedupe keeps
   * one in-flight body per Member, and membership clears when the body
   * settles (ran, dropped, or failed).
   */
  private readonly pendingPolicyResets = new Set<AgentTeamMemberId>()
  /**
   * Fresh-start Members whose last turn ended by announcing completion (the
   * completion marker): the next dispatch — an Inbox wake carrying new unread
   * work — renews their context first and the task is delivered into the fresh
   * generation, so every task really starts from system context plus that
   * task. A completion alone never renews; the arm waits for dispatch. Restored
   * over a marker tail by a later boot as well, so a restart keeps the promise.
   */
  private readonly armedFreshStartReset = new Set<AgentTeamMemberId>()
  /**
   * Per Member, the ledger sequence up to which a sender explicitly declared
   * "this work needs their live context" ({@link AgentTeamSendMessageRequest.keepContext}):
   * the dispatch gate reads direct work newer than that sequence as a real new
   * task and direct work at or before it as the exempted delivery. Process-local
   * like the arm, and monotone by construction — a later dispatch always
   * carries a higher sequence — so one exemption can never cover a second task.
   */
  private readonly keptDispatchSequence = new Map<AgentTeamMemberId, number>()
  /**
   * Per Member, the dispatch whose keep-or-renew judgement is in flight at the
   * model. The Inbox gate holds every wake while one is running — the answer
   * decides whether that delivery lands in the live Session or after a renewal —
   * and one call at a time keeps a burst of dispatches from spending a call each.
   */
  private readonly judgingFreshStart = new Map<AgentTeamMemberId, number>()
  /**
   * The Session id of the most recent context renewal committed for each
   * Member, whatever path renewed it (Human menu, supervision, doctor, or the
   * fresh-start policy). A waiting reset body reads it as "already renewed":
   * the fresh-generation intent is satisfied, and the body must not stack a
   * second erase onto a context someone else just made fresh.
   */
  private readonly renewedSessionByMember = new Map<AgentTeamMemberId, SessionId>()
  /** One in-flight auto-prune sweep per Member; the task-start twin of pendingPolicyResets. */
  private readonly pendingPruneSweeps = new Set<AgentTeamMemberId>()
  /**
   * One in-flight live runtime apply per Member; the edit twin of
   * pendingPruneSweeps. Concurrent edits coalesce into the one running body,
   * which re-applies the CURRENT ledger facts, so no edit is lost.
   */
  private readonly pendingMemberApplies = new Set<AgentTeamMemberId>()
  /**
   * Presence wake epoch: Agent running/idle/failure is runtime state with no
   * durable fact behind it, so the presence scope counts those edge wakes in
   * process. It never takes part in a projection waiter's comparison.
   */
  private presenceEpoch = 0
  private readonly changeWaiters = new Set<ChangeWaiter>()

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'agentTeam')
    this.pressurePolicy = new PressurePolicyCoordinator({
      memberForAgent: agent => {
        const member = this.memberForAgent(agent)
        return member === undefined ? undefined : { memberId: member.memberId, sessionId: agent.id }
      },
      compactionForAgent: agent => this.ctx.agentPresets.serviceFor(agent, 'compaction'),
      compactWithFallback: (agent, memberId, signal) => this.policyCompactWithFallback(memberId, agent, signal),
      log: message => { this.ctx.logger.warn(`agent-team: ${message}`) },
    })
    // Human profile: this Host row's own Config (name + avatarRef, both
    // volatile), so the settings service derives its form from the schema and
    // an edit lands in the running plugin without a remount. Team's own page
    // owns that surface, so the row declares itself presentation-owned rather
    // than schema-page owned. Reads go straight to the live Config reference;
    // this subscription is the change signal the retired section hook used to
    // be — the ledger's runtime @ handle follows every edit.
    this.ctx.inject(['settings'], settingsCtx => {
      settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, this.ctx.fiber))
      this.adoptLegacyHumanProfile()
    })
    this.ctx.on('loader/volatile-update', () => { this.syncHumanHandle() })
  }

  /** Current human display name; the single source for team_view and @ matching. */
  humanHandle(): string {
    const name = normalizeHumanName(this.config.name.get())
    return name === '' ? HUMAN_PROFILE_DEFAULT_NAME : name
  }

  /** Current human profile reference held in this Host row's Config (name + avatarRef). */
  humanProfile(): { readonly name: string; readonly avatarRef?: string | undefined } {
    const avatarRef = this.config.avatarRef.get()
    return Object.freeze({ name: this.humanHandle(), ...(avatarRef === undefined ? {} : { avatarRef }) })
  }

  /** Push the current Config name into the ledger's runtime @ handle. */
  private syncHumanHandle(): void {
    try {
      this.ledger?.setHumanDisplayHandle(this.humanHandle())
    } catch {
      // The ledger is absent before Service.init; the post-open sync covers it.
    }
  }

  /**
   * The two judgements the Config schema cannot make about a Human name: the
   * same non-empty floor as Member handles, plus global uniqueness against live
   * Members. `setHumanProfile` runs it before the write, so a colliding rename
   * rejects instead of persisting. It reads the one field it judges, so the
   * caller passes the name alone rather than a whole profile shape.
   */
  private validateHumanProfile(value: { readonly name: string }): void {
    const name = assertValidHumanName(value.name)
    const ledger = this.ledger
    if (ledger === undefined) return
    const normalized = name.normalize('NFKC').trim().toLowerCase()
    for (const member of ledger.listMembers()) {
      if (member.state === 'inactive' || member.state === 'archived') continue
      if (member.handle.normalize('NFKC').trim().toLowerCase() === normalized) {
        throw new Error(`human name '${name}' collides with an existing Member handle`)
      }
    }
  }

  /**
   * One-time adoption of the profile facts the retired `agent-team-human`
   * settings section held (see `LEGACY_HUMAN_PROFILE_SECTION` for why the
   * upstream importer cannot carry them over). The values land in this Host
   * row's own Config through the same Remote the profile page writes, so the
   * page, the ledger's @ handle, and every avatar seat follow as after any
   * edit. Readiness has two one-way edges — the settings service arrives, the
   * ledger opens — and whichever fires second starts the attempt; only a
   * pristine profile is adopted, and one attempt per boot is its whole
   * lifetime, so adoption never loops and never re-writes.
   */
  private adoptLegacyHumanProfile(): void {
    if (this.legacyAdoptionStarted) return
    if (this.ctx.get('settings') === undefined || this.ledger === undefined) return
    this.legacyAdoptionStarted = true
    void this.adoptLegacyHumanProfileNow().catch((error: unknown) => {
      this.ctx.logger.warn('agent-team: legacy human profile adoption failed: %s', String(error))
    })
  }

  /** Carry the first legacy document that still has the section into a pristine profile. */
  private async adoptLegacyHumanProfileNow(): Promise<void> {
    // A profile-launched Host always carries the profile context; a Host booted
    // without one still adopts from the DSH home, which is where a pre-rc.1
    // install kept the document. Read through `get`: cordis refuses a direct
    // `ctx.profileContext` for a service this plugin does not declare, and
    // adoption may not gate the Host on app-boot.
    const profileHome: string | undefined = this.ctx.get('profileContext')?.home
    const homes = profileHome === undefined ? [dshHomePath()] : [dshHomePath(), profileHome]
    const candidates = new Set(homes.flatMap(home => [join(home, 'settings.yaml'), join(home, 'settings.yaml.imported')]))
    let legacy: LegacyHumanProfileFields | undefined
    let source: string | undefined
    for (const candidate of candidates) {
      let text: string
      try {
        text = readFileSync(candidate, 'utf8')
      } catch {
        // Absent candidates are the steady state once adoption settles; the
        // live document is one only because the first boot after the upgrade
        // can race the importer that renames it.
        continue
      }
      const parsed = parseLegacyHumanProfile(text)
      if (parsed !== undefined) {
        legacy = parsed
        source = candidate
        break
      }
    }
    if (legacy === undefined || source === undefined) return
    // The reference is carried only while its bytes still draw: the avatar
    // store is the authority for whether this avatar exists at all.
    let avatarRef = legacy.avatarRef
    if (avatarRef !== undefined && await readHumanAvatar(humanAvatarsRoot(), avatarRef) === undefined) avatarRef = undefined
    const plan = planLegacyAdoption(this.humanProfile(), {
      ...(legacy.name === undefined ? {} : { name: legacy.name }),
      ...(avatarRef === undefined ? {} : { avatarRef }),
    })
    if (plan === undefined) return
    await this.setHumanProfile(plan)
    this.ctx.logger.info('agent-team: adopted the legacy human profile from %s', source)
  }

  /** Open the durable ledger and restore every enabled Member independently. */
  protected async [Service.init](): Promise<void> {
    // The continuity projection registers once per Host: the framework keeps
    // one unit per projection key and drives it for every Session, so Team's
    // fold is session-agnostic and the state carries the identity it folds.
    // The registration rides this plugin's fiber — unloading Team removes the
    // key (and its cached cells) from later drives and snapshots.
    this.ctx.effect(() => this.ctx.root.sessionProjections.register(
      createTeamContextProjectionDefinition(this.contextProjectionHost),
    ), 'agentTeam.contextProjection')
    this.ctx.on('agent/error', ({ agent, error }) => {
      const member = this.memberForAgent(agent)
      if (member === undefined) return
      const message = error instanceof Error ? error.message : String(error)
      this.setMemberFailure(member.memberId, 'runtime', message, agent.id)
      const kind = classifyRecoverableError(message)
      if (kind !== undefined) this.ctx.logger.warn(`agent-team: member '${member.handle}' hit a recoverable ${kind} error; recording a consecutive error occurrence`)
      this.recovery.onError(member.memberId, message)
      this.supervisor.onError(member.memberId, message)
      this.emitMemberPresenceChanged(member)
    })
    this.ctx.on('agent/status', ({ agent, status }) => {
      const member = this.memberForAgent(agent)
      if (status === 'running') this.runningAgents.add(agent.id)
      else this.runningAgents.delete(agent.id)
      if (member !== undefined) this.memberActivity.set(member.memberId, Date.now())
      if (status === 'running' && member !== undefined) {
        const recovered = this.clearMemberFailure(member.memberId, 'runtime')
        if (recovered) this.notifiedInbox.delete(member.memberId)
        this.emitMemberPresenceChanged(member)
        // A rollover/recovery in flight delivers its own sequenced
        // rederived Inbox after the handoff and carried input; a status-driven
        // steer here would claim the handoff turn's next step and leapfrog
        // the carried messages.
        if (!this.contextManagement.isTransitioning(member.memberId)) this.notifyMember(agent)
      }
      // A turn that ends without an error closes any automatic recovery episode.
      // The idle transition is itself presence-affecting (working → available),
      // so it must wake presence watchers exactly like the running transition
      // above; without this wake, cached Client member rows keep showing the
      // Member as working after every turn until an unrelated change arrives.
      if (status === 'idle' && member !== undefined) {
        if (this.memberFailures.get(member.memberId)?.runtime === undefined) {
          this.recovery.onCleanTurnEnd(member.memberId)
          this.supervisor.onCleanTurn(member.memberId)
        }
        this.emitMemberPresenceChanged(member)
      }
    })
    // The store's dispatch carrier is untagged, so a scope-tagged listener
    // inside the Agent setup would receive nothing; one root listener that
    // maps the session id back to its Member is the seam that works (same
    // shape as the `agent/status` listener above). The first turn of a
    // freshly published Member cannot race this: `handles.set()` precedes the
    // same activation continuation that publishes the Agent, so by the time
    // any tool call streams, the map lookup succeeds.
    this.ctx.on('session/event', (session, event) => {
      const memberId = this.memberBySessionId.get(session.id)
      if (memberId === undefined) return
      this.memberActivity.set(memberId, Date.now())
      const handle = this.handles.get(memberId)
      if (handle === undefined || handle.agent.session.id !== session.id) return
      // A successful assistant response ends any open provider-overflow
      // recovery sequence for this Member.
      if (event.type === 'assistant/message') {
        this.pressurePolicy.onAssistantMessage(handle.agent)
        // The response-shape guard runs on every completed model round. The
        // guard observes the round inside its append publish, so its delivery
        // defers to the next tick (an inbox mutation here would re-enter the
        // append) and then steers a still-open turn or opens the next one.
        this.responseGuard.onAssistantMessage(memberId, classifyAssistantResponse(event.data.message.content), event.data.interrupted === true)
        // The completion liaison reads the same round's prose for the one
        // contract it owns: a reply opening with 拒绝继续 declines an awaited
        // Task push. Aborted prefixes are not the Member's decision.
        if (event.data.interrupted !== true) this.completionLiaison.onAssistantText(memberId, assistantPlainText(event.data.message.content))
      }
      // The stop lane of the guard: a turn that ended is the moment the user
      // sees. A clean completion (the marker) arms the fresh-start policy for
      // the next dispatch; a stop that left work unfinished gets a bounded
      // continue reminder even when the in-loop budget already stood down.
      if (event.type === 'turn/end') {
        const reasonKind = event.data.reason?.kind ?? 'unknown'
        const stopOutcome = this.responseGuard.onTurnStop(memberId, reasonKind)
        // A stop the provider forced at the output-token cap leaves the Member
        // idle on a truncated answer; the Host does not auto-continue it — the
        // designated leader is told and decides what happens to the Member.
        if (reasonKind === 'max-tokens') this.truncationEscalation.onTruncatedStop(memberId)
        if (stopOutcome === 'marker') {
          // Closing a turn on the marker ends any open truncation episode: the
          // Member is back to working through its work normally.
          this.truncationEscalation.onCleanStop(memberId)
          this.armFreshStartReset(memberId)
          // The completion liaison opens one report-check episode and closes
          // any Task-push decision the Member was mulling over.
          this.completionLiaison.onCompletedStop(memberId, this.requireLedger().position())
        }
      }
      // Context management reacts only after a successful durable tool/result;
      // the projection (not this listener) decides what that means.
      this.contextManagement.onSessionEvent(memberId, handle.agent, event)
    })
    // Claim the single-writer authority before opening the domain: any older
    // live ledger for this storage is superseded from here on, and its own
    // next ledger call fails the fence instead of interleaving a fork.
    const fenceDirectory = this.ledgerFenceDirectory()
    if (fenceDirectory !== undefined) {
      this.fence = ledgerFenceFor(fenceDirectory)
      await this.fence.claim()
    }
    const domain = await this.ctx.storageDomain.open(agentTeamDomainSpec)
    this.ctx.effect(() => async () => {
      this.accepting = false
      this.recovery.dispose()
      this.responseGuard.dispose()
      this.supervisor.dispose()
      this.continuationWatcher.dispose()
      this.completionLiaison.dispose()
      this.truncationEscalation.dispose()
      this.memberWatch.dispose()
      this.contextManagement.dispose()
      this.pressurePolicy.dispose()
      if (this.attachmentGcTimer !== undefined) clearInterval(this.attachmentGcTimer)
      this.attachmentGcTimer = undefined
      this.emitChanged()
      await this.lifecycleTail
      await Promise.all([...this.handles.values()].map(handle => handle.dispose()))
      this.handles.clear()
      this.armedFreshStartReset.clear()
      this.keptDispatchSequence.clear()
      this.judgingFreshStart.clear()
      this.renewedSessionByMember.clear()
      this.modelSelections.clear()
      this.memberRuntime.disposeAll()
      this.runningAgents.clear()
      this.memberActivity.clear()
      this.supervisionEscalation.clear()
      this.retirementRecaps.clear()
      await this.fence?.release()
      await domain.close()
    }, 'agentTeam.dispose')
    this.domain = domain
    // Supersession is global for this instance, not just a commit refusal:
    // once the fence answers false, the Remote entry points must fail fast
    // too, so a leaked old mount stops serving instead of answering reads
    // from a projection that a newer host has already moved past.
    const ledger = new AgentTeamLedger(domain.table('operations'), this.fence === undefined ? {} : { ownsAuthority: async () => {
      const owned = await this.fence!.owns()
      if (!owned) this.accepting = false
      return owned
    } })
    this.ledger = ledger
    // A live Config edit in the constructor's window may have arrived before
    // the ledger existed; sync once here so @ matching starts from the stored
    // name.
    this.syncHumanHandle()
    this.adoptLegacyHumanProfile()
    const initialization = await ledger.initialize()
    if (initialization.committed) this.emitCommitted(initialization.value)
    this.startAttachmentGc(ledger)
    // One metadata listing serves every Member restore; per-member list calls
    // would repeat the same I/O linearly during startup.
    const persistedSessions = new Set((await this.persistedSessionHeaders()).map(snapshot => snapshot.header.id))
    await this.sweepWorkspaceParticipations(ledger)
    for (const member of ledger.listMembers()) {
      if (member.state === 'enabled') await this.activateMember(member, undefined, persistedSessions)
      else if (member.state === 'inactive') await this.memberRuntime.cleanupRemovedMember(member)
    }
    // Supervision starts only after the restore settled: a pass that ran while
    // Members were still activating would read every cold Session as an
    // abnormal stop and start handing work over to fresh generations. The
    // continuation watcher rides the same restore gate — its pass would
    // otherwise read the activation window as all-idle with open Tasks.
    this.supervisor.start()
    this.continuationWatcher.start()
    // The completion liaison reads presence and the ledger tail alike, so it
    // rides the same restore gate as the two passes above.
    this.completionLiaison.start()
    // Standing watches restore with the roster, so their first pass samples a
    // settled Team instead of an activating one.
    this.memberWatch.start()
  }

  /**
   * Lazy Workspace-deletion handling: a Workspace that no longer exists can
   * only be detected through the registry — there is no deletion event. A
   * dead non-default participation is withdrawn here (its Claims and
   * Attention release through the normal leave path); a dead default
   * Workspace is left alone — activation fails on its missing cwd and the
   * Member surfaces as unavailable for Human attention.
   */
  private async sweepWorkspaceParticipations(ledger: AgentTeamLedger): Promise<void> {
    for (const member of ledger.listMembers()) {
      if (member.state === 'inactive' || member.state === 'archived') continue
      for (const workspaceId of ledger.workspacesOf(member.memberId)) {
        if (workspaceId === member.workspaceId || this.ctx.workspaceRegistry.get(workspaceId) !== undefined) continue
        this.ctx.logger.warn(`agent-team: workspace '${workspaceId}' is gone; withdrawing member '${member.handle}' from it`)
        try {
          await ledger.leaveWorkspace({ requestId: randomUUID() as AgentTeamRequestId, workspaceId, memberId: member.memberId, actor: agentTeamHumanActor() })
        } catch (error) {
          this.ctx.logger.warn(`agent-team: failed to withdraw member '${member.handle}' from deleted workspace '${workspaceId}': ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
  }

  /**
   * Whether one Member Session has durable persisted content, decided through
   * {@link SessionPersistence.stat} rather than a bare metadata listing: the
   * backend reports a still-draining session through its pending header, so a
   * resume racing a suspend's fire-and-forget final flush cannot mistake a
   * still-draining persisted Session for an unpersisted one and fork a fresh
   * generation over it.
   */
  private async sessionPersisted(sessionId: SessionId): Promise<boolean> {
    return this.sessionReader.exists(sessionId)
  }

  /** Resolve one exact live Agent to its durable Team Member; forks do not inherit identity. */
  memberForAgent(agent: Agent): AgentTeamAgentMember | undefined {
    for (const [memberId, handle] of this.handles) {
      if (handle.agent === agent) return this.requireLedger().getMember(memberId)
    }
    return undefined
  }

  /** Return every durable Member with current process availability. */
  members(): readonly AgentTeamAgentMemberStatus[] {
    return this.requireLedger().listMembers().map(member => this.memberStatus(member))
  }

  /** Read-only navigation lookup for branded Task refs found in message bodies. */
  @Remote('resolveTaskRefs')
  resolveTaskRefs(request: AgentTeamResolveTaskRefsRequest): AgentTeamResolveTaskRefsResult {
    this.requireWorkspace(request.workspaceId)
    const seen = new Set<AgentTeamTaskRef>()
    const taskRefs = request.taskRefs.filter(taskRef => {
      if (seen.has(taskRef)) return false
      seen.add(taskRef)
      return true
    })
    return Object.freeze({ resolved: Object.freeze(this.requireLedger().resolveTaskRefs(request.workspaceId, taskRefs)) })
  }

  /** Read-only navigation lookup for branded Thread refs found in message bodies. */
  @Remote('resolveThreadRefs')
  resolveThreadRefs(request: AgentTeamResolveThreadRefsRequest): AgentTeamResolveThreadRefsResult {
    this.requireWorkspace(request.workspaceId)
    const seen = new Set<AgentTeamThreadRef>()
    const threadRefs = request.threadRefs.filter(threadRef => {
      if (seen.has(threadRef)) return false
      seen.add(threadRef)
      return true
    })
    return Object.freeze({ resolved: Object.freeze(this.requireLedger().resolveThreadRefs(request.workspaceId, threadRefs)) })
  }

  /** Browser-safe Human roster, optionally filtered to one participation. */
  @Remote('members')
  membersForClient(request: AgentTeamMembersRequest): readonly AgentTeamClientMemberStatus[] {
    if (request.workspaceId !== undefined) this.requireWorkspace(request.workspaceId)
    const ledger = this.requireLedger()
    return this.members()
      .filter(status => request.workspaceId === undefined || ledger.participatesIn(status.member.memberId, request.workspaceId))
      .map(({ member: { privateMemoryPath: _privateMemoryPath, ...member }, ...status }) => Object.freeze({ ...status, member: Object.freeze(member), workspaceIds: ledger.workspacesOf(member.memberId) }))
  }

  /**
   * Human read behind the Prompt dialog: the stored prompt profile, the
   * lifecycle facts it renders from, and — when the Member has a live
   * session — its actual assembled sections once, with drop/protection/stale
   * marks the dialog and the runtime listener agree on, the usage projection
   * folded from the Member's own session logs, and — with the autoPrune switch
   * on — the zero-use candidate list the confirm surface renders from.
   */
  @Remote('memberPromptView')
  async memberPromptView(request: AgentTeamMemberPromptViewRequest): Promise<AgentTeamMemberPromptView> {
    const member = this.requireLedger().getMember(request.memberId)
    if (member === undefined) throw new Error(`unknown Agent Member '${request.memberId}'`)
    const handle = this.handles.get(request.memberId)
    const projection = handle === undefined ? undefined : await this.promptSectionProjection(handle, member.prompt)
    return Object.freeze({
      memberId: member.memberId,
      handle: member.handle,
      description: member.description,
      state: member.state,
      ...(member.prompt === undefined ? {} : { prompt: member.prompt }),
      ...(projection === undefined ? {} : { sections: projection.entries }),
      ...(projection?.usagePartial ? { usagePartial: true } : {}),
      ...(projection !== undefined && member.prompt?.autoPrune === true && projection.candidates.length > 0
        ? { pruneCandidates: projection.candidates }
        : {}),
      ...(member.model === undefined ? {} : { model: member.model }),
      ...(member.capabilities === undefined ? {} : { capabilities: member.capabilities }),
      ...(member.contextStartPolicy === undefined ? {} : { contextStartPolicy: member.contextStartPolicy }),
      ...(member.contextWindow === undefined ? {} : { contextWindow: member.contextWindow }),
    })
  }

  /**
   * Human read behind the session-history dialog: every Session generation
   * this Member has run, newest first. The walk follows the stored
   * `parentSession` fork lineage from the live handle's Session — or, when no
   * generation is live, from the ledger-bound Session — the live generation
   * reads through its handle, archived ancestors through the stored-session
   * reader — capped at the same depth as the timeline and the usage fold. An
   * unreadable ancestor degrades to a metadata-less entry and ends the walk;
   * the list never claims depth it could not verify. A current binding that
   * cannot be read (a transition committed while its Session never landed)
   * degrades the same way but continues at the predecessor the ledger
   * recorded, so archived history survives the newest generation's crash. A
   * durable binding that has already moved past the live handle (a context
   * transition in progress) never enters the list: the bound Session may not
   * exist on disk yet, while the handle's generation still carries the newest
   * readable events.
   */
  @Remote('memberSessions')
  async memberSessions(request: AgentTeamMemberSessionsRequest): Promise<readonly AgentTeamMemberSessionSummary[]> {
    const member = this.requireLedger().getMember(request.memberId)
    if (member === undefined) throw new Error(`unknown Agent Member '${request.memberId}'`)
    const lineage = await this.memberSessionLineage(member)
    const ledger = this.requireLedger()
    return Object.freeze(lineage.map(generation => Object.freeze({
      sessionId: generation.sessionId,
      isCurrent: generation.isCurrent,
      // A generation inherited across a succession edge belongs to a retired
      // predecessor; carry its handle so the page labels it apart from the
      // successor's own generations. The owner is the requested Member on its
      // own generations (no label).
      ...(generation.ownerMemberId === member.memberId
        ? {}
        : { predecessorHandle: ledger.getMember(generation.ownerMemberId)?.handle }),
      ...(generation.createdAt === undefined ? {} : { createdAt: generation.createdAt }),
      ...(generation.eventCount === undefined ? {} : { eventCount: generation.eventCount }),
    })))
  }

  /**
   * One bounded transcript page of one generation from the same lineage walk:
   * the generation's OWN events only (the fork-inherited prefix belongs to
   * the ancestor page), newest tail first, older pages reached through the
   * returned cursor. A Session outside the Member's lineage is refused —
   * this read never becomes a general session reader.
   */
  @Remote('memberSessionTranscript')
  async memberSessionTranscript(request: AgentTeamMemberSessionTranscriptRequest): Promise<AgentTeamMemberSessionTranscript> {
    const member = this.requireLedger().getMember(request.memberId)
    if (member === undefined) throw new Error(`unknown Agent Member '${request.memberId}'`)
    const sessionId = SessionId(request.sessionId)
    const lineage = await this.memberSessionLineage(member)
    const generation = lineage.find(entry => entry.sessionId === sessionId)
    if (generation === undefined) throw new Error(`Session '${sessionId}' is not in the lineage of Agent Member '${member.handle}'`)
    if (generation.events === undefined) throw new Error(`Session '${sessionId}' could not be read: ${generation.unreadableDetail ?? 'unreadable'}`)
    const rendered: Array<{ seq: number; time: number; role: AgentTeamMemberSessionTranscriptEntry['role']; text: string }> = []
    for (const event of generation.events) {
      if (request.beforeSeq !== undefined && event.seq >= request.beforeSeq) continue
      // The Human review surface reads the same fold as the doctor in multiline
      // mode — line breaks survive so the page can render Markdown — and
      // additionally expands `agent/inbox/spliced` batches, which is how a
      // Member's wake input (Team relays, Host notices) reached the surface.
      for (const entry of humanTranscriptEntriesOf(event)) {
        rendered.push({ seq: event.seq, time: event.time, role: entry.role, text: entry.text })
      }
    }
    let start = rendered.length
    let chars = 0
    while (start > 0) {
      const candidate = rendered[start - 1]!
      if (start < rendered.length
        && (rendered.length - start + 1 > SESSION_TRANSCRIPT_PAGE_ENTRIES || chars + candidate.text.length > SESSION_TRANSCRIPT_PAGE_CHARS)) break
      chars += candidate.text.length + 1
      start -= 1
    }
    const page = rendered.slice(start)
    return Object.freeze({
      entries: Object.freeze(page.map(entry => Object.freeze(entry))),
      hasEarlier: start > 0,
      ...(start > 0 ? { nextBeforeSeq: page[0]!.seq } : {}),
    })
  }

  /**
   * The lineage walk: the requested Member's own generations newest-first,
   * then — when it carries a supervision succession edge — the predecessor's
   * generations, and so on through the chain. Each Member's own walk follows
   * the Session `parentSession` chain (fork generations) and the ledger's
   * recorded `previousSessionForMember` fallback for an unreadable current
   * binding. The whole walk is bounded by `MAX_TIMELINE_ANCESTORS`, and a
   * `seen` set keeps a corrupt cycle from looping; a missing or unreadable
   * predecessor ends the walk safely instead of throwing.
   */
  private memberSessionLineage(member: AgentTeamAgentMember): Promise<readonly {
    readonly sessionId: SessionId
    readonly isCurrent: boolean
    readonly ownerMemberId: AgentTeamMemberId
    readonly createdAt?: number
    readonly eventCount?: number
    readonly events?: readonly SessionEvent[]
    readonly unreadableDetail?: string
  }[]> {
    return (async () => {
      const generations: Array<{
        readonly sessionId: SessionId
        readonly isCurrent: boolean
        readonly ownerMemberId: AgentTeamMemberId
        readonly createdAt?: number
        readonly eventCount?: number
        readonly events?: readonly SessionEvent[]
        readonly unreadableDetail?: string
      }> = []
      const ledger = this.requireLedger()
      const seenSessions = new Set<SessionId>()
      const seenMembers = new Set<AgentTeamMemberId>()
      let owner: AgentTeamAgentMember | undefined = member
      // Only the requested Member's first generation is `isCurrent`; every
      // generation inherited across the succession edge is history.
      let ownsCurrent = true
      while (owner !== undefined && generations.length <= MAX_TIMELINE_ANCESTORS) {
        if (seenMembers.has(owner.memberId)) break
        seenMembers.add(owner.memberId)
        const handle = this.handles.get(owner.memberId)
        // The live handle, when there is one, IS the current readable generation
        // even after the durable binding has moved onto its next Session: during
        // a context transition the bound Session may not exist on disk yet, and
        // a stored read of it would fail with "not found" while the handle's
        // generation still carries the Member's newest events.
        let sessionId: SessionId | undefined = handle?.agent.session.id ?? owner.sessionId
        let firstOfMember = true
        let guard = 0
        while (sessionId !== undefined && guard++ <= MAX_TIMELINE_ANCESTORS && generations.length <= MAX_TIMELINE_ANCESTORS) {
          if (seenSessions.has(sessionId)) break
          const isCurrent = ownsCurrent && generations.length === 0
          if (isCurrent && handle !== undefined && handle.agent.session.id === sessionId) {
            const session = handle.agent.session
            seenSessions.add(sessionId)
            generations.push({
              sessionId,
              isCurrent,
              ownerMemberId: owner.memberId,
              createdAt: session.header.createdAt,
              eventCount: session.snapshotEvents().length,
              events: session.ownEvents(),
            })
            sessionId = session.header.parentSession
            firstOfMember = false
            continue
          }
          const read = await this.sessionReader.read(sessionId)
          if (!read.ok) {
            seenSessions.add(sessionId)
            generations.push({ sessionId, isCurrent, ownerMemberId: owner.memberId, unreadableDetail: read.failure.detail })
            // A durable binding can name a Session that never materialized (a
            // renewal or rollover committed while its activation failed or is
            // still running). The ledger recorded which Session that transition
            // retired: when the unreadable entry IS the Member's bound Session,
            // resume the walk at the recorded predecessor instead of ending —
            // archived history stays auditable through exactly the crash that
            // generation cannot describe. Mid-walk ancestor failures keep their
            // old contract: the entry states the stop and nothing follows it.
            const predecessor = firstOfMember && sessionId === owner.sessionId
              ? ledger.previousSessionForMember(owner.memberId)
              : undefined
            if (predecessor === undefined || predecessor === sessionId) break
            sessionId = predecessor
            firstOfMember = false
            continue
          }
          const inspection = read.inspection
          seenSessions.add(sessionId)
          generations.push({
            sessionId,
            isCurrent,
            ownerMemberId: owner.memberId,
            createdAt: inspection.header.createdAt,
            eventCount: inspection.events.length,
            events: inspection.events.slice(inspection.inheritedEventCount),
          })
          sessionId = inspection.header.parentSession
          firstOfMember = false
        }
        ownsCurrent = false
        const predecessorId: AgentTeamMemberId | undefined = owner.predecessorMemberId
        owner = predecessorId === undefined ? undefined : ledger.getMember(predecessorId)
      }
      return generations
    })()
  }

  /**
   * One-shot LLM curation for the Prompt dialog, propose-only. The call rides
   * the Host context's public `llm.stream()` seam (the same in-process path
   * compaction summarizers use) on the Member's effective route, races the
   * client's cancellation signal against a fixed timeout, and returns a
   * validated proposal. It never commits anything: the only durable prompt
   * paths stay member-updated (edit) and member-added (create), and the
   * proposal only ever backfills the dialog form for the Human to review.
   * Input covers the live assembled sections (name, bounded text, protected
   * and prose marks), the private skills catalog names, the member identity,
   * and the Human's requirements; the reply is parsed defensively and every
   * proposed name is re-validated against the live section set and catalog
   * before it reaches the dialog. Requires an enabled Member with a live
   * session — the section input IS the live assembly.
   */
  @Remote('curateMemberPrompt')
  async curateMemberPrompt(request: AgentTeamCurateMemberPromptRequest, signal?: AbortSignal): Promise<AgentTeamCurateMemberPromptResult> {
    this.requireAccepting()
    const member = this.requireLedger().getMember(request.memberId)
    if (member === undefined) throw new Error(`unknown Agent Member '${request.memberId}'`)
    if (member.state !== 'enabled') throw new Error(`Agent Member '${member.handle}' is ${member.state}; only enabled Members can curate their prompt`)
    const active = this.handles.get(request.memberId)
    if (active === undefined) throw new Error(`Agent Member '${member.handle}' has no active session; curation reads the live prompt assembly`)
    const requirements = request.requirements.trim()
    if (requirements === '') throw new Error('curation requirements must not be empty')
    const modelUsed = this.currentModelSelectionOf(request.memberId)
    const proposal = await this.curationProposal(active, member, modelUsed, requirements, signal)
    return Object.freeze({ proposal, modelUsed })
  }

  /** Build the bounded curation input from one live assembly and catalog. */
  private curateInput(handle: AgentHandle, member: AgentTeamAgentMember, requirements: string): Promise<CuratePromptInput> {
    const scope = scopeOf(handle.agent.ctx)!
    return this.ctx.systemPrompt.assemble({ scope }).then(async assembly => {
      const toolNames = this.ctx.tools.schemas(scope).map(tool => tool.name)
      const mapping = sectionToolMapping(assembly.sections, toolNames)
      return {
        handle: member.handle,
        description: member.description,
        ...(member.prompt?.customPrompt === undefined ? {} : { currentParagraph: member.prompt.customPrompt }),
        skills: await listPrivateSkillNames(BUNDLED_SKILLS_DIRECTORY, join(memberMemoryDirectoryPath(member), 'skills')),
        sections: assembly.sections.map(section => ({
          name: section.name,
          text: section.text,
          isProtected: isProtectedPromptSection(section.name),
          proseOnly: (mapping.get(section.name) ?? []).length === 0,
        })),
        requirements,
      }
    })
  }

  /** Run the one-shot completion and parse + re-validate its proposal. */
  private async curationProposal(handle: AgentHandle, member: AgentTeamAgentMember, selection: AgentTeamModelSelection, requirements: string, signal?: AbortSignal): Promise<AgentTeamCurateMemberPromptProposal> {
    const llm = this.ctx.get('llm')
    if (llm === undefined) throw new Error('no LLM service is available for curation')
    const timeout = AbortSignal.timeout(CURATE_TIMEOUT_MS)
    const linked = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    const input = await this.curateInput(handle, member, requirements)
    const { system, messages } = buildCurateMessages(input)
    const assembler = new BlockAssembler()
    try {
      for await (const chunk of llm.stream({
        provider: selection.provider,
        model: selection.model,
        messages: [...messages],
        system,
        maxTokens: CURATE_MAX_TOKENS,
        signal: linked,
      })) assembler.push(chunk)
    } catch (error) {
      if (linked.aborted) throw new Error('curation call was cancelled or timed out')
      throw error
    }
    // A cancelled call never produces a proposal, even when a mock or lenient
    // adapter ignored the signal and streamed to completion.
    if (linked.aborted) throw new Error('curation call was cancelled or timed out')
    const finish = assembler.finish
    if (finish.kind === 'error' || finish.kind === 'aborted') throw new LlmError(finish.failure.message, finish.failure.code, finish.failure)
    if (finish.kind === 'max-tokens') throw new Error('curation reply was truncated at the token cap')
    const text = assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('')
    const parsed = parseCurateProposal(text, isProtectedPromptSection)
    // Re-validate every proposed name against the live data the input was
    // built from: a stale or hallucinated section or skill name never
    // reaches the dialog.
    const liveSectionNames = new Set(input.sections.map(section => section.name))
    const droppedSectionNames = parsed.droppedSectionNames?.filter(name => liveSectionNames.has(name))
    const catalog = new Set(input.skills)
    const skillsAllow = parsed.skillsAllow?.filter(name => catalog.has(name))
    return Object.freeze({
      ...(droppedSectionNames === undefined || droppedSectionNames.length === 0 ? {} : { droppedSectionNames }),
      ...(skillsAllow === undefined || skillsAllow.length === 0 ? {} : { skillsAllow }),
      ...(parsed.customPrompt === undefined ? {} : { customPrompt: parsed.customPrompt }),
    })
  }

  /**
   * Assemble the Member's scope once (read-only, the same assembly its next
   * step gets) and derive the dialog's section entries plus the auto-prune
   * projection: the stored drop list provides dropped/stale marks, the shared
   * protection set refuses drops at consumption and marks them here, the
   * section→tools mapping flags prose-only sections and prices each section's
   * usage from the window fold, and zero-use mapped sections become the
   * candidates. Stored names the current assembly no longer knows render as
   * inert stale entries; a protected name renders protected rather than dropped
   * even when the ledger still lists it. A Member disposed mid-assemble (or any
   * assemble failure) degrades to no projection — the dialog renders its
   * no-live-session state and the Host log carries the diagnostic — instead of
   * a raw throw.
   */
  private async promptSectionProjection(handle: AgentHandle, prompt: AgentTeamAgentMember['prompt']): Promise<PromptSectionProjection> {
    try {
      // A live handle always carries an agent scope; the type cannot know that.
      const scope = scopeOf(handle.agent.ctx)!
      const assembly = await this.ctx.systemPrompt.assemble({ scope })
      const toolNames = this.ctx.tools.schemas(scope).map(tool => tool.name)
      const mapping = sectionToolMapping(assembly.sections, toolNames)
      const fold = await this.memberWindowUsage(handle)
      const usageOf = (name: string): number => {
        let total = 0
        for (const toolName of mapping.get(name) ?? []) total += fold.counts.get(toolName) ?? 0
        return total
      }
      const requested = prompt?.droppedSections ?? []
      const live = assembly.sections.map(section => {
        const isProtected = isProtectedPromptSection(section.name)
        return {
          name: section.name,
          chars: promptSectionByteLength(section.text),
          dropped: !isProtected && requested.includes(section.name),
          isProtected,
          stale: false,
          proseOnly: (mapping.get(section.name) ?? []).length === 0,
          usage: usageOf(section.name),
        }
      })
      const currentNames = new Set(assembly.sections.map(section => section.name))
      const stale = requested
        .filter(name => !currentNames.has(name) && !isProtectedPromptSection(name))
        .map(name => ({ name, dropped: true, isProtected: false, stale: true, proseOnly: false }))
      const entries = Object.freeze([...live, ...stale].map(entry => Object.freeze(entry)))
      const liveByName = new Map(live.map(entry => [entry.name, entry]))
      const candidates = Object.freeze(assembly.sections
        .map(section => section.name)
        .filter(name => {
          const entry = liveByName.get(name)
          return entry !== undefined && !entry.isProtected && !entry.proseOnly && !entry.dropped && entry.usage === 0
        }))
      return { entries, candidates, usagePartial: fold.partial }
    } catch (error) {
      this.ctx.logger.warn(`agent-team: prompt section projection for member '${handle.agent.session.id}' failed: ${error instanceof Error ? error.message : String(error)}`)
      return { entries: [], candidates: [], usagePartial: false }
    }
  }

  /**
   * Fold the Member's candidate window (last 20 completed turns or 14 days,
   * whichever closes first) from its own session logs across the rollover
   * lineage: the live generation folds directly, archived ancestors through
   * the stored-session reader, each contributing only its own events so the
   * fork-inherited prefix never double counts. An unreadable ancestor or a
   * lineage deeper than the walk cap degrades the fold to `partial`.
   */
  private async memberWindowUsage(handle: AgentHandle): Promise<UsageFold> {
    const session = handle.agent.session
    return foldLineageUsage(
      {
        ownEvents: session.ownEvents(),
        ...(session.header.parentSession === undefined ? {} : { parentSession: session.header.parentSession }),
      },
      async sessionId => {
        const read = await this.sessionReader.read(SessionId(sessionId))
        if (!read.ok) return { ok: false }
        const inspection = read.inspection
        return {
          ok: true,
          generation: {
            ownEvents: inspection.events.slice(inspection.inheritedEventCount),
            ...(inspection.header.parentSession === undefined ? {} : { parentSession: inspection.header.parentSession }),
          },
        }
      },
      Date.now(),
    )
  }

  /**
   * Count the Member's completed conversation turns across its whole rollover
   * lineage. Unlike the candidate window above this walk has no turn or day
   * bound: a leader watching a teammate asks for the total, not the recent
   * slice. Unreadable generations degrade the count the same way (under-count).
   */
  private async memberTurns(handle: AgentHandle): Promise<number> {
    const session = handle.agent.session
    return countLineageTurns(
      {
        ownEvents: session.ownEvents(),
        ...(session.header.parentSession === undefined ? {} : { parentSession: session.header.parentSession }),
      },
      async sessionId => {
        const read = await this.sessionReader.read(SessionId(sessionId))
        if (!read.ok) return { ok: false }
        const inspection = read.inspection
        return {
          ok: true,
          generation: {
            ownEvents: inspection.events.slice(inspection.inheritedEventCount),
            ...(inspection.header.parentSession === undefined ? {} : { parentSession: inspection.header.parentSession }),
          },
        }
      },
    )
  }

  /** Emit a current baseline, then coalesced invalidations until canceled. */
  @Remote({ mode: 'stream' })
  async * changes(request: AgentTeamChangesRequest, signal?: AbortSignal): AsyncIterable<AgentTeamChangesResult> {
    const scope = this.validateChangeScope(request.scope)
    let pending: number | undefined
    let resume: (() => void) | undefined
    const waiter: ChangeWaiter = {
      scope,
      wake: version => {
        pending = version
        resume?.()
      },
    }
    const onAbort = (): void => { resume?.() }
    if (signal?.aborted || !this.accepting) return
    this.changeWaiters.add(waiter)
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      // Listen before yielding so a commit during the consumer's read is kept.
      yield { version: this.changeVersionOf(scope) }
      while (!signal?.aborted && this.accepting) {
        if (pending === undefined) await new Promise<void>(resolve => { resume = resolve })
        resume = undefined
        if (signal?.aborted || !this.accepting) return
        if (pending !== undefined) {
          const version = pending
          pending = undefined
          yield { version }
        }
      }
    } finally {
      this.changeWaiters.delete(waiter)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /** Return durable Team status without issuing a model request or a storage write. */
  status(): AgentTeamStatus {
    return this.requireLedger().status()
  }

  @Remote('createChannel')
  async createChannel(request: AgentTeamCreateChannelRequest): Promise<AgentTeamCreateChannelResult> {
    this.requireAccepting()
    this.requireWorkspace(request.workspaceId)
    const ledger = this.requireLedger()
    if (!ledger.hasCommitted(request.requestId)) this.assertChannelMembersAvailable(request.memberIds)
    const result = await ledger.createChannel({ ...request, actor: agentTeamHumanActor() })
    if (result.committed) this.emitCommitted(result.value.receipt)
    return result.value
  }

  /** Human rename of one Channel's display facts; identity refs are immutable. */
  @Remote('updateChannel')
  async updateChannel(request: AgentTeamUpdateChannelRequest): Promise<AgentTeamUpdateChannelResult> {
    this.requireAccepting()
    this.requireWorkspace(request.workspaceId)
    const result = await this.requireLedger().updateChannel({ ...request, actor: agentTeamHumanActor() })
    if (result.committed) this.emitCommitted(result.value.receipt)
    return result.value
  }

  /**
   * Archive one Channel: hidden from every surface with all facts kept. Pure
   * ledger projection change — Member sessions stay live (they may work in
   * other Channels), every active Claim on the Channel's Threads releases,
   * and affected Members' Attention clears.
   */
  @Remote('archiveChannel')
  async archiveChannel(request: AgentTeamArchiveChannelRequest): Promise<AgentTeamArchiveChannelResult> {
    this.requireAccepting()
    this.requireWorkspace(request.workspaceId)
    const result = await this.requireLedger().archiveChannel({ ...request, actor: agentTeamHumanActor() })
    if (result.committed) this.emitCommitted(result.value.receipt)
    return result.value
  }

  /** Create a durable Member and atomically grant its declared initial Channels. */
  @Remote('addMember')
  async addMember(request: AgentTeamAddMemberRequest): Promise<AgentTeamAddMemberResult> {
    return this.enqueueLifecycle(async () => {
      const workspace = this.requireWorkspace(request.workspaceId)
      await this.assertModelRoute(request.model)
      const memberId = `member:${randomUUID()}` as AgentTeamMemberId
      const member: AgentTeamAgentMember = Object.freeze({
        memberId,
        sessionId: SessionId(`agent-team-${randomUUID()}`),
        workspaceId: request.workspaceId,
        handle: request.handle,
        description: request.description,
        presetId: request.presetId,
        ...(request.model === undefined ? {} : { model: Object.freeze({ ...request.model }) }),
        ...(request.capabilities === undefined ? {} : { capabilities: Object.freeze(deepCopyCapabilities(request.capabilities)) }),
        ...(request.prompt === undefined ? {} : { prompt: Object.freeze(deepCopyPrompt(request.prompt)) }),
        ...(request.contextStartPolicy === undefined ? {} : { contextStartPolicy: request.contextStartPolicy }),
        ...(request.contextWindow === undefined ? {} : { contextWindow: request.contextWindow }),
        privateMemoryPath: dshHomePath('agent-team', 'members', memberMemoryDirectoryName(memberId)),
        state: 'enabled',
      })
      const ledger = this.requireLedger()
      const result = await ledger.addMember({ ...request, actor: agentTeamHumanActor(), member })
      if (result.committed) this.emitCommitted(result.value.receipt)
      const stored = result.value.member
      if (!this.handles.has(stored.memberId)) await this.activateMember(stored, workspace.path)
      // Creation seeds exactly the creation Workspace participation; attach it
      // here (like membersForClient) so the Client never synthesizes it.
      return Object.freeze({ receipt: result.value.receipt, status: this.memberStatus(stored), workspaceIds: ledger.workspacesOf(stored.memberId) })
    })
  }

  /** Commit suspended intent, then wait for the owned AgentHandle to become quiescent. */
  async suspendMember(request: AgentTeamSetMemberStateRequest): Promise<AgentTeamMemberResult> {
    return this.enqueueLifecycle(async () => {
      const result = await this.requireLedger().suspendMember({ ...request, actor: agentTeamHumanActor() })
      if (result.committed) this.emitCommitted(result.value.receipt)
      await this.disposeMemberSession(request.memberId, result.value.member)
      return Object.freeze({ receipt: result.value.receipt, status: this.memberStatus(result.value.member) })
    })
  }

  /** Commit enabled intent and restore the exact persisted Session. */
  async resumeMember(request: AgentTeamSetMemberStateRequest): Promise<AgentTeamMemberResult> {
    return this.enqueueLifecycle(async () => {
      const result = await this.requireLedger().resumeMember({ ...request, actor: agentTeamHumanActor() })
      if (result.committed) this.emitCommitted(result.value.receipt)
      this.clearMemberNotificationState(result.value.member.memberId)
      // The suspended Session's log is durable once its retirement completes,
      // and agents.resume() waits for exactly that retirement before loading.
      // Consulting the persistence tree here instead would race the
      // fire-and-forget retirement on Windows, where the JSONL backend
      // publishes directories through transient staging entries that surface
      // as ENOENT mid-walk — so pass the known session rather than re-listing.
      await this.activateMember(result.value.member, undefined, new Set([result.value.member.sessionId]))
      return Object.freeze({ receipt: result.value.receipt, status: this.memberStatus(result.value.member) })
    })
  }

  /**
   * Operator nudge for a Member that stopped making progress: complete an
   * interrupted context transition, steer a continuation prompt into its live
   * session, rebuild it after an orphaned preset composition, or re-run
   * activation when no live session exists. Runtime-only — no ledger
   * operation, no suspend. Taking over manually also cancels any pending
   * automatic recovery episode.
   */
  @Remote('recoverMember')
  async recoverMember(request: AgentTeamRecoverMemberRequest): Promise<AgentTeamRecoverMemberResult> {
    this.requireAccepting()
    const member = this.requireLedger().getMember(request.memberId)
    if (member === undefined || !this.requireLedger().participatesIn(request.memberId, request.workspaceId)) throw new Error(`unknown Member '${request.memberId}' in workspace '${request.workspaceId}'`)
    this.recovery.stopTracking(request.memberId)
    const handle = this.handles.get(request.memberId)
    // A live handle running a different Session than the durable binding is an
    // interrupted context transition (the same shape `memberStatus` labels
    // 'rollover'): the binding moved onto the next Session while the previous
    // generation never retired. Completing the swap is the only honest repair
    // — steering the stale generation would keep answering from a Session the
    // ledger no longer binds, and a plain re-activation would try to resume a
    // Session that may not exist on disk yet. Lifecycle serialization means a
    // transition still in flight settles before this body runs, and there the
    // re-read below degrades to a no-op.
    if (handle !== undefined && member.state === 'enabled' && handle.agent.id !== member.sessionId) {
      this.ctx.logger.info(`agent-team: completing the interrupted context transition for member '${member.handle}'`)
      await this.enqueueLifecycle(async () => {
        const stored = this.requireLedger().getMember(request.memberId)
        const active = this.handles.get(request.memberId)
        if (stored === undefined || stored.state !== 'enabled') return
        if (active === undefined || active.agent.id === stored.sessionId) return
        const retiredSessionId = active.agent.session.id
        await this.retireMemberGeneration(request.memberId, active, retiredSessionId)
        await this.activateMember(stored, undefined, undefined, retiredSessionId)
      })
      return Object.freeze({ status: this.memberStatus(this.requireLedger().getMember(request.memberId) ?? member) })
    }
    // An orphaned composition cannot be steered: its tools are gone, so a
    // continuation prompt reaches an inert Member. Rebuild the Agent in place.
    if (handle !== undefined && this.ctx.agentPresets.composedPreset(handle.agent.ctx) === undefined) {
      this.ctx.logger.info(`agent-team: rebuilding member '${member.handle}' after its preset composition was orphaned by a reload`)
      await this.reactivateMember(request.memberId)
      return Object.freeze({ status: this.memberStatus(member) })
    }
    // A failed activation also leaves nothing to steer; re-running it is the
    // only way back. A renewed failure stays non-throwing: the refreshed
    // status carries the activation diagnostic for the sidebar.
    if (handle === undefined) {
      if (member.state !== 'enabled') throw new Error(`Agent Member '${member.handle}' is ${member.state}; only enabled Members can be restarted`)
      this.ctx.logger.info(`agent-team: restarting member '${member.handle}' after a failed activation`)
      // There is no write-side repair pass anymore: dsh 0.1.7 converts the
      // released V3 history at read time, and this bundle no longer authors
      // the old wrapper shape, so a refusal stays a deterministic failure the
      // retry reports again rather than something the restart heals.
      await this.reactivateMember(request.memberId)
      return Object.freeze({ status: this.memberStatus(member) })
    }
    this.ctx.logger.info(`agent-team: operator asked member '${member.handle}' to resume`)
    this.steerResume(member, this.manualResumeText())
    return Object.freeze({ status: this.memberStatus(member) })
  }

  /**
   * Start one enabled Member from a new context: dispose the live handle,
   * archive the previous Session (its log stays on disk for history), and
   * activate a fresh Session under a new sessionId, so preset, tools, private
   * memory, and model selection all reload while the next turn carries no
   * history. The durable operation moves the Member's sessionId; identity,
   * memory path, and binding survive. A new id is what keeps the Web Client
   * seat live: a disposed generation's resident instance keeps its `removed`
   * bit forever, so renewing under the same id would leave a permanently
   * grayed session view.
   */
  @Remote('clearMemberContext')
  async clearMemberContext(request: AgentTeamClearMemberContextRequest): Promise<AgentTeamClearMemberContextResult> {
    return this.enqueueLifecycle(async () => {
      this.requireAccepting()
      this.requireWorkspace(request.workspaceId)
      const stored = this.requireLedger().getMember(request.memberId)
      if (stored === undefined || !this.requireLedger().participatesIn(request.memberId, request.workspaceId)) throw new Error(`unknown Member '${request.memberId}' in workspace '${request.workspaceId}'`)
      if (stored.state !== 'enabled') throw new Error(`Agent Member '${stored.handle}' is not enabled; only enabled Members can start from a new context`)
      const active = this.handles.get(request.memberId)
      if (active === undefined) throw new Error(`Agent Member '${stored.handle}' has no active session to clear`)
      if (this.runningAgents.has(active.agent.id)) throw new Error(`Agent Member '${stored.handle}' is still running; wait for the current turn to end before starting from a new context`)
      const renewed = await this.renewMemberContextNow(request.memberId, request.requestId, 'human')
      return Object.freeze({ receipt: renewed.receipt, status: this.memberStatus(renewed.member) })
    })
  }

  /**
   * The one context-renewal path shared by every reset caller — the Human
   * menu's reset row, supervision's forced fallback reset, the doctor
   * diagnostic reset, and the fresh-start task policy: commit the idempotent
   * ledger renewal, retire the previous generation, activate the fresh
   * Session, and privately notice the reset Member. The fresh id derives from
   * the requestId, so a retried identical request mints the same id and the
   * ledger dedupes it instead of colliding; the format matches addMember's
   * `agent-team-<uuid>`. Callers own their own preconditions (participation,
   * enabled state, running-turn refusal) — this core only refuses a Member
   * with no live generation.
   */
  private async renewMemberContextNow(memberId: AgentTeamMemberId, requestId: AgentTeamRequestId, resetBy: 'human' | 'supervision' | 'teammate' | 'doctor' | 'policy'): Promise<{ readonly receipt: AgentTeamClearMemberContextResult['receipt']; readonly member: AgentTeamAgentMember }> {
    const ledger = this.requireLedger()
    const stored = ledger.getMember(memberId)
    if (stored === undefined || stored.state !== 'enabled') throw new Error(`Agent Member '${this.memberLabel(memberId)}' is not enabled; only enabled Members can start from a new context`)
    const active = this.handles.get(memberId)
    if (active === undefined) throw new Error(`Agent Member '${stored.handle}' has no active session to clear`)
    const previousSessionId = stored.sessionId
    const sessionId = SessionId(`agent-team-${requestId}`)
    const result = await ledger.renewMemberSession({ requestId, workspaceId: stored.workspaceId, memberId, sessionId, actor: agentTeamHumanActor() })
    if (result.committed) this.emitCommitted(result.value.receipt)
    else {
      // A retried identical request already renewed this Member; report the
      // recorded outcome without another dispose/reactivate cycle.
      return Object.freeze({ receipt: result.value.receipt, member: result.value.member })
    }
    const renewed = result.value.member
    // Record the fresh generation as satisfying any renewal intent: a policy
    // body that later wakes on this swap sees "already renewed" and stands
    // down instead of erasing the context another path just made fresh. The
    // completion arm is spent by this renewal, so the fresh generation's own
    // notifyMember below delivers the gated wake normally.
    this.renewedSessionByMember.set(memberId, sessionId)
    this.armedFreshStartReset.delete(memberId)
    this.keptDispatchSequence.delete(memberId)
    await this.retireMemberGeneration(memberId, active, previousSessionId)
    // Defer the ordinary Inbox wake so the reset notice reads as the fresh
    // generation's first Team word; the wake is rederived right after it.
    await this.activateMember(renewed, undefined, undefined, previousSessionId, { deferNotify: true })
    const reactivated = this.handles.get(memberId)
    if (reactivated === undefined) {
      // Reactivation failed; the activation diagnostic carries the reason and
      // the durable renewal stays honest about the attempt.
      throw new Error(`Agent Member '${stored.handle}' failed to start a new context: ${this.memberFailures.get(memberId)?.activation ?? 'unknown error'}`)
    }
    if (resetBy !== 'doctor') this.notifyMemberContextReset(reactivated.agent, renewed, resetBy)
    this.notifyMember(reactivated.agent)
    return Object.freeze({ receipt: result.value.receipt, member: renewed })
  }

  /**
   * Privately notice the reset Member itself after its context renewal: one
   * runtime notice — never a ledger Message — telling it the Session was
   * reset, that its handle, settings, and private memory are unchanged and
   * durable Team facts survived, and how to re-orient: the injected memory
   * index names what was in hand, recent Team history is durable in the
   * ledger through `team_view`, `team_inbox`, and `team_thread`, and whatever
   * stays unclear it asks the teammates concerned instead of guessing. The
   * Team is not broadcast to: a reset moves no durable Team fact, and the
   * Member's next ordinary messages carry its state. Doctor dispatches skip
   * it — the reset is an internal step of a one-shot diagnostic whose prompt
   * arrives immediately. A failed delivery only logs: the renewal itself is
   * already durable when this runs.
   */
  private notifyMemberContextReset(agent: Agent, member: AgentTeamAgentMember, resetBy: 'human' | 'supervision' | 'teammate' | 'policy'): void {
    const resetSource = resetBy === 'human'
      ? 'the Human'
      : resetBy === 'supervision'
        ? 'team supervision after repeated failures'
        : resetBy === 'teammate'
          ? 'a teammate through team supervision'
          : 'your fresh-start Task policy'
    const text = [
      `Context reset notice: your Session was just reset by ${resetSource}, and you are starting from an empty context.`,
      'Your handle, settings, and private memory are unchanged, and durable Team facts (Tasks, Claims, Channels) are unaffected — but you remember nothing from earlier conversation.',
      'Re-orient before continuing any work: your injected memory index names what was in hand, and the recent Team history is durable in the ledger — read the Threads, Tasks, and mentions that concern you through team_view, team_inbox, and team_thread.',
      'If anything stays unclear after reading, ask the teammates concerned — reply in the relevant Thread or send a direct message — instead of guessing.',
    ].join('\n')
    const hint = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: AGENT_TEAM_PLUGIN_ID, form: 'notice', summary: RESET_NOTICE_SUMMARY },
    })
    try {
      // The same sequencing rule as the Inbox wake: ordinary next-turn input
      // already queued (a rollover's or recovery's carried messages) claims
      // the turn first, and this notice rides behind it as its own turn.
      if (agent.inbox.nextTurn.some(message => message.source.kind === 'user')) agent.followup(hint)
      else agent.steer(hint)
    } catch (error) {
      this.ctx.logger.warn(`agent-team: context-reset notice for member '${member.handle}' failed to deliver: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Human-requested in-place context compaction for one enabled Member's live
   * Session. The remote only validates and schedules: the compaction runs in
   * the background at the Member's next true idle boundary through the public
   * compaction-basic engine, so it is inserted after the Member's current
   * actions without blocking later conversation — input that arrives meanwhile
   * queues and is served once the compaction settles (runMaintenance latches
   * waking input, it never drops it).
   *
   * The engine instance is transient and carries the Human-selected
   * summarization LLM in its config; it shares the Host context's public
   * llm/tokenMeter/sessions seams and reuses exactly the implementation the
   * Team preset mounts (see docs/architecture.md). Failures surface through
   * the Member's compaction failure slot, the same diagnostic surface the
   * pressure policy reports through.
   */
  @Remote('compactMemberContext')
  async compactMemberContext(request: AgentTeamCompactMemberContextRequest): Promise<AgentTeamCompactMemberContextResult> {
    this.requireAccepting()
    this.requireWorkspace(request.workspaceId)
    const stored = this.requireLedger().getMember(request.memberId)
    if (stored === undefined || !this.requireLedger().participatesIn(request.memberId, request.workspaceId)) throw new Error(`unknown Member '${request.memberId}' in workspace '${request.workspaceId}'`)
    if (stored.state !== 'enabled') throw new Error(`Agent Member '${stored.handle}' is ${stored.state}; only enabled Members can compact their context`)
    if (this.contextManagement.isTransitioning(request.memberId)) throw new Error(`Agent Member '${stored.handle}' has a context rollover already scheduled; wait for it to finish before compacting`)
    const active = this.handles.get(request.memberId)
    if (active === undefined) throw new Error(`Agent Member '${stored.handle}' has no active session to compact`)
    if (this.pendingCompactions.has(request.memberId)) throw new Error(`Agent Member '${stored.handle}' already has a compaction scheduled; wait for it to finish`)
    this.pendingCompactions.add(request.memberId)
    void this.runMemberCompaction(stored, active, request.model)
    return Object.freeze({ status: this.memberStatus(stored) })
  }

  /**
   * Background body of one scheduled compaction. Waits for the Member's idle
   * boundary, then forces one useful reduction even below the pressure
   * threshold. A member that stays busy (fresh waking input between idle
   * checks) is retried a bounded number of times and then silently dropped —
   * conversation takes precedence over the optional reduction. A real
   * compaction failure reports through the compaction failure slot.
   */
  private async runMemberCompaction(member: AgentTeamAgentMember, active: AgentHandle, model: AgentTeamModelSelection | undefined): Promise<void> {
    const memberId = member.memberId
    try {
      await this.manualCompactionWithFallback(memberId, member, active, model)
      // A successful in-place reduction resolves a stale compaction failure
      // the pressure policy may have left behind.
      if (this.clearMemberFailure(memberId, 'compaction')) this.emitAutoCompactionChanged(memberId)
    } catch (error) {
      const diagnostic = `manual context compaction failed: ${error instanceof Error ? error.message : String(error)}`
      this.ctx.logger.warn(`agent-team: ${diagnostic} (member '${member.handle}')`)
      this.setMemberFailure(memberId, 'compaction', diagnostic, active.agent.id)
      this.emitAutoCompactionChanged(memberId)
    } finally {
      this.pendingCompactions.delete(memberId)
    }
  }

  /**
   * Schedule the context reset one Member's fresh-start task-start policy
   * calls for. Claim and Human atomic-start boundaries schedule it directly;
   * an armed Member (its last turn completed with the marker) schedules it
   * when its next dispatch delivers new unread work. continue policy (the
   * absent default) never does. One in-flight body per Member: concurrently
   * overlapping schedules merge into a single reset. Returns whether a reset
   * is now scheduled or already in flight — a false tells the caller to keep
   * its own delivery (there is nothing to wait behind).
   */
  private scheduleFreshStartReset(memberId: AgentTeamMemberId): boolean {
    const stored = this.ledger?.getMember(memberId)
    if (stored?.contextStartPolicy !== 'fresh') return false
    if (this.pendingPolicyResets.has(memberId)) return true
    const active = this.handles.get(memberId)
    if (active === undefined) return false
    this.pendingPolicyResets.add(memberId)
    void this.runFreshStartReset(stored, active)
    return true
  }

  /**
   * Arm the fresh-start policy after one completed stop announced the marker:
   * the renewal belongs to the next dispatch, never to the completion itself.
   * continue Members never arm, and an already-armed Member re-arming is the
   * same one pending reset.
   */
  private armFreshStartReset(memberId: AgentTeamMemberId): void {
    if (this.ledger?.getMember(memberId)?.contextStartPolicy !== 'fresh') return
    this.armedFreshStartReset.add(memberId)
  }

  /**
   * Whether one dispatch goes to the model for the keep-or-renew decision at
   * all. That discrimination is the Team's own judgement about its work, so it
   * runs only where a Team actually has someone who owns the call: the Workspace
   * needs an enabled designated leader. Without one the fresh-start policy
   * behaves as it always did — the next assignment renews.
   */
  private hasDesignatedLeader(memberId: AgentTeamMemberId): boolean {
    const ledger = this.ledger
    if (ledger === undefined) return false
    const workspaces = ledger.workspacesOf(memberId)
    return ledger.listMembers().some(member =>
      member.state === 'enabled' && member.leader === true && workspaces.some(workspaceId => ledger.workspacesOf(member.memberId).includes(workspaceId)))
  }

  /**
   * Ask the model whether the incoming assignment continues the work this Member
   * already holds: its last {@link DISPATCH_HISTORY_MESSAGE_LIMIT} authored
   * Messages plus the content of the Task it most recently claimed. A score of
   * {@link CONTEXT_RELEVANCE_THRESHOLD} or above keeps the live Session; every
   * other outcome — a lower score, a reply with no usable number, a provider
   * error, a timeout, or no LLM service at all — renews, because the Member's
   * own configuration promises a fresh context per task and the judgement is only
   * an exception to it. The score is logged so each erase-or-keep call stays
   * auditable.
   */
  private async dispatchRelevanceKeepsContext(member: AgentTeamAgentMember, assignment: string): Promise<boolean> {
    const memberId = member.memberId
    const ledger = this.requireLedger()
    const history = [...ledger.recentMemberMessageBodies(memberId, DISPATCH_HISTORY_MESSAGE_LIMIT)]
    const latestTask = ledger.latestTaskContentOf(memberId)
    if (latestTask !== undefined) history.push(latestTask)
    if (history.length === 0) {
      this.ctx.logger.info(`agent-team: dispatch context judgement for member '${member.handle}': no recent work to compare — renewing before delivery`)
      return false
    }
    const llm = this.ctx.get('llm')
    if (llm === undefined) {
      this.ctx.logger.warn(`agent-team: dispatch context judgement for member '${member.handle}': no LLM service is available — renewing before delivery`)
      return false
    }
    const selection = this.currentModelSelectionOf(memberId)
    const { system, messages } = buildRelevanceJudge({ handle: member.handle, task: assignment, history })
    const signal = AbortSignal.timeout(RELEVANCE_JUDGE_TIMEOUT_MS)
    const assembler = new BlockAssembler()
    try {
      for await (const chunk of llm.stream({ provider: selection.provider, model: selection.model, messages: [...messages], system, maxTokens: RELEVANCE_JUDGE_MAX_TOKENS, signal })) assembler.push(chunk)
    } catch (error) {
      this.ctx.logger.warn(`agent-team: dispatch context judgement for member '${member.handle}' failed: ${error instanceof Error ? error.message : String(error)} — renewing before delivery`)
      return false
    }
    if (signal.aborted) {
      this.ctx.logger.warn(`agent-team: dispatch context judgement for member '${member.handle}' timed out — renewing before delivery`)
      return false
    }
    const finish = assembler.finish
    if (finish.kind === 'error' || finish.kind === 'aborted') {
      this.ctx.logger.warn(`agent-team: dispatch context judgement for member '${member.handle}' failed: ${finish.failure.message} — renewing before delivery`)
      return false
    }
    const text = assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('')
    const score = parseRelevanceScore(text)
    if (score === undefined) {
      this.ctx.logger.warn(`agent-team: dispatch context judgement for member '${member.handle}' returned no usable score — renewing before delivery`)
      return false
    }
    const keeps = score >= CONTEXT_RELEVANCE_THRESHOLD
    this.ctx.logger.info(`agent-team: dispatch context judgement for member '${member.handle}': relevance ${score.toFixed(2)} of ${history.length} recent item(s) — ${keeps ? 'keeping the live context' : 'renewing before delivery'}`)
    return keeps
  }

  /**
   * Start the one judgement a dispatch deserves, holding its Inbox wake until
   * the answer lands: the sequence the call was made for is remembered so a
   * "keep" exempts exactly that delivery, and a second dispatch arriving while
   * the model is thinking waits its turn rather than starting a parallel call.
   * Fire-and-forget: a lost judgement must never strand a dispatch, so the body
   * always ends by releasing the hold and re-deriving the delivery.
   */
  private judgeFreshStartDispatch(member: AgentTeamAgentMember, sequence: number, assignment: string): void {
    const memberId = member.memberId
    if (this.judgingFreshStart.has(memberId)) return
    if (!this.hasDesignatedLeader(memberId)) {
      this.scheduleFreshStartReset(memberId)
      return
    }
    this.judgingFreshStart.set(memberId, sequence)
    void this.runFreshStartJudgement(member, sequence, assignment)
  }

  /** Background body of one dispatch judgement: decide, release the hold, deliver. */
  private async runFreshStartJudgement(member: AgentTeamAgentMember, sequence: number, assignment: string): Promise<void> {
    const memberId = member.memberId
    let keeps = false
    try {
      keeps = await this.dispatchRelevanceKeepsContext(member, assignment)
    } catch (error) {
      this.ctx.logger.warn(`agent-team: dispatch context judgement for member '${member.handle}' errored: ${error instanceof Error ? error.message : String(error)} — renewing before delivery`)
    } finally {
      if ((this.judgingFreshStart.get(memberId) ?? 0) <= sequence) this.judgingFreshStart.delete(memberId)
    }
    if (keeps) {
      // The exemption rides the same sequence-bound channel the sender's explicit
      // keepContext uses, so it covers this delivery and never the next task.
      this.keptDispatchSequence.set(memberId, sequence)
    } else {
      this.scheduleFreshStartReset(memberId)
      if (this.pendingPolicyResets.has(memberId)) return
    }
    const current = this.handles.get(memberId)
    if (current !== undefined) this.notifyMember(current.agent)
  }

  /**
   * Background body of one scheduled fresh-start reset. A claim fires inside
   * the Member's own turn, so the reset waits for the turn boundary and
   * converges like executeMemberTransition. A generation swap while it waits
   * (a rollover, a restart resume, or any context change) re-binds the wait
   * to the live handle instead of dropping the scheduled reset with the old
   * one — bounded by {@link POLICY_RESET_MAX_BINDINGS} re-bindings. Then it
   * re-reads the Member at the boundary (a concurrent edit may have changed
   * the policy) and runs the same durable renewal the Human reset path uses.
   * When the reset renews, the activation inside delivers the rederived Inbox
   * wake — the queued dispatch reaches the fresh generation instead of the
   * doomed context. When the body gives up (policy moved, Member gone, or the
   * re-binding budget spent without renewing), it re-derives the wake on the
   * live handle itself so a gated delivery is never lost. Failures are
   * logged, never thrown and never retried — the next boundary schedules
   * its own reset.
   */
  private async runFreshStartReset(member: AgentTeamAgentMember, active: AgentHandle): Promise<void> {
    const memberId = member.memberId
    // The generation this schedule was made against: a renewal of THAT
    // session (by any path) satisfies the intent; a renewal that landed
    // before this schedule does not — the new dispatch still owes a fresh
    // context over the session the schedule found live.
    const scheduledSession = member.sessionId
    let current = active
    let renewed = false
    try {
      for (let binding = 0; binding < POLICY_RESET_MAX_BINDINGS; binding++) {
        const stored = this.ledger?.getMember(memberId)
        if (stored?.contextStartPolicy !== 'fresh' || stored.state !== 'enabled') return
        const landed = this.renewedSessionByMember.get(memberId)
        if (landed !== undefined && landed !== scheduledSession && landed === current.agent.session.id) {
          renewed = true
          return
        }
        if (!this.runningAgents.has(current.agent.id)) {
          // The idle seam: the lifecycle body re-checks once more (edits and
          // suspensions queue ahead of it), then renews. The renewal itself
          // re-derives the gated Inbox wake behind the reset notice.
          renewed = await this.enqueueLifecycle(async () => {
            this.requireAccepting()
            const storedMember = this.ledger?.getMember(memberId)
            if (storedMember?.contextStartPolicy !== 'fresh' || storedMember.state !== 'enabled') return false
            if (this.handles.get(memberId) !== current) return false
            await this.renewMemberContextNow(memberId, randomUUID() as AgentTeamRequestId, 'policy')
            return true
          })
          if (renewed) return
          // The body skipped it (policy moved or handle swapped inside the
          // queue): re-read the live handle and converge through the loop.
          const latest = this.handles.get(memberId)
          if (latest === undefined) return
          current = latest
          continue
        }
        await this.memberRuntime.awaitTurnBoundary(current)
        const latest = this.handles.get(memberId)
        if (latest === undefined) return
        current = latest
      }
      this.ctx.logger.warn(`agent-team: fresh-start context reset for member '${member.handle}' gave up after ${POLICY_RESET_MAX_BINDINGS} turn-boundary bindings`)
    } catch (error) {
      this.ctx.logger.warn(`agent-team: fresh-start context reset for member '${member.handle}' failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.pendingPolicyResets.delete(memberId)
      // A consumed arm stays consumed: the renewal path cleared it with the
      // commit. A give-up releases the arm instead of keeping it armed —
      // flushing below would otherwise re-meet the gate on the same unread
      // dispatch and re-schedule this very body in a hot retry loop. The
      // dispatch degrades to the pre-renewal context (the pre-gate behaviour);
      // the Member's next marker-completed stop re-arms it for a later task.
      if (!renewed) this.armedFreshStartReset.delete(memberId)
      // Whatever happened, a wake this body held back must now be delivered —
      // after a renewal the live handle is the fresh generation, exactly
      // where the dispatch belongs.
      const latest = this.handles.get(memberId)
      if (latest !== undefined) this.notifyMember(latest.agent)
    }
  }

  /**
   * Schedule one auto-prune sweep behind a task-start boundary (claim or Human
   * atomic start), mirroring the fresh-start reset seam: same one-in-flight
   * dedupe, same turn-boundary wait, same serialized lifecycle body. Only a
   * Member with the autoPrune switch on sweeps; everyone else pays one ledger
   * read and never prunes.
   */
  private scheduleAutoPruneSweep(memberId: AgentTeamMemberId): void {
    if (this.pendingPruneSweeps.has(memberId)) return
    const stored = this.ledger?.getMember(memberId)
    if (stored?.prompt?.autoPrune !== true) return
    const active = this.handles.get(memberId)
    if (active === undefined) return
    this.pendingPruneSweeps.add(memberId)
    void this.runAutoPruneSweep(stored, active)
  }

  /**
   * Background body of one scheduled auto-prune sweep. Like the fresh-start
   * reset it waits for the turn boundary, re-reads the Member there (a
   * concurrent edit may have turned the switch off), and runs inside the
   * serialized lifecycle queue. Failures are logged, never thrown and never
   * retried — the next task start schedules its own sweep.
   */
  private async runAutoPruneSweep(member: AgentTeamAgentMember, active: AgentHandle): Promise<void> {
    const memberId = member.memberId
    try {
      await this.memberRuntime.awaitTurnBoundary(active)
      if (this.handles.get(memberId) !== active) return
      if (this.runningAgents.has(active.agent.id)) await active.agent.whenIdle()
      if (this.handles.get(memberId) !== active) return
      const stored = this.ledger?.getMember(memberId)
      if (stored?.prompt?.autoPrune !== true || stored.state !== 'enabled') return
      // The usage fold reads up to MAX_USAGE_ANCESTORS whole session files and
      // re-parses inherited prefixes, so it runs OUTSIDE the serialized
      // lifecycle queue — folding inside it would block every edit, archive,
      // and renewal on that I/O. The queued body only re-validates cheaply
      // (runAutoPruneBody) against the re-read member and this projection.
      const projection = await this.promptSectionProjection(active, stored.prompt)
      await this.enqueueLifecycle(async () => {
        this.requireAccepting()
        // Lifecycle edits and suspensions queue ahead of this body and can
        // commit after the projection folded above; only a still-opted-in,
        // still-enabled Member sweeps.
        const current = this.ledger?.getMember(memberId)
        if (current?.prompt?.autoPrune !== true || current.state !== 'enabled') return
        const live = this.handles.get(memberId)
        if (live === undefined) return
        await this.runAutoPruneBody(current, live, projection)
      })
    } catch (error) {
      this.ctx.logger.warn(`agent-team: auto-prune sweep for member '${member.handle}' failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.pendingPruneSweeps.delete(memberId)
    }
  }

  /**
   * One sweep's decision body, already holding the folded projection (the
   * fold ran before the queue; whole-file session reads must not block
   * lifecycle ops). Re-validates each candidate cheaply against the folded
   * entries — a name that no longer maps to a live, unprotected, tool-mapped
   * entry is skipped — and, with none left, does nothing. Ask mode (the
   * default, and the full-auto mode degraded by a partial usage fold —
   * unreadable history can only under-count, so a partial fold never drives
   * an automatic drop) posts the inbox notice and leaves the candidates for
   * the dialog's confirm surface. Full-auto commits the candidates as one
   * durable member update through the same echo-complete shape the Human
   * editor uses, live-applies the drop list at the settled boundary, and
   * still posts the notice naming what was pruned — every automatic drop
   * stays ledger-recorded and traceable.
   */
  private async runAutoPruneBody(member: AgentTeamAgentMember, active: AgentHandle, projection: PromptSectionProjection): Promise<void> {
    if (this.handles.get(member.memberId) !== active) return
    const entryByName = new Map(projection.entries.map(entry => [entry.name, entry]))
    const candidates = projection.candidates.filter(name => {
      const entry = entryByName.get(name)
      return entry !== undefined && !entry.stale && !entry.isProtected && !entry.proseOnly
    })
    if (candidates.length === 0) return
    const fullAuto = member.prompt?.autoExecutePrune === true && !projection.usagePartial
    if (!fullAuto) {
      await this.announceAutoPrune(member, candidates, false)
      return
    }
    const mergedDrops = [...new Set([...(member.prompt?.droppedSections ?? []), ...candidates])].sort()
    const prior = member.prompt
    const result = await this.requireLedger().updateMember({
      requestId: randomUUID() as AgentTeamRequestId,
      memberId: member.memberId,
      handle: member.handle,
      description: member.description,
      prompt: {
        droppedSections: mergedDrops,
        ...(prior?.customPrompt === undefined ? {} : { customPrompt: prior.customPrompt }),
        autoPrune: true,
        ...(prior?.autoExecutePrune === undefined ? {} : { autoExecutePrune: prior.autoExecutePrune }),
      },
      ...(member.model === undefined ? {} : { model: member.model }),
      ...(member.capabilities === undefined ? {} : { capabilities: member.capabilities }),
      ...(member.contextStartPolicy === undefined ? {} : { contextStartPolicy: member.contextStartPolicy }),
      ...(member.contextWindow === undefined ? {} : { contextWindow: member.contextWindow }),
      actor: agentTeamHumanActor(),
    })
    if (result.committed) this.emitCommitted(result.value.receipt)
    this.memberRuntime.reapplyMemberSectionDrops(result.value.member)
    await this.announceAutoPrune(result.value.member, candidates, true)
  }

  /**
   * Post one auto-prune notice on every Channel the swept Member belongs to,
   * addressed to the Human by mention so it lands in the Human inbox. Ask mode
   * asks for confirmation; full-auto documents what was committed. The notice
   * is Member-voiced, and failures are logged, never thrown — the
   * drop itself is already durable when this runs.
   */
  private async announceAutoPrune(member: AgentTeamAgentMember, sections: readonly string[], executed: boolean): Promise<void> {
    const ledger = this.requireLedger()
    const named = sections.map(name => `\`${name}\``).join(', ')
    const body = executed
      ? `Auto-prune executed: my prompt sections ${named} mapped no tool calls inside my usage window (the last ${PRUNE_WINDOW_TURNS} completed turns or ${PRUNE_WINDOW_DAYS} days, whichever closed first), and my auto-execute upgrade dropped them from my assembly. @human — restore them in my Prompt dialog if they are still needed.`
      : `Auto-prune notice: my prompt sections ${named} mapped no tool calls inside my usage window (the last ${PRUNE_WINDOW_TURNS} completed turns or ${PRUNE_WINDOW_DAYS} days, whichever closed first). @human — confirm the drop in my Prompt dialog, or ignore this notice to keep them.`
    const noticeChannels = ledger.workspacesOf(member.memberId)
      .flatMap(workspaceId => ledger.channelsForMember(member.memberId, workspaceId).map(channelRef => ({ workspaceId, channelRef })))
    for (const { workspaceId, channelRef } of noticeChannels) {
      try {
        await this.sendMessageAs({ kind: 'member', memberId: member.memberId, handle: member.handle }, {
          requestId: randomUUID() as AgentTeamRequestId,
          workspaceId,
          channelRef,
          body,
          asTask: false,
        })
      } catch (error) {
        this.ctx.logger.warn(`agent-team: auto-prune notice for member '${member.handle}' failed in channel '${channelRef}': ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /**
   * One manual compaction with the summarizer fallback chain: the
   * Human-selected (or session-default) LLM first, then — when the attempt
   * fails on a real error rather than a busy Member — the Host catalog's other
   * configured routes, up to {@link MAX_COMPACTION_FALLBACK_ATTEMPTS}. A
   * persistently busy Member loses no data and is silently dropped
   * (conversation takes precedence over the optional reduction); an
   * exhausted fallback chain rethrows the original failure into
   * {@link runMemberCompaction}'s failure reporting.
   */
  private async manualCompactionWithFallback(memberId: AgentTeamMemberId, member: AgentTeamAgentMember, active: AgentHandle, model: AgentTeamModelSelection | undefined): Promise<void> {
    const agent = active.agent
    let lastError: unknown
    for (let attempt = 0; attempt < MEMBER_COMPACT_BUSY_ATTEMPTS; attempt += 1) {
      await agent.whenIdle()
      if (this.handles.get(memberId) !== active) return
      try {
        const engine = new BasicCompactionEngine(this.ctx, {
          auto: false,
          ...(model === undefined ? {} : { summarizationProvider: model.provider, summarizationModel: model.model }),
        })
        const result = await engine.compactNow(agent, new AbortController().signal)
        if (result === null) {
          this.ctx.logger.info(`agent-team: manual compaction for member '${member.handle}' found no compactable range`)
        } else {
          this.ctx.logger.info(`agent-team: manual compaction for member '${member.handle}' shadowed ${result.shadowedSeqs.length} surface nodes (~${result.shadowedTokenCount} tokens)`)
        }
        return
      } catch (error) {
        lastError = error
        // Only a busy Member is worth re-awaiting; every other failure class
        // falls through to the fallback chain.
        if (!(error instanceof ManualCompactionError) || error.code !== 'busy') break
      }
    }
    if (lastError === undefined) return
    if (lastError instanceof ManualCompactionError && lastError.code === 'busy') {
      // A persistently busy Member loses no data — log only, the Human can
      // retry once the conversation settles.
      this.ctx.logger.warn(`agent-team: manual compaction for member '${member.handle}' stayed busy and was dropped`)
      return
    }
    // The chosen summarizer failed on a real error: try the other configured
    // LLM routes before reporting the failure.
    const current = model ?? this.currentModelSelectionOf(memberId)
    const fallbacks = (await this.fallbackCompactionSelections(current)).slice(0, MAX_COMPACTION_FALLBACK_ATTEMPTS)
    for (const selection of fallbacks) {
      try {
        const engine = new BasicCompactionEngine(this.ctx, {
          auto: false,
          summarizationProvider: selection.provider,
          summarizationModel: selection.model,
        })
        const result = await engine.compactNow(agent, new AbortController().signal)
        this.ctx.logger.info(`agent-team: manual compaction for member '${member.handle}' succeeded via fallback LLM ${selection.provider}/${selection.model} (shadowed ${result === null ? 0 : result.shadowedSeqs.length} surface nodes)`)
        return
      } catch (error) {
        this.ctx.logger.warn(`agent-team: manual compaction fallback via ${selection.provider}/${selection.model} failed: ${error instanceof Error ? error.message : String(error)} (member '${member.handle}')`)
      }
    }
    throw lastError
  }

  /** The effective model route of one Member, or the Host default when unset. */
  private currentModelSelectionOf(memberId: AgentTeamMemberId): AgentTeamModelSelection {
    const ref = this.modelSelections.get(memberId)
    return ref?.assembled ?? ref?.current ?? this.ledger?.getMember(memberId)?.model ?? this.ctx.agentDefaultModel.currentSelection()
  }

  /**
   * The Host catalog's other configured provider/model pairs, excluding the
   * Member's current route — the candidate summarizers for the compaction
   * fallback. Provider enumeration never throws; a provider whose model list
   * fails is logged and skipped, and an unreachable LLM service yields no
   * candidates (the caller keeps its original failure).
   */
  private async fallbackCompactionSelections(exclude: AgentTeamModelSelection | undefined): Promise<readonly AgentTeamModelSelection[]> {
    const llm = this.ctx.get('llm')
    if (llm === undefined) return []
    const selections: AgentTeamModelSelection[] = []
    for (const provider of llm.listProviders()) {
      let models: readonly { readonly id: string }[]
      try {
        models = await llm.listModels(provider.id)
      } catch (error) {
        this.ctx.logger.warn(`agent-team: compaction fallback could not list models of provider '${provider.id}': ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      for (const model of models) {
        if (exclude !== undefined && provider.id === exclude.provider && model.id === exclude.model) continue
        selections.push({ provider: provider.id, model: model.id })
      }
    }
    return selections
  }

  /**
   * The policy-side compaction fallback ({@link PressurePolicyCoordinator}'s
   * `compactWithFallback`): after the Member-scoped engine's forced reduction
   * throws, try the other configured LLM routes — up to
   * {@link MAX_COMPACTION_FALLBACK_ATTEMPTS} — and report whether any of them
   * advanced the durable surface. The coordinator still re-measures pressure
   * itself, so a fallback that ran without reducing anything fails closed
   * exactly like the original failure.
   */
  private async policyCompactWithFallback(memberId: AgentTeamMemberId, agent: Agent, signal: AbortSignal): Promise<boolean> {
    const generation = agent.session.surface.replaceGeneration
    const fallbacks = (await this.fallbackCompactionSelections(this.currentModelSelectionOf(memberId))).slice(0, MAX_COMPACTION_FALLBACK_ATTEMPTS)
    for (const selection of fallbacks) {
      if (signal.aborted) return false
      try {
        const engine = new BasicCompactionEngine(this.ctx, {
          auto: false,
          summarizationProvider: selection.provider,
          summarizationModel: selection.model,
        })
        await engine.compactIfNeeded(agent, 'context-overflow', signal)
        if (agent.session.surface.replaceGeneration > generation) {
          this.ctx.logger.info(`agent-team: hard-limit compaction fallback succeeded via ${selection.provider}/${selection.model} (member '${this.memberLabel(memberId)}')`)
          return true
        }
        this.ctx.logger.warn(`agent-team: hard-limit compaction fallback via ${selection.provider}/${selection.model} produced no durable reduction (member '${this.memberLabel(memberId)}')`)
      } catch (error) {
        this.ctx.logger.warn(`agent-team: hard-limit compaction fallback via ${selection.provider}/${selection.model} failed: ${error instanceof Error ? error.message : String(error)} (member '${this.memberLabel(memberId)}')`)
      }
    }
    return false
  }

  /**
   * Human-dispatched failure diagnosis. Resolves (or creates) the persistent
   * `doctor` Member, joins it to the failed Member's Channels so the report
   * can be traced there, starts it from a fresh context — the same renewal the
   * Human menu's reset performs — and steers the failed Member's bounded
   * session transcript into that fresh session as the research subject. The
   * doctor reports by direct message to the Human and as a Thread in the
   * failed Member's Channel; nothing in this remote waits for the analysis.
   */
  @Remote('diagnoseMember')
  async diagnoseMember(request: AgentTeamDiagnoseMemberRequest): Promise<AgentTeamDiagnoseMemberResult> {
    return this.enqueueLifecycle(async () => {
      this.requireAccepting()
      this.requireWorkspace(request.workspaceId)
      const ledger = this.requireLedger()
      const failed = ledger.getMember(request.memberId)
      if (failed === undefined || !ledger.participatesIn(request.memberId, request.workspaceId)) throw new Error(`unknown Member '${request.memberId}' in workspace '${request.workspaceId}'`)
      if (failed.handle.normalize('NFKC').trim().toLowerCase() === DOCTOR_HANDLE) throw new Error(`the doctor member cannot diagnose itself`)
      // The failed Member's Channels are the diagnosis's durable-trace surface:
      // the doctor inherits exactly that reach so it can post the report there.
      const homeChannels = ledger.channelsForMember(request.memberId, request.workspaceId)
      const { member: doctor, fresh } = await this.ensureDoctorMember(failed.workspaceId, homeChannels)
      // Every dispatch starts from an empty context, so prior analyses never
      // bleed into each other; a doctor created by this call is already fresh.
      // The renewal rebinds the Member onto a new Session, so report the
      // post-renewal ledger record, not the pre-renewal snapshot.
      if (!fresh) await this.renewMemberContextNow(doctor.memberId, request.requestId, 'doctor')
      const current = ledger.getMember(doctor.memberId) ?? doctor
      const handle = this.handles.get(current.memberId)
      if (handle === undefined) throw new Error(`the doctor member '${current.handle}' has no live session to receive the diagnosis task`)
      const { transcript, failureDiagnostic } = await this.failureTranscriptFor(request.memberId)
      handle.agent.steer(createUserMessage({
        content: [{ type: 'text', text: doctorAnalysisPrompt({
          failedHandle: failed.handle,
          ...(homeChannels.length === 0 ? {} : { channelRefs: homeChannels }),
          ...(failureDiagnostic === undefined ? {} : { failureDiagnostic }),
          transcript,
        }) }],
        source: { kind: AGENT_TEAM_PLUGIN_ID, form: 'notice', summary: DOCTOR_DIAGNOSTIC_SUMMARY },
      }))
      this.ctx.logger.info(`agent-team: doctor dispatched to diagnose member '${failed.handle}'`)
      return Object.freeze({ status: this.memberStatus(current) })
    })
  }

  /**
   * Resolve the persistent doctor Member for one Workspace, creating it on
   * first use: same Team Member preset, private memory like any other Member.
   * The doctor joins the failed Member's Channels — granted atomically at
   * creation, backfilled per dispatch for a reused doctor — so the analysis
   * can be recorded as a Thread where the failed work happened, not only as a
   * direct message. A disabled or archived `doctor` blocks the plain handle,
   * so a re-creation takes the same numbered-generation path a supervision
   * replacement does.
   */
  private async ensureDoctorMember(workspaceId: WorkspaceId, homeChannels: readonly AgentTeamChannelRef[]): Promise<{ readonly member: AgentTeamAgentMember; readonly fresh: boolean }> {
    const ledger = this.requireLedger()
    // The doctor is workspace-scoped: a handle match from another Workspace
    // cannot receive this dispatch's steer or Channel grants, so only a doctor
    // that participates here is reused.
    const existing = ledger.listMembers().find(member => member.state === 'enabled'
      && ledger.workspacesOf(member.memberId).includes(workspaceId)
      && member.handle.normalize('NFKC').trim().toLowerCase() === DOCTOR_HANDLE)
    if (existing !== undefined) {
      // A doctor reused across dispatches may lack Channels the failed Member
      // gained later; joinChannel itself refuses an existing membership, so
      // only the gap is committed.
      const joined = new Set(ledger.channelsForMember(existing.memberId, workspaceId))
      for (const channelRef of homeChannels) {
        if (joined.has(channelRef)) continue
        const channelJoin = await ledger.joinChannel({ requestId: randomUUID() as AgentTeamRequestId, workspaceId, channelRef, memberId: existing.memberId, actor: agentTeamHumanActor() })
        this.emitCommitted(channelJoin.value.receipt)
      }
      return { member: existing, fresh: false }
    }
    const taken = new Set(ledger.listMembers().map(member => member.handle.normalize('NFKC').trim().toLowerCase()))
    const handle = taken.has(DOCTOR_HANDLE) ? nextReplacementHandle(DOCTOR_HANDLE, ledger.listMembers().map(member => member.handle)) : DOCTOR_HANDLE
    const memberId = `member:${randomUUID()}` as AgentTeamMemberId
    const member: AgentTeamAgentMember = Object.freeze({
      memberId,
      sessionId: SessionId(`agent-team-${randomUUID()}`),
      workspaceId,
      handle,
      description: DOCTOR_DESCRIPTION,
      presetId: DOCTOR_PRESET_ID,
      privateMemoryPath: dshHomePath('agent-team', 'members', memberMemoryDirectoryName(memberId)),
      state: 'enabled',
    })
    const added = await ledger.addMember({
      requestId: randomUUID() as AgentTeamRequestId,
      workspaceId,
      handle,
      description: DOCTOR_DESCRIPTION,
      presetId: DOCTOR_PRESET_ID,
      channelRefs: [...homeChannels],
      member,
      actor: agentTeamHumanActor(),
    })
    if (!added.committed) throw new Error(`the doctor member '${handle}' could not be created`)
    this.emitCommitted(added.value.receipt)
    const stored = added.value.member
    await this.activateMember(stored, this.requireWorkspace(workspaceId).path)
    const activated = this.handles.get(stored.memberId)
    if (activated === undefined) {
      throw new Error(`the doctor member '${stored.handle}' failed to activate: ${this.memberFailures.get(stored.memberId)?.activation ?? 'unknown error'}`)
    }
    return { member: stored, fresh: true }
  }

  /**
   * The research material for one diagnosis: the failed Member's session log —
   * the live generation's own events when it still has one, the persisted log
   * otherwise — rendered as a bounded transcript, plus the Member's recorded
   * failure diagnostic (runtime first, then compaction, then activation).
   */
  private async failureTranscriptFor(memberId: AgentTeamMemberId): Promise<{ readonly transcript: string; readonly failureDiagnostic: string | undefined }> {
    const handle = this.handles.get(memberId)
    let events: readonly TranscriptEvent[]
    if (handle !== undefined) {
      events = handle.agent.session.snapshotEvents()
    } else {
      const sessionId = this.ledger?.getMember(memberId)?.sessionId
      if (sessionId === undefined) return { transcript: '(the member has no session log)', failureDiagnostic: undefined }
      const read = await this.sessionReader.read(sessionId)
      if (!read.ok) return { transcript: `(the member's session log could not be read: ${read.failure.kind})`, failureDiagnostic: undefined }
      events = read.inspection.events
    }
    const failures = this.memberFailures.get(memberId)
    return {
      transcript: renderFailureTranscript(events),
      failureDiagnostic: failures?.runtime?.message ?? failures?.compaction?.message ?? failures?.activation?.detail,
    }
  }

  /**
   * Retire one Member's previous generation after its durable binding moved
   * onto a new Session id: drop the old handle's transient state, dispose the
   * Agent, and archive the old Session log (which stays on disk for history).
   * Shared by the Human clear path and the model-initiated rollover.
   */
  private async retireMemberGeneration(memberId: AgentTeamMemberId, active: AgentHandle, previousSessionId: SessionId): Promise<void> {
    // Drop the old handle's transient state: pending recovery episodes and
    // error markers belong to the disposed agent, not to the Member.
    this.recovery.stopTracking(memberId)
    // The context admission gate stays armed through disposal: input racing
    // the retire window must still be captured for the new generation, and
    // the coordinator drops its own bookkeeping only after the swap settles.
    this.memberBySessionId.delete(previousSessionId)
    // The activity baseline belongs to the retired generation: the fresh one
    // starts its hung-detection clock from its own first event.
    this.memberActivity.delete(memberId)
    await active.dispose()
    this.handles.delete(memberId)
    this.modelSelections.delete(memberId)
    this.memberRuntime.forgetMember(memberId)
    this.clearMemberFailure(memberId, 'activation')
    // Runtime and compaction failures belong to the retired generation's
    // Session: a record left behind would keep presence in error and could
    // escalate a healthy new generation into an unneeded context reset.
    this.clearMemberFailure(memberId, 'runtime')
    this.clearMemberFailure(memberId, 'compaction')
    this.clearMemberNotificationState(memberId)
    // The previous log survives on disk; archiving hides it from every
    // grouping surface so one Member keeps exactly one visible Session.
    await this.ctx.workspaceRegistry.archiveSession(previousSessionId)
  }

  /**
   * Execute one prepared context rollover at a true idle boundary: commit the
   * idempotent Member-actor operation, retire the previous generation, and
   * activate the fresh Session whose first model-facing context is the
   * Member's own handoff. Later non-Team input captured during the transition
   * is delivered after the handoff; the Team Inbox is rederived from the
   * ledger, never copied.
   */
  private async executeMemberTransition(memberId: AgentTeamMemberId, plan: TransitionPlan): Promise<void> {
    await this.enqueueLifecycle(async () => {
      this.requireAccepting()
      const stored = this.requireLedger().getMember(memberId)
      if (stored === undefined || stored.state !== 'enabled') throw new Error(`Agent Member '${memberId}' cannot roll over: not enabled`)
      if (stored.sessionId !== plan.previousSessionId) throw new Error(`Agent Member '${stored.handle}' is no longer bound to the rolled-over Session`)
      const active = this.handles.get(memberId)
      if (active === undefined) throw new Error(`Agent Member '${stored.handle}' has no active session to roll over`)
      // A racing turn the admission gate rejects still leaves the Agent
      // momentarily running; wait for its convergence instead of failing the
      // swap — the gate guarantees it spends no model request.
      if (this.runningAgents.has(active.agent.id)) await active.agent.whenIdle()
      if (this.runningAgents.has(active.agent.id)) throw new Error(`Agent Member '${stored.handle}' is still running; the rollover must wait for idle`)
      // Checkpoint return: resolve the seed before committing anything. A
      // violation found here fails the whole swap with the old generation
      // intact — never a guessed seed over a wrong prefix.
      const seed = plan.checkpointRef === undefined ? undefined : await this.resolveCheckpointSeed(memberId, active.agent, plan.checkpointRef as AgentTeamContextCheckpointRef)
      // Recheck the job guard at the lifecycle commit seam: a job may have
      // started or settled after the tool-time validation.
      const blockingJobs = this.ownedJobsBlockingRollover(active.agent)
      if (blockingJobs.length > 0) {
        throw new Error(`the context rollover is refused: this Member now owns jobs that would not survive the switch (${blockingJobs.join(', ')}); collect or stop them, then retry`)
      }
      const rolled = await this.rolloverSessionForAgent(active.agent, {
        // The engine plan carries the host-derived request id as a plain
        // string; Team's rollover operation vocabulary brands it, and the
        // context-continuity host adapter is its only producer.
        requestId: plan.requestId as AgentTeamRolloverSessionRequest['requestId'],
        workspaceId: stored.workspaceId,
        memberId,
        previousSessionId: plan.previousSessionId,
        newSessionId: plan.newSessionId,
        handoffEventSeq: plan.handoffEventSeq as AgentTeamRolloverSessionRequest['handoffEventSeq'],
        trigger: plan.trigger,
        ...(seed === undefined ? {} : { checkpointRef: seed.checkpointRef, sourceSessionId: seed.sourceSessionId, sourceThroughSeq: seed.sourceThroughSeq }),
      })
      // Interrupt closing: a checkpoint return citing a pinned interrupt's
      // anchor consumed that interruption — close the entry inside the same
      // serialized step so the stack never holds an already-resumed session.
      // The requestId binds to the transition target, so a retried transition
      // replays to the same close and a crash between the two commits is
      // finished by the next attempt.
      if (seed !== undefined) {
        const pinned = this.requireLedger().pendingInterruptForCheckpoint(memberId, seed.checkpointRef)
        if (pinned !== undefined) {
          const closed = await this.requireLedger().resolveMemberInterrupt({
            requestId: `interrupt-resumed:${plan.newSessionId}` as AgentTeamRequestId,
            workspaceId: pinned.workspaceId,
            memberId,
            actor: this.memberActor(active.agent),
            interruptRef: pinned.interruptRef,
            resolution: 'resumed',
          })
          if (closed.committed) this.emitCommitted(closed.value.receipt)
        }
      }
      // The durable old-log projection is the carried-input truth: after the
      // old Agent retires, fold its final state and take every post-intent
      // non-Team candidate the old generation never answered. The process
      // capture only accelerates; it is unioned by message id, never allowed
      // to override the fold.
      const preRetireCapture = this.contextManagement.drainCapturedInput(memberId)
      // The retiring generation's live route is this transition's carried
      // selection: the next generation keeps the provider/model the prompt
      // was assembled against, so an operator default-model flip between
      // generations cannot re-interpolate the system prompt and void the
      // provider prefix cache mid-handoff. Only an explicit Member model
      // (or the renewal paths, which reload by contract) overrides it.
      const carriedSelection = this.modelSelections.get(memberId)?.current
      await this.retireMemberGeneration(memberId, active, plan.previousSessionId)
      const finalEvents = active.agent.session.ownEvents()
      const finalState = foldTeamContextProjection(
        finalEvents,
        { sessionId: active.agent.session.id, inheritedEventCount: active.agent.session.inheritedEventCount },
        this.contextProjectionHost,
      )
      const foldedCarried = carriedInputOf(finalState, finalEvents)
      const carriedById = new Map(plan.carriedInput.map(message => [message.id, message]))
      for (const message of foldedCarried) carriedById.set(message.id, message)
      for (const message of preRetireCapture) if (!carriedById.has(message.id)) carriedById.set(message.id, message)
      for (const message of this.contextManagement.drainCapturedInput(memberId)) if (!carriedById.has(message.id)) carriedById.set(message.id, message)
      const carriedInput = [...carriedById.values()]
      // A fresh rollover seeds nothing and points the lineage parent at the
      // previous active Session; a checkpoint return seeds the resolved
      // prefix and parents at the seed source Session instead. Activation
      // defers the ordinary Inbox wake so the handoff is guaranteed to be the
      // new generation's first model-facing context.
      const seedEvents = seed === undefined ? undefined : seed.prefix
      await this.activateMember(rolled.member, undefined, undefined, seed === undefined ? plan.previousSessionId : seed.sourceSessionId, {
        deferNotify: true,
        ...(carriedSelection === undefined ? {} : { carriedSelection }),
        // The prefix is contiguous from seq 0, so its length is exactly the
        // inherited cut the child folds past.
        ...(seedEvents === undefined ? {} : { seed: seedEvents, inheritedEventCount: SessionLogOffset(seedEvents.length) }),
      })
      const reactivated = this.handles.get(memberId)
      if (reactivated === undefined) {
        throw new Error(`Agent Member '${stored.handle}' failed to activate its next context: ${this.memberFailures.get(memberId)?.activation ?? 'unknown error'}`)
      }
      // The handoff is the first model-facing context of the new generation.
      // It rides the step-priority inbox lane (steer) so a later rederived
      // Inbox notice queues behind it instead of preempting it; carried input
      // follows as its own turn, and the Inbox is rederived from ledger facts.
      reactivated.agent.steer(this.contextManagement.handoffMessageFor(plan))
      for (const message of carriedInput) reactivated.agent.followup(message)
      const notifications = this.requireLedger().notificationFacts(rolled.member.memberId)
      if (notifications.length > 0) this.notifyMember(reactivated.agent, carriedInput.length > 0)
    })
  }

  /** Ledger handle for log lines; falls back to the raw id when unknown. */
  private memberLabel(memberId: AgentTeamMemberId): string {
    return this.ledger?.getMember(memberId)?.handle ?? memberId
  }

  /**
   * Cache GC: uploads referenced by a Message survive 72h from upload so
   * Member agents keep a consumption window; orphans (never sent) go after
   * 24h. Runs once at startup and then daily — in-process only, because the
   * cache is transient by design and rebuilds nothing across restarts.
   */
  private startAttachmentGc(ledger: AgentTeamLedger): void {
    const sweep = async (): Promise<void> => {
      await sweepAttachmentCache(attachmentsRoot(), ledger.referencedAttachmentIds(), Date.now())
    }
    void sweep()
    this.attachmentGcTimer = setInterval(() => { void sweep() }, 24 * 60 * 60 * 1000)
    this.attachmentGcTimer.unref?.()
  }

  private automaticResumeText(): string {
    return 'Your previous turn ended early due to a temporary service error. Please continue the work you were doing before the error.'
  }

  private manualResumeText(): string {
    return 'The operator asked you to resume after the previous turn ended early. Please continue the work you were doing before the error.'
  }

  /**
   * Steer one continuation message into a Member's live session. Throws when
   * no handle exists so the coordinator stops tracking; appends the inbox
   * snapshot whenever there is anything new to read.
   */
  private steerResume(member: AgentTeamAgentMember, text: string): void {
    const handle = this.handles.get(member.memberId)
    if (handle === undefined) throw new Error(`member '${member.handle}' has no active session`)
    const notifications = this.requireLedger().notificationFacts(member.memberId)
    const body = notifications.length === 0 ? text : `${text}\n\n${this.notificationText(notifications, member.memberId)}`
    const hint = createUserMessage({
      content: [{ type: 'text', text: body }],
      source: { kind: AGENT_TEAM_PLUGIN_ID, form: 'notice', summary: RECOVERY_NOTICE_SUMMARY },
    })
    for (const pending of [...handle.agent.inbox.nextStep, ...handle.agent.inbox.nextTurn]) {
      if (this.isInboxNotice(pending)) handle.agent.inbox.remove(pending.id)
    }
    handle.agent.steer(hint)
  }

  /** Automatic-recovery wakeup; throwing tells the coordinator the target is gone. */
  private injectRecovery(memberId: AgentTeamMemberId): void {
    const handle = this.handles.get(memberId)
    const agent = handle?.agent
    const member = agent !== undefined ? this.memberForAgent(agent) : undefined
    if (agent === undefined || member === undefined || member.state !== 'enabled') throw new Error(`member '${memberId}' cannot be recovered automatically`)
    this.steerResume(member, this.automaticResumeText())
  }

  /**
   * Run one supervision tick now: the periodic timer calls this, and a test or an
   * operator can drive it directly. Open escalation steps advance before the
   * pass's own bring-up budget runs — the same order the timer uses, so a chain
   * that stalled on a failed reset is retried here rather than nudged past.
   * Overlapping ticks are skipped by the policy, never queued, so a slow
   * handover cannot pile up more work behind itself.
   */
  runSupervisionPass(): Promise<void> {
    return this.supervisor.runTick()
  }

  /**
   * Run one completion-liaison pass now: the periodic timer calls this, and a
   * test or an operator can drive it with a chosen clock (the grace and
   * cooldown windows measure against the passed time).
   */
  runCompletionLiaisonPass(now?: number): Promise<void> {
    return this.completionLiaison.runPass(now)
  }

  /**
   * What supervision sees of one Member: a live Session whose preset composition
   * survived and no failure record. A context rollover or an in-flight turn is
   * `settling` (this policy never interrupts either) — except a turn that has
   * produced no durable Session event for {@link SUPERVISION_HUNG_MS}: a healthy
   * turn emits events continuously, so that much silence while nominally running
   * is a wedge, and the policy must act on it rather than wait forever. Anything
   * the roster reports as unreachable or erroring is the abnormal stop it acts
   * on. A Member that is live and simply idle with open Claims is waiting by
   * design. Reading healthy again drops any escalation progress: the chain only
   * ever advances while the Member stays abnormal.
   */
  private supervisionStateOf(memberId: AgentTeamMemberId): MemberSupervisionState {
    const ledger = this.requireLedger()
    const member = ledger.getMember(memberId)
    if (member === undefined || member.state !== 'enabled') return 'healthy'
    if (this.contextManagement.isTransitioning(memberId)) return 'settling'
    const handle = this.handles.get(memberId)
    if (handle !== undefined && this.runningAgents.has(handle.agent.id)) {
      const lastActivity = this.memberActivity.get(memberId)
      // No recorded activity yet (a turn that just started, or a pre-listener
      // generation) cannot prove a wedge: stay out of the way.
      if (lastActivity !== undefined && Date.now() - lastActivity >= SUPERVISION_HUNG_MS) return 'stopped'
      return 'settling'
    }
    const status = this.memberStatus(member)
    if (status.availability !== 'active' || status.presence === 'error') return 'stopped'
    this.supervisionEscalation.delete(memberId)
    this.retirementRecaps.delete(memberId)
    return 'healthy'
  }

  /**
   * One supervised bring-up: the same repair `recoverMember` performs, chosen by
   * what is actually missing. No live Session (or an orphaned composition) is
   * rebuilt; any other live Agent that stopped mid-work gets the automatic
   * continuation prompt. The next pass judges the attempt, so a throw here only
   * means it did not help.
   */
  private async restartMemberUnderSupervision(memberId: AgentTeamMemberId): Promise<void> {
    const ledger = this.requireLedger()
    const member = ledger.getMember(memberId)
    if (member === undefined || member.state !== 'enabled') return
    const handle = this.handles.get(memberId)
    if (handle === undefined || this.ctx.agentPresets.composedPreset(handle.agent.ctx) === undefined) {
      this.ctx.logger.warn(`agent-team: supervision rebuilding member '${member.handle}' after it stopped with no live composition`)
      await this.reactivateMember(memberId)
      return
    }
    this.ctx.logger.warn(`agent-team: supervision asking member '${member.handle}' to continue the work it stopped on`)
    this.steerResume(member, this.automaticResumeText())
  }

  /**
   * The give-up entry into the coercion chain: record the episode and run the
   * Host's own context reset immediately — the same fresh-context renewal the
   * Human menu performs, privately noticed to the reset Member alone. Nothing
   * is broadcast asking teammates to reset it: the Member re-orients from its
   * memory and the durable Team history and asks its teammates about whatever
   * stays unclear. A further give-up callback for the same episode re-enters
   * here as a no-op, and the chain's last resort — the archive-and-replace
   * handover — advances in {@link runSupervisionPass} only while the Member
   * still reads abnormal after the reset.
   */
  private async escalateSupervisedMember(memberId: AgentTeamMemberId, trigger: SupervisionTrigger, restartAttempts: number): Promise<void> {
    if (this.supervisionEscalation.has(memberId)) return
    this.supervisionEscalation.set(memberId, { trigger, restartAttempts, reset: false })
    // The final-Session recap is kicked off here, one whole supervision tick
    // before the handover it may decorate, so its bounded call has long settled
    // by the time the notice is built. It runs outside the ledger queue.
    const member = this.requireLedger().getMember(memberId)
    if (member !== undefined) this.startRetirementRecap(member)
    await this.forceResetSupervisedMember(memberId, trigger)
    // forceReset swallows a renewal that committed but could not reactivate —
    // that is still the reset step having run. Only a lifecycle refusal
    // (requireAccepting) reaches here, and it leaves reset:false so the next
    // pass retries the reset before any handover.
    this.supervisionEscalation.set(memberId, { trigger, restartAttempts, reset: true })
  }

  /**
   * Kick off the retirement recap outside the ledger queue: a one-shot,
   * propose-only digest of the Member's final Session whose result lands in a
   * per-Member slot the later handover reads without waiting. It never enters
   * the ledger, never becomes a Team fact, and never fails the handover — a
   * timeout, abort, or model error simply leaves no recap to append.
   */
  private startRetirementRecap(member: AgentTeamAgentMember): void {
    const entry: { recap?: SupervisionSessionRecap } = {}
    this.retirementRecaps.set(member.memberId, entry)
    void this.retirementSessionRecap(member)
      .then(recap => { if (recap !== undefined) entry.recap = recap })
      .catch(() => {})
  }

  /**
   * The best-effort recap itself: the retired Member's own final-Session
   * transcript, newest 20 entries, through the shared digest shape on the
   * Member's pinned model (the Host default when it pinned none). It reads only
   * the Member's bound Session — never an inherited ancestor — and resolves
   * `undefined` on any failure or timeout instead of throwing.
   */
  private async retirementSessionRecap(member: AgentTeamAgentMember): Promise<SupervisionSessionRecap | undefined> {
    try {
      const messages = await this.retiredFinalSessionDigestInput(member)
      if (messages.length === 0) return undefined
      const llm = this.ctx.get('llm')
      if (llm === undefined) return undefined
      const { system, messages: request } = buildDigestMessages({ messages })
      const selection = member.model ?? this.ctx.agentDefaultModel.currentSelection()
      const timeout = AbortSignal.timeout(DIGEST_TIMEOUT_MS)
      const assembler = new BlockAssembler()
      try {
        for await (const chunk of llm.stream({
          provider: selection.provider,
          model: selection.model,
          messages: [...request],
          system,
          maxTokens: DIGEST_MAX_TOKENS,
          signal: timeout,
        })) assembler.push(chunk)
      } catch {
        return undefined
      }
      // A cancelled call never produces a recap, even when a mock or lenient
      // adapter ignored the signal and streamed to completion.
      if (timeout.aborted) return undefined
      const finish = assembler.finish
      if (finish.kind === 'error' || finish.kind === 'aborted' || finish.kind === 'max-tokens') return undefined
      const text = assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('')
      const parsed = parseThreadDigest(text)
      return Object.freeze({ summary: parsed.summary, keyPoints: parsed.keyPoints })
    } catch {
      return undefined
    }
  }

  /**
   * The recap input: the Member's own final-Session transcript folded to the
   * digest's message shape, newest 20 entries. The live handle is preferred
   * while the Member's bound Session still has one; a stored read covers the
   * case where the failed mount has already released it.
   */
  private async retiredFinalSessionDigestInput(member: AgentTeamAgentMember): Promise<readonly ThreadDigestMessage[]> {
    const handle = this.handles.get(member.memberId)
    let events: readonly SessionEvent[] | undefined
    if (handle !== undefined && handle.agent.session.id === member.sessionId) {
      events = handle.agent.session.ownEvents()
    } else {
      const read = await this.sessionReader.read(member.sessionId)
      if (read.ok) events = read.inspection.events.slice(read.inspection.inheritedEventCount)
    }
    if (events === undefined) return []
    const entries: TranscriptEntry[] = []
    for (const event of events) entries.push(...humanTranscriptEntriesOf(event))
    return retirementRecapDigestMessages(member.handle, entries)
  }

  /**
   * Advance every open escalation while its Member is still abnormal: a reset
   * step that never committed retries, and a reset that did not heal the
   * Member becomes the archive-and-replace handover. A
   * Member that reads healthy (or left the roster) drops out of the chain —
   * a reset that healed it re-arms the gentle bring-up for any future
   * episode. Failures are logged, never thrown: the next pass retries the
   * same step.
   */
  private async advanceSupervisionEscalations(): Promise<void> {
    for (const [memberId, escalation] of [...this.supervisionEscalation]) {
      const state = this.supervisionStateOf(memberId)
      if (state === 'healthy') {
        this.supervisionEscalation.delete(memberId)
        this.retirementRecaps.delete(memberId)
        continue
      }
      if (state === 'settling') continue
      if (escalation.reset !== true) {
        try {
          await this.forceResetSupervisedMember(memberId, escalation.trigger)
          this.supervisionEscalation.set(memberId, { ...escalation, reset: true })
        } catch (error) {
          this.ctx.logger.warn(`agent-team: supervision force-reset for member '${memberId}' failed: ${error instanceof Error ? error.message : String(error)}`)
        }
        continue
      }
      try {
        await this.handOverSupervisedMember(memberId, escalation.trigger, escalation.restartAttempts)
        this.supervisionEscalation.delete(memberId)
        this.retirementRecaps.delete(memberId)
      } catch (error) {
        this.ctx.logger.warn(`agent-team: supervision handover for member '${memberId}' failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /**
   * Delivery for the idle-continuation watcher: the nudge rides the ordinary
   * mention path in the Team Assistant's voice — the Host's own supervision
   * identity, never the Human's — posted into the leader's Channel holding
   * the most named open Tasks (ties fall back to the oldest), with the leader
   * as the only explicit recipient. A throw is caught by the watcher and
   * logged — the next episode retries.
   */
  private async announceContinuationNudge(input: { readonly workspaceId: WorkspaceId, readonly leader: ContinuationLeader, readonly tasks: readonly ContinuationTask[] }): Promise<void> {
    const ledger = this.requireLedger()
    const channels = ledger.channelsForMember(input.leader.memberId, input.workspaceId)
    if (channels.length === 0) throw new Error(`leader '${input.leader.handle}' has no Channel in workspace '${input.workspaceId}'`)
    const namedRefs = new Set(input.tasks.map(task => task.taskRef))
    const openByChannel = new Map<AgentTeamChannelRef, number>()
    for (const row of ledger.tasksForWorkspace({ workspaceId: input.workspaceId }).tasks) {
      if (!namedRefs.has(row.taskRef)) continue
      openByChannel.set(row.channelRef, (openByChannel.get(row.channelRef) ?? 0) + 1)
    }
    // channelsForMember is oldest-first; the stable sort keeps that order for
    // ties, so open work that cannot be attributed to one Channel still lands
    // on the leader's founding Channel.
    const channelRef = [...channels].sort((a, b) => (openByChannel.get(b) ?? 0) - (openByChannel.get(a) ?? 0))[0]
    if (channelRef === undefined) throw new Error(`leader '${input.leader.handle}' has no resolvable Channel in workspace '${input.workspaceId}'`)
    await this.sendMessageAs(agentTeamAssistantActor(), {
      requestId: randomUUID() as AgentTeamRequestId,
      workspaceId: input.workspaceId,
      channelRef,
      body: continuationNudgeText({ leaderHandle: input.leader.handle, tasks: input.tasks }),
      recipients: [input.leader.memberId],
      asTask: false,
    })
  }

  /**
   * Channel pick for a liaison delivery addressed at one Member: their own
   * Channels in the Workspace, ranked by how many of the named open Tasks
   * each holds (ties fall back to the oldest, like the continuation nudge),
   * so the notice lands where the work actually lives.
   */
  private liaisonChannelFor(memberId: AgentTeamMemberId, workspaceId: WorkspaceId, tasks: readonly ContinuationTask[]): AgentTeamChannelRef | undefined {
    const ledger = this.requireLedger()
    const channels = ledger.channelsForMember(memberId, workspaceId)
    if (channels.length === 0) return undefined
    const namedRefs = new Set(tasks.map(task => task.taskRef))
    const openByChannel = new Map<AgentTeamChannelRef, number>()
    for (const row of ledger.tasksForWorkspace({ workspaceId }).tasks) {
      if (!namedRefs.has(row.taskRef)) continue
      openByChannel.set(row.channelRef, (openByChannel.get(row.channelRef) ?? 0) + 1)
    }
    return [...channels].sort((a, b) => (openByChannel.get(b) ?? 0) - (openByChannel.get(a) ?? 0))[0]
  }

  /**
   * Report-check delivery: the Team Assistant's voice names the idle Member
   * in the leader's oldest Channel of the Workspace, with the leader as the
   * only explicit recipient — the ordinary Inbox path wakes them into a turn.
   */
  private async notifyLiaisonLeader(input: { readonly memberId: AgentTeamMemberId, readonly memberHandle: string, readonly workspaceId: WorkspaceId, readonly leader: LiaisonLeader }): Promise<void> {
    const channelRef = this.requireLedger().channelsForMember(input.leader.memberId, input.workspaceId)[0]
    if (channelRef === undefined) throw new Error(`leader '${input.leader.handle}' has no Channel in workspace '${input.workspaceId}'`)
    await this.sendMessageAs(agentTeamAssistantActor(), {
      requestId: randomUUID() as AgentTeamRequestId,
      workspaceId: input.workspaceId,
      channelRef,
      body: liaisonReportCheckText({ leaderHandle: input.leader.handle, memberHandle: input.memberHandle }),
      recipients: [input.leader.memberId],
      asTask: false,
    })
  }

  /**
   * Truncation-escalation delivery: the Team Assistant's voice names the
   * truncated Member in the leader's Channel for the Workspace, with the
   * leader as the only explicit recipient — the ordinary Inbox path wakes
   * them into a turn where they decide what happens to the Member.
   */
  private async notifyLeaderOfTruncation(input: { readonly memberId: AgentTeamMemberId, readonly memberHandle: string, readonly workspaceId: WorkspaceId, readonly leader: TruncationLeader }): Promise<void> {
    const channelRef = this.requireLedger().channelsForMember(input.leader.memberId, input.workspaceId)[0]
    if (channelRef === undefined) throw new Error(`leader '${input.leader.handle}' has no Channel in workspace '${input.workspaceId}'`)
    await this.sendMessageAs(agentTeamAssistantActor(), {
      requestId: randomUUID() as AgentTeamRequestId,
      workspaceId: input.workspaceId,
      channelRef,
      body: truncationEscalationText({ leaderHandle: input.leader.handle, memberHandle: input.memberHandle }),
      recipients: [input.leader.memberId],
      asTask: false,
    })
  }

  /**
   * Open-Task push for a leaderless Workspace: the Member's busiest Channel,
   * the Member as the only explicit recipient, in the Team Assistant's voice.
   * The mention is direct work, so a fresh-context Member armed at completion
   * consumes its arm first and reads the Task list in the fresh generation.
   */
  private async pushLiaisonTasks(input: { readonly memberId: AgentTeamMemberId, readonly memberHandle: string, readonly workspaceId: WorkspaceId, readonly tasks: readonly ContinuationTask[] }): Promise<void> {
    const channelRef = this.liaisonChannelFor(input.memberId, input.workspaceId, input.tasks)
    if (channelRef === undefined) throw new Error(`member '${input.memberHandle}' has no Channel in workspace '${input.workspaceId}'`)
    await this.sendMessageAs(agentTeamAssistantActor(), {
      requestId: randomUUID() as AgentTeamRequestId,
      workspaceId: input.workspaceId,
      channelRef,
      body: liaisonTaskPushText({ memberHandle: input.memberHandle, tasks: input.tasks }),
      recipients: [input.memberId],
      asTask: false,
    })
  }

  /**
   * Interrupt-resume delivery: a runtime notice steered into the finished
   * Member's own Session (the context-reset notice shape — never a ledger
   * Message, since a resume is the Member's private context bookkeeping, not
   * a Team fact). It names the pending stack and the resume action so the
   * Member runs its pre-completion analysis against the durable interrupt
   * projection. A Member with no live handle throws: the lane stays retryable
   * for the next episode, exactly like the task push.
   */
  private async pushLiaisonInterrupts(input: { readonly memberId: AgentTeamMemberId, readonly memberHandle: string, readonly interrupts: readonly LiaisonInterrupt[] }): Promise<void> {
    const handle = this.handles.get(input.memberId)
    if (handle === undefined) throw new Error(`member '${input.memberHandle}' has no active session for interrupt resume`)
    const hint = createUserMessage({
      content: [{ type: 'text', text: liaisonResumePushText({ interrupts: input.interrupts }) }],
      source: { kind: AGENT_TEAM_PLUGIN_ID, form: 'notice', summary: INTERRUPT_PUSH_SUMMARY },
    })
    // Same sequencing as the reset notice: ordinary next-turn input already
    // queued claims the turn first, and this resume reminder rides behind it.
    if (handle.agent.inbox.nextTurn.some(message => message.source.kind === 'user')) handle.agent.followup(hint)
    else handle.agent.steer(hint)
  }

  /**
   * Declined-push relay: the refusing Member speaks in its own Channel (the
   * auto-prune notice shape — it speaks for itself rather than through the
   * Team Assistant), quoting its decision verbatim so only the Channel
   * carries the feedback to the Human.
   */
  private async notifyLiaisonFeedback(input: { readonly memberId: AgentTeamMemberId, readonly memberHandle: string, readonly workspaceId: WorkspaceId, readonly feedbackText: string }): Promise<void> {
    const openTasks = (this.ledger?.incompleteTasksForWatch() ?? []).filter(task => task.workspaceId === input.workspaceId)
    const channelRef = this.liaisonChannelFor(input.memberId, input.workspaceId, openTasks)
    if (channelRef === undefined) throw new Error(`member '${input.memberHandle}' has no Channel in workspace '${input.workspaceId}'`)
    await this.sendMessageAs({ kind: 'member', memberId: input.memberId, handle: input.memberHandle }, {
      requestId: randomUUID() as AgentTeamRequestId,
      workspaceId: input.workspaceId,
      channelRef,
      body: liaisonFeedbackText({ feedbackText: input.feedbackText }),
      asTask: false,
    })
  }

  /**
   * The chain's reset step: the Host performs the same context reset the Human
   * menu performs ({@link renewMemberContextNow} — durable renewal, generation
   * retire, fresh activation, private notice), retiring the wedged generation.
   * This is the one caller allowed to retire a generation that is nominally
   * still running: a hung Member never reaches idle, so refusing running
   * Agents here would make the fallback unreachable — disposal aborts the
   * wedged turn, and the durable binding has already moved by the time the old
   * Agent dies.
   */
  private async forceResetSupervisedMember(memberId: AgentTeamMemberId, trigger: SupervisionTrigger): Promise<void> {
    await this.enqueueLifecycle(async () => {
      this.requireAccepting()
      const stored = this.requireLedger().getMember(memberId)
      if (stored === undefined || stored.state !== 'enabled') return
      this.ctx.logger.warn(`agent-team: supervision force-resetting member '${stored.handle}' after ${trigger}`)
      this.clearMemberFailure(memberId, 'runtime')
      this.clearMemberFailure(memberId, 'compaction')
      try {
        await this.renewMemberContextNow(memberId, randomUUID() as AgentTeamRequestId, 'supervision')
      } catch (error) {
        // A renewal that committed but failed to reactivate (or could not even
        // start) is still chain progress: the diagnostic is recorded, and the
        // next pass re-reads the Member — healthy means the reset healed it,
        // still broken means the handover takes over.
        this.ctx.logger.warn(`agent-team: supervision force-reset of member '${stored.handle}' did not produce a live context: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  }

  /**
   * The terminal supervision action: archive the Member that cannot be brought
   * back and put a same-role generation in its place.
   *
   * Every fact this writes is an ordinary ledger operation committed under the
   * Host's Human authority, inside one serialized lifecycle step, so no Remote
   * call interleaves with the handover. The successor is added and activated
   * first, and the predecessor is archived only once that activation is real;
   * a successor that cannot come up is rolled back and the failure rethrown, so
   * the escalation stays open and the next pass retries the same step rather
   * than leaving the Team with an archived Member and no live replacement. What
   * the replacement inherits is the role
   * (preset, description, pinned model, capabilities), the private memory, and
   * the Channel reach of its predecessor; never its Session log. The abandoned
   * work itself becomes durable Team facts through archival's own
   * `claims_released` Activities, and the public notice asks the Human admin to
   * reassign those Tasks to the new handle.
   */
  private async handOverSupervisedMember(memberId: AgentTeamMemberId, trigger: SupervisionTrigger, restartAttempts: number): Promise<void> {
    await this.enqueueLifecycle(async () => {
      const ledger = this.requireLedger()
      const failed = ledger.getMember(memberId)
      if (failed === undefined || failed.state !== 'enabled') return
      // Capture the participation before archival: the ledger keeps memberships
      // across archival, but reading the handover input after the fact would
      // couple this step to that decision.
      const channelsByWorkspace = new Map<WorkspaceId, readonly AgentTeamChannelRef[]>(
        ledger.workspacesOf(memberId).map(workspaceId => [workspaceId, ledger.channelsForMember(memberId, workspaceId)] as const),
      )
      const homeChannels = channelsByWorkspace.get(failed.workspaceId) ?? []
      const taskNumbers = new Map(ledger.workspacesOf(memberId).flatMap(workspaceId =>
        ledger.tasksForWorkspace({ workspaceId }).tasks.map(task => [task.taskRef, task.taskNumber] as const)))
      const releasedClaims = ledger.activeClaimsForMember(memberId)
        .map(claim => Object.freeze({ direction: claim.direction, taskNumber: taskNumbers.get(claim.taskRef) ?? 0 }))
      const completedWork = ledger.completedWorkForMember(memberId)
      // A Workspace that no longer exists is left to the startup sweep instead of
      // being re-granted onto a Member that cannot activate in it.
      const otherWorkspaces = [...channelsByWorkspace.keys()].filter(workspaceId =>
        workspaceId !== failed.workspaceId && this.ctx.workspaceRegistry.get(workspaceId) !== undefined)
      const replacementHandle = nextReplacementHandle(failed.handle,
        ledger.listMembers().filter(member => member.state !== 'inactive').map(member => member.handle))
      const replacementId = `member:${randomUUID()}` as AgentTeamMemberId
      const replacement: AgentTeamAgentMember = Object.freeze({
        memberId: replacementId,
        sessionId: SessionId(`agent-team-${randomUUID()}`),
        predecessorMemberId: failed.memberId,
        workspaceId: failed.workspaceId,
        handle: replacementHandle,
        description: failed.description,
        presetId: failed.presetId,
        ...(failed.model === undefined ? {} : { model: Object.freeze({ ...failed.model }) }),
        ...(failed.capabilities === undefined ? {} : { capabilities: Object.freeze(deepCopyCapabilities(failed.capabilities)) }),
        ...(failed.prompt === undefined ? {} : { prompt: Object.freeze(deepCopyPrompt(failed.prompt)) }),
        ...(failed.contextStartPolicy === undefined ? {} : { contextStartPolicy: failed.contextStartPolicy }),
        ...(failed.contextWindow === undefined ? {} : { contextWindow: failed.contextWindow }),
        ...(failed.leader === undefined ? {} : { leader: failed.leader }),
        privateMemoryPath: dshHomePath('agent-team', 'members', memberMemoryDirectoryName(replacementId)),
        state: 'enabled',
      })
      const added = await ledger.addMember({
        requestId: randomUUID() as AgentTeamRequestId,
        actor: agentTeamHumanActor(),
        workspaceId: failed.workspaceId,
        handle: replacementHandle,
        description: failed.description,
        presetId: failed.presetId,
        ...(replacement.model === undefined ? {} : { model: replacement.model }),
        ...(replacement.capabilities === undefined ? {} : { capabilities: replacement.capabilities }),
        ...(replacement.prompt === undefined ? {} : { prompt: replacement.prompt }),
        ...(replacement.contextStartPolicy === undefined ? {} : { contextStartPolicy: replacement.contextStartPolicy }),
        ...(replacement.contextWindow === undefined ? {} : { contextWindow: replacement.contextWindow }),
        channelRefs: homeChannels,
        member: replacement,
      })
      if (!added.committed) throw new Error(`supervision could not commit a replacement Member for '${failed.handle}'`)
      const stored = added.value.member
      this.emitCommitted(added.value.receipt)
      // The inherited index has to be in place before the first activation:
      // provisioning only writes a missing `memory.md`, so the copy wins and the
      // replacement's first turn already reads what its predecessor knew.
      const inheritance = await this.memberRuntime.inheritPrivateMemory(failed, memberMemoryDirectoryPath(stored))
      if (inheritance === 'refused-foreign-home') this.ctx.logger.warn(`agent-team: supervision refused to inherit private memory from '${failed.privateMemoryPath}': it names a directory outside this DSH home`)
      await this.activateMember(stored, this.requireWorkspace(failed.workspaceId).path)
      // The predecessor stays live and enabled until its replacement is proven:
      // activation swallows its own failure, so a replacement that never came up
      // must be rolled back rather than left as the only roster row. Archiving
      // first would strand the Team on a tombstone with no successor to hand the
      // work to — the exact "reset deleted the Member" outcome this guards.
      if (!this.handles.has(stored.memberId)) {
        const dropped = await ledger.removeMember({ requestId: randomUUID() as AgentTeamRequestId, memberId: stored.memberId, actor: agentTeamHumanActor() })
        if (dropped.committed) this.emitCommitted(dropped.value.receipt)
        await this.disposeMemberSession(stored.memberId, dropped.value.member)
        await this.memberRuntime.cleanupRemovedMember(dropped.value.member)
        throw new Error(`supervision could not activate a replacement Member for '${failed.handle}'; the predecessor stays enabled and the pass retries`)
      }
      const archived = await ledger.archiveMember({ requestId: randomUUID() as AgentTeamRequestId, memberId, actor: agentTeamHumanActor() })
      this.emitCommitted(archived.value.receipt)
      await this.disposeMemberSession(memberId, archived.value.member)
      await this.ctx.workspaceRegistry.archiveSession(archived.value.member.sessionId)
      this.ctx.logger.warn(`agent-team: supervision replaced member '${failed.handle}' with '${stored.handle}' after ${trigger} and a forced reset that did not heal it`)
      for (const workspaceId of otherWorkspaces) {
        const joined = await ledger.joinWorkspace({ requestId: randomUUID() as AgentTeamRequestId, workspaceId, memberId: stored.memberId, actor: agentTeamHumanActor() })
        this.emitCommitted(joined.value.receipt)
        for (const channelRef of channelsByWorkspace.get(workspaceId) ?? []) {
          const channelJoin = await ledger.joinChannel({ requestId: randomUUID() as AgentTeamRequestId, workspaceId, channelRef, memberId: stored.memberId, actor: agentTeamHumanActor() })
          this.emitCommitted(channelJoin.value.receipt)
        }
      }
      // The notice is addressed to the workspace's designated leader when there
      // is one: a single addressed recipient keeps the Channel quiet, and the
      // assistant-actor send bypasses the member-in-Channel gate that a Member
      // actor would have to clear. Only with no reachable leader does it fall
      // back to the inherited-Channel broadcast.
      const leader = ledger.listMembers().find(member =>
        member.state === 'enabled' && member.leader === true
        && member.memberId !== memberId && member.memberId !== stored.memberId
        && ledger.workspacesOf(member.memberId).includes(failed.workspaceId))
      const leaderChannel = leader === undefined ? undefined : ledger.channelsForMember(leader.memberId, failed.workspaceId)[0]
      const addressedHandle = leader !== undefined && leaderChannel !== undefined ? leader.handle : AGENT_TEAM_HUMAN_HANDLE
      // Read the recap slot without waiting: the digest was kicked off a whole
      // supervision tick ago (at give-up) and has long settled — a still-open or
      // failed call simply contributes nothing.
      const sessionRecap = this.retirementRecaps.get(memberId)?.recap
      const noticeBody = supervisionRetirementNotice({
        failedHandle: failed.handle, replacementHandle: stored.handle, addressedHandle, trigger,
        restartAttempts, maxRestartAttempts: SUPERVISION_MAX_RESTART_ATTEMPTS,
        maxConsecutiveFailures: SUPERVISION_MAX_CONSECUTIVE_FAILURES,
        maxWindowFailures: SUPERVISION_WINDOW_FAILURES,
        maxFailureWindowMs: SUPERVISION_FAILURE_WINDOW_MS, completedWork, releasedClaims,
        ...(sessionRecap === undefined ? {} : { sessionRecap }),
      })
      if (leader !== undefined && leaderChannel !== undefined) {
        await this.sendMessageAs(agentTeamAssistantActor(), {
          requestId: randomUUID() as AgentTeamRequestId,
          workspaceId: failed.workspaceId,
          channelRef: leaderChannel,
          body: noticeBody,
          recipients: [leader.memberId],
          asTask: false,
        })
        return
      }
      if (homeChannels.length === 0) {
        // No shared Channel means no admin surface to ask through; the roster
        // change and the released Claims are still the durable record.
        this.ctx.logger.warn(`agent-team: supervision could not announce the '${failed.handle}' → '${stored.handle}' handover: the Member belonged to no Channel`)
        return
      }
      // No qualifying leader: the notice is broadcast on every Channel the
      // replacement inherited, in the Team Assistant's voice, and delivered to
      // every live Member of those Channels — the `@human` body mention
      // actually carries the admin ask to the Human's Inbox, while the explicit
      // recipients put the notice into each other Member's Inbox so the whole
      // Team learns which handle now owns the failed Member's reach.
      const noticeChannels = ledger.workspacesOf(stored.memberId)
        .flatMap(workspaceId => ledger.channelsForMember(stored.memberId, workspaceId).map(channelRef => ({ workspaceId, channelRef })))
      for (const { workspaceId, channelRef } of noticeChannels) {
        const audience = ledger.enabledChannelMembers(channelRef).filter(enabledMemberId => enabledMemberId !== stored.memberId)
        await this.sendMessageAs(agentTeamAssistantActor(), {
          requestId: randomUUID() as AgentTeamRequestId,
          workspaceId,
          channelRef,
          body: noticeBody,
          ...(audience.length === 0 ? {} : { recipients: audience }),
          asTask: false,
        })
      }
    })
  }

  /**
   * Human edit of one Member's mutable facts. A live model selection is
   * updated in place: disposing an Agent emits session/disposed, which makes
   * the Web Client permanently mark the same Session id unavailable even when
   * Team immediately recreates it.
   */
  @Remote('updateMember')
  async updateMember(request: AgentTeamUpdateMemberRequest): Promise<AgentTeamMemberResult> {
    return this.enqueueLifecycle(async () => {
      await this.assertModelRoute(request.model)
      const previous = this.requireLedger().getMember(request.memberId)
      const result = await this.requireLedger().updateMember({ ...request, actor: agentTeamHumanActor() })
      if (result.committed) this.emitCommitted(result.value.receipt)
      const stored = result.value.member
      const active = this.handles.get(request.memberId)
      if (active !== undefined && !isDeepStrictEqual(previous?.model ?? undefined, stored.model ?? undefined)) {
        const selection = this.modelSelections.get(request.memberId)
        if (selection === undefined) throw new Error(`Agent Member '${stored.handle}' has no live model selection`)
        selection.current = stored.model ?? this.ctx.agentDefaultModel.currentSelection()
      }
      const runtimeSwapNeeded = !isDeepStrictEqual(previous?.capabilities ?? undefined, stored.capabilities ?? undefined)
        || !isDeepStrictEqual(previous?.prompt ?? undefined, stored.prompt ?? undefined)
      if (runtimeSwapNeeded) this.scheduleMemberRuntimeApply(stored)
      return Object.freeze({ receipt: result.value.receipt, status: this.memberStatus(stored) })
    })
  }

  /**
   * Schedule the live swap one capability or prompt edit of a Member calls
   * for, mirroring the fresh-start reset and auto-prune seams: the durable
   * edit answers immediately and the turn-boundary wait runs OUTSIDE the
   * serialized lifecycle queue, so a long — or hung — turn never holds the
   * edit's response, another Member's edit, or the supervision force-reset
   * behind it. One in-flight body per Member: overlapping edits coalesce,
   * because the body re-applies the CURRENT ledger facts rather than the
   * snapshot it was scheduled from. No active handle means nothing to swap:
   * activation re-applies everything from the ledger. An idle Member has no
   * boundary to wait for, so its swap stays synchronous inside the edit's own
   * queue body and the answer already reflects the live surface.
   */
  private scheduleMemberRuntimeApply(member: AgentTeamAgentMember): void {
    const memberId = member.memberId
    const active = this.handles.get(memberId)
    if (active === undefined) return
    if (!this.runningAgents.has(active.agent.id)) {
      this.applyMemberRuntime(member)
      return
    }
    if (this.pendingMemberApplies.has(memberId)) return
    this.pendingMemberApplies.add(memberId)
    void this.runMemberRuntimeApply(member, active)
  }

  /**
   * Background body of one scheduled runtime apply. While the Agent runs, the
   * current turn keeps its schemas, catalog, and assembled prompt; the swap
   * happens once the turn ends, with the same Session and history surviving.
   * The handle is re-checked unconditionally after the wait — the wait may
   * have resolved because the old generation was disposed rather than because
   * the turn ended, and an external Session dispose can move the generation on
   * without the Team queue ever seeing it. A stale handle bails: the disposed
   * scope released the old restriction, section, and drop listener already, no
   * disposer leaks, and the ledger intent applies at the next activation
   * instead. Like the sweep, the body re-reads the Member at the boundary and
   * again inside the queue — lifecycle edits and suspensions can commit while
   * it waits — and a Member that is no longer stored or no longer enabled
   * drops. Failures are logged, never thrown and never retried: the durable
   * edit already landed.
   */
  private async runMemberRuntimeApply(member: AgentTeamAgentMember, active: AgentHandle): Promise<void> {
    const memberId = member.memberId
    try {
      await this.memberRuntime.awaitTurnBoundary(active)
      if (this.handles.get(memberId) !== active) return
      if (this.runningAgents.has(active.agent.id)) await active.agent.whenIdle()
      if (this.handles.get(memberId) !== active) return
      const stored = this.ledger?.getMember(memberId)
      if (stored === undefined || stored.state !== 'enabled') return
      await this.enqueueLifecycle(async () => {
        this.requireAccepting()
        // Lifecycle edits and suspensions queue ahead of this body and can
        // commit after the boundary re-read above; only a still-stored,
        // still-enabled Member with a live session swaps.
        const current = this.ledger?.getMember(memberId)
        if (current === undefined || current.state !== 'enabled') return
        if (this.handles.get(memberId) === undefined) return
        this.applyMemberRuntime(current)
      })
    } catch (error) {
      this.ctx.logger.warn(`agent-team: live apply of the edit for member '${member.handle}' failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.pendingMemberApplies.delete(memberId)
    }
  }

  /**
   * Re-apply both live halves — the capability swap (restriction, then the
   * skill-selection filter) and the prompt swap (custom section, then the drop
   * listener) — from the Member's current ledger facts. Both halves always
   * run, whichever one the edit touched: each primitive is release-then-apply,
   * every release is a no-op when nothing was ever registered, and every apply
   * registers nothing when the stored field is absent (an absent allow-list, a
   * blank paragraph, an empty drop list). Re-applying an unchanged half is
   * therefore an idempotent swap of the same surface, and the coalesced body
   * stays correct for whichever halves the edits in flight actually changed.
   */
  private applyMemberRuntime(member: AgentTeamAgentMember): void {
    this.memberRuntime.reapplyMemberToolPolicy(member)
    this.memberRuntime.swapSkillSelection(member.memberId, member.capabilities?.skills?.allow)
    this.memberRuntime.reapplyMemberPromptSection(member)
    this.memberRuntime.reapplyMemberSectionDrops(member)
  }

  /** Irreversibly remove one Member, archive its Session, and delete its private namespace. */
  async removeMember(request: AgentTeamRemoveMemberRequest): Promise<AgentTeamRemoveMemberResult> {
    return this.enqueueLifecycle(async () => {
      const result = await this.requireLedger().removeMember({ ...request, actor: agentTeamHumanActor() })
      if (result.committed) this.emitCommitted(result.value.receipt)
      await this.disposeMemberSession(request.memberId, result.value.member)
      await this.memberRuntime.cleanupRemovedMember(result.value.member)
      return result.value
    })
  }

  /**
   * Archive one Member: commit the archival, stop its live session (disposal
   * only — private memory and the Session log stay on disk for a future
   * restore), and archive the Session from every grouping surface. Like
   * removal, all active Claims release and the Member's Attention clears.
   */
  @Remote('archiveMember')
  async archiveMember(request: AgentTeamArchiveMemberRequest): Promise<AgentTeamArchiveMemberResult> {
    return this.enqueueLifecycle(async () => {
      const result = await this.requireLedger().archiveMember({ ...request, actor: agentTeamHumanActor() })
      if (result.committed) this.emitCommitted(result.value.receipt)
      await this.disposeMemberSession(request.memberId, result.value.member)
      await this.ctx.workspaceRegistry.archiveSession(result.value.member.sessionId)
      return result.value
    })
  }

  /** Human-only Task resolution. Business fences are returned as typed outcomes. */
  @Remote('changeTask')
  async changeTask(request: AgentTeamTaskRequest): Promise<AgentTeamTaskResult> {
    this.requireAccepting()
    this.requireWorkspace(request.workspaceId)
    const result = await this.requireLedger().changeTask({ ...request, actor: agentTeamHumanActor() })
    this.emitCommittedOutcome(result)
    return result.value
  }

  /** Human-only batch Task resolution: acceptance or closing for several Tasks in one turn. */
  @Remote('changeTasks')
  async changeTasks(request: AgentTeamTasksBatchRequest): Promise<AgentTeamTasksBatchResult> {
    this.requireAccepting()
    this.requireWorkspace(request.workspaceId)
    const result = await this.requireLedger().changeTasks({ ...request, actor: agentTeamHumanActor() })
    if (result.committed) {
      for (const outcome of result.value.outcomes) {
        if (outcome.kind === 'committed') this.emitCommitted(outcome.receipt)
      }
    }
    return result.value
  }

  /** Human-only promotion of a taskless Thread into a real Task plus public Message. */
  @Remote('promoteThread')
  async promoteThread(request: AgentTeamPromoteThreadRequest): Promise<AgentTeamPromoteThreadResult> {
    this.requireAccepting()
    this.requireWorkspace(request.workspaceId)
    const result = await this.requireLedger().promoteThread({ ...request, actor: agentTeamHumanActor() })
    this.emitCommittedOutcome(result)
    return result.value
  }

  /** Human-only Channel membership grant; it never injects historical Thread bodies. */
  @Remote('joinChannel')
  async joinChannel(request: AgentTeamJoinChannelRequest): Promise<AgentTeamJoinChannelResult> {
    const actor = this.humanCall(request.workspaceId)
    const ledger = this.requireLedger()
    if (!ledger.hasCommitted(request.requestId)) this.assertChannelMembersAvailable([request.memberId])
    const result = await ledger.joinChannel({ ...request, actor })
    if (result.committed) this.emitCommitted(result.value.receipt)
    return result.value
  }

  /** Human-only Channel membership removal and Channel-scoped cleanup. */
  @Remote('removeChannelMember')
  async removeChannelMember(request: AgentTeamRemoveChannelMemberRequest): Promise<AgentTeamRemoveChannelMemberResult> {
    const actor = this.humanCall(request.workspaceId)
    const result = await this.requireLedger().removeChannelMember({ ...request, actor })
    if (result.committed) this.emitCommitted(result.value.receipt)
    return result.value
  }

  /** Human-only Workspace participation grant; a pure relation — no Session moves. */
  @Remote('joinWorkspace')
  async joinWorkspace(request: AgentTeamJoinWorkspaceRequest): Promise<AgentTeamJoinWorkspaceResult> {
    const actor = this.humanCall(request.workspaceId)
    const result = await this.requireLedger().joinWorkspace({ ...request, actor })
    if (result.committed) this.emitCommitted(result.value.receipt)
    return result.value
  }

  /** Human-only Workspace participation withdrawal and Workspace-scoped cleanup. */
  @Remote('leaveWorkspace')
  async leaveWorkspace(request: AgentTeamLeaveWorkspaceRequest): Promise<AgentTeamLeaveWorkspaceResult> {
    const actor = this.humanCall(request.workspaceId)
    const result = await this.requireLedger().leaveWorkspace({ ...request, actor })
    if (result.committed) this.emitCommitted(result.value.receipt)
    return result.value
  }

  /** Human top-level Thread start; asTask attaches an optional Task overlay. */
  @Remote('sendMessage')
  async sendMessage(request: AgentTeamSendMessageRequest): Promise<AgentTeamSendMessageResult> {
    return this.sendMessageAs(this.humanCall(request.workspaceId), request)
  }

  /**
   * Resolve uploaded ids and agent-supplied absolute paths into one attachment
   * metadata list. Paths are all validated before anything is copied, so one
   * rejection leaves the cache untouched and the message uncommitted.
   */
  private async resolveMessageAttachments(request: { readonly attachments?: readonly AgentTeamAttachmentId[] | undefined; readonly attachmentPaths?: readonly string[] | undefined }): Promise<readonly AgentTeamMessageAttachment[]> {
    const fromPaths: AgentTeamMessageAttachment[] = []
    if (request.attachmentPaths !== undefined && request.attachmentPaths.length > 0) {
      for (const absolutePath of request.attachmentPaths) await validatePathAttachment(absolutePath)
      for (const absolutePath of request.attachmentPaths) fromPaths.push(Object.freeze(await copyPathAttachment(attachmentsRoot(), absolutePath)))
    }
    return [...fromPaths, ...await this.prepareAttachments(request.attachments)]
  }

  /** Verify requested attachment ids against the cache. */
  private async prepareAttachments(requested?: readonly AgentTeamAttachmentId[]): Promise<readonly AgentTeamMessageAttachment[]> {
    if (requested === undefined || requested.length === 0) return []
    const metadata: AgentTeamMessageAttachment[] = []
    for (const attachmentId of requested) {
      const stored = await readAttachment(attachmentsRoot(), attachmentId)
      if (stored === undefined) throw new Error(`attachment '${attachmentId}' is not in the upload cache`)
      metadata.push(Object.freeze({ attachmentId, name: stored.name, byteSize: stored.byteSize, mediaType: stored.mediaType }))
    }
    return metadata
  }

  /**
   * Derive the stored body: one machine-facing `[attachment] <absolute path>`
   * line per attachment appended to the member-facing text.
   */
  private appendAttachmentLines(body: string, metadata: readonly AgentTeamMessageAttachment[]): string {
    const trimmed = body.trim()
    if (metadata.length === 0) return trimmed
    const lines = metadata.map(attachment => `[attachment] ${attachmentPayloadPath(attachment.attachmentId, attachment.name)}`)
    return `${trimmed}\n${lines.join('\n')}`
  }

  /** Upload one composer attachment into the cache; bytes are immutable once written. */
  @Remote('putAttachment')
  async putAttachment(request: AgentTeamPutAttachmentRequest): Promise<AgentTeamPutAttachmentResult> {
    this.requireAccepting()
    this.requireWorkspace(request.workspaceId)
    const bytes = Buffer.from(request.bytesBase64, 'base64')
    if (bytes.byteLength === 0) throw new Error('attachment must not be empty')
    if (bytes.byteLength > ATTACHMENT_MAX_BYTES) throw new Error(`attachment exceeds the ${ATTACHMENT_MAX_BYTES} byte limit`)
    const mediaType = sanitizeMediaType(request.mediaType)
    const attachmentId = newAttachmentId()
    return Object.freeze(await writeAttachment(attachmentsRoot(), attachmentId, request.name, mediaType, bytes))
  }

  /** Read one cached attachment back for client display; gone entries throw and the UI degrades to a chip. */
  @Remote('getAttachment')
  async getAttachment(request: AgentTeamGetAttachmentRequest): Promise<AgentTeamGetAttachmentResult> {
    const stored = await readAttachment(attachmentsRoot(), request.attachmentId)
    if (stored === undefined) throw new Error(`attachment '${request.attachmentId}' is no longer cached`)
    return Object.freeze({ name: stored.name, mediaType: stored.mediaType, byteSize: stored.byteSize, bytesBase64: stored.bytes.toString('base64') })
  }

  /**
   * Human profile read for the settings page and footnote: name + avatar
   * reference from this Host row's live Config plus version facts. Human-scoped
   * (the Web Client calls it); agent tools never receive avatar bytes, only the
   * name through team_view. The new-release check stays best-effort and cached —
   * `updateAvailable` is false until a background refresh actually observes a
   * newer published release.
   */
  /**
   * Local environment check for the settings page: which DSH line this Host
   * runs against, and whether that line is inside the range this bundle
   * declares. Human-scoped and read-only — the Client renders the verdict and
   * states the range in words, and nothing here is written back.
   *
   * Synchronous like `humanProfile`: both read the installed manifest once and
   * settle immediately, and the verdict comes from the Harness's own
   * compatibility evaluator rather than a second version comparison written
   * here.
   *
   * The wire type and `EnvironmentReport` keep separate top-level field lists on
   * purpose: the contract states every fact as optional because a Transport may
   * withhold any of them, while the report is the stricter thing the checker
   * guarantees. This assignment is where the compiler holds the two together,
   * and a new required contract field fails it here.
   */
  @Remote('environment')
  environmentForClient(_request: AgentTeamEnvironmentRequest): AgentTeamEnvironmentResult {
    return Object.freeze(reportEnvironment())
  }

  @Remote('humanProfile')
  humanProfileForClient(_request: AgentTeamHumanProfileRequest): AgentTeamHumanProfileResult {
    const profile = this.humanProfile()
    const update = this.humanUpdateCheck.snapshot()
    return Object.freeze({
      name: profile.name,
      ...(profile.avatarRef === undefined ? {} : { avatarRef: profile.avatarRef }),
      version: HUMAN_PROFILE_VERSION,
      repoUrl: HUMAN_PROFILE_REPO_URL,
      updateAvailable: update.updateAvailable,
      ...(update.latestVersion === undefined ? {} : { latestVersion: update.latestVersion }),
    })
  }

  /**
   * Upload one human avatar image into the persistent store. Human-only by
   * construction: only the Web Client calls this Remote, never agent tools.
   * The caller stores the returned ref in settings; bytes never enter the
   * TTL-bound attachment cache.
   */
  @Remote('putHumanAvatar')
  async putHumanAvatar(request: AgentTeamPutHumanAvatarRequest): Promise<AgentTeamPutHumanAvatarResult> {
    this.requireAccepting()
    const bytes = Buffer.from(request.bytesBase64, 'base64')
    return Object.freeze(await writeHumanAvatar(humanAvatarsRoot(), request.name, request.mediaType ?? 'application/octet-stream', bytes))
  }

  /** Read one human avatar back; removed entries throw and the UI falls back to hue/initial. */
  @Remote('getHumanAvatar')
  async getHumanAvatar(request: AgentTeamGetHumanAvatarRequest): Promise<AgentTeamGetHumanAvatarResult> {
    const stored = await readHumanAvatar(humanAvatarsRoot(), request.avatarRef)
    if (stored === undefined) throw new Error(`human avatar '${request.avatarRef}' is no longer stored`)
    return Object.freeze({ name: stored.name, mediaType: stored.mediaType, byteSize: stored.byteSize, bytesBase64: stored.bytes.toString('base64') })
  }

  /** Remove one human avatar entry; the UI falls back to hue/initial afterwards. */
  @Remote('removeHumanAvatar')
  async removeHumanAvatar(request: AgentTeamRemoveHumanAvatarRequest): Promise<AgentTeamRemoveHumanAvatarResult> {
    this.requireAccepting()
    await removeHumanAvatar(humanAvatarsRoot(), request.avatarRef)
    return Object.freeze({ removed: true })
  }

  /**
   * Overwrite the Human profile fields the caller supplies. The Host owns this
   * write because the profile is the Host row's own Config: the schema supplies
   * the shape, this method supplies the two judgements the schema cannot make
   * (a non-empty name, a name no live Member already answers to), and the
   * settings service persists the result into the active profile's patch
   * document and applies it to the running plugin live.
   *
   * No expected revision accompanies the write: the profile is two scalar
   * fields written from the Human's own pages, where the last write wins. This
   * is not a hard boundary around a user-editable document — the settings
   * service's own document opener (and a text editor) can change the stored
   * name without passing here, exactly as the retired section validator could
   * not stop it.
   */
  @Remote('setHumanProfile')
  async setHumanProfile(request: AgentTeamSetHumanProfileRequest): Promise<AgentTeamSetHumanProfileResult> {
    this.requireAccepting()
    const settings = this.ctx.get('settings')
    if (settings === undefined) throw new Error('the settings service is unavailable')
    const name = request.name === undefined ? undefined : assertValidHumanName(request.name)
    if (name !== undefined) this.validateHumanProfile({ name })
    const ops: SettingsPathOp[] = []
    if (name !== undefined) ops.push({ op: 'set', path: ['name'], value: name })
    if (request.avatarRef === null) ops.push({ op: 'unset', path: ['avatarRef'] })
    else if (request.avatarRef !== undefined) ops.push({ op: 'set', path: ['avatarRef'], value: request.avatarRef })
    if (ops.length !== 0) {
      // The settings namespace IS this Host row's id in the composition, and it
      // must be addressed by that name rather than by `ctx.fiber.entry` here: a
      // Remote call runs under its caller's context, whose fiber entry is the
      // RPC gateway's row (`typert-gateway`), which the settings service then
      // looks up as an unrelated plugin. shipping.spec.ts pins the constant to
      // the row `cordis.patch.yml` declares.
      await settings.mutate(HUMAN_PROFILE_SETTINGS_NAMESPACE, ops)
    }
    return Object.freeze({ ...this.humanProfile() })
  }

  /** Human existing-Thread reply; unread and revision conflicts are business outcomes. */
  @Remote('reply')
  async reply(request: AgentTeamReplyRequest): Promise<AgentTeamReplyResult> {
    return this.replyAs(this.humanCall(request.workspaceId), request)
  }

  /**
   * Human correction of one Human-sent Message. The executor candidates are
   * read from the pre-commit projection, the ledger commits the body swap, and
   * only then — before the commit's wake is emitted — is every Member that may
   * be executing the old body (mentioned, read through, currently running)
   * force-stopped with its Inbox intact. Cancel first, wake second: the
   * corrected instruction is re-delivered through the re-added markers and
   * replays after the aborted turn converges instead of racing it.
   */
  @Remote('editMessage')
  async editMessage(request: AgentTeamEditMessageRequest): Promise<AgentTeamEditMessageResult> {
    const actor = this.humanCall(request.workspaceId)
    const ledger = this.requireLedger()
    const candidates = ledger.executorsOfMessage(request.messageRef)
    const result = await ledger.editMessage({ ...request, actor })
    const stoppedMembers = result.committed ? this.forceStopExecutors(candidates) : []
    this.emitCommittedOutcome(result)
    return { ...result.value, stoppedMembers }
  }

  /**
   * Human retraction or deletion of one Human-sent Message, with the same
   * pre-commit executor snapshot and force-stop ordering as the edit. A recall
   * adds no marker, so the commit wake names nobody: the stopped Members learn
   * of the withdrawal through an explicit notice, and every other reader sees
   * the tombstone (or nothing, for a deletion) on its next look.
   */
  @Remote('recallMessage')
  async recallMessage(request: AgentTeamRecallMessageRequest): Promise<AgentTeamRecallMessageResult> {
    const actor = this.humanCall(request.workspaceId)
    const ledger = this.requireLedger()
    const candidates = ledger.executorsOfMessage(request.messageRef)
    const result = await ledger.recallMessage({ ...request, actor })
    const stoppedMembers = result.committed ? this.forceStopExecutors(candidates) : []
    this.emitCommittedOutcome(result)
    if (stoppedMembers.length > 0) this.notifyRecalledInstruction(stoppedMembers)
    return { ...result.value, stoppedMembers }
  }

  /** Abort the running subset; their queued work survives (keepInbox) and the commit's wake replays it. */
  private forceStopExecutors(memberIds: readonly AgentTeamMemberId[]): readonly AgentTeamMemberId[] {
    const stopped: AgentTeamMemberId[] = []
    for (const memberId of memberIds) {
      const agent = this.handles.get(memberId)?.agent
      if (agent === undefined || agent.status !== 'running') continue
      try {
        agent.cancel({ kind: 'user' }, { keepInbox: true })
        stopped.push(memberId)
      } catch (error) {
        // A failed stop cannot roll back the committed correction.
        this.ctx.logger.warn(`agent-team: force-stop of '${memberId}' failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return stopped
  }

  /** Plain-language withdrawal notice to force-stopped Members: this instruction is dead, the rest of the queue continues. */
  private notifyRecalledInstruction(memberIds: readonly AgentTeamMemberId[]): void {
    const notice = createUserMessage({ content: [{ type: 'text',
      text: 'The user has withdrawn the instruction you were working on. Stop it now: do not produce further output for it, and do not report it as done. Every other pending instruction stays in effect — continue with those.' }],
      source: { kind: AGENT_TEAM_PLUGIN_ID, form: 'notice', summary: 'Instruction withdrawn by the user' } })
    for (const memberId of memberIds) {
      const handle = this.handles.get(memberId)
      if (handle === undefined) continue
      try {
        if (handle.agent.status === 'idle') handle.agent.followup(notice)
        else handle.agent.steer(notice)
      } catch (error) {
        // Notification delivery cannot roll back a committed recall.
        this.ctx.logger.warn(`agent-team: withdrawal notice not delivered to '${memberId}': ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /** Human's personal Attention operation. */
  @Remote('changeAttention')
  async changeAttention(request: AgentTeamThreadAttentionRequest): Promise<AgentTeamThreadAttentionResult> {
    const actor = this.humanCall(request.workspaceId)
    const result = await this.requireLedger().changeAttention({ ...request, actor })
    if (result.committed) this.emitCommitted(result.value.receipt)
    return result.value
  }

  /** Human Inbox projection; the Web Client consumes the direct-only slice as its mention queue. */
  @Remote('inbox')
  inbox(request: AgentTeamInboxRequest): AgentTeamInbox {
    this.requireWorkspace(request.workspaceId)
    return this.requireLedger().inbox(agentTeamHumanActor(), request)
  }

  /**
   * Human's cross-Channel Task list: every Task with its sub-task linkage and live progress.
   */
  @Remote('tasks')
  tasks(request: AgentTeamTasksRequest): AgentTeamTasks {
    this.requireWorkspace(request.workspaceId)
    return this.requireLedger().tasksForWorkspace(request)
  }

  /** Human's per-Member working queues: current Claims and unclaimed Channel work, one read for the roster. */
  @Remote('memberTasks')
  memberTasks(request: AgentTeamMemberTasksRequest): AgentTeamMemberTasks {
    this.requireWorkspace(request.workspaceId)
    return this.requireLedger().memberTasksForWorkspace(request)
  }

  /** Human's durable, atomically acknowledged Thread read. */
  @Remote('readThread')
  async readThread(request: AgentTeamThreadReadRequest): Promise<AgentTeamThreadReadResult> {
    const actor = this.humanCall(request.workspaceId)
    const result = await this.requireLedger().readThread({ ...request, actor })
    // A read that made no progress commits no operation and carries no receipt.
    const receipt = result.committed ? result.value.receipt : undefined
    if (receipt !== undefined) this.emitCommitted(receipt)
    return result.value
  }

  /** Human-only durable Attention observations for one Thread. */
  @Remote('threadObservations')
  threadObservations(request: AgentTeamThreadObservationsRequest): AgentTeamThreadObservations {
    this.requireWorkspace(request.workspaceId)
    return this.requireLedger().threadObservations(agentTeamHumanActor(), request)
  }

  /** Human's non-mutating bounded Thread history. */
  @Remote('threadHistory')
  threadHistory(request: AgentTeamThreadHistoryRequest): AgentTeamThreadHistory {
    this.requireWorkspace(request.workspaceId)
    return this.requireLedger().threadHistory(agentTeamHumanActor(), request)
  }

  /**
   * Human one-shot plain-language Thread digest: propose-only, commits
   * nothing, the same ephemeral shape as Prompt curation. The call rides the
   * Host's public `llm.stream()` seam on the Team's own configured route
   * (`digestModelSelection`) with the
   * bounded Thread transcript, names resolved through the ledger's single
   * actor resolver so a name never reads differently on two surfaces. The
   * request is assembly-free: it carries only the digest instruction and the
   * transcript — no tools, skills, MCP, memory or Member identity — exactly
   * the one-shot shape Prompt curation uses. The
   * model's decision flag is merged with the ledger's own awaiting-acceptance
   * fact: a Task open at `in_review` is waiting on the Human even if the
   * digest call glossed over it.
   */
  @Remote('summarizeThread')
  async summarizeThread(request: AgentTeamSummarizeThreadRequest, signal?: AbortSignal): Promise<AgentTeamSummarizeThreadResult> {
    this.requireWorkspace(request.workspaceId)
    const ledger = this.requireLedger()
    const history = ledger.threadHistory(agentTeamHumanActor(), { workspaceId: request.workspaceId, threadRef: request.threadRef, limit: DIGEST_MESSAGE_LIMIT })
    const nameOf = (memberId: AgentTeamMemberId): string => ledger.actorFor(memberId).name
    const replyFacts = history.facts.filter((fact): fact is Extract<AgentTeamThreadFact, { kind: 'message' }> =>
      fact.kind === 'message' && fact.message.messageRef !== history.anchor.messageRef)
    // A recalled instruction is audit-only: its body reaches the digest model as
    // the withdrawal tombstone, never as the withdrawn text.
    const transcript: readonly ThreadDigestMessage[] = [
      { author: nameOf(history.anchor.sender), text: history.anchor.recalledAt === undefined ? history.anchor.body : AGENT_TEAM_RECALLED_BODY_TOMBSTONE, mentions: history.anchorMentions.map(nameOf) },
      ...replyFacts.map(fact => ({ author: nameOf(fact.message.sender), text: fact.message.recalledAt === undefined ? fact.message.body : AGENT_TEAM_RECALLED_BODY_TOMBSTONE, mentions: fact.mentions.map(nameOf) })),
    ]
    const awaitingReview = history.task !== undefined && history.task.resolution === 'open' && history.task.status === 'in_review'
    const llm = this.ctx.get('llm')
    if (llm === undefined) throw new Error('no LLM service is available for the Thread digest')
    const timeout = AbortSignal.timeout(DIGEST_TIMEOUT_MS)
    const linked = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    const { system, messages } = buildDigestMessages({
      ...(history.task === undefined ? {} : { taskStatus: awaitingReview ? `${history.task.status} (awaiting Human acceptance)` : history.task.status }),
      messages: transcript,
    })
    const selection = this.digestModelSelection(request.workspaceId)
    const assembler = new BlockAssembler()
    try {
      for await (const chunk of llm.stream({
        provider: selection.provider,
        model: selection.model,
        messages: [...messages],
        system,
        maxTokens: DIGEST_MAX_TOKENS,
        signal: linked,
      })) assembler.push(chunk)
    } catch (error) {
      if (linked.aborted) throw new Error('digest call was cancelled or timed out')
      throw error
    }
    // A cancelled call never produces a digest, even when a mock or lenient
    // adapter ignored the signal and streamed to completion.
    if (linked.aborted) throw new Error('digest call was cancelled or timed out')
    const finish = assembler.finish
    if (finish.kind === 'error' || finish.kind === 'aborted') throw new LlmError(finish.failure.message, finish.failure.code, finish.failure)
    if (finish.kind === 'max-tokens') throw new Error('digest reply was truncated at the token cap')
    const text = assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('')
    const parsed = parseThreadDigest(text)
    const digest: AgentTeamThreadDigest = Object.freeze({
      summary: parsed.summary,
      keyPoints: parsed.keyPoints,
      needsHumanDecision: parsed.needsHumanDecision || awaitingReview,
      ...(parsed.decisionQuestion === undefined ? {} : { decisionQuestion: parsed.decisionQuestion }),
      ...(parsed.options === undefined ? {} : { options: parsed.options }),
      ...(parsed.optionSelection === undefined ? {} : { optionSelection: parsed.optionSelection }),
    })
    return Object.freeze({ digest, modelUsed: selection, revision: history.thread.revision })
  }

  /**
   * Model route for Team semantic processing (the Thread digest today): the
   * Workspace's enabled designated leader speaks for the Team, so its pinned
   * model runs the call — a leader without a pinned model effectively holds
   * the Host default, so the Host default is used. With no designated leader,
   * the first enabled Workspace Member that pinned a model interprets through
   * that Team-configured LLM; only when nobody pinned one does the call fall
   * back to the Host default route. Pure read-side routing: it never writes
   * Member facts and never wakes anyone.
   */
  private digestModelSelection(workspaceId: WorkspaceId): AgentTeamModelSelection {
    const ledger = this.requireLedger()
    const members = ledger.listMembers().filter(member =>
      member.state === 'enabled' && ledger.workspacesOf(member.memberId).includes(workspaceId))
    const hostDefault = () => this.ctx.agentDefaultModel.currentSelection()
    const leader = members.find(member => member.leader === true)
    if (leader !== undefined) return leader.model ?? hostDefault()
    const pinned = members.find(member => member.model !== undefined)
    return pinned?.model ?? hostDefault()
  }

  /** Return the existing bounded public Workspace discovery projection. */
  @Remote('view')
  view(request: AgentTeamViewRequest): AgentTeamView {
    this.requireWorkspace(request.workspaceId)
    return this.requireLedger().view(request)
  }

  /** Agent-only top-level Thread start. Workspace identity is verified against the live binding. */
  async sendMessageForAgent(agent: Agent, request: AgentTeamSendMessageRequest): Promise<AgentTeamSendMessageResult> {
    return this.sendMessageAs(this.memberCall(agent, request.workspaceId), request)
  }

  /** Agent-only existing-Thread reply. */
  async replyForAgent(agent: Agent, request: AgentTeamReplyRequest): Promise<AgentTeamReplyResult> {
    return this.replyAs(this.memberCall(agent, request.workspaceId), request)
  }

  /** Agent-only personal Attention change. */
  async changeAttentionForAgent(agent: Agent, request: AgentTeamThreadAttentionRequest): Promise<AgentTeamThreadAttentionResult> {
    const actor = this.memberCall(agent, request.workspaceId)
    const result = await this.requireLedger().changeAttention({ ...request, actor })
    if (result.committed) this.emitCommitted(result.value.receipt)
    return result.value
  }

  attentionStatusForAgent(agent: Agent, request: { workspaceId: AgentTeamViewRequest['workspaceId']; threadRef?: AgentTeamThreadAttentionRequest['threadRef'] | undefined; taskRef?: AgentTeamTask['taskRef'] | undefined }): AgentTeamThreadAttentionStatus {
    const actor = this.memberActor(agent)
    this.requireAgentWorkspace(actor, request.workspaceId)
    return this.requireLedger().attentionStatus(actor, request)
  }

  /** Agent-only Claim mutation. */
  async changeClaimForAgent(agent: Agent, request: AgentTeamClaimRequest): Promise<AgentTeamClaimResult> {
    const actor = this.memberCall(agent, request.workspaceId)
    const result = await this.requireLedger().changeClaim({ ...request, actor })
    this.emitCommittedOutcome(result)
    // The claim boundary of a fresh-start Member: the reset schedules behind
    // the Member's own running turn and renews at its idle boundary.
    if (request.action === 'claim' && result.committed) this.scheduleFreshStartReset(actor.memberId)
    // The same task-start boundary sweeps auto-prune candidates for an
    // opted-in Member; the switch-off default never schedules.
    if (request.action === 'claim' && result.committed) this.scheduleAutoPruneSweep(actor.memberId)
    return result.value
  }

  listClaimsForAgent(agent: Agent, request: { workspaceId: AgentTeamViewRequest['workspaceId']; taskRef: AgentTeamTask['taskRef'] }): AgentTeamClaimList {
    const actor = this.memberActor(agent)
    this.requireAgentWorkspace(actor, request.workspaceId)
    return this.requireLedger().listClaims(actor, request)
  }

  inboxForAgent(agent: Agent, request: { readonly workspaceId?: WorkspaceId; readonly limit?: number }): AgentTeamInbox {
    const actor = this.memberActor(agent)
    if (request.workspaceId === undefined) return this.requireLedger().memberInbox(actor, request)
    this.requireAgentWorkspace(actor, request.workspaceId)
    return this.requireLedger().inbox(actor, { ...request, workspaceId: request.workspaceId })
  }

  async readThreadForAgent(agent: Agent, request: AgentTeamThreadReadRequest): Promise<AgentTeamThreadReadResult> {
    const actor = this.memberCall(agent, request.workspaceId)
    const result = await this.requireLedger().readThread({ ...request, actor })
    // A read that made no progress commits no operation and carries no receipt.
    const receipt = result.committed ? result.value.receipt : undefined
    if (receipt !== undefined) this.emitCommitted(receipt)
    const value = result.value
    // Private read-time enrich: an acceptance the reader just acknowledged is
    // a natural Task boundary, so the Host prices the reader's context once,
    // after the durable read has committed. Never a ledger fact, never
    // persisted, and a measurement failure degrades to an explicit
    // `unavailable` — the committed read is never reversed.
    const advice = await this.acceptanceContextAdvice(agent, value)
    return advice === undefined ? value : Object.freeze({ ...value, contextAdvice: advice })
  }

  /**
   * Context advice for one acceptance acknowledged by this read: only when
   * the read carried an unread accept activity AND the Task is still done.
   * Repeat reads (nothing unread), history-style reads, and reopened Tasks
   * carry no advice — the acceptance no longer stands.
   */
  private async acceptanceContextAdvice(agent: Agent, read: AgentTeamThreadReadResult): Promise<AgentTeamContextAdvice | undefined> {
    if (read.task === undefined || read.task.resolution !== 'accepted' || read.task.status !== 'done') return undefined
    const acknowledgedAccept = read.facts.some(entry => entry.unread && entry.fact.kind === 'activity'
      && entry.fact.activity.kind === 'accept')
    if (!acknowledgedAccept) return undefined
    const advice = await this.contextAdviceFor(agent)
    if (advice.action === 'unavailable') return advice
    // A closing Task is the natural moment for the pre-completion analysis:
    // the private advice carries the pending-interrupt count so the Member
    // sees what it owes itself, beside the context verdict it already reads.
    const memberId = this.memberForAgent(agent)?.memberId
    const pendingInterrupts = memberId === undefined ? 0 : this.requireLedger().pendingInterruptsForMember(memberId).length
    if (pendingInterrupts === 0) return advice
    return Object.freeze({
      ...advice,
      pendingInterrupts,
      guidance: `${advice.guidance} You have ${pendingInterrupts} pending interrupted session(s): before closing, run the pre-completion analysis — post this work's completion report first, then context_interrupt list and resume the newest restorable entry with a context_rollover citing its exact anchor ref, or release it if it no longer needs returning.`,
    })
  }

  /** Price the reading Member's context against its current route's budgets. */
  private async contextAdviceFor(agent: Agent): Promise<AgentTeamContextAdvice> {
    try {
      const limits = await this.routeLimitsForAgent(agent)
      if (limits === undefined) return this.unavailableAdvice()
      const taskBoundaryThreshold = Math.floor(limits.handoffAt * CONTEXT_ACCEPT_ADVICE_OF_HANDOFF)
      if (limits.usageTokens >= limits.handoffAt) {
        return Object.freeze({ usageTokens: limits.usageTokens, taskBoundaryThreshold, handoffAt: limits.handoffAt, hardLimit: limits.hardLimit,
          action: 'handoff-now',
          guidance: 'You are at or above the handoff budget. Finish the current atomic action and unsettled evidence, then call context_rollover with a fresh handoff now.' })
      }
      if (limits.usageTokens >= taskBoundaryThreshold) {
        // A fresh-start Member is renewed automatically when its next task is
        // assigned, so advising a rollover now would only erase the completion
        // summary the Human still reads from the live Session. Keep the
        // context; the next assignment is the boundary.
        if (this.memberForAgent(agent)?.contextStartPolicy === 'fresh') {
          return Object.freeze({ usageTokens: limits.usageTokens, taskBoundaryThreshold, handoffAt: limits.handoffAt, hardLimit: limits.hardLimit,
            action: 'keep',
            guidance: 'Keep the current context: your fresh-start Task policy renews the Session automatically when your next task is assigned, so rolling over now would only erase your completion summary from the live log. Do not rollover just because this Task was accepted.' })
        }
        return Object.freeze({ usageTokens: limits.usageTokens, taskBoundaryThreshold, handoffAt: limits.handoffAt, hardLimit: limits.hardLimit,
          action: 'rollover',
          guidance: 'Finish the acceptance closeout, persist only durable reusable conclusions, collect or stop jobs, then call context_rollover with a fresh handoff covering every other active Claim. Do not return to an old checkpoint solely because this Task was accepted.' })
      }
      return Object.freeze({ usageTokens: limits.usageTokens, taskBoundaryThreshold, handoffAt: limits.handoffAt, hardLimit: limits.hardLimit,
        action: 'keep',
        guidance: 'Keep the current context for possible acceptance follow-up. This acceptance is already a timeline boundary; do not create a redundant checkpoint. Record a checkpoint only before the next noisy or risky phase.' })
    } catch {
      // Any measurement failure degrades explicitly; the read stays durable.
      return this.unavailableAdvice()
    }
  }

  private unavailableAdvice(): AgentTeamContextAdvice {
    return Object.freeze({ usageTokens: undefined, taskBoundaryThreshold: undefined, handoffAt: undefined, hardLimit: undefined,
      action: 'unavailable',
      guidance: 'Context usage could not be measured for this acceptance; manage context by your existing pressure policy.' })
  }

  /**
   * What the supervision pass reads about one fellow Member, surfaced to any
   * enabled Member through the team_supervise tool: the pass state, presence,
   * the recorded failure diagnostic, and the windowed failure count the policy
   * acts on. Read-only — no ledger operation, no mutation.
   */
  supervisionStatusForAgent(agent: Agent, request: { readonly workspaceId: WorkspaceId; readonly memberId: AgentTeamMemberId }): AgentTeamSupervisionStatus {
    this.memberCall(agent, request.workspaceId)
    const ledger = this.requireLedger()
    const member = ledger.getMember(request.memberId)
    if (member === undefined || !ledger.participatesIn(request.memberId, request.workspaceId)) throw new Error(`unknown Member '${request.memberId}' in workspace '${request.workspaceId}'`)
    const status = this.memberStatus(member)
    const failures = this.memberFailures.get(request.memberId)
    const diagnostic = failures?.runtime?.message ?? failures?.compaction?.message ?? failures?.activation?.detail
    return Object.freeze({
      memberId: member.memberId,
      handle: member.handle,
      state: this.supervisionStateOf(request.memberId),
      presence: status.presence,
      ...(diagnostic === undefined ? {} : { diagnostic }),
      recentFailureCount: this.supervisor.recentFailureCount(request.memberId, SUPERVISION_FAILURE_WINDOW_MS),
      failureWindowMinutes: Math.round(SUPERVISION_FAILURE_WINDOW_MS / 60_000),
    })
  }

  /**
   * A teammate's forced context reset of one abnormal fellow Member — the same
   * fresh-context renewal the Human menu's reset row performs. The caller must
   * be an enabled Member of the Workspace, the target must be enabled and read
   * abnormal to supervision (stopped, erroring, failing repeatedly, or hung),
   * and a Member cannot reset itself. A hung target is by definition still
   * running, so — unlike the Human remote — this path retires a live generation
   * without an idle refusal; disposal aborts the wedged turn.
   */
  async resetMemberForAgent(agent: Agent, request: AgentTeamResetMemberRequest): Promise<AgentTeamResetMemberResult> {
    const actor = this.memberCall(agent, request.workspaceId)
    const ledger = this.requireLedger()
    const target = ledger.getMember(request.memberId)
    if (target === undefined || !ledger.participatesIn(request.memberId, request.workspaceId)) throw new Error(`unknown Member '${request.memberId}' in workspace '${request.workspaceId}'`)
    if (target.memberId === actor.memberId) throw new Error(`Agent Member '${target.handle}' cannot reset its own context through team_supervise`)
    if (target.state !== 'enabled') throw new Error(`Agent Member '${target.handle}' is ${target.state}; only enabled Members can be reset`)
    if (this.supervisionStateOf(request.memberId) === 'healthy') throw new Error(`Agent Member '${target.handle}' reads healthy; supervision resets only abnormal Members`)
    this.ctx.logger.warn(`agent-team: member '${actor.handle}' reset abnormal member '${target.handle}' through team supervision`)
    await this.enqueueLifecycle(async () => {
      this.requireAccepting()
      this.clearMemberFailure(request.memberId, 'runtime')
      this.clearMemberFailure(request.memberId, 'compaction')
      await this.renewMemberContextNow(request.memberId, request.requestId, 'teammate')
    })
    return Object.freeze({ status: this.memberStatus(this.requireLedger().getMember(request.memberId)!) })
  }

  /**
   * Agent-only direct message: append the audit-only dm-sent operation, then
   * inject the body into the recipient's live session. The ledger commit is
   * the durable fact; the injection is a transient runtime effect, so a
   * missing handle or a failed wake returns a structured delivery error while
   * the recorded DM stays durable for the recipient's recovery path.
   */
  async dmForAgent(agent: Agent, request: AgentTeamDmRequest): Promise<AgentTeamDmResult> {
    const actor = this.memberCall(agent, request.workspaceId)
    const result = await this.requireLedger().sendDm({ ...request, actor })
    if (!result.committed) return result.value
    this.emitCommitted(result.value.receipt)
    const recipient = result.value.recipient
    const handle = this.handles.get(recipient.memberId)
    if (handle === undefined) {
      throw new AgentTeamDmDeliveryError(recipient.memberId, recipient.handle, `DM recorded but not delivered: Agent Member '${recipient.handle}' has no live session; it will find the message in its DM history after recovery`)
    }
    try {
      const message = createUserMessage({
        content: [{ type: 'text', text: this.dmRelayText(agent, recipient, request.body.trim(), result.value.receipt.occurredAt, result.value.receipt.operationId, request.workspaceId) }],
        source: { kind: AGENT_TEAM_PLUGIN_ID, form: 'relay' },
      })
      // An idle recipient gets one ordinary turn; a busy one is steered into
      // its current turn — the same wake split subagent continuations use.
      if (handle.agent.status === 'idle') handle.agent.followup(message)
      else handle.agent.steer(message)
    } catch (error) {
      throw new AgentTeamDmDeliveryError(recipient.memberId, recipient.handle, `DM recorded but not delivered: ${error instanceof Error ? error.message : String(error)}`)
    }
    return result.value
  }

  /** Relay body: the DM itself plus one bounded line of adjacent context. */
  private dmRelayText(senderAgent: Agent, recipient: AgentTeamAgentMember, body: string, occurredAt: string, excluding: AgentTeamOperationId, workspaceId: WorkspaceId): string {
    const sender = this.memberForAgent(senderAgent)
    const prior = this.requireLedger().dmHistoryBetween(senderAgent.id, recipient.memberId, excluding)
    const header = `Direct message from @${sender?.handle ?? 'a Team Member'} at ${formatTeamTimestamp(occurredAt)}:`
    const context = prior === undefined ? '' : `\n\n[most recent prior DM between you: ${prior}]`
    return `${header}\nWorkspace: ${workspaceId}\n\n${body}${context}`
  }

  /**
   * One sampled observation of a watched Member for the leader's watch: the
   * same supervision state and presence team_supervise reports, plus the watch's
   * own measurements (context price, completed turns, held Tasks). Read-only —
   * sampling never writes a ledger operation; only the notice is a Team fact.
   */
  private async watchSampleOf(memberId: AgentTeamMemberId, workspaceId: WorkspaceId): Promise<MemberWatchSample | undefined> {
    const ledger = this.requireLedger()
    const member = ledger.getMember(memberId)
    if (member === undefined || !ledger.participatesIn(memberId, workspaceId)) return undefined
    const status = this.memberStatus(member)
    const failures = this.memberFailures.get(memberId)
    const diagnostic = failures?.runtime?.message ?? failures?.compaction?.message ?? failures?.activation?.detail
    const handle = this.handles.get(memberId)
    let contextTokens: number | undefined
    let contextWindow: number | undefined
    let turns = 0
    if (handle !== undefined) {
      // Measurement is best effort: an unreadable meter degrades the sample to
      // the supervision fields instead of dropping the whole observation.
      try {
        const limits = await this.routeLimitsForAgent(handle.agent)
        contextTokens = limits?.usageTokens
        contextWindow = limits?.contextWindow
      } catch { /* an unmeasurable route still reports state and tasks */ }
      try {
        turns = await this.memberTurns(handle)
      } catch { turns = 0 }
    }
    const queue = ledger.memberTasksForWorkspace({ workspaceId }).queues.find(entry => entry.memberId === memberId)
    const tasks: readonly MemberWatchTask[] = Object.freeze((queue?.current ?? []).map(row => Object.freeze({
      taskRef: row.taskRef, ...(row.taskNumber === undefined ? {} : { taskNumber: row.taskNumber }), status: row.status, subject: row.subject,
    })))
    return Object.freeze({
      state: this.supervisionStateOf(memberId),
      presence: status.presence,
      ...(diagnostic === undefined ? {} : { diagnostic }),
      ...(contextTokens === undefined ? {} : { contextTokens }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      turns, tasks,
    })
  }

  /**
   * Deliver one watch notice to the watching leader as an ordinary Team
   * Assistant Message in the leader's own Channel, so the observation lands in
   * the leader's Inbox and Thread like every other Team fact. A leader without
   * a Channel is a delivery failure the pass logs and retries; the watch itself
   * stays durable.
   */
  private async notifyLeaderOfWatch(notice: MemberWatchNotice): Promise<void> {
    const channelRef = this.requireLedger().channelsForMember(notice.leaderMemberId, notice.workspaceId)[0]
    if (channelRef === undefined) throw new Error(`leader '${notice.leaderHandle}' has no Channel in workspace '${notice.workspaceId}'`)
    await this.sendMessageAs(agentTeamAssistantActor(), {
      requestId: randomUUID() as AgentTeamRequestId,
      workspaceId: notice.workspaceId,
      channelRef,
      body: memberWatchNoticeText(notice),
      recipients: [notice.leaderMemberId],
      asTask: false,
    })
  }

  /**
   * The leader's standing watch: place or retune one watch over a fellow
   * Member. Only the Workspace leader may watch (the ledger enforces it), and
   * the watch is durable — a restart re-reads it.
   */
  async watchMemberForAgent(agent: Agent, request: AgentTeamWatchMemberRequest): Promise<AgentTeamWatchMemberResult> {
    const actor = this.memberCall(agent, request.workspaceId)
    const result = await this.requireLedger().watchMember({ ...request, actor })
    if (result.committed) this.emitCommitted(result.value.receipt)
    return result.value
  }

  /** Cancel one of the caller's own watches; the ledger rejects any other leader's. */
  async unwatchMemberForAgent(agent: Agent, request: AgentTeamUnwatchMemberRequest): Promise<AgentTeamUnwatchMemberResult> {
    const actor = this.memberCall(agent, request.workspaceId)
    const result = await this.requireLedger().unwatchMember({ ...request, actor })
    if (result.committed) this.emitCommitted(result.value.receipt)
    return result.value
  }

  /** The caller's own watches, newest first — the read the tool lists. */
  memberWatchesForAgent(agent: Agent, request: { readonly workspaceId: WorkspaceId }): readonly AgentTeamMemberWatch[] {
    const actor = this.memberCall(agent, request.workspaceId)
    return this.requireLedger().watchesForLeader(actor.memberId, request.workspaceId)
  }

  /**
   * One on-demand sample of a watched Member: the same read the periodic pass
   * performs, so a leader can look now instead of waiting for the cadence.
   * Refuses a Member the caller does not watch.
   */
  async memberWatchSnapshotForAgent(agent: Agent, request: { readonly workspaceId: WorkspaceId; readonly memberId: AgentTeamMemberId }): Promise<AgentTeamMemberWatchSnapshot> {
    const actor = this.memberCall(agent, request.workspaceId)
    const ledger = this.requireLedger()
    const watch = ledger.watchesForLeader(actor.memberId, request.workspaceId).find(entry => entry.memberId === request.memberId)
    if (watch === undefined) throw new Error(`you are not watching Member '${request.memberId}' in workspace '${request.workspaceId}'`)
    const member = ledger.getMember(request.memberId)
    if (member === undefined) throw new Error(`unknown Member '${request.memberId}' in workspace '${request.workspaceId}'`)
    const sample = await this.watchSampleOf(request.memberId, request.workspaceId)
    if (sample === undefined) throw new Error(`Member '${member.handle}' is not readable in workspace '${request.workspaceId}'`)
    // The state age is the age of the state the pass last sampled, so "stopped
    // for five minutes" survives a change of state; before the first sample of
    // this process the durable watch start is the leader's own frame for it.
    const since = Date.parse(watch.startedAt)
    const stateMinutes = this.memberWatch.sampledStateMinutes(watch.watchRef)
      ?? (Number.isNaN(since) ? 0 : Math.max(0, Math.floor((Date.now() - since) / 60_000)))
    return Object.freeze({
      watchRef: watch.watchRef,
      memberId: watch.memberId,
      handle: member.handle,
      state: sample.state,
      presence: sample.presence,
      ...(sample.diagnostic === undefined ? {} : { diagnostic: sample.diagnostic }),
      stateMinutes,
      ...(sample.contextTokens === undefined ? {} : { contextTokens: sample.contextTokens }),
      ...(sample.contextWindow === undefined ? {} : { contextWindow: sample.contextWindow }),
      turns: sample.turns,
      tasks: Object.freeze(ledger.memberTasksForWorkspace({ workspaceId: request.workspaceId }).queues.find(entry => entry.memberId === request.memberId)?.current ?? []),
      intervalMinutes: watch.intervalMinutes,
      stalledMinutes: watch.stalledMinutes,
      startedSequence: watch.startedSequence,
      startedAt: watch.startedAt,
    })
  }

  /**
   * Run one watch pass now: the periodic timer calls this, and a test or an
   * operator can drive it with a chosen clock.
   */
  runMemberWatchPass(now?: number): Promise<void> {
    return this.memberWatch.runPass(now)
  }

  threadHistoryForAgent(agent: Agent, request: AgentTeamThreadHistoryRequest): AgentTeamThreadHistory {
    const actor = this.memberActor(agent)
    this.requireAgentWorkspace(actor, request.workspaceId)
    return this.requireLedger().threadHistory(actor, request)
  }

  /** Live participation addresses; paths remain owned by the Harness registry. */
  workspacesForAgent(agent: Agent): readonly { readonly workspaceId: WorkspaceId; readonly path: string | undefined; readonly default: boolean }[] {
    const actor = this.memberActor(agent)
    const member = this.requireLedger().getMember(actor.memberId)!
    return Object.freeze(this.requireLedger().workspacesOf(actor.memberId).map(workspaceId => Object.freeze({
      workspaceId, path: this.ctx.workspaceRegistry.get(workspaceId)?.path, default: workspaceId === member.workspaceId,
    })))
  }

  /** Agent-only bounded discovery projection; participation list carries registry titles when known. */
  viewForAgent(agent: Agent, request: AgentTeamViewRequest): AgentTeamView {
    const member = this.memberForAgent(agent)
    if (member === undefined) throw new Error('Agent is not an active Team Member')
    if (!this.requireLedger().participatesIn(member.memberId, request.workspaceId)) throw new Error('Member cannot view another Workspace')
    const view = this.requireLedger().view(request, member.memberId)
    return Object.freeze({ ...view, workspaces: Object.freeze(view.workspaces.map(participation => {
      const title = this.ctx.workspaceRegistry.get(participation.workspaceId)?.title
      return title === undefined ? participation : Object.freeze({ ...participation, title })
    })) })
  }

  /** Validate the durable ledger against an independently replayed projection. */
  validateLedger(): void {
    this.requireLedger().validate()
  }

  /**
   * Validate the durable ledger for the invariant's mount check. The
   * constructor already re-derived every durable record against its own
   * scratch projection, so this adopts that conclusion once while nothing has
   * committed since; every other call, and every commit-driven validation,
   * replays the whole table again.
   */
  validateLedgerAtMount(): void {
    this.requireLedger().validateAtMount()
  }

  /**
   * Budget + measurement for one Member's CURRENT routed selection — the
   * member-pinned model or the default selection, resolved through the LLM
   * service so a route change is honored at the next on-demand read. The budget
   * is priced from the route's OWN model information — context window plus the
   * adapter's default per-request output cap — through
   * {@link deriveContextPressureBudget}; a last persisted `request/context`
   * event still supplies the window when the resolution discloses none. This
   * pricing is passive: it feeds only the acceptance advice, the context
   * timeline, and the checkpoint-return guard, never a request decision —
   * a selection whose capacity cannot be resolved simply degrades those
   * surfaces to their unavailable or fallback presentations.
   */
  private async routeLimitsForAgent(agent: Agent): Promise<{ readonly usageTokens: number; readonly hardLimit: number; readonly handoffAt: number; readonly contextWindow: number } | undefined> {
    const member = this.memberForAgent(agent)
    if (member === undefined) return undefined
    // The pressure budget must match the route the CURRENT step actually
    // uses: the live selection ref's `assembled` capture when the step has
    // entered prompt assembly, its `current` selection otherwise. Re-deriving
    // from the ledger or the Host default would race a concurrent default
    // change or live model edit and split the budget from the real route.
    const ref = this.modelSelections.get(member.memberId)
    const selection = ref?.assembled ?? ref?.current ?? member.model ?? this.ctx.agentDefaultModel.currentSelection()
    const meter = agent.ctx.get('tokenMeter')
    const usageTokens = meter?.measure(agent.session)?.totalTokens
    if (usageTokens === undefined) return undefined
    const routeInfo = await this.resolvedRouteInfo(selection)
    let contextWindow = routeInfo?.contextWindow
    if (contextWindow === undefined) {
      const persisted = agent.session.requestContext()
      if (persisted?.provider === selection.provider && persisted.model === selection.model) {
        contextWindow = persisted.contextWindow
      }
    }
    if (contextWindow === undefined) return undefined
    // A Member's durable window override caps — never raises — the routed
    // model's capacity; the LLM route cannot be widened from Team settings.
    const effectiveWindow = member.contextWindow === undefined ? contextWindow : Math.min(member.contextWindow, contextWindow)
    // The override narrows the priced window itself, so the route's output
    // reserve applies against the narrowed budget exactly as against the bare
    // route — an override below the reserve floors to a zero budget.
    const { hardLimit, handoffAt } = deriveContextPressureBudget(effectiveWindow, routeInfo?.defaultMaxTokens)
    return { usageTokens, hardLimit, handoffAt, contextWindow: effectiveWindow }
  }

  /**
   * Cache of resolved model information per provider/model; unknown stays
   * unknown, and a route resolved without a disclosed field stays without it.
   */
  private readonly routeInfos = new Map<string, { readonly contextWindow?: number; readonly defaultMaxTokens?: number } | undefined>()

  /**
   * Resolve one selection's provider-owned model information — the context
   * window and the default per-request output cap that prices the pressure
   * budget — cached per route (one directory round-trip per route per
   * process). The LLM service is resolved lazily (not a hard inject): the
   * Host mounts it in every production shape, while ledger-level fixtures
   * provide only the services the Team service itself owns. A missing or
   * throwing resolution is an unknown route — the pressure policy fails
   * closed on it.
   */
  private async resolvedRouteInfo(selection: { readonly provider: string; readonly model: string }): Promise<{ readonly contextWindow?: number; readonly defaultMaxTokens?: number } | undefined> {
    const key = `${selection.provider}::${selection.model}`
    if (this.routeInfos.has(key)) return this.routeInfos.get(key)
    let info: { readonly contextWindow?: number; readonly defaultMaxTokens?: number } | undefined
    try {
      const llm = this.ctx.get('llm')
      const modelInfo = llm === undefined ? undefined : await llm.resolveModelInfo(selection.provider, selection.model)
      if (modelInfo !== undefined) {
        info = Object.freeze({
          ...(modelInfo.context?.contextWindow === undefined ? {} : { contextWindow: modelInfo.context.contextWindow }),
          ...(modelInfo.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: modelInfo.defaultMaxTokens }),
        })
      }
    } catch {
      info = undefined
    }
    this.routeInfos.set(key, info)
    return info
  }

  /**
   * Resolve one checkpoint ref to its exact seed prefix before any rollover
   * commit. The walk covers the current generation (own events) and archived
   * ancestors through `sessionPersistence`; the same projection definition
   * folds every source. Guards fail closed: unresolved, foreign-lineage,
   * open-turn, or nonshrinking targets reject without any lifecycle effect.
   */
  private async resolveCheckpointSeed(memberId: AgentTeamMemberId, agent: Agent, checkpointRef: AgentTeamContextCheckpointRef): Promise<CheckpointSeed> {
    let sessionId: SessionId | undefined = agent.session.id
    let live = true
    let guard = 0
    while (sessionId !== undefined && guard++ <= MAX_TIMELINE_ANCESTORS) {
      let events: readonly SessionEvent[]
      let inheritedEventCount: SessionLogOffset
      let parentSession: SessionId | undefined
      // Capture this iteration's source identity BEFORE the branch advances
      // the lineage flag: the measurement call below keys on it.
      const sourceIsCurrent = live
      if (live) {
        events = agent.session.snapshotEvents()
        inheritedEventCount = agent.session.inheritedEventCount
        parentSession = agent.session.header.parentSession
        live = false
      } else {
        const read = await this.sessionReader.read(sessionId)
        if (!read.ok) {
          throw new StoredSessionReadError(`checkpoint '${checkpointRef}' could not be resolved: its source Session is unreadable (${read.failure.kind}: ${read.failure.detail})`, read.failure)
        }
        events = read.inspection.events
        inheritedEventCount = read.inspection.inheritedEventCount
        parentSession = read.inspection.header.parentSession
      }
      // Fold the source with its inherited cut respected: inherited events
      // are resolved history in that source, never fresh intent; checkpoints
      // recorded in this source's own span are the selectable targets.
      const state = foldTeamContextProjection(events, { sessionId, inheritedEventCount }, this.contextProjectionHost)
      // A Team-boundary default checkpoint: the boundary's completed-turn
      // anchor is the seed cut, and it is selectable exactly when one
      // Thread's facts entered the context through it — the same proof the
      // timeline requires, revalidated here because the model may cite a
      // boundary the timeline never surfaced.
      const boundary = checkpointRef.startsWith('team-boundary-')
        ? boundaryByRef(state, checkpointRef)
        : undefined
      const entry = checkpointByRef(state, checkpointRef)
      const anchorTurnEndSeq = boundary !== undefined ? boundary.turnEndSeq : entry?.turnEndSeq
      if (anchorTurnEndSeq !== undefined && anchorTurnEndSeq !== -1) {
        if (boundary !== undefined && boundary.kind !== 'team-boundary') {
          throw new Error(`checkpoint '${checkpointRef}' is not a restorable boundary`)
        }
        // The seed is the exact contiguous prefix through the anchor's
        // completed turn end. Balanced by construction — the turn ended.
        const throughSeq = anchorTurnEndSeq + 1
        const prefix = events.slice(0, throughSeq)
        if (boundary !== undefined) {
          // The seed must stay inside one Thread's context: the retained
          // prefix through the anchor holds exactly one Thread's facts, read
          // from the fold's own boundary attributions — the same accumulated
          // set the timeline shows, so a ref the timeline offered is never
          // refused here for a reason it did not state.
          const threads = retainedTopicsThrough(state, anchorTurnEndSeq)
          if (threads.length !== 1) {
            throw new Error(threads.length === 0
              ? `boundary '${checkpointRef}' has no single attributable Thread; write a fresh handoff instead`
              : `boundary '${checkpointRef}' spans multiple Threads; write a fresh handoff instead`)
          }
        }
        // Nonshrinking guard, priced by the SAME source-replayed measurement
        // the timeline shows: the seed's retained cost is the SOURCE's own
        // token count scaled by the anchor share — a small current generation
        // never disguises a large ancestor seed. An unmeasurable source fails
        // closed: pricing the unknown as zero would wave an oversized seed
        // through.
        const limits = await this.routeLimitsForAgent(agent)
        // A route whose live budget cannot be priced is priced as the
        // conservative fallback, never as the old fixed 200K cap that would
        // wave a seed through on a narrower route.
        const handoffAt = limits?.handoffAt ?? FALLBACK_PRESSURE_BUDGET.handoffAt
        const sourceUsage = await this.sourceUsageTokens(sessionId, sourceIsCurrent, agent)
        if (sourceUsage === undefined) {
          throw new Error(`checkpoint '${checkpointRef}' could not be priced: its source Session's context cost cannot be measured; write a fresh handoff instead`)
        }
        const retained = this.retainedEstimate(sourceUsage, events.length, anchorTurnEndSeq)
        if (prefix.length >= events.length) {
          throw new Error('checkpoint return does not shrink the working set; use a fresh handoff instead')
        }
        if (retained >= handoffAt) {
          throw new Error('checkpoint return would retain a context at or above the handoff budget; use a fresh handoff instead')
        }
        // Single-Thread coverage guard: with more than one active Claim the
        // Host cannot prove a rewind stays inside one Thread's context.
        // The exception is an interrupt-pinned anchor: the pinned entry IS
        // the Member's declared return to exactly this context, so the
        // stack — not the heuristic — vouches for the rewind's scope.
        const interruptPinned = this.requireLedger().pendingInterruptForCheckpoint(memberId, checkpointRef) !== undefined
        if (!interruptPinned && this.requireLedger().activeClaimCountForMember(memberId) > 1) {
          throw new Error('multiple active Claims: write a fresh handoff covering all of them instead of returning to a checkpoint')
        }
        return { checkpointRef, sourceSessionId: sessionId, sourceThroughSeq: SessionLogOffset(throughSeq), prefix }
      }
      sessionId = parentSession
    }
    throw new Error(`checkpoint '${checkpointRef}' does not resolve in this Member's lineage`)
  }

  /**
   * Rebuild the handoff for a Member whose rollover committed but whose new
   * Session activated without the handoff delivery (a crash between the
   * ledger commit and the swap's delivery step). The previous Session —
   * recorded in the operation, mirrored by the lineage parent, and available
   * from the ledger even when the new Session's own header never carried it —
   * holds the durable intent; fold it cold and deliver the same handoff
   * envelope first. Idempotent: once any handoff exists in the new Session's
   * own log this never runs.
   */
  private async reconstructMissingHandoff(member: AgentTeamAgentMember, agent: Agent): Promise<void> {
    const previousSessionId = agent.session.header.parentSession
      ?? this.requireLedger().previousSessionForMember(member.memberId)
    if (previousSessionId === undefined) return
    const previousRead = await this.sessionReader.read(previousSessionId)
    if (!previousRead.ok) {
      // Best-effort recovery: the handoff intent stays lost with the
      // unreadable previous Session, but the Member still activates.
      const failure = previousRead.failure
      this.ctx.logger.warn(`agent-team: rollover handoff reconstruction could not read the previous Session '${previousSessionId}' (${failure.kind}): ${failure.detail}`)
      return
    }
    const inspection = previousRead.inspection
    const state = foldTeamContextProjection(
      inspection.events,
      { sessionId: previousSessionId, inheritedEventCount: inspection.inheritedEventCount },
      this.contextProjectionHost,
    )
    if (state.pending === null) return
    const pending = state.pending
    const message = TEAM_CONTEXT_CODEC.createHandoffMessage({
      handoff: pending.handoff,
      previousSessionId,
      newSessionId: agent.session.id,
      trigger: 'model',
      handoffEventSeq: pending.resultSeq as never,
      ...(pending.checkpointRef === undefined ? {} : { checkpointRef: pending.checkpointRef }),
      ...(pending.relatedFiles.length === 0 ? {} : { relatedFiles: pending.relatedFiles }),
    })
    agent.steer(message)
    this.ctx.logger.info(`agent-team: reconstructed the rollover handoff for member '${this.memberLabel(member.memberId)}' from the previous Session '${previousSessionId}'`)
  }

  /**
   * Resolve the exact recorded seed prefix of one committed checkpoint
   * return for crash recovery: cold-read the recorded source Session, take
   * the contiguous prefix of the recorded exclusive length, and verify the
   * source's own fold still resolves the recorded anchor there — an explicit
   * checkpoint through `checkpointByRef`, or a default Team boundary whose
   * recorded ref appears among the source's own boundary keys.
   * Fail-closed by contract: an unreadable source or an unprovable anchor
   * REJECTS the activation — a committed checkpoint return may never
   * downgrade to a blank child.
   */
  private async recordedCheckpointPrefix(seed: { readonly sourceSessionId: SessionId; readonly sourceThroughSeq: SessionLogOffset; readonly checkpointRef: AgentTeamContextCheckpointRef }): Promise<{ readonly prefix: readonly SessionEvent[] }> {
    const seedRead = await this.sessionReader.read(seed.sourceSessionId)
    if (!seedRead.ok) {
      const failure = seedRead.failure
      throw new StoredSessionReadError(`the recorded checkpoint-return seed source Session '${seed.sourceSessionId}' is unreadable (${failure.kind}): ${failure.detail}`, failure)
    }
    const inspection = seedRead.inspection
    const through = Number(seed.sourceThroughSeq)
    if (!Number.isSafeInteger(through) || through < 0 || through > inspection.events.length) {
      throw new Error(`the recorded checkpoint-return seed cut ${through} is not a valid prefix of Session '${seed.sourceSessionId}'`)
    }
    const state = foldTeamContextProjection(
      inspection.events,
      { sessionId: seed.sourceSessionId, inheritedEventCount: inspection.inheritedEventCount },
      this.contextProjectionHost,
    )
    const anchorProven = checkpointByRef(state, seed.checkpointRef) !== undefined
      || boundaryByRef(state, seed.checkpointRef) !== undefined
    if (!anchorProven) {
      throw new Error(`the recorded checkpoint-return anchor '${seed.checkpointRef}' no longer resolves in Session '${seed.sourceSessionId}'`)
    }
    return { prefix: inspection.events.slice(0, through) }
  }

  /**
   * Redeliver the old generation's unconsumed post-intent input to a
   * generation whose durable rollover committed but whose delivery did not
   * finish. Bound to the ledger's recorded transition target — the CURRENT
   * Session being that target — never to whether the handoff itself landed,
   * so a crash after the handoff but before the carried enqueue still
   * replays. The fold is the same durable truth the live transition uses
   * (unconsumed, non-Team, order preserved). Idempotency keys on what is
   * CURRENTLY present: delivered `user/message` ids plus the live inbox's
   * pending next-step/next-turn ids — a historical insert that was already
   * claimed (and removed) but never surfaced is NOT known and must replay.
   * Fail-closed for genuinely unreadable previous Sessions (missing/IO) so
   * the Member's input is never dropped silently, with three bounded
   * exceptions: a generation that already started its own turns needs no
   * replay (its carried input was delivered or superseded while it ran), a
   * log-corruption class error skips with a warning (the Host repairs torn
   * tails; a retired generation's corrupt log must not permanently block the
   * Member's activation), and a deterministic released-format refusal skips
   * with a warning (the candidate's own migration audit refuses that
   * artifact, so no retry can ever read it).
   */
  private async replayCarriedInput(member: AgentTeamAgentMember, agent: Agent, generationStarted: boolean): Promise<number> {
    const transition = this.requireLedger().lastTransitionForMember(member.memberId)
    if (transition === undefined || transition.targetSessionId !== agent.session.id) return 0
    // A generation that already started its own turns needs no previous-Session
    // replay: its carried input was delivered with the handoff (or superseded)
    // before any own turn could run. Skipping the inspect also keeps a later
    // corruption or loss of the retired Session from re-blocking this Member
    // on every restart of the current generation.
    if (generationStarted) {
      this.ctx.logger.info(`agent-team: skipping carried-input replay for member '${this.memberLabel(member.memberId)}': the current Session '${agent.session.id}' already started a generation`)
      return 0
    }
    let inspectionEvents: readonly SessionEvent[]
    let inspectionInherited: SessionLogOffset
    const previousRead = await this.sessionReader.read(transition.previousSessionId)
    if (!previousRead.ok) {
      const failure = previousRead.failure
      // Log-corruption class: bounded fail-open. The current Session's own
      // fold is intact and the Host repairs the retired log's torn tail; a
      // corrupted retired generation must not permanently block activation.
      if (failure.kind === 'corrupt') {
        this.ctx.logger.warn(`agent-team: previous Session '${transition.previousSessionId}' holding carried input for member '${this.memberLabel(member.memberId)}' is corrupt: ${failure.detail}; skipping the replay`)
        return 0
      }
      // Deterministic released-format refusal: the retired artifact is refused
      // by the candidate's own migration audit, which no retry can change.
      // Failing activation here would turn a data problem in a Session the
      // Member no longer runs in into permanent unavailability — the exact
      // failure class this hardening removes. Genuine IO and unknown failures
      // stay fail-closed so carried input is never dropped silently.
      if (failure.kind === 'refused') {
        this.ctx.logger.warn(`agent-team: previous Session '${transition.previousSessionId}' holding carried input for member '${this.memberLabel(member.memberId)}' is refused by the session-format migration: ${failure.detail}; skipping the replay`)
        return 0
      }
      throw new StoredSessionReadError(`the previous Session '${transition.previousSessionId}' holding the Member's carried input is unreadable (${failure.kind}): ${failure.detail}`, failure)
    }
    inspectionEvents = previousRead.inspection.events
    inspectionInherited = previousRead.inspection.inheritedEventCount
    const state = foldTeamContextProjection(
      inspectionEvents,
      { sessionId: transition.previousSessionId, inheritedEventCount: inspectionInherited },
      this.contextProjectionHost,
    )
    const carried = carriedInputOf(state, inspectionEvents)
    if (carried.length === 0) return 0
    const known = new Set<string>()
    for (const event of agent.session.ownEvents()) {
      if (event.type !== 'user/message') continue
      const id = (event.data as { id?: string }).id
      if (id !== undefined) known.add(id)
    }
    for (const pending of [...agent.inbox.nextStep, ...agent.inbox.nextTurn]) {
      known.add(pending.id)
    }
    let redelivered = 0
    for (const message of carried) {
      if (known.has(message.id)) continue
      agent.followup(message)
      redelivered += 1
    }
    if (redelivered > 0) this.ctx.logger.info(`agent-team: redelivered ${redelivered} carried input message(s) for member '${this.memberLabel(member.memberId)}' after the rollover crash recovery`)
    return redelivered
  }

  /**
   * Agent-only checkpoint request validation: the tool calls this inside its
   * own running turn. Like `context_rollover`, the tool performs no side effect —
   * the durable checkpoint is the successful `tool/call`+`tool/result` pair
   * the Session projection folds; the ref returned here is deterministic
   * from this Member Session's identity plus the tool call id, so the model
   * can cite it before the result exists and a repeated provider call id in
   * another generation never collides with this one.
   */
  recordCheckpointForAgent(agent: Agent, request: AgentTeamCheckpointToolRequest): AgentTeamCheckpointToolOutcome {
    const member = this.memberForAgent(agent)
    if (member === undefined || member.state !== 'enabled') throw new Error('context_checkpoint requires an active Team Member')
    if (this.runningAgents.has(agent.id) !== true) throw new Error('context_checkpoint must run inside this Member\'s own running turn')
    const name = request.name.trim()
    if (name === '') throw new Error('context_checkpoint requires a non-empty name')
    if (name.length > MAX_CHECKPOINT_NAME_CHARS) throw new Error(`context_checkpoint name exceeds ${MAX_CHECKPOINT_NAME_CHARS} characters`)
    return { checkpointRef: checkpointRefFor(agent.session.id, request.callId), name }
  }

  /**
   * Agent-only bounded structural timeline: resolved checkpoints plus Team
   * delivery, handoff, and compaction boundaries across the current
   * generation and its archived ancestor lineage. Structural only — no
   * transcript content. The walk, the per-source folds, the pricing, and the
   * anchor rules are the engine's `readContextTimeline`; Team contributes the
   * fold configuration, the measurement, and the one judgement the engine
   * leaves to its host — which Threads a boundary's retained prefix holds — so
   * a ref this list offers is a ref `context_rollover` accepts.
   */
  async contextTimelineForAgent(agent: Agent, request: AgentTeamTimelineToolRequest): Promise<AgentTeamTimelineToolResult> {
    const member = this.memberForAgent(agent)
    if (member === undefined || member.state !== 'enabled') throw new Error('context_timeline requires an active Team Member')
    const limit = request.limit === undefined ? DEFAULT_TIMELINE_LIMIT : Math.trunc(request.limit)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TIMELINE_LIMIT) throw new Error(`context_timeline limit must be between 1 and ${MAX_TIMELINE_LIMIT}`)
    const meter = agent.ctx.get('tokenMeter')
    const measurement = meter?.measure(agent.session)
    const usageTokens = measurement?.totalTokens ?? 0
    const limits = await this.routeLimitsForAgent(agent)
    // An unpriceable route displays the conservative fallback budget, never a
    // fixed cap pretending to be the live route's capacity.
    const hardLimit = limits?.hardLimit ?? FALLBACK_PRESSURE_BUDGET.hardLimit
    const handoffAt = limits?.handoffAt ?? FALLBACK_PRESSURE_BUDGET.handoffAt
    // One measurement per lineage source, memoized by Session: the engine
    // measures a source once before pricing its anchors, and the boundary
    // overlay below reads the same map to tell an unprovable budget (never
    // priced as free) from a real budget rejection.
    const measurements = new Map<string, number | undefined>()
    const timeline = await readContextTimeline({
      current: {
        sessionId: agent.session.id,
        header: agent.session.header,
        inheritedEventCount: agent.session.inheritedEventCount,
        events: agent.session.snapshotEvents(),
      },
      config: this.contextFoldConfig(),
      readAncestor: sessionId => this.sessionReader.read(sessionId),
      measureSource: source => {
        const key = String(source.sessionId)
        if (!measurements.has(key)) measurements.set(key, this.measureContextSourceForAgent(agent, source))
        return measurements.get(key)
      },
      currentUsageTokens: usageTokens,
      handoffAt,
      limit,
      // Archived ancestors the engine walks; the seed guard resolves a cited
      // ref through the same depth, so the timeline never offers a ref the
      // guard cannot reach.
      maxAncestors: MAX_TIMELINE_ANCESTORS,
    })
    return {
      usageTokens,
      hardLimit,
      handoffAt,
      items: timeline.items.map(item => this.teamTimelineItemFor(item, agent.session.id, handoffAt, measurements)),
      ...(timeline.incompleteFrom === undefined ? {} : { incompleteFrom: timeline.incompleteFrom }),
    }
  }

  /**
   * Map one engine timeline item onto the model-facing Team item. The engine
   * decided the walk, the fold, the pricing, and the head, checkpoint, and
   * measurable-source verdicts; Team restates exactly one policy of its own: a
   * Team boundary is selectable only when the RETAINED PREFIX through it stays
   * inside one Thread — the same proof the seed guard revalidates before it
   * swaps a generation. The engine judges a boundary by its OWN attribution
   * instead, so a boundary that arrived after a second Thread's facts would be
   * offered here and refused by `context_rollover`; Team's stricter rule is
   * what keeps the two surfaces answering one question.
   */
  private teamTimelineItemFor(item: ContextTimelineItem, currentSessionId: SessionId, handoffAt: number, measurements: ReadonlyMap<string, number | undefined>): AgentTeamTimelineItem {
    const source: AgentTeamTimelineItem['source'] = item.source === 'boundary'
      ? item.kind === 'handoff' || item.kind === 'compaction' ? item.kind : 'team-boundary'
      : item.source === 'checkpoint' ? 'agent' : 'head'
    const affectedThreads = item.affectedTopics
    let restorable = item.restorable
    let reason = item.reason
    // A boundary's verdict is Team's to make, but only once its source is
    // measurable: "the budget cannot be proven" is the engine's first
    // rejection and stays first — an unmeasurable boundary is not selectable
    // even when its prefix holds exactly one Thread.
    if (item.source === 'boundary' && measurements.get(String(item.sourceSessionId ?? currentSessionId)) !== undefined) {
      if (source === 'handoff' || source === 'compaction') {
        // A handoff opens a generation and a compaction rewrites the visible
        // surface: rewinding into either is not a proven-safe target. The
        // engine has no vocabulary for that and would answer "no single topic
        // is attributable", which misdescribes why.
        restorable = false
        reason = `source '${source}' is not a restorable checkpoint`
      } else if (affectedThreads.length !== 1) {
        restorable = false
        reason = affectedThreads.length === 0
          ? 'no single Thread is attributable to this boundary'
          : 'multiple Threads entered the context through this boundary; write a fresh handoff instead'
      } else if (item.retainedTokens >= handoffAt) {
        restorable = false
        reason = 'retained context would not materially shrink the working set'
      } else {
        restorable = true
        reason = undefined
      }
    }
    return {
      checkpointRef: item.ref,
      name: item.label,
      source,
      retainedTokens: item.retainedTokens,
      discardedTokens: item.discardedTokens,
      affectedThreads,
      restorable,
      ...(reason === undefined ? {} : { reason }),
      // Team's field semantics, unchanged: every item that is not a
      // checkpoint names the Session it anchors in — an ancestor generation's
      // boundary is how a lineage reads — and a checkpoint is keyed to its own
      // Session by its ref already.
      ...(source === 'agent' ? {} : { sourceSessionId: item.sourceSessionId ?? currentSessionId }),
    }
  }

  /**
   * Replayed measurement of one lineage source: the live current Session
   * measures directly; an archived ancestor measures through a detached
   * Session rebuilt from the source's own log, so a seed's retained cost is
   * priced in the SOURCE's own tokens — never the current generation's.
   * Returns undefined when no meter is available or the source cannot be
   * replayed; callers fail closed on the unknown.
   */
  private async sourceUsageTokens(sessionId: SessionId, live: boolean, agent: Agent): Promise<number | undefined> {
    const meter = agent.ctx.get('tokenMeter')
    if (meter === undefined) return undefined
    if (live) return meter.measure(agent.session)?.totalTokens
    // 0.1.5 removed borrowSession: rebuild a detached Session from the
    // stored log so the seed's retained cost is priced by the SOURCE's own
    // replay, never the current generation's. An unreadable source or a
    // failing meter is unmeasurable and prices as UNKNOWN.
    const read = await this.sessionReader.read(sessionId)
    if (!read.ok) return undefined
    return this.measureDetachedSource(agent, {
      sessionId,
      header: read.inspection.header,
      inheritedEventCount: read.inspection.inheritedEventCount,
      events: read.inspection.events,
    })
  }

  /**
   * One already-read source's replayed measurement: an archived generation is
   * rebuilt as a detached Session and measured in its own tokens. Undefined
   * means unmeasurable, never free.
   */
  private measureDetachedSource(agent: Agent, source: ContextTimelineSource): number | undefined {
    const meter = agent.ctx.get('tokenMeter')
    if (meter === undefined) return undefined
    try {
      const session = Session.create(source.sessionId, source.events, source.header, source.inheritedEventCount)
      return meter.measure(session)?.totalTokens
    } catch {
      return undefined
    }
  }

  /**
   * One source's replayed measurement, in that source's own tokens, for a
   * caller that already holds the source: the live generation measures
   * directly, an archived one is rebuilt from the log it came with. Undefined
   * means unmeasurable — a caller must never price an unknown source as free.
   */
  measureContextSourceForAgent(agent: Agent, source: ContextTimelineSource): number | undefined {
    if (String(source.sessionId) === String(agent.session.id)) {
      return agent.ctx.get('tokenMeter')?.measure(agent.session)?.totalTokens
    }
    return this.measureDetachedSource(agent, source)
  }

  /**
   * The one fold configuration the registered projection unit and every cold
   * fold use, so a generation read back for the timeline reads exactly as the
   * projection folded it — same codec, same boundary attribution.
   */
  contextFoldConfig(): ContextProjectionConfig {
    return createTeamContextProjectionConfig(this.contextProjectionHost)
  }

  /**
   * Monotonic anchor-share estimate of a seed's retained cost, priced in the
   * SOURCE Session's own measurement: the fraction of the source log the
   * seed prefix covers, scaled to the source's replayed token count. The
   * anchor position is exact and the share grows monotonically toward the
   * source's head (100%). A large ancestor's anchor therefore prices at the
   * ancestor's real size even inside a small current generation — the
   * timeline display and the return guard share this one estimate.
   */
  private retainedEstimate(sourceUsageTokens: number, sourceLength: number, anchorTurnEndSeq: number): number {
    if (sourceLength <= 0) return sourceUsageTokens
    const share = Math.min(1, Math.max(0, (anchorTurnEndSeq + 1) / sourceLength))
    return Math.round(sourceUsageTokens * share)
  }

  /**
   * Agent-only rollover request validation: the tool calls this to check its
   * Member binding, exclusivity, and checkpoint ownership. It performs no
   * lifecycle effect — the actual transition reacts to the successful tool
   * result through the context-management coordinator.
   */
  async requestNewContext(agent: Agent, request: AgentTeamNewContextToolRequest): Promise<AgentTeamNewContextToolOutcome> {
    const member = this.memberForAgent(agent)
    if (member === undefined || member.state !== 'enabled') throw new Error('context_rollover requires an active Team Member')
    if (this.contextManagement.isTransitioning(member.memberId)) throw new Error('a context rollover is already scheduled for this Member; wait for it to finish before requesting another')
    if (this.runningAgents.has(agent.id) !== true) {
      // The tool runs inside the Member's own turn, so a non-running agent at
      // this point is a harness anomaly; refuse rather than schedule a swap
      // outside the turn fence.
      throw new Error('context_rollover must run inside this Member\'s own running turn')
    }
    // Job ownership guard: disposing the old Agent cancels its running jobs
    // and orphaned terminal-but-unreported output would vanish with it. The
    // rejection names the jobs so the model can collect or stop them first;
    // the transition rechecks at the lifecycle commit seam because a job may
    // settle between this validation and the swap.
    const blocking = this.ownedJobsBlockingRollover(agent)
    if (blocking.length > 0) {
      throw new Error(`context_rollover is refused while this Member owns jobs that would not survive the switch (${blocking.join(', ')}); collect or stop them first, then retry`)
    }
    if (request.checkpointRef === undefined) return { mode: 'fresh' }
    if (!/^(context-checkpoint-[0-9a-f]{64}|team-boundary-[0-9a-f]{64})$/.test(request.checkpointRef)) throw new Error('checkpointRef must be an opaque ref exactly as returned by context_timeline')
    // Full current-state prevalidation through the ONE resolver the swap
    // itself uses: a ref that is fabricated, unattributable, nonshrinking,
    // unmeasurable, over-budget, or blocked by multiple active Claims
    // rejects HERE — a model-visible error result instead of a fake
    // `scheduled` whose async swap always fails. The seed is resolved and
    // discarded: the transition seam resolves it again, so only the mutable
    // guard set (jobs, route limits, lineage growth) is revalidated there.
    await this.resolveCheckpointSeed(member.memberId, agent, request.checkpointRef)
    return { mode: 'from-checkpoint' }
  }

  /**
   * Jobs this Agent owns that cannot survive a generation swap: any
   * running/stopping job, and any settled job whose terminal output was
   * never reported (disposal would silently discard it). In-place hard
   * compaction is exempt — it never cancels the owner.
   */
  private ownedJobsBlockingRollover(agent: Agent): readonly string[] {
    const jobs = agent.ctx.get('jobs')
    if (jobs === undefined) return []
    return jobs.list(agent)
      .filter((job: { status: string; reported: boolean }) => job.status === 'running' || job.status === 'stopping' || ((job.status === 'completed' || job.status === 'killed' || job.status === 'failed') && !job.reported))
      .map((job: { id: string; label: string }) => `${job.label} (${job.id})`)
  }

  /**
   * Agent-only session rollover commit: the Member actor must be the target
   * Member on its currently bound live Session. The Host performs the actual
   * generation swap around this write; the ledger records only the durable
   * binding transition and rollover audit envelope.
   */
  async rolloverSessionForAgent(agent: Agent, request: AgentTeamRolloverSessionRequest): Promise<AgentTeamDurableMemberResult> {
    const actor = this.memberCall(agent, request.workspaceId)
    const result = await this.requireLedger().rolloverMemberSession({ ...request, actor })
    if (result.committed) this.emitCommitted(result.value.receipt)
    return result.value
  }

  /**
   * Agent-only interrupt recording: pin the Member's unfinished session onto
   * a checkpoint it actually recorded. The cited ref must appear in the
   * Member's own lineage timeline — the same engine anti-forgery surface
   * `context_rollover` gate-checks against — and an unresolved checkpoint is
   * not yet an anchor, so the record belongs to the turn after the one that
   * recorded it (the engine's quiet continuation lands it there). Recording
   * performs no lifecycle effect: the swap stays exclusively the rollover
   * tool's; the entry is durable bookkeeping the resume protocol walks.
   */
  async recordInterruptForAgent(agent: Agent, request: AgentTeamRecordInterruptToolRequest): Promise<AgentTeamRecordInterruptToolOutcome> {
    const member = this.memberForAgent(agent)
    if (member === undefined || member.state !== 'enabled') throw new Error('context_interrupt requires an active Team Member')
    if (this.runningAgents.has(agent.id) !== true) throw new Error('context_interrupt must run inside this Member\'s own running turn')
    if (!/^(context-checkpoint-[0-9a-f]{64}|team-boundary-[0-9a-f]{64})$/.test(request.checkpointRef)) throw new Error('checkpointRef must be an opaque ref exactly as returned by context_checkpoint or context_timeline')
    if (!(await this.lineageKnowsAnchor(agent, member.memberId, request.checkpointRef))) {
      throw new Error('the checkpoint is not a resolved anchor of this Member\'s lineage yet: record it with context_checkpoint, and pin the interrupt in the turn that follows')
    }
    // The tool-call id keys the commit: a retried provider call with the same
    // id resolves to the entry already on the stack, never a duplicate.
    const result = await this.requireLedger().recordMemberInterrupt({
      requestId: `interrupt-record:${agent.session.id}:${request.callId}` as AgentTeamRequestId,
      workspaceId: member.workspaceId,
      memberId: member.memberId,
      actor: this.memberActor(agent),
      sessionId: agent.session.id,
      checkpointRef: request.checkpointRef as AgentTeamContextCheckpointRef,
      label: request.label,
      incompleteState: request.incompleteState,
      ...(request.taskRef === undefined ? {} : { taskRef: request.taskRef }),
      ...(request.threadRef === undefined ? {} : { threadRef: request.threadRef }),
      ...(request.notePath === undefined ? {} : { notePath: request.notePath }),
    })
    if (result.committed) this.emitCommitted(result.value.receipt)
    return { interruptRef: result.value.interrupt.interruptRef, recordedSequence: result.value.interrupt.recordedSequence }
  }

  /** Agent-only pending-stack read: every interrupt this Member pinned and has not resumed or released, newest first. */
  async listInterruptsForAgent(agent: Agent): Promise<AgentTeamListInterruptsToolOutcome> {
    const member = this.memberForAgent(agent)
    if (member === undefined || member.state !== 'enabled') throw new Error('context_interrupt requires an active Team Member')
    const pending = this.requireLedger().pendingInterruptsForMember(member.memberId)
    return Object.freeze({ items: await this.interruptViews(member.memberId, agent, pending) })
  }

  /** Agent-only release: close one pending interrupt without returning to it. */
  async releaseInterruptForAgent(agent: Agent, request: AgentTeamReleaseInterruptToolRequest): Promise<AgentTeamReleaseInterruptToolOutcome> {
    const member = this.memberForAgent(agent)
    if (member === undefined || member.state !== 'enabled') throw new Error('context_interrupt requires an active Team Member')
    const result = await this.requireLedger().resolveMemberInterrupt({
      requestId: `interrupt-released:${agent.session.id}:${request.callId}` as AgentTeamRequestId,
      workspaceId: member.workspaceId,
      memberId: member.memberId,
      actor: this.memberActor(agent),
      interruptRef: request.interruptRef,
      resolution: 'released',
      ...(request.reason === undefined ? {} : { reason: request.reason }),
    })
    if (result.committed) this.emitCommitted(result.value.receipt)
    // The agent surface only ever releases; the idempotency assertion above
    // guarantees a retried call resolves to this call's own `released` record.
    return { interruptRef: result.value.interruptRef, resolution: 'released' }
  }

  /** Whether one opaque ref is a resolved anchor of this Member's current lineage window. */
  private async lineageKnowsAnchor(agent: Agent, memberId: AgentTeamMemberId, checkpointRef: string): Promise<boolean> {
    const timeline = await this.contextTimelineForAgent(agent, { memberId, limit: MAX_TIMELINE_LIMIT })
    return timeline.items.some(item => item.checkpointRef === checkpointRef)
  }

  /**
   * Annotate pending entries with the live lineage verdict: citing the anchor
   * today returns or not, and the reason the timeline states. Without a live
   * Agent the walk cannot run at all — an unproven anchor never reads as
   * returnable, so the Human surface degrades to an explicit unverified false
   * instead of an optimistic yes.
   */
  private async interruptViews(memberId: AgentTeamMemberId, agent: Agent | undefined, pending: readonly AgentTeamMemberInterrupt[]): Promise<readonly AgentTeamInterruptView[]> {
    const verdicts = new Map<string, { restorable: boolean; reason?: string }>()
    let walked = false
    if (agent !== undefined && pending.length > 0) {
      try {
        const timeline = await this.contextTimelineForAgent(agent, { memberId, limit: MAX_TIMELINE_LIMIT })
        for (const item of timeline.items) verdicts.set(item.checkpointRef, { restorable: item.restorable, ...(item.reason === undefined ? {} : { reason: item.reason }) })
        walked = true
      } catch {
        walked = false
      }
    }
    return Object.freeze(pending.map(interrupt => {
      const verdict = walked ? verdicts.get(interrupt.checkpointRef) : undefined
      const restorable = verdict?.restorable === true
      return Object.freeze({
        interruptRef: interrupt.interruptRef,
        label: interrupt.label,
        incompleteState: interrupt.incompleteState,
        checkpointRef: interrupt.checkpointRef,
        recordedAt: interrupt.recordedAt,
        ...(interrupt.taskRef === undefined ? {} : { taskRef: interrupt.taskRef }),
        ...(interrupt.threadRef === undefined ? {} : { threadRef: interrupt.threadRef }),
        restorable,
        ...(restorable ? {} : { reason: verdict?.reason ?? 'the anchor is not listed in this Member\'s current lineage window, so the return cannot be proven' }),
      })
    }))
  }

  /** Human read: one Member's pending interrupts, newest first, annotated when the Member is live. */
  @Remote('memberInterrupts')
  async memberInterrupts(request: AgentTeamMemberInterruptsRequest): Promise<AgentTeamMemberInterrupts> {
    this.requireAccepting()
    this.requireWorkspace(request.workspaceId)
    const member = this.requireLedger().getMember(request.memberId)
    if (member === undefined) throw new Error(`unknown Agent Member '${request.memberId}'`)
    const pending = this.requireLedger().pendingInterruptsForMember(member.memberId).filter(interrupt => interrupt.workspaceId === request.workspaceId)
    return Object.freeze({
      memberId: member.memberId,
      items: await this.interruptViews(member.memberId, this.handles.get(member.memberId)?.agent, pending),
    })
  }

  /** Human release of one Member's pending interrupt; `resumed` stays exclusively the Host's own close. */
  @Remote('resolveMemberInterrupt')
  async resolveMemberInterrupt(request: AgentTeamResolveMemberInterruptRequest): Promise<AgentTeamResolveMemberInterruptResult> {
    this.requireAccepting()
    const result = await this.requireLedger().resolveMemberInterrupt({
      requestId: request.requestId,
      workspaceId: request.workspaceId,
      memberId: request.memberId,
      actor: this.humanCall(request.workspaceId),
      interruptRef: request.interruptRef,
      resolution: 'released',
      ...(request.reason === undefined ? {} : { reason: request.reason }),
    })
    if (result.committed) this.emitCommitted(result.value.receipt)
    return result.value
  }

  private emitCommittedOutcome<T extends { readonly kind: string; readonly receipt?: AgentTeamOperationReceipt }>(
    result: { readonly committed: boolean; readonly value: T },
  ): void {
    if (result.committed && result.value.kind === 'committed' && result.value.receipt !== undefined) this.emitCommitted(result.value.receipt)
  }

  private assertChannelMembersAvailable(memberIds: readonly AgentTeamMemberId[] | undefined): void {
    for (const memberId of memberIds ?? []) {
      const member = this.requireLedger().getMember(memberId)
      if (member === undefined) throw new Error(`unknown Agent Member '${memberId}'`)
      if (this.memberStatus(member).availability !== 'active') throw new Error(`Agent Member '${memberId}' is not available for Channel membership`)
    }
  }

  /** Shared Task-creation commit: resolve uploads into metadata lines and append through the ledger. */
  private async sendMessageAs(actor: AgentTeamHumanActor | AgentTeamAssistantActor | AgentTeamMemberActor, request: AgentTeamSendMessageRequest): Promise<AgentTeamSendMessageResult> {
    const metadata = await this.resolveMessageAttachments(request)
    const result = await this.requireLedger().sendMessage({
      ...request, body: this.appendAttachmentLines(request.body, metadata),
      ...(metadata.length === 0 ? {} : { resolvedAttachments: metadata }),
      actor,
    })
    // The sender's fresh-context judgement is recorded before the commit is
    // emitted: emitting synchronously derives each named Member's Inbox wake,
    // and the dispatch gate reads the exemption from there.
    if (request.keepContext === true && result.committed && result.value.kind === 'committed') this.keepFreshStartDispatch(result.value.directMarkers)
    this.emitCommittedOutcome(result)
    // A Human atomic start is the one creation boundary a fresh-start Member
    // cannot schedule itself: every mentioned fresh-policy Member resets at
    // this boundary (teammate sends and taskless messages never do) — unless
    // the sender declared this work needs the Member's live context, or the
    // model's relevance judgement says the assignment continues that work.
    const outcome = result.value
    if (actor.kind === 'human' && request.asTask !== false && outcome.kind === 'committed') {
      for (const marker of outcome.directMarkers) {
        const stored = this.ledger?.getMember(marker.memberId)
        if (stored === undefined || stored.contextStartPolicy !== 'fresh') continue
        if (request.keepContext === true) {
          this.keptDispatchSequence.set(marker.memberId, marker.sequence)
          continue
        }
        this.judgeFreshStartDispatch(stored, marker.sequence, outcome.message.body)
      }
      // The same atomic-start boundary sweeps auto-prune candidates for every
      // opted-in Member the task starts; the switch-off default never does.
      for (const marker of outcome.directMarkers) this.scheduleAutoPruneSweep(marker.memberId)
    }
    return outcome
  }

  /** Shared existing-Thread reply commit: same upload resolution and outcome emission. */
  private async replyAs(actor: AgentTeamHumanActor | AgentTeamMemberActor, request: AgentTeamReplyRequest): Promise<AgentTeamReplyResult> {
    const metadata = await this.resolveMessageAttachments(request)
    const result = await this.requireLedger().reply({
      ...request, body: this.appendAttachmentLines(request.body, metadata),
      ...(metadata.length === 0 ? {} : { resolvedAttachments: metadata }),
      actor,
    })
    if (request.keepContext === true && result.committed && result.value.kind === 'committed') this.keepFreshStartDispatch(result.value.directMarkers)
    this.emitCommittedOutcome(result)
    return result.value
  }

  /**
   * Record one dispatch whose sender judged the work needs the named Members'
   * live Session: their fresh-start arm stays armed but the direct work this
   * Message creates (at this ledger sequence) no longer spends it. A later
   * dispatch carries a higher sequence and renews as usual, so the exemption is
   * exactly this delivery, never the next task.
   */
  private keepFreshStartDispatch(markers: readonly AgentTeamDirectMarker[]): void {
    for (const marker of markers) this.keptDispatchSequence.set(marker.memberId, marker.sequence)
  }

  /** Fence one Human Remote call: accepting Host, known Workspace, Human actor. */
  private humanCall(workspaceId: AgentTeamViewRequest['workspaceId']): AgentTeamHumanActor {
    this.requireAccepting()
    this.requireWorkspace(workspaceId)
    return agentTeamHumanActor()
  }

  /** Fence one Member call: accepting Host, live Member binding, matching Workspace participation. */
  private memberCall(agent: Agent, workspaceId: AgentTeamViewRequest['workspaceId']): AgentTeamMemberActor {
    this.requireAccepting()
    this.requireWorkspace(workspaceId)
    const actor = this.memberActor(agent)
    this.requireAgentWorkspace(actor, workspaceId)
    return actor
  }

  private memberActor(agent: Agent): AgentTeamMemberActor {
    const member = this.memberForAgent(agent)
    if (member === undefined) throw new Error('Agent is not an active Team Member')
    return Object.freeze({ kind: 'member', memberId: member.memberId, handle: member.handle })
  }

  private requireAgentWorkspace(actor: AgentTeamMemberActor, workspaceId: AgentTeamViewRequest['workspaceId']): void {
    if (!this.requireLedger().participatesIn(actor.memberId, workspaceId)) throw new Error('Member cannot mutate another Workspace')
  }

  /**
   * Validate a pinned model route's reasoning effort against the adapter's own
   * metadata when the LLM service is reachable; unknown routes defer to the
   * LLM layer's runtime check at call time.
   */
  private async assertModelRoute(model: AgentTeamModelSelection | undefined): Promise<void> {
    if (model === undefined || model.reasoningEffort === undefined) return
    try {
      const resolved = await this.ctx.llm.resolveModelInfo(model.provider, model.model)
      const efforts = resolved.reasoning?.efforts ?? []
      if (efforts.length > 0 && !efforts.some(effort => effort.id === model.reasoningEffort)) {
        throw new Error(`reasoning effort '${model.reasoningEffort}' is not supported by ${model.provider}/${model.model}`)
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('is not supported by')) throw error
    }
  }

  /**
   * Session headers currently durable in the persistence backend.
   *
   * The Host retires a disposed Session's log without awaiting it, so a
   * concurrent activation can observe the JSONL backend's transient win32
   * staging directories (.dsh-mkdir-*) as ENOENT while they rename into
   * place. The read is idempotent; back off briefly instead of failing the
   * activation on a race the publisher resolves within milliseconds.
   */
  private async persistedSessionHeaders() {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.ctx.sessionPersistence.list()
      } catch (error) {
        if (attempt >= 3 || (error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error
        await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 25))
      }
    }
  }

  private async activateMember(member: AgentTeamAgentMember, knownWorkspacePath?: string, knownSessions?: ReadonlySet<SessionId>, forkedFrom?: SessionId, options?: { readonly deferNotify?: boolean; readonly seed?: readonly SessionEvent[]; readonly inheritedEventCount?: SessionLogOffset; readonly carriedSelection?: AgentTeamModelSelection }): Promise<void> {
    if (this.handles.has(member.memberId)) return
    let created: AgentHandle | undefined
    try {
      const workspace = this.requireWorkspace(member.workspaceId)
      const workspacePath = knownWorkspacePath ?? workspace.path
      // Existing Members carry the pre-sanitization ledger path; activation
      // migrates it onto the sanitized directory before provisioning.
      const sanitizedMemoryPath = dshHomePath('agent-team', 'members', memberMemoryDirectoryName(member.memberId))
      await this.memberRuntime.initializePrivateMemory(sanitizedMemoryPath, member.privateMemoryPath)
      const persisted = knownSessions !== undefined ? knownSessions.has(member.sessionId)
        : await this.sessionPersisted(member.sessionId)
      // AgentOptions declares only provider/model. Install the full selection
      // through the public Agent model-selection seam so reasoning effort is
      // applied to the next request and not lost during activation. A context
      // rollover carries the retiring generation's live route: the fresh
      // generation must re-render the same prompt assembly, not reload the
      // operator default under it (see the transition's carriedSelection).
      const selection = member.model ?? options?.carriedSelection ?? this.ctx.agentDefaultModel.currentSelection()
      const agentOptions = { provider: selection.provider, model: selection.model }
      const selected: ModelSelectionRef = { current: selection, assembled: undefined }
      // Absent skills.allow loads every discovered private skill; a present
      // allow-list filters the catalog by name through the live ref below.
      // `swap` is bound by the provider at activation (no-op until then).
      const skillSelection: MemberSkillSelectionRef = { current: member.capabilities?.skills?.allow, swap: () => {} }
      const setup = async (agentCtx: Context, agent: Agent) => {
        try {
          await this.ctx.agentPresets.mount(agentCtx, member.presetId)
          this.memberRuntime.applyMemberToolPolicy(agentCtx, member)
          this.memberRuntime.applyMemberPromptSection(agentCtx, member)
          this.memberRuntime.applyMemberSectionDrops(agentCtx, member)
          this.validateMemberPreset(agentCtx)
        } catch (error) {
          // Tag composition failures with their own class: the activation
          // diagnostic routes preset-composition (install/runtime split)
          // failures by type, not by matching message text.
          throw new PresetCompositionError(error instanceof Error ? error.message : String(error), { cause: error })
        }
        installModelSelection(agentCtx, selected)
        // Admission gate for pending context rollovers: once a successful
        // context_rollover result is durable, queued input must not open another
        // old-generation model request. The turn-stop boundary captures the
        // inbox (non-Team input is carried to the new generation), and a
        // racing pre-step rejects instead of admitting claimed messages.
        agentCtx.on('agent/turn-stopping', ({ agent }) => {
          if (!this.contextManagement.needsAdmissionGate(agent)) return
          this.contextManagement.captureQueuedInput(agent)
        })
        agentCtx.on('agent/pre-step', async ({ agent, messages }, next) => {
          // Check before AND after the waterfall: a rollover pending at either
          // edge must reject this old-generation step, preserving its claimed
          // input for the new generation instead of letting it run or drop.
          if (this.contextManagement.needsAdmissionGate(agent)) {
            this.contextManagement.captureClaimedInput(agent, messages)
            return { kind: 'reject' as const }
          }
          const decision = await next()
          if (decision.kind === 'reject' || !this.contextManagement.needsAdmissionGate(agent)) return decision
          this.contextManagement.captureClaimedInput(agent, messages)
          return { kind: 'reject' as const }
        })
        // Provider context-overflow recovery: one bounded compact-and-retry
        // sequence per failure chain through the Team-owned policy.
        agentCtx.on('agent/request-error', async ({ agent, failure, signal }, next) => {
          const retry = await this.pressurePolicy.onRequestError(agent, failure, signal)
          if (retry) return { kind: 'retry' as const }
          return next()
        })
        return {
          commit: () => {
            // The member scope composes no sandbox-policy service (the preset
            // owns no sandbox row), so read the last logged mode straight from
            // the session log; `sandbox/mode` is log-only and never joins the
            // model-visible surface. Re-appending only when the effective mode
            // differs keeps resumed members from growing redundant events.
            const logged = agent.session.ownEvents().toReversed().find(event => event.type === 'sandbox/mode')
            if (logged?.data.mode !== 'danger-full-access') setSandboxMode(agent.session, 'danger-full-access')
          },
        }
      }
      // A renewal's create path parents at the ledger-recorded previous
      // Session even when the caller does not pass one: a crash between the
      // durable rollover commit and this activation recreates the Session
      // from the ledger binding alone, and the lineage parent is what makes
      // the missing handoff reconstructible on the NEXT failure. A recorded
      // checkpoint seed re-seeds the child here — the crash lost the process
      // memory, but the ledger envelope names the exact source prefix.
      let recordedSeed: readonly SessionEvent[] | undefined
      let recordedSeedCut: SessionLogOffset | undefined
      const rolloverSeed = !persisted && options?.seed === undefined
        ? this.requireLedger().rolloverSeedForMember(member.memberId, member.sessionId)
        : undefined
      if (rolloverSeed !== undefined) {
        // Fail-closed: an unreadable or unprovable recorded seed rejects
        // this activation (the catch below records the diagnostic) instead
        // of silently downgrading a committed checkpoint return to a blank
        // child.
        const resolved = await this.recordedCheckpointPrefix(rolloverSeed)
        recordedSeed = resolved.prefix
        recordedSeedCut = SessionLogOffset(resolved.prefix.length)
      }
      const lineageParent = forkedFrom ?? (!persisted ? this.requireLedger().previousSessionForMember(member.memberId) : undefined)
      let recoveryCarried = 0
      const seededFromLedger = recordedSeed !== undefined
      const effectiveParent = recordedSeed !== undefined ? rolloverSeed!.sourceSessionId : lineageParent
      const seedOptions = options?.seed !== undefined && options.inheritedEventCount !== undefined
        ? { seed: options.seed, inheritedEventCount: options.inheritedEventCount }
        : recordedSeed !== undefined && recordedSeedCut !== undefined
          ? { seed: recordedSeed, inheritedEventCount: recordedSeedCut }
          : {}
      created = persisted
        ? await this.ctx.agents.resume({ resumeSessionId: member.sessionId, agentOptions, setup })
        : await this.ctx.agents.create({
            sessionId: member.sessionId,
            // A context renewal records its fork lineage so the archived
            // previous Session stays discoverable from the durable header; a
            // checkpoint return parents at the seed source and marks the
            // fork seeded with its exact inherited prefix length.
            meta: {
              cwd: workspacePath,
              agentPreset: member.presetId,
              ...(effectiveParent === undefined ? {} : { parentSession: effectiveParent }),
              ...(options?.seed === undefined && !seededFromLedger ? {} : { isSeeded: true }),
            },
            ...seedOptions,
            agentOptions,
            setup,
          })
      this.memberRuntime.mountMemberSkillProvider(member, created.agent.ctx, skillSelection)
      await workspace.attachSession(member.sessionId)
      this.handles.set(member.memberId, created)
      this.memberBySessionId.set(member.sessionId, member.memberId)
      this.modelSelections.set(member.memberId, selected)
      this.clearMemberFailure(member.memberId, 'activation')
      this.nameMemberSession(member, created.agent)
      // Snapshot whether this generation had already started its own turns
      // BEFORE any recovery delivery below: the handoff steer and the Inbox
      // wake legitimately append `turn/start` to this Session, and those must
      // never be mistaken for the generation having run on its own.
      const generationStarted = created.agent.session.ownEvents().some(event => event.type === 'turn/start')
      // Restore-tail judgement for a persisted Session: the last turn decides
      // what the restart owes this Member. A marker close carries the
      // fresh-start arm across the restart (the next dispatch still renews
      // first); a stop that left the work unfinished — a crash orphan, a
      // shutdown dispose, a completed stop with no marker — gets the same
      // bounded continue reminder a live faulty stop would have received, and
      // only while it is recent work the last Host generation was cut into.
      // A pending Inbox delivery is itself the wake-up: no reminder stacks
      // beside it.
      if (persisted) {
        const tail = classifyStoppedTurnTail(created.agent.session.ownEvents())
        if (tail.outcome === 'marker') {
          this.armFreshStartReset(member.memberId)
          // The completion liaison reads the same marker tail retroactively:
          // a Member whose completed stop was cut into by the restart still
          // earns its report check once the new process is watching, so idle
          // unreported Members do not slip through on every deploy. Only a
          // recent stop counts (same window as the boot fault reminder), and
          // a pending DIRECT fact — a mention or DM that will wake the Member
          // anyway — is the leader's own follow-up in flight, so no episode
          // opens beside it. Pure follower chatter never suppresses: under
          // point-to-point waking it summons no turn of its own.
          const pendingDirect = this.requireLedger().notificationFacts(member.memberId).some(({ item }) => item.directCount > 0)
          if (tail.at !== undefined
            && Date.now() - tail.at <= BOOT_FAULT_REMINDER_WINDOW_MS
            && !pendingDirect) {
            this.completionLiaison.onCompletedStop(
              member.memberId,
              this.requireLedger().positionAtOccurredAt(new Date(tail.at).toISOString()),
              tail.at,
            )
          }
        } else if (tail.outcome === 'faulty'
          && tail.at !== undefined
          && Date.now() - tail.at <= BOOT_FAULT_REMINDER_WINDOW_MS
          && !this.requireLedger().notificationFacts(member.memberId).some(({ item }) => item.directCount > 0)) {
          this.responseGuard.onStoppedAtBoot(member.memberId, 'faulty')
        }
      }
      // A restart between a durable rollover intent and its swap replays the
      // old Session; the projection still carries the intent, so finish the
      // transition (or keep waiting for the containing turn) from here.
      if (persisted) {
        const inheritedEventCount = created.agent.session.inheritedEventCount
        const state = foldTeamContextProjection(
          created.agent.session.ownEvents(),
          { sessionId: created.agent.session.id, inheritedEventCount },
          this.contextProjectionHost,
        )
        if (state.pending !== null) this.contextManagement.recoverPendingTransition(member.memberId, created.agent, member.sessionId)
        // A restart between one checkpoint's durable result and its quiet
        // follow-up delivery repairs exactly once; delivered continuations
        // stay delivered through the projection's own delivery record.
        this.contextManagement.repairContinuations(created.agent, state)
        // A restart after the rollover committed but before the handoff was
        // delivered activates the new Session with no handoff in its own
        // log — never treat that as an ordinary blank Member Session. The
        // operation's recorded previous Session (the lineage parent) still
        // holds the intent; rebuild the handoff from it. Presence is judged
        // by the projection boundary alone: every handoff this Host ever
        // published classifies under the context source's recognizer,
        // including the history the read-time conversion renamed.
        if (!state.boundaries.some(boundary => boundary.kind === 'handoff')) {
          await this.reconstructMissingHandoff(member, created.agent)
        }
        // Carried input redelivery binds to the committed transition target —
        // this Session — never to the handoff's presence: a crash after the
        // handoff landed but before the carried enqueue still replays here.
        recoveryCarried = await this.replayCarriedInput(member, created.agent, generationStarted)
      } else if (forkedFrom === undefined && lineageParent !== undefined) {
        // A restart recreated a Session that never materialized before the
        // crash (the rollover committed, its activation failed, and this
        // create path just rebuilt it from the ledger binding alone): the
        // same handoff reconstruction applies from the ledger's recorded
        // previous Session, and the old generation's unconsumed post-intent
        // input — the durable fold, the same truth the live transition uses —
        // rides behind the handoff exactly as it would have. The rollover's
        // own activation passes its fork parent explicitly and delivers the
        // handoff right after — that delivery is the plan, never this
        // recovery.
        await this.reconstructMissingHandoff(member, created.agent)
        recoveryCarried = await this.replayCarriedInput(member, created.agent, generationStarted)
      }
      // The ordinary Inbox wake runs LAST, after any recovery delivery above:
      // the handoff must stay the first model-facing context of a recovered
      // generation, with carried input behind it and rederived Team facts
      // behind that. When recovery redelivered carried input, the wake is
      // sequenced behind it (its own follow-up turn) so the steer lane can
      // never leapfrog the carried messages. A rollover activation defers the
      // wake entirely — its caller delivers the handoff (and carried input)
      // first and rederives the Inbox afterwards.
      if (options?.deferNotify !== true) this.notifyMember(created.agent, recoveryCarried > 0)
    } catch (error) {
      await created?.dispose()
      this.modelSelections.delete(member.memberId)
      this.memberRuntime.forgetMember(member.memberId)
      const message = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn(`agent-team: activation failed for member '${this.memberLabel(member.memberId)}': ${message}`)
      this.setActivationDiagnostic(member.memberId, this.activationDiagnosticOf(error, member.sessionId))
    } finally {
      // Activation only changes this Workspace's presence projection.
      this.emitMemberPresenceChanged(member)
    }
  }


  /**
   * Rebuild one enabled Member in place from its persisted Session.
   *
   * A bundle-row reload tears down the preset roster subtree, which prunes the
   * standing mount while live agents keep their dead scope bindings: the
   * Member keeps its session but loses its composed tools and services.
   * Re-running the preset composition requires a fresh Agent, and disposal is
   * the cost — the Web Client marks the recreated Session unavailable until it
   * is reopened, the same trade the shipped suspend/resume cycle makes.
   */
  private reactivateMember(memberId: AgentTeamMemberId): Promise<boolean> {
    return this.enqueueLifecycle(async () => {
      const member = this.requireLedger().getMember(memberId)
      if (member === undefined || member.state !== 'enabled') return false
      const stale = this.handles.get(memberId)
      if (stale !== undefined) {
        this.handles.delete(memberId)
        this.modelSelections.delete(memberId)
        this.memberRuntime.forgetMember(memberId)
        // The composition-loss diagnostic this heal answers is stale once the
        // rebuild starts; a later activation must not resurface it.
        this.clearMemberFailure(memberId, 'compaction')
        this.emitAutoCompactionChanged(memberId)
        await stale.dispose()
      }
      await this.activateMember(member)
      return this.handles.has(memberId)
    })
  }

  /**
   * Default an untitled Member Session to its handle so the ordinary Session
   * list names it. An explicit rename or any earlier title always wins; the
   * cosmetic default never fails Member activation.
   */
  private nameMemberSession(member: AgentTeamAgentMember, agent: Agent): void {
    const sessionTitle = this.ctx.get('sessionTitle')
    if (sessionTitle === undefined) return
    try {
      if (sessionTitle.get(agent.session) !== undefined) return
      sessionTitle.rename(agent.session, member.handle)
    } catch {
      // The composition may carry no session-title service, or the rename may
      // race its disposal; the Member works identically without the title.
    }
  }

  private validateMemberPreset(agentCtx: Context): void {
    const scope = scopeOf(agentCtx)
    const teamMessage = this.ctx.tools.get('team_message', scope)
    if ((teamMessage as Record<PropertyKey, unknown> | undefined)?.[AGENT_TEAM_PRESET_MARKER] !== true) {
      // `agentPresets.mount` already rejected an unscoped context, so a scope
      // key the harness sees but this bundle does not means the two sides
      // loaded different module instances of @deepseek-ai/dsh-scope (the
      // common trigger is running the CLI from source via tsx).
      if (scope === undefined) throw new Error(teamPresetScopeMismatchMessage(isTsxDevMode()))
      throw new Error('selected preset is not team-enabled')
    }
    const available = new Set(this.ctx.tools.schemas(scope).map(tool => tool.name))
    const missing = AGENT_TEAM_TOOL_NAMES.filter(name => !available.has(name))
    if (missing.length > 0) throw new Error(`team-enabled preset is missing tools: ${missing.join(', ')}`)
  }

  private memberStatus(member: AgentTeamAgentMember): AgentTeamAgentMemberStatus {
    if (member.state === 'inactive') return Object.freeze({ member, availability: 'inactive', presence: 'unavailable' })
    if (member.state === 'archived') return Object.freeze({ member, availability: 'archived', presence: 'unavailable' })
    if (member.state === 'suspended') return Object.freeze({ member, availability: 'suspended', presence: 'unavailable' })
    const failures = this.memberFailures.get(member.memberId)
    if (failures?.activation !== undefined) return Object.freeze({ member, availability: 'unavailable', presence: 'unavailable', diagnostic: failures.activation })
    const handle = this.handles.get(member.memberId)
    if (handle === undefined) return Object.freeze({ member, availability: 'unavailable', presence: 'unavailable' })
    // A rollover commits its ledger binding before the old generation retires
    // and the new one activates; during that window the live handle still runs
    // the previous Session. The Member stays visible but must not report the
    // new binding as active — a Client following the row would otherwise open
    // a Session that does not exist yet.
    if (handle.agent.id !== member.sessionId) return Object.freeze({ member, availability: 'unavailable', presence: 'unavailable', diagnostic: { class: 'rollover' as const, detail: 'context rollover in progress' } })
    if (this.ctx.agentPresets.composedPreset(handle.agent.ctx) === undefined) {
      return Object.freeze({ member, availability: 'active', presence: 'error', diagnostic: { class: 'preset-composition' as const, detail: ORPHANED_MEMBER_DIAGNOSTIC } })
    }
    const runtimeError = failures?.runtime?.message ?? failures?.compaction?.message
    if (runtimeError !== undefined) return Object.freeze({ member, availability: 'active', presence: 'error', diagnostic: { class: 'runtime' as const, detail: runtimeError } })
    // Capability warnings are runtime-derived at activation (handles-scoped,
    // like failures): absent while capabilities resolve cleanly.
    const capabilityWarnings = this.memberRuntime.capabilityWarningsFor(member.memberId)
    return Object.freeze({
      member, availability: 'active', presence: handle.agent.status === 'running' ? 'working' : 'available',
      ...(capabilityWarnings === undefined ? {} : { capabilityWarnings }),
    })
  }

  private setMemberFailure(memberId: AgentTeamMemberId, slot: 'runtime' | 'compaction', message: string, sessionId?: SessionId): void {
    const failures = this.memberFailures.get(memberId) ?? {}
    failures[slot] = Object.freeze({ message, ...(sessionId === undefined ? {} : { sessionId }) })
    this.memberFailures.set(memberId, failures)
  }

  /** Store one structured activation diagnostic; runtime/compaction slots stay plain messages. */
  private setActivationDiagnostic(memberId: AgentTeamMemberId, diagnostic: AgentTeamMemberDiagnostic): void {
    const failures = this.memberFailures.get(memberId) ?? {}
    failures.activation = Object.freeze(diagnostic)
    this.memberFailures.set(memberId, failures)
  }

  /**
   * Route one activation failure to its diagnostic class: preset composition
   * failures by their own error class, session failures by the seam's typed
   * classification (our call sites carry it directly; a Harness resume
   * failure carries it through the cause chain), everything else as an
   * unclassified activation failure.
   */
  private activationDiagnosticOf(error: unknown, sessionId: SessionId): AgentTeamMemberDiagnostic {
    if (error instanceof PresetCompositionError) return { class: 'preset-composition' as const, detail: error.message }
    const failure = error instanceof StoredSessionReadError ? error.failure : sessionFailureOf(error, sessionId)
    if (failure !== undefined) {
      const shared = { detail: failure.detail, ...(failure.location === undefined ? {} : { location: failure.location }), sessionId: failure.sessionId }
      return failure.kind === 'refused' ? { class: 'session-refused' as const, ...shared } : { class: 'session-unreadable' as const, ...shared }
    }
    return { class: 'activation' as const, detail: error instanceof Error ? error.message : String(error) }
  }

  private clearMemberFailure(memberId: AgentTeamMemberId, slot: 'activation' | 'runtime' | 'compaction'): boolean {
    const failures = this.memberFailures.get(memberId)
    if (failures === undefined || failures[slot] === undefined) return false
    if (Object.keys(failures).length === 1) this.memberFailures.delete(memberId)
    else delete failures[slot]
    return true
  }

  private requireWorkspace(workspaceId: AgentTeamViewRequest['workspaceId']) {
    const workspace = this.ctx.workspaceRegistry.get(workspaceId)
    if (workspace === undefined) throw new Error(`unknown Workspace '${workspaceId}'`)
    return workspace
  }

  private requireLedger(): AgentTeamLedger {
    if (this.ledger === undefined || this.domain === undefined) throw new Error('agent-team service is not initialized')
    return this.ledger
  }

  private requireAccepting(): void {
    if (!this.accepting) throw new Error('agent-team service is shutting down')
  }

  /**
   * The storage directory the composition layer ships beside the SQLite ledger
   * route (`ledgerDirectory`); undefined means this Host was never given a
   * shared file medium to fence (a memory-backend test harness owns its ledger
   * in-process), and it runs unfenced and touches nothing in the DSH home.
   */
  private ledgerFenceDirectory(): string | undefined {
    return this.config.ledgerDirectory
  }

  private emitCommitted(receipt: AgentTeamOperationReceipt): void {
    this.ctx.emit('agent-team/committed', { receipt })
    const operation = this.ledger?.getOperation(receipt.operationId)
    if (operation === undefined) {
      this.emitChanged()
      return
    }
    const ledger = this.requireLedger()
    this.emitChanged(ledger.changeScopesOf(operation))
    if (operation.kind === 'team/member-workspace-joined' || operation.kind === 'team/member-workspace-left') {
      const agent = this.handles.get(operation.data.memberId)?.agent
      if (agent !== undefined) {
        const path = this.ctx.workspaceRegistry.get(operation.data.workspaceId)?.path
        const text = `Team participation changed: you have ${operation.kind === 'team/member-workspace-joined' ? 'joined' : 'left'} Workspace ${operation.data.workspaceId}${path === undefined ? ' (path unavailable)' : ` (${JSON.stringify(path)})`}.\nCurrent Workspace ids: ${ledger.workspacesOf(operation.data.memberId).join(', ')}. This replaces earlier participation information. Your Session and cwd have not moved.`
        const notice = createUserMessage({ content: [{ type: 'text', text }],
          source: { kind: AGENT_TEAM_PLUGIN_ID, form: 'notice', summary: 'Team Workspace participation changed' } })
        try {
          if (agent.status === 'idle' || agent.inbox.nextTurn.some(message => message.source.kind === 'user')) agent.followup(notice)
          else agent.steer(notice)
        } catch (error) {
          // Notification delivery cannot roll back a committed participation.
          this.ctx.logger.warn(`agent-team: participation notice not delivered: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    // Waking stays point-to-point on this per-commit broadcast: a Member is
    // summoned only when the operation names them — an added Direct marker
    // (mention or DM), an added Activity marker on their Task, or their own
    // acting. Ordinary Thread chatter keeps its unread count in the Inbox
    // projection and rides along with the next addressed delivery's summary,
    // so shared-Thread traffic spends no turn per follower. Recovery- and
    // restore-time hint re-derivation is a different question and still calls
    // notifyMember directly from those paths.
    const delta = 'inbox' in operation.data ? operation.data.inbox : undefined
    for (const memberId of ledger.affectedMembersOf(operation)) {
      const handle = this.handles.get(memberId)
      if (handle === undefined) continue
      const named = (operation.actor.kind === 'member' && operation.actor.memberId === memberId)
        || (delta?.directMarkers.added.some(marker => marker.memberId === memberId) ?? false)
        || (delta?.activityMarkers.added.some(marker => marker.memberId === memberId) ?? false)
      if (!named) continue
      this.notifyMember(handle.agent)
    }
    // Task acceptance no longer schedules standalone auto compaction: it is
    // a semantic checkpoint/context cue (delivered as ordinary Team
    // notification), and compaction stays a Member-owned or overflow-recovery
    // action.
  }

  private emitAutoCompactionChanged(memberId: AgentTeamMemberId): void {
    for (const workspaceId of this.ledger?.workspacesOf(memberId) ?? []) this.emitPresenceChanged(workspaceId)
  }

  /**
   * Presence-only invalidation: Agent running/idle/activation/failure changes
   * alter no durable projection, so only members/presence subscribers wake —
   * the workspace catalog and the scope-less Inbox subscriptions stay parked.
   */
  private emitPresenceChanged(workspaceId: WorkspaceId): void {
    this.emitChanged([{ kind: 'presence', workspaceId }])
  }

  /** Presence invalidation in every Workspace the Member participates in — each panel listing it must refresh. */
  private emitMemberPresenceChanged(member: AgentTeamAgentMember): void {
    for (const workspaceId of this.requireLedger().workspacesOf(member.memberId)) this.emitPresenceChanged(workspaceId)
  }

  /** Wake from durable unread state with bounded facts for direct and state-changing work. */
  private notifyMember(agent: Agent, sequenced = false): void {
    const member = this.memberForAgent(agent)
    if (member === undefined || member.state !== 'enabled') return
    const notifications = this.requireLedger().notificationFacts(member.memberId)
    if (notifications.length === 0) {
      this.notifiedInbox.delete(member.memberId)
      return
    }

    // Any ordinary next-turn input already queued (a rollover's or recovery's
    // carried messages) forces sequencing regardless of the caller: a steer
    // would claim the nearest step boundary and leapfrog the carried turn.
    if (!sequenced) {
      sequenced = agent.inbox.nextTurn.some(message => message.source.kind === 'user')
    }
    const signature = JSON.stringify(notifications.map(({ item }) => [
      item.thread.threadRef, item.thread.revision, item.unreadCount, item.directCount, item.newestSequence,
    ]))
    if (this.notifiedInbox.get(member.memberId) === signature) return
    // The fresh-start policy's dispatch gate: an armed Member (its last turn
    // completed with the marker) renews BEFORE a dispatch wake is read — the
    // new task lands in the fresh generation's system context, not the
    // finished task's log. Only structured direct work (a mention's unread,
    // directCount > 0) is a dispatch: Thread chatter, Task-activity notices
    // (an acceptance the Member waits on), and DMs — which are pure session
    // relay and never a new task — never spend the arm. A sender that marks
    // its dispatch as needing the live context exempts that delivery by ledger
    // sequence. While a reset is in flight every wake stays held behind it —
    // except once the renewal has landed, because the renewal's own re-derived
    // delivery runs through this same call and the signature dedupe would then
    // swallow it. The body's exit re-derives any still-held delivery, so
    // gating never loses the work.
    if (member.contextStartPolicy === 'fresh') {
      const renewalLanded = this.renewedSessionByMember.get(member.memberId) === member.sessionId
      // A sender that declared this work needs the Member's live context
      // exempts the direct work it named: only a mention newer than that
      // declaration is a fresh task seam worth judging at all.
      const keptSequence = this.keptDispatchSequence.get(member.memberId) ?? 0
      // The judgement is about THIS dispatch, never about the backlog: an older
      // mention the Member has read around without closing is still unread, and
      // folding it in would let one related message keep every later unrelated
      // task alive. Only the newest direct work decides.
      const directMessages = notifications
        .flatMap(({ item, facts }) => item.directCount > 0 ? facts : [])
        .filter((fact): fact is AgentTeamThreadReadFact & { readonly fact: Extract<AgentTeamStoredThreadFact, { kind: 'message' }> } =>
          fact.direct && fact.fact.kind === 'message' && fact.fact.sequence > keptSequence)
      const newestSequence = directMessages.reduce((highest, fact) => Math.max(highest, fact.fact.sequence), 0)
      const assignment = directMessages
        .filter(fact => fact.fact.sequence === newestSequence)
        .map(fact => fact.fact.message.body)
        .join('\n')
      // Whether this dispatch continues the Member's finished work is a semantic
      // call, so the model makes it — but only when the Workspace has a designated
      // leader who owns that judgement. The wake stays held while the call runs:
      // a keep exempts this delivery, anything else renews before it lands.
      if (this.judgingFreshStart.has(member.memberId)) return
      if (assignment !== '' && this.armedFreshStartReset.has(member.memberId)) {
        this.judgeFreshStartDispatch(member, newestSequence, assignment)
        return
      }
      const held = this.pendingPolicyResets.has(member.memberId) && !renewalLanded
      if (held && this.scheduleFreshStartReset(member.memberId)) return
    }
    const pending = [...agent.inbox.nextStep, ...agent.inbox.nextTurn]
    // steerResume already combines the recovery instruction and these durable
    // facts. Its synchronous running transition must not replace that notice.
    if (pending.some(message => this.isRecoveryNotice(message))) {
      this.notifiedInbox.set(member.memberId, signature)
      return
    }
    const existingInboxHint = pending.find(message => this.isInboxNotice(message))
    if (existingInboxHint !== undefined) agent.inbox.remove(existingInboxHint.id)
    const hint = createUserMessage({
      content: [{ type: 'text', text: this.notificationText(notifications, member.memberId) }],
      source: { kind: AGENT_TEAM_PLUGIN_ID, form: 'notice', summary: INBOX_NOTICE_SUMMARY },
    })
    this.notifiedInbox.set(member.memberId, signature)
    try {
      // Steer normally claims the nearest step boundary — which would
      // preempt carried input that a rollover or crash recovery queued as
      // ordinary next-turn messages. The sequenced mode enqueues the
      // rederived Inbox as its own follow-up turn instead, so the delivery
      // order stays handoff → carried input → rederived Inbox.
      if (sequenced) agent.followup(hint)
      else agent.steer(hint)
    } catch (error) {
      this.clearMemberNotificationState(member.memberId)
      throw error
    }
  }

  private isInboxNotice(message: UserMessage): boolean {
    const source = message.source
    return isAgentTeamSource(source)
      && source.form === 'notice' && source.summary === INBOX_NOTICE_SUMMARY
  }

  private isRecoveryNotice(message: UserMessage): boolean {
    const source = message.source
    return isAgentTeamSource(source)
      && source.form === 'notice' && source.summary === RECOVERY_NOTICE_SUMMARY
  }

  /**
   * Group key when one unread direct Message is a Host-posted recurring notice
   * whose deliveries supersede each other — a continuation nudge (one group per
   * Workspace) or a context-reset announcement (one group per announcing
   * Member and Workspace). Each newer delivery restates the full current state,
   * so an older unread instance carries no information and must not be
   * re-rendered into a Member's bounded notification context. Any other Message
   * has no key and always renders.
   */
  private recurringNoticeKey(fact: AgentTeamThreadFact, workspaceId: WorkspaceId): string | undefined {
    if (fact.kind !== 'message') return undefined
    const body = fact.message.body
    const firstLine = body.slice(0, body.includes('\n') ? body.indexOf('\n') : body.length)
    if (firstLine.includes(CONTINUATION_NUDGE_MARKER)) return `continuation\u0000${workspaceId}`
    if (body.startsWith(CONTEXT_RESET_NOTICE_MARKER)) return `reset\u0000${workspaceId}\u0000${fact.message.sender}`
    return undefined
  }

  private notificationText(notifications: ReturnType<AgentTeamLedger['notificationFacts']>, readerId?: AgentTeamMemberId): string {
    const maxCharacters = 32 * 1024
    const sections: string[] = ['Team Inbox has unread work.']
    let characterCount = sections[0]!.length
    let detailedFactCount = 0
    // Supersede pass: the newest sequence of each recurring-notice group, read
    // across every notification, not just the rendered slice.
    const noticeKeyOf = (entry: AgentTeamThreadReadFact, workspaceId: WorkspaceId): string | undefined =>
      entry.direct && entry.fact.kind === 'message' ? this.recurringNoticeKey(entry.fact, workspaceId) : undefined
    const newestNoticeSequence = new Map<string, number>()
    for (const { item, facts } of notifications) {
      for (const entry of facts) {
        const key = noticeKeyOf(entry, item.workspaceId)
        if (key !== undefined && (newestNoticeSequence.get(key) ?? -1) < entry.fact.sequence) newestNoticeSequence.set(key, entry.fact.sequence)
      }
    }
    const supersededKeyOf = (entry: AgentTeamThreadReadFact, workspaceId: WorkspaceId): string | undefined => {
      const key = noticeKeyOf(entry, workspaceId)
      return key !== undefined && (newestNoticeSequence.get(key) ?? -1) > entry.fact.sequence ? key : undefined
    }
    // Superseded instances never render, and their Threads' slots free up:
    // only Notifications with something left to say compete for the bounded
    // item budget. Each superseded instance is counted for the summary line.
    const supersededCounts = new Map<string, number>()
    const renderable = notifications.flatMap(({ item, facts }) => {
      const kept = facts.filter(entry => {
        const key = supersededKeyOf(entry, item.workspaceId)
        if (key === undefined) return true
        supersededCounts.set(key, (supersededCounts.get(key) ?? 0) + 1)
        return false
      })
      return kept.length === 0 ? [] : [Object.freeze({ item, facts: Object.freeze(kept) })]
    })
    let omitted = renderable.length > 8
    const append = (section: string): boolean => {
      if (characterCount + section.length + 2 > maxCharacters) {
        omitted = true
        return false
      }
      sections.push(section)
      characterCount += section.length + 2
      return true
    }
    for (const { item, facts } of renderable.slice(0, 8)) {
      if (!append(`Workspace: ${item.workspaceId}\nChannel: ${item.channelRef}`)) break
      for (const { fact, direct } of facts) {
        if (detailedFactCount >= 20) {
          omitted = true
          break
        }
        if (direct && fact.kind === 'message') {
          const sender = fact.message.sender === AGENT_TEAM_HUMAN_MEMBER_ID
            ? 'human'
            : fact.message.sender === AGENT_TEAM_ASSISTANT_MEMBER_ID
              ? AGENT_TEAM_ASSISTANT_HANDLE
              : this.requireLedger().getMember(fact.message.sender)?.handle ?? fact.message.sender
          const detail = ['Direct Team mention', `Occurred at: ${formatTeamTimestamp(fact.occurredAt)}`, `From: ${sender}`, `Channel: ${item.channelRef}`,
            ...(item.task === undefined ? [] : [`Task: ${item.task.taskRef}`]),
            `Thread: ${item.thread.threadRef}`, `Message ref: ${fact.message.messageRef}`,
            `Message: ${this.boundedNotificationBody(fact.message.body)}`].join('\n')
          if (append(detail)) detailedFactCount += 1
        } else if (fact.kind === 'activity') {
          const detail = `${this.activityNotification(fact.activity, readerId)}\nOccurred at: ${formatTeamTimestamp(fact.occurredAt)}\nThread: ${item.thread.threadRef}`
          if (append(detail)) detailedFactCount += 1
        }
      }
      const ordinary = facts.filter(entry => entry.fact.kind === 'message' && !entry.direct)
      if (ordinary.length > 0) {
        const route = item.task === undefined ? `Thread ${item.thread.threadRef}` : `Task ${item.task.taskRef}`
        append(`${route}: ${ordinary.length} unread update${ordinary.length === 1 ? '' : 's'} · newest at ${formatTeamTimestamp(ordinary.at(-1)!.fact.occurredAt)}.`)
      }
    }
    if (supersededCounts.size > 0) {
      const parts = [...supersededCounts].map(([key, count]) => `${count} earlier ${key.startsWith('continuation') ? 'continuation check' : 'context-reset notice'}${count === 1 ? '' : 's'}`)
      sections.push(`Superseded Team notices are omitted from this context: ${parts.join(', ')} — only the newest delivery of each kind still carries current information.`)
    }
    if (omitted) sections.push('More unread work remains in team_inbox; the automatic context is bounded.')
    sections.push('Use team_thread read with the relevant workspace and threadRef before acting or replying. Use team_inbox only when you need to triage the remaining Threads.')
    return sections.join('\n\n')
  }

  private boundedNotificationBody(body: string): string {
    const limit = 8 * 1024
    return body.length <= limit ? body : `${body.slice(0, limit)}\n[Message body truncated; use team_thread read for the full Message.]`
  }

  private activityNotification(activity: AgentTeamActivity, readerId?: AgentTeamMemberId): string {
    const actor = activity.actor === AGENT_TEAM_HUMAN_MEMBER_ID
      ? 'human'
      : activity.actor === AGENT_TEAM_ASSISTANT_MEMBER_ID
        ? AGENT_TEAM_ASSISTANT_HANDLE
        : this.requireLedger().getMember(activity.actor)?.handle ?? activity.actor
    // An acceptance concludes the reader's own Claims in two ways: a Claim
    // already finished before the accept was accepted (its work stands), and
    // a still-open Claim the accept completed atomically (no further work is
    // needed). Both must be said plainly, or the owner keeps working on a
    // done Task or never learns its contribution was accepted.
    if (activity.kind === 'accept' && activity.actor === AGENT_TEAM_HUMAN_MEMBER_ID && readerId !== undefined) {
      const acceptedOwn = (activity.acceptedClaimRefs ?? []).filter(claimRef => this.requireLedger().getClaim(claimRef)?.owner === readerId)
      const completedOwn = (activity.completedClaimRefs ?? []).filter(claimRef => this.requireLedger().getClaim(claimRef)?.owner === readerId)
      // The early-accept-only reader holds no finished Claim: every own Claim
      // was completed atomically, so the "finished Claim" clause's ref list
      // would be empty. Render the completed semantics alone instead of a
      // sentence with a dangling empty list.
      const finishedOwn = acceptedOwn.filter(claimRef => !completedOwn.includes(claimRef))
      if (completedOwn.length > 0 && finishedOwn.length > 0) {
        return `Team Task update\n${actor} accepted Task ${activity.taskRef}. Your Claim ${completedOwn.join(', ')} was completed with the acceptance, and your finished Claim ${finishedOwn.join(', ')} was accepted. No further work is needed.`
      }
      if (completedOwn.length > 0) {
        return `Team Task update\n${actor} accepted Task ${activity.taskRef} and your open Claim ${completedOwn.join(', ')} was completed with it. No further work is needed.`
      }
      if (acceptedOwn.length > 0) {
        return `Team Task update\n${actor} accepted Task ${activity.taskRef}; your finished Claim ${acceptedOwn.join(', ')} was accepted. No further work is needed.`
      }
    }
    if (activity.kind === 'claim' || activity.kind === 'done' || activity.kind === 'release') {
      return `Team Task update\n${actor} ${activity.kind} Claim ${activity.claimRef} on Task ${activity.taskRef}.`
    }
    if (activity.kind === 'claims_released') {
      return `Team Task update\n${actor}'s Claims ${activity.claimRefs.join(', ')} were released on Task ${activity.taskRef}.`
    }
    if (activity.kind === 'promote') {
      return `Team Task update\n${actor} created Task ${activity.taskRef} from Thread ${activity.threadRef}; it is open for claims.`
    }
    const released = 'releasedClaimRefs' in activity && activity.releasedClaimRefs !== undefined && activity.releasedClaimRefs.length > 0
      ? ` Released Claims: ${activity.releasedClaimRefs.join(', ')}.` : ''
    return `Team Task update\n${actor} ${activity.kind} Task ${activity.taskRef}.${released}`
  }

  /** Dispose one live Member Session and drop its per-Member runtime state. */
  private async disposeMemberSession(memberId: AgentTeamMemberId, member: Pick<AgentTeamAgentMember, 'memberId' | 'sessionId'>): Promise<void> {
    this.clearMemberRecoveryState(member)
    const handle = this.handles.get(memberId)
    if (handle !== undefined) {
      await handle.dispose()
      this.handles.delete(memberId)
    }
    this.memberBySessionId.delete(member.sessionId)
    this.modelSelections.delete(memberId)
    this.memberRuntime.forgetMember(memberId)
    this.clearMemberFailure(memberId, 'activation')
  }

  private clearMemberRecoveryState(member: Pick<AgentTeamAgentMember, 'memberId' | 'sessionId'>): void {
    this.recovery.stopTracking(member.memberId)
    this.clearMemberFailure(member.memberId, 'runtime')
    this.clearMemberNotificationState(member.memberId)
  }

  private clearMemberNotificationState(memberId: AgentTeamMemberId): void {
    this.notifiedInbox.delete(memberId)
  }

  /**
   * Wake waiters for one committed or lifecycle change. Undefined broadcasts
   * to everyone; an empty scope list invalidates nobody because no shared
   * projection changed; otherwise global and matching scoped waiters wake.
   * Presence-only scopes sit outside that: they change no durable projection,
   * so only matching presence waiters wake and the scope-less Inbox
   * subscriptions stay parked.
   *
   * Each woken waiter receives the version of its own scope's domain, so a
   * wake can never hand a projection waiter a presence number or the other way
   * around. Nothing here advances the projection version.
   */
  private emitChanged(scopes?: readonly AgentTeamChangeScope[]): void {
    const touchesProjection = scopes === undefined || scopes.some(scope => scope.kind !== 'presence')
    const touchesPresence = scopes !== undefined && scopes.some(scope => scope.kind === 'presence')
    if (!touchesProjection && !touchesPresence) return
    if (touchesPresence) this.presenceEpoch += 1
    for (const waiter of this.changeWaiters) {
      const waiterScope = waiter.scope
      if (scopes !== undefined && (waiterScope === undefined ? !touchesProjection : !scopes.some(scope => sameChangeScope(scope, waiterScope)))) continue
      waiter.wake(this.changeVersionOf(waiterScope))
    }
  }

  /**
   * The cursor domain of one scope: presence scopes count process-local edge
   * wakes, every other scope compares against the durable ledger position of
   * the newest shared-projection commit. The two domains are deliberately
   * separate, so a presence edge cannot invalidate a projection subscriber and
   * a private read invalidates no one.
   */
  private changeVersionOf(scope: AgentTeamChangeScope | undefined): number {
    if (scope?.kind === 'presence') return this.presenceEpoch
    return this.ledger?.projectionSequence() ?? 0
  }

  private validateChangeScope(scope: AgentTeamChangeScope | undefined): AgentTeamChangeScope | undefined {
    if (scope === undefined) return undefined
    const ref = scope.kind === 'workspace' || scope.kind === 'presence' ? scope.workspaceId : scope.kind === 'channel' ? scope.channelRef : scope.threadRef
    if (typeof ref !== 'string' || ref.length === 0) throw new Error(`change scope of kind '${scope.kind}' requires a non-empty ref`)
    return scope
  }

  private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    this.requireAccepting()
    const result = this.lifecycleTail.then(operation)
    this.lifecycleTail = result.then(() => {}, () => {})
    return result
  }
}
