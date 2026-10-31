#!/usr/bin/env node
/**
 * Agent Team external client: the one script an external harness's agent needs
 * to join a team and collaborate through the gateway's HTTP API.
 *
 * Zero dependencies, Node >= 18. Commands mirror the team communication tools:
 *
 *   join   — register as a team Member (needs the operator's boot token, once)
 *   view   — the team directory: Channels, Threads, Members
 *   inbox  — your unread triage list
 *   read   — acknowledge one Thread's unread facts; returns the next-write token
 *   history— page older facts without changing read state
 *   send   — start a Thread / reply / DM
 *   watch  — block until the team has unread work, then read it and exit
 *   job    — report progress from inside a team_job background process
 *
 * Credentials from `join` are cached in a state file (default
 * ~/.agent-team/<workspace>.<handle>.json — one per agent, so several external
 * agents or sessions on this machine each keep their own identity) and every
 * other command reuses them. Output is JSON on stdout; errors are JSON on
 * stderr with exit code 1.
 *
 * The `watch` exit IS the notification: run it in the background (bash
 * run_in_background on DSH harnesses) and its completion notice wakes you;
 * without background jobs, call it with a bounded --timeout in the foreground.
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms))

function fail(message, extra = {}) {
  process.stderr.write(`${JSON.stringify({ kind: 'error', message, ...extra }, null, 2)}\n`)
  process.exit(1)
}

function usage() {
  return `Usage: node agent-team.mjs <command> [options]

Commands:
  join    --url URL --workspace ID --token BOOT-TOKEN --handle NAME [--description TEXT] [--state FILE]
  view    [--handle H] [--state FILE]
  inbox   [--limit N] [--handle H] [--state FILE]
  read    --thread REF | --task REF [--handle H] [--state FILE]
  history --thread REF | --task REF [--before N] [--limit N] [--handle H] [--state FILE]
  send start --channel REF --body TEXT [--as-task] [--parent-task REF] [--client-request-id ID]
  send reply --thread REF | --task REF --body TEXT --base-revision N [--client-request-id ID]
  send dm    --member REF --body TEXT [--client-request-id ID]
  heartbeat [--note TEXT] [--entries JSON | --entries-file PATH] [--handle H] [--state FILE]
  dms     [--after N] [--limit N] [--handle H] [--state FILE]
  job message --body TEXT   (inside a team_job child: reads AGENT_TEAM_JOB_ID / AGENT_TEAM_JOB_TOKEN / AGENT_TEAM_GATEWAY_URL from the environment)
  watch   [--interval SEC] [--timeout SEC] [--max-reads N] [--heartbeat-seconds SEC] [--handle H] [--state FILE]

State defaults to ~/.agent-team/<workspace>.<handle>.json — one file per agent,
so several external agents (or sessions) on this machine each keep their own
identity. Pass --handle with every command, or --state to name the file
directly. JSON in, JSON out.`
}

const COMMANDS = ['join', 'view', 'inbox', 'read', 'history', 'send', 'watch', 'heartbeat', 'dms', 'job']
const [command, subcommand] = process.argv.slice(2)
if (command === undefined || COMMANDS.includes(command) === false) {
  process.stderr.write(`${usage()}\n`)
  process.exit(command === 'help' || command === '--help' ? 0 : 1)
}

const { values } = parseArgs({
  args: process.argv.slice(command === 'send' || command === 'job' ? 3 : 2),
  options: {
    url: { type: 'string' },
    workspace: { type: 'string' },
    token: { type: 'string' },
    handle: { type: 'string' },
    description: { type: 'string' },
    state: { type: 'string' },
    limit: { type: 'string' },
    thread: { type: 'string' },
    task: { type: 'string' },
    before: { type: 'string' },
    channel: { type: 'string' },
    member: { type: 'string' },
    body: { type: 'string' },
    'base-revision': { type: 'string' },
    'as-task': { type: 'boolean' },
    'parent-task': { type: 'string' },
    'client-request-id': { type: 'string' },
    interval: { type: 'string', default: '3' },
    timeout: { type: 'string', default: '600' },
    'max-reads': { type: 'string', default: '5' },
    note: { type: 'string' },
    entries: { type: 'string' },
    'entries-file': { type: 'string' },
    'heartbeat-seconds': { type: 'string', default: '30' },
    after: { type: 'string' },
  },
  strict: false,
})

/** State resolution: --state wins, else ~/.agent-team/<workspace>.json. */
function sanitizeStatePart(value) {
  return value.replace(/[^\w.-]/gu, '_')
}

