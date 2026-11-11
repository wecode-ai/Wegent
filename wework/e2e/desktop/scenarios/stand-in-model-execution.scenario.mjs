import { openStandInSettings } from '../modules/stand-in-profile-navigation.mjs'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createDesktopScenario as createCatalogScenario } from './stand-in-model-catalog.scenario.mjs'
import { requestExecutor, writeCodexModelConfig } from '../modules/executor-rpc.mjs'
import { completedApiResourceTimings, until } from '../modules/plugin-regression-fixture.mjs'
import { reloadMainWindow } from '../modules/workspace-flows.mjs'
import { TransportFaultProxy } from '../modules/transport-fault-proxy.mjs'
import {
  MODEL_API_KEY,
  RETRY_CONTINUATION_PROMPT as RUNTIME_RETRY_CONTINUATION_PROMPT,
} from '../modules/shared.mjs'
import { readMcpToolOutput } from '../modules/mcp-tool-results.mjs'
import { createSubscriptionConfigRegression } from '../modules/stand-in-subscription-config.mjs'
import {
  assistantMessage,
  createSse,
  delegatedTaskResultEvents,
  handleEmptyReplyPrediction,
  handleModelMaintenanceRequest,
  mcpToolRequestEvents,
  readRequestBody,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
  responseFailed,
} from '../modules/response-protocol.mjs'

const PANEL = '[data-testid="stand-in-primary-profile"]'
const CHAT =
  '[data-workspace-tab-content][aria-hidden="false"] [data-testid="stand-in-conversation"]'
const marker = `STAND_IN_MODEL_EXECUTION_${process.pid}`
const selector = id => `[data-testid=${JSON.stringify(id)}]`
const CLOUD_MODEL = 'catalog-kimi-public'
const INITIAL_LIMITS = { contextWindow: 512_000, maxOutputTokens: 4096 }
const UPDATED_LIMITS = { contextWindow: 768_000, maxOutputTokens: 16_384 }
const OFFICIAL_MODEL = 'gpt-6.1-sol'
const ORDINARY = '[data-workspace-tab-content="fixed-task"] [data-testid="desktop-workbench-main"]'
const RETRY_HISTORY_CALL = 'retry-previous-conversation'

function retryConversationHistory(body, { marker, retryTaskId, retryThreadId }) {
  assert.ok(retryTaskId && retryThreadId, 'Retry must retain its original logical conversation')
  const messages = (body.input ?? []).filter(item => ['user', 'assistant'].includes(item.role))
  const message = messages.filter(item => item.role === 'user').at(-1)
  const text =
    typeof message?.content === 'string'
      ? message.content
      : (message?.content ?? []).map(part => part.text ?? '').join('')
  assert.ok(
    text.includes(`read_task(${JSON.stringify({ taskId: retryTaskId })})`),
    'A new-session retry must identify the exact authorized conversation history'
  )
  assert.equal(
    JSON.stringify(messages).includes(`${marker}_CHAT_`),
    false,
    'Retry must send the continuation prompt rather than replaying the original request'
  )
  assert.equal(
    JSON.stringify(messages).includes(`${marker}_OFFICIAL`),
    false,
    'A cross-provider retry must not copy the previous official native session'
  )
  if (!requestContainsToolOutput(body, RETRY_HISTORY_CALL)) {
    return {
      events: mcpToolRequestEvents(body, {
        toolName: 'read_task',
        directToolName: 'mcp__wework_stand_in__read_task',
        argumentsValue: { taskId: retryTaskId },
        searchCallId: `${RETRY_HISTORY_CALL}-search`,
        toolCallId: RETRY_HISTORY_CALL,
      }).events,
    }
  }
  const history = JSON.parse(readMcpToolOutput(body, RETRY_HISTORY_CALL))
  assert.equal(history.success, true, 'Retry must successfully read real authorized history')
  assert.equal(history.taskId, retryTaskId, 'Retry must read its exact original logical task')
  assert.ok(Array.isArray(history.messages), 'Retry must consume actual conversation messages')
  assert.notEqual(
    history.hasMoreBefore,
    true,
    'The bounded retry fixture history must fit one page'
  )
  assert.ok(
    history.messages.every(message => message.contentComplete !== false),
    'The bounded retry fixture must read complete message content'
  )
  return { messages: history.messages }
}

