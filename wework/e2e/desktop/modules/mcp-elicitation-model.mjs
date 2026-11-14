import assert from 'node:assert/strict'
import { selectedToolCall } from './model-tool-calls.mjs'
import { readMcpToolOutput } from './mcp-tool-results.mjs'
import {
  assistantMessage,
  responseCompleted,
  responseCreated,
  selectMcpTool,
  selectTool,
  selectToolSearch,
  toolSearchResponseEvents,
} from './response-protocol.mjs'
import {
  MCP_ELICITATION_ACCEPTED_MARKER,
  MCP_ELICITATION_CALL_ID,
  MCP_ELICITATION_COMPLETION_TEXT,
  MCP_ELICITATION_NAMESPACE,
  MCP_ELICITATION_PROMPT,
  MCP_ELICITATION_SEARCH_ID,
  MCP_ELICITATION_TOOL_NAME,
} from './shared.mjs'

const timeoutScenarios = [null, null, 'url_timeout', 'form_timeout']

export function createMcpElicitationModel() {
  let round = 1
  let stage = 'search'
  let outputCallId
  let waitCount = 0

  return (body, responseId) => {
    assert.ok(round <= timeoutScenarios.length, 'Unexpected MCP elicitation turn')
    const timeoutScenario = timeoutScenarios[round - 1]
    const searchId = `${MCP_ELICITATION_SEARCH_ID}-${round}`
    const callId = `${MCP_ELICITATION_CALL_ID}-${round}`
    const events = items => [responseCreated(responseId), ...items, responseCompleted(responseId)]

    if (stage === 'search') {
      assert.ok(
        JSON.stringify(body).includes(MCP_ELICITATION_PROMPT),
        'The real Codex request did not contain the MCP elicitation prompt'
      )
      const search = selectToolSearch(body, MCP_ELICITATION_TOOL_NAME)
      stage = 'call'
      return events(toolSearchResponseEvents(searchId, search))
    }

    if (stage === 'call') {
      const tool = selectMcpTool(
        body,
        MCP_ELICITATION_NAMESPACE,
        MCP_ELICITATION_TOOL_NAME,
        timeoutScenario ? { scenario: timeoutScenario } : {},
        searchId
      )
      stage = 'result'
      outputCallId = callId
      waitCount = 0
      return events(selectedToolCall(callId, tool))
    }

    const output = readMcpToolOutput(body, outputCallId)
    const cellId = output.match(/^Script running with cell ID (\S+)/)?.[1]
    if (cellId) {
      // Code Mode can yield while the real MCP server is waiting on the form deadline.
      const wait = selectTool(body, 'wait', { cell_id: cellId, yield_time_ms: 30_000 })
      outputCallId = `${callId}-wait-${++waitCount}`
      return events(selectedToolCall(outputCallId, wait))
    }

    const expected = timeoutScenario
      ? `E2E_MCP_ELICITATION_TIMEOUT:${timeoutScenario}:cancel`
      : MCP_ELICITATION_ACCEPTED_MARKER
    assert.ok(
      output.includes(expected),
      `MCP elicitation ${outputCallId} did not return ${expected}`
    )
    const completion = assistantMessage(`${MCP_ELICITATION_COMPLETION_TEXT}:${round}`)
    round += 1
    stage = 'search'
    return events([completion])
  }
}
