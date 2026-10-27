import assert from 'node:assert/strict'
import { createDesktopScenario as createStreamRecovery } from './executor-stream-recovery.scenario.mjs'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  selectE2EModel,
} from '../modules/shared.mjs'
import {
  assistantMessage,
  createSse,
  handleEmptyReplyPrediction,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const PROMPT = 'WEWORK_E2E_RATE_LIMIT_WAIT'
const COMPLETED = 'WEWORK_E2E_RATE_LIMIT_RECOVERED'
const WAIT_STATUS = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="runtime-rate-limit-wait-status"]`

// Keep the original stream-recovery regression and add real HTTP 429 coverage
// to the same CI-covered checkpoint without changing its existing assertions.
export function createDesktopScenario(options) {
  const existing = createStreamRecovery(options)
  let active = false
  let recover = false
  let attempts = 0

  return {
    ...existing,
    async handleHttp(request, response, url) {
      if (!active) return existing.handleHttp(request, response, url)
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      if (!JSON.stringify(body).includes(PROMPT)) return false
      attempts += 1
      if (!recover) {
        response.writeHead(429, {
          'content-type': 'application/json',
          'retry-after': '5',
        })
        response.end(
          JSON.stringify({ error: { message: 'Rate limit exceeded', type: 'rate_limit_error' } })
        )
        return true
      }
      const id = `rate-limit-recovered-${attempts}`
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(
        createSse([responseCreated(id), assistantMessage(COMPLETED), responseCompleted(id)])
      )
      return true
    },
    async verify(control) {
      await existing.verify(control)
      active = true
      try {
        await control.command('click', '[data-testid="new-chat-button"]')
        await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR)
        await selectE2EModel(control, undefined, undefined, ACTIVE_WORKBENCH_SELECTOR)
        await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: PROMPT })
        await control.command('press', ACTIVE_COMPOSER_SELECTOR, { key: 'Enter' })
        // This fixture deliberately holds the model in HTTP retry backoff.
        await control.command('waitFor', WAIT_STATUS, { timeoutMs: options.modelResponseTimeoutMs })
        assert.ok(attempts > 0, 'No real model request reached the rate-limit fixture')
        const state = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
        const taskId = state.workbench?.currentRuntimeTask?.taskId
        assert.ok(taskId, 'The rate-limited task has no identity')
        const waitingSidebar = `[data-testid="runtime-local-task-rate-limit-wait-${taskId}"]`
        await control.command('waitFor', waitingSidebar)
        const snapshot = JSON.parse(await control.command('snapshot', 'body'))
        assert.ok(
          snapshot.testIds.includes('pause-response-button'),
          'Rate limiting settled the turn'
        )
        assert.ok(
          !snapshot.testIds.includes(`runtime-local-task-running-${taskId}`),
          'The rate-limited task still shows the running indicator'
        )
        assert.ok(
          !snapshot.testIds.includes('runtime-reconnecting-open-proxy-settings'),
          'Rate limiting incorrectly offered network proxy recovery'
        )

        recover = true
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
          {
            text: COMPLETED,
            timeoutMs: options.modelResponseTimeoutMs,
          }
        )
        await control.command('waitFor', WAIT_STATUS, { visible: false })
        await control.command('waitFor', waitingSidebar, { visible: false })
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="pause-response-button"]`,
          {
            visible: false,
          }
        )
        const recovered = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
        assert.equal(
          recovered.workbench?.currentRuntimeTask?.taskId,
          taskId,
          'Rate-limit recovery replaced the conversation'
        )

        recover = false
        await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: PROMPT })
        await control.command('press', ACTIVE_COMPOSER_SELECTOR, { key: 'Enter' })
        await control.command('waitFor', WAIT_STATUS, { timeoutMs: options.modelResponseTimeoutMs })
        await control.command(
          'click',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="pause-response-button"]`
        )
        await control.command('waitFor', WAIT_STATUS, { visible: false })
        await control.command('waitFor', waitingSidebar, { visible: false })
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="pause-response-button"]`,
          { visible: false }
        )
      } finally {
        recover = true
        active = false
      }
    },
  }
}