export function executionModelEvents(body, context) {
  const { marker, cases, completed } = context
  const latestUser = (body.input ?? []).filter(item => item.role === 'user').at(-1)
  const message = JSON.stringify(latestUser?.content ?? '')
  const retry = message.includes(RUNTIME_RETRY_CONTINUATION_PROMPT)
  if (retry)
    assert.ok(
      [...cases.values()].some(testCase => testCase.upstream === body.model),
      'The selected upstream model must receive the call'
    )
  const history = retry ? retryConversationHistory(body, context) : undefined
  const delegatedTaskId = message.match(/Wework delegated task result:.*?taskId=([^,\s]+)/)?.[1]
  const candidates = [...cases.keys()].filter(name =>
    history?.messages?.some(
      item =>
        item.role === 'user' && JSON.stringify(item.content).includes(`${marker}_CHAT_${name}`)
    )
  )
  if (history?.messages)
    assert.equal(candidates.length, 1, 'Read history must identify one unfinished request')
  const name = delegatedTaskId
    ? [...completed].find(([, taskId]) => taskId === delegatedTaskId)?.[0]
    : retry
      ? history.messages
        ? candidates[0]
        : [...cases.keys()].find(name => cases.get(name).upstream === body.model)
      : [...cases.keys()].find(name =>
          ['CHAT', 'WORK'].some(kind => message.includes(`${marker}_${kind}_${name}`))
        )
  assert.ok(name, 'The model request must identify its own execution case')
  assert.equal(
    body.model,
    cases.get(name).upstream,
    'The selected upstream model must receive the call'
  )
  const testCase = cases.get(name)
  const reasoning = message.includes(`${marker}_WORK_${name}`)
    ? testCase.reasoning
    : (testCase.conversationReasoning ?? testCase.reasoning)
  if (reasoning) {
    assert.equal(
      body.reasoning?.effort,
      reasoning,
      'The selected conversation or work reasoning effort must reach the model'
    )
  }
  if (!message.includes(`${marker}_WORK_${name}`) && testCase.conversationLimits) {
    assert.equal(
      body.max_output_tokens,
      testCase.conversationLimits.maxOutputTokens,
      'The refreshed output limit must reach the actual primary model request'
    )
  }
  if (history?.events) return { name, events: history.events }
  let retryEvidence
  if (history) {
    const request = history.messages.find(
      item =>
        item.role === 'user' && JSON.stringify(item.content).includes(`${marker}_CHAT_${name}`)
    )
    const progress = history.messages.find(
      item =>
        item.role === 'assistant' &&
        JSON.stringify(item.content).includes(`${marker}_PROGRESS_${name}`)
    )
    assert.ok(progress, 'Retry must consume the completed progress from the failed native turn')
    assert.ok(request.id && progress.id, 'Retry evidence must identify actual persisted messages')
    assert.equal(
      request.id,
      context.retryMessageIds?.request,
      'Retry must recover the exact request persisted in the failed original session'
    )
    assert.equal(
      progress.id,
      context.retryMessageIds?.progress,
      'Retry must recover the exact completed progress persisted in the failed original session'
    )
    retryEvidence = {
      taskId: context.retryTaskId,
      threadId: context.retryThreadId,
      name,
      requestMessageId: request.id,
      progressMessageId: progress.id,
    }
  }
  const resultEvents = delegatedTaskResultEvents(body)
  if (resultEvents) return { name, events: resultEvents }
  const callId = `create-${name}`
  if (message.includes(`${marker}_WORK_${name}`)) {
    return { name, events: [assistantMessage(`${marker}_DONE_${name}`)] }
  }
  if (requestContainsToolOutput(body, callId)) {
    const result = JSON.parse(readMcpToolOutput(body, callId))
    assert.equal(result.success, true, 'The real primary stand-in must create its work')
    completed.set(name, result.taskId)
    return { name, events: [assistantMessage(`工作已创建：${name}`)], retryEvidence }
  }
  return {
    name,
    retryEvidence,
    events: mcpToolRequestEvents(body, {
      toolName: 'create_task',
      directToolName: 'mcp__wework_stand_in__create_task',
      argumentsValue: {
        requestId: callId,
        title: `模型调用验证 ${name}`,
        message: `${marker}_WORK_${name}`,
      },
      searchCallId: `${callId}-search`,
      toolCallId: callId,
    }).events,
  }
}

