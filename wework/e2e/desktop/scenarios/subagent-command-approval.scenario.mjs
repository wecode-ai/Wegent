import assert from 'node:assert/strict'
import { access, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { selectedToolCall } from '../modules/model-tool-calls.mjs'
import {
  assistantMessage,
  createSse,
  handleEmptyReplyPrediction,
  readRequestBody,
  responseCompleted,
  responseCreated,
  selectTool,
  toolOutputText,
} from '../modules/response-protocol.mjs'
import { shellCommandResponse } from '../modules/shell-command-response.mjs'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  selectE2EModel,
} from '../modules/shared.mjs'
import { isCollaborationSubagentRequest } from '../modules/subagent-request.mjs'

const PROMPT = 'Verify native child command approval'
const CHILD_TASK = 'Remove the isolated command approval fixture'
const FIXTURE = 'child-command-approval.tmp'
const CHILD_DONE = 'The child removed the approval fixture'
const DONE = 'Parent received the child command result'
const SPAWN = 'spawn-command-child'
const COMMAND = 'remove-child-approval-fixture'
const CARD = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="request-user-input-card"]`

export function createDesktopScenario({ workspacePath }) {
  const fixture = join(workspacePath, FIXTURE)
  let sequence = 0
  let waits = 0
  let childFinished = false

  async function childEvents(body) {
    if (toolOutputText(body, COMMAND) != null) {
      await assert.rejects(access(fixture), { code: 'ENOENT' })
      childFinished = true
      return [assistantMessage(CHILD_DONE)]
    }
    const command =
      process.platform === 'win32'
        ? `Remove-Item -LiteralPath '${FIXTURE}' -Force`
        : `rm -f '${FIXTURE}'`
    return shellCommandResponse(body, COMMAND, command, workspacePath)
  }

  function parentEvents(body, input) {
    if (input.includes(CHILD_DONE)) return [assistantMessage(DONE)]
    if (toolOutputText(body, SPAWN) != null) {
      assert.ok(++waits <= 3, 'Parent did not receive the approved child command result')
      return selectedToolCall(
        `wait-for-command-child-${waits}`,
        selectTool(body, 'wait_agent', { timeout_ms: 20_000 })
      )
    }
    return selectedToolCall(
      SPAWN,
      selectTool(body, 'spawn_agent', { task_name: 'command_worker', message: CHILD_TASK })
    )
  }

  return {
    codexConfigToml: '[features.multi_agent_v2]\nenabled = true\n',
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/v1/responses', '/responses'].includes(url.pathname)) {
        return false
      }
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      const input = JSON.stringify(body.input)
      const child = isCollaborationSubagentRequest(request.headers) && input.includes(CHILD_TASK)
      if (!child && !input.includes(PROMPT)) return false
      const id = `child-command-approval-${++sequence}`
      const events = child ? await childEvents(body) : parentEvents(body, input)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },
    async verify(control) {
      await writeFile(fixture, 'Isolated child approval fixture')
      await control.command('clickWhenEnabled', '[data-testid="new-chat-button"]')
      await selectE2EModel(control)
      await control.command('click', '[data-testid="permission-mode-menu-button"]')
      await control.command('click', '[data-testid="permission-mode-workspace-write"]')
      await control.command('click', '[data-testid="permission-mode-menu-button"]')
      await control.command('click', '[data-testid="permission-mode-full-access"]')
      await control.command(
        'clickWhenEnabled',
        '[data-testid="command-approval-confirm-option-manual"]'
      )
      await control.command('clickWhenEnabled', '[data-testid="full-access-confirm-submit"]')
      await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: PROMPT })
      await control.command(
        'clickWhenEnabled',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`
      )
      await control.command('waitFor', CARD, { text: FIXTURE, timeoutMs: 10_000 })
      await access(fixture)
      await control.command(
        'clickWhenEnabled',
        `${CARD} [data-testid="request-user-input-submit-button"]`
      )
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
        {
          text: DONE,
          timeoutMs: 10_000,
        }
      )
      assert.ok(childFinished, 'The original subagent must receive the command result')
      await control.command('waitFor', CARD, { visible: false, timeoutMs: 3_000 })
      await assert.rejects(access(fixture), { code: 'ENOENT' })
    },
  }
}
