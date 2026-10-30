import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  createSingleRootLocalProject,
  withTimeout,
} from '../modules/shared.mjs'
import {
  assistantMessage,
  createSse,
  handleEmptyReplyPrediction,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'
import { waitForWorkbenchDebugState } from '../modules/workspace-flows.mjs'
import { runtimeTransportGates } from '../modules/runtime-transport-gates.mjs'
import { fetchLocalRuntime } from '../modules/runtime-request.mjs'

const GOAL = 'WEWORK_NATIVE_LIFECYCLE_EXISTING_GOAL'
const FOLLOW_UP = 'WEWORK_NATIVE_LIFECYCLE_ORDINARY_REQUEST'
const ORDINARY_DONE = 'WEWORK_NATIVE_ORDINARY_REQUEST_FINISHED'
const CONTINUED = 'WEWORK_NATIVE_GOAL_CONTINUED'

function deferred() {
  let resolve
  const promise = new Promise(complete => {
    resolve = complete
  })
  return { promise, resolve }
}

export function createDesktopScenario(options) {
  const initial = deferred()
  const ordinary = deferred()
  const continuation = deferred()
  const continuationRequested = deferred()
  let active = false
  let ordinaryFinished = false
  let requestCount = 0

  return {
    cleanup() {
      initial.resolve()
      ordinary.resolve()
      continuation.resolve()
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
      assert.ok(
        JSON.stringify(body).includes(GOAL),
        'The real native request lost the existing Goal'
      )
      const id = `native-lifecycle-${++requestCount}`
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      response.write(createSse([responseCreated(id)]))
      if (!JSON.stringify(body).includes(FOLLOW_UP)) {
        await initial.promise
        if (!response.destroyed)
          response.end(createSse([assistantMessage('initial'), responseCompleted(id)]))
      } else if (!ordinaryFinished) {
        await ordinary.promise
        ordinaryFinished = true
        response.end(createSse([assistantMessage(ORDINARY_DONE), responseCompleted(id)]))
      } else {
        continuationRequested.resolve()
        await continuation.promise
        if (!response.destroyed)
          response.end(createSse([assistantMessage(CONTINUED), responseCompleted(id)]))
      }
      return true
    },
    async verify(control) {
      active = true
      let address
      const gates = runtimeTransportGates(control)
      const evidence = []
      const origin = await control.command('getLocationOrigin', 'body')
      const rpc = async (method, params) => {
        const response = await fetchLocalRuntime(control, `${origin}/wework/executor/v1/rpc`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: `native-lifecycle-${method}`, method, params }),
          timeoutMs: options.uiTimeoutMs,
        })
        const payload = await response.json()
        assert.equal(payload.ok, true, payload.error?.message)
        return payload.result
      }
      const assertRunning = async (label, previousTurnId) => {
        const snapshot = await waitForWorkbenchDebugState(
          control,
          value =>
            Boolean(value.workbench?.activeLifecycle?.task?.executionState?.revision) &&
            Boolean(value.workbench?.activeLifecycle?.turn.id) &&
            value.workbench.activeLifecycle.turn.id !== previousTurnId &&
            value.workbench.activeLifecycle.turn.id ===
              value.workbench.activeLifecycle.task.executionState.turnId &&
            value.workbench?.activeLifecycle?.execution.running === true &&
            value.pane?.status?.taskExecution.running === true &&
            value.pane?.status?.isBusy === true,
          `${label}: native state and pane execution diverged`
        )
        const state = snapshot.workbench.activeLifecycle
        assert.ok(
          state.task.executionState?.revision,
          'The UI did not consume a versioned execution snapshot'
        )
        await control.command(
          'waitFor',
          `[data-testid="runtime-local-task-running-${address.taskId}"]`
        )
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="pause-response-button"]`
        )
        evidence.push({
          label,
          execution: state.execution,
          turn: state.turn,
          native: state.task.executionState,
        })
        return state
      }
      try {
        await createSingleRootLocalProject(control, options.workspacePath, 'native-lifecycle')
        await control.command(
          'click',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="add-context-button"]`
        )
        await control.command('click', '[data-testid="set-goal-button"]')
        await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: GOAL })
        await control.command('press', ACTIVE_COMPOSER_SELECTOR, { key: 'Enter' })
        const started = await waitForWorkbenchDebugState(
          control,
          snapshot => Boolean(snapshot.workbench?.activeLifecycle?.turn.id),
          'The initial native Goal did not start'
        )
        address = started.workbench.currentRuntimeTask
        await assertRunning('initial-goal')

        await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: FOLLOW_UP })
        await control.command('press', ACTIVE_COMPOSER_SELECTOR, { key: 'Enter' })
        await control.command('waitFor', '[data-testid="conversation-queue-panel"]', {
          text: FOLLOW_UP,
        })
        await control.command('click', '[data-testid^="queue-interrupt-button-"]')
        await waitForWorkbenchDebugState(
          control,
          snapshot =>
            snapshot.workbench?.activeLifecycle?.turn.id &&
            snapshot.workbench.activeLifecycle.turn.id !==
              started.workbench.activeLifecycle.turn.id,
          'The ordinary request did not replace the interrupted Goal turn'
        )
        const ordinaryState = await assertRunning('ordinary-request')
        assert.equal(ordinaryState.goalStatus, 'active')

        await gates.arm({
          id: 'ordinary-completed',
          kind: 'event',
          name: 'runtime.turn.updated',
          where: [
            { path: 'payload.taskId', equals: address.taskId },
            { path: 'payload.data.turnId', equals: ordinaryState.turn.id },
            { path: 'payload.data.status', equals: 'settled' },
          ],
        })
        ordinary.resolve()
        await withTimeout(
          continuationRequested.promise,
          options.uiTimeoutMs,
          'The existing Goal did not continue after the ordinary request'
        )
        const continued = await assertRunning('automatic-continuation', ordinaryState.turn.id)
        assert.notEqual(continued.turn.id, ordinaryState.turn.id)
        await gates.wait('ordinary-completed')
        await gates.release('ordinary-completed')
        const afterOldCompletion = await assertRunning('late-native-completion')
        assert.equal(afterOldCompletion.turn.id, continued.turn.id)

        const readyCount = control.readyCount
        await control.command('reloadMainWindow', 'body')
        await control.awaitReadyAfter(readyCount)
        const reloaded = await assertRunning('reload-during-continuation')
        assert.equal(reloaded.turn.id, continued.turn.id)

        await rpc('runtime.tasks.goal.clear', { address })
        continuation.resolve()
        await waitForWorkbenchDebugState(
          control,
          snapshot =>
            snapshot.workbench?.activeLifecycle?.execution.phase === 'idle' &&
            snapshot.pane?.status?.isBusy === false,
          'The native execution did not settle after Goal clearing and native completion'
        )
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="thinking-indicator"]`,
          { visible: false }
        )
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="tool-block-thinking"]`,
          { visible: false }
        )
        await gates.save(options.resultDir, 'native-lifecycle-event-order.json', [
          'ordinary-completed',
        ])
        await writeFile(
          join(options.resultDir, 'native-lifecycle-states.json'),
          JSON.stringify(evidence, null, 2)
        )
      } finally {
        await gates.reset()
        if (address) await rpc('runtime.tasks.goal.clear', { address })
        initial.resolve()
        ordinary.resolve()
        continuation.resolve()
      }
    },
  }
}
