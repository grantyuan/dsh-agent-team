import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  AgentTeamAddMemberRequest,
  AgentTeamArchiveChannelRequest,
  AgentTeamArchiveChannelResult,
  AgentTeamArchiveMemberRequest,
  AgentTeamArchiveMemberResult,
  AgentTeamChannelRef,
  AgentTeamClientMemberStatus,
  AgentTeamClearMemberContextRequest,
  AgentTeamClearMemberContextResult,
  AgentTeamCompactMemberContextRequest,
  AgentTeamCompactMemberContextResult,
  AgentTeamCurateMemberPromptRequest,
  AgentTeamCurateMemberPromptResult,
  AgentTeamCreateChannelRequest,
  AgentTeamCreateChannelResult,
  AgentTeamDiagnoseMemberRequest,
  AgentTeamDiagnoseMemberResult,
  AgentTeamInbox,
  AgentTeamInboxRequest,
  AgentTeamJoinWorkspaceRequest,
  AgentTeamJoinWorkspaceResult,
  AgentTeamLeaveWorkspaceRequest,
  AgentTeamLeaveWorkspaceResult,
  AgentTeamJoinChannelRequest,
  AgentTeamJoinChannelResult,
  AgentTeamGetAttachmentRequest,
  AgentTeamGetAttachmentResult,
  AgentTeamPutAttachmentRequest,
  AgentTeamPutAttachmentResult,
  AgentTeamMemberInterrupts,
  AgentTeamMemberInterruptsRequest,
  AgentTeamMemberResult,
  AgentTeamMemberPromptView,
  AgentTeamMemberPromptViewRequest,
  AgentTeamMemberSessionsRequest,
  AgentTeamMemberSessionSummary,
  AgentTeamMemberSessionTranscript,
  AgentTeamMemberSessionTranscriptRequest,
  AgentTeamAddMemberResult,
  AgentTeamRecoverMemberRequest,
  AgentTeamRecoverMemberResult,
  AgentTeamMembersRequest,
  AgentTeamRemoveChannelMemberRequest,
  AgentTeamRemoveChannelMemberResult,
  AgentTeamResolveMemberInterruptRequest,
  AgentTeamResolveMemberInterruptResult,
  AgentTeamEditMessageRequest,
  AgentTeamEditMessageResult,
  AgentTeamRecallMessageRequest,
  AgentTeamRecallMessageResult,
  AgentTeamReplyRequest,
  AgentTeamResolveTaskRefsRequest,
  AgentTeamResolveTaskRefsResult,
  AgentTeamResolveThreadRefsRequest,
  AgentTeamResolveThreadRefsResult,
  AgentTeamReplyResult,
  AgentTeamConfirmationRequired,
  AgentTeamSummarizeThreadRequest,
  AgentTeamSummarizeThreadResult,
  AgentTeamThreadHistory,
  AgentTeamThreadHistoryRequest,
  AgentTeamThreadObservations,
  AgentTeamThreadObservationsRequest,
  AgentTeamThreadReadRequest,
  AgentTeamThreadReadResult,
  AgentTeamPromoteThreadRequest,
  AgentTeamPromoteThreadResult,
  AgentTeamTaskRequest,
  AgentTeamTaskResult,
  AgentTeamTasks,
  AgentTeamTasksBatchRequest,
  AgentTeamTasksBatchResult,
  AgentTeamTasksRequest,
  AgentTeamMemberTasks,
  AgentTeamMemberTasksRequest,
  AgentTeamSendMessageRequest,
  AgentTeamSendMessageResult,
  AgentTeamUpdateChannelRequest,
  AgentTeamUpdateChannelResult,
  AgentTeamUpdateMemberRequest,
  AgentTeamView,
  AgentTeamViewRequest,
} from '@wowyuarm/dsh-agent-team/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { TeamNavigationActions, TeamNavigationSnapshot } from './navigation.ts'
import type { TeamChangeListener, TeamChangeScope } from './team-changes.ts'
import type { TeamDraftStore } from './drafts.ts'
import type { TeamHumanIdentitySource } from './human-identity.ts'

