/**
 * Single-writer fence for the Agent Team ledger.
 *
 * The ledger authority assumes exactly one AgentTeam host writes the domain:
 * `nextSequence` is an in-memory counter and the Harness storage domain
 * performs no cross-process or cross-context coordination (its contract
 * declares cross-process ownership out of scope). Two live ledgers over one
 * storage file therefore interleave and fork the operation chain at the first
 * shared write — which fail-closes only at the next replay. A patch-reload
 * that leaks its old service instance is enough to create that state, so the
 * fence enforces the single-writer rule at the Team layer:
 *
 * - claim-on-mount: the newest holder takes authority unconditionally, so a
 *   legitimate remount is never blocked by the instance it replaces;
 * - superseded holders stop: every earlier holder in the same process is
 *   marked through a module registry, and any holder elsewhere through the
 *   lock-file nonce, before their next ledger call commits anything.
 *
 * The check is per ledger call, so the residual race window is one in-flight
 * commit, not an ongoing fork; closing that window completely would need
 * compare-and-swap at the storage layer, which the Harness declares out of
 * scope. The lock lives in the directory named by the Host row's
 * composition-only `ledgerDirectory` config, shipped in the bundle patch
 * beside the SQLite ledger route; a Host without that config is unfenced.
 * @module
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const LOCK_FILE_NAME = 'agent_team.host.lock'

interface LedgerFenceRecord {
  readonly nonce: string
  readonly pid: number
  readonly claimedAt: string
}

/** Live fences by lock path: the same-process fast path that needs no file I/O. */
const fencesByPath = new Map<string, LedgerFence>()

/** One host instance's claim on the ledger's single write authority. */
export class LedgerFence {
  readonly nonce = randomUUID()
  private superseded = false

  constructor(readonly lockPath: string) { }

  /**
   * Take write authority for this instance: last claim wins. Any earlier fence
   * on the same path — old patch-reload survivor included — is marked
   * superseded and its next ledger call stops before committing.
   */
  async claim(): Promise<void> {
    const record: LedgerFenceRecord = { nonce: this.nonce, pid: process.pid, claimedAt: new Date().toISOString() }
    await mkdir(dirname(this.lockPath), { recursive: true })
    const temp = `${this.lockPath}.${this.nonce}.tmp`
    await writeFile(temp, JSON.stringify(record), 'utf8')
    // POSIX rename replaces; Windows EPERMs on an existing target, so the old
    // claim is removed first. The removal doubles as the supersession signal
    // for any other holder's next `owns()` — a missing lock is a lost lock.
    await unlink(this.lockPath).catch(() => { })
    await rename(temp, this.lockPath)
    fencesByPath.get(this.lockPath)?.markSuperseded()
    fencesByPath.set(this.lockPath, this)
  }

  /**
   * Whether this instance still owns the authority. The registry check is the
   * in-process fast path; the file nonce check is what stops a holder that a
   * different process (or context) overwrote. A missing or foreign lock is
   * never treated as a transient read error: losing the read is losing the
   * write.
   */
  async owns(): Promise<boolean> {
    if (this.superseded) return false
    if (fencesByPath.get(this.lockPath) !== this) {
      this.markSuperseded()
      return false
    }
    let owned = false
    try {
      const record = JSON.parse(await readFile(this.lockPath, 'utf8')) as Partial<LedgerFenceRecord> | undefined
      owned = record?.nonce === this.nonce
    } catch {
      owned = false
    }
    // Losing is one-way: authority returns only through a fresh claim (a new
    // mount), never through the file happening to come back.
    if (!owned) this.markSuperseded()
    return owned
  }

  /**
   * Clean hand-off on dispose: the holder removes its own lock and nothing
   * else. A fence already superseded by a newer claim leaves the newer
   * holder's file untouched.
   */
  async release(): Promise<void> {
    if (this.superseded) return
    if (!(await this.owns())) {
      this.markSuperseded()
      return
    }
    fencesByPath.delete(this.lockPath)
    await unlink(this.lockPath).catch(() => { })
  }

  markSuperseded(): void {
    this.superseded = true
  }
}

/** The fence for the dshHome storage directory that hosts the ledger domain. */
export function ledgerFenceFor(storageDirectory: string): LedgerFence {
  return new LedgerFence(join(storageDirectory, LOCK_FILE_NAME))
}