// Extend the existing checkpoint without another Backend or Electron lifecycle.
export function createDesktopScenario(options) {
  const catalog = createCatalogScenario(options)
  const subscription = createSubscriptionConfigRegression()
  const appEnvironment = {}
  let cloud, catalogProxy
  let userId
  let current
  const executionCases = new Map()
  const completed = new Map()
  const calls = new Map()
  let officialCalls = 0
  let officialFailures = 0
  let cloudRetryCalls = 0
  let retryTaskId, retryThreadId, retryMessageIds, recoveredHistory
  return {
    ...catalog,
    appEnvironment,
    prepareApp: subscription.prepareApp,
    attachServer: subscription.attachServer,
    async prepareCloud(environment) {
      cloud = environment
      await catalog.prepareCloud(cloud)
      catalogProxy = await new TransportFaultProxy(cloud.backendUrl).start()
      appEnvironment.WEWORK_E2E_CLOUD_BACKEND_URL = catalogProxy.url
      const response = await fetch(`${cloud.backendUrl}/api/users/me`, {
        headers: { Authorization: `Bearer ${cloud.authToken}` },
        signal: AbortSignal.timeout(options.uiTimeoutMs),
      })
      assert.equal(response.ok, true)
      userId = (await response.json()).id
      const model = (await cloudRequest(cloud, '/api/admin/public-models?limit=1000')).items.find(
        item => item.name === CLOUD_MODEL
      )
      assert.ok(model)
      await cloudRequest(cloud, `/api/admin/public-models/${model.id}`, 'PUT', {
        json: withModelLimits(model.json, INITIAL_LIMITS),
      })
    },
    async handleHttp(request, response, url) {
      if (
        request.method !== 'POST' ||
        !['/responses', '/v1/responses', '/backend-api/codex/responses'].includes(url.pathname)
      )
        return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      if (handleModelMaintenanceRequest(body, response)) return true
      if (subscription.acceptsModelRequest(request, url, body)) {
        const latestUser = (body.input ?? []).filter(item => item.role === 'user').at(-1)
        const message = JSON.stringify(latestUser?.content ?? '')
        const fail = message.includes(`${marker}_CHAT_cloud`)
        assert.ok(
          message.includes(`${marker}_OFFICIAL`) || (fail && current === undefined),
          'A cloud or custom conversation must never fall back to the previous official provider'
        )
        officialCalls += 1
        const id = `official-model-execution-${officialCalls}`
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
        if (fail) {
          officialFailures += 1
          assert.equal(officialFailures, 1, 'Only one extra official model turn may fail')
          const progress = assistantMessage(`${marker}_PROGRESS_cloud`)
          progress.item.phase = 'commentary'
          response.end(
            createSse([
              responseCreated(id),
              progress,
              responseFailed(id, `${marker}_OFFICIAL_FAILED`),
            ])
          )
          return true
        }
        response.end(
          createSse([
            responseCreated(id),
            assistantMessage(`${marker}_OFFICIAL_DONE`),
            responseCompleted(id),
          ])
        )
        return true
      }
      const input = JSON.stringify(body.input ?? [])
      const latestUser = (body.input ?? []).filter(item => item.role === 'user').at(-1)
      const retry = JSON.stringify(latestUser?.content ?? '').includes(
        RUNTIME_RETRY_CONTINUATION_PROMPT
      )
      if (!current || (!input.includes(marker) && !(current === 'cloud' && retry))) return false
      assert.equal(request.headers.authorization, `Bearer ${MODEL_API_KEY}`)
      const { name, events, retryEvidence } = executionModelEvents(body, {
        marker,
        cases: executionCases,
        completed,
        retryTaskId,
        retryThreadId,
        retryMessageIds,
      })
      if (retryEvidence) recoveredHistory = retryEvidence
      calls.set(name, (calls.get(name) ?? 0) + 1)
      if (name === 'cloud' && retry) cloudRetryCalls += 1
      const id = `model-execution-${Date.now()}`
      const completedResponse = responseCompleted(id)
      if (name === 'cloud') {
        completedResponse.response.usage = {
          ...completedResponse.response.usage,
          input_tokens: 32,
          output_tokens: 16,
          total_tokens: 48,
        }
      }
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), ...events, completedResponse]))
      return true
    },
    async verify(control) {
      await catalog.verify(control)
      const rpc = (method, params) => requestExecutor(control, method, params, options.uiTimeoutMs)
      const initial = await rpc('runtime.stand_in.personal.get', { userId })
      const primaryTaskId = `stand-in-chat-${userId}-primary`
      let primaryThreadId
      const nativeModels = (await rpc('runtime.runner.catalog', {})).models
      const native = nativeModels.find(
        model =>
          model.runtime === 'codex' &&
          model.provider === 'wework-e2e' &&
          model.supported_reasoning_efforts?.includes('high')
      )
      assert.ok(native, 'The isolated custom provider must have a selectable model supporting high')
      const previousConfig = await rpc('runtime.codex.app_server.request', {
        method: 'config/read',
        params: { includeLayers: false, cwd: null },
      })
      assert.equal(typeof previousConfig.config.model, 'string')
      const setCatalogProvider = (provider, model = previousConfig.config.model) =>
        writeCodexModelConfig(control, { provider, model }, options.uiTimeoutMs)
      const cases = [
        {
          name: 'cloud',
          key: ['codex', 'cloud', 'public', 'default', 0, CLOUD_MODEL],
          model: CLOUD_MODEL,
          upstream: 'kimi-k3',
          type: 'public',
        },
        {
          name: 'custom',
          key: [native.runtime, native.provider, native.model_id],
          model: native.local_model_id,
          upstream: native.local_model_id,
          type: 'runtime',
          reasoning: 'high',
        },
      ]
      for (const testCase of cases) executionCases.set(testCase.name, testCase)
      try {
        // Reuse the existing owner reload after both catalog cleanup and the
        // public legacy-profile setup, so the UI edits the current saved version.
        await rpc('runtime.stand_in.personal.save', {
          userId,
          settings: initial.primary
            ? {
                ...initial,
                primary: { ...initial.primary, model: null, modelOptions: {} },
              }
            : initial,
        })
        await reloadMainWindow(control, 'Stand-in settings did not reload after catalog cleanup')
        await control.command('clickWhenEnabled', '[data-testid="workspace-tab-select-fixed-task"]')
        await control.command('waitFor', ORDINARY)
        await openExplicitModelMenu(control, `${ORDINARY} [data-testid="model-selector-button"]`)
        await control.command(
          'waitFor',
          '[data-testid="model-selector-menu"] [data-testid^="model-option-"][aria-checked="true"]'
        )
        await control.command('press', 'body', { key: 'Escape' })
        const ordinary = {
          model: await control.command(
            'getText',
            `${ORDINARY} [data-testid="model-selector-button"]`
          ),
          draft: await control.command('getText', `${ORDINARY} [data-testid="chat-message-input"]`),
        }
        // The native catalog has one configured provider, so establish the real
        // official identity before creating its persistent conversation session.
        await setCatalogProvider('openai', OFFICIAL_MODEL)
        const official = (await rpc('runtime.runner.catalog', {})).models.find(
          model =>
            model.runtime === 'codex' &&
            model.provider === 'openai' &&
            model.model_id === OFFICIAL_MODEL
        )
        assert.ok(official, 'The subscription must expose the real official runner catalog')
        // No options means the real default-provider thread has no saved identity.
        const officialAddress = await rpc('runtime.stand_in.conversation', {
          userId,
          message: `${marker}_OFFICIAL`,
        })
        assert.equal(officialAddress.taskId, primaryTaskId)
        const { task: officialTask } = await until(
          () => rpc('runtime.tasks.get', { taskId: primaryTaskId }),
          result => {
            assert.notEqual(result.task?.status, 'failed', JSON.stringify(result))
            return (
              result.task?.status === 'done' && result.task.running !== true && officialCalls > 0
            )
          },
          'The primary conversation did not establish a real official-provider thread',
          options.modelResponseTimeoutMs
        )
        assert.equal(officialCalls, 1)
        assert.equal(officialTask.modelSelection, null)
        assert.equal(officialTask.runtimeHandle.modelSelection ?? null, null)
        assert.equal(officialTask.runtimeHandle.activeModelProvider ?? null, null)
        assert.ok(officialTask.threadId)
        primaryThreadId = officialTask.threadId
        retryTaskId = primaryTaskId
        retryThreadId = primaryThreadId
        await rpc('runtime.stand_in.conversation', {
          userId,
          message: `${marker}_CHAT_cloud`,
        })
        const { task: failed } = await until(
          () => rpc('runtime.tasks.get', { taskId: primaryTaskId }),
          result => result.task?.status === 'failed' && result.task.running !== true,
          'The official model did not expose its single real failed turn',
          options.modelResponseTimeoutMs
        )
        assert.equal(officialCalls, 2)
        assert.equal(officialFailures, 1)
        assert.equal(failed.threadId, primaryThreadId)
        assert.equal(failed.modelSelection, null)
        assert.equal(failed.runtimeHandle.activeModelProvider ?? null, null)
        const failedHistory = await rpc('runtime.tasks.transcript', {
          taskId: primaryTaskId,
          limit: 100,
          includeFullContent: true,
        })
        retryMessageIds = {}
        for (const [role, content] of [
          ['user', `${marker}_CHAT_cloud`],
          ['assistant', `${marker}_PROGRESS_cloud`],
        ]) {
          const message = failedHistory.messages.find(
            message =>
              message.role === role &&
              message.sessionThreadId === primaryThreadId &&
              JSON.stringify(message.content).includes(content)
          )
          assert.ok(
            message?.id,
            'The failed original native turn must persist its actual request and progress'
          )
          retryMessageIds[role === 'user' ? 'request' : 'progress'] = message.id
        }
        await control.command('clickWhenEnabled', '[data-testid="personal-stand-in-button"]')
        await control.command('waitFor', CHAT)
        const { task: resolved } = await until(
          () => rpc('runtime.tasks.get', { taskId: primaryTaskId }),
          result => result.task?.runtimeHandle.activeModelProvider?.threadId === primaryThreadId,
          'Opening the same legacy chat must resolve its provider through the owning Runtime'
        )
        assert.deepEqual(resolved.runtimeHandle.activeModelProvider, {
          threadId: primaryThreadId,
          provider: 'openai',
        })
        assert.equal(resolved.modelSelection, null)
        await control.command('waitFor', `${CHAT} [data-testid="assistant-error-retry"]`)
        for (const testCase of cases) {
          current = testCase.name
          await openStandInSettings(control)
          await control.command('waitFor', PANEL)
          await openExplicitModelMenu(control, `${PANEL} [data-testid="model-selector-button"]`)
          const option = selector(`model-option-${JSON.stringify(testCase.key)}`)
          await control.command('waitFor', option)
          await control.command('scrollIntoView', option)
          await control.command('clickWhenEnabled', option)
          if (testCase.reasoning) {
            await control.command(
              'clickWhenEnabled',
              selector(`model-control-reasoning-${testCase.reasoning}`)
            )
          }
          await control.command('press', 'body', { key: 'Escape' })
          const configuredLabel = (
            await control.command('getText', `${PANEL} [data-testid="model-selector-button"]`)
          ).trim()
          await control.command('clickWhenEnabled', '[data-testid="stand-in-primary-save"]')
          await control.command('waitFor', PANEL, { visible: false })
          const saved = await rpc('runtime.stand_in.personal.get', { userId })
          assert.equal(
            saved.primary.model.model_id,
            testCase.name === 'cloud' ? 'kimi-k3' : native.model_id
          )
          if (testCase.reasoning) {
            assert.equal(saved.primary.modelOptions.reasoning, testCase.reasoning)
          }
          await control.command('waitFor', `${CHAT} [data-testid="model-selector-button"]`, {
            text: configuredLabel,
          })
          if (testCase.reasoning) {
            assert.ok(configuredLabel.includes('高'), 'The saved native model must display High')
          }
          if (testCase.name === 'cloud') {
            const draft = `${marker}_CHAT_cloud`
            const trigger = `${CHAT} [data-testid="model-selector-button"]`
            await control.command('fill', `${CHAT} [data-testid="chat-message-input"]`, {
              value: draft,
            })
            await openExplicitModelMenu(control, trigger)
            await control.command(
              'clickWhenEnabled',
              selector(`model-option-${official.local_model_id}`)
            )
            await control.command('press', 'body', { key: 'Escape' })
            // Change the real native configuration rather than substituting a
            // directory response. The old provider identity leaves the catalog
            // even though another provider still offers the same model name.
            await setCatalogProvider(native.provider)
            const shifted = (await rpc('runtime.runner.catalog', {})).models
            assert.equal(
              shifted.some(model => model.runtime === 'codex' && model.provider === 'openai'),
              false,
              'The previous official identity must leave the real native catalog'
            )
            assert.ok(
              shifted.some(
                model =>
                  model.runtime === 'codex' &&
                  model.provider === native.provider &&
                  model.model_id === official.model_id
              ),
              'The same model name must remain available under the new provider identity'
            )
            await openExplicitModelMenu(control, trigger)
            const nativeOption = selector(`model-option-${official.local_model_id}`)
            await control.command(
              'waitFor',
              `${nativeOption}[data-model-provider-id="${native.provider}"]`
            )
            await control.command('waitFor', `${nativeOption}[data-model-provider-id="openai"]`, {
              visible: false,
            })
            await control.command('waitFor', `${CHAT} [data-testid="send-message-button"]:disabled`)
            const previous = (await rpc('runtime.tasks.get', { taskId: primaryTaskId })).task
            assert.equal(previous.threadId, primaryThreadId)
            assert.equal(previous.modelSelection, null)
            assert.deepEqual(previous.runtimeHandle.activeModelProvider, {
              threadId: primaryThreadId,
              provider: 'openai',
            })
            await control.command('clickWhenEnabled', selector(`model-option-${testCase.model}`))
            await control.command('waitFor', '[data-testid="model-switch-warning-dialog"]', {
              text: '下一条消息将在这里开启新会话',
            })
            await control.command(
              'clickWhenEnabled',
              '[data-testid="model-switch-warning-confirm-button"]'
            )
            await control.command('waitFor', '[data-testid="model-switch-warning-dialog"]', {
              visible: false,
            })
            await control.command('waitFor', CHAT)
            assert.equal(
              (
                await control.command('getText', `${CHAT} [data-testid="chat-message-input"]`)
              ).trim(),
              draft
            )
            assert.deepEqual(
              (await rpc('runtime.stand_in.personal.get', { userId })).primary,
              saved.primary
            )
            const refreshed = await verifyCloudModelRecovery({
              control,
              cloud,
              catalogProxy,
              rpc,
              userId,
              modelName: testCase.model,
              reasoning: saved.primary.modelOptions?.reasoning === 'high' ? 'low' : 'high',
            })
            testCase.conversationReasoning = refreshed.reasoning
            testCase.conversationLimits = refreshed.limits
          }
          await control.command(
            'fill',
            `${CHAT} [data-testid="chat-message-input"][contenteditable="true"]`,
            { value: `${marker}_CHAT_${current}` }
          )
          await control.command(
            'clickWhenEnabled',
            `${CHAT} [data-testid="${current === 'cloud' ? 'assistant-error-retry' : 'send-message-button'}"]`
          )
          if (current === 'cloud') {
            await until(
              () => cloudRetryCalls,
              count => count > 0,
              'The failed official turn was not retried through the selected cloud model',
              options.modelResponseTimeoutMs
            )
          }
          await until(
            () => rpc('runtime.tasks.get', { taskId: primaryTaskId }),
            result => {
              assert.notEqual(result.task?.status, 'failed', JSON.stringify(result))
              return result.task?.status === 'done' && completed.has(current)
            },
            `Primary stand-in did not call ${current}`,
            options.modelResponseTimeoutMs
          )
          const { task } = await until(
            () => rpc('runtime.tasks.get', { taskId: completed.get(current) }),
            result => {
              assert.notEqual(result.task?.status, 'failed', JSON.stringify(result))
              return result.task?.status === 'done'
            },
            `Concrete work did not call ${current}`,
            options.modelResponseTimeoutMs
          )
          assert.equal(task.runtimeHandle.modelSelection.modelName, testCase.model)
          assert.equal(task.runtimeHandle.modelSelection.modelType, testCase.type)
          if (testCase.reasoning) {
            assert.equal(task.runtimeHandle.modelSelection.options.reasoning, testCase.reasoning)
          }
          if (current === 'custom') {
            const log = await readFile(join(options.resultDir, 'executor.log'), 'utf8')
            assert.ok(
              log
                .split('\n')
                .some(line =>
                  line.includes(
                    `task_id=${task.taskId} route=local_proxy_user_provider provider=${native.provider}`
                  )
                ),
              'Concrete work must resolve custom provider authentication through the native adapter'
            )
          }
          const transcript = await rpc('runtime.tasks.transcript', { taskId: task.taskId })
          assert.ok(JSON.stringify(transcript).includes(`${marker}_DONE_${current}`))
          await until(
            () => rpc('runtime.tasks.transcript', { taskId: primaryTaskId }),
            result =>
              result.messages.some(
                message =>
                  message.role === 'assistant' &&
                  JSON.stringify(message.content).includes(`${marker}_DONE_${current}`)
              ),
            `Primary stand-in did not report the actual ${current} work result`,
            options.modelResponseTimeoutMs
          )
          const { task: primary } = await until(
            () => rpc('runtime.tasks.get', { taskId: primaryTaskId }),
            result => {
              assert.notEqual(result.task?.status, 'failed', JSON.stringify(result))
              return result.task?.status === 'done' && result.task.running !== true
            },
            `Primary stand-in did not settle after reporting ${current}`,
            options.modelResponseTimeoutMs
          )
          assert.equal(primary.taskId, primaryTaskId)
          assert.ok(primary.threadId, 'The primary conversation must retain its native session')
          if (testCase.name === 'cloud') {
            assert.notEqual(
              primary.threadId,
              primaryThreadId,
              'A cross-provider retry must create a new native session in the same stand-in'
            )
            assert.ok(cloudRetryCalls > 0, 'UI retry must reach the selected cloud model')
            assert.equal(recoveredHistory?.taskId, primaryTaskId)
            assert.equal(recoveredHistory?.threadId, primaryThreadId)
            assert.equal(recoveredHistory?.name, 'cloud')
            assert.deepEqual(primary.runtimeHandle.origin, officialTask.runtimeHandle.origin)
            assert.equal(primary.workspacePath, officialTask.workspacePath)
            const rebound = await rpc('runtime.tasks.get', {
              taskId: primaryTaskId,
              resolveActiveProvider: true,
            })
            const activeProvider = rebound.task.runtimeHandle.activeModelProvider
            assert.equal(activeProvider.threadId, primary.threadId)
            assert.ok(activeProvider.provider)
            assert.notEqual(
              activeProvider.provider,
              'openai',
              'The new native thread must not reuse cached official-provider metadata'
            )
            assert.equal(
              (
                await control.command('getText', `${CHAT} [data-testid="chat-message-input"]`)
              ).trim(),
              `${marker}_CHAT_cloud`,
              'Retry must preserve the unsent draft in the original conversation'
            )
            const history = await rpc('runtime.tasks.transcript', {
              taskId: primaryTaskId,
              limit: 100,
              includeFullContent: true,
            })
            assert.ok(
              history.messages.some(
                message =>
                  message.sessionThreadId === primaryThreadId &&
                  JSON.stringify(message.content).includes(`${marker}_OFFICIAL_DONE`)
              ),
              'The previous official session must remain in the persistent conversation history'
            )
            assert.deepEqual(
              (await rpc('runtime.stand_in.personal.get', { userId })).primary,
              saved.primary
            )
            await control.command(
              'clickWhenEnabled',
              '[data-testid="workspace-tab-select-fixed-task"]'
            )
            await control.command('waitFor', ORDINARY)
            assert.equal(
              await control.command('getText', `${ORDINARY} [data-testid="model-selector-button"]`),
              ordinary.model
            )
            assert.equal(
              await control.command('getText', `${ORDINARY} [data-testid="chat-message-input"]`),
              ordinary.draft
            )
            await control.command('clickWhenEnabled', '[data-testid="personal-stand-in-button"]')
            await control.command('waitFor', CHAT)
          } else if (primaryThreadId) {
            assert.equal(
              primary.threadId,
              primaryThreadId,
              'Saving another model must continue the existing primary conversation session'
            )
          }
          primaryThreadId = primary.threadId
          assert.equal(primary.runtimeHandle.modelSelection.modelName, testCase.model)
          assert.equal(primary.runtimeHandle.modelSelection.modelType, testCase.type)
          const conversationReasoning = testCase.conversationReasoning ?? testCase.reasoning
          if (conversationReasoning) {
            assert.equal(
              primary.runtimeHandle.modelSelection.options.reasoning,
              conversationReasoning
            )
          }
          if (testCase.conversationLimits) {
            const selected = primary.runtimeHandle.modelSelection.options
            assert.equal(
              selected.weworkCloudModelContextWindow,
              String(UPDATED_LIMITS.contextWindow)
            )
            assert.equal(
              selected.weworkCloudModelMaxOutputTokens,
              String(UPDATED_LIMITS.maxOutputTokens)
            )
            const consumed = await until(
              async () =>
                (await rpc('runtime.tasks.transcript', { taskId: primaryTaskId })).contextUsage
                  ?.modelContextWindow,
              window =>
                Number.isInteger(window) &&
                window > INITIAL_LIMITS.contextWindow &&
                window <= UPDATED_LIMITS.contextWindow,
              'The native context usage did not reflect the refreshed cloud model window'
            )
            assert.ok(
              Number.isInteger(consumed) &&
                consumed > INITIAL_LIMITS.contextWindow &&
                consumed <= UPDATED_LIMITS.contextWindow,
              `Native Codex must use the expanded context budget within the new limit: ${consumed}`
            )
          }
          assert.ok(
            calls.get(current) >= 3,
            'Both primary conversation and concrete work must reach the authenticated model'
          )
        }
      } finally {
        try {
          await setCatalogProvider(native.provider)
          const restored = (await rpc('runtime.runner.catalog', {})).models
          assert.ok(
            restored.some(
              model =>
                model.runtime === native.runtime &&
                model.provider === native.provider &&
                model.model_id === native.model_id
            ),
            'Cleanup must restore the original native provider configuration and directory'
          )
        } finally {
          const latest = await rpc('runtime.stand_in.personal.get', { userId })
          await rpc('runtime.stand_in.personal.save', {
            userId,
            settings: { ...initial, version: latest.version },
          })
        }
      }
    },
    diagnostics() {
      return {
        current,
        officialCalls,
        officialFailures,
        cloudRetryCalls,
        recoveredHistory,
        calls: Object.fromEntries(calls),
        completed: Object.fromEntries(completed),
        catalogRequests: catalogProxy?.requests,
      }
    },
    async cleanup() {
      try {
        await catalogProxy?.stop()
      } finally {
        try {
          await subscription.cleanup()
        } finally {
          await catalog.cleanup()
        }
      }
    },
  }
}

