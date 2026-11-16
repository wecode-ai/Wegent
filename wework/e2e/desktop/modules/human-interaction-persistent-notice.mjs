import { selectedToolCall } from './model-tool-calls.mjs'
import assert from 'node:assert/strict'
import { selectE2EModel } from './shared.mjs'
import {
  assistantMessage,
  createSse,
  functionCall,
  responseCompleted,
  responseCreated,
  selectTool,
  toolOutputText,
} from './response-protocol.mjs'

const PROMPT = 'HUMAN_INTERACTIONS_REVIEW_PERSISTENT_NOTICE'
const QUESTION = '请确认常驻提醒只在处理完成后关闭。'
const NOTICE = '[data-testid="runtime-interaction-notice"]'
const ACTIVE = '[data-workspace-tab-content][aria-hidden="false"]'
const ORIGINAL = `${ACTIVE} [data-testid="desktop-workbench-surface"][aria-hidden="false"]`
const COMPOSER = `${ACTIVE} [data-active-workbench-pane="true"] [data-testid="chat-message-input"][contenteditable="true"]`

/** Reuse the real runtime and inbox; only the model response is simulated. */
export function createPersistentInteractionNoticeCase() {
  let held
  const callId = 'persistent-interaction-notice-question'
  return {
    handleModel(body, response) {
      if (!JSON.stringify(body.input).includes(PROMPT)) return false
      if (toolOutputText(body, callId) !== null) {
        response.end(
          createSse([
            responseCreated(PROMPT),
            assistantMessage('常驻提醒验证问题已提出。'),
            responseCompleted(PROMPT),
          ])
        )
      } else {
        assert.equal(held, undefined, 'The persistence question must be emitted only once')
        held = {
          response,
          tool: selectTool(body, 'request_user_input_async', {
            questions: [{ title: QUESTION }],
          }),
        }
      }
      return true
    },
    async verify(control, modelResponseTimeoutMs) {
      // The preceding dismissal intentionally leaves its original runtime question unanswered.
      const newTask = `${ORIGINAL} [data-testid="new-chat-button"]`
      await control.command('waitFor', newTask, { visible: true })
      await control.command('click', newTask, { visible: true })
      await selectE2EModel(control, undefined, undefined, ORIGINAL)
      await control.command('waitFor', COMPOSER, { visible: true })
      await control.command('fill', COMPOSER, { value: PROMPT })
      await control.command(
        'waitFor',
        `${ORIGINAL} [data-testid="send-message-button"]:not(:disabled)`
      )
      await control.command(
        'click',
        `${ORIGINAL} [data-testid="send-message-button"]:not(:disabled)`
      )
      const deadline = Date.now() + modelResponseTimeoutMs
      while (!held && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100))
      assert.ok(held, 'The real runtime must request the persistence question')
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await control.command('focusMainWindow', 'body')
      held.response.end(
        createSse([
          responseCreated(PROMPT),
          ...selectedToolCall(callId, held.tool, 1),
          responseCompleted(PROMPT),
        ])
      )
      await control.command('waitFor', NOTICE, {
        text: QUESTION,
        timeoutMs: modelResponseTimeoutMs,
      })
      // Keep the pointer and focus outside the reminder, so the former hover pause cannot mask expiry.
      await control.command('hover', '[data-testid="workspace-tab-select-fixed-board"]')
      await control.command('waitFor', NOTICE, { text: QUESTION, visible: true, stableMs: 9_000 })
      await control.command('click', '[data-testid="interaction-notice-open"]')
      const page = `${ACTIVE} [data-testid="runtime-interactions-page"]`
      await control.command('waitFor', page, { text: QUESTION })
      await control.command('waitFor', NOTICE, { text: QUESTION, visible: true })
      await control.command('click', `${page} [data-testid="interaction-open-original"]`)
      const input = `${ORIGINAL} [data-testid="request-user-input-custom-question_1"]`
      await control.command('waitFor', input, { visible: true })
      await control.command('waitFor', NOTICE, { text: QUESTION, visible: true })
      await control.command('fill', input, { value: '已在原会话处理完成' })
      const submit = `${ORIGINAL} [data-testid="request-user-input-submit-button"]:not(:disabled)`
      await control.command('waitFor', submit)
      await control.command('click', submit)
      await control.command('click', '[data-testid="workspace-tab-select-pending-interactions"]')
      await control.command('waitFor', `${page} [data-testid="interactions-pending-count"]`, {
        text: '0',
      })
      assert.equal(
        Number(await control.command('getElementCount', NOTICE)),
        0,
        'Handling the question in its original conversation must remove the reminder'
      )
    },
  }
}