export interface TeamNavigationSource {
  getSnapshot: () => TeamNavigationSnapshot
  subscribe: (listener: () => void) => () => void
}

/** Subscribe to one projection scope's invalidation stream; disposal aborts the shared poll. */
export type SubscribeTeamChanges = (scope: TeamChangeScope, listener: TeamChangeListener) => () => void

/** One adapter-owned selectable reasoning effort of one model route. */
export interface TeamModelEffortOption {
  readonly id: string
  readonly name: string
}

/** One selectable model row inside one provider group of the Host catalog. */
export interface TeamModelOption {
  readonly id: string
  readonly name: string
  /** Selectable reasoning levels when the adapter exposes them. */
  readonly reasoning?: {
    readonly efforts: readonly TeamModelEffortOption[]
  }
}

/** Provider-grouped slice of the Host model catalog the editors render. */
export interface TeamModelProviderGroup {
  readonly id: string
  readonly name: string
  readonly models: readonly TeamModelOption[]
}

/** Host-scoped catalog load result; per-provider listing failures ride `failures`. */
export interface TeamModelCatalog {
  readonly groups: readonly TeamModelProviderGroup[]
  readonly failures: readonly { readonly id: string; readonly name: string; readonly message: string }[]
}

export type TeamSidebarProps = PropsRuntime<'sidebar.workspaces'>
  & PropsLocale<'team'>
  & TeamNavigationActions
  & {
    navigation: TeamNavigationSource
    loadMembers: (request: AgentTeamMembersRequest) => Promise<RemoteResult<readonly AgentTeamClientMemberStatus[]>>
    /** One Workspace's per-Member working queues behind the Agents panel's task surfaces. */
    loadMemberTasks: (request: AgentTeamMemberTasksRequest) => Promise<RemoteResult<AgentTeamMemberTasks>>
    /**
     * Human-sent Message into one Channel — the Agent panel's only write lane.
     * The task-reassignment consultation rides it: one Message to the Team
     * leader's own Channel naming the Task and the requested taker, and the
     * leader decides and arranges from there.
     */
    sendMessage: (request: AgentTeamSendMessageRequest) => Promise<RemoteResult<AgentTeamSendMessageResult>>
    /** Human direct-only Inbox slice; the badge sums each visible Workspace's total. */
    loadInbox: (request: AgentTeamInboxRequest) => Promise<RemoteResult<AgentTeamInbox>>
    /** Fired after every committed durable Thread read; the badge refreshes without waiting for a changes wake. */
    subscribeReads: (listener: () => void) => () => void
    subscribeChanges: SubscribeTeamChanges
    addMember: (request: AgentTeamAddMemberRequest) => Promise<RemoteResult<AgentTeamAddMemberResult>>
    loadChannels: (request: AgentTeamViewRequest) => Promise<RemoteResult<AgentTeamView>>
    createChannel: (request: AgentTeamCreateChannelRequest) => Promise<RemoteResult<AgentTeamCreateChannelResult>>
    updateChannel: (request: AgentTeamUpdateChannelRequest) => Promise<RemoteResult<AgentTeamUpdateChannelResult>>
    archiveChannel: (request: AgentTeamArchiveChannelRequest) => Promise<RemoteResult<AgentTeamArchiveChannelResult>>
    updateMember: (request: AgentTeamUpdateMemberRequest) => Promise<RemoteResult<AgentTeamMemberResult>>
    /** Fresh Host read behind the Prompt dialog: the stored profile plus the echo inputs its durable edit re-commits. */
    loadPromptView: (request: AgentTeamMemberPromptViewRequest) => Promise<RemoteResult<AgentTeamMemberPromptView>>
    recoverMember: (request: AgentTeamRecoverMemberRequest) => Promise<RemoteResult<AgentTeamRecoverMemberResult>>
    /**
     * Host clear-context remote: the visible "reset" row action renews the
     * Member's Session — identity, memory, and binding survive, the previous
     * log stays archived on disk, and the next turn starts with no history.
     */
    clearMemberContext: (request: AgentTeamClearMemberContextRequest) => Promise<RemoteResult<AgentTeamClearMemberContextResult>>
    /**
     * Host doctor dispatch: create or reuse the durable `doctor` Member, start
     * it on a fresh Session, and hand it the failed Member's transcript as
     * research material. The doctor reports its analysis to the Human.
     */
    diagnoseMember: (request: AgentTeamDiagnoseMemberRequest) => Promise<RemoteResult<AgentTeamDiagnoseMemberResult>>
    /**
     * Schedule an in-place compaction of the Member's live Session, optionally
     * naming the LLM that writes the summary. The Host acknowledges the
     * schedule; the compaction itself runs behind the Member's current
     * activity and never blocks later conversation.
     */
    compactMemberContext: (request: AgentTeamCompactMemberContextRequest) => Promise<RemoteResult<AgentTeamCompactMemberContextResult>>
    /**
     * One Member's pending interrupt stack, newest first, each entry carrying
     * the live lineage verdict the Host walks for it.
     */
    loadMemberInterrupts: (request: AgentTeamMemberInterruptsRequest) => Promise<RemoteResult<AgentTeamMemberInterrupts>>
    /** Human release of one pending interrupt; `resumed` stays the Host's own close. */
    releaseMemberInterrupt: (request: AgentTeamResolveMemberInterruptRequest) => Promise<RemoteResult<AgentTeamResolveMemberInterruptResult>>
    /**
     * One bounded propose-only LLM curation pass behind the Prompt dialog: the
     * Host assembles the Member's live section input and runs a single
     * completion with the Member's effective model. The proposal only ever
     * backfills the dialog's form — nothing persists until the Human saves
     * through the normal update path. The signal cancels an in-flight pass.
     */
    curateMemberPrompt: (request: AgentTeamCurateMemberPromptRequest, signal?: AbortSignal) => Promise<RemoteResult<AgentTeamCurateMemberPromptResult>>
    archiveMember: (request: AgentTeamArchiveMemberRequest) => Promise<RemoteResult<AgentTeamArchiveMemberResult>>
    joinWorkspace: (request: AgentTeamJoinWorkspaceRequest) => Promise<RemoteResult<AgentTeamJoinWorkspaceResult>>
    leaveWorkspace: (request: AgentTeamLeaveWorkspaceRequest) => Promise<RemoteResult<AgentTeamLeaveWorkspaceResult>>
    joinChannel: (request: AgentTeamJoinChannelRequest) => Promise<RemoteResult<AgentTeamJoinChannelResult>>
    removeChannelMember: (request: AgentTeamRemoveChannelMemberRequest) => Promise<RemoteResult<AgentTeamRemoveChannelMemberResult>>
    /** Session-independent Host model catalog (`llm.models`); needs no live Member. */
    loadModels: () => Promise<RemoteResult<TeamModelCatalog>>
    /** Embed the Member's Session conversation in the Team conversation seat. */
    openMemberSession: (sessionId: AgentTeamClientMemberStatus['member']['sessionId']) => void
    selectedChannelRef?: AgentTeamChannelRef
  }

