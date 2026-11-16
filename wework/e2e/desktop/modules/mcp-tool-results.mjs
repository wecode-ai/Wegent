import assert from 'node:assert/strict'

import { modelToolOutputText } from './model-tool-output.mjs'

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
  const text = modelToolOutputText(output)
  assert.ok(text, `Real MCP call ${callId} returned no result text`)
  return text
}
