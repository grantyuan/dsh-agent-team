// Single source of truth for which sibling dsh-context-continuity checkout
// this repository resolves `@wowyuarm/dsh-context-continuity` against.
//
// The engine is a separate repository that is not published yet (release
// cadence is batched and the operator deferred it), so Team consumes the
// built sibling checkout exactly like it consumes the sibling Harness
// checkout: the package name resolves through node_modules to a linked
// sibling directory, and the published-bundle peer story is settled at
// release time.
//
// Resolution order:
//   1. DSH_CONTEXT_CONTINUITY_DIR — an isolated checkout for a release or
//      certification run.
//   2. Default: `dsh-context-continuity`, the daily sibling checkout.
//
// A resolved directory that does not exist fails fast here, at its cause,
// instead of surfacing later as a far-away `Cannot find module
// '@wowyuarm/dsh-context-continuity'` inside an unrelated test.
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_CONTINUITY_NAME = 'dsh-context-continuity'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Name of the engine checkout directory (env override > the default sibling name). */
export const continuityName = process.env.DSH_CONTEXT_CONTINUITY_DIR?.trim() || DEFAULT_CONTINUITY_NAME

const continuityRoot = resolve(projectRoot, '..', continuityName)

if (!existsSync(continuityRoot) || !statSync(continuityRoot).isDirectory()) {
  const siblings = readdirSync(join(projectRoot, '..'), { withFileTypes: true })
    .filter(entry => entry.isDirectory()
      && entry.name !== 'dsh-agent-team'
      && !entry.name.startsWith('.'))
    .map(entry => entry.name)
  throw new Error(
    `The context-continuity engine resolves to '../${continuityName}', which does not exist.`
    + ` Keep the engine checkout as a sibling ('${DEFAULT_CONTINUITY_NAME}') and build it there (npm run build),`
    + ` or point DSH_CONTEXT_CONTINUITY_DIR at another checkout of it.`
    + ` Sibling directories that DO exist: ${siblings.length > 0 ? siblings.join(', ') : '(none)'}.`,
  )
}

/** Absolute path of the engine checkout every consumer must resolve against. */
export const continuityDir = continuityRoot

/** The built package entry the linked engine exposes; must exist before linking. */
export const continuityEntry = join(continuityDir, 'lib', 'index.js')
