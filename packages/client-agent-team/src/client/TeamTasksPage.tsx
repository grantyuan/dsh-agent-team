import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentTeamMemberId, AgentTeamTaskRow } from '@wowyuarm/dsh-agent-team/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamConversationProps } from './slots.ts'
import { claimersLabel, formatAbsoluteTime, formatInboxTime, formatTaskStatus, taskStatusDot } from './team-formatters.ts'
import { namedAvatarOwners, TeamAvatarStack, type TeamAvatarHuman } from './TeamAvatarStack.tsx'
import { TeamStateDot } from './TeamStateDot.tsx'
import css from './conversation.module.css'
import inboxCss from './inbox.module.css'
import taskCss from './tasks.module.css'

interface TeamTaskRow {
  readonly workspaceId: WorkspaceId
  readonly workspaceTitle: string
  readonly task: AgentTeamTaskRow
}

interface TeamTasksPageProps {
  readonly useWorkspaces: TeamConversationProps['useWorkspaces']
  readonly loadTasks: TeamConversationProps['loadTasks']
  /** Wake source while the page is open: one scope-less subscription, like the Inbox page. */
  readonly subscribeChanges: TeamConversationProps['subscribeChanges']
  readonly selectWorkspace: TeamConversationProps['selectWorkspace']
  readonly selectThread: TeamConversationProps['selectThread']
  /** The Human's display name, from the Client's one identity projection. */
  readonly humanName: string
  readonly humanAvatarUrl?: string | undefined
  readonly t: TeamConversationProps['t']
}

const OPEN_STATES = new Set(['todo', 'in_progress', 'in_review'])
const isOpen = (task: AgentTeamTaskRow): boolean => OPEN_STATES.has(task.status)

/** One top-level Task with the sub-tasks that named it as their parent. */
interface TaskGroup {
  readonly row: TeamTaskRow
  readonly children: readonly TeamTaskRow[]
}

/**
 * The Human Task list: one `tasks` call per visible Workspace, rendering every
 * Task with its live standing and the sub-task trees Agents split underneath.
 * The ledger stays flat, so the tree assembles here — a Task with a
 * `parentTaskRef` renders indented under its parent (which the Host guaranteed
 * lives in the same Channel), with a `{done}/{total}` progress count beside the
 * parent. Rows merge across every Workspace in the Host's own Channel-ordinal
 * order, split into the same two sections the Inbox speaks — open work first,
 * finished work after — so a reader scans what still moves before what stopped.
 * A sub-task whose parent is not in the merged list (archived away, or a
 * one-sided projection gap) falls back to a top-level row, so no Task is ever
 * invisible. Opening a row navigates to its Thread; nothing is acknowledged by
 * viewing.
 */
