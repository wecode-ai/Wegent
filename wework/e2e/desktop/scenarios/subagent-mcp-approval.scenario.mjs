import assert from 'node:assert/strict'

import { toolDetailsMcpConfigToml } from '../modules/desktop-build-flows.mjs'
import { selectedToolCall } from '../modules/model-tool-calls.mjs'
import { readMcpToolOutput } from '../modules/mcp-tool-results.mjs'
import {
  assistantMessage,
  createSse,
  handleEmptyReplyPrediction,
  readRequestBody,
  responseCompleted,
  responseCreated,
  selectMcpTool,
  selectTool,
  selectToolSearch,
  toolSearchResponseEvents,
  toolOutputText,
} from '../modules/response-protocol.mjs'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  selectE2EModel,
} from '../modules/shared.mjs'
import { isCollaborationSubagentRequest } from '../modules/subagent-request.mjs'

const PROMPT = 'Verify native child MCP approval'
const CHILD_TASK = 'Request consent for two node_repl calls'
const CHILD_RESULT = 'Child verified both MCP decisions'
const DONE = 'Parent received the child approval results'
const CARD = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="request-user-input-card"]`
const APPROVAL = `${CARD} [data-testid="request-user-input-question-__mcp_approval"]`

export function createDesktopScenario({ uiTimeoutMs }) {
  let sequence = 0
  let waits = 0
  let childFinished = false
  const searchId = 'child-approval-search'
  const firstId = 'child-approval-allow'
  const secondId = 'child-approval-cancel'
  const spawnId = 'child-approval-spawn'
  const toolCall = (body, id) =>
    selectedToolCall(id, selectMcpTool(body, 'node_repl', 'js', { code: '40 + 44' }, searchId))

  function childEvents(body) {
    if (toolOutputText(body, secondId) != null) {
      assert.match(readMcpToolOutput(body, secondId), /user cancelled MCP tool call/)
      childFinished = true
      return [assistantMessage(CHILD_RESULT)]
    }
    if (toolOutputText(body, firstId) != null) {
      assert.match(readMcpToolOutput(body, firstId), /result: 84/)
      return toolCall(body, secondId)
    }
    if (body.input.some(item => item.call_id === searchId)) return toolCall(body, firstId)
    return toolSearchResponseEvents(searchId, selectToolSearch(body, 'node_repl js'))
  }

  function parentEvents(body, input) {
    if (input.includes(CHILD_RESULT)) return [assistantMessage(DONE)]
    if (toolOutputText(body, spawnId) != null) {
      assert.ok(++waits <= 3, 'Parent did not receive its child result')
      return selectedToolCall(
        `child-approval-wait-${waits}`,
        selectTool(body, 'wait_agent', {
          timeout_ms: 20_000,
        })
      )
    }
    return selectedToolCall(
      spawnId,
      selectTool(body, 'spawn_agent', {
        task_name: 'approval_worker',
        message: CHILD_TASK,
      })
    )
  }

  return {
    codexConfigToml:
      toolDetailsMcpConfigToml().replace(
        'default_tools_approval_mode = "approve"',
        'default_tools_approval_mode = "prompt"'
      ) + '\n[features.multi_agent_v2]\nenabled = true\n',
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/v1/responses', '/responses'].includes(url.pathname)) {
        return false
      }
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      const input = JSON.stringify(body.input)
      const child = isCollaborationSubagentRequest(request.headers) && input.includes(CHILD_TASK)
      if (!child && !input.includes(PROMPT)) return false
      const id = `child-mcp-approval-${++sequence}`
      const events = child ? childEvents(body) : parentEvents(body, input)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },
    async verify(control) {
      await selectE2EModel(control)
      await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: PROMPT })
      await control.command(
        'clickWhenEnabled',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`
      )
      await control.command('waitFor', APPROVAL, { text: 'node_repl', timeoutMs: uiTimeoutMs })
      await control.command(
        'click',
        `${CARD} [data-testid="request-user-input-option-__mcp_approval-0"]`
      )
      await control.command('click', `${CARD} [data-testid="request-user-input-submit-button"]`)
      // Only a completed first native tool call can make the model issue the second one.
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="request-user-input-summary"]`,
        {
          text: 'Allow',
          timeoutMs: 6_000,
        }
      )
      await control.command('waitFor', APPROVAL, { text: 'node_repl', timeoutMs: uiTimeoutMs })
      await control.command('click', `${CARD} [data-testid="request-user-input-ignore-button"]`)
      await control.command('waitFor', ACTIVE_WORKBENCH_SELECTOR, { text: DONE, timeoutMs: 10_000 })
      assert.ok(childFinished, 'The child did not receive both native MCP results')
      await control.command('waitFor', APPROVAL, { visible: false, timeoutMs: 3_000 })
    },
  }
}
