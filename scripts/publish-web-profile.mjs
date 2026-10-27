/**
 * Republish this bundle into a DSH profile from a fresh tarball and restart `dsh web`.
 *
 *   build → pack + verify artifact → stop the running `dsh web` → reinstall the
 *   tarball into the profile → confirm the installed copy is this build → start `dsh web`
 *
 * The reinstall deletes the previously extracted copy first: `dsh plugin add` of a
 * changed `file:` tarball updates the lockfile integrity but can leave the extracted
 * package at its old contents, so a fresh build silently fails to reach the profile
 * without that deletion. The installed copy is then compared against this build,
 * file by file.
 *
 * The profile is expected to already pin this package to a `file:` tarball (the form a
 * locally built stable profile uses); a registry range or `link:` checkout is refused
 * rather than silently converted.
 *
 * POSIX only (`ps`/`kill`, detached sessions) — macOS and Linux.
 *
 * Usage: npm run publish:web [-- --profile web] [--no-start] [--no-open]
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

const argv = process.argv.slice(2)
const profileAt = argv.indexOf('--profile')
const profile = profileAt === -1 ? 'web' : argv[profileAt + 1]
if (profile === undefined || profile.startsWith('--')) throw new Error('--profile requires a name')
const start = !argv.includes('--no-start')
const open = !argv.includes('--no-open')

const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const profileDir = join(dshHome, 'profiles', profile)
const installedRoot = join(profileDir, 'node_modules', ...pkg.name.split('/'))
const tarball = join(root, `${pkg.name.replace(/^@/, '').replaceAll('/', '-')}-${pkg.version}.tgz`)
const logPath = join(root, 'artifacts', 'dsh-web.log')

const step = text => console.log(`[publish:${profile}] ${text}`)
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms))

const run = (command, args, cwd = root) => {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`)
}

const dshBin = spawnSync('sh', ['-c', 'command -v dsh'], { encoding: 'utf8' }).stdout?.trim()
if (dshBin === undefined || dshBin === '') throw new Error('dsh is not on PATH — expose the DSH CLI first')

const profileManifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8').catch(error => {
  throw new Error(`cannot read the ${profile} profile at ${profileDir}: ${error.message}`)
}))
const spec = profileManifest.dependencies?.[pkg.name]
if (spec === undefined) {
  throw new Error(`the ${profile} profile does not depend on ${pkg.name}; install it once with \`dsh plugin --profile ${profile} add file:<tarball>\``)
}
if (!spec.startsWith('file:') || !spec.endsWith('.tgz')) {
  throw new Error(`the ${profile} profile pins ${pkg.name} as ${spec}, not a file: build — republishing a local build would rewrite that pin`)
}

step('1/6 building the bundle')
run('npm', ['run', 'build'])

step('2/6 packing the tarball (prepack rebuilds through the real publish path)')
await rm(tarball, { force: true })
run('npm', ['pack'])
await stat(tarball)

step('3/6 verifying the publication layout')
run('npm', ['run', 'check:artifact'])

// `dsh web` itself must exit before its files are replaced, so the running instance
// is identified by the resolved CLI path rather than by a bare `web` word match.
const stopDshWeb = async () => {
  const ps = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' })
  if (ps.error !== undefined) throw ps.error
  const pids = (ps.stdout ?? '').split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (match === null) return []
    const [, pid, command] = match
    const isDshWeb = Number(pid) !== process.pid && command.includes(dshBin) && /(^|\s)web(\s|$)/.test(command)
    return isDshWeb ? [Number(pid)] : []
  })
  if (pids.length === 0) {
    step('4/6 stopping dsh web — it is not running')
    return
  }
  const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
  const waitForExit = async timeoutMs => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline && pids.some(alive)) await delay(250)
    return !pids.some(alive)
  }
  for (const pid of pids) process.kill(pid, 'SIGTERM')
  step(`4/6 stopping dsh web (SIGTERM → ${pids.join(', ')})`)
  if (await waitForExit(15_000)) return
  for (const pid of pids) process.kill(pid, 'SIGKILL')
  step(`   escalated to SIGKILL for ${pids.join(', ')}`)
  if (!(await waitForExit(5_000))) step(`   warning: ${pids.join(', ')} still appears in the process table`)
}

await stopDshWeb()

step(`5/6 reinstalling the tarball into the ${profile} profile`)
await rm(installedRoot, { recursive: true, force: true })
run(dshBin, ['plugin', '--profile', profile, 'add', `file:${tarball}`], profileDir)

const digestTree = async dir => {
  const hash = createHash('sha256')
  const walk = async current => {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) await walk(path)
      else {
        hash.update(path.slice(dir.length))
        hash.update(await readFile(path))
      }
    }
  }
  await walk(dir)
  return hash.digest('hex')
}

for (const packagePath of ['packages/agent-team/lib', 'packages/tool-agent-team/lib', 'packages/client-agent-team/lib']) {
  const [built, installed] = await Promise.all([
    digestTree(join(root, packagePath)),
    digestTree(join(installedRoot, packagePath)),
  ])
  if (built !== installed) {
    throw new Error(`the installed ${packagePath} does not match this build — the ${profile} profile kept an older extraction`)
  }
}
step(`   ${pkg.name}@${pkg.version} in ${profileDir} matches this build`)

if (!start) {
  step('done (--no-start); run `dsh web` when ready')
  process.exit(0)
}

step(`6/6 starting dsh web (log: ${logPath})`)
await mkdir(dirname(logPath), { recursive: true })
await rm(logPath, { force: true })

// `dsh web` is an alias for `dsh --profile web`, so the profile is selected once, before the
// app arguments. The server runs in its own session so it outlives this script and never owns
// the terminal it was started from.
//
// stdout must be a pipe and the file must be owned by a non-node reader: a snap-confined node
// sitting under a node ancestor cannot write a regular-file stdout (EBADF from
// SyncWriteStream), which makes the server die seconds after start with an empty log. `cat`
// therefore performs the append, and the pipeline also means `sh` stays alive for as long as
// the server does — its exit is the signal that the server died.
const quote = value => `'${value.replaceAll("'", `'\\''`)}'`
const invoked = [dshBin, '--profile', profile, ...(open ? [] : ['--no-open'])].map(quote).join(' ')
const child = spawn('sh', ['-c', `${invoked} 2>&1 | cat >> ${quote(logPath)}`], {
  cwd: root,
  detached: true,
  stdio: 'ignore',
})
child.unref()

let exited = false
child.once('exit', () => { exited = true })
const deadline = Date.now() + 120_000
let url
while (url === undefined) {
  const text = await readFile(logPath, 'utf8').catch(() => '')
  url = /dsh web: (https?:\/\/\S+)/.exec(text)?.[1]
  if (url !== undefined) break
  if (exited) throw new Error(`dsh web exited before printing a URL — read ${logPath}`)
  if (Date.now() > deadline) throw new Error(`dsh web printed no URL within 120s — read ${logPath}`)
  await delay(500)
}

console.log(`\ndsh web: ${url}\nlog: ${logPath}`)