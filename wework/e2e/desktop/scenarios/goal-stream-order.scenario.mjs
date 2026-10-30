import assert from 'node:assert/strict'
import { fetchLocalRuntime } from '../modules/runtime-request.mjs'
import { createDesktopScenario as createGoalOutputIdentity } from './goal-output-identity.scenario.mjs'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  createSingleRootLocalProject,
  withTimeout,
} from '../modules/shared.mjs'
import {
  createSse,
  handleEmptyReplyPrediction,
  readRequestBody,
  streamingTextEvents,
} from '../modules/response-protocol.mjs'
import { waitForWorkbenchDebugState } from '../modules/workspace-flows.mjs'
import { waitForCompletedRuntimeTaskThread } from '../modules/runtime-task-evidence.mjs'

const PROMPT = 'WEWORK_GOAL_NATIVE_STREAM_ORDER'
const CURRENT = 'WEWORK_GOAL_CURRENT_TURN'
const UPDATED = 'WEWORK_GOAL_UPDATED_AFTER_SWITCH'
const COMPLETED_TURNS = 7
const PROGRESS_ITEMS = 160

// Exceed the real five-page native history window without mocking history or runtime events.
function completedTurnEvents(round) {
  const events = []
  for (let index = 0; index <= PROGRESS_ITEMS; index += 1) {
    const final = index === PROGRESS_ITEMS
    const text = `${PROMPT} turn ${round} ${final ? 'finished' : `progress ${index}`}`
    const stream = streamingTextEvents(
      `goal-order-${round}-${index}`,
      text,
      final ? 'final_answer' : 'commentary'
    )
    const segment = [
      ...stream.start.filter(event => index === 0 || event.type !== 'response.created'),
      {
        type: 'response.output_text.delta',
        item_id: stream.itemId,
        output_index: index,
        content_index: 0,
        delta: text,
      },
      ...stream.finish.filter(event => final || event.type !== 'response.completed'),
    ]
    for (const event of segment) {
      if ('output_index' in event) event.output_index = index
      if (event.response) event.response.id = `goal-order-${round}`
    }
    events.push(...segment)
  }
  return events
}

export function createDesktopScenario(options) {
  const existing = createGoalOutputIdentity(options)
  let active = false
  let requests = 0
  let releaseProgress
  let releaseCompletion
  let continuationStarted
  const continuation = new Promise(resolve => {
    continuationStarted = resolve
  })
  const progress = new Promise(resolve => {
    releaseProgress = resolve
  })
  const completion = new Promise(resolve => {
    releaseCompletion = resolve
  })

  return {
    setRestartDesktopApp: restart => existing.setRestartDesktopApp(restart),
    async handleHttp(request, response, url) {
      if (!active) return existing.handleHttp(request, response, url)
      if (request.method !== 'POST' || !['/v1/responses', '/responses'].includes(url.pathname)) {
        return false
      }
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      assert.ok(
        JSON.stringify(body).includes(PROMPT),
        'The model request lost the ordering fixture'
      )
      const round = ++requests
      assert.ok(round <= COMPLETED_TURNS + 1, `Unexpected Goal continuation ${round}`)
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      if (round <= COMPLETED_TURNS) {
        response.end(createSse(completedTurnEvents(round)))
        return true
      }
      const stream = streamingTextEvents(
        'goal-order-current',
        `${CURRENT}\n${UPDATED}`,
        'final_answer'
      )
      const delta = text =>
        createSse([
          {
            type: 'response.output_text.delta',
            item_id: stream.itemId,
            output_index: 0,
            content_index: 0,
            delta: text,
          },
        ])
      response.write(createSse(stream.start))
      response.write(delta(CURRENT))
      continuationStarted()
      await progress
      if (response.destroyed) return true
      response.write(delta(`\n${UPDATED}`))
      await completion
      if (!response.destroyed) response.end(createSse(stream.finish))
      return true
    },
    async verify(control) {
      await existing.verify(control)
      active = true
      let address
      const origin = await control.command('getLocationOrigin', 'body')
      const rpc = async (method, params) => {
        const response = await fetchLocalRuntime(control, `${origin}/wework/executor/v1/rpc`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: `goal-order-${method}`, method, params }),
          timeoutMs: options.uiTimeoutMs,
        })
        const payload = await response.json()
        assert.equal(response.ok, true)
        assert.equal(payload.ok, true, payload.error?.message)
        return payload.result
      }
      try {
        await control.command('click', '[data-testid="new-chat-button"]')
        await createSingleRootLocalProject(control, options.workspacePath, 'goal-stream-order')
        await control.command(
          'click',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="add-context-button"]`
        )
        await control.command('click', '[data-testid="set-goal-button"]')
        await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: PROMPT })
        await control.command('press', ACTIVE_COMPOSER_SELECTOR, { key: 'Enter' })
        // Wait for native persistence and Goal continuation without repeatedly
        // serializing the thousand-item transcript while it is still being built.
        await withTimeout(
          continuation,
          options.workbenchReadyTimeoutMs,
          'The real Goal did not reach the held model continuation'
        )
        const running = await waitForWorkbenchDebugState(
          control,
          snapshot =>
            requests === COMPLETED_TURNS + 1 &&
            Boolean(snapshot.workbench?.activeLifecycle?.turn.id),
          'The held Goal continuation did not appear in the workbench'
        )
        address = running.workbench.currentRuntimeTask
        const page = await rpc('runtime.tasks.transcript', { address, limit: 5 })
        const latestTurnId = page.turns.find(turn => turn.status === 'streaming')?.id
        assert.ok(latestTurnId, 'The native page omitted the held active turn')
        assert.equal(
          page.hasMoreBefore,
          true,
          'The fixture did not exceed native history pagination'
        )
        assert.ok(
          page.turns.length < COMPLETED_TURNS,
          'The fixture did not leave older streamed turns outside the page'
        )
        await control.command('click', '[data-testid="new-chat-button"]')
        await control.command('click', `[data-testid="runtime-local-task-row-${address.taskId}"]`)
        await waitForWorkbenchDebugState(
          control,
          snapshot => {
            const expected = `runtime-view:${latestTurnId}:assistant`
            return (
              snapshot.pane?.transcript.loading === false &&
              snapshot.pane?.status.activeAssistantMessage?.id === expected &&
              snapshot.pane?.messageSummary.lastMessage?.id === expected
            )
          },
          'A historical streamed turn displaced the current Goal turn after navigation'
        )
        await control.command('waitFor', ACTIVE_WORKBENCH_SELECTOR, { text: CURRENT })
        releaseProgress()
        await control.command('waitFor', ACTIVE_WORKBENCH_SELECTOR, { text: UPDATED })
      } finally {
        try {
          if (address) await rpc('runtime.tasks.goal.clear', { address })
        } finally {
          releaseProgress()
          releaseCompletion()
        }
        if (address)
          await waitForCompletedRuntimeTaskThread(control, address.taskId, options.uiTimeoutMs)
      }
    },
  }
}
