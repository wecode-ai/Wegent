import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createDesktopScenario as createStoppedGoal } from './goal-stopped-state.scenario.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { ensureTaskRowVisible } from '../modules/memory-tool-flows.mjs'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  MODEL_REQUEST_TIMEOUT_MS,
  createSingleRootLocalProject,
} from '../modules/shared.mjs'
import {
  assistantMessage,
  createSse,
  handleEmptyReplyPrediction,
  readRequestBody,
  responseCompleted,
  responseCreated,
  selectedToolCall,
  selectTool,
} from '../modules/response-protocol.mjs'
import { waitForWorkbenchDebugState } from '../modules/workspace-flows.mjs'

const MARKER = 'WEWORK_GOAL_RESUME_ROUTE'
const RECOVERED = `${MARKER}_RECOVERED`

export function createDesktopScenario(options) {
  const existing = options.checkpoint === 'goal-resume-route' ? null : createStoppedGoal(options)
  let active = false
  let requests = 0
  let restartDesktopApp
  return {
    ...existing,
    setRestartDesktopApp(restart) {
      restartDesktopApp = restart
      existing?.setRestartDesktopApp?.(restart)
    },
    async handleHttp(request, response, url, modelRequest) {
      if (!active) return existing?.handleHttp(request, response, url, modelRequest) ?? false
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      assert.ok(JSON.stringify(body).includes(MARKER), 'Resume lost the original Goal')
      const current = ++requests
      assert.ok(current <= 3, 'Resuming the Goal submitted duplicate model work')
      if (current === 1) {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            error: { type: 'invalid_request_error', code: 'invalid_prompt', message: MARKER },
          })
        )
        return true
      }
      const id = `${MARKER}-${current}`
      const completed = responseCompleted(id)
      completed.response.usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(
        createSse([
          responseCreated(id),
          ...(current === 2
            ? selectedToolCall(
                'resume-route-complete',
                selectTool(body, 'update_goal', { status: 'complete' })
              )
            : [assistantMessage(RECOVERED)]),
          completed,
        ])
      )
      return true
    },
    async verify(control) {
      await existing?.verify(control)
      active = true
      let address
      const rpc = (method, params) => requestExecutor(control, method, params, options.uiTimeoutMs)
      try {
        await control.command('clickWhenEnabled', '[data-testid="new-chat-button"]')
        const workspace = join(options.workspacePath, 'goal-resume-route')
        await mkdir(workspace, { recursive: true })
        await createSingleRootLocalProject(control, workspace, 'goal-resume-route')
        await control.command(
          'click',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="add-context-button"]`
        )
        await control.command('click', '[data-testid="set-goal-button"]')
        await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: MARKER })
        await control.command(
          'clickWhenEnabled',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`
        )
        const stopped = await waitForWorkbenchDebugState(
          control,
          snapshot =>
            requests === 1 &&
            snapshot.pane?.goal?.status === 'blocked' &&
            snapshot.pane?.status?.isBusy === false,
          'The model rejection did not stop the Goal'
        )
        address = stopped.workbench.currentRuntimeTask
        const before = (await rpc('runtime.tasks.goal.get', { address })).goal
        // Reopening a blocked thread after an executor restart leaves native history
        // available while its in-memory model route no longer exists.
        assert.ok(restartDesktopApp, 'The fixture requires the shared desktop restart')
        await restartDesktopApp()
        await ensureTaskRowVisible(control, `runtime-local-task-row-${address.taskId}`)
        await control.command(
          'clickWhenEnabled',
          `[data-testid="runtime-local-task-row-${address.taskId}"]`
        )
        const transcript = await rpc('runtime.tasks.transcript', { address, refresh: true })
        assert.ok(transcript.messages.length, 'Reopening must restore the original conversation')
        assert.equal(requests, 1, 'Loading blocked history must not invoke the model')
        await control.command(
          'clickWhenEnabled',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="resume-goal-button"]`
        )
        // Resuming after a restart starts Codex and reopens the thread before rendering the reply.
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
          { text: RECOVERED, timeoutMs: MODEL_REQUEST_TIMEOUT_MS }
        )
        const settled = await waitForWorkbenchDebugState(
          control,
          snapshot =>
            snapshot.workbench?.activeLifecycle?.goalStatus === 'complete' &&
            snapshot.pane?.status?.isBusy === false,
          'Resuming the stopped Goal did not complete'
        )
        assert.equal(settled.workbench.currentRuntimeTask.taskId, address.taskId)
        const after = (await rpc('runtime.tasks.goal.get', { address })).goal
        assert.equal(after.status, 'complete')
        for (const key of ['threadId', 'objective', 'createdAt', 'tokenBudget'])
          assert.equal(after[key], before[key], `Resume replaced Goal ${key}`)
        assert.ok(after.tokensUsed > before.tokensUsed, 'Resumed model usage must be recorded')
        assert.equal(requests, 3, 'Resume must reach the model and complete its real tool call')
      } finally {
        if (address) await rpc('runtime.tasks.goal.clear', { address })
        active = false
      }
    },
    diagnostics() {
      return {
        ...existing?.diagnostics?.(),
        resumeRouteRequests: requests,
        resumeRouteActive: active,
      }
    },
  }
}
