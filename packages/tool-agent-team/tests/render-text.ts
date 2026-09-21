import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { apply } from '../src/index.ts'
import { registerContextTools } from '../src/context-tools.ts'

/**
 * Shared render-spec harness: registers the Team tools into a throwaway
 * registry and renders one structured value to text, because renders are the
 * only channel a tool result reaches the model through. Asserting on this
 * text — not the schema — is what locks the model-visible contract.
 */
export function teamTools(): Map<string, ToolDefinition> {
  const registered = new Map<string, ToolDefinition>()
  apply({ tools: { register: (tool: unknown) => {
    const definition = tool as ToolDefinition
    registered.set(definition.name, definition)
  } } } as never)
  return registered
}

export function contextTools(): Map<string, ToolDefinition> {
  const registered = new Map<string, ToolDefinition>()
  // The context rows resolve the Host and the query service at call time, so
  // the render harness only needs the registry — a `get` that answers nothing
  // keeps that laziness honest instead of faking a service.
  registerContextTools({ tools: { register: (tool: unknown) => {
    const definition = tool as ToolDefinition
    registered.set(definition.name, definition)
  } }, get: () => undefined } as never)
  return registered
}

export function renderText(tool: ToolDefinition, args: Record<string, unknown>, value: unknown): string {
  const blocks = tool.output.render(args, value as never)
  return blocks.map(block => block.type === 'text' ? block.text : '').join('\n')
}

/** Count how many times a label appears — the "exactly one" discipline for token hand-offs. */
export function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}
