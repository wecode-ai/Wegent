import assert from 'node:assert/strict'
import { access, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  assistantMessage,
  createSse,
  handleEmptyReplyPrediction,
  readRequestBody,
  requestAdvertisesShellTool,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'
import { shellCommandResponse } from '../modules/shell-command-response.mjs'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  createSingleRootLocalProject,
  selectE2EModel,
} from '../modules/shared.mjs'
import { waitForWorkbenchDebugState } from '../modules/workspace-flows.mjs'
import { verifyPendingInteractionsTab } from '../modules/pending-interactions-tab.mjs'

const PROMPT = 'Remove the isolated inbox-command-approval.tmp fixture.'
const COMPLETE = 'Inbox approval reached the original task.'
const CALL = 'inbox-command-approval'
const FIXTURE = 'inbox-command-approval.tmp'
const TAB = '[data-testid="workspace-tab-select-pending-interactions"]'
const PAGE = '[data-testid="runtime-interactions-page"]'

export function createDesktopScenario({ workspacePath, workbenchReadyTimeoutMs }) {
  let active = false
  let releaseCommand
  const commandReady = new Promise(resolve => {
    releaseCommand = resolve
  })
  return {
    cleanup() {
      active = false
      releaseCommand()
    },
    async handleHttp(request, response, url) {
      if (
        !active ||
        request.method !== 'POST' ||
        !['/responses', '/v1/responses'].includes(url.pathname)
      )
        return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      if (!JSON.stringify(body.input ?? []).includes(PROMPT)) return false
      const id = `inbox-approval-${Date.now()}`
      let events = []
      if (requestContainsToolOutput(body, CALL)) {
        events = [assistantMessage(COMPLETE)]
      } else if (requestAdvertisesShellTool(body)) {
        await commandReady
        const command =
          process.platform === 'win32'
            ? `Remove-Item -LiteralPath '${FIXTURE}' -Force`
            : `rm -f '${FIXTURE}'`
        events = shellCommandResponse(body, CALL, command, workspacePath)
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },
    async verify(control) {
      active = true
      const fixture = join(workspacePath, FIXTURE)
      await writeFile(fixture, 'Isolated approval fixture')
      await control.command('clickWhenEnabled', '[data-testid="new-chat-button"]')
      await createSingleRootLocalProject(control, workspacePath, 'Inbox command approval')
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
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]:not(:disabled)`
      )
      await control.command('press', ACTIVE_COMPOSER_SELECTOR, { key: 'Enter' })
      const snapshot = await waitForWorkbenchDebugState(
        control,
        state => state.workbench?.currentRuntimeTask?.taskId,
        'The command approval needs an original task',
        workbenchReadyTimeoutMs
      )
      const { deviceId, taskId } = snapshot.workbench.currentRuntimeTask
      await control.command('click', TAB)
      await control.command('waitFor', PAGE, { visible: true })
      releaseCommand()
      await control.command('waitFor', `${PAGE} [data-testid="interaction-list-item"]`, {
        text: FIXTURE,
        visible: true,
      })
      await control.command('click', `${PAGE} [data-testid="interaction-list-item"]`)
      await control.command('clickWhenEnabled', `${PAGE} [data-testid="interaction-show-context"]`)
      const allow = `${PAGE} [data-testid="request-user-input-option-__codex_approval-0"]`
      await control.command('waitFor', `${allow}:not(:disabled)`, { visible: true })
      await access(fixture)
      await control.command('clickWhenEnabled', allow)
      await verifyPendingInteractionsTab(control, 0)
      await control.command('click', '[data-testid="workspace-tab-select-fixed-task"]')
      await control.command('click', `[data-testid="runtime-local-task-row-${taskId}"]`)
      await control.command('waitFor', '[data-testid="message-assistant"]', { text: COMPLETE })
      await assert.rejects(access(fixture), { code: 'ENOENT' })

      const messages = JSON.parse(
        await control.command('getRuntimeConversationMessages', 'body', {
          value: JSON.stringify({ deviceId, taskId }),
        })
      )
      const approval = messages
        .flatMap(message => message.blocks ?? [])
        .map(block => block.renderPayload)
        .find(payload => payload?.interactionKind === 'approval')
      assert.ok(
        approval?.requestId != null,
        'The completed approval must retain its request identity'
      )
      const duplicate = JSON.parse(
        await control.command('answerRuntimeUserInputDirectly', 'body', {
          value: JSON.stringify({
            taskId,
            requestUserInputResponse: {
              requestId: approval.requestId,
              interactionScope: approval.interactionScope,
              answers: { __codex_approval: { answers: ['allow_once'] } },
            },
          }),
        })
      )
      assert.equal(duplicate.success, false, 'A settled approval must not execute again')
      assert.match(duplicate.code, /^(missing|stale|closed)_request_user_input$/)
    },
  }
}
