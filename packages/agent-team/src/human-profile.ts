import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'

/**
 * Human identity profile: the one configurable display name plus the avatar
 * reference. `member:human` stays the durable identity everywhere; only the
 * handle shown in team_view, @ matching, and UI follows this profile.
 *
 * Storage split (see spec.md v1):
 * - name + avatarRef live in the Host settings namespace `agent-team-human`
 *   (settings.yaml user layer, live through `ctx.settings`).
 * - avatar bytes live under a persistent directory below; the settings
 *   document holds only the reference, never a data URL. The composer
 *   attachment cache is TTL-bound and must not hold avatar bytes.
 */

export const HUMAN_PROFILE_SETTINGS_NAMESPACE = 'agent-team-human'

/** Fallback display name before any user override is stored. */
export const HUMAN_PROFILE_DEFAULT_NAME = 'human'

/** Repository home for the version footnote link. */
export const HUMAN_PROFILE_REPO_URL = 'https://github.com/wowyuarm/dsh-agent-team'

/**
 * Bundle version shown in the settings footnote, and the current side of the
 * update check: the version of the package THIS Host runs from — read from the
 * installed manifest, so a `link:` checkout under the development profile and a
 * registry tarball under stable each state their own truth. It is not a
 * hand-maintained string: the 0.1.14 bundle shipped with `0.1.13` written in
 * it, which made the footnote name the previous release and the update check
 * offer the release the user already had.
 *
 * Resolved once at load, three levels above this module — `packages/agent-team/{src,lib}`
 * sits that deep in both layouts, the same relative positioning
 * `member-runtime.ts` uses to find `core-skills`. An unreadable or malformed
 * manifest degrades to `'unknown'`: the Remote's `version: string` contract
 * holds and the update comparison simply compares nothing. The footnote is
 * informational only and never gates behavior.
 */
export const HUMAN_PROFILE_VERSION = readInstalledBundleVersion()

/** Version of the manifest this package installed from, or `'unknown'`. */
function readInstalledBundleVersion(): string {
  try {
    const manifestPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { readonly version?: unknown }
    if (typeof manifest.version === 'string' && manifest.version !== '') return manifest.version
  } catch {
    // Reading our own manifest must never fail the Host boot: a host that
    // cannot find its own package.json is a broken install, and the footnote
    // reporting 'unknown' says so more honestly than a stale number.
  }
  return 'unknown'
}

export interface HumanProfile {
  readonly name: string
  readonly avatarRef?: string
}

/** Settings document shape: name with schema default, avatarRef as a plain reference. */
export interface HumanProfileSettings {
  readonly name: string
  readonly avatarRef?: string
}

/** Schemastery schema resolving the `agent-team-human` namespace value. */
export const HUMAN_PROFILE_SETTINGS_SCHEMA: z<HumanProfileSettings> = z.object({
  name: z.string().default(HUMAN_PROFILE_DEFAULT_NAME),
  // Schemastery fields are optional unless `.required()`: a missing avatarRef
  // simply resolves absent, which the profile reads as "no custom avatar".
  avatarRef: z.string(),
})

/** Normalize one candidate display name the way Member handles normalize. */
export function normalizeHumanName(raw: string): string {
  return raw.normalize('NFKC').trim()
}

/**
 * Validate one candidate display name with the same floor as Member handles:
 * non-empty after trim. Uniqueness against live Members is checked by the
 * Host (which owns the ledger), not here, so this stays a pure function.
 */
export function assertValidHumanName(raw: string): string {
  const name = normalizeHumanName(raw)
  if (name === '') throw new Error('human name must not be empty')
  return name
}
