import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')

/**
 * The deployment contract for Member delegation: the team-member preset ships
 * the subagent tools pinned to a plain worker child preset, and that child
 * preset carries no Team tools — a delegated worker answers to its parent
 * Member alone and never speaks for the team. These assertions read the real
 * patch text so a row rename or a plugin-list edit that quietly drops one of
 * them fails here rather than at boot.
 */
describe('team-member delegation preset contract', () => {
  it('mounts the subagent tools on Members, pinned to the worker preset', async () => {
    const patch = await readFile(resolve(root, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain("name: '@deepseek-ai/dsh-tool-subagent-control'")
    expect(patch).toMatch(/name: '@deepseek-ai\/dsh-tool-subagent'\s*\n\s*config:\s*\n\s*provider: spawn\s*\n\s*toolName: subagent\s*\n\s*agentPreset: team-subagent/)
  })

  it('ships a team-subagent child preset without the Team tools', async () => {
    const patch = await readFile(resolve(root, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('id: wowyuarm-agent-team-preset-team-subagent')
    expect(patch).toContain('id: team-subagent')
    // Slice the child preset's own plugin list: from its row to the Host row
    // that follows it. The Team tools plugin must not appear inside it.
    const start = patch.indexOf('id: wowyuarm-agent-team-preset-team-subagent')
    const end = patch.indexOf('id: wowyuarm-agent-team-host')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const childSlice = patch.slice(start, end)
    expect(childSlice).not.toContain('@wowyuarm/dsh-agent-team/tools')
    expect(childSlice).not.toContain('member-context')
    // A worker still gets the ordinary project tools it needs to do the task.
    expect(childSlice).toContain("name: '@deepseek-ai/dsh-tool-bash'")
    expect(childSlice).toContain("name: '@deepseek-ai/dsh-tool-fs'")
  })

  it('keeps the Team tools and the job tool on the Member preset itself', async () => {
    const patch = await readFile(resolve(root, 'cordis.patch.yml'), 'utf8')
    const memberStart = patch.indexOf('id: wowyuarm-agent-team-preset-team-member')
    const childStart = patch.indexOf('id: wowyuarm-agent-team-preset-team-subagent')
    expect(memberStart).toBeGreaterThan(-1)
    expect(childStart).toBeGreaterThan(memberStart)
    const memberSlice = patch.slice(memberStart, childStart)
    expect(memberSlice).toContain("name: '@wowyuarm/dsh-agent-team/tools'")
    expect(memberSlice).toContain('tool-subagent')
  })
})
