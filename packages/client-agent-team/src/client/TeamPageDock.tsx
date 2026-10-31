import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from 'react'
import { IconCloseOutlineRegular, IconCompareSplitOutlineRegular, IconFullscreenOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { TeamDockPane, TeamDockStore, TeamDockTab } from './dock.ts'
import { faceOfSnapshot } from './dock.ts'
import type { TeamDockProps } from './slots.ts'
import type { TeamNavigationSnapshot } from './navigation.ts'
import { useHumanIdentity } from './human-identity.ts'
import { TeamChannelPage } from './TeamChannelPage.tsx'
import { TeamInboxPage } from './TeamInboxPage.tsx'
import { TeamMessageCenterPage } from './TeamMessageCenterPage.tsx'
import { TeamSessionHistoryPage } from './TeamSessionHistoryPage.tsx'
import { TeamTasksPage } from './TeamTasksPage.tsx'
import { TeamThreadPage } from './TeamThreadPage.tsx'
import css from './dock.module.css'
import conversationCss from './conversation.module.css'

/** Splits beyond this stop being readable in a column; the button refuses quietly. */
const MAX_PANES = 3

/** Relative pane weight floor, shared with the store's clamp. */
const MIN_PANE_WEIGHT = 0.12

/** One Workspace's display facts, resolved once per dock render. */
interface WorkspaceTitle {
  readonly workspaceId: WorkspaceId
  readonly title: string
}

/**
 * The Team page dock: the right column seat that renders the Team pages —
 * Inbox, Tasks, Message Center, Channels, Threads, session history — as tabs
 * in one or more split panes, beside the conversation the frame keeps in its
 * center. The dock owns browser-kept layout only; what a tab shows is the
 * navigation snapshot's face, and every sidebar entry point lands here through
 * the same face (so a click on a sidebar card always answers, whatever the
 * center currently renders).
 */
export function TeamPageDock(props: TeamDockProps) {
  const { width, viewportWidth, canShow, navigation, dock, syncPresentation, t, useWorkspaces, ...pages } = props
  const navigationState = useSyncExternalStore(navigation.subscribe, navigation.getSnapshot, navigation.getSnapshot)
  const dockState = useSyncExternalStore(dock.subscribe, dock.getSnapshot, dock.getSnapshot)
  const identity = useHumanIdentity(pages.humanIdentity)
  const humanName = identity.name ?? t('human')
  const workspaceItems = useWorkspaces(state => state.items)
  const workspaceTitles: readonly WorkspaceTitle[] = workspaceItems.map(workspace => ({ workspaceId: workspace.workspaceId, title: workspace.title }))
  const panesRef = useRef<HTMLDivElement | null>(null)

  // Every navigation face lands in the dock: a sidebar card, a Channel row, a
  // Thread row, a Back button — the snapshot moves, the dock focuses or opens
  // the tab that stands for it, reopening the dock when it was closed. The
  // effect deliberately does not depend on the dock's own state: a close the
  // Human performed (the toggle, the last pane closed) must not be undone by
  // this sync, and openFace is silent for a face that already owns its tab.
  useEffect(() => {
    if (navigationState.mode !== 'team') return
    const face = faceOfSnapshot(navigationState)
    if (face !== undefined) dock.openFace(face)
  }, [dock, navigationState])

  // A dock reopened with no pane left takes its first tab from the current
  // navigation face, so the sidebar toggle always lands on a real page.
  useEffect(() => {
    if (!dockState.open || dockState.panes.length > 0) return
    const face = faceOfSnapshot(navigationState)
    if (face !== undefined) dock.openFace(face)
  }, [dock, dockState, navigationState])

  // The frame sizes the right column from this report and this report only:
  // the shipped right panel reported hidden on its unmount, and the dock's own
  // presentation rides the persisted mode plus the narrow-viewport fallback.
  const autoFullscreen = viewportWidth < 768
  const shown = dockState.open
  const fullscreen = shown && (dockState.fullscreen || autoFullscreen || canShow !== true)
  const track = shown && !autoFullscreen
  useEffect(() => {
    syncPresentation({ shown, track, fullscreen })
  }, [syncPresentation, shown, track, fullscreen])
  useEffect(() => () => { syncPresentation({ shown: false, track: false, fullscreen: false }) }, [syncPresentation])

  if (!shown) return null
  const maximized = dockState.maximizedPaneId
  const paneList: readonly TeamDockPane[] = dockState.panes

  return (
    <section
      className={css.panel}
      style={{ width: fullscreen ? '100vw' : width } as CSSProperties}
      data-team-dock
      {...(fullscreen ? { 'data-fullscreen': true } : {})}
      aria-label={t('dockTitle')}
    >
      <header className={css.dockHeader}>
        <span className={css.dockTitle}>{t('dockTitle')}</span>
        <div className={css.dockActions}>
          <Tooltip label={t('dockSplit')} side="bottom">
            <button
              type="button"
              className={css.iconButton}
              aria-label={t('dockSplit')}
              disabled={dockState.panes.length === 0 || dockState.panes.length >= MAX_PANES}
              onClick={() => dock.splitPane()}
            >
              <IconCompareSplitOutlineRegular size={16} />
            </button>
          </Tooltip>
          <Tooltip label={dockState.fullscreen ? t('dockRestorePanel') : t('dockMaximizePanel')} side="bottom">
            <button
              type="button"
              className={css.iconButton}
              aria-label={dockState.fullscreen ? t('dockRestorePanel') : t('dockMaximizePanel')}
              aria-pressed={dockState.fullscreen}
              onClick={() => { dock.setFullscreen(!dockState.fullscreen) }}
            >
              <IconFullscreenOutlineRegular size={16} />
            </button>
          </Tooltip>
          <Tooltip label={t('dockClosePanel')} side="bottom">
            <button
              type="button"
              className={css.iconButton}
              aria-label={t('dockClosePanel')}
              onClick={() => { dock.setOpen(false) }}
            >
              <IconCloseOutlineRegular size={16} />
            </button>
          </Tooltip>
        </div>
      </header>
      <div className={css.panes} ref={panesRef}>
        {paneList.map((pane, index) => (
          <PaneSection
            key={pane.id}
            pane={pane}
            hidden={maximized !== undefined && maximized !== pane.id}
            divider={index > 0 ? <PaneDivider top={paneList[index - 1]!} bottom={pane} containerRef={panesRef} onResize={dock.setPaneSize} /> : undefined}
            maximized={maximized === pane.id}
            dock={dock}
            navigationState={navigationState}
            workspaceTitles={workspaceTitles}
            humanName={humanName}
            {...(identity.avatarUrl === undefined ? {} : { humanAvatarUrl: identity.avatarUrl })}
            pages={pages}
            t={t}
            useWorkspaces={useWorkspaces}
          />
        ))}
      </div>
    </section>
  )
}

/** Everything the pane renderer reads beyond the dock store, the seat geometry, the locale, and the global hooks. */
type PanePages = Omit<TeamDockProps, 'width' | 'viewportWidth' | 'canShow' | 'navigation' | 'dock' | 'syncPresentation' | 't' | 'useWorkspaces'>

/** One pane: its tab strip, its per-pane actions, and every tab body kept mounted. */
function PaneSection(props: {
  pane: TeamDockPane
  hidden: boolean
  divider?: ReactNode
  maximized: boolean
  dock: TeamDockStore
  navigationState: TeamNavigationSnapshot
  workspaceTitles: readonly WorkspaceTitle[]
  humanName: string
  humanAvatarUrl?: string
  pages: PanePages
  t: TeamDockProps['t']
  useWorkspaces: TeamDockProps['useWorkspaces']
}) {
  const { pane, hidden, divider, maximized, dock, navigationState, workspaceTitles, humanName, pages, t } = props
  const paneRef = useRef<HTMLDivElement | null>(null)
  // The tab's own Workspace names its page and its title; tabs that carry none
  // fall back to the browsed Workspace.
  const tabWorkspaceId = (tab: TeamDockTab): WorkspaceId | undefined => tab.workspaceId ?? navigationState.workspaceId
  const titleOf = (workspaceId: WorkspaceId | undefined): string | undefined =>
    workspaceTitles.find(workspace => workspace.workspaceId === workspaceId)?.title

  const activateTab = (tab: TeamDockTab): void => {
    dock.focusTab(pane.id, tab.id)
    pages.restoreTabFace(tab)
  }

  /** Refocus the pane's live tab after a close, so keyboard flow never drops. */
  const refocusActiveTab = (): void => {
    queueMicrotask(() => { paneRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus() })
  }

  const onTablistKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    const index = pane.tabs.findIndex(tab => tab.id === pane.activeTabId)
    if (index === -1) return
    const next = event.key === 'ArrowLeft'
      ? pane.tabs[(index + pane.tabs.length - 1) % pane.tabs.length]!
      : pane.tabs[(index + 1) % pane.tabs.length]!
    event.preventDefault()
    activateTab(next)
    refocusActiveTab()
  }

  return (
    <>
      {divider}
      <div
        ref={paneRef}
        className={hidden ? css.paneHidden : css.pane}
        style={{ flexGrow: pane.size }}
        data-team-dock-pane
        aria-hidden={hidden || undefined}
      >
        <div className={css.paneHeader} role="tablist" aria-label={t('dockTitle')} onKeyDown={onTablistKeyDown}>
          {pane.tabs.map(tab => (
            <div
              key={tab.id}
              role="tab"
              tabIndex={tab.id === pane.activeTabId ? 0 : -1}
              aria-selected={tab.id === pane.activeTabId}
              className={css.tab}
              data-team-dock-tab
              onClick={() => { activateTab(tab) }}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  activateTab(tab)
                }
              }}
            >
              <span className={css.tabLabel}>{tabLabel(tab, titleOf(tabWorkspaceId(tab)), t)}</span>
              <button
                type="button"
                className={css.tabClose}
                aria-label={t('dockCloseTab')}
                tabIndex={tab.id === pane.activeTabId ? 0 : -1}
                onClick={event => {
                  event.stopPropagation()
                  dock.closeTab(pane.id, tab.id)
                  refocusActiveTab()
                }}
                onKeyDown={event => event.stopPropagation()}
              >
                <IconCloseOutlineRegular size={12} />
              </button>
            </div>
          ))}
          <div className={css.paneActions}>
            <Tooltip label={maximized ? t('dockRestorePane') : t('dockMaximizePane')} side="bottom">
              <button
                type="button"
                className={css.iconButton}
                aria-label={maximized ? t('dockRestorePane') : t('dockMaximizePane')}
                aria-pressed={maximized}
                onClick={() => { dock.toggleMaximize(pane.id) }}
              >
                <IconFullscreenOutlineRegular size={14} />
              </button>
            </Tooltip>
            <Tooltip label={t('dockClosePane')} side="bottom">
              <button
                type="button"
                className={css.iconButton}
                aria-label={t('dockClosePane')}
                onClick={() => { dock.closePane(pane.id) }}
              >
                <IconCloseOutlineRegular size={14} />
              </button>
            </Tooltip>
          </div>
        </div>
        {/* One body mounts per pane — the active tab's. The pages read their
            projections on mount, so a remount on every switch is what keeps a
            re-opened tab current; a kept-mounted background page would show
            the stale queue it held when it went dark. */}
        {(() => {
          const active = pane.tabs.find(tab => tab.id === pane.activeTabId)
          if (active === undefined) return null
          return (
            <div
              key={active.id}
              role="tabpanel"
              aria-label={tabLabel(active, titleOf(tabWorkspaceId(active)), t)}
              className={css.body}
              data-team-dock-body
            >
              <TeamPageSurface tab={active} navigationState={navigationState} workspaceTitles={workspaceTitles} humanName={humanName} {...(props.humanAvatarUrl === undefined ? {} : { humanAvatarUrl: props.humanAvatarUrl })} t={t} useWorkspaces={props.useWorkspaces} {...pages} />
            </div>
          )
        })()}
      </div>
    </>
  )
}

