import assert from 'node:assert/strict'
import { readMcpToolOutput } from './mcp-tool-results.mjs'

export function assertElicitationToolResult(body, callId, cancelled) {
  const text = readMcpToolOutput(body, callId)
  if (cancelled) {
    assert.deepEqual(JSON.parse(text), { action: 'cancel' })
  } else {
    assert.ok(
      text.includes('E2E_MCP_ELICITATION_ACCEPTED:owner'),
      'The real MCP server did not return the accepted audience to the model'
    )
  }
}

export function currentTurnHasToolOutput(body, callId) {
  const input = Array.isArray(body.input) ? body.input : []
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index]
    if (item?.role === 'user') return false
    if (
      ['function_call_output', 'custom_tool_call_output'].includes(item?.type) &&
      item.call_id === callId
    )
      return true
  }
  return false
}

export function currentTurnHasToolSearchResult(body, namespaceName) {
  const input = Array.isArray(body.input) ? body.input : []
  let turnStart = 0
  for (let index = input.length - 1; index >= 0; index -= 1) {
    if (input[index]?.role === 'user') {
      turnStart = index + 1
      break
    }
  }
  return input.slice(turnStart).some(item => JSON.stringify(item).includes(namespaceName))
}
