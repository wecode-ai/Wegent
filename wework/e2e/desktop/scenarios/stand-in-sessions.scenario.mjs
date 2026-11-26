import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as poll } from 'node:timers/promises'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { DEFAULT_MODEL_ID } from '../modules/shared.mjs'
import { modelRequestTexts } from '../modules/model-tool-output.mjs'
import {
  assistantMessage,
  createSse,
  isReplyPredictionRequest,
  readRequestBody,
  toolOutputText,
  selectTool,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'
import { selectedToolCall } from '../modules/model-tool-calls.mjs'
import { storyUntil } from '../modules/stand-in-source-story-evidence.mjs'

const USER = 9001
const TASK = `stand-in-chat-${USER}-primary`
const FIRST = 'STAND_IN_SESSION_FIRST_QUESTION'
const SECOND = 'STAND_IN_SESSION_SECOND_CLEAN_CONTEXT'
const FOLLOWUP = 'STAND_IN_SESSION_FOLLOWUP'
const ASYNC_PROMPT = 'STAND_IN_SESSION_ASYNC_QUESTION'
const ASYNC_QUESTION = 'STAND_IN_SESSION_ASYNC_QUESTION_TEXT'
const ASYNC_ANSWER = 'STAND_IN_SESSION_ASYNC_ANSWER'
const ASYNC_WAITING = 'STAND_IN_SESSION_ASYNC_WAITING'
const ASYNC_RESULT = 'STAND_IN_SESSION_ASYNC_RESULT'
const CHILD = 'STAND_IN_SESSION_CHILD_RESULT'
const CHAT = '[data-testid="stand-in-conversation"]'

export function createDesktopScenario({
  executorHome,
  workspacePath,
  uiTimeoutMs,
  modelResponseTimeoutMs,
  restartDesktopApp,
}) {
  let cleanContextObserved = false
  let followupObserved = false
  let questionCalls = 0
  let asyncQuestionAccepted = false
  let asyncAnswerObserved = false
  let resultDelivered = false
  let heldPhase = 'question'
  let releaseHeldResponse

  function releaseResponse() {
    heldPhase = null
    const release = releaseHeldResponse
    releaseHeldResponse = undefined
    release?.()
  }

  async function settled(control, expected = () => true) {
    const deadline = Date.now() + modelResponseTimeoutMs
    let task
    while (Date.now() < deadline) {
      const result = await requestExecutor(
        control,
        'runtime.tasks.get',
        { taskId: TASK },
        uiTimeoutMs
      )
      task = result.task
      assert.notEqual(task?.status, 'failed', JSON.stringify(task))
      if (task?.status === 'done' && task.running !== true && expected(task)) {
        const running = await requestExecutor(
          control,
          'runtime.tasks.running_count',
          {},
          uiTimeoutMs
        )
        if (running.runningCount === 0) return task
      }
      await poll(100)
    }
    assert.fail(`Stand-in did not settle: ${JSON.stringify(task)}`)
  }

  return {
    async prepareApp() {
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
    },
    async handleHttp(req, response, url) {
      if (req.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(req)
      if (isReplyPredictionRequest(body)) return false
      const input = JSON.stringify(body.input ?? [])
      let events
      let responsePhase = null
      if (input.includes('Wework delegated task result:')) {
        assert.ok(input.includes(SECOND), 'Work results must wake the current execution session')
        assert.ok(!input.includes(FIRST), 'Work results must not reopen the old execution session')
        resultDelivered = true
        events = [assistantMessage('独立工作的结果已回到同一个助理入口。')]
      } else if (input.includes(CHILD)) {
        events = [assistantMessage('独立工作已完成。')]
      } else if (!asyncAnswerObserved && input.includes(ASYNC_PROMPT)) {
        const answer = toolOutputText(body, 'session-async-question')
        if (answer === null) {
          assert.equal(asyncQuestionAccepted, false, 'The assistant question must not be repeated')
          events = selectedToolCall(
            'session-async-question',
            selectTool(body, 'request_user_input_async', {
              questions: [{ title: ASYNC_QUESTION }],
            })
          )
        } else {
          assert.deepEqual(JSON.parse(answer), { accepted: true })
          asyncQuestionAccepted = true
          asyncAnswerObserved = modelRequestTexts(body, 'user').includes(ASYNC_ANSWER)
          events = [assistantMessage(asyncAnswerObserved ? ASYNC_RESULT : ASYNC_WAITING)]
        }
      } else if (input.includes(FOLLOWUP)) {
        followupObserved = true
        events = [assistantMessage('后续消息仍在第二段执行会话中。')]
      } else if (input.includes(SECOND)) {
        assert.ok(
          !input.includes(FIRST),
          'A new execution session must not replay old model context'
        )
        cleanContextObserved = true
        events = [assistantMessage('第二段执行会话已开始，历史记录仍然保留。')]
      } else if (input.includes(FIRST)) {
        const answer = toolOutputText(body, 'session-question')
        if (answer !== null) {
          assert.deepEqual(JSON.parse(answer), { answers: { session: { answers: ['Continue'] } } })
          responsePhase = 'answer'
          events = [assistantMessage('第一段问题已回答，可以继续。')]
        } else {
          questionCalls += 1
          if (questionCalls === 1) responsePhase = 'question'
          events = selectedToolCall(
            'session-question',
            selectTool(body, 'request_user_input', {
              questions: [
                {
                  header: 'Session',
                  id: 'session',
                  question: '是否继续这项工作？',
                  options: [
                    { label: 'Wait', description: 'Keep the work paused.' },
                    { label: 'Continue', description: 'Continue the current work.' },
                  ],
                },
              ],
            })
          )
        }
      } else return false
      const id = `stand-in-session-${Date.now()}`
      const sendResponse = () => {
        if (response.destroyed || response.writableEnded) return
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
        response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      }
      if (responsePhase && responsePhase === heldPhase) releaseHeldResponse = sendResponse
      else sendResponse()
      return true
    },
    async verify(control) {
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await control.command('click', '[data-testid="workspace-tab-select-fixed-task"]')
      await control.command('clickWhenEnabled', '[data-testid="personal-stand-in-button"]')
      await control.command('waitFor', CHAT)
      const settings = await requestExecutor(
        control,
        'runtime.stand_in.personal.get',
        { userId: USER },
        uiTimeoutMs
      )
      const catalog = await requestExecutor(control, 'runtime.runner.catalog', {}, uiTimeoutMs)
      const model = catalog.models.find(model => model.runtime === 'codex' && model.is_default)
      assert.ok(model)
      const options = {
        modelId: model.local_model_id,
        modelType: 'runtime',
        modelOptions: { runnerModelProvider: model.provider },
      }
      await requestExecutor(
        control,
        'runtime.stand_in.personal.save',
        {
          userId: USER,
          settings: {
            ...settings,
            primary: {
              prompt: '',
              preferences: '',
              ...settings.primary,
              enabled: true,
              connections: [],
            },
          },
        },
        uiTimeoutMs
      )
      const send = (message, extra = {}) =>
        requestExecutor(
          control,
          'runtime.stand_in.conversation',
          {
            userId: USER,
            message,
            options: { ...options, ...extra },
          },
          uiTimeoutMs
        )
      const editor = `${CHAT} [data-testid="chat-message-input"][contenteditable="true"]`
      await control.command('fill', editor, { value: FIRST })
      try {
        await control.command('clickWhenEnabled', `${CHAT} [data-testid="send-message-button"]`)
        await storyUntil(
          () => Promise.resolve(Boolean(releaseHeldResponse)),
          Boolean,
          modelResponseTimeoutMs,
          'The first assistant message must reach the model'
        )
        await control.command('waitFor', `${CHAT} [data-testid="message-user"]`, {
          text: FIRST,
          visible: true,
          timeoutMs: uiTimeoutMs,
        })
        await control.command('waitFor', editor, {
          visible: true,
          timeoutMs: uiTimeoutMs,
        })
        await control.command('waitFor', `${CHAT} [data-testid="message-assistant-waiting"]`, {
          text: '正在思考',
          visible: true,
          timeoutMs: uiTimeoutMs,
        })
      } finally {
        releaseResponse()
      }
      await control.command('waitFor', '[data-testid="request-user-input-card"]', {
        timeoutMs: modelResponseTimeoutMs,
      })
      await control.command('waitFor', `${CHAT} [data-testid="message-assistant-waiting"]`, {
        visible: false,
        timeoutMs: uiTimeoutMs,
      })
      const pending = await requestExecutor(
        control,
        'runtime.tasks.get',
        { taskId: TASK },
        uiTimeoutMs
      )
      const firstThread = pending.task.threadId
      assert.ok(firstThread)
      await assert.rejects(
        send(SECOND, { startNewSession: true, expectedThreadId: firstThread }),
        /Finish the current execution, questions and approvals/
      )
      assert.equal(
        (await requestExecutor(control, 'runtime.tasks.get', { taskId: TASK }, uiTimeoutMs)).task
          .threadId,
        firstThread
      )
      const questionSummary = `${CHAT} [data-testid="request-user-input-summary"]`
      heldPhase = 'answer'
      try {
        await control.command('click', '[data-testid="request-user-input-option-session-1"]')
        await storyUntil(
          () => Promise.resolve(Boolean(releaseHeldResponse)),
          Boolean,
          modelResponseTimeoutMs,
          'The answered question must reach the model before its result'
        )
        await control.command('waitFor', questionSummary, {
          text: 'Continue',
          visible: true,
          timeoutMs: uiTimeoutMs,
        })
      } finally {
        releaseResponse()
      }
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: '第一段问题已回答',
        timeoutMs: modelResponseTimeoutMs,
      })
      await settled(control)
      await control.command('waitFor', questionSummary, {
        visible: false,
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(await control.command('getElementCount', questionSummary), '0')
      assert.equal(questionCalls, 1)
      const initialSearch = await requestExecutor(
        control,
        'runtime.tasks.transcript.search',
        { taskId: TASK, query: '第一段问题已回答' },
        uiTimeoutMs
      )
      const retainedCursor = initialSearch.matches[0]?.cursor
      assert.ok(retainedCursor, 'The first session must issue a reusable history cursor')
      await send(SECOND, {
        startNewSession: true,
        expectedThreadId: firstThread,
        clientUserMessageId: 'session-second',
      })
      const current = await settled(
        control,
        task => task.threadId !== firstThread && cleanContextObserved
      )
      assert.notEqual(current.threadId, firstThread)
      assert.equal(cleanContextObserved, true)
      await assert.rejects(
        send(SECOND, { startNewSession: true, expectedThreadId: firstThread }),
        /active conversation session changed/
      )
      const newest = await requestExecutor(
        control,
        'runtime.tasks.transcript',
        { taskId: TASK, limit: 100 },
        uiTimeoutMs
      )
      assert.equal(newest.sessionThreadId, current.threadId)
      assert.ok(JSON.stringify(newest.messages).includes('第二段执行会话已开始'))
      assert.equal(newest.hasMoreBefore, true)
      const oldest = await requestExecutor(
        control,
        'runtime.tasks.transcript',
        { taskId: TASK, limit: 100, beforeCursor: newest.beforeCursor },
        uiTimeoutMs
      )
      assert.equal(oldest.sessionThreadId, firstThread)
      assert.equal(oldest.threadId, current.threadId)
      assert.ok(JSON.stringify(oldest.messages).includes('第一段问题已回答'))
      const taskSearch = await requestExecutor(
        control,
        'runtime.tasks.search',
        { query: '第一段问题已回答' },
        uiTimeoutMs
      )
      assert.ok(taskSearch.items.some(item => item.taskId === TASK))
      const search = await requestExecutor(
        control,
        'runtime.tasks.transcript.search',
        {
          taskId: TASK,
          query: '第一段问题已回答',
        },
        uiTimeoutMs
      )
      assert.equal(search.matches.length, 1)
      assert.equal(search.matches[0].sessionThreadId, firstThread)
      const matched = await requestExecutor(
        control,
        'runtime.tasks.transcript',
        {
          taskId: TASK,
          beforeCursor: search.matches[0].cursor,
        },
        uiTimeoutMs
      )
      assert.ok(JSON.stringify(matched.messages).includes('第一段问题已回答'))
      const retained = await requestExecutor(
        control,
        'runtime.tasks.transcript',
        { taskId: TASK, beforeCursor: retainedCursor },
        uiTimeoutMs
      )
      assert.equal(retained.sessionThreadId, firstThread)
      assert.ok(JSON.stringify(retained.messages).includes('第一段问题已回答'))
      await send(FOLLOWUP, { clientUserMessageId: 'session-followup' })
      assert.equal((await settled(control, () => followupObserved)).threadId, current.threadId)
      const activeChat = `[data-workspace-tab-content][aria-hidden="false"] ${CHAT}`
      await control.command(
        'fill',
        `${activeChat} [data-testid="chat-message-input"][contenteditable="true"]`,
        { value: ASYNC_PROMPT }
      )
      await control.command('clickWhenEnabled', `${activeChat} [data-testid="send-message-button"]`)
      const card = `${activeChat} [data-testid="request-user-input-card"]:has([data-testid="request-user-input-custom-question_1"])`
      await control.command('waitFor', card, {
        text: ASYNC_QUESTION,
        visible: true,
        timeoutMs: modelResponseTimeoutMs,
      })
      await control.command('waitFor', `${activeChat} [data-testid="message-assistant"]`, {
        text: ASYNC_WAITING,
        timeoutMs: modelResponseTimeoutMs,
      })
      const awaitingAnswer = await settled(
        control,
        task => task.interactionStatus === 'awaitingUserReply'
      )
      assert.equal(awaitingAnswer.threadId, current.threadId)
      assert.equal(asyncQuestionAccepted, true)
      await control.command(
        'fill',
        `${card} [data-testid="request-user-input-custom-question_1"]`,
        {
          value: ASYNC_ANSWER,
        }
      )
      await control.command(
        'clickWhenEnabled',
        `${card} [data-testid="request-user-input-submit-button"]`
      )
      await control.command('waitFor', `${activeChat} [data-testid="message-assistant"]`, {
        text: ASYNC_RESULT,
        timeoutMs: modelResponseTimeoutMs,
      })
      assert.equal(asyncAnswerObserved, true)
      const answered = await settled(control, task => !task.interactionStatus)
      assert.equal(answered.threadId, current.threadId)
      const origin = {
        type: 'stand_in_task',
        initiatedBy: 'stand_in',
        standInId: '@primary',
        userId: USER,
        deviceId: settings.executionDeviceId,
        sourceTaskId: TASK,
        askBeforeAct: true,
      }
      const child = await requestExecutor(
        control,
        'runtime.tasks.create',
        {
          taskId: 'stand-in-session-child',
          title: '助理分段后的独立工作',
          runtime: 'codex',
          workspacePath,
          message: CHILD,
          origin,
          executionRequest: {
            task_id: 'stand-in-session-child',
            subtask_id: 'stand-in-session-child-initial',
            user_id: USER,
            prompt: CHILD,
            new_session: true,
            bot: [{ shell_type: 'Codex', name: 'Session result verification' }],
            model_config: { model_id: model.local_model_id, model_provider: model.provider },
            origin,
          },
          modelSelection: {
            modelName: model.local_model_id,
            modelType: 'runtime',
            options: { runnerModelProvider: model.provider },
          },
        },
        uiTimeoutMs
      )
      assert.equal(child.accepted, true)
      await control.command('waitFor', `${CHAT} [data-testid="message-assistant"]`, {
        text: '独立工作的结果已回到',
        timeoutMs: modelResponseTimeoutMs,
      })
      assert.equal(resultDelivered, true)
      assert.equal((await settled(control)).threadId, current.threadId)
      await restartDesktopApp()
      await control.command('clickWhenEnabled', '[data-testid="personal-stand-in-button"]')
      await control.command('waitFor', `${CHAT} [data-testid="message-assistant"]`, {
        text: '后续消息仍在第二段',
        timeoutMs: modelResponseTimeoutMs,
      })
      // Older messages may be virtualized out of the viewport after restart.
      await control.command(
        'scrollToRatioAsUser',
        `${activeChat} [data-testid="right-workspace-chat-scroll-area"]`,
        { value: '0' }
      )
      await control.command('waitFor', `${CHAT} [data-testid="message-assistant"]`, {
        text: '第一段问题已回答',
      })
      const refreshed = await requestExecutor(
        control,
        'runtime.tasks.transcript',
        { taskId: TASK, includeFullContent: true },
        uiTimeoutMs
      )
      assert.ok(JSON.stringify(refreshed.messages).includes('第一段问题已回答'))
      assert.ok(JSON.stringify(refreshed.messages).includes('后续消息仍在第二段'))
      assert.equal(
        (await requestExecutor(control, 'runtime.tasks.get', { taskId: TASK }, uiTimeoutMs)).task
          .threadId,
        current.threadId
      )
    },
    diagnostics() {
      return {
        cleanContextObserved,
        questionCalls,
        asyncQuestionAccepted,
        asyncAnswerObserved,
        resultDelivered,
      }
    },
  }
}
