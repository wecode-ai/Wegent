import assert from 'node:assert/strict'
import { restartCodexWhenIdle } from '../modules/executor-restart-readiness.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import {
  assistantMessage,
  createSse,
  handleEmptyReplyPrediction,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'
import {
  assertSubscriptionModelRequest,
  createSubscriptionConfigRegression,
} from '../modules/stand-in-subscription-config.mjs'
import { waitForValue } from '../modules/workspace-agent-setup.mjs'
import { attachCodexModelWebSocket } from './codex-invalid-launch-cwd.scenario.mjs'

const TASK = 'codex-responses-continuation'
const MODEL = 'gpt-6.2-sol'
const FIRST = 'OFFICIAL_RESPONSES_FIRST_TURN'
const FOLLOWUP = 'OFFICIAL_RESPONSES_FOLLOWUP_TURN'
const WEBSOCKET = 'OFFICIAL_RESPONSES_WEBSOCKET_TURN'
const RESPONSES_PATH = '/backend-api/codex/responses'

function userMessage(body, text) {
  return body.input?.find(
    item => item.role === 'user' && JSON.stringify(item.content).includes(text)
  )
}

function reply(prompt) {
  const responseId = `resp_${prompt.toLowerCase()}`
  const message = assistantMessage(`${prompt}_COMPLETE`)
  return [responseCreated(responseId), message, responseCompleted(responseId, [message.item])]
}

export function createDesktopScenario({ workspacePath, uiTimeoutMs, modelResponseTimeoutMs }) {
  const subscription = createSubscriptionConfigRegression()
  let closeSockets
  let verified = false
  let defaultUsedWebSocket = false
  let originalMessage
  let forwardedContinuation
  let optedInMessage

  return {
    modelProviderId: 'openai',
    modelId: MODEL,
    prepareApp: options => subscription.prepareApp(options),
    attachServer(server) {
      closeSockets = attachCodexModelWebSocket(server, {
        modelServerUrl: 'http://localhost',
        paths: [RESPONSES_PATH],
        isVerificationComplete: () => verified,
        modelEvents(request, body, { isWarmup, isPrediction }) {
          if (isWarmup || isPrediction) return
          assertSubscriptionModelRequest(request, body, MODEL)
          const optedIn = userMessage(body, WEBSOCKET)
          if (optedIn) {
            optedInMessage = optedIn
            return reply(WEBSOCKET)
          }
          if (userMessage(body, FIRST)) {
            defaultUsedWebSocket = true
            return reply(FIRST)
          }
        },
      })
    },
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || url.pathname !== RESPONSES_PATH) return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      const first = userMessage(body, FIRST)
      const followup = userMessage(body, FOLLOWUP)
      if (first || followup) {
        assertSubscriptionModelRequest(request, body, MODEL)
        if (followup) {
          forwardedContinuation = {
            history: first,
            inputId: followup.id,
            threadId: body.client_metadata?.thread_id,
          }
        } else {
          originalMessage = first
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(createSse(reply(followup ? FOLLOWUP : FIRST)))
        return true
      }
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'Expected a WebSocket request' } }))
      return true
    },
    async verify(control) {
      const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
      const run = async (taskId, prompt, threadId) => {
        const result = await rpc(threadId ? 'runtime.tasks.send' : 'runtime.tasks.create', {
          taskId,
          title: TASK,
          runtime: 'codex',
          workspacePath,
          message: prompt,
          ...(threadId ? { threadId } : {}),
          modelSelection: {
            modelName: MODEL,
            modelType: 'runtime',
            options: { codexProviderId: 'openai', codexProviderType: 'official' },
          },
          executionRequest: {
            task_id: taskId,
            subtask_id: prompt,
            project_workspace_path: workspacePath,
            prompt,
            new_session: !threadId,
            bot: [{ shell_type: 'Codex', name: 'Official Responses continuation' }],
            model_config: {
              model_id: MODEL,
              model_provider: 'openai',
              wework_model_kind: 'codex-official',
            },
          },
        })
        assert.equal(result.accepted, true)
        return waitForValue(
          async () => (await rpc('runtime.tasks.get', { taskId })).task,
          task => ['done', 'failed'].includes(task?.status),
          `Official Codex turn did not finish for ${prompt}`,
          modelResponseTimeoutMs
        )
      }

      const first = await run(TASK, FIRST)
      assert.equal(first.status, 'done', first.executionState?.error)
      assert.equal(typeof first.threadId, 'string')
      assert.equal(defaultUsedWebSocket, false, 'The first turn must use HTTP by default')
      assert.match(originalMessage?.id, /^msg_/)
      const restart = () =>
        restartCodexWhenIdle(
          async () => JSON.parse(await control.command('restartLocalCodexAppServerIfIdle', 'body')),
          uiTimeoutMs
        )
      await restart()
      const resumed = await run(TASK, FOLLOWUP, first.threadId)
      assert.equal(resumed.status, 'done', resumed.executionState?.error)
      assert.equal(resumed.threadId, first.threadId)
      assert.ok(forwardedContinuation, 'Codex did not replay the restored history over HTTP')
      assert.deepEqual(forwardedContinuation.history, originalMessage)
      assert.match(forwardedContinuation.inputId, /^msg_/)
      assert.equal(forwardedContinuation.threadId, first.threadId)
      const httpOption = '[data-testid="local-codex-transport-http"]'
      const webSocketOption = '[data-testid="local-codex-transport-websocket"]'
      const openModels = () =>
        control.command('navigate', 'body', { value: '/settings/personal/models' })
      const waitForTransport = selector =>
        control.command(
          'waitFor',
          `${selector}[role="radio"][aria-checked="true"]:not(:disabled):not([aria-disabled="true"])`,
          {
            timeoutMs: uiTimeoutMs,
          }
        )
      await openModels()
      await waitForTransport(httpOption)
      await control.command('clickWhenEnabled', webSocketOption)
      await waitForTransport(webSocketOption)
      await control.command('navigate', 'body', { value: '/settings/personal/general' })
      await control.command('waitFor', '[data-testid="general-settings-page"]')
      await openModels()
      await waitForTransport(webSocketOption)
      const optedIn = await run(`${TASK}-websocket`, WEBSOCKET)
      assert.equal(optedIn.status, 'done', optedIn.executionState?.error)
      assert.match(optedInMessage?.id, /^msg_/)
      await control.command('clickWhenEnabled', httpOption)
      await waitForTransport(httpOption)
      const optedOut = await run(`${TASK}-http`, FIRST)
      assert.equal(optedOut.status, 'done', optedOut.executionState?.error)
      assert.equal(defaultUsedWebSocket, false, 'Switching back to HTTP must disable WebSocket')
      verified = true
    },
    async cleanup() {
      closeSockets?.()
      await subscription.cleanup()
    },
  }
}