export type TeamConversationProps = PropsRuntime<'main'> & PropsLocale<'team'> & TeamNavigationActions & {
  navigation: TeamNavigationSource
  /** Keyed composer draft cache; one store per Client context. */
  drafts: TeamDraftStore
  /** The Human's own identity: the display name and avatar every seat that names or draws them reads. */
  humanIdentity: TeamHumanIdentitySource
  loadChannels: (request: AgentTeamViewRequest) => Promise<RemoteResult<AgentTeamView>>
  readThread: (request: AgentTeamThreadReadRequest) => Promise<RemoteResult<AgentTeamThreadReadResult>>
  loadThreadHistory: (request: AgentTeamThreadHistoryRequest) => Promise<RemoteResult<AgentTeamThreadHistory>>
  subscribeChanges: SubscribeTeamChanges
  putAttachment: (request: AgentTeamPutAttachmentRequest) => Promise<RemoteResult<AgentTeamPutAttachmentResult>>
  getAttachment: (request: AgentTeamGetAttachmentRequest) => Promise<RemoteResult<AgentTeamGetAttachmentResult>>
  sendMessage: (request: AgentTeamSendMessageRequest) => Promise<RemoteResult<AgentTeamSendMessageResult>>
  joinChannel: (request: AgentTeamJoinChannelRequest) => Promise<RemoteResult<AgentTeamJoinChannelResult>>
  removeChannelMember: (request: AgentTeamRemoveChannelMemberRequest) => Promise<RemoteResult<AgentTeamRemoveChannelMemberResult>>
  reply: (request: AgentTeamReplyRequest) => Promise<RemoteResult<AgentTeamReplyResult | AgentTeamConfirmationRequired>>
  /** Human correction of one Human-sent Message; the Host force-stops its running executors first. */
  editMessage: (request: AgentTeamEditMessageRequest) => Promise<RemoteResult<AgentTeamEditMessageResult>>
  /** Human retraction or deletion of one Human-sent Message, with the same force-stop guarantee. */
  recallMessage: (request: AgentTeamRecallMessageRequest) => Promise<RemoteResult<AgentTeamRecallMessageResult>>
  changeTask: (request: AgentTeamTaskRequest) => Promise<RemoteResult<AgentTeamTaskResult>>
  changeTasks: (request: AgentTeamTasksBatchRequest) => Promise<RemoteResult<AgentTeamTasksBatchResult>>
  promoteThread: (request: AgentTeamPromoteThreadRequest) => Promise<RemoteResult<AgentTeamPromoteThreadResult>>
  resolveTaskRefs: (request: AgentTeamResolveTaskRefsRequest) => Promise<RemoteResult<AgentTeamResolveTaskRefsResult>>
  resolveThreadRefs: (request: AgentTeamResolveThreadRefsRequest) => Promise<RemoteResult<AgentTeamResolveThreadRefsResult>>
  loadMembers: (request: AgentTeamMembersRequest) => Promise<RemoteResult<readonly AgentTeamClientMemberStatus[]>>
  /** Human direct-only Inbox slice; the Inbox page merges one call per visible Workspace. */
  loadInbox: (request: AgentTeamInboxRequest) => Promise<RemoteResult<AgentTeamInbox>>
  /** Human cross-Channel Task list; the Tasks page merges one call per visible Workspace. */
  loadTasks: (request: AgentTeamTasksRequest) => Promise<RemoteResult<AgentTeamTasks>>
  /** Human-only Thread Attention observations; the Thread composer ranks the returned followers first. */
  threadObservations: (request: AgentTeamThreadObservationsRequest) => Promise<RemoteResult<AgentTeamThreadObservations>>
  /** Human one-shot plain-language Thread digest: propose-only, commits nothing. */
  summarizeThread: (request: AgentTeamSummarizeThreadRequest, signal?: AbortSignal) => Promise<RemoteResult<AgentTeamSummarizeThreadResult>>
  /** Agent-card session jump, shared by every slot; message member chips reuse it. */
  openMemberSession: (sessionId: AgentTeamClientMemberStatus['member']['sessionId']) => void
  /**
   * Host read behind the session-history page: every Session generation the
   * Member has run, newest first, folded from the stored `parentSession`
   * lineage. An unreadable ancestor rides as a metadata-less entry and ends
   * the walk.
   */
  loadMemberSessions: (request: AgentTeamMemberSessionsRequest) => Promise<RemoteResult<readonly AgentTeamMemberSessionSummary[]>>
  /**
   * One bounded transcript page of one lineage generation: the generation's
   * own events, newest tail first, older pages reached through the returned
   * cursor. Reads are Team-owned and never activate or write the Session.
   */
  loadMemberSessionTranscript: (request: AgentTeamMemberSessionTranscriptRequest) => Promise<RemoteResult<AgentTeamMemberSessionTranscript>>
}

export type TeamSettingsProps = PropsRuntime<'sidebar.settings'> & PropsLocale<'team'> & {
  loadMemberGroups: () => Promise<readonly TeamMemberGroup[]>
}

export interface TeamMemberGroup {
  readonly workspaceId: string
  readonly workspaceTitle: string
  readonly members: readonly AgentTeamClientMemberStatus[]
}

export type TeamFooterProps = PropsRuntime<'sidebar.footer.action'> & PropsLocale<'team'> & TeamNavigationActions & {
  navigation: TeamNavigationSource
}
