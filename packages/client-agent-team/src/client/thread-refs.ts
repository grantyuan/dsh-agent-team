import { useSyncExternalStore } from 'react'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  AgentTeamChannelRef, AgentTeamResolveThreadRefsRequest, AgentTeamResolveThreadRefsResult, AgentTeamTaskRef, AgentTeamThreadRef,
} from '@wowyuarm/dsh-agent-team/types'

/** Navigation facts for one branded Thread ref, resolved once per session. */
export interface ResolvedThreadRef {
  readonly threadRef: AgentTeamThreadRef
  readonly channelRef: AgentTeamChannelRef
  readonly taskRef?: AgentTeamTaskRef
  readonly taskNumber?: number
  /** Opening-line gist distinguishing one Thread chip from another. */
  readonly title: string
}

type Listener = () => void

const resolved = new Map<AgentTeamThreadRef, ResolvedThreadRef>()
const pending = new Set<AgentTeamThreadRef>()
/** Refs the Host did not recognize; never re-queried (no retry loops). */
const unresolvable = new Set<AgentTeamThreadRef>()
const listeners = new Set<Listener>()
let version = 0

const emit = (): void => {
  version += 1
  for (const listener of listeners) listener()
}

const subscribe = (listener: Listener): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Stable snapshot token; the map is read directly after this changes. */
const getSnapshot = (): number => version

/** React binding: re-renders the caller when any ref resolution lands. */
export const useResolvedThreadRefVersion = (): number => useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

export const cachedResolvedThreadRef = (threadRef: AgentTeamThreadRef): ResolvedThreadRef | undefined => resolved.get(threadRef)

/** Store one resolution (click path) and wake every rendered link. */
export const rememberResolvedThreadRef = (entry: ResolvedThreadRef): void => {
  resolved.set(entry.threadRef, entry)
  pending.delete(entry.threadRef)
  emit()
}

/** Compare refs by branded prefix plus hyphen-stripped UUID, so abbreviated spellings line up with their full form. */
function refKeyOf(ref: string): string {
  return ref.toLowerCase().replaceAll('-', '')
}

/**
 * Click-path Host lookup: remember every resolved entry and hand them back
 * for immediate navigation. The Host keeps `resolved` in the same order as
 * the input `threadRefs` (one entry per resolvable input, unknowns omitted);
 * the pairing walk below relies on that contract, so it must be preserved
 * together with this implementation.
 */
export const hostThreadRefLookup = (
  resolveThreadRefs: (request: AgentTeamResolveThreadRefsRequest) => Promise<RemoteResult<AgentTeamResolveThreadRefsResult>>,
  workspaceId: AgentTeamResolveThreadRefsRequest['workspaceId'],
): ((threadRefs: readonly AgentTeamThreadRef[]) => Promise<readonly ResolvedThreadRef[]>) =>
  async threadRefs => {
    const result = await resolveThreadRefs({ workspaceId, threadRefs })
    if (!result.ok) return []
    const entries = result.value.resolved
    // The Host answers with full refs even for abbreviated inputs; the
    // returned entries keep the input order, so walk both sides and remember
    // each authored spelling as an alias of its resolution.
    let entryIndex = 0
    for (const requested of threadRefs) {
      const entry = entries[entryIndex]
      if (entry === undefined || !refKeyOf(entry.threadRef).startsWith(refKeyOf(requested))) continue
      if (entry.threadRef !== requested) rememberResolvedThreadRef({ ...entry, threadRef: requested })
      rememberResolvedThreadRef(entry)
      entryIndex += 1
    }
    return entries
  }

/** Resolve one Thread ref through the Host and jump to its home Channel Thread. */
export const jumpToThread = (
  resolveThreadRefs: (request: AgentTeamResolveThreadRefsRequest) => Promise<RemoteResult<AgentTeamResolveThreadRefsResult>>,
  workspaceId: AgentTeamResolveThreadRefsRequest['workspaceId'],
  threadRef: AgentTeamThreadRef,
  selectThread: (threadRef: AgentTeamThreadRef, channelRef?: AgentTeamChannelRef, taskRef?: AgentTeamTaskRef, taskNumber?: number) => void,
): void => {
  void resolveThreadRefs({ workspaceId, threadRefs: [threadRef] }).then(result => {
    if (!result.ok) return
    const hit = result.value.resolved[0]
    if (hit !== undefined) selectThread(hit.threadRef, hit.channelRef, hit.taskRef, hit.taskNumber)
  })
}

/**
 * Batch-resolve unknown refs through the Host lookup. Concurrent callers
 * deduplicate through the pending set; failures just clear the pending mark
 * so a later interaction can retry.
 */
export const resolveUnknownThreadRefs = async (
  refs: readonly AgentTeamThreadRef[],
  lookup: (threadRefs: readonly AgentTeamThreadRef[]) => Promise<readonly ResolvedThreadRef[]>,
): Promise<void> => {
  const missing = refs.filter(threadRef => !resolved.has(threadRef) && !pending.has(threadRef) && !unresolvable.has(threadRef))
  if (missing.length === 0) return
  for (const threadRef of missing) pending.add(threadRef)
  try {
    const entries = await lookup(missing)
    for (const entry of entries) {
      resolved.set(entry.threadRef, entry)
      pending.delete(entry.threadRef)
    }
    // Refs the Host does not know are parked for the session: re-querying
    // them on every render would loop and hammer the Host.
    for (const threadRef of missing) {
      if (!resolved.has(threadRef)) unresolvable.add(threadRef)
    }
    if (entries.length > 0) emit()
  } finally {
    for (const threadRef of missing) pending.delete(threadRef)
  }
}
