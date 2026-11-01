import { fetchLocalRuntime } from '../modules/runtime-request.mjs'
import assert from 'node:assert/strict'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  createSingleRootLocalProject,
} from '../modules/shared.mjs'
import { createSse, readRequestBody, streamingTextEvents } from '../modules/response-protocol.mjs'
import { waitForWorkbenchDebugState } from '../modules/workspace-flows.mjs'

const MARKER = 'WEWORK_GOAL_STATE_SYNC'

export function createDesktopScenario({ workspacePath, uiTimeoutMs }) {
  let active = false
  let release
  let requests = 0
  const held = new Promise(resolve => {
    release = resolve
  })

  return {
    async handleHttp(request, response, url) {
      if (
        !active ||
        request.method !== 'POST' ||
        !['/v1/responses', '/responses'].includes(url.pathname)
      ) {
        return false
      }
      const body = await readRequestBody(request)
      assert.ok(JSON.stringify(body).includes(MARKER), 'The real model request lost the fixture')
      const stream = streamingTextEvents(`goal-state-sync-${++requests}`, `${MARKER} running`)
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      response.write(createSse(stream.start))
      response.write(
        createSse([
          {
            type: 'response.output_text.delta',
            item_id: stream.itemId,
            output_index: 0,
            content_index: 0,
            delta: `${MARKER} running`,
          },
        ])
      )
      await held
      response.end(createSse(stream.finish))
      return true
    },

    async verify(control) {
      active = true
      let address
      const origin = await control.command('getLocationOrigin', 'body')
      const rpc = async (method, params) => {
        const response = await fetchLocalRuntime(control, `${origin}/wework/executor/v1/rpc`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: `goal-state-sync-${method}`, method, params }),
          timeoutMs: uiTimeoutMs,
        })
        const payload = await response.json()
        assert.equal(response.ok, true)
        assert.equal(payload.ok, true, payload.error?.message)
        assert.equal(payload.result.accepted, true, payload.result.error)
        return payload.result
      }
      try {
        await createSingleRootLocalProject(control, workspacePath, 'goal-state-sync')
        await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: MARKER })
        await control.command('press', ACTIVE_COMPOSER_SELECTOR, { key: 'Enter' })
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
          {
            text: `${MARKER} running`,
          }
        )
        address = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body')).workbench
          .currentRuntimeTask
        assert.ok(address?.taskId)

        for (const status of ['active', 'paused', 'active', 'blocked', 'active']) {
          const result = await rpc('runtime.tasks.goal.set', { address, objective: MARKER, status })
          assert.equal(result.goal.status, status)
          await waitForWorkbenchDebugState(
            control,
            snapshot =>
              snapshot.pane?.goal?.status === status &&
              snapshot.workbench?.activeLifecycle?.goalStatus === status,
            `The Goal bar and lifecycle did not agree on ${status}`
          )
          await control.command(
            'waitFor',
            `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="${status === 'active' ? 'pause-goal-button' : 'resume-goal-button'}"]`
          )
          if (status === 'active') {
            await control.command(
              'waitFor',
              `[data-testid="runtime-local-task-goal-dot-${address.taskId}"]`
            )
          } else {
            assert.equal(
              Number(
                await control.command(
                  'getElementCount',
                  `[data-testid="runtime-local-task-goal-dot-${address.taskId}"]`
                )
              ),
              0
            )
          }
        }

        await rpc('runtime.tasks.goal.clear', { address })
        await waitForWorkbenchDebugState(
          control,
          snapshot =>
            snapshot.pane?.goal === null &&
            snapshot.workbench?.activeLifecycle?.goalStatus === null,
          'Clearing the Goal did not clear both views'
        )
        await control.command('waitFor', '[data-testid="goal-status-bar"]', { visible: false })
      } finally {
        release()
        if (address) await rpc('runtime.tasks.goal.clear', { address })
      }
    },
  }
}
