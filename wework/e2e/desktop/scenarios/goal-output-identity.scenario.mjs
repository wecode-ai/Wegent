import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createDesktopScenario as createGoalStateSync } from './goal-state-sync.scenario.mjs'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  createSingleRootLocalProject,
} from '../modules/shared.mjs'
import { createSse, readRequestBody, streamingTextEvents } from '../modules/response-protocol.mjs'
import { waitForWorkbenchDebugState } from '../modules/workspace-flows.mjs'
import {
  assertConversationTextOccurrences,
  assertConversationTextOrder,
} from '../modules/conversation-navigation.mjs'
import { waitForCompletedRuntimeTaskThread } from '../modules/runtime-task-evidence.mjs'

const BASE = 'WEWORK_OUTPUT_IDENTITY_BASE'
const GOAL = 'WEWORK_OUTPUT_IDENTITY_GOAL'
const FOLLOW_UP = 'WEWORK_OUTPUT_IDENTITY_FOLLOW_UP'
const HISTORY = 'The original answer must keep its place.'
const INITIAL = 'The goal answer before restart must stay attached to its user.'
const RECOVERED = 'The recovered output must appear as a new live turn.'
const FINAL = 'The ordinary follow-up must also keep its own answer.'

export function createDesktopScenario(options) {
  const existing = createGoalStateSync(options)
  let active = false
  let stage = 0
  let restartDesktopApp
  let releaseRecovered
  let releaseFollowUp
  const recoveredHeld = new Promise(resolve => {
    releaseRecovered = resolve
  })
  const followUpHeld = new Promise(resolve => {
    releaseFollowUp = resolve
  })

  const scenario = {
    setRestartDesktopApp(restart) {
      restartDesktopApp = restart
    },
    async handleHttp(request, response, url) {
      if (!active) return existing.handleHttp(request, response, url)
      if (request.method !== 'POST' || !['/v1/responses', '/responses'].includes(url.pathname)) {
        return false
      }
      const body = await readRequestBody(request)
      assert.ok(JSON.stringify(body).includes(BASE), 'The native session lost its earlier history')
      const current = stage++
      if (current === 4) {
        assert.ok(
          JSON.stringify(body).includes(FOLLOW_UP),
          'A stopped Goal requested another model response before the follow-up'
        )
      }
      const text = [HISTORY, INITIAL, '', RECOVERED, FINAL][current]
      assert.notEqual(text, undefined, `Unexpected model request ${current}`)
      const stream = streamingTextEvents(`output-identity-${current}`, text, 'final_answer')
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      response.write(createSse(stream.start))
      if (current === 2) {
        await new Promise(resolve => response.once('close', resolve))
        return true
      }
      response.write(
        createSse([
          {
            type: 'response.output_text.delta',
            item_id: stream.itemId,
            output_index: 0,
            content_index: 0,
            delta: text,
          },
        ])
      )
      if (current === 3 || current === 4) {
        await Promise.race([
          current === 3 ? recoveredHeld : followUpHeld,
          new Promise(resolve => response.once('close', resolve)),
        ])
        if (response.destroyed) return true
      }
      response.end(createSse(stream.finish))
      return true
    },
    async verify(control) {
      await existing.verify(control)
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`
      )
      active = true
      let address
      const rpc = async (method, params) => {
        const origin = await control.command('getLocationOrigin', 'body')
        const response = await fetch(`${origin}/wework/executor/v1/rpc`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: `output-identity-${method}`, method, params }),
          signal: AbortSignal.timeout(options.uiTimeoutMs),
        })
        const payload = await response.json()
        assert.equal(response.ok, true)
        assert.equal(payload.ok, true, payload.error?.message)
        return payload.result
      }
      const waitText = text => control.command('waitFor', ACTIVE_WORKBENCH_SELECTOR, { text })
      const send = async text => {
        await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: text })
        await control.command('press', ACTIVE_COMPOSER_SELECTOR, { key: 'Enter' })
      }
      const transcript = () => rpc('runtime.tasks.transcript', { address, refresh: true })
      const goalUser = result =>
        result.messages.find(message => message.role === 'user' && message.content === GOAL)
      try {
        await control.command('click', '[data-testid="new-chat-button"]')
        await createSingleRootLocalProject(control, options.workspacePath, 'output-identity')
        await send(BASE)
        await waitText(HISTORY)
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`
        )
        await control.command(
          'click',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="add-context-button"]`
        )
        await control.command('click', '[data-testid="set-goal-button"]')
        await send(GOAL)
        await waitText(INITIAL)
        const before = await waitForWorkbenchDebugState(
          control,
          snapshot => stage === 3 && Boolean(snapshot.workbench?.currentRuntimeTask?.taskId),
          'The native Goal did not enter its automatic continuation'
        )
        address = before.workbench.currentRuntimeTask
        const originalUser = goalUser(await transcript())
        assert.ok(originalUser?.turnId, 'The original Goal user needs a native turn identity')
        await restartDesktopApp()
        await control.command('waitFor', `[data-testid="runtime-local-task-row-${address.taskId}"]`)
        await control.command('click', `[data-testid="runtime-local-task-row-${address.taskId}"]`)
        await waitText(RECOVERED)
        await control.command('click', '[data-testid="new-chat-button"]')
        await control.command('click', `[data-testid="runtime-local-task-row-${address.taskId}"]`)
        await waitText(RECOVERED)
        const during = await transcript()
        assert.equal(
          goalUser(during)?.turnId,
          originalUser.turnId,
          'Automatic recovery rebound the original user message to the recovered turn'
        )
        for (const text of [HISTORY, INITIAL, RECOVERED]) await waitText(text)
        await assertConversationTextOccurrences(
          control,
          Object.fromEntries([BASE, HISTORY, GOAL, INITIAL, RECOVERED].map(text => [text, 1]))
        )
        await control.command(
          'click',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="pause-response-button"]`
        )
        await waitForCompletedRuntimeTaskThread(control, address.taskId, options.uiTimeoutMs)
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`
        )
        await rpc('runtime.tasks.goal.clear', { address })
        await control.command('waitFor', '[data-testid="goal-status-bar"]', { visible: false })
        await send(FOLLOW_UP)
        await waitText(FINAL)
        await control.command('click', '[data-testid="new-chat-button"]')
        await control.command('click', `[data-testid="runtime-local-task-row-${address.taskId}"]`)
        await waitText(FINAL)
        releaseFollowUp()
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`
        )
        await control.command('click', '[data-testid="new-chat-button"]')
        await control.command('click', `[data-testid="runtime-local-task-row-${address.taskId}"]`)
        for (const text of [BASE, HISTORY, GOAL, INITIAL, RECOVERED, FOLLOW_UP, FINAL])
          await waitText(text)
        await waitForWorkbenchDebugState(
          control,
          snapshot => snapshot.pane?.transcript?.loading === false,
          'The final history did not finish loading'
        )
        await writeFile(
          join(options.resultDir, 'output-identity-transcript.json'),
          JSON.stringify(await transcript(), null, 2)
        )
        const visible = await control.command(
          'getText',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-chat-scroll-content"]`
        )
        const ordered = [BASE, HISTORY, GOAL, INITIAL, RECOVERED, FOLLOW_UP, FINAL]
        await assertConversationTextOccurrences(
          control,
          Object.fromEntries(ordered.map(text => [text, 1]))
        )
        assertConversationTextOrder(visible, ordered)
      } finally {
        releaseRecovered()
        releaseFollowUp()
        if (address) await rpc('runtime.tasks.goal.clear', { address })
      }
    },
  }
  return scenario
}