/**
 * State resolution: --state wins; else the per workspace+handle default — one
 * file per agent, so two agents (or two sessions) sharing this machine never
 * overwrite each other's credentials and never act as one member. With no
 * --handle, resolve a single match and refuse to guess among several: two
 * agents sharing one state file would share one inbox and race each other's
 * reads and replies.
 */
async function statePathOf(values) {
  if (values.state !== undefined) return resolve(values.state)
  const workspace = values.workspace
  if (workspace === undefined || workspace === '') {
    return fail('join requires --workspace; other commands need --workspace (plus --handle when several agents share this machine) or --state (the file join wrote)', { usage: usage() })
  }
  const directory = join(homedir(), '.agent-team')
  const base = sanitizeStatePart(workspace)
  if (values.handle !== undefined && values.handle !== '') {
    return join(directory, `${base}.${sanitizeStatePart(values.handle)}.json`)
  }
  let entries
  try {
    entries = await readdir(directory)
  } catch {
    return fail(`no state directory at ${directory}; run the join command first`)
  }
  const candidates = entries.filter(entry => entry === `${base}.json` || (entry.startsWith(`${base}.`) && entry.endsWith('.json')))
  if (candidates.length === 1) return join(directory, candidates[0])
  if (candidates.length === 0) return fail(`no state file for workspace '${workspace}' under ${directory}; run the join command first`)
  return fail(`several agents have joined workspace '${workspace}' on this machine; pass --handle <handle> or --state <file> to pick one identity`, { candidates: candidates.sort() })
}

async function loadState(values) {
  const path = await statePathOf(values)
  let raw
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return fail(`no state file at ${path}; run the join command first`)
  }
  const state = JSON.parse(raw)
  if (state.baseUrl === undefined || state.workspaceId === undefined || state.memberId === undefined || state.token === undefined) {
    return fail(`state file ${path} is incomplete; run the join command again`)
  }
  return { ...state, path }
}

async function saveState(path, state) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

async function api(state, method, path, body) {
  const response = await fetch(`${state.baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-agent-team-member': state.memberId,
      authorization: `Bearer ${state.token}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  })
  const text = await response.text()
  let parsed
  try {
    parsed = text === '' ? {} : JSON.parse(text)
  } catch {
    parsed = { raw: text }
  }
  if (response.ok === false) {
    const detail = parsed?.error?.message ?? `HTTP ${response.status}`
    return fail(`${method} ${path} refused: ${detail}`, { status: response.status, body: parsed })
  }
  return parsed
}

function positiveInt(value, name) {
  const parsed = Number(value)
  if (Number.isSafeInteger(parsed) === false || parsed < 1) return fail(`--${name} must be a positive integer`)
  return parsed
}

/** Build one heartbeat payload from --note plus --entries / --entries-file. */
async function heartbeatPayloadOf(values) {
  if (values.note === undefined && values.entries === undefined && values['entries-file'] === undefined) {
    return fail('heartbeat requires --note and/or --entries (or --entries-file); the note is what the team reads as your current status')
  }
  let entries
  if (values['entries-file'] !== undefined) {
    try {
      entries = JSON.parse(await readFile(resolve(values['entries-file']), 'utf8'))
    } catch (error) {
      return fail(`--entries-file could not be read as JSON: ${error.message}`)
    }
  } else if (values.entries !== undefined) {
    try {
      entries = JSON.parse(values.entries)
    } catch (error) {
      return fail(`--entries is not valid JSON: ${error.message}`)
    }
  }
  if (entries !== undefined && Array.isArray(entries) === false) return fail('--entries must be a JSON array of {role, text} turns')
  return {
    ...(values.note === undefined ? {} : { note: values.note }),
    ...(entries === undefined ? {} : { entries }),
  }
}

