import assert from 'node:assert/strict'
import { createDesktopScenario as createExistingScenario } from './reply-predictions.scenario.mjs'
import { selectE2EModel } from '../modules/shared.mjs'
import { waitForSnapshot } from '../modules/conversation-layout.mjs'
import {
  assistantMessage,
  createSse,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const ACTIVE = '[data-workspace-tab-content][aria-hidden="false"]'
const INPUT = `${ACTIVE} [data-testid="chat-message-input"]`
const GHOST = `${ACTIVE} [data-testid="chat-message-input-prediction"]`
const PROMPT = 'WEWORK_REPLY_PREDICTION_BACKGROUND 请分析下一步验证方案。'
const SUGGESTION = '请继续验证后台任务。'

function complete(response, id, text) {
  response.end(createSse([assistantMessage(text), responseCompleted(id)]))
}

async function waitForCache(control, key, text) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const raw = await control.command('getLocalStorageItem', 'body', { value: key })
    if (raw && JSON.parse(raw).text === text) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail('The background task did not persist its reply suggestion before reopening')
}

export async function restoreDisabledReplyPredictions(control, verificationError) {
  try {
    await control.command('navigate', 'body', { value: '/settings/general' })
    await control.command('waitFor', '[data-testid="reply-prediction-enabled"]')
    await control.command('scrollIntoView', '[data-testid="reply-prediction-settings"]')
    const checked = await control.command(
      'getAttribute',
      '[data-testid="reply-prediction-enabled"]',
      {
        value: 'aria-checked',
      }
    )
    if (checked === 'true') {
      await control.command('click', '[data-testid="reply-prediction-enabled"]')
    }
    await control.command(
      'waitFor',
      '[data-testid="reply-prediction-enabled"][aria-checked="false"]'
    )
  } catch (cleanupError) {
    if (verificationError) {
      throw new AggregateError(
        [verificationError, cleanupError],
        'Reply prediction verification and cleanup failed'
      )
    }
    throw cleanupError
  }
}

// Add background cases to the existing CI checkpoint without changing its assertions.
export async function createDesktopScenario(options) {
  const existing = await createExistingScenario(options)
  let active = false
  let heldTurn
  let heldPrediction
  let predictionRequests = 0
  return {
    ...existing,
    async handleHttp(request, response, url) {
      if (!active) return existing.handleHttp(request, response, url)
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      const input = JSON.stringify(body.input ?? body.messages ?? [])
      assert.ok(input.includes('WEWORK_REPLY_PREDICTION_BACKGROUND'))
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      if (input.includes('Predict one natural next USER message')) {
        predictionRequests += 1
        const id = `background-prediction-${predictionRequests}`
        response.write(createSse([responseCreated(id)]))
        if (predictionRequests === 1)
          complete(response, id, JSON.stringify({ suggestion: SUGGESTION }))
        else heldPrediction = { response, id }
      } else {
        response.write(createSse([responseCreated('background-turn')]))
        heldTurn = response
      }
      return true
    },
    async verify(control) {
      await existing.verify(control)
      active = true
      let verificationError
      try {
        await control.command('click', '[data-testid="reply-prediction-enabled"]')
        await control.command(
          'waitFor',
          '[data-testid="reply-prediction-enabled"][aria-checked="true"]'
        )
        await control.command('click', '[data-testid="settings-back-button"]')
        await control.command('click', '[data-testid="new-chat-button"]')
        await control.command('waitFor', INPUT)
        await selectE2EModel(control)
        await control.command('fill', INPUT, { value: PROMPT })
        await control.command('clickWhenEnabled', `${ACTIVE} [data-testid="send-message-button"]`)
        await waitForSnapshot(
          control,
          snapshot => heldTurn && snapshot.testIds.includes('pause-response-button'),
          'The task did not start its held model response'
        )
        const debug = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
        const task = debug.workbench?.currentRuntimeTask
        assert.ok(task?.taskId && task.deviceId)
        // New-chat tasks are chat-scoped even when their route omits workspaceKind.
        const scope = JSON.stringify([task.deviceId, task.taskId, null])
        const cacheKey = `wework.replyPrediction.v1.${scope}`
        await control.command('click', '[data-testid="new-chat-button"]')
        await control.command('waitFor', INPUT)
        const background = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
        assert.notEqual(background.workbench?.currentRuntimeTask?.taskId, task.taskId)
        complete(heldTurn, 'background-turn', '方案已分析，请继续验证。')
        await waitForCache(control, cacheKey, SUGGESTION)
        assert.equal(predictionRequests, 1, 'The inactive task did not generate exactly once')
        await control.command('click', `[data-testid="runtime-local-task-row-${task.taskId}"]`)
        await control.command('waitFor', GHOST, { text: SUGGESTION })
        assert.equal(predictionRequests, 1, 'Reopening regenerated the cached suggestion')

        await control.command('fill', INPUT, { value: `${PROMPT} 再检查一次。` })
        heldTurn = null
        await control.command('clickWhenEnabled', `${ACTIVE} [data-testid="send-message-button"]`)
        await waitForSnapshot(control, () => heldTurn, 'The follow-up turn did not start')
        complete(heldTurn, 'background-turn', '第二轮检查完成。')
        await control.command(
          'waitFor',
          `${ACTIVE} [data-testid="chat-message-input-prediction-pending"]`
        )
        await waitForSnapshot(
          control,
          () => heldPrediction,
          'The follow-up prediction did not start'
        )
        await control.command('click', '[data-testid="new-chat-button"]')
        await control.command('waitFor', INPUT)
        assert.equal(
          heldPrediction.response.destroyed,
          false,
          'Switching tasks cancelled prediction'
        )
        const nextSuggestion = '请确认第二轮验证结果。'
        complete(
          heldPrediction.response,
          heldPrediction.id,
          JSON.stringify({ suggestion: nextSuggestion })
        )
        await waitForCache(control, cacheKey, nextSuggestion)
        await control.command('click', `[data-testid="runtime-local-task-row-${task.taskId}"]`)
        await control.command('waitFor', GHOST, { text: nextSuggestion })
        assert.equal(predictionRequests, 2, 'Task switching duplicated a prediction request')
      } catch (error) {
        verificationError = error
        throw error
      } finally {
        heldTurn?.end()
        heldPrediction?.response.end()
        await restoreDisabledReplyPredictions(control, verificationError)
      }
    },
    diagnostics() {
      return { ...existing.diagnostics(), backgroundPredictionRequests: predictionRequests }
    },
  }
}
