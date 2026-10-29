import assert from 'node:assert/strict'
import { fetchLocalRuntime } from '../modules/runtime-request.mjs'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createDesktopScenario as createOverloadRecovery } from './model-overload-recovery.scenario.mjs'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  createSingleRootLocalProject,
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
import { waitForWorkbenchDebugState } from '../modules/workspace-flows.mjs'

const GOAL = 'WEWORK_OVERLOADED_GOAL'
const RECOVERED = 'WEWORK_OVERLOADED_GOAL_RECOVERED'

export function createDesktopScenario(options) {
  const existing = createOverloadRecovery(options)
  let active = false
  let requests = 0
  let releaseRecovered
  let releaseContinuation
  let recoveredHeld
  let continuationHeld
  const reset = () => {
    requests = 0
    recoveredHeld = new Promise(resolve => {
      releaseRecovered = resolve
    })
    continuationHeld = new Promise(resolve => {
      releaseContinuation = resolve
    })
  }
  return {
    ...existing,
    async handleHttp(request, response, url) {
      if (!active) return existing.handleHttp(request, response, url)
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      assert.ok(JSON.stringify(body).includes(GOAL), 'Recovery lost the Goal objective')
      const current = ++requests
      assert.ok(current <= 3, 'Goal recovery started a duplicate turn')
      const id = `goal-overload-${Date.now()}`
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(createSse([responseCreated(id)]))
      if (current === 1) {
        response.end(
          createSse([
            {
              type: 'response.failed',
              response: {
                id,
                status: 'failed',
                error: {
                  code: 'server_is_overloaded',
                  message: 'Selected model is at capacity. Please try a different model.',
                },
              },
            },
          ])
        )
        return true
      }
      await Promise.race([
        current === 2 ? recoveredHeld : continuationHeld,
        new Promise(resolve => response.once('close', resolve)),
      ])
      if (!response.destroyed)
        response.end(createSse([assistantMessage(RECOVERED), responseCompleted(id)]))
      return true
    },
    async verify(control) {
      await existing.verify(control)
      active = true
      const origin = await control.command('getLocationOrigin', 'body')
      const rpc = async (method, params) => {
        const response = await fetchLocalRuntime(control, `${origin}/wework/executor/v1/rpc`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: `goal-overload-${method}`, method, params }),
          timeoutMs: options.uiTimeoutMs,
        })
        const payload = await response.json()
        assert.equal(response.ok, true)
        assert.equal(payload.ok, true, payload.error?.message)
        assert.equal(payload.result.accepted, true, payload.result.error)
        return payload.result
      }
      let address
      try {
        for (const action of ['continue', 'resume', 'paused', 'clear']) {
          const continuing = action === 'continue' || action === 'resume'
          reset()
          await control.command('click', '[data-testid="new-chat-button"]')
          const workspace = join(options.workspacePath, `goal-overload-${action}`)
          await mkdir(workspace, { recursive: true })
          await createSingleRootLocalProject(control, workspace, `goal-overload-${action}`)
          await selectE2EModel(control, undefined, 'GPT-5.6 Luna', ACTIVE_WORKBENCH_SELECTOR)
          await control.command(
            'click',
            `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="add-context-button"]`
          )
          await control.command('click', '[data-testid="set-goal-button"]')
          await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: `${GOAL}_${action}` })
          await control.command('press', ACTIVE_COMPOSER_SELECTOR, { key: 'Enter' })
          const stopped = await waitForWorkbenchDebugState(
            control,
            snapshot =>
              snapshot.pane?.goal?.status === 'blocked' &&
              snapshot.pane.goal.threadId !== 'pending' &&
              snapshot.workbench?.activeLifecycle?.goalStatus === 'blocked',
            'The overloaded turn did not stop its Goal'
          )
          address = stopped.workbench.currentRuntimeTask
          const before = (await rpc('runtime.tasks.goal.get', { address })).goal
          assert.equal(before.status, 'blocked')
          assert.equal(before.threadId, stopped.pane.goal.threadId)
          if (continuing) {
            if (action === 'resume')
              await rpc('runtime.tasks.goal.set', { address, status: 'active' })
            await waitForWorkbenchDebugState(
              control,
              snapshot =>
                requests === 2 &&
                snapshot.pane?.goal?.status === 'active' &&
                snapshot.workbench?.activeLifecycle?.goalStatus === 'active' &&
                snapshot.pane?.status?.isBusy,
              'Overload recovery did not restore the Goal lifecycle'
            )
            const after = (await rpc('runtime.tasks.goal.get', { address })).goal
            assert.equal(after.objective, before.objective)
            assert.equal(after.createdAt, before.createdAt)
            assert.equal(after.tokenBudget, before.tokenBudget)
            assert.ok(after.tokensUsed >= before.tokensUsed)
            assert.ok(after.timeUsedSeconds >= before.timeUsedSeconds)
            await control.command(
              'waitFor',
              `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="pause-goal-button"]`
            )
            releaseRecovered()
            await waitForWorkbenchDebugState(
              control,
              snapshot =>
                requests === 3 &&
                snapshot.pane?.goal?.status === 'active' &&
                snapshot.pane?.status?.isBusy,
              'The restored Goal stopped after one ordinary turn instead of continuing'
            )
            await rpc('runtime.tasks.goal.set', { address, status: 'complete' })
            releaseContinuation()
          } else {
            if (action === 'clear') await rpc('runtime.tasks.goal.clear', { address })
            else await rpc('runtime.tasks.goal.set', { address, status: action })
          }
          await waitForWorkbenchDebugState(
            control,
            snapshot => snapshot.pane?.status?.isBusy === false,
            'The recovered or stopped Goal did not settle'
          )
          if (!continuing) {
            // The model backoff is five seconds. Observe beyond its deadline to
            // prove a user mutation cannot be undone by the pending recovery.
            await new Promise(resolve => setTimeout(resolve, 5500))
            assert.equal(requests, 1, 'Recovery continued a Goal changed by the user')
            const goal = (await rpc('runtime.tasks.goal.get', { address })).goal
            assert.equal(goal?.status ?? null, action === 'clear' ? null : action)
          }
          if (continuing) {
            const readyCount = control.readyCount
            await control.command('reloadMainWindow', 'body')
            await control.awaitReadyAfter(readyCount)
            await control.command('waitFor', ACTIVE_WORKBENCH_SELECTOR, { text: RECOVERED })
            const log = await readFile(join(options.resultDir, 'executor.log'), 'utf8')
            assert.ok(log.includes('codex overloaded turn recovery'))
            assert.equal((await rpc('runtime.tasks.goal.get', { address })).goal.status, 'complete')
          }
          await rpc('runtime.tasks.goal.clear', { address })
          address = null
        }
      } finally {
        releaseRecovered?.()
        releaseContinuation?.()
        if (address) await rpc('runtime.tasks.goal.clear', { address })
        active = false
      }
    },
    diagnostics() {
      return { ...existing.diagnostics(), goalRequests: requests, goalActive: active }
    },
  }
}
