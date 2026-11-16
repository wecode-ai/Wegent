import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDesktopScenario as createNativeGuidance } from './native-guidance.scenario.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { waitForValue } from '../modules/workspace-agent-setup.mjs'
import {
  assistantMessage,
  createSse,
  handleEmptyReplyPrediction,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const INITIAL = 'WEWORK_MOBILE_LOCAL_INITIAL'
const FOLLOW_UP = 'WEWORK_MOBILE_LOCAL_FOLLOW_UP'
const INITIAL_DONE = 'WEWORK_MOBILE_LOCAL_INITIAL_DONE'
const FOLLOW_UP_DONE = 'WEWORK_MOBILE_LOCAL_FOLLOW_UP_DONE'

async function loadSharedBuilders() {
  const clientBundle = process.env.WEWORK_E2E_SOCKET_IO_CLIENT
  if (clientBundle) {
    return createRequire(import.meta.url)(join(dirname(clientBundle), 'local-runtime-payload.cjs'))
  }
  const { createServer } = await import('vite')
  const loader = await createServer({
    root: fileURLToPath(new URL('../../../../', import.meta.url)),
    configFile: false,
    envFile: false,
    logLevel: 'error',
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false },
    appType: 'custom',
  })
  try {
    return {
      ...(await loader.ssrLoadModule('/packages/chat-core/src/local-runtime-execution.ts')),
      ...(await loader.ssrLoadModule('/packages/chat-core/src/local-runtime-model.ts')),
      ...(await loader.ssrLoadModule('/wework/electron/src/host/model-interface-runtime.ts')),
    }
  } finally {
    await loader.close()
  }
}

