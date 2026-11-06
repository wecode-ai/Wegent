import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createDesktopScenario as createCatalogScenario } from './stand-in-model-catalog.scenario.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { until } from '../modules/plugin-regression-fixture.mjs'
import { reloadMainWindow } from '../modules/workspace-flows.mjs'
import { MODEL_API_KEY } from '../modules/shared.mjs'
import { readMcpToolOutput } from '../modules/mcp-tool-results.mjs'
import {
  assistantMessage,
  createSse,
  delegatedTaskResultEvents,
  mcpToolRequestEvents,
  readRequestBody,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const PANEL = '[data-testid="stand-in-primary-profile"]'
const marker = `STAND_IN_MODEL_EXECUTION_${process.pid}`
const selector = id => `[data-testid=${JSON.stringify(id)}]`

export function executionModelEvents(body, { marker, cases, completed }) {
  const latestUser = (body.input ?? []).filter(item => item.role === 'user').at(-1)
  const message = JSON.stringify(latestUser?.content ?? '')
  const delegatedTaskId = message.match(/Wework delegated task result:.*?taskId=([^,\s]+)/)?.[1]
  const name = delegatedTaskId
    ? [...completed].find(([, taskId]) => taskId === delegatedTaskId)?.[0]
    : [...cases.keys()].find(name =>
        ['CHAT', 'WORK'].some(kind => message.includes(`${marker}_${kind}_${name}`))
      )
  assert.ok(name, 'The model request must identify its own execution case')
  assert.equal(
    body.model,
    cases.get(name).upstream,
    'The selected upstream model must receive the call'
  )
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
    return { name, events: [assistantMessage(`工作已创建：${name}`)] }
  }
  return {
    name,
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
  let userId
  let current
  const executionCases = new Map()
  const completed = new Map()
  const calls = new Map()
  return {
    ...catalog,
    async prepareCloud(cloud) {
      await catalog.prepareCloud(cloud)
      const response = await fetch(`${cloud.backendUrl}/api/users/me`, {
        headers: { Authorization: `Bearer ${cloud.authToken}` },
        signal: AbortSignal.timeout(options.uiTimeoutMs),
      })
      assert.equal(response.ok, true)
      userId = (await response.json()).id
    },
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      const input = JSON.stringify(body.input ?? [])
      if (!current || !input.includes(marker)) return false
      assert.equal(request.headers.authorization, `Bearer ${MODEL_API_KEY}`)
      const { name, events } = executionModelEvents(body, {
        marker,
        cases: executionCases,
        completed,
      })
      calls.set(name, (calls.get(name) ?? 0) + 1)
      const id = `model-execution-${Date.now()}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },
    async verify(control) {
      await catalog.verify(control)
      // The catalog check restores settings through RPC; reload the owner before editing again.
      await reloadMainWindow(control, 'Stand-in settings did not reload after catalog cleanup')
      await control.command('clickWhenEnabled', '[data-testid="personal-stand-in-button"]')
      await control.command('waitFor', '[data-testid="stand-in-overview"]')
      const rpc = (method, params) => requestExecutor(control, method, params, options.uiTimeoutMs)
      const initial = await rpc('runtime.stand_in.personal.get', { userId })
      const native = (await rpc('runtime.runner.catalog', {})).models.find(
        model => model.runtime === 'codex' && model.provider === 'wework-e2e'
      )
      assert.ok(native, 'The isolated custom provider must be selectable')
      const cases = [
        {
          name: 'cloud',
          key: ['codex', 'cloud', 'public', 'default', 0, 'catalog-kimi-public'],
          model: 'catalog-kimi-public',
          upstream: 'kimi-k3',
          type: 'public',
        },
        {
          name: 'custom',
          key: [native.runtime, native.provider, native.model_id],
          model: native.local_model_id,
          upstream: native.local_model_id,
          type: 'runtime',
        },
      ]
      for (const testCase of cases) executionCases.set(testCase.name, testCase)
      try {
        for (const testCase of cases) {
          current = testCase.name
          await control.command('clickWhenEnabled', '[data-testid="stand-in-settings-open"]')
          await control.command('waitFor', PANEL)
          await control.command(
            'clickWhenEnabled',
            `${PANEL} [data-testid="model-selector-button"]`
          )
          const option = selector(`model-option-${JSON.stringify(testCase.key)}`)
          await control.command('waitFor', option)
          await control.command('scrollIntoView', option)
          await control.command('clickWhenEnabled', option)
          await control.command('press', 'body', { key: 'Escape' })
          await control.command('clickWhenEnabled', '[data-testid="stand-in-primary-save"]')
          await control.command('waitFor', PANEL, { visible: false })
          const saved = await rpc('runtime.stand_in.personal.get', { userId })
          assert.equal(
            saved.primary.model.model_id,
            testCase.name === 'cloud' ? 'kimi-k3' : native.model_id
          )
          const address = await rpc('runtime.stand_in.conversation', {
            userId,
            message: `${marker}_CHAT_${current}`,
          })
          await until(
            () => rpc('runtime.tasks.get', { taskId: address.taskId }),
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
            () => rpc('runtime.tasks.transcript', { taskId: address.taskId }),
            result =>
              result.messages.some(
                message =>
                  message.role === 'assistant' &&
                  JSON.stringify(message.content).includes(`${marker}_DONE_${current}`)
              ),
            `Primary stand-in did not report the actual ${current} work result`,
            options.modelResponseTimeoutMs
          )
          assert.ok(
            calls.get(current) >= 3,
            'Both primary conversation and concrete work must reach the authenticated model'
          )
        }
      } finally {
        const latest = await rpc('runtime.stand_in.personal.get', { userId })
        await rpc('runtime.stand_in.personal.save', {
          userId,
          settings: { ...initial, version: latest.version },
        })
      }
    },
    diagnostics() {
      return { current, calls: Object.fromEntries(calls), completed: Object.fromEntries(completed) }
    },
  }
}
