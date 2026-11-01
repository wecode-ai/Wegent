import { fetchLocalRuntime } from '../modules/runtime-request.mjs'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createDesktopScenario as createGoalStateSync } from './goal-state-sync.scenario.mjs'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  createSingleRootLocalProject,
} from '../modules/shared.mjs'
import {
  createSse,
  handleEmptyReplyPrediction,
  readRequestBody,
  streamingTextEvents,
} from '../modules/response-protocol.mjs'
import { waitForWorkbenchDebugState } from '../modules/workspace-flows.mjs'
import {
  activeTranscriptSelector,
  assertConversationTextOccurrences,
  assertConversationTextOrder,
} from '../modules/conversation-navigation.mjs'
import { waitForCompletedRuntimeTaskThread } from '../modules/runtime-task-evidence.mjs'
import { withShortConversationViewport } from '../modules/conversation-short-layout.mjs'

const BASE = 'WEWORK_OUTPUT_IDENTITY_BASE'
const GOAL = 'WEWORK_OUTPUT_IDENTITY_GOAL'
const FOLLOW_UP = 'WEWORK_OUTPUT_IDENTITY_FOLLOW_UP'
const HISTORY = 'The original answer must keep its place.'
const INITIAL = 'The goal answer before restart must stay attached to its user.'
const RECOVERED = 'The recovered output must appear as a new live turn.'
const FINAL = 'The ordinary follow-up must also keep its own answer.'

async function captureIdentityFailure(control, resultDir, evidence) {
  const transcriptSelector = '[data-testid="desktop-chat-scroll-content"]'
  const commands = {
    activeWorkspaceCount: ['getElementCount', '[data-workspace-tab-content][aria-hidden="false"]'],
    focusedPaneCount: [
      'getElementCount',
      `${ACTIVE_WORKBENCH_SELECTOR}[data-active-workbench-pane="true"]`,
    ],
    activeTranscriptCount: ['getElementCount', activeTranscriptSelector()],
    activeTranscriptText: ['getText', activeTranscriptSelector()],
    allTranscriptText: ['getText', transcriptSelector],
    viewportMetrics: ['getElementMetrics', '[data-testid="desktop-chat-scroll"]'],
    rowMetrics: ['getElementMetrics', `${transcriptSelector} [data-message-row][data-index]`],
    workbench: ['getWorkbenchDebugSnapshot', 'body'],
  }
  const diagnostics = { ...evidence }
  for (const [key, args] of Object.entries(commands)) {
    try {
      diagnostics[key] = await control.command(...args)
    } catch (error) {
      diagnostics[key] = { error: String(error) }
    }
  }
  await writeFile(
    join(resultDir, 'output-identity-failure.json'),
    JSON.stringify(diagnostics, null, 2)
  )
}

export function createDesktopScenario(options) {
  const existing = createGoalStateSync(options)
  let active = false
  let stage = 0
  let phase = 'setup'
  const requestTrace = []
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
      if (handleEmptyReplyPrediction(body, response)) return true
      assert.ok(JSON.stringify(body).includes(BASE), 'The native session lost its earlier history')
      const current = stage++
      requestTrace.push({
        stage: current,
        phase,
        hasFollowUp: JSON.stringify(body).includes(FOLLOW_UP),
        timestamp: Date.now(),
      })
      if (current === 4) {
        assert.ok(
          JSON.stringify(body).includes(FOLLOW_UP),
          `A stopped Goal requested another model response before the follow-up: ${JSON.stringify(requestTrace)}`
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
      let recoveredTranscript
      const rpc = async (method, params) => {
        const origin = await control.command('getLocationOrigin', 'body')
        const response = await fetchLocalRuntime(control, `${origin}/wework/executor/v1/rpc`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: `output-identity-${method}`, method, params }),
          timeoutMs: options.uiTimeoutMs,
        })
        const payload = await response.json()
        assert.equal(response.ok, true)
        assert.equal(payload.ok, true, payload.error?.message)
        return payload.result
      }
      const waitText = text => control.command('waitFor', activeTranscriptSelector(), { text })
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
        phase = 'restart'
        await restartDesktopApp()
        await control.command('waitFor', `[data-testid="runtime-local-task-row-${address.taskId}"]`)
        await control.command('click', `[data-testid="runtime-local-task-row-${address.taskId}"]`)
        await waitText(RECOVERED)
        phase = 'reopen-recovered-conversation'
        await control.command('click', '[data-testid="new-chat-button"]')
        await control.command('click', `[data-testid="runtime-local-task-row-${address.taskId}"]`)
        await waitText(RECOVERED)
        const during = await transcript()
        recoveredTranscript = during
        assert.equal(
          goalUser(during)?.turnId,
          originalUser.turnId,
          'Automatic recovery rebound the original user message to the recovered turn'
        )
        await withShortConversationViewport(
          control,
          'The recovered Goal identity fixture',
          async () => {
            for (const text of [BASE, HISTORY, GOAL, INITIAL, RECOVERED]) await waitText(text)
            await assertConversationTextOccurrences(
              control,
              Object.fromEntries([BASE, HISTORY, GOAL, INITIAL, RECOVERED].map(text => [text, 1]))
            )
          }
        )
        phase = 'pause-response'
        await control.command(
          'click',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="pause-response-button"]`
        )
        phase = 'wait-for-stopped-thread'
        await waitForCompletedRuntimeTaskThread(control, address.taskId, options.uiTimeoutMs)
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`
        )
        phase = 'clear-goal'
        await rpc('runtime.tasks.goal.clear', { address })
        await control.command('waitFor', '[data-testid="goal-status-bar"]', { visible: false })
        phase = 'send-follow-up'
        await send(FOLLOW_UP)
        phase = 'wait-for-follow-up'
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
        await waitForWorkbenchDebugState(
          control,
          snapshot => snapshot.pane?.transcript?.loading === false,
          'The final history did not finish loading'
        )
        await writeFile(
          join(options.resultDir, 'output-identity-transcript.json'),
          JSON.stringify(await transcript(), null, 2)
        )
        await withShortConversationViewport(
          control,
          'The completed Goal identity fixture',
          async () => {
            const ordered = [BASE, HISTORY, GOAL, INITIAL, RECOVERED, FOLLOW_UP, FINAL]
            for (const text of ordered) await waitText(text)
            const visible = await control.command('getText', activeTranscriptSelector())
            await assertConversationTextOccurrences(
              control,
              Object.fromEntries(ordered.map(text => [text, 1]))
            )
            assertConversationTextOrder(visible, ordered)
          }
        )
      } catch (error) {
        console.error('[goal-output-identity] verification failed', { phase, requestTrace }, error)
        try {
          await captureIdentityFailure(control, options.resultDir, {
            phase,
            requestTrace,
            recoveredTranscript,
          })
        } catch (diagnosticError) {
          console.error('[goal-output-identity] failed to retain diagnostics', diagnosticError)
        }
        throw error
      } finally {
        phase = 'cleanup'
        releaseRecovered()
        releaseFollowUp()
        if (address) await rpc('runtime.tasks.goal.clear', { address })
      }
    },
  }
  return scenario
}
