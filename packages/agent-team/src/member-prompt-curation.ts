/**
 * Pure construction and parsing for the Prompt dialog's one-shot LLM
 * curation. The Host builds one bounded model call from the Member's live
 * prompt surface, private skills catalog, identity, and the Human's free-text
 * requirements, then parses the reply into a propose-only draft. Nothing here
 * touches the ledger — the proposal only ever backfills the dialog form, and
 * the Human commits (or discards) it through the normal member update.
 *
 * @module @wowyuarm/dsh-agent-team/member-prompt-curation
 */
import type { RequestMessage } from '@deepseek-ai/dsh-llm'

/**
 * Hard wall-clock bound of the one-shot curation call. The Host races this
 * timeout against the client's cancellation signal so a stuck provider can
 * never pin the dialog (or a remote worker) for longer than one minute.
 */
export const CURATE_TIMEOUT_MS = 60_000

/** Output token ceiling of the curation call; the proposal is small by design. */
export const CURATE_MAX_TOKENS = 4096

/**
 * Per-section text cap inside the curation input: identity and boundaries
 * matter, not full section prose. Each truncated text ends with an ellipsis
 * so the model knows it saw a cut.
 */
export const CURATE_SECTION_TEXT_CAP = 1200

/** Cap for the Human's free-text requirements inside the curation input. */
export const CURATE_REQUIREMENTS_CAP = 4000

/** The custom role paragraph cap the durable edit already enforces. */
export const CURATE_PROMPT_BYTES = 8192

/** One live prompt section as the curation input presents it. */
export interface CurateInputSection {
  readonly name: string
  readonly text: string
  /** Drop requests for a protected name are refused at consumption. */
  readonly isProtected: boolean
  /** No current tool name maps to this section. */
  readonly proseOnly: boolean
}

/** Everything the one-shot call sees about one Member. */
export interface CuratePromptInput {
  readonly handle: string
  readonly description: string
  /** The stored custom role paragraph, if any. */
  readonly currentParagraph?: string
  /** The Member's private skills catalog names (bundled core skills first). */
  readonly skills: readonly string[]
  readonly sections: readonly CurateInputSection[]
  /** The Human's requirements, already capped by the caller or here. */
  readonly requirements: string
}

/** The parsed model proposal; every field optional and client-reviewed. */
export interface CurateProposal {
  readonly droppedSectionNames?: readonly string[]
  readonly skillsAllow?: readonly string[]
  readonly customPrompt?: string
}

const ROLE_LINE = [
  'You curate the system prompt of one AI team member. You propose edits only:',
  'a human reviews and applies them. Answer with EXACTLY one JSON object and',
  'nothing else — no prose, no code fences.',
].join(' ')

const SHAPE_LINE = [
  'Shape: {"droppedSectionNames": string[], "skillsAllow": string[], "customPrompt": string}.',
  '- droppedSectionNames: prompt sections to REMOVE from the member next assemblies.',
  '  Never name a section whose protected flag is true. Omit the field or pass [] to keep every section.',
  '- skillsAllow: the skill names the member should have enabled, as a subset of',
  '  the catalog names listed below. Omit the field to keep the current selection.',
  '- customPrompt: a rewritten custom role paragraph implementing the requirements.',
  '  Plain prose, at most 8192 UTF-8 bytes. Omit the field to keep the current paragraph.',
].join('\n')

function cap(text: string, cap_: number): string {
  return text.length <= cap_ ? text : `${text.slice(0, cap_)}…`
}

/**
 * Build the one-shot call: an identity-free system line plus one user message
 * carrying the bounded member facts and the requirements. Section texts and
 * the requirements are capped so a huge prompt surface cannot grow the call
 * without bound; the JSON shape instruction is explicit because the reply is
 * parsed defensively.
 */
export function buildCurateMessages(input: CuratePromptInput): { readonly system: string; readonly messages: readonly RequestMessage[] } {
  const sectionLines = input.sections.map(section =>
    `- name: ${section.name}${section.isProtected ? ' (protected — never propose dropping)' : ''}${section.proseOnly ? ' (prose-only: maps no tool)' : ''}\n  text: ${cap(section.text, CURATE_SECTION_TEXT_CAP)}`)
  const lines = [
    `Member handle: ${input.handle}`,
    `Member description: ${input.description}`,
    `Current custom role paragraph: ${input.currentParagraph === undefined || input.currentParagraph.trim() === '' ? '(none)' : cap(input.currentParagraph, CURATE_SECTION_TEXT_CAP)}`,
    `Private skills catalog (names only): ${input.skills.length === 0 ? '(none)' : input.skills.join(', ')}`,
    'Assembled prompt sections:',
    ...sectionLines,
    '',
    'Human requirements:',
    cap(input.requirements, CURATE_REQUIREMENTS_CAP),
  ]
  return {
    system: `${ROLE_LINE}\n${SHAPE_LINE}`,
    messages: [{ role: 'user', content: [{ type: 'text', text: lines.join('\n') }] }],
  }
}

/** Strip one optional Markdown code fence around a JSON payload. */
function unfence(text: string): string {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(text)
  return fenced?.[1] ?? text
}

function stringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  // Trim and drop blanks: a model-supplied name never legitimately carries
  // surrounding whitespace, and section or skill names are plain identifiers.
  const names = value
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
    .map(name => name.trim())
  return [...new Set(names)].sort()
}

/**
 * Parse the model reply defensively: tolerate Markdown fences, extract the
 * first JSON object, and type-guard every field. Unknown fields are ignored;
 * a wrong-typed field is dropped rather than fatal — except a `customPrompt`
 * over the byte cap, which is a contract violation worth failing loudly.
 * Dropped section names run through `protect` so a protected name can never
 * reach the dialog's drop set even if the model ignored its instruction.
 */
export function parseCurateProposal(text: string, protect: (name: string) => boolean): CurateProposal {
  const unfenced = unfence(text)
  const start = unfenced.indexOf('{')
  const end = unfenced.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('curation reply contains no JSON object')
  let parsed: unknown
  try {
    parsed = JSON.parse(unfenced.slice(start, end + 1))
  } catch {
    throw new Error('curation reply is not valid JSON')
  }
  // Unreachable as a JSON array: the slice starts at the first brace, so the
  // parsed top level is always an object or the parse itself failed.
  if (parsed === null || typeof parsed !== 'object') throw new Error('curation reply is not a JSON object')
  const record = parsed as Record<string, unknown>
  const droppedRaw = stringArray(record.droppedSectionNames)
  const dropped = droppedRaw?.filter(name => !protect(name))
  const skillsAllow = stringArray(record.skillsAllow)
  const paragraphRaw = record.customPrompt
  if (paragraphRaw !== undefined && typeof paragraphRaw !== 'string') throw new Error('curation reply customPrompt is not a string')
  const paragraph = paragraphRaw?.trim()
  if (paragraph !== undefined && paragraph !== '' && new TextEncoder().encode(paragraph).length > CURATE_PROMPT_BYTES) {
    throw new Error('curation reply customPrompt exceeds the 8192-byte limit')
  }
  return {
    ...(dropped !== undefined && dropped.length > 0 ? { droppedSectionNames: dropped } : {}),
    ...(skillsAllow !== undefined && skillsAllow.length > 0 ? { skillsAllow } : {}),
    ...(paragraph !== undefined && paragraph !== '' ? { customPrompt: paragraph } : {}),
  }
}
