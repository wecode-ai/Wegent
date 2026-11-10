import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as poll } from 'node:timers/promises'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { rejectModelWebSocketUpgrade } from '../modules/reject-model-upgrade.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
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
import {
  selectE2EModel,
  PROVIDER_SWITCH_OFFICIAL_OPTION_ID,
  PROVIDER_SWITCH_OFFICIAL_LABEL,
} from '../modules/shared.mjs'

const USER = 9001
const TASK = `stand-in-chat-${USER}-primary`
const FIRST = 'STAND_IN_SESSION_FIRST_QUESTION'
const SECOND = 'STAND_IN_SESSION_SECOND_CLEAN_CONTEXT'
const FOLLOWUP = 'STAND_IN_SESSION_FOLLOWUP'
const CHILD = 'STAND_IN_SESSION_CHILD_RESULT'
const SWITCH = 'STAND_IN_SESSION_UI_PROVIDER_SWITCH'
const SWITCH_FOLLOWUP = 'STAND_IN_SESSION_UI_PROVIDER_FOLLOWUP'
const ASYNC_QUESTION = 'STAND_IN_SESSION_ASYNC_QUESTION'
const ASYNC_ANSWER = 'STAND_IN_SESSION_ASYNC_ANSWER'
const ASYNC_COMPLETION = 'STAND_IN_SESSION_ASYNC_ANSWER_ACCEPTED'
const RETRY_PROMPT = 'STAND_IN_SESSION_PROVIDER_RETRY'
const RETRY_FAILURE = 'STAND_IN_SESSION_INTENTIONAL_RETRY_FAILURE'
const RETRY_COMPLETION = 'STAND_IN_SESSION_PROVIDER_RETRY_COMPLETE'
const RETRY_CONTINUATION = 'Continue the unfinished work from the previous turn'
const CHAT = '[data-testid="stand-in-conversation"]'
const SOURCE_MODEL = 'local-model:desktop-e2e-responses'

