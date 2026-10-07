import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentTeamMemberId, AgentTeamTaskRef, AgentTeamTaskRow } from '@wowyuarm/dsh-agent-team/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamConversationProps } from './slots.ts'
import { claimersLabel, formatAbsoluteTime, formatInboxTime, formatTaskStatus, taskStatusDot } from './team-formatters.ts'
import { namedAvatarOwners, TeamAvatarStack, type TeamAvatarHuman } from './TeamAvatarStack.tsx'
import { TeamStateDot } from './TeamStateDot.tsx'
import { mintRequestId } from './requests.ts'
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
  /** Host batch resolution behind the multi-select bar: acceptance or closing for several Tasks at once. */
  readonly changeTasks: TeamConversationProps['changeTasks']
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
 * invisible. Open rows carry a selection checkbox: the multi-select bar
 * resolves them through one Host batch call, each Task its own durable
 * operation. Opening a row navigates to its Thread; selecting acknowledges
 * nothing and viewing acknowledges nothing.
 */
export function TeamTasksPage({ useWorkspaces, loadTasks, subscribeChanges, changeTasks, selectWorkspace, selectThread, humanName, humanAvatarUrl, t }: TeamTasksPageProps) {
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
  // Wakes and the Workspace list can start refreshes faster than their reads
  // answer, and an older read may not lose the race on its own: without a
  // ticket, a slow first read can land after a fast second and overwrite fresh
  // rows with stale standing — exactly the "the list disagrees with the Thread"
  // mismatch this page must never show. Only the newest refresh may write.
  const refreshTicket = useRef(0)

  const refresh = useCallback(async () => {
    const ticket = ++refreshTicket.current
    if (!loadedRef.current) setLoading(true)
    const results = await Promise.all(workspaces.map(async workspace => {
      const result = await loadTasks({ workspaceId: workspace.workspaceId })
      return result.ok
        ? { ok: true as const, workspaceId: workspace.workspaceId, workspaceTitle: workspace.title, tasks: result.value.tasks, humanMemberId: result.value.humanMemberId }
        : { ok: false as const, message: result.error.message }
    }))
    if (ticket !== refreshTicket.current) return
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

  // The selection holds full Task refs and survives wakes: rows refresh in
  // place, and the checkout keeps whatever it held unless the reader clears it.
  const [selected, setSelected] = useState<ReadonlySet<AgentTeamTaskRef>>(new Set())
  const [batchRunning, setBatchRunning] = useState(false)
  // One line of batch feedback at a time — a committed count, the skipped and
  // failed summary the Host reported, or a transport error — cleared by the
  // next selection change or the next run.
  const [batchNote, setBatchNote] = useState<string>()

  const toggle = (taskRef: AgentTeamTaskRef, on: boolean): void => {
    setBatchNote(undefined)
    setSelected(prev => {
      const next = new Set(prev)
      if (on) next.add(taskRef)
      else next.delete(taskRef)
      return next
    })
  }

  const runBatch = async (action: 'accept' | 'close'): Promise<void> => {
    if (batchRunning) return
    setBatchRunning(true)
    setBatchNote(undefined)
    try {
      // The batch Remote is one Workspace's resolution, so a selection spanning
      // Workspaces groups into one call per Workspace it touches.
      const byWorkspace = new Map<WorkspaceId, AgentTeamTaskRef[]>()
      for (const row of rows ?? []) {
        if (!selected.has(row.task.taskRef)) continue
        const bucket = byWorkspace.get(row.workspaceId) ?? []
        bucket.push(row.task.taskRef)
        byWorkspace.set(row.workspaceId, bucket)
      }
      const results = await Promise.all([...byWorkspace].map(([workspaceId, taskRefs]) =>
        changeTasks({ requestId: mintRequestId(), workspaceId, taskRefs, action })))
      const failed = results.filter(result => !result.ok)
      if (failed.length > 0) {
        setBatchNote(failed[0]!.error.message)
        return
      }
      const outcomes = results.flatMap(result => result.ok ? result.value.outcomes : [])
      const committed = outcomes.filter(outcome => outcome.kind === 'committed').length
      const skipped = outcomes.filter(outcome => outcome.kind === 'already_resolved').length
      const failedOutcomes = outcomes.filter(outcome => outcome.kind === 'failed')
      const parts: string[] = [committed > 0 ? t('tasksBatchCommitted', { count: committed }) : '']
      if (skipped > 0) parts.push(t('tasksBatchSkipped', { count: skipped }))
      if (failedOutcomes.length > 0) parts.push(t('tasksBatchFailed', { count: failedOutcomes.length, reason: failedOutcomes[0]!.reason }))
      setBatchNote(parts.filter(part => part !== '').join('；'))
      setSelected(new Set())
      await refresh()
    } finally {
      setBatchRunning(false)
    }
  }

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
                  {openGroups.map(group => <TaskGroupView key={group.row.task.taskRef} group={group} showWorkspace={showWorkspace} human={human}
                    selected={selected} onToggle={toggle} t={t} onOpen={open} />)}
                </div>
              </section>}
              {doneGroups.length > 0 && <section className={inboxCss.section}>
                <h2 className={inboxCss.sectionTitle}>{t('tasksSectionDone')}<span className={inboxCss.sectionCount}>{doneRows.length}</span></h2>
                <div className={inboxCss.list}>
                  {doneGroups.map(group => <TaskGroupView key={group.row.task.taskRef} group={group} showWorkspace={showWorkspace} human={human} t={t} onOpen={open} />)}
                </div>
              </section>}
              {selected.size > 0 && <div className={taskCss.batchBar} role="toolbar" aria-label={t('tasksBatchSelected', { count: selected.size })}>
                <span className={taskCss.batchCount}>{t('tasksBatchSelected', { count: selected.size })}</span>
                <Button size="sm" variant="primary" disabled={batchRunning} onClick={() => { void runBatch('accept') }}>{t('tasksBatchAccept')}</Button>
                <Button size="sm" variant="outline" disabled={batchRunning} onClick={() => { void runBatch('close') }}>{t('tasksBatchClose')}</Button>
                <Button size="sm" variant="ghost" disabled={batchRunning} onClick={() => { setSelected(new Set()); setBatchNote(undefined) }}>{t('tasksBatchClear')}</Button>
                {(batchRunning || batchNote !== undefined) && <span className={taskCss.batchNote}>{batchRunning ? t('tasksBatchSubmitting') : batchNote}</span>}
              </div>}
              {/* A committed run clears its own selection, so its feedback would
                  die with the bar; the note outlives it as one status line until
                  the reader selects again. A failed run keeps its selection, so
                  its note stays on the bar where the actions still are. */}
              {selected.size === 0 && !batchRunning && batchNote !== undefined && <p className={taskCss.batchNote} role="status">{batchNote}</p>}
            </>)}
        {rows !== undefined && error !== undefined && <p className={css.error} role="alert">{error}</p>}
      </div>
    </div>
  </main>
}

