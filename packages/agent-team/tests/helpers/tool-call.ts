/**
 * One tool call through the service-level batch executor, returning the
 * settled result of that call. The batch API replaced the per-call
 * convenience, so the specs keep their per-call ergonomics through here.
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolBatchInput, ToolBatchResult, ToolExecutionResult } from '@deepseek-ai/dsh-tools'

type ToolBatchService = { execute(input: ToolBatchInput): Promise<ToolBatchResult> }

export async function executeToolCall(
  tools: ToolBatchService,
  agent: Agent,
  callId: ToolCallId,
  name: string,
  args: unknown,
): Promise<ToolExecutionResult> {
  const batch = await tools.execute({
    calls: [{ type: 'tool-call', id: callId, name, arguments: JSON.stringify(args) }],
    signal: new AbortController().signal,
    agent,
  })
  const result = batch.results[0]?.result
  if (result === undefined) throw new Error(`tool call ${name} (${callId}) settled without a result`)
  return result
}