export function TeamTasksPage({ useWorkspaces, loadTasks, subscribeChanges, selectWorkspace, selectThread, humanName, humanAvatarUrl, t }: TeamTasksPageProps) {
  const workspaces = useWorkspaces(state => state.items)
  const [rows, setRows] = useState<readonly TeamTaskRow[]>()
  // The Host names the Human's Member id on every payload; the page keeps it so
  // an owner chip that names the reader draws the one identity every seat draws.
  const [humanMemberId, setHumanMemberId] = useState<AgentTeamMemberId>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  // Only the first refresh owns the loading surface; later wakes refresh the
  // rendered rows in place instead of flashing them back to skeleton.
  const loadedRef = useRef(false)

  const refresh = useCallback(async () => {
    if (!loadedRef.current) setLoading(true)
    const results = await Promise.all(workspaces.map(async workspace => {
      const result = await loadTasks({ workspaceId: workspace.workspaceId })
      return result.ok
        ? { ok: true as const, workspaceId: workspace.workspaceId, workspaceTitle: workspace.title, tasks: result.value.tasks, humanMemberId: result.value.humanMemberId }
        : { ok: false as const, message: result.error.message }
    }))
    const failure = results.find(result => !result.ok)
    setHumanMemberId(results.find(result => result.ok)?.humanMemberId)
    setRows(results.flatMap(result => result.ok
      ? result.tasks.map(task => ({ workspaceId: result.workspaceId, workspaceTitle: result.workspaceTitle, task }))
      : []))
    setError(failure?.ok === false ? failure.message : undefined)
    loadedRef.current = true
    setLoading(false)
  }, [loadTasks, workspaces])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => subscribeChanges(undefined, update => {
    if (update.type === 'failed') {
      setError(update.message)
      return
    }
    void refresh()
  }), [subscribeChanges, refresh])

  const open = (row: TeamTaskRow): void => {
    selectWorkspace(row.workspaceId)
    selectThread(row.task.threadRef, row.task.channelRef, row.task.taskRef, row.task.taskNumber)
  }

  const all = rows ?? []
  const byRef = new Map(all.map(row => [row.task.taskRef, row]))
  const assemble = (source: readonly TeamTaskRow[]): readonly TaskGroup[] => {
    const childrenByParent = new Map<string, TeamTaskRow[]>()
    const topLevel: TeamTaskRow[] = []
    for (const row of source) {
      const parentRef = row.task.parentTaskRef
      const parent = parentRef === undefined ? undefined : byRef.get(parentRef)
      // A child joins its parent only when the parent is itself a top-level
      // row here; deeper nesting flattens to the parent's level instead of
      // growing a second indent.
      if (parentRef === undefined || parent === undefined || parent.task.parentTaskRef !== undefined) {
        topLevel.push(row)
        continue
      }
      const bucket = childrenByParent.get(parentRef)
      if (bucket === undefined) childrenByParent.set(parentRef, [row])
      else bucket.push(row)
    }
    return topLevel.map(row => {
      const children = childrenByParent.get(row.task.taskRef)
      return children === undefined ? { row, children: [] } : { row, children }
    })
  }
  const openRows = all.filter(row => isOpen(row.task))
  const doneRows = all.filter(row => !isOpen(row.task))
  const openGroups = assemble(openRows)
  const doneGroups = assemble(doneRows)
  // A row names its Workspace only while the rows on screen span more than
  // one — the same rule the Inbox page speaks.
  const shownWorkspaces = new Set<string>()
  for (const row of all) shownWorkspaces.add(row.workspaceTitle)
  const showWorkspace = shownWorkspaces.size > 1
  const human = humanMemberId === undefined
    ? undefined
    : { memberId: humanMemberId, name: humanName, ...(humanAvatarUrl === undefined ? {} : { avatarUrl: humanAvatarUrl }) } satisfies TeamAvatarHuman

  return <main className={css.surface} data-team-tasks>
    <div className={css.surfaceHeader}>
      <header className={css.headerRow}>
        <div className={css.headerCopy}>
          <h1>{t('tasksTitle')}</h1>
          {rows !== undefined && all.length > 0 && <p className={inboxCss.headerMeta}>
            <span>{t('tasksHeaderOpen', { count: openRows.length })}</span>
          </p>}
        </div>
      </header>
    </div>
    <div className={css.timeline}>
      <div className={css.timelineContent}>
        {loading && rows === undefined && error === undefined && <div className={css.emptySurface}><p className={css.loadingState}><span className={css.loadingMark} aria-hidden="true" />{t('loadingTasks')}</p></div>}
        {!loading && rows === undefined && error !== undefined && <div className={css.errorState} role="alert"><span>{error}</span><Button size="sm" variant="outline" onClick={() => { void refresh() }}>{t('retry')}</Button></div>}
        {rows !== undefined && (all.length === 0
          ? <div className={css.emptySurface}>
              <div className={css.emptyState}>
                <strong>{t('tasksEmptyTitle')}</strong>
                <span>{t('tasksEmptyHint')}</span>
              </div>
            </div>
          : <>
              {openGroups.length > 0 && <section className={inboxCss.section}>
                <h2 className={inboxCss.sectionTitle}>{t('tasksSectionOpen')}<span className={inboxCss.sectionCount}>{openRows.length}</span></h2>
                <div className={inboxCss.list}>
                  {openGroups.map(group => <TaskGroupView key={group.row.task.taskRef} group={group} showWorkspace={showWorkspace} human={human} onOpen={open} t={t} />)}
                </div>
              </section>}
              {doneGroups.length > 0 && <section className={inboxCss.section}>
                <h2 className={inboxCss.sectionTitle}>{t('tasksSectionDone')}<span className={inboxCss.sectionCount}>{doneRows.length}</span></h2>
                <div className={inboxCss.list}>
                  {doneGroups.map(group => <TaskGroupView key={group.row.task.taskRef} group={group} showWorkspace={showWorkspace} human={human} onOpen={open} t={t} />)}
                </div>
              </section>}
            </>)}
        {rows !== undefined && error !== undefined && <p className={css.error} role="alert">{error}</p>}
      </div>
    </div>
  </main>
}