/** One top-level Task with its indented sub-tasks, if any. Open rows carry their selection checkbox. */
function TaskGroupView({ group, showWorkspace, human, selected, onToggle, t, onOpen }: {
  readonly group: TaskGroup
  readonly showWorkspace: boolean
  readonly human: TeamAvatarHuman | undefined
  readonly selected?: ReadonlySet<AgentTeamTaskRef> | undefined
  readonly onToggle?: (taskRef: AgentTeamTaskRef, on: boolean) => void
  readonly t: TeamConversationProps['t']
  readonly onOpen: (row: TeamTaskRow) => void
}) {
  const done = group.children.filter(child => !isOpen(child.task)).length
  return <>
    <TaskRow row={group.row} showWorkspace={showWorkspace} human={human} t={t}
      {...(group.children.length === 0 ? {} : { progress: { done, total: group.children.length } })}
      {...(selected === undefined || onToggle === undefined ? {} : { check: {
        checked: selected.has(group.row.task.taskRef),
        onCheck: on => { onToggle(group.row.task.taskRef, on) },
        label: t('tasksSelectRow', { number: group.row.task.taskNumber }),
      } })}
      onOpen={() => { onOpen(group.row) }} />
    {group.children.map(child => <TaskRow key={child.task.taskRef} row={child} showWorkspace={showWorkspace} human={human} subtask t={t}
      {...(selected === undefined || onToggle === undefined ? {} : { check: {
        checked: selected.has(child.task.taskRef),
        onCheck: on => { onToggle(child.task.taskRef, on) },
        label: t('tasksSelectRow', { number: child.task.taskNumber }),
      } })}
      onOpen={() => { onOpen(child) }} />)}
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
 * A selectable row carries the checkbox outside the row button — a control
 * inside a button would open the Thread on the very click meant to select.
 */
function TaskRow({ row, showWorkspace, subtask, progress, human, check, t, onOpen }: {
  readonly row: TeamTaskRow
  readonly showWorkspace: boolean
  readonly subtask?: boolean | undefined
  readonly progress?: { readonly done: number, readonly total: number } | undefined
  readonly human: TeamAvatarHuman | undefined
  readonly check?: { readonly checked: boolean, readonly onCheck: (on: boolean) => void, readonly label: string } | undefined
  readonly t: TeamConversationProps['t']
  readonly onOpen: () => void
}) {
  const { task } = row
  const owners = namedAvatarOwners(task.claimOwners, human)
  const rowButton = <button type="button" className={[
    inboxCss.row,
    ...(subtask === true ? [taskCss.subtask] : []),
    ...(check !== undefined ? [taskCss.inShell] : []),
  ].join(' ')} onClick={onOpen}>
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
  if (check === undefined) return rowButton
  return <div className={taskCss.rowShell}>
    <input type="checkbox" className={taskCss.rowCheck} aria-label={check.label} checked={check.checked} onChange={event => { check.onCheck(event.target.checked) }} />
    {rowButton}
  </div>
}
