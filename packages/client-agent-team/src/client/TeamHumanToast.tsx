import { useEffect, useRef, useState } from 'react'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AgentTeamInboxItem, AgentTeamChannelRef, AgentTeamThreadRef } from '@wowyuarm/dsh-agent-team/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { TeamToastProps } from './slots.ts'

/** One visible banner: keyed so a newer arrival restarts the cycle. */
interface ToastShow {
  readonly key: number
  readonly text: string
  readonly workspaceId: WorkspaceId
  readonly threadRef: AgentTeamThreadRef
  readonly channelRef: AgentTeamChannelRef | undefined
}

/** The banner holds ten seconds before its fade, as the operator asked. */
const TOAST_HOLD_MS = 10_000

/** One bounded preview line; the toast is a pointer, not a reader. */
function boundedPreview(text: string): string {
  const collapsed = text.replaceAll(/\s+/gu, ' ').trim()
  return collapsed.length <= 80 ? collapsed : `${collapsed.slice(0, 79)}…`
}

/**
 * The Human's new-message banner: whenever a Team Message arrives that is
 * addressed to the Human — an @mention or a direct marker, which is exactly
 * how the assistant's notices and teammates' asks reach them — a banner
 * slides in for ten seconds, and its action jumps straight to the Thread.
 * It watches the same durable Inbox the sidebar badge reads, so nothing new
 * is invented here: the banner is one more presentation of the Host's own
 * unread facts, mounted outside the Team seats so it reaches the Human in
 * either mode. The first pass only seeds the seen-cursor — a backlog that
 * predates this mount never toasts.
 */
export function TeamHumanToast({ navigation, loadInbox, subscribeChanges, subscribeReads, enterTeam, selectThread, t, useWorkspaces }: TeamToastProps) {
  const workspaces = useWorkspaces(state => state.items)
  const [show, setShow] = useState<ToastShow | undefined>(undefined)
  const seenRef = useRef<Map<string, number> | undefined>(undefined)
  const showSeq = useRef(0)
  const navigationState = navigation.getSnapshot()
  const teamModeRef = useRef(navigationState.mode === 'team')
  teamModeRef.current = navigationState.mode === 'team'

  useEffect(() => {
    let disposed = false
    let running = false
    let again = false
    const poll = async (): Promise<void> => {
      if (running) { again = true; return }
      running = true
      try {
        const results = await Promise.all(workspaces.map(async workspace => {
          const read = await loadInbox({ workspaceId: workspace.workspaceId, limit: 5 })
          return read.ok ? { workspaceId: workspace.workspaceId as WorkspaceId, items: read.value.items } : null
        }))
        if (disposed) return
        const next = new Map(seenRef.current ?? undefined)
        let fresh: ToastShow | undefined
        for (const entry of results) {
          if (entry === null) continue
          for (const item of entry.items as readonly AgentTeamInboxItem[]) {
            if ((item.directCount ?? 0) === 0) continue
            const key = `${entry.workspaceId} ${item.thread.threadRef}`
            const seen = next.get(key) ?? 0
            if (seenRef.current !== undefined && item.newestSequence > seen) {
              fresh = {
                key: ++showSeq.current,
                text: t('toastNewMessage', { name: item.newestActor.name, preview: boundedPreview(item.previewText ?? '') }),
                workspaceId: entry.workspaceId,
                threadRef: item.thread.threadRef,
                channelRef: item.channelRef,
              }
            }
            next.set(key, Math.max(seen, item.newestSequence))
          }
        }
        seenRef.current = next
        // The newest arrival wins the single banner; the rest stay in the
        // Inbox badge, which this pass also keeps honest.
        if (fresh !== undefined) setShow(fresh)
      } finally {
        running = false
        if (again) { again = false; void poll() }
      }
    }
    void poll()
    const unsubscribe = subscribeChanges(undefined, update => { if (update.type === 'changed') void poll() })
    const unsubscribeReads = subscribeReads(() => { void poll() })
    return () => { disposed = true; unsubscribe(); unsubscribeReads() }
  }, [workspaces, loadInbox, subscribeChanges, subscribeReads, t])

  if (show === undefined) return null
  return <Toast
    key={show.key}
    text={show.text}
    holdMs={TOAST_HOLD_MS}
    actions={[{ label: t('toastView'), onClick: () => {
      setShow(undefined)
      // The jump is one durable navigation: enter Team mode (a no-op when
      // already in it) and open the Thread — the dock follows the face.
      enterTeam()
      selectThread(show.threadRef, show.channelRef)
    } }]}
    onDone={() => { setShow(current => current?.key === show.key ? undefined : current) }}
  />
}