// Exercise the phone's shared payload through the existing real executor and Codex.
// Native iOS scheduling and OAuth are outside this desktop checkpoint's coverage.
export function createDesktopScenario(options) {
  const existing = createNativeGuidance(options)
  let active = false
  const requests = []
  return {
    ...existing,
    async handleHttp(request, response, url) {
      if (!active) return existing.handleHttp(request, response, url)
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      const text = JSON.stringify(body.input)
      assert.ok(text.includes(INITIAL), 'The mobile task lost its initial native history')
      const followUp = text.includes(FOLLOW_UP)
      assert.equal(requests.length, followUp ? 1 : 0, 'The mobile request was duplicated')
      requests.push(followUp ? 'follow-up' : 'initial')
      const id = `mobile-local-${requests.length}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(
        createSse([
          responseCreated(id),
          assistantMessage(followUp ? FOLLOW_UP_DONE : INITIAL_DONE),
          responseCompleted(id),
        ])
      )
      return true
    },
    async verify(control) {
      await existing.verify(control)
      const builders = await loadSharedBuilders()
      const rpc = (method, params) => requestExecutor(control, method, params, options.uiTimeoutMs)
      const snapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
      const deviceId = snapshot.workbench?.currentRuntimeTask?.deviceId
      assert.ok(deviceId, 'The existing runtime did not expose its owning device')
      const port = Number(process.env.WEWORK_E2E_MODEL_SERVER_PORT)
      assert.ok(port > 0, 'The shared model service did not expose its port')
      const modelId = `mobile-responses-${randomUUID()}`
      const modelName = `local-model:${modelId}`
      const provider = builders.modelInterfaceProviderId(modelId)
      const configured = builders.modelInterfaceRuntimeConfig({
        id: modelId,
        modelId: 'mobile-responses-model',
        displayName: 'Mobile Responses',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiFormat: 'openai-responses',
        apiKey: 'isolated-model-fixture',
      })
      await rpc('runtime.runner.local_models.replace', {
        models: [
          {
            runtime: 'codex',
            provider,
            model_id: modelName,
            local_model_id: modelName,
            label: 'Mobile Responses',
            is_default: false,
            modelConfig: configured,
          },
        ],
      })
      await rpc('runtime.models.sync_creation_profiles', {
        profiles: [
          { runtime: 'codex', modelName, label: 'Mobile Responses', modelConfig: configured },
        ],
      })
      const catalog = await rpc('runtime.runner.catalog', {})
      assert.ok(
        catalog.models.some(item => item.model_id === modelName && item.provider === provider),
        'The phone Responses model did not enter the real runner catalog'
      )
      const workspacePath = join(options.workspacePath, 'mobile-local-payload')
      await mkdir(workspacePath, { recursive: true })
      const taskId = randomUUID()
      const modelOptions = { permissionMode: 'full-access', runnerModelProvider: provider }
      const modelConfig = builders.resolveLocalRuntimeModelConfig({
        runtime: 'codex',
        modelName,
        modelType: 'runtime',
        modelOptions,
      })
      const executionRequest = (message, newSession, clientUserMessageId) =>
        builders.buildLocalRuntimeExecutionRequest({
          taskId,
          runtime: 'codex',
          title: 'Mobile local payload',
          message,
          clientUserMessageId,
          turnSeed: newSession ? 1 : 2,
          modelConfig,
          modelOptions,
          reasoningConfig: null,
          localDeviceId: deviceId,
          workspacePath,
          workspaceSource: 'local_path',
          newSession,
          user: { id: 0, user_name: 'local', email: 'local@wework.local' },
        })
      const address = { deviceId, taskId, runtime: 'codex', workspacePath }
      const waitForReply = expected =>
        waitForValue(
          async () => {
            const { task } = await rpc('runtime.tasks.get', { address })
            const transcript = await rpc('runtime.tasks.transcript', { address })
            assert.notEqual(task?.executionState?.outcome, 'failed', 'Mobile execution failed')
            return { task, transcript }
          },
          result =>
            result.task?.executionState?.phase === 'idle' &&
            result.transcript.messages?.some(
              message => message.role === 'assistant' && JSON.stringify(message).includes(expected)
            ),
          `The mobile runtime did not complete ${expected}`,
          options.uiTimeoutMs
        )
      active = true
      const created = await rpc('runtime.tasks.create', {
        schemaVersion: 2,
        ...address,
        title: 'Mobile local payload',
        message: INITIAL,
        clientUserMessageId: `${taskId}-initial`,
        modelId: modelName,
        modelType: 'runtime',
        modelOptions,
        executionRequest: executionRequest(INITIAL, true, `${taskId}-initial`),
      })
      assert.equal(created.accepted, true, created.error)
      assert.equal(created.taskId, taskId)
      assert.equal(created.deviceId, deviceId)
      const first = await waitForReply(INITIAL_DONE)
      const sent = await rpc('runtime.tasks.send', {
        address,
        taskId,
        message: FOLLOW_UP,
        clientUserMessageId: `${taskId}-follow-up`,
        modelSelection: { modelName, modelType: 'runtime', options: modelOptions },
        executionRequest: executionRequest(FOLLOW_UP, false, `${taskId}-follow-up`),
      })
      assert.equal(sent.accepted, true, sent.error)
      assert.equal(sent.taskId, taskId)
      const second = await waitForReply(FOLLOW_UP_DONE)
      assert.ok(first.task.threadId, 'The mobile task did not acquire a native thread')
      assert.equal(
        second.task.threadId,
        first.task.threadId,
        'Follow-up created a new native thread'
      )
      assert.equal(second.task.executionState.outcome, 'succeeded')
      for (const suffix of ['initial', 'follow-up']) {
        const messages = second.transcript.messages.filter(
          message =>
            message.role === 'user' && message.clientUserMessageId === `${taskId}-${suffix}`
        )
        assert.equal(
          messages.length,
          1,
          `Mobile ${suffix} lost or duplicated its user-message identity`
        )
      }
      assert.deepEqual(requests, ['initial', 'follow-up'])
      await writeFile(
        join(options.resultDir, 'mobile-local-payload.json'),
        JSON.stringify({ address, requests, first: first.task, second: second.task }, null, 2)
      )
      // The existing checkpoint owns and removes this isolated Home and workspace.
    },
  }
}
