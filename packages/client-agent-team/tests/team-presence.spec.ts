/**
 * The row diagnostic is the only place the Client says why an unavailable
 * Member is unavailable; the restart affordance now covers every unavailable
 * state (including a transition the Host could not finish — its recovery read
 * completes the swap). The verdict here is projection-derived and pure, so it
 * is pinned in this file; `team-mode-agents.client.spec.tsx` covers the row
 * menu that consumes it, and the artifact path a refusal carries is asserted
 * below.
 */
import { describe, expect, it } from 'vitest'
import type { AgentTeamClientMemberStatus, AgentTeamMemberDiagnostic } from '@wowyuarm/dsh-agent-team/types'
import { zh } from '../src/client/locales.ts'
import type { TeamSidebarProps } from '../src/client/slots.ts'
import { diagnosticText, presenceLabel } from '../src/client/TeamPresenceDot.tsx'

const t = ((key: keyof typeof zh, params?: Record<string, string | number>) => {
  let value: string = zh[key]
  for (const [name, replacement] of Object.entries(params ?? {})) value = value.replace(`{${name}}`, String(replacement))
  return value
}) as TeamSidebarProps['t']

/** An unavailable Member carrying only the diagnostic facts these verdicts read. */
function unavailable(diagnostic?: AgentTeamMemberDiagnostic): AgentTeamClientMemberStatus {
  return { presence: 'unavailable', ...(diagnostic === undefined ? {} : { diagnostic }) } as unknown as AgentTeamClientMemberStatus
}

describe('Member row diagnostics', () => {
  it('renders the refused artifact path beside the reason', () => {
    const refused = unavailable({
      class: 'session-refused',
      detail: 'cannot safely transform unclassified message source',
      location: { kind: 'jsonl', path: '/tmp/sessions/x/session.v0.jsonl.zstd' },
    })
    expect(diagnosticText(refused)).toBe('cannot safely transform unclassified message source (/tmp/sessions/x/session.v0.jsonl.zstd)')
    expect(diagnosticText(unavailable({ class: 'runtime', detail: 'boom' }))).toBe('boom')
    expect(diagnosticText(unavailable())).toBe('')
  })

  it('labels an unavailable Member with the reason, not a bare state', () => {
    expect(presenceLabel(unavailable(), t)).toBe('不可用')
    expect(presenceLabel(unavailable({ class: 'session-refused', detail: 'refused' }), t)).toBe('不可用: refused')
  })
})