/** One top-level Task with its indented sub-tasks, if any. */
function TaskGroupView({ group, showWorkspace, human, onOpen, t }: {
  readonly group: TaskGroup
  readonly showWorkspace: boolean
  readonly human: TeamAvatarHuman | undefined
  readonly onOpen: (row: TeamTaskRow) => void
  readonly t: TeamConversationProps['t']
}) {
  const done = group.children.filter(child => !isOpen(child.task)).length
  return <>
    <TaskRow row={group.row} showWorkspace={showWorkspace} human={human} t={t}
      {...(group.children.length === 0 ? {} : { progress: { done, total: group.children.length } })}
      onOpen={() => { onOpen(group.row) }} />
    {group.children.map(child => <TaskRow key={child.task.taskRef} row={child} showWorkspace={showWorkspace} human={human} subtask t={t} onOpen={() => { onOpen(child) }} />)}
  </>
}

/**
 * One Task row, shaped like the shipped Inbox row: the status dot leads in the
 * gutter — this page's scan axis is where work stands — the identity line
 * answers which Task this is, its standing, and its sub-task progress, and the
 * bounded subject sits under it. The dot is the one shared Team indicator, so
 * this page reads exactly like the Thread headings and the Channel feed about
 * standing; the owner stack closes the identity line, the same cluster the
 * Inbox rows lead with, drawn here where the dot already answers the scan.
 */
function TaskRow({ row, showWorkspace, subtask, progress, human, t, onOpen }: {
  readonly row: TeamTaskRow
  readonly showWorkspace: boolean
  readonly subtask?: boolean | undefined
  readonly progress?: { readonly done: number, readonly total: number } | undefined
  readonly human: TeamAvatarHuman | undefined
  readonly t: TeamConversationProps['t']
  readonly onOpen: () => void
}) {
  const { task } = row
  const owners = namedAvatarOwners(task.claimOwners, human)
  return <button type="button" className={subtask === true ? `${inboxCss.row} ${taskCss.subtask}` : inboxCss.row} onClick={onOpen}>
    <span className={inboxCss.rowActor} aria-hidden="true">
      <TeamStateDot state={taskStatusDot(task.status)} />
    </span>
    <span className={inboxCss.rowLine}>
      <span className={inboxCss.rowCrumb}>
        {showWorkspace && <span className={inboxCss.rowWorkspace}>{row.workspaceTitle}</span>}
        {showWorkspace && ' / '}
        <span className={inboxCss.rowTask}>{t('taskLabel', { number: task.taskNumber })}</span>
        {' '}
        <span>{formatTaskStatus(task.status, t)}</span>
        {progress !== undefined && <span> · {t('tasksSubtaskProgress', { done: progress.done, total: progress.total })}</span>}
      </span>
      {owners.length > 0 && <span className={taskCss.rowOwners}>
        <TeamAvatarStack owners={owners} label={claimersLabel(owners, t)} human={human} />
      </span>}
      <time className={inboxCss.rowTime} dateTime={task.lastActivityAt} title={formatAbsoluteTime(task.lastActivityAt)}>{formatInboxTime(task.lastActivityAt, t)}</time>
    </span>
    <span className={inboxCss.rowPreview}>{task.subject}</span>
  </button>
}
