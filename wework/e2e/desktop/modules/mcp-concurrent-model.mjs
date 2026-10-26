import {
  assert,
  MCP_ELICITATION_APPROVED_NAMESPACE,
  MCP_ELICITATION_NAMESPACE,
  MCP_ELICITATION_TOOL_NAME,
} from './shared.mjs'
import {
  assistantMessage,
  functionCall,
  customToolCall,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
  selectMcpTool,
  selectTool,
  selectToolSearch,
  toolSearchResponseEvents,
  toolOutputText,
} from './response-protocol.mjs'

export const CONCURRENT_CASES = ['accept', 'cancel', 'ordinary_first', 'timeout']
export const CONCURRENT_SCENARIO = 'mcp_concurrent'
export const CONCURRENT_QUESTION_ID = 'concurrent_direction'
export const concurrentPrompt = action => `E2E_CONCURRENT_MCP_INPUT:${action}`
export const concurrentCompletion = action => `E2E_CONCURRENT_MCP_COMPLETE:${action}`

export async function respondToConcurrentMcpInput(
  control,
  body,
  response,
  responseId,
  modelRequest
) {
  control.recordScenarioRequest(CONCURRENT_SCENARIO, modelRequest)
  const count = control.scenarioRequests.get(CONCURRENT_SCENARIO).length
  assert.ok(count <= CONCURRENT_CASES.length * 5, 'Unexpected concurrent elicitation model request')
  const action = CONCURRENT_CASES[Math.floor((count - 1) / 5)]
  const stage = (count - 1) % 5
  const scenario = `concurrent_${action}`
  const questionId = `ordinary-${scenario}`
  const mcpId = `mcp-${scenario}`
  assert.ok(JSON.stringify(body).includes(concurrentPrompt(action)))
  if (stage === 0) {
    const search = selectToolSearch(body, MCP_ELICITATION_TOOL_NAME)
    control.writeSse(response, [
      responseCreated(responseId),
      ...toolSearchResponseEvents(`search-${scenario}`, search),
      responseCompleted(responseId),
    ])
    return
  }
  if (stage === 1) {
    // Only the form-first case may use the prompting server: Codex keeps one
    // pending request_user_input per turn, so an auto-approved MCP call racing
    // a question published earlier would answer the question with "Allow".
    const namespace =
      action === 'ordinary_first' ? MCP_ELICITATION_NAMESPACE : MCP_ELICITATION_APPROVED_NAMESPACE
    const mcp = selectMcpTool(body, namespace, MCP_ELICITATION_TOOL_NAME, {
      scenario,
    })
    const exec = (body.tools ?? []).find(tool => tool.name === 'exec')
    assert.ok(
      exec,
      `Code Mode exec unavailable: ${JSON.stringify((body.tools ?? []).map(tool => [tool.name, tool.type]))}`
    )
    const toolName = `${mcp.namespace}__${mcp.name}`.replace(/[^a-zA-Z0-9_$]/g, '_')
    // The real MCP call stays open behind a fixture gate while the native cell
    // yields. A subsequent step can then ask an ordinary blocking question.
    control.writeSse(response, [
      responseCreated(responseId),
      customToolCall(
        mcpId,
        'exec',
        `// @exec: {"yield_time_ms": 1}\ntext(await tools.${toolName}(${JSON.stringify(mcp.arguments)}))`
      ),
      responseCompleted(responseId),
    ])
    return
  }
  if (stage === 2) {
    const output = toolOutputText(body, mcpId)
    const cell = output?.match(/Script running with cell ID (\S+)/)?.[1]
    assert.ok(cell, `The native MCP cell did not yield: ${output}`)
    control.concurrentMcpCell = cell
    if (action === 'ordinary_first') await control.concurrentOrdinaryReady
    const ordinary = selectTool(body, 'request_user_input', {
      questions: [
        {
          id: CONCURRENT_QUESTION_ID,
          header: 'Direction',
          question: `Keep this ordinary question pending: ${action}?`,
          options: [
            { label: 'Continue', description: 'Continue after both questions settle.' },
            { label: 'Stop', description: 'Choose another direction.' },
          ],
        },
      ],
    })
    control.writeSse(response, [
      responseCreated(responseId),
      ...functionCall(questionId, ordinary.name, ordinary.arguments),
      responseCompleted(responseId),
    ])
    return
  }
  assert.deepEqual(
    JSON.parse(toolOutputText(body, questionId)),
    {
      answers: { [CONCURRENT_QUESTION_ID]: { answers: ['Continue'] } },
    },
    'The native ordinary question did not receive the explicit answer'
  )
  if (stage === 3) {
    // Keep only the model response held while the UI verifies the remaining
    // MCP request. Reading the cell earlier would legitimately yield again.
    if (action === 'ordinary_first') await control.concurrentMcpReady
    const wait = selectTool(body, 'wait', {
      cell_id: control.concurrentMcpCell,
      yield_time_ms: 1000,
    })
    control.writeSse(response, [
      responseCreated(responseId),
      ...functionCall(`wait-${scenario}`, wait.name, wait.arguments),
      responseCompleted(responseId),
    ])
    return
  }
  assert.ok(
    requestContainsToolOutput(body, `wait-${scenario}`),
    'The real MCP output never reached Codex'
  )
  const expected = ['cancel', 'timeout'].includes(action) ? 'cancel' : 'accept'
  assert.ok(JSON.stringify(body).includes(`E2E_MCP_ELICITATION_CONCURRENT:${scenario}:${expected}`))
  const held = control.heldScenarioResponses.get(CONCURRENT_SCENARIO)
  assert.ok(held, 'Final model response must stay held while checking cleared waiting state')
  await held.promise
  control.writeSse(response, [
    responseCreated(responseId),
    assistantMessage(concurrentCompletion(action)),
    responseCompleted(responseId),
  ])
}
