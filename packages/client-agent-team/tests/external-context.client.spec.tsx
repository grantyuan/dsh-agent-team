// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { AgentTeamClientMemberStatus, AgentTeamExternalContextResult } from '@wowyuarm/dsh-agent-team/types'
import { zh } from '../src/client/locales.ts'
import { TeamSessionHistoryPage } from '../src/client/TeamSessionHistoryPage.tsx'

const t = ((key: keyof typeof zh, params?: Record<string, string | number>) => {
  let value: string = zh[key]
  for (const [name, replacement] of Object.entries(params ?? {})) value = value.replace(`{${name}}`, String(replacement))
  return value
}) as Parameters<typeof TeamSessionHistoryPage>[0]['t']

const MEMBER_ID = 'member:external-1' as never

function rosterMember(external: boolean): AgentTeamClientMemberStatus {
  return {
    member: {
      memberId: MEMBER_ID,
      sessionId: 'session:one',
      workspaceId: 'workspace:alpha',
      handle: 'visitor',
      description: '',
      presetId: 'team-member',
      ...(external ? { external: true } : {}),
      state: 'enabled',
    },
    availability: 'unavailable',
    presence: external ? 'available' : 'unavailable',
    workspaceIds: ['workspace:alpha'],
  } as never
}

/** A read failure in the shape the carrier produces (code/details belong to it, not to the test). */
const readFailure = (message: string): { ok: false; error: { message: string } } =>
  ({ ok: false, error: { message } }) as never

function renderPage({ external, context, refuse }: { readonly external: boolean; readonly context?: AgentTeamExternalContextResult; readonly refuse?: boolean }) {
  const loadMembers = vi.fn(async (): Promise<RemoteResult<readonly AgentTeamClientMemberStatus[]>> => ({ ok: true, value: [rosterMember(external)] }))
  const loadMemberSessions = vi.fn(async (): Promise<RemoteResult<readonly never[]>> => ({ ok: true, value: [] }))
  const loadMemberSessionTranscript = vi.fn()
  const loadExternalContext = vi.fn(async (): Promise<RemoteResult<AgentTeamExternalContextResult>> =>
    (refuse === true ? readFailure('host offline') : { ok: true, value: context ?? {} }) as RemoteResult<AgentTeamExternalContextResult>)
  render(
    <TeamSessionHistoryPage
      memberId={MEMBER_ID}
      workspaceId="workspace:alpha"
      loadMembers={loadMembers}
      loadMemberSessions={loadMemberSessions}
      loadMemberSessionTranscript={loadMemberSessionTranscript as never}
      loadExternalContext={loadExternalContext}
      exitSessionHistory={() => {}}
      t={t}
    />,
  )
  return { loadExternalContext, loadMemberSessions }
}

afterEach(cleanup)

describe('External member audit page', () => {
  it('renders the synced heartbeat snapshot for an external member', async () => {
    const { loadExternalContext, loadMemberSessions } = renderPage({
      external: true,
      context: {
        lastBeatAt: '2026-01-01T08:00:00Z',
        note: '正在修复登录 bug',
        entries: [{ role: 'user', text: '请修复登录' }, { role: 'assistant', text: '已定位到 session 校验' }],
      },
    })
    // No generation list is queried: an external member owns no stored session.
    await waitFor(() => { expect(screen.getByText(/最近心跳：/)).not.toBeNull() })
    expect(loadMemberSessions).not.toHaveBeenCalled()
    expect(loadExternalContext).toHaveBeenCalledWith({ workspaceId: 'workspace:alpha', memberId: MEMBER_ID })
    expect(screen.getByText('正在修复登录 bug')).not.toBeNull()
    expect(screen.getByText('请修复登录')).not.toBeNull()
    expect(screen.getByText('已定位到 session 校验')).not.toBeNull()
  })

  it('states that no heartbeat has landed yet on an empty snapshot', async () => {
    renderPage({ external: true, context: {} })
    await waitFor(() => { expect(screen.getByText(zh.externalContextNever)).not.toBeNull() })
  })

  it('reports a refused read inside the panel and still shows the page', async () => {
    renderPage({ external: true, refuse: true })
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('同步上下文读不出来：host offline') })
    expect(screen.getByText(zh.externalContextTitle)).not.toBeNull()
  })

  it('keeps the stored-generation page for an ordinary member', async () => {
    const { loadExternalContext } = renderPage({ external: false })
    await waitFor(() => { expect(screen.getByRole('navigation', { name: zh.sessionHistoryGenerations })).not.toBeNull() })
    expect(loadExternalContext).not.toHaveBeenCalled()
  })
})
