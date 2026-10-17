import { describe, expect, it } from 'vitest'
import { humanTranscriptEntriesOf, renderFailureTranscript, renderTranscriptEvent, transcriptEntryOf, type TranscriptEvent } from '../src/failure-transcript.ts'
import { AGENT_TEAM_PLUGIN_ID, AGENT_TEAM_V3_RENAMED_KIND } from '../src/context-source.ts'

const event = (type: string, data: unknown): TranscriptEvent => ({ type, time: 1_729_000_000_000, data })

const userText = (text: string, source: Record<string, unknown> = { kind: 'user' }): TranscriptEvent =>
  event('user/message', { role: 'user', source, content: [{ type: 'text', text }] })

describe('transcript fold — role lanes', () => {
  it('keeps a direct Human prompt on the user lane', () => {
    expect(transcriptEntryOf(userText('run the tests'))).toMatchObject({ role: 'user', text: 'run the tests' })
  })

  it('labels a Team relay and a Host notice by their source attribution, current and V3-renamed kinds', () => {
    expect(transcriptEntryOf(userText('Direct message from @builder: is the build green?', { kind: AGENT_TEAM_PLUGIN_ID, form: 'relay' })))
      .toMatchObject({ role: 'team' })
    expect(transcriptEntryOf(userText('Context reset notice', { kind: AGENT_TEAM_PLUGIN_ID, form: 'notice', summary: 'x' })))
      .toMatchObject({ role: 'notice' })
    expect(transcriptEntryOf(userText('snapshot envelope', { kind: AGENT_TEAM_V3_RENAMED_KIND, form: 'snapshot', sections: [] })))
      .toMatchObject({ role: 'notice' })
  })

  it('renders the system message envelope on the system lane and skips an empty one', () => {
    const entry = transcriptEntryOf(event('system/message', { turn: 1, step: 1, message: { role: 'system', content: [{ type: 'text', text: 'You are an Agent Team Member.' }] } }))
    expect(entry).toMatchObject({ role: 'system', text: 'You are an Agent Team Member.' })
    expect(transcriptEntryOf(event('system/message', { turn: 1, step: 1, message: { role: 'system', content: [] } }))).toBeUndefined()
  })

  it('reads the assistant text from the event message, not the envelope', () => {
    const entry = transcriptEntryOf(event('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'Build is green.' }] }, stream: [] }))
    expect(entry).toMatchObject({ role: 'assistant', text: 'Build is green.' })
  })
})

describe('transcript fold — clamping modes', () => {
  const markdown = '# Title\n\n- first\n- second\n\n**bold** body'

  it('multiline mode keeps the stored line breaks for Markdown rendering', () => {
    const entry = transcriptEntryOf(userText(markdown), { multiline: true })
    expect(entry?.text).toBe(markdown)
  })

  it('the default mode folds to one line, which is what the doctor transcript needs', () => {
    const entry = transcriptEntryOf(userText(markdown))
    expect(entry?.text).toBe('# Title - first - second **bold** body')
    expect(renderTranscriptEvent(userText(markdown))).toBe('[user] # Title - first - second **bold** body')
  })

  it('multiline mode keeps a tool result text block while the default mode stringifies', () => {
    const result = event('tool/result', { turn: 1, step: 1, message: { role: 'tool', content: [{ type: 'text', text: 'line one\nline two' }] } })
    expect(transcriptEntryOf(result, { multiline: true })?.text).toBe('line one\nline two')
    expect(transcriptEntryOf(result)?.text).toContain('line one\\nline two')
  })

  it('clamps an over-budget entry only in the model-facing mode: multiline keeps the stored text whole', () => {
    const long = `${'x'.repeat(2001)} tail`
    expect(transcriptEntryOf(userText(long))?.text).toBe(`${'x'.repeat(2000)}…`)
    const multi = `${'y'.repeat(9000)}\nz`
    expect(transcriptEntryOf(userText(multi), { multiline: true })?.text).toBe(`${'y'.repeat(9000)}\nz`)
    expect(transcriptEntryOf(userText(multi), { multiline: true })?.text).not.toContain('…')
  })

  it('keeps over-budget tool arguments and tool results whole in multiline mode', () => {
    const args = `{"command":"ls ${'d'.repeat(1200)}"}`
    expect(transcriptEntryOf(event('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: args }), { multiline: true })?.text).toBe(`bash\n${args}`)
    const result = event('tool/result', { turn: 1, step: 1, message: { role: 'tool', content: [{ type: 'text', text: 'r'.repeat(5000) }] } })
    expect(transcriptEntryOf(result, { multiline: true })?.text).toBe('r'.repeat(5000))
  })

  it('splits the tool-call name from its arguments only in multiline mode', () => {
    const call = event('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' })
    expect(transcriptEntryOf(call)?.text).toBe('bash {"command":"ls"}')
    expect(transcriptEntryOf(call, { multiline: true })?.text).toBe('bash\n{"command":"ls"}')
  })
})

describe('humanTranscriptEntriesOf — the review fold expands inbox splices', () => {
  const spliced = (messages: readonly unknown[]): TranscriptEvent => event('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: messages })

  it('renders each inserted message on its own lane, keeping stored line breaks', () => {
    const entries = humanTranscriptEntriesOf(spliced([
      { role: 'user', source: { kind: AGENT_TEAM_PLUGIN_ID, form: 'relay' }, content: [{ type: 'text', text: 'Direct message from @builder:\n- green\n- ready' }] },
      { role: 'user', source: { kind: AGENT_TEAM_PLUGIN_ID, form: 'notice', summary: 's' }, content: [{ type: 'text', text: 'Inbox hint' }] },
      { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Human typed this' }] },
    ]))
    expect(entries.map(entry => entry.role)).toEqual(['team', 'notice', 'user'])
    expect(entries[0]!.text).toBe('Direct message from @builder:\n- green\n- ready')
  })

  it('drops empty batches and contentless messages instead of rendering blank rows', () => {
    expect(humanTranscriptEntriesOf(spliced([]))).toEqual([])
    expect(humanTranscriptEntriesOf(spliced([{ role: 'user', source: { kind: 'user' }, content: [] }]))).toEqual([])
  })

  it('keeps the multiline folding for ordinary events', () => {
    const entries = humanTranscriptEntriesOf(event('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '## Done\n\nall green' }] }, stream: [] }))
    expect(entries).toEqual([{ role: 'assistant', text: '## Done\n\nall green' }])
  })
})

describe('renderFailureTranscript — the doctor fold keeps single-line rendering', () => {
  it('renders the new lanes as single labelled lines and keeps the tail', () => {
    const events = [
      event('system/message', { turn: 1, step: 1, message: { role: 'system', content: [{ type: 'text', text: 'instructions\nsecond line' }] } }),
      userText('Direct message from @builder: ping', { kind: AGENT_TEAM_PLUGIN_ID, form: 'relay' }),
      event('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'pong' }] }, stream: [] }),
    ]
    const transcript = renderFailureTranscript(events)
    expect(transcript).toBe('[system] instructions second line\n[team] Direct message from @builder: ping\n[assistant] pong')
  })

  it('still ignores inbox splices: the doctor budget is the tail-evidence contract', () => {
    expect(renderFailureTranscript([event('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'spliced' }] }] })]))
      .toBe('(the session log carries no model-visible events)')
  })
})
