import assert from 'node:assert/strict'

export function readMcpToolOutput(request, callId) {
  const output = request.input.find(
    item =>
      ['function_call_output', 'mcp_tool_call_output', 'custom_tool_call_output'].includes(
        item.type
      ) && item.call_id === callId
  )?.output
  assert.notEqual(output, undefined, `Real MCP call ${callId} did not return a tool output`)
  const blocks = typeof output === 'string' ? JSON.parse(output) : output
  assert.ok(
    Array.isArray(blocks),
    `Codex MCP output must contain input_text blocks: ${JSON.stringify(blocks)}`
  )
  const text = blocks
    .filter(block => block.type === 'input_text' && !block.text.startsWith('Wall time:'))
    .map(block => block.text)
    .join('\n')
  assert.ok(text, `Real MCP call ${callId} returned no result text`)
  return text
}
