/**
 * Team-owned ledger divergence guard for `@wowyuarm/dsh-agent-team`.
 *
 * Harness retired its runtime invariant registry (`@deepseek-ai/dsh-invariants`,
 * DSH 0.2.1), so the check that used to be contributed to that registry now
 * mounts as a companion row of its own beside the Host. The ledger is Team
 * authority, so the guard that defends it is Team-owned too.
 */

import type { Context } from '@deepseek-ai/cordis'

const PACKAGE_NAME = '@wowyuarm/dsh-agent-team'

/** Cordis companion plugin name. */
export const name = 'agent-team-invariant'
/** Services required before the companion can validate Team state. */
export const inject = ['agentTeam']

/**
 * Report a violated Team ledger contract. Attributed to this package the way
 * the retired registry attributed its failures, so a divergence stays readable
 * in a Host log and on a caller-owned frame.
 */
const fail = (message: string): never => {
  throw new Error(`invariant violated by "${PACKAGE_NAME}": ${message}`)
}

/** Install the ledger checks and the commit-driven replay. */
export function apply(ctx: Context): void {
  const divergence = (error: unknown): string =>
    `durable ledger and Team projection diverged: ${String(error)}`

  // Mounting stays synchronous: a durable ledger that cannot be re-derived
  // must fail startup instead of racing the first commit. The mount adopts
  // the record-level replay the constructor already ran, once and only while
  // nothing has committed since; every later validation, and every
  // commit-driven one below, replays the whole durable table.
  try {
    ctx.agentTeam.validateLedgerAtMount()
  } catch (error) {
    fail(divergence(error))
  }

  // The commit path cannot pay a full replay before its Remote response
  // returns, and opening a Thread commits. The replay stays the same full one
  // over the durable table, but commits coalesce into a single run in the
  // check phase, after the I/O turn carrying the response. A divergence stays
  // loud: it is logged where it is detected, and every later commit re-raises
  // it on a caller-owned frame until a replay comes back clean.
  let latched: string | undefined
  let pending: NodeJS.Immediate | undefined
  const check = (): void => {
    pending = undefined
    try {
      ctx.agentTeam.validateLedger()
      latched = undefined
    } catch (error) {
      latched = divergence(error)
      ctx.logger.error(`agent-team: ${latched}`)
    }
  }
  ctx.effect(() => () => {
    if (pending !== undefined) clearImmediate(pending)
    pending = undefined
  }, 'agent-team.invariant.pending-validation')
  ctx.on('agent-team/committed', () => {
    // Scheduled before the latch re-raises: a replay that comes back clean is
    // what releases it.
    if (pending === undefined) pending = setImmediate(check)
    if (latched !== undefined) fail(latched)
  })
}