/**
 * One piggyback heartbeat: watch sends the last synced snapshot on its poll
 * cadence so presence stays fresh while the agent idles, without the model
 * having to do anything. A beat failure never breaks the watch loop — the
 * next cadence tick retries.
 */
async function piggybackHeartbeat(state, payload) {
  if (payload === undefined) return
  try {
    await api(state, 'POST', `/agent-team/${encodeURIComponent(state.workspaceId)}/heartbeat`, payload)
  } catch { /* the next cadence tick retries; the watch loop continues */ }
}

async function main() {
    if (command === 'join') {
    if (values.url === undefined || values.workspace === undefined || values.token === undefined || values.handle === undefined) {
      process.stderr.write(`${usage()}\n`)
      process.exit(1)
    }
    const baseUrl = values.url.replace(/\/+$/u, '')
  const response = await fetch(`${baseUrl}/agent-team/${encodeURIComponent(values.workspace)}/members`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${values.token}` },
    body: JSON.stringify({
      handle: values.handle,
      ...(values.description === undefined ? {} : { description: values.description }),
    }),
    signal: AbortSignal.timeout(60_000),
  }).catch(error => {
    const refused = error?.cause?.code === 'ECONNREFUSED' || error?.code === 'ECONNREFUSED'
    return fail(`join could not reach ${baseUrl}: ${error.message}${refused ? ' — nothing is listening there; the gateway is opt-in, so ask the operator to enable the external API on the Team Host settings row (enable, port, boot token; no restart needed)' : ''}`)
  })
    const body = await response.json().catch(() => ({}))
    if (response.ok === false) {
      const detail = body?.error?.message ?? `HTTP ${response.status}`
      // A taken handle means this identity already joined here: its state file
      // likely still holds working credentials (tokens are derived, so they
      // never expire) — point the caller there instead of at a fresh join.
      const taken = /handle/i.test(detail)
      const hint = taken === false ? '' : ` — this handle already joined this workspace; run view --workspace <id> --handle ${values.handle} to reuse its credentials (state file ${await statePathOf(values)}), or pick a fresh --handle for a second agent`
      fail(`join refused: ${detail}${hint}`, { status: response.status })
    }
    const state = { baseUrl, workspaceId: values.workspace, memberId: body.memberId, token: body.token }
    const path = await statePathOf(values)
    await saveState(path, state)
    process.stdout.write(`${JSON.stringify({ kind: 'joined', ...state, stateFile: path }, null, 2)}\n`)
  } else if (command === 'view') {
    const state = await loadState(values)
    process.stdout.write(`${JSON.stringify(await api(state, 'GET', `/agent-team/${encodeURIComponent(state.workspaceId)}/view`), null, 2)}\n`)
  } else if (command === 'inbox') {
    const state = await loadState(values)
    const limit = values.limit === undefined ? '' : `?limit=${positiveInt(values.limit, 'limit')}`
    process.stdout.write(`${JSON.stringify(await api(state, 'GET', `/agent-team/${encodeURIComponent(state.workspaceId)}/inbox${limit}`), null, 2)}\n`)
  } else if (command === 'read' || command === 'history') {
    const state = await loadState(values)
    if (values.thread === undefined && values.task === undefined) return fail(`${command} requires --thread or --task`)
    const payload = {
      ...(values.thread === undefined ? {} : { threadRef: values.thread }),
      ...(values.task === undefined ? {} : { taskRef: values.task }),
      ...(values.before === undefined ? {} : { beforeSequence: positiveInt(values.before, 'before') }),
      ...(values.limit === undefined ? {} : { limit: positiveInt(values.limit, 'limit') }),
    }
    process.stdout.write(`${JSON.stringify(await api(state, 'POST', `/agent-team/${encodeURIComponent(state.workspaceId)}/threads/${command}`, payload), null, 2)}\n`)
  } else if (command === 'send') {
    const state = await loadState(values)
    const payload = {
      action: subcommand,
      ...(values['client-request-id'] === undefined ? {} : { clientRequestId: values['client-request-id'] }),
    }
    if (subcommand === 'start') {
      if (values.channel === undefined || values.body === undefined) return fail('send start requires --channel and --body')
      payload.channelRef = values.channel
      payload.body = values.body
      if (values['as-task'] === true) payload.asTask = true
      if (values['parent-task'] !== undefined) payload.parentTaskRef = values['parent-task']
    } else if (subcommand === 'dm') {
      if (values.member === undefined || values.body === undefined) return fail('send dm requires --member and --body')
      payload.memberRef = values.member
      payload.body = values.body
    } else {
      if (values.body === undefined || values['base-revision'] === undefined || (values.thread === undefined && values.task === undefined)) {
        return fail('send reply requires --thread (or --task), --body, and --base-revision from a drained read')
      }
      if (values.thread !== undefined) payload.threadRef = values.thread
      if (values.task !== undefined) payload.taskRef = values.task
      payload.body = values.body
      payload.baseRevision = positiveInt(values['base-revision'], 'base-revision')
    }
    process.stdout.write(`${JSON.stringify(await api(state, 'POST', `/agent-team/${encodeURIComponent(state.workspaceId)}/messages`, payload), null, 2)}\n`)
  } else if (command === 'heartbeat') {
    const state = await loadState(values)
    const payload = await heartbeatPayloadOf(values)
    const result = await api(state, 'POST', `/agent-team/${encodeURIComponent(state.workspaceId)}/heartbeat`, payload)
    // Remember what the team last saw, so the watch loop can keep presence
    // fresh with the same snapshot between explicit heartbeats.
    await saveState(state.path, { ...state, lastHeartbeat: payload })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else if (command === 'dms') {
    const state = await loadState(values)
    const after = values.after === undefined ? '' : `&after=${positiveInt(values.after, 'after')}`
    const limit = values.limit === undefined ? '' : `&limit=${positiveInt(values.limit, 'limit')}`
    process.stdout.write(`${JSON.stringify(await api(state, 'GET', `/agent-team/${encodeURIComponent(state.workspaceId)}/dms?${after}${limit}`), null, 2)}\n`)
  } else if (command === 'job') {
    if (subcommand !== 'message') return fail('job takes one subcommand: message --body TEXT')
    const jobId = process.env.AGENT_TEAM_JOB_ID
    const jobToken = process.env.AGENT_TEAM_JOB_TOKEN
    const gatewayUrl = process.env.AGENT_TEAM_GATEWAY_URL
    if (jobId === undefined || jobToken === undefined || gatewayUrl === undefined) {
      return fail('job message only runs inside a team_job child process: AGENT_TEAM_JOB_ID, AGENT_TEAM_JOB_TOKEN, and AGENT_TEAM_GATEWAY_URL must be in its environment')
    }
    if (values.body === undefined || values.body.trim() === '') return fail('job message requires --body TEXT')
    const response = await fetch(`${gatewayUrl}/jobs/${encodeURIComponent(jobId)}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${jobToken}` },
      body: JSON.stringify({ body: values.body }),
      signal: AbortSignal.timeout(60_000),
    })
    const text = await response.text()
    let parsed
    try { parsed = text === '' ? {} : JSON.parse(text) } catch { parsed = { raw: text } }
    if (response.ok === false) {
      const detail = parsed?.error?.message ?? `HTTP ${response.status}`
      return fail(`job message refused: ${detail}`, { status: response.status, body: parsed })
    }
    process.stdout.write(`${JSON.stringify(parsed, null, 2)}\n`)
  } else if (command === 'watch') {
    const state = await loadState(values)
    const intervalMs = positiveInt(values.interval, 'interval') * 1000
    const deadline = Date.now() + positiveInt(values.timeout, 'timeout') * 1000
    const maxReads = positiveInt(values['max-reads'], 'max-reads')
    const heartbeatSeconds = positiveInt(values['heartbeat-seconds'], 'heartbeat-seconds')
    const heartbeatEveryMs = heartbeatSeconds * 1000
    const inboxPath = `/agent-team/${encodeURIComponent(state.workspaceId)}/inbox`
    const dmsPath = `/agent-team/${encodeURIComponent(state.workspaceId)}/dms`
    // The DM cursor is the one read-state a poller owns: DMs never enter the
    // Inbox and are never acknowledged by reads, so the watcher tracks the
    // ledger sequence it last surfaced and includes everything newer.
    let dmCursor = state.lastDmSequence ?? 0
    // The first piggyback beat fires right away: mounting the watcher IS a
    // live signal, even before any quiet cadence elapses.
    let nextBeatAt = 0
    while (Date.now() < deadline) {
      if (Date.now() >= nextBeatAt) {
        await piggybackHeartbeat(state, state.lastHeartbeat)
        nextBeatAt = Date.now() + heartbeatEveryMs
      }
      const inbox = await api(state, 'GET', inboxPath)
      const poll = await api(state, 'GET', `${dmsPath}?after=${dmCursor}`)
      const incoming = poll.dms.filter(dm => dm.direction === 'in')
      if (inbox.totalUnreadCount > 0 || incoming.length > 0) {
        const reads = []
        for (const item of inbox.items.slice(0, maxReads)) {
          const read = await api(state, 'POST', `/agent-team/${encodeURIComponent(state.workspaceId)}/threads/read`, { threadRef: item.thread.threadRef })
          reads.push({
            threadRef: read.thread.threadRef,
            channelRef: read.anchor?.channelRef,
            taskRef: read.task?.taskRef,
            taskStatus: read.task?.status,
            baseRevision: read.thread.revision,
            remainingUnreadCount: read.remainingUnreadCount,
            facts: read.facts.map(entry => ({
              sequence: entry.fact.sequence,
              kind: entry.fact.kind,
              occurredAt: entry.fact.occurredAt,
              unread: entry.unread,
              direct: entry.direct,
              // Message facts carry the prose; activity facts carry the work event.
              ...(entry.fact.kind === 'message'
                ? { sender: entry.fact.message.sender, body: entry.fact.message.body, mentions: entry.fact.mentions }
                : { activity: entry.fact.activity.kind, actor: entry.fact.activity.actor, taskRef: entry.fact.activity.taskRef }),
            })),
          })
        }
        // Advance past everything this wake surfaced — incoming DMs included.
        for (const dm of poll.dms) dmCursor = Math.max(dmCursor, dm.sequence)
        await saveState(state.path, { ...state, lastDmSequence: dmCursor })
        process.stdout.write(`${JSON.stringify({
          kind: 'messages',
          totalUnreadCount: inbox.totalUnreadCount,
          note: inbox.items.length > maxReads ? 'more unread Threads beyond this wake; run watch again' : undefined,
          reads,
          dms: incoming.map(dm => ({ from: dm.peerMemberId, body: dm.body, occurredAt: dm.occurredAt })),
          dmNote: incoming.length > 0 ? 'DMs have no thread: answer with `send dm` back to the sender, or start a Thread if the work needs the team' : undefined,
        }, null, 2)}\n`)
        process.exit(0)
      }
      await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())))
    }
    process.stdout.write(`${JSON.stringify({ kind: 'quiet', message: 'no unread team messages before the timeout' }, null, 2)}\n`)
  }
}

await main()
