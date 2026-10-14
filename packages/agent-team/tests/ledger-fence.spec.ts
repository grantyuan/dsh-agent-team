import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { AGENT_TEAM_AUTHORITY_LOST_MESSAGE, AgentTeamLedger, agentTeamHumanActor } from '../src/ledger.ts'
import { ledgerFenceFor } from '../src/ledger-fence.ts'
import type { AgentTeamOperation, AgentTeamOperationId, AgentTeamRequestId } from '../src/types.ts'

/**
 * Single-writer fence for the ledger (see ledger-fence.ts): a leaked second
 * AgentTeam instance — same-process patch-reload survivor or another host —
 * must stop at its next ledger call instead of interleaving and forking the
 * operation chain. The suite covers the fence itself, then the enforcement at
 * the ledger chokepoint.
 */

const cleanups: Array<() => Promise<void>> = []

async function tempFenceDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-team-fence-'))
  cleanups.push(async () => { await rm(dir, { recursive: true, force: true }) })
  return dir
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

/** A Map-backed KvTable plus the underlying Map for post-run content checks. */
function fakeTable(): { readonly table: KvTable<AgentTeamOperationId, AgentTeamOperation>; readonly map: Map<AgentTeamOperationId, AgentTeamOperation> } {
  const map = new Map<AgentTeamOperationId, AgentTeamOperation>()
  const table = Object.assign(map, { put: async (key: AgentTeamOperationId, value: AgentTeamOperation) => { map.set(key, value) } }) as unknown as KvTable<AgentTeamOperationId, AgentTeamOperation>
  return { table, map }
}

const requestId = (value: string): AgentTeamRequestId => value as AgentTeamRequestId
const alpha = WorkspaceId('workspace:alpha')
const human = agentTeamHumanActor()

function channel(requestIdValue: string, name: string) {
  return { requestId: requestId(requestIdValue), workspaceId: alpha, name, description: name, memberIds: [], actor: human }
}

describe('LedgerFence', () => {
  it('claims ownership and writes the lock record', async () => {
    const dir = await tempFenceDir()
    const fence = ledgerFenceFor(dir)
    await fence.claim()
    expect(await fence.owns()).toBe(true)
    const record = JSON.parse(await readFile(join(dir, 'agent_team.host.lock'), 'utf8')) as { nonce: string; pid: number }
    expect(record.nonce).toBe(fence.nonce)
    expect(record.pid).toBe(process.pid)
  })

  it('a newer claim supersedes the earlier holder in the same process', async () => {
    const dir = await tempFenceDir()
    const first = ledgerFenceFor(dir)
    const second = ledgerFenceFor(dir)
    await first.claim()
    expect(await first.owns()).toBe(true)
    await second.claim()
    expect(await first.owns()).toBe(false)
    expect(await second.owns()).toBe(true)
  })

  it('stops a holder whose lock file was overwritten by another host, latched', async () => {
    const dir = await tempFenceDir()
    const fence = ledgerFenceFor(dir)
    await fence.claim()
    // Simulate a foreign process overwriting the claim.
    await writeFile(join(dir, 'agent_team.host.lock'), JSON.stringify({ nonce: 'other-host-nonce', pid: 1, claimedAt: new Date().toISOString() }), 'utf8')
    expect(await fence.owns()).toBe(false)
    // Losing is latched: a restored file does not hand the pen back.
    await writeFile(join(dir, 'agent_team.host.lock'), JSON.stringify({ nonce: fence.nonce, pid: process.pid, claimedAt: new Date().toISOString() }), 'utf8')
    expect(await fence.owns()).toBe(false)
  })

  it('release removes only the holder\'s own lock', async () => {
    const dir = await tempFenceDir()
    const first = ledgerFenceFor(dir)
    const second = ledgerFenceFor(dir)
    await first.claim()
    await second.claim()
    await first.release()
    // first was superseded: its release must not touch second's lock.
    const survivor = JSON.parse(await readFile(join(dir, 'agent_team.host.lock'), 'utf8')) as { nonce: string }
    expect(survivor.nonce).toBe(second.nonce)
    await second.release()
    await expect(readFile(join(dir, 'agent_team.host.lock'), 'utf8')).rejects.toThrow()
    expect(await second.owns()).toBe(false)
  })
})

describe('ledger authority enforcement', () => {
  it('a superseded ledger refuses further calls and commits nothing, while the new holder continues', async () => {
    const dir = await tempFenceDir()
    const oldFence = ledgerFenceFor(dir)
    await oldFence.claim()
    const { table, map } = fakeTable()
    const oldLedger = new AgentTeamLedger(table, { ownsAuthority: () => oldFence.owns() })
    await oldLedger.initialize()
    await oldLedger.createChannel(channel('channel-old', 'old'))

    // A patch-reload survivor mounts over the same storage: last claim wins.
    const newFence = ledgerFenceFor(dir)
    await newFence.claim()

    await expect(oldLedger.createChannel(channel('channel-fork', 'fork'))).rejects.toThrow(AGENT_TEAM_AUTHORITY_LOST_MESSAGE)
    expect([...map.values()].some(operation => operation.requestId === requestId('channel-fork'))).toBe(false)

    // The new holder replays the shared table and keeps writing forward.
    const newLedger = new AgentTeamLedger(table, { ownsAuthority: () => newFence.owns() })
    await newLedger.initialize()
    await newLedger.createChannel(channel('channel-new', 'new'))
    expect(newLedger.position()).toBe(3)
    expect([...map.values()].some(operation => operation.requestId === requestId('channel-new'))).toBe(true)
  })

  it('a superseded ledger latches: it stops consulting the authority probe', async () => {
    const probe = vi.fn(async () => true)
    const { table } = fakeTable()
    const ledger = new AgentTeamLedger(table, { ownsAuthority: probe })
    await ledger.initialize()
    expect(probe).toHaveBeenCalledTimes(1)
    probe.mockImplementation(async () => false)
    await expect(ledger.createChannel(channel('channel-a', 'a'))).rejects.toThrow(AGENT_TEAM_AUTHORITY_LOST_MESSAGE)
    await expect(ledger.createChannel(channel('channel-b', 'b'))).rejects.toThrow(AGENT_TEAM_AUTHORITY_LOST_MESSAGE)
    // The first loss call consulted the probe; the second failed on the latch alone.
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('an unfenced ledger (no ownsAuthority) is unchanged', async () => {
    const { table } = fakeTable()
    const ledger = new AgentTeamLedger(table)
    await ledger.initialize()
    expect(ledger.position()).toBe(1)
  })
})
