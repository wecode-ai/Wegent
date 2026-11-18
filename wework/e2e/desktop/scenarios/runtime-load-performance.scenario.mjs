import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  WORKBENCH_READY_TIMEOUT_MS,
  createSingleRootLocalProject,
  selectE2EModel,
} from '../modules/shared.mjs'
import {
  createSse,
  handleEmptyReplyPrediction,
  readRequestBody,
  streamingTextEvents,
} from '../modules/response-protocol.mjs'
import { waitForCompletedRuntimeTaskThread } from '../modules/runtime-task-evidence.mjs'
import { waitForWorkbenchDebugState } from '../modules/workspace-flows.mjs'

const LOAD_BUDGET_MS = 2_000
const PROMPT = 'WEWORK_RUNTIME_LOAD_PERFORMANCE'
const COMPLETION = `${PROMPT}_COMPLETE`
const SIDEBAR = '[data-testid="sidebar-worklists-scroll"]'

export function createDesktopScenario({ workspacePath, resultDir, uiTimeoutMs }) {
  return {
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      if (!JSON.stringify(body).includes(PROMPT)) return false
      const events = streamingTextEvents('runtime-load-performance', COMPLETION, 'final_answer')
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([...events.start, ...events.finish]))
      return true
    },

    async verify(control) {
      await createSingleRootLocalProject(control, workspacePath, 'runtime-load-performance')
      await selectE2EModel(control)
      await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
        visible: true,
        timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
      })
      await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: PROMPT })
      await control.command(
        'clickWhenEnabled',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`,
        { timeoutMs: uiTimeoutMs }
      )
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
        {
          text: COMPLETION,
          visible: true,
          timeoutMs: uiTimeoutMs,
        }
      )
      const task = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body')).workbench
        ?.currentRuntimeTask
      assert.ok(task?.taskId, 'The speed fixture did not create a runtime task')
      await waitForCompletedRuntimeTaskThread(control, task.taskId, uiTimeoutMs)
      const row = `${SIDEBAR} [data-testid="runtime-local-task-row-${task.taskId}"]`
      await control.command('waitFor', row, { visible: true, timeoutMs: uiTimeoutMs })

      // Reload from a blank conversation so sidebar data and transcript reads are
      // both cold, without preloading the task during the sidebar measurement.
      await control.command('click', '[data-testid="new-chat-button"]')
      await waitForWorkbenchDebugState(
        control,
        snapshot => snapshot.workbench?.currentRuntimeTask == null,
        'The speed fixture did not return to a blank conversation',
        uiTimeoutMs
      )
      const readyCount = control.readyCount
      await control.command('reloadMainWindow', 'body')
      await control.awaitReadyAfter(readyCount, WORKBENCH_READY_TIMEOUT_MS)

      let sidebarLoadMs = null
      let conversationOpenMs = null
      let rowVisibleAtReady = null
      let measurementError = null
      try {
        // Control readiness marks the renderer entry point. Splash and process
        // bootstrap stay outside this budget; fetching and painting the first
        // task row stay inside it.
        const sidebarStartedAt = performance.now()
        rowVisibleAtReady = Number(await control.command('getElementCount', row)) > 0
        await control.command('waitFor', row, { visible: true, timeoutMs: uiTimeoutMs })
        sidebarLoadMs = Number((performance.now() - sidebarStartedAt).toFixed(3))

        await control.command('click', '[data-testid="new-chat-button"]')
        await waitForWorkbenchDebugState(
          control,
          snapshot => snapshot.workbench?.currentRuntimeTask == null,
          'The speed fixture did not clear the restored conversation',
          uiTimeoutMs
        )
        const conversationStartedAt = performance.now()
        await control.command('click', row)
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
          {
            text: COMPLETION,
            visible: true,
            timeoutMs: uiTimeoutMs,
          }
        )
        conversationOpenMs = Number((performance.now() - conversationStartedAt).toFixed(3))
      } catch (error) {
        measurementError = error
      }

      await writeFile(
        join(resultDir, 'runtime-load-performance.json'),
        JSON.stringify(
          {
            budgetMs: LOAD_BUDGET_MS,
            sidebarLoadMs,
            rowVisibleAtReady,
            conversationOpenMs,
            taskId: task.taskId,
            error:
              measurementError instanceof Error
                ? measurementError.message
                : measurementError
                  ? String(measurementError)
                  : null,
          },
          null,
          2
        )
      )
      if (measurementError) throw measurementError
      assert.equal(
        rowVisibleAtReady,
        false,
        'The task row was visible before sidebar load timing started'
      )
      assert.ok(
        sidebarLoadMs != null && sidebarLoadMs < LOAD_BUDGET_MS,
        `Sidebar load exceeded ${LOAD_BUDGET_MS}ms: ${sidebarLoadMs}ms`
      )
      assert.ok(
        conversationOpenMs != null && conversationOpenMs < LOAD_BUDGET_MS,
        `Conversation open exceeded ${LOAD_BUDGET_MS}ms: ${conversationOpenMs}ms`
      )
    },
  }
}
