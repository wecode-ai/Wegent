import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createDesktopScenario as createGoalStreamOrder } from './goal-stream-order.scenario.mjs'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  createSingleRootLocalProject,
} from '../modules/shared.mjs'
import { handleEmptyReplyPrediction, readRequestBody } from '../modules/response-protocol.mjs'
import { waitForWorkbenchDebugState } from '../modules/workspace-flows.mjs'

const MARKER = 'WEWORK_STOPPED_GOAL_STATE'

export function createDesktopScenario(options) {
  const existing = createGoalStreamOrder(options)
  let active = false
  return {
    ...existing,
    async handleHttp(request, response, url) {
      if (!active) return existing.handleHttp(request, response, url)
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      assert.ok(JSON.stringify(body).includes(MARKER), 'The model request lost its Goal')
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          error: { type: 'invalid_request_error', code: 'invalid_prompt', message: MARKER },
        })
      )
      return true
    },
    async verify(control) {
      await existing.verify(control)
      active = true
      await control.command('click', '[data-testid="new-chat-button"]')
      const workspace = join(options.workspacePath, 'goal-stopped-state')
      await mkdir(workspace, { recursive: true })
      await createSingleRootLocalProject(control, workspace, 'goal-stopped-state')
      await control.command(
        'click',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="add-context-button"]`
      )
      await control.command('click', '[data-testid="set-goal-button"]')
      await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: MARKER })
      await control.command('press', ACTIVE_COMPOSER_SELECTOR, { key: 'Enter' })

      const assertStopped = async () => {
        await waitForWorkbenchDebugState(
          control,
          snapshot =>
            snapshot.workbench?.activeLifecycle?.task?.status === 'failed' &&
            snapshot.workbench?.activeLifecycle?.execution?.phase === 'idle' &&
            snapshot.workbench?.activeLifecycle?.turn?.phase === 'idle' &&
            snapshot.pane?.status?.isBusy === false,
          'A failed Goal must remain stopped after native history is loaded'
        )
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="thinking-indicator"]`,
          {
            visible: false,
          }
        )
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="resume-goal-button"]`
        )
      }
      await assertStopped()
      const readyCount = control.readyCount
      await control.command('reloadMainWindow', 'body')
      await control.awaitReadyAfter(readyCount)
      await assertStopped()
    },
  }
}