function tabLabel(tab: TeamDockTab, workspaceTitle: string | undefined, t: TeamDockProps['t']): string {
  switch (tab.kind) {
    case 'overview': return workspaceTitle ?? t('team')
    case 'inbox': return t('inboxTitle')
    case 'tasks': return t('tasksTitle')
    case 'messages': return t('messagesTitle')
    case 'channel': return t('channelTab')
    case 'thread': return t('threadTab')
    case 'sessionHistory': return t('historyTab')
  }
}

/**
 * One vertical divider: pointer capture plus a rAF-throttled dy, converted to
 * relative pane weights against the panes container's height.
 */
function PaneDivider(props: { top: TeamDockPane; bottom: TeamDockPane; containerRef: RefObject<HTMLDivElement | null>; onResize: (paneId: string, size: number) => void }) {
  const { top, bottom, containerRef, onResize } = props
  const [dragging, setDragging] = useState(false)
  const origin = useRef(0)
  const latest = useRef(0)
  const frame = useRef<number | null>(null)
  const capture = useRef<{ element: HTMLDivElement; id: number } | null>(null)
  const callbacks = useRef({ top, bottom, onResize })
  callbacks.current = { top, bottom, onResize }

  const apply = (): void => {
    const container = containerRef.current
    if (container === null) return
    const { top: topPane, bottom: bottomPane, onResize: resize } = callbacks.current
    const unit = container.clientHeight / (topPane.size + bottomPane.size)
    if (!Number.isFinite(unit) || unit <= 0) return
    const delta = (latest.current - origin.current) / unit
    const nextTop = Math.min(Math.max(topPane.size + delta, MIN_PANE_WEIGHT), topPane.size + bottomPane.size - MIN_PANE_WEIGHT)
    resize(topPane.id, nextTop)
    resize(bottomPane.id, topPane.size + bottomPane.size - nextTop)
  }

  const endDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    const active = capture.current
    if (active?.id !== event.pointerId) return
    capture.current = null
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null }
    if (active.element.hasPointerCapture(active.id)) active.element.releasePointerCapture(active.id)
    setDragging(false)
  }

  return (
    <div
      className={css.divider}
      role="separator"
      aria-orientation="horizontal"
      data-dragging={dragging || undefined}
      onPointerDown={event => {
        if (event.button !== 0 || capture.current !== null) return
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        capture.current = { element: event.currentTarget, id: event.pointerId }
        origin.current = event.clientY
        latest.current = event.clientY
        setDragging(true)
      }}
      onPointerMove={event => {
        if (capture.current?.id !== event.pointerId) return
        latest.current = event.clientY
        frame.current ??= requestAnimationFrame(() => {
          frame.current = null
          apply()
        })
      }}
      onPointerUp={endDrag}
      onLostPointerCapture={endDrag}
    />
  )
}

