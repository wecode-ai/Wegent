import assert from 'node:assert/strict'

const TIMING_HEADER = /^Wall time: \d+(?:\.\d+)? seconds\nOutput:(?:\n|$)/

export function readMcpToolOutput(request, callId) {
  const output = request.input.find(
    item =>
      ['function_call_output', 'mcp_tool_call_output', 'custom_tool_call_output'].includes(
        item.type
      ) && item.call_id === callId
  )?.output
  assert.notEqual(output, undefined, `Real MCP call ${callId} did not return a tool output`)
  assert.ok(
    typeof output === 'string' || Array.isArray(output),
    `Codex MCP output must contain text or content blocks: ${JSON.stringify(output)}`
  )
  const text =
    typeof output === 'string'
      ? output.replace(TIMING_HEADER, '')
      : output
          .filter(block => block.type === 'input_text')
          .map(block => block.text.replace(TIMING_HEADER, ''))
          .filter(Boolean)
          .join('\n')
  assert.ok(text, `Real MCP call ${callId} returned no result text`)
  return text
}
