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
 *
 * Credentials from `join` are cached in a state file (default
 * ~/.agent-team/<workspace>.json) and every other command reuses them.
 * Output is JSON on stdout; errors are JSON on stderr with exit code 1.
 *
 * The `watch` exit IS the notification: run it in the background (bash
 * run_in_background on DSH harnesses) and its completion notice wakes you;
 * without background jobs, call it with a bounded --timeout in the foreground.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
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
  view    [--state FILE]
  inbox   [--limit N] [--state FILE]
  read    --thread REF | --task REF [--state FILE]
  history --thread REF | --task REF [--before N] [--limit N] [--state FILE]
  send start --channel REF --body TEXT [--as-task] [--parent-task REF] [--client-request-id ID]
  send reply --thread REF | --task REF --body TEXT --base-revision N [--client-request-id ID]
  send dm    --member REF --body TEXT [--client-request-id ID]
  watch   [--interval SEC] [--timeout SEC] [--max-reads N] [--state FILE]

State defaults to ~/.agent-team/<workspace>.json. JSON in, JSON out.`
}

const COMMANDS = ['join', 'view', 'inbox', 'read', 'history', 'send', 'watch']
const [command, subcommand] = process.argv.slice(2)
if (command === undefined || COMMANDS.includes(command) === false) {
  process.stderr.write(`${usage()}\n`)
  process.exit(command === 'help' || command === '--help' ? 0 : 1)
}

const { values } = parseArgs({
  args: process.argv.slice(command === 'send' ? 3 : 2),
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
  },
  strict: false,
})

/** State resolution: --state wins, else ~/.agent-team/<workspace>.json. */
async function statePathOf(values) {
  if (values.state !== undefined) return resolve(values.state)
  const workspace = values.workspace
  if (workspace === undefined || workspace === '') {
    return fail('join requires --workspace; other commands need --workspace or --state (the file join wrote)', { usage: usage() })
  }
  return join(homedir(), '.agent-team', `${workspace.replace(/[^\w.-]/gu, '_')}.json`)
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
      fail(`join refused: ${body?.error?.message ?? `HTTP ${response.status}`}`, { status: response.status })
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
  } else if (command === 'watch') {
    const state = await loadState(values)
    const intervalMs = positiveInt(values.interval, 'interval') * 1000
    const deadline = Date.now() + positiveInt(values.timeout, 'timeout') * 1000
    const maxReads = positiveInt(values['max-reads'], 'max-reads')
    const inboxPath = `/agent-team/${encodeURIComponent(state.workspaceId)}/inbox`
    while (Date.now() < deadline) {
      const inbox = await api(state, 'GET', inboxPath)
      if (inbox.totalUnreadCount > 0) {
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
        process.stdout.write(`${JSON.stringify({
          kind: 'messages',
          totalUnreadCount: inbox.totalUnreadCount,
          note: inbox.items.length > maxReads ? 'more unread Threads beyond this wake; run watch again' : undefined,
          reads,
        }, null, 2)}\n`)
        process.exit(0)
      }
      await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())))
    }
    process.stdout.write(`${JSON.stringify({ kind: 'quiet', message: 'no unread team messages before the timeout' }, null, 2)}\n`)
  }
}

await main()