/**
 * The page a tab stands for, dispatched off the tab's face. The workspace the
 * tab was opened under is authoritative — a background tab keeps its own
 * Workspace even after the Human browses another one — falling back to the
 * snapshot's selection for tabs that carry none.
 */
function TeamPageSurface(props: { tab: TeamDockTab; navigationState: TeamNavigationSnapshot; workspaceTitles: readonly WorkspaceTitle[]; humanName: string; humanAvatarUrl?: string; t: TeamDockProps['t']; useWorkspaces: TeamDockProps['useWorkspaces'] } & PanePages) {
  const { tab, navigationState, workspaceTitles, humanName, humanAvatarUrl, t, useWorkspaces, ...pages } = props
  const workspaceId = tab.workspaceId ?? navigationState.workspaceId
  const workspaceTitle = workspaceTitles.find(workspace => workspace.workspaceId === workspaceId)?.title
  switch (tab.kind) {
    case 'overview':
      return <WelcomeSurface {...(workspaceId === undefined ? {} : { workspaceId })} {...(workspaceTitle === undefined ? {} : { workspaceTitle })} t={t} />
    case 'inbox':
      return <TeamInboxPage key={tab.id} useWorkspaces={useWorkspaces} loadInbox={pages.loadInbox} subscribeChanges={pages.subscribeChanges} readThread={pages.readThread} selectWorkspace={pages.selectWorkspace} selectThread={pages.selectThread} humanName={humanName} {...(humanAvatarUrl === undefined ? {} : { humanAvatarUrl })} t={t} />
    case 'tasks':
      return <TeamTasksPage key={tab.id} useWorkspaces={useWorkspaces} loadTasks={pages.loadTasks} subscribeChanges={pages.subscribeChanges} selectWorkspace={pages.selectWorkspace} selectThread={pages.selectThread} changeTasks={pages.changeTasks} humanName={humanName} {...(humanAvatarUrl === undefined ? {} : { humanAvatarUrl })} t={t} />
    case 'messages':
      return <TeamMessageCenterPage key={tab.id} useWorkspaces={useWorkspaces} loadMessageCenter={pages.loadMessageCenter} loadChannels={pages.loadChannels} readThread={pages.readThread} reply={pages.reply} subscribeChanges={pages.subscribeChanges} selectWorkspace={pages.selectWorkspace} selectThread={pages.selectThread} humanName={humanName} {...(humanAvatarUrl === undefined ? {} : { humanAvatarUrl })} t={t} />
    case 'sessionHistory':
      return <TeamSessionHistoryPage key={tab.id} memberId={tab.memberId!} {...(workspaceId === undefined ? {} : { workspaceId })} loadMembers={pages.loadMembers} loadMemberSessions={pages.loadMemberSessions} loadMemberSessionTranscript={pages.loadMemberSessionTranscript} loadExternalContext={pages.loadExternalContext} exitSessionHistory={pages.exitSessionHistory} t={t} />
    case 'thread': {
      if (workspaceId === undefined || tab.threadRef === undefined) {
        return <WelcomeSurface {...(workspaceId === undefined ? {} : { workspaceId })} {...(workspaceTitle === undefined ? {} : { workspaceTitle })} t={t} />
      }
      // The one-shot locate anchor replays only while this tab is the face the
      // snapshot names; a background restore never scrolls anywhere.
      const face = faceOfSnapshot(navigationState)
      const isFace = face?.kind === 'thread' && face.threadRef === tab.threadRef
      return <TeamThreadPage key={tab.id} humanName={humanName} {...(humanAvatarUrl === undefined ? {} : { humanAvatarUrl })} workspaceId={workspaceId} putAttachment={pages.putAttachment} threadRef={tab.threadRef} {...(tab.threadOrigin === undefined ? {} : { threadOrigin: tab.threadOrigin })} {...(isFace && navigationState.focusSequence !== undefined ? { focusSequence: navigationState.focusSequence } : {})} backFromThread={pages.backFromThread} selectChannel={pages.selectChannel} selectThread={pages.selectThread} resolveTaskRefs={pages.resolveTaskRefs} resolveThreadRefs={pages.resolveThreadRefs} openMemberSession={pages.openMemberSession} {...(tab.channelRef === undefined ? {} : { channelRef: tab.channelRef })} {...(tab.taskRef === undefined ? {} : { taskRef: tab.taskRef })} {...(tab.taskNumber === undefined ? {} : { taskNumber: tab.taskNumber })} drafts={pages.drafts} getAttachment={pages.getAttachment} readThread={pages.readThread} loadChannels={pages.loadChannels} loadThreadHistory={pages.loadThreadHistory} threadObservations={pages.threadObservations} summarizeThread={pages.summarizeThread} subscribeChanges={pages.subscribeChanges} loadMembers={pages.loadMembers} reply={pages.reply} editMessage={pages.editMessage} recallMessage={pages.recallMessage} changeTask={pages.changeTask} promoteThread={pages.promoteThread} t={t} />
    }
    case 'channel': {
      if (workspaceId === undefined || tab.channelRef === undefined) {
        return <WelcomeSurface {...(workspaceId === undefined ? {} : { workspaceId })} {...(workspaceTitle === undefined ? {} : { workspaceTitle })} t={t} />
      }
      return <TeamChannelPage key={tab.id} humanName={humanName} {...(humanAvatarUrl === undefined ? {} : { humanAvatarUrl })} workspaceId={workspaceId} channelRef={tab.channelRef} drafts={pages.drafts} putAttachment={pages.putAttachment} getAttachment={pages.getAttachment} loadChannels={pages.loadChannels} subscribeChanges={pages.subscribeChanges} loadMembers={pages.loadMembers} loadInbox={pages.loadInbox} sendMessage={pages.sendMessage} joinChannel={pages.joinChannel} removeChannelMember={pages.removeChannelMember} selectThread={pages.selectThread} selectChannel={pages.selectChannel} backToChannels={pages.backToChannels} resolveTaskRefs={pages.resolveTaskRefs} resolveThreadRefs={pages.resolveThreadRefs} openMemberSession={pages.openMemberSession} t={t} />
    }
  }
}

/** The overview body: the Workspace's title and the pick-a-Channel hint. */
function WelcomeSurface({ workspaceId, workspaceTitle, t }: { workspaceId?: WorkspaceId; workspaceTitle?: string; t: TeamDockProps['t'] }) {
  const welcome = workspaceId === undefined
    ? { eyebrow: t('teamMode'), title: t('team'), body: t('empty') }
    : { eyebrow: workspaceTitle ?? workspaceId, title: t('channels'), body: t('selectChannelHint') }
  return <main className={conversationCss.welcomeSurface} data-team-dock-welcome>
    <div className={conversationCss.welcome}>
      <span className={conversationCss.welcomeEyebrow}>{welcome.eyebrow}</span>
      <h1>{welcome.title}</h1>
      <p>{welcome.body}</p>
    </div>
  </main>
}
