import { useSyncExternalStore } from 'react'
import type { TeamConversationProps } from './slots.ts'
import { useHumanIdentity } from './human-identity.ts'
import { TeamChannelPage } from './TeamChannelPage.tsx'
import { TeamInboxPage } from './TeamInboxPage.tsx'
import { TeamSessionHistoryPage } from './TeamSessionHistoryPage.tsx'
import { TeamTasksPage } from './TeamTasksPage.tsx'
import { TeamThreadPage } from './TeamThreadPage.tsx'
import css from './conversation.module.css'

export function TeamConversation({ t, useWorkspaces, navigation, drafts, humanIdentity, putAttachment, getAttachment, loadChannels, readThread, loadThreadHistory, threadObservations, summarizeThread, subscribeChanges, loadMembers, loadInbox, loadTasks, sendMessage, joinChannel, removeChannelMember, reply, editMessage, recallMessage, changeTask, changeTasks, promoteThread, selectThread, selectChannel, selectWorkspace, backFromThread, backToChannels, resolveTaskRefs, resolveThreadRefs, openMemberSession, loadMemberSessions, loadMemberSessionTranscript, exitSessionHistory }: TeamConversationProps) {
  const navigationState = useSyncExternalStore(navigation.subscribe, navigation.getSnapshot, navigation.getSnapshot)
  // Every seat names and draws the Human from this one projection: the
  // localized fallback stands only until the first profile read lands.
  const identity = useHumanIdentity(humanIdentity)
  const humanName = identity.name ?? t('human')
  const workspaces = useWorkspaces(state => state.items)
  const current = workspaces.find(workspace => workspace.workspaceId === navigationState.workspaceId)
  if (navigationState.inbox === true) {
    // The Inbox page is global: it merges every visible Workspace and needs no
    // selected Workspace. Selecting Inbox clears the Channel/Thread faces, so
    // this face owns the seat while the flag stands. The Human identity rides
    // along for the same reason it rides on the other two faces: a row that
    // names or draws the reader must draw the one identity every seat draws.
    return <TeamInboxPage key="inbox" useWorkspaces={useWorkspaces} loadInbox={loadInbox} subscribeChanges={subscribeChanges} readThread={readThread} selectWorkspace={selectWorkspace} selectThread={selectThread} humanName={humanName} {...(identity.avatarUrl === undefined ? {} : { humanAvatarUrl: identity.avatarUrl })} t={t} />
  }
  if (navigationState.tasks === true) {
    // The Tasks page is global in the same way: it merges every visible
    // Workspace and needs no selected Workspace, and it owns the seat while
    // its navigation flag stands.
    return <TeamTasksPage key="tasks" useWorkspaces={useWorkspaces} loadTasks={loadTasks} subscribeChanges={subscribeChanges} selectWorkspace={selectWorkspace} selectThread={selectThread} changeTasks={changeTasks} humanName={humanName} {...(identity.avatarUrl === undefined ? {} : { humanAvatarUrl: identity.avatarUrl })} t={t} />
  }
  if (navigationState.sessionHistory !== undefined) {
    // The session-history page is a durable audit face: it reads the Member's
    // stored lineage through Team-owned remotes that never activate or write
    // a Session, so it renders regardless of the Member's live state and even
    // for a Member archived since. The seat only needs the branded Member id;
    // the roster read behind the header name is resolved inside the page.
    return <TeamSessionHistoryPage key={navigationState.sessionHistory} memberId={navigationState.sessionHistory} loadMembers={loadMembers} loadMemberSessions={loadMemberSessions} loadMemberSessionTranscript={loadMemberSessionTranscript} exitSessionHistory={exitSessionHistory} t={t} />
  }
  if (current !== undefined && navigationState.threadRef !== undefined) {
    return <TeamThreadPage key={navigationState.threadRef} humanName={humanName} {...(identity.avatarUrl === undefined ? {} : { humanAvatarUrl: identity.avatarUrl })} workspaceId={current.workspaceId} putAttachment={putAttachment} threadRef={navigationState.threadRef} {...(navigationState.threadOrigin === undefined ? {} : { threadOrigin: navigationState.threadOrigin })} backFromThread={backFromThread} selectChannel={selectChannel} selectThread={selectThread} resolveTaskRefs={resolveTaskRefs} resolveThreadRefs={resolveThreadRefs} openMemberSession={openMemberSession} {...(navigationState.channelRef === undefined ? {} : { channelRef: navigationState.channelRef })} {...(navigationState.taskRef === undefined ? {} : { taskRef: navigationState.taskRef })} {...(navigationState.taskNumber === undefined ? {} : { taskNumber: navigationState.taskNumber })} drafts={drafts} getAttachment={getAttachment} readThread={readThread} loadChannels={loadChannels} loadThreadHistory={loadThreadHistory} threadObservations={threadObservations} summarizeThread={summarizeThread} subscribeChanges={subscribeChanges} loadMembers={loadMembers} reply={reply} editMessage={editMessage} recallMessage={recallMessage} changeTask={changeTask} promoteThread={promoteThread} t={t} />
  }
  if (current !== undefined && navigationState.channelRef !== undefined) {
    return <TeamChannelPage key={navigationState.channelRef} humanName={humanName} {...(identity.avatarUrl === undefined ? {} : { humanAvatarUrl: identity.avatarUrl })} workspaceId={current.workspaceId} channelRef={navigationState.channelRef} drafts={drafts} putAttachment={putAttachment} getAttachment={getAttachment} loadChannels={loadChannels} subscribeChanges={subscribeChanges} loadMembers={loadMembers} loadInbox={loadInbox} sendMessage={sendMessage} joinChannel={joinChannel} removeChannelMember={removeChannelMember} selectThread={selectThread} selectChannel={selectChannel} backToChannels={backToChannels} resolveTaskRefs={resolveTaskRefs} resolveThreadRefs={resolveThreadRefs} openMemberSession={openMemberSession} t={t} />
  }
  const welcome = current === undefined
    ? { eyebrow: t('teamMode'), title: t('team'), body: t('empty') }
    : { eyebrow: current.title, title: t('channels'), body: t('selectChannelHint') }
  return <main className={css.welcomeSurface} data-team-conversation>
    <div className={css.welcome}>
      <span className={css.welcomeEyebrow}>{welcome.eyebrow}</span>
      <h1>{welcome.title}</h1>
      <p>{welcome.body}</p>
    </div>
  </main>
}
