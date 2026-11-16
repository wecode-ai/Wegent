import assert from 'node:assert/strict'
import { createSingleRootLocalProject, selectE2EModel } from '../modules/shared.mjs'
import { waitForWorkbenchDebugState } from '../modules/workspace-flows.mjs'
import { runtimeTransportGates } from '../modules/runtime-transport-gates.mjs'
import {
  assistantMessage,
  createSse,
  handleEmptyReplyPrediction,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const ROOT = '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const PROMPT = 'WEWORK_RUNTIME_TASK_READINESS'
const COMPLETED = 'WEWORK_RUNTIME_TASK_READINESS_COMPLETED'

export function createDesktopScenario({ workspacePath, uiTimeoutMs, resultDir }) {
  let active = false
  let modelRequests = 0
  return {
    async handleHttp(request, response, url) {
      if (
        !active ||
        request.method !== 'POST' ||
        !['/responses', '/v1/responses'].includes(url.pathname)
      )
        return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      assert.ok(JSON.stringify(body.input).includes(PROMPT), 'The real create lost its prompt')
      assert.equal(++modelRequests, 1, 'Task creation unexpectedly sent another model request')
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(
        createSse([
          responseCreated('task-readiness'),
          assistantMessage(COMPLETED),
          responseCompleted('task-readiness'),
        ])
      )
      return true
    },
    async verify(control) {
      active = true
      await createSingleRootLocalProject(control, workspacePath, 'task-readiness')
      await selectE2EModel(control, undefined, undefined, ROOT)
      const gates = runtimeTransportGates(control)
      await gates.arm({
        id: 'readiness-goal',
        kind: 'request',
        name: 'runtime.tasks.goal.get',
        hold: false,
      })
      await gates.arm({
        id: 'readiness-goal-response',
        kind: 'response',
        name: 'runtime.tasks.goal.get',
        hold: false,
      })
      await gates.arm({
        id: 'readiness-context',
        kind: 'request',
        name: 'runtime_tasks.context',
        hold: false,
      })
      await control.command('holdLocalExecutorRequests', 'body', {
        value: JSON.stringify({ method: 'runtime.tasks.create', phase: 'before-dispatch' }),
      })
      const mark = control.errors.mark()
      let primaryError
      try {
        await control.command('fill', `${ROOT} [data-testid="chat-message-input"]`, {
          value: PROMPT,
        })
        await control.command('clickWhenEnabled', `${ROOT} [data-testid="send-message-button"]`)
        await control.command('awaitLocalExecutorRequestHold', 'body', { timeoutMs: uiTimeoutMs })
        await waitForWorkbenchDebugState(
          control,
          state => Boolean(state.workbench?.currentRuntimeTask?.taskId),
          'Optimistic task did not open'
        )
        // A waiting reader proves the mount/effect occurred; absence alone would be insufficient.
        const deadline = Date.now() + uiTimeoutMs
        let readers = []
        while (Date.now() < deadline) {
          readers = JSON.parse(await control.command('getRuntimeTaskCreationDiagnostics', 'body'))
          if (readers.some(entry => entry.waitingReaders > 0)) break
          await new Promise(resolve => setTimeout(resolve, 50))
        }
        assert.ok(
          readers.some(entry => entry.waitingReaders > 0),
          'No real reader reached the creation barrier'
        )
        assert.equal(
          await gates.read('readiness-goal'),
          null,
          'Goal read dispatched before persistence'
        )
        assert.equal(
          await gates.read('readiness-context'),
          null,
          'Context read dispatched before persistence'
        )
        await control.command('releaseLocalExecutorRequestHold', 'body')
        await control.command('waitFor', `${ROOT} [data-testid="message-assistant"]`, {
          text: COMPLETED,
          timeoutMs: uiTimeoutMs,
        })
        await gates.wait('readiness-goal-response')
        await control.errors.assertCollectedErrors(control, [], {
          after: mark,
          source: 'renderer',
          type: 'executor:runtime.tasks.goal.get',
        })
        await gates.save(resultDir, 'runtime-task-readiness.json', [
          'readiness-goal',
          'readiness-context',
          'readiness-goal-response',
        ])
        return { deferredReads: true }
      } catch (error) {
        primaryError = error
        throw error
      } finally {
        const cleanup = await Promise.allSettled([
          control.command('releaseLocalExecutorRequestHold', 'body'),
          gates.reset(),
        ])
        active = false
        const failures = cleanup
          .filter(result => result.status === 'rejected')
          .map(result => result.reason)
        if (failures.length)
          throw new AggregateError(
            primaryError ? [primaryError, ...failures] : failures,
            'Task readiness cleanup failed'
          )
      }
    },
  }
}