export function createDesktopScenario({
  workspacePath,
  uiTimeoutMs,
  modelResponseTimeoutMs,
  restartDesktopApp,
}) {
  let cleanContextObserved = false
  let followupObserved = false
  let questionCalls = 0
  let resultDelivered = false
  let providerSwitchObserved = false
  let asyncAnswerObserved = false
  let retryFailureDelivered = false
  let retrySwitchObserved = false

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
    modelProviderId: 'openai',
    modelId: PROVIDER_SWITCH_OFFICIAL_OPTION_ID,
    async prepareApp({ codexHome, executorHome, control }) {
      const configPath = join(codexHome, 'config.toml')
      const config = await readFile(configPath, 'utf8')
      // Keep the real built-in provider identity while mocking only its model service.
      await writeFile(configPath, `openai_base_url = "${control.url}/v1"\n${config}`)
      // The official model must advertise the same non-blocking question tool as
      // the custom provider so the switched session can ask before it settles.
      const capabilities = join(executorHome, 'capabilities')
      await mkdir(capabilities, { recursive: true })
      await writeFile(
        join(capabilities, 'model-catalog-overrides.json'),
        JSON.stringify([
          {
            slug: PROVIDER_SWITCH_OFFICIAL_OPTION_ID,
            fields: { experimental_supported_tools: ['request_user_input_async'] },
          },
        ])
      )
      await rm(join(codexHome, 'models_cache.json'), { force: true })
    },
    attachServer(server) {
      server.on('upgrade', (_request, socket) => rejectModelWebSocketUpgrade(server, socket))
    },
    async handleHttp(req, response, url) {
      if (req.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(req)
      if (isReplyPredictionRequest(body)) return false
      const input = JSON.stringify(body.input ?? [])
      const lastUserText = JSON.stringify(
        (Array.isArray(body.input) ? body.input : [])
          .filter(item => item?.role === 'user')
          .at(-1) ?? ''
      )
      let events
      if (lastUserText.includes(RETRY_CONTINUATION)) {
        assert.notEqual(
          body.model,
          PROVIDER_SWITCH_OFFICIAL_OPTION_ID,
          'The cross-provider retry stayed on the failed thread model'
        )
        retrySwitchObserved = true
        events = [assistantMessage(RETRY_COMPLETION)]
      } else if (lastUserText.includes(RETRY_PROMPT)) {
        assert.equal(retryFailureDelivered, false, 'The retry prompt failed more than once')
        retryFailureDelivered = true
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            error: { type: 'invalid_request_error', message: RETRY_FAILURE },
          })
        )
        return true
      } else if (lastUserText.includes(ASYNC_ANSWER)) {
        assert.equal(
          body.model,
          PROVIDER_SWITCH_OFFICIAL_OPTION_ID,
          'The async answer was routed back to the stale provider'
        )
        asyncAnswerObserved = true
        events = [assistantMessage(ASYNC_COMPLETION)]
      } else if (input.includes(SWITCH_FOLLOWUP)) {
        events = [assistantMessage('切换后的后续消息继续使用同一个执行会话。')]
      } else if (input.includes(SWITCH)) {
        if (toolOutputText(body, 'stand-in-async-question') !== null) {
          events = [assistantMessage('问题已记录，继续当前工作。')]
        } else {
          assert.ok(
            input.includes('untrusted background context'),
            'Provider transitions must bridge readable reference context'
          )
          assert.ok(
            input.includes(SECOND),
            'The previous stand-in conversation must remain available as reference'
          )
          providerSwitchObserved = true
          events = selectedToolCall(
            'stand-in-async-question',
            selectTool(body, 'request_user_input_async', {
              questions: [
                {
                  title: ASYNC_QUESTION,
                  options: ['Wait', ASYNC_ANSWER],
                },
              ],
            })
          )
        }
      } else if (input.includes('Wework delegated task result:')) {
        assert.ok(input.includes(SECOND), 'Work results must wake the current execution session')
        assert.ok(!input.includes(FIRST), 'Work results must not reopen the old execution session')
        resultDelivered = true
        events = [assistantMessage('独立工作的结果已回到同一个分身入口。')]
      } else if (input.includes(CHILD)) {
        events = [assistantMessage('独立工作已完成。')]
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
          events = [assistantMessage('第一段问题已回答，可以继续。')]
        } else {
          questionCalls += 1
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
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },
    async verify(control) {
      await ensureExperimentalFeaturesEnabled(control)
      control.failBlockedCloudModels()
      control.restoreCloudModels()
      await control.command('dispatchLocalModelSettingsChanged', '')
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await control.command('click', '[data-testid="workspace-tab-select-fixed-task"]')
      await control.command('clickWhenEnabled', '[data-testid="personal-stand-in-button"]')
      await control.command('waitFor', CHAT)
      // Use an explicit custom-model identity, independent of native catalog aliases.
      await selectE2EModel(control, SOURCE_MODEL, 'Desktop E2E Responses', CHAT)
      const settings = await requestExecutor(
        control,
        'runtime.stand_in.personal.get',
        { userId: USER },
        uiTimeoutMs
      )
      const catalog = await requestExecutor(control, 'runtime.runner.catalog', {}, uiTimeoutMs)
      const nativeCatalog = await requestExecutor(
        control,
        'runtime.codex.models.list',
        { includeHidden: false },
        uiTimeoutMs
      )
      assert.ok(
        nativeCatalog.providers.some(
          provider => provider.id === 'openai' && provider.type === 'official'
        ),
        'The target must use the built-in official provider, not a custom GPT alias'
      )
      const model = catalog.models.find(
        model => model.runtime === 'codex' && model.local_model_id === SOURCE_MODEL
      )
      assert.ok(model, 'The source must be the explicitly selected custom Responses model')
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
      await control.command(
        'fill',
        `${CHAT} [data-testid="chat-message-input"][contenteditable="true"]`,
        { value: FIRST }
      )
      await control.command('clickWhenEnabled', `${CHAT} [data-testid="send-message-button"]`)
      await control.command('waitFor', '[data-testid="request-user-input-card"]', {
        timeoutMs: modelResponseTimeoutMs,
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
      await control.command('click', '[data-testid="request-user-input-option-session-1"]')
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: '第一段问题已回答',
        timeoutMs: modelResponseTimeoutMs,
      })
      await settled(control)
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
          title: '分身分段后的独立工作',
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
      // The history boundary disappears once automatic pagination finishes.
      // The current session's first request remains a stable user-scroll anchor.
      await control.command('scrollIntoViewAsUser', `${CHAT} [data-testid="message-user"]`, {
        text: SECOND,
      })
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
      assert.equal(current.modelSelection.modelName, SOURCE_MODEL)
      await control.command('focusMainWindow', 'body')
      await control.command(
        'fill',
        `${CHAT} [data-testid="chat-message-input"][contenteditable="true"]`,
        { value: SWITCH }
      )
      await selectE2EModel(
        control,
        PROVIDER_SWITCH_OFFICIAL_OPTION_ID,
        PROVIDER_SWITCH_OFFICIAL_LABEL,
        CHAT,
        'openai'
      )
      await control.command('waitFor', CHAT, { visible: true })
      assert.ok(
        (await control.command('getText', `${CHAT} [data-testid="chat-message-input"]`)).includes(
          SWITCH
        ),
        'Switching providers must preserve the stand-in draft'
      )
      // Fail the work-list refresh that follows the accepted switch so the
      // renderer keeps the previous provider until a later successful refresh.
      await control.command('failLocalExecutorRequests', 'body', {
        value: JSON.stringify({
          method: 'runtime.tasks.list',
          message: 'Desktop E2E intentional work list refresh failure',
        }),
      })
      await control.command('clickWhenEnabled', `${CHAT} [data-testid="send-message-button"]`)
      await control.command('waitFor', `${CHAT} [data-testid="request-user-input-card"]`, {
        text: ASYNC_QUESTION,
        timeoutMs: modelResponseTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="runtime-work-load-status"]', {
        timeoutMs: uiTimeoutMs,
      })
      assert.match(
        await control.command('getText', '[data-testid="runtime-work-load-status"]'),
        /任务刷新失败|Couldn't refresh tasks/,
        'The switched session must keep the stale task list after its refresh fails'
      )
      const switched = await settled(
        control,
        task => task.threadId !== current.threadId && providerSwitchObserved
      )
      assert.equal(switched.taskId, TASK)
      assert.equal(switched.modelSelection.modelName, PROVIDER_SWITCH_OFFICIAL_OPTION_ID)
      await control.command('focusMainWindow', 'body')
      await control.command(
        'click',
        `${CHAT} [data-testid="request-user-input-option-question_1-1"]`
      )
      await control.command('waitFor', `${CHAT} [data-testid="message-assistant"]`, {
        text: ASYNC_COMPLETION,
        timeoutMs: modelResponseTimeoutMs,
      })
      assert.equal(asyncAnswerObserved, true)
      assert.equal((await settled(control)).threadId, switched.threadId)
      await control.command('clearLocalExecutorRequestFailures', 'body')
      await control.command('clickWhenEnabled', '[data-testid="runtime-work-load-retry"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="runtime-work-load-status"]', {
        visible: false,
        timeoutMs: uiTimeoutMs,
      })
      await control.command(
        'fill',
        `${CHAT} [data-testid="chat-message-input"][contenteditable="true"]`,
        { value: SWITCH_FOLLOWUP }
      )
      await control.command('clickWhenEnabled', `${CHAT} [data-testid="send-message-button"]`)
      await control.command('waitFor', `${CHAT} [data-testid="message-assistant"]`, {
        text: '切换后的后续消息',
        timeoutMs: modelResponseTimeoutMs,
      })
      assert.equal((await settled(control)).threadId, switched.threadId)
      await control.command(
        'fill',
        `${CHAT} [data-testid="chat-message-input"][contenteditable="true"]`,
        { value: RETRY_PROMPT }
      )
      await control.command('clickWhenEnabled', `${CHAT} [data-testid="send-message-button"]`)
      await control.command('waitFor', `${CHAT} [data-testid="assistant-error-retry"]`, {
        visible: true,
        timeoutMs: modelResponseTimeoutMs,
      })
      const failed = (
        await requestExecutor(control, 'runtime.tasks.get', { taskId: TASK }, uiTimeoutMs)
      ).task
      assert.equal(failed.threadId, switched.threadId)
      await selectE2EModel(control, SOURCE_MODEL, 'Desktop E2E Responses', CHAT)
      await control.command('focusMainWindow', 'body')
      await control.command('clickWhenEnabled', `${CHAT} [data-testid="assistant-error-retry"]`, {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', `${CHAT} [data-testid="message-assistant"]`, {
        text: RETRY_COMPLETION,
        timeoutMs: modelResponseTimeoutMs,
      })
      const retried = await settled(control)
      assert.equal(retrySwitchObserved, true)
      assert.notEqual(retried.threadId, failed.threadId)
      assert.equal(retried.modelSelection.modelName, SOURCE_MODEL)
      await control.command('waitFor', '[data-testid="personal-stand-in-unread-count"]', {
        visible: false,
        timeoutMs: uiTimeoutMs,
      })
    },
    diagnostics() {
      return {
        cleanContextObserved,
        questionCalls,
        resultDelivered,
        providerSwitchObserved,
        asyncAnswerObserved,
        retryFailureDelivered,
        retrySwitchObserved,
      }
    },
  }
}
