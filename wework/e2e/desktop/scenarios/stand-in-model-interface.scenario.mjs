import { openStandInSettings } from '../modules/stand-in-profile-navigation.mjs'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createDesktopScenario as createExistingScenario } from './stand-in-model-execution.scenario.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { until } from '../modules/plugin-regression-fixture.mjs'
import { MODEL_API_KEY } from '../modules/shared.mjs'
import { readMcpToolOutput } from '../modules/mcp-tool-results.mjs'
import { nativeApprovalModelResponse } from '../modules/native-approval-model.mjs'
import { reloadMainWindow } from '../modules/workspace-flows.mjs'
import {
  assistantMessage,
  codexRequestKind,
  codexRequestMetadata,
  createSse,
  delegatedTaskResultEvents,
  handleEmptyReplyPrediction,
  handleModelMaintenanceRequest,
  mcpToolRequestEvents,
  readRequestBody,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const CHAT = 'STAND_IN_MODEL_INTERFACE_CHAT'
const WORK = 'STAND_IN_MODEL_INTERFACE_WORK'
const DONE = 'STAND_IN_MODEL_INTERFACE_DONE'
const RESUME_CHAT = 'STAND_IN_MODEL_INTERFACE_CHAT_RESUME'
const RESUME_WORK = 'STAND_IN_MODEL_INTERFACE_WORK_RESUME'
const RESUMED = 'STAND_IN_MODEL_INTERFACE_RESUMED'
const MODEL = 'stand-in-interface-upstream'
const selector = id => `[data-testid=${JSON.stringify(id)}]`

/** Extend the CI-owned model checkpoint using its existing desktop and Backend lifecycle. */
export function createDesktopScenario(options) {
  const existing = createExistingScenario(options)
  let userId
  let concreteTaskId
  let primaryTaskId
  let primaryAddressReady
  let resolvePrimaryAddress
  let modelCalls = 0
  const interfaceRequests = []
  return {
    ...existing,
    async prepareCloud(cloud) {
      await existing.prepareCloud(cloud)
      const response = await fetch(`${cloud.backendUrl}/api/users/me`, {
        headers: { Authorization: `Bearer ${cloud.authToken}` },
      })
      assert.ok(response.ok)
      userId = (await response.json()).id
    },
    async prepareApp(environment) {
      await existing.prepareApp?.(environment)
      const directory = join(options.electronUserDataDirectory, 'model-connections')
      await mkdir(directory, { recursive: true })
      await writeFile(
        join(directory, 'model.yml'),
        JSON.stringify({
          version: 1,
          providers: [
            {
              id: 'stand-in-interface',
              name: 'Stand-in model interface',
              base_url: `http://127.0.0.1:${process.env.WEWORK_E2E_MODEL_SERVER_PORT}`,
              api_format: 'openai-responses',
              request_path: '/v1/story-model/responses',
              api_key: MODEL_API_KEY,
              models: [
                {
                  id: 'stand-in-interface',
                  model_id: MODEL,
                  display_name: 'Stand-in model interface',
                  tool_profile: 'function',
                  codex_catalog_model_id: 'wework-gpt-6.1-sol',
                  codex_tool_compatibility: 'standard',
                },
              ],
            },
          ],
        }),
        { mode: 0o600 }
      )
    },
    async handleHttp(request, response, url) {
      if (url.pathname !== '/v1/story-model/responses')
        return existing.handleHttp(request, response, url)
      const body = await readRequestBody(request)
      assert.equal(request.headers.authorization, `Bearer ${MODEL_API_KEY}`)
      assert.equal(body.model, MODEL)
      const latestUser = (Array.isArray(body.input) ? body.input : [])
        .filter(item => item.role === 'user')
        .at(-1)
      const latestText = JSON.stringify(latestUser ?? '')
      interfaceRequests.push({
        kind: codexRequestKind(body),
        source: codexRequestMetadata(body)?.thread_source ?? null,
        toolCount: body.tools?.length ?? 0,
        tools: (body.tools ?? []).slice(0, 32).map(tool => ({ type: tool.type, name: tool.name })),
        latestUserHasWork: latestText.includes(WORK),
        latestUserHasChat: latestText.includes(CHAT),
      })
      if (interfaceRequests.length > 20) interfaceRequests.shift()
      const approval = await nativeApprovalModelResponse(body, existing)
      if (approval !== null) {
        const id = `interface-approval-${Date.now()}`
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
        response.end(
          createSse([responseCreated(id), assistantMessage(approval), responseCompleted(id)])
        )
        return true
      }
      if (handleModelMaintenanceRequest(body, response)) return true
      if (handleEmptyReplyPrediction(body, response)) return true
      const resultEvents = delegatedTaskResultEvents(body)
      if (resultEvents) {
        const id = `interface-result-${Date.now()}`
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
        response.end(createSse([responseCreated(id), ...resultEvents, responseCompleted(id)]))
        return true
      }
      modelCalls++
      const input = JSON.stringify(body.input ?? [])
      // Tool output may quote primary chat markers; it cannot change the acting task.
      const latestUserInput = latestText
      const worker = latestUserInput.includes(WORK)
      if (!worker && (input.includes(CHAT) || input.includes(RESUME_CHAT))) {
        assert.ok(
          JSON.stringify(body).includes(
            'Attempt missing data-source connections with connect_source'
          ),
          'Identity creation and continuation must include host-owned source discovery instructions'
        )
      }
      let events
      if (worker) {
        assert.ok(input.includes(WORK))
        await primaryAddressReady
        assert.ok(primaryTaskId, 'The worker must read the real primary conversation address')
        const resumed = latestUserInput.includes(RESUME_WORK)
        const phase = resumed ? 'resume' : 'initial'
        const listCallId = `interface-worker-${phase}-list`
        const readCallId = `interface-worker-${phase}-read`
        if (requestContainsToolOutput(body, readCallId)) {
          const history = JSON.parse(readMcpToolOutput(body, readCallId))
          assert.equal(history.taskId, primaryTaskId)
          assert.ok(
            JSON.stringify(history.messages).includes(resumed ? RESUME_CHAT : CHAT),
            'The delegated worker must read actual primary chat evidence before completing'
          )
          events = [assistantMessage(resumed ? RESUMED : DONE)]
        } else {
          const listed = requestContainsToolOutput(body, listCallId)
          if (listed) {
            const result = JSON.parse(readMcpToolOutput(body, listCallId))
            const primary = result.items.find(item => item.taskId === primaryTaskId)
            assert.ok(primary, 'General history discovery must include the primary identity')
            assert.equal(primary.kind, 'identity')
            assert.equal(primary.canContinue, false)
          }
          const toolName = listed ? 'read_task' : 'list_tasks'
          events = mcpToolRequestEvents(body, {
            toolName,
            directToolName: `mcp__wework_stand_in__${toolName}`,
            argumentsValue: listed ? { taskId: primaryTaskId } : { limit: 50 },
            searchCallId: `${listed ? readCallId : listCallId}-search`,
            toolCallId: listed ? readCallId : listCallId,
          }).events
        }
      } else if (input.includes(RESUME_CHAT)) {
        if (requestContainsToolOutput(body, 'interface-resume')) {
          const result = JSON.parse(readMcpToolOutput(body, 'interface-resume'))
          assert.equal(result.success, true)
          assert.equal(result.taskId, concreteTaskId)
          events = [assistantMessage('原工作已继续')]
        } else {
          events = mcpToolRequestEvents(body, {
            toolName: 'continue_task',
            directToolName: 'mcp__wework_stand_in__continue_task',
            argumentsValue: {
              requestId: 'interface-resume',
              taskId: concreteTaskId,
              message: RESUME_WORK,
            },
            searchCallId: 'interface-resume-search',
            toolCallId: 'interface-resume',
          }).events
        }
      } else if (!input.includes(CHAT)) {
        assert.ok(input.includes(WORK))
        assert.fail('A concrete worker must complete its general conversation reads first')
      } else if (requestContainsToolOutput(body, 'interface-create')) {
        const result = JSON.parse(readMcpToolOutput(body, 'interface-create'))
        assert.equal(result.success, true)
        concreteTaskId = result.taskId
        events = [assistantMessage('已交办具体工作')]
      } else {
        const listed = requestContainsToolOutput(body, 'interface-list')
        events = mcpToolRequestEvents(body, {
          toolName: listed ? 'create_task' : 'list_tasks',
          directToolName: `mcp__wework_stand_in__${listed ? 'create_task' : 'list_tasks'}`,
          argumentsValue: listed
            ? { requestId: 'interface-create', title: '模型接口工作', message: WORK }
            : {},
          searchCallId: listed ? 'interface-create-search' : 'interface-list-search',
          toolCallId: listed ? 'interface-create' : 'interface-list',
        }).events
      }
      const id = `model-interface-${Date.now()}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },
    diagnostics() {
      return { ...existing.diagnostics?.(), interfaceRequests }
    },
    async verify(control) {
      await existing.verify(control)
      await reloadMainWindow(
        control,
        'Model-interface settings did not reload after fixture cleanup'
      )
      await control.command('clickWhenEnabled', '[data-testid="personal-stand-in-button"]')
      await control.command('waitFor', '[data-testid="stand-in-overview"]')
      const rpc = (method, params) => requestExecutor(control, method, params, options.uiTimeoutMs)
      const initial = await rpc('runtime.stand_in.personal.get', { userId })
      const catalog = await rpc('runtime.runner.catalog', {})
      const model = catalog.models.find(row => row.model_id === 'local-model:stand-in-interface')
      assert.ok(
        model,
        'A native model.yml interface must appear without changing Codex config.toml'
      )
      assert.ok(!JSON.stringify(catalog).includes(MODEL_API_KEY))
      assert.ok(!JSON.stringify(model).includes('modelConfig'))
      try {
        await openStandInSettings(control)
        await control.command(
          'clickWhenEnabled',
          '[data-testid="stand-in-primary-profile"] [data-testid="model-selector-button"]'
        )
        const option = selector(
          `model-option-${JSON.stringify([model.runtime, model.provider, model.model_id])}`
        )
        await control.command('waitFor', option)
        await control.command('scrollIntoView', option)
        await control.command('clickWhenEnabled', option)
        await control.command('press', 'body', { key: 'Escape' })
        await control.command('clickWhenEnabled', '[data-testid="stand-in-primary-save"]')
        await control.command('waitFor', '[data-testid="stand-in-primary-profile"]', {
          visible: false,
        })
        const saved = await rpc('runtime.stand_in.personal.get', { userId })
        assert.equal(saved.primary.model.model_id, model.model_id)
        assert.ok(!JSON.stringify(saved).includes(MODEL_API_KEY))
        primaryAddressReady = new Promise(resolve => {
          resolvePrimaryAddress = resolve
        })
        const address = await rpc('runtime.stand_in.conversation', { userId, message: CHAT })
        primaryTaskId = address.taskId
        resolvePrimaryAddress()
        await until(
          () => rpc('runtime.tasks.get', { taskId: address.taskId }),
          result => {
            assert.notEqual(result.task?.status, 'failed', JSON.stringify(result))
            return result.task?.status === 'done' && concreteTaskId
          },
          'The primary stand-in did not delegate through its configured model interface',
          options.modelResponseTimeoutMs
        )
        await until(
          () => rpc('runtime.tasks.get', { taskId: concreteTaskId }),
          result => {
            assert.notEqual(result.task?.status, 'failed', JSON.stringify(result))
            return result.task?.status === 'done'
          },
          'The concrete work did not finish through the inherited model interface',
          options.modelResponseTimeoutMs
        )
        const transcript = await rpc('runtime.tasks.transcript', { taskId: concreteTaskId })
        assert.ok(JSON.stringify(transcript).includes(DONE))
        assert.ok(modelCalls >= 4)
        await options.restartDesktopApp()
        await rpc('runtime.stand_in.conversation', { userId, message: RESUME_CHAT })
        await until(
          () => rpc('runtime.tasks.transcript', { taskId: concreteTaskId }),
          result => !result.running && JSON.stringify(result).includes(RESUMED),
          'The original work lost its model-interface credentials after restarting Wework',
          options.modelResponseTimeoutMs
        )
        const resumed = await rpc('runtime.tasks.transcript', { taskId: concreteTaskId })
        assert.equal(
          resumed.threadId,
          transcript.threadId,
          'Continuation must retain the original work conversation'
        )
      } finally {
        const latest = await rpc('runtime.stand_in.personal.get', { userId })
        await rpc('runtime.stand_in.personal.save', {
          userId,
          settings: { ...initial, version: latest.version },
        })
      }
    },
  }
}
