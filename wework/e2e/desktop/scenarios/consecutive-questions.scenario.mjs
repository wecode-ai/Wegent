import { selectedToolCall } from '../modules/model-tool-calls.mjs'
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  DEFAULT_MODEL_ID,
  createSingleRootLocalProject,
  selectE2EModel,
} from '../modules/shared.mjs'
import {
  assistantMessage,
  createSse,
  functionCall,
  handleEmptyReplyPrediction,
  readRequestBody,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
  selectTool,
} from '../modules/response-protocol.mjs'
import { waitForWorkbenchDebugState } from '../modules/workspace-flows.mjs'

const PROMPT = 'WEWORK_CONSECUTIVE_ASYNC_QUESTIONS'
const COMPLETE = 'WEWORK_CONSECUTIVE_ANSWERS_ACCEPTED'
const FIRST = 'Which audience should receive the report?'
const SECOND = 'Which format should the report use?'
const THIRD = 'When should the report be delivered?'
const ANSWER = 'STAFF\nPDF\nTomorrow'
const CARD = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="request-user-input-card"]`
const INPUT = `${CARD} [data-testid="request-user-input-custom-question_1"]`

export function createDesktopScenario({
  executorHome,
  workspacePath,
  resultDir,
  workbenchReadyTimeoutMs,
}) {
  let active = false
  let releaseSecond
  const secondReady = new Promise(resolve => {
    releaseSecond = resolve
  })
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
      if (!JSON.stringify(body).includes(PROMPT)) return false
      const id = `consecutive-${Date.now()}`
      let events
      if (!requestContainsToolOutput(body, 'consecutive-first')) {
        const tool = selectTool(body, 'request_user_input_async', {
          questions: [{ title: FIRST }],
        })
        events = selectedToolCall('consecutive-first', tool)
      } else if (!requestContainsToolOutput(body, 'consecutive-second')) {
        await secondReady
        const tool = selectTool(body, 'request_user_input_async', {
          questions: [
            { title: SECOND, options: ['PDF', 'HTML'] },
            { title: THIRD, options: ['Today', 'Tomorrow'] },
          ],
        })
        events = selectedToolCall('consecutive-second', tool)
      } else {
        const input = body.input ?? body.messages ?? []
        const answered = input.some(
          message => message.role === 'user' && JSON.stringify(message).includes('STAFF')
        )
        if (answered)
          assert.ok(
            JSON.stringify(input).includes(ANSWER.replaceAll('\n', '\\n')),
            'All three answers must reach the real Codex model request in order'
          )
        events = [assistantMessage(answered ? COMPLETE : 'Waiting for all three answers.')]
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },
    async verify(control) {
      active = true
      const capabilities = join(executorHome, 'capabilities')
      await mkdir(capabilities, { recursive: true })
      await writeFile(
        join(capabilities, 'model-catalog-overrides.json'),
        JSON.stringify([
          {
            slug: DEFAULT_MODEL_ID,
            fields: { experimental_supported_tools: ['request_user_input_async'] },
          },
        ])
      )
      await rm(join(executorHome, 'codex', 'models_cache.json'), { force: true })
      await control.command('waitFor', '[data-testid="new-chat-button"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await control.command('click', '[data-testid="new-chat-button"]')
      const workspace = join(workspacePath, 'consecutive-questions')
      await mkdir(workspace, { recursive: true })
      await createSingleRootLocalProject(control, workspace, 'Consecutive questions')
      await selectE2EModel(control)
      await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: PROMPT })
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]:not(:disabled)`
      )
      await control.command('press', ACTIVE_COMPOSER_SELECTOR, { key: 'Enter' })
      try {
        await control.command('waitFor', CARD, { text: FIRST, visible: true })
        await control.command('focus', INPUT)
        await control.command('fill', INPUT, { value: 'STAFF' })
        const readQuestions = async () => {
          const snapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
          const task = snapshot.pane.currentRuntimeTask
          const messages = JSON.parse(
            await control.command('getRuntimeConversationMessages', 'body', {
              value: JSON.stringify({ deviceId: task.deviceId, taskId: task.taskId }),
            })
          )
          return {
            input: await control.command('getValue', INPUT),
            inputAttribute: await control.command('getAttribute', INPUT, { value: 'value' }),
            mountId: await control.command(
              'getAttribute',
              `${CARD} [data-testid="request-user-input-question-question_1"]`,
              { value: 'id' }
            ),
            questions: messages.flatMap(message =>
              (message.blocks ?? []).flatMap(block =>
                block.renderPayload?.kind === 'request_user_input' ? [block.renderPayload] : []
              )
            ),
          }
        }
        const firstState = await readQuestions()
        await writeFile(
          join(resultDir, 'consecutive-question-first-draft.json'),
          JSON.stringify(firstState, null, 2)
        )
        assert.equal(
          firstState.input,
          'STAFF',
          'Establish the first draft before releasing further questions'
        )
        assert.equal(firstState.inputAttribute, 'STAFF', 'React must retain the first draft')
        releaseSecond()
        await control.command('waitFor', CARD, { text: THIRD, visible: true })
        await writeFile(
          join(resultDir, 'consecutive-question-identities.json'),
          JSON.stringify(
            {
              first: firstState,
              afterArrival: await readQuestions(),
            },
            null,
            2
          )
        )
        assert.equal(
          await control.command('getValue', INPUT),
          'STAFF',
          'New questions must preserve the first draft'
        )
        const text = await control.command('getText', CARD)
        assert.ok(
          text.indexOf(FIRST) < text.indexOf(SECOND) && text.indexOf(SECOND) < text.indexOf(THIRD)
        )
        const thirdTestId = await control.command(
          'getAttribute',
          `${CARD} [data-testid^="request-user-input-question-"]`,
          { text: THIRD, value: 'data-testid' }
        )
        const thirdId = thirdTestId.slice('request-user-input-question-'.length)
        await control.command(
          'click',
          `${CARD} [data-testid=${JSON.stringify(`request-user-input-option-${thirdId}-1`)}]`
        )
        await control.command('click', `${CARD} [data-testid="request-user-input-submit-button"]`)
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
          { text: COMPLETE, visible: true }
        )
        await waitForWorkbenchDebugState(
          control,
          snapshot => snapshot.pane?.status?.isBusy === false,
          'The combined answer must complete the turn'
        )
        assert.equal(Number(await control.command('getElementCount', CARD)), 0)
        const readyCount = control.readyCount
        await control.command('reloadMainWindow', 'body')
        await control.awaitReadyAfter(readyCount)
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="user-message-question-reply"]`,
          { text: THIRD, visible: true }
        )
        assert.equal(
          Number(await control.command('getElementCount', CARD)),
          0,
          'Answered questions must remain settled after reloading'
        )
      } finally {
        active = false
        releaseSecond()
      }
    },
  }
}
