import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createDesktopScenario as createStatusScenario } from './change-request-status.scenario.mjs'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  selectE2EModel,
} from '../modules/shared.mjs'
import { waitForSnapshot } from '../modules/conversation-layout.mjs'
import {
  assistantMessage,
  createSse,
  handleEmptyReplyPrediction,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const PROMPT = 'WEWORK_E2E_PR_REPAIR_RUNNING'
const COMPLETED = 'WEWORK_E2E_PR_REPAIR_GUIDANCE_DELIVERED'
const ENVIRONMENT = '[data-testid="environment-info-button"]'

// Extend the existing CI checkpoint while preserving all of its original cases.
export async function createDesktopScenario(options) {
  const existing = await createStatusScenario(options)
  let active = false
  let heldResponse
  let guidedRequests = 0

  return {
    ...existing,
    async handleHttp(request, response, url) {
      if (!active) return existing.handleHttp(request, response, url)
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname)) {
        return existing.handleHttp(request, response, url)
      }
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      assert.ok(JSON.stringify(body).includes(PROMPT), 'The running task lost its original input')
      if (!heldResponse) {
        heldResponse = response
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(createSse([responseCreated('pr-repair-held')]))
        return true
      }
      assert.ok(
        JSON.stringify(body.input).includes('修复 PR/MR #2631'),
        'The real Codex model request did not receive the PR repair guidance'
      )
      guidedRequests += 1
      heldResponse.end()
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(
        createSse([
          responseCreated('pr-repair-guided'),
          assistantMessage(COMPLETED),
          responseCompleted('pr-repair-guided'),
        ])
      )
      return true
    },
    async verify(control) {
      await existing.verify(control)
      active = true
      try {
        await writeFile(join(options.homePath, '.wework-change-request-e2e-state'), 'failure\n')
        await control.command('click', ENVIRONMENT)
        await control.command('click', ENVIRONMENT)
        await control.command('waitFor', '[data-testid="change-request-checks"]', {
          text: '检查失败',
        })
        await control.command('click', ENVIRONMENT)
        await control.command('click', '[data-testid="new-chat-button"]')
        await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR)
        await selectE2EModel(control, undefined, undefined, ACTIVE_WORKBENCH_SELECTOR)
        await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: PROMPT })
        await control.command('clickWhenEnabled', '[data-testid="send-message-button"]')
        await waitForSnapshot(
          control,
          snapshot => heldResponse && snapshot.testIds.includes('pause-response-button'),
          'The real task did not start its held model response'
        )
        const state = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
        const taskId = state.workbench?.currentRuntimeTask?.taskId
        assert.ok(taskId, 'The running PR repair task has no identity')
        const statusId = `runtime-local-task-change-request-${taskId}`
        await control.command('waitFor', `[data-testid="${statusId}"]`)
        await control.command('click', `[data-testid="${statusId}"]`)
        await control.command('clickWhenEnabled', `[data-testid="${statusId}-repair"]`)
        await control.command('waitFor', '[data-testid="message-assistant"]', {
          text: COMPLETED,
          timeoutMs: options.modelResponseTimeoutMs,
        })
        assert.equal(guidedRequests, 1, 'The repair must reach Codex exactly once')
        await control.command('waitFor', '[data-testid="user-message-content"]', {
          text: '修复 PR/MR #2631',
        })
        await options.captureScreenshot(control, 'change-request-status-09-running-repair.png')
      } finally {
        heldResponse?.end()
      }
    },
    diagnostics() {
      return { ...existing.diagnostics(), runningRepairGuidedRequests: guidedRequests }
    },
  }
}