async function openExplicitModelMenu(control, trigger) {
  const menu = '[data-testid="model-selector-menu"]'
  await control.command('clickWhenEnabled', trigger)
  await control.command('waitFor', menu)
  if ((await control.command('getAttribute', menu, { value: 'data-panel' })) === 'simple') {
    await control.command('clickWhenEnabled', '[data-testid="model-advanced-toggle"]')
  }
  await control.command('waitFor', `${menu}[data-panel="advanced"]`)
}

async function cloudRequest(cloud, path, method = 'GET', body) {
  const response = await fetch(`${cloud.backendUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${cloud.authToken}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(10_000),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  assert.ok(response.ok, `${method} ${path}: HTTP ${response.status}`)
  return response.json()
}

function withModelLimits(modelJson, limits) {
  return {
    ...modelJson,
    spec: {
      ...modelJson.spec,
      modelConfig: {
        ...modelJson.spec.modelConfig,
        context_window: limits.contextWindow,
        max_output_tokens: limits.maxOutputTokens,
      },
    },
  }
}

async function waitForDeliveredCloudCatalog(control, catalogProxy, requestStart = 0) {
  return until(
    async () => {
      const timings = await completedApiResourceTimings(control, '/api/models/unified')
      const request = catalogProxy.requests
        .slice(requestStart)
        .filter(entry => entry.method === 'GET' && entry.path === '/api/models/unified')
        .at(-1)
      if (!request?.responseCompleted || request.status !== 200) return null
      const receivedAt = Date.parse(request.receivedAt)
      return timings.some(
        timing =>
          Math.floor(timing.startedAt) <= receivedAt && Math.ceil(timing.completedAt) >= receivedAt
      )
        ? request
        : null
    },
    request => Boolean(request),
    'The previous cloud catalog request did not finish in the renderer'
  )
}

/** Refresh real Backend bytes in the mounted chat without another model turn or app lifecycle. */
async function verifyCloudModelRecovery({
  control,
  cloud,
  catalogProxy,
  rpc,
  userId,
  modelName,
  reasoning,
}) {
  const request = (path, method, body) => cloudRequest(cloud, path, method, body)
  const model = (await request('/api/admin/public-models?limit=1000')).items.find(
    item => item.name === modelName
  )
  assert.ok(model, 'The saved model must be the real isolated Backend fixture')
  assert.equal(model.is_active, true)
  const update = active =>
    request(`/api/admin/public-models/${model.id}`, 'PUT', { is_active: active })
  const trigger = `${CHAT} [data-testid="model-selector-button"]`
  const submit = `${CHAT} [data-testid="send-message-button"]`
  const editor = `${CHAT} [data-testid="chat-message-input"][contenteditable="true"]`
  const draft = `${marker}_CHAT_cloud`
  const requestStart = catalogProxy.requests.length
  const previousRule = catalogProxy.rule
  try {
    await control.command('fill', editor, { value: draft })
    // A visible cached option does not prove the settings picker's refresh has settled.
    await waitForDeliveredCloudCatalog(control, catalogProxy)
    const disabledRequestStart = catalogProxy.requests.length
    await update(false)
    await control.command('clickWhenEnabled', trigger)
    await waitForDeliveredCloudCatalog(control, catalogProxy, disabledRequestStart)
    await control.command('waitFor', selector(`model-option-${modelName}`), { visible: false })
    await control.command('waitFor', `${submit}:disabled`)
    await control.command('press', 'body', { key: 'Escape' })
    await update(true)
    catalogProxy.rule = entry =>
      entry.method === 'GET' && entry.path === '/api/models/unified'
        ? 'hold-response'
        : previousRule(entry)
    await control.command('clickWhenEnabled', trigger)
    const held = await until(
      () => catalogProxy.requests.slice(requestStart).find(entry => entry.committedResponseHeld),
      entry => Boolean(entry),
      'Opening the stand-in model menu did not refresh the real cloud catalog'
    )
    assert.equal(held.status, 200)
    await control.command('waitFor', `${submit}:disabled`)
    await control.command('waitFor', trigger, { enabled: true })
    assert.equal(
      held.released,
      undefined,
      'The catalog response must remain blocked until asserted'
    )
    await control.command('clickWhenEnabled', selector(`model-control-reasoning-${reasoning}`))
    await control.command('waitFor', `${submit}:disabled`)
    assert.equal(held.released, undefined, 'Editing options must not release the catalog barrier')
    catalogProxy.rule = previousRule
    assert.equal(await held.release(), true, 'The original Backend response must be delivered')
    await control.command('waitFor', submit, { enabled: true })
    await control.command('press', 'body', { key: 'Escape' })
    assert.equal((await control.command('getText', editor)).trim(), draft)
    const saved = await rpc('runtime.stand_in.personal.get', { userId })
    assert.equal(saved.primary.model.cloud_model.name, modelName)
    // Select the loaded model explicitly before its same-identity metadata changes.
    await openExplicitModelMenu(control, trigger)
    await control.command('clickWhenEnabled', selector(`model-option-${modelName}`))
    await control.command('press', 'body', { key: 'Escape' })
    await waitForDeliveredCloudCatalog(control, catalogProxy)
    const updatedLabel = `${model.json.metadata.displayName} · updated limits`
    const updated = withModelLimits(model.json, UPDATED_LIMITS)
    updated.metadata = { ...updated.metadata, displayName: updatedLabel }
    await request(`/api/admin/public-models/${model.id}`, 'PUT', { json: updated })
    const updatedRequestStart = catalogProxy.requests.length
    await control.command('clickWhenEnabled', trigger)
    await waitForDeliveredCloudCatalog(control, catalogProxy, updatedRequestStart)
    await control.command('press', 'body', { key: 'Escape' })
    await control.command('waitFor', trigger, { text: updatedLabel })
    await control.command('waitFor', submit, { enabled: true })
    return { reasoning, limits: UPDATED_LIMITS }
  } finally {
    catalogProxy.rule = previousRule
    await Promise.all(
      catalogProxy.requests
        .slice(requestStart)
        .filter(entry => entry.committedResponseHeld && !entry.released)
        .map(entry => entry.release())
    )
    await update(model.is_active)
  }
}
