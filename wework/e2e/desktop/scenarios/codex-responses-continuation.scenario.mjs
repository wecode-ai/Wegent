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
  let originalMessage
  let forwardedContinuation

  return {
    modelProviderId: 'openai',
    modelId: MODEL,
    prepareApp: subscription.prepareApp,
    attachServer(server) {
      closeSockets = attachCodexModelWebSocket(server, {
        modelServerUrl: 'http://localhost',
        paths: [RESPONSES_PATH],
        isVerificationComplete: () => verified,
        modelEvents(request, body, { isWarmup, isPrediction }) {
          if (isWarmup || isPrediction) return
          assertSubscriptionModelRequest(request, body, MODEL)
          if (userMessage(body, FOLLOWUP)) {
            // Match the upstream failure observed when restoring the same thread
            // over WebSocket. The HTTP endpoint accepts the replay with IDs intact.
            return [
              {
                type: 'error',
                status: 400,
                error: {
                  message: 'This request does not support user-supplied input item IDs.',
                  type: 'invalid_request_error',
                  param: 'input',
                  code: 'unsupported_parameter',
                },
              },
            ]
          }
          const first = userMessage(body, FIRST)
          if (first) {
            originalMessage = first
            return reply(FIRST)
          }
        },
      })
    },
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || url.pathname !== RESPONSES_PATH) return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      assertSubscriptionModelRequest(request, body, MODEL)
      const followup = userMessage(body, FOLLOWUP)
      if (followup) {
        forwardedContinuation = {
          history: userMessage(body, FIRST),
          inputId: followup.id,
          threadId: body.client_metadata?.thread_id,
        }
      } else {
        const first = userMessage(body, FIRST)
        if (first) originalMessage = first
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(createSse(reply(followup ? FOLLOWUP : FIRST)))
      return true
    },
    async verify(control) {
      const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
      const run = async (prompt, threadId) => {
        const result = await rpc(threadId ? 'runtime.tasks.send' : 'runtime.tasks.create', {
          taskId: TASK,
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
            task_id: TASK,
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
          async () => (await rpc('runtime.tasks.get', { taskId: TASK })).task,
          task => ['done', 'failed'].includes(task?.status),
          `Official Codex turn did not finish for ${prompt}`,
          modelResponseTimeoutMs
        )
      }

      const first = await run(FIRST)
      assert.equal(first.status, 'done', first.executionState?.error)
      assert.equal(typeof first.threadId, 'string')
      assert.match(originalMessage?.id, /^msg_/)
      await restartCodexWhenIdle(
        async () => JSON.parse(await control.command('restartLocalCodexAppServerIfIdle', 'body')),
        uiTimeoutMs
      )
      const resumed = await run(FOLLOWUP, first.threadId)
      assert.equal(resumed.status, 'done', resumed.executionState?.error)
      assert.equal(resumed.threadId, first.threadId)
      assert.ok(forwardedContinuation, 'The restored request did not reach the HTTP model endpoint')
      assert.deepEqual(forwardedContinuation.history, originalMessage)
      assert.match(forwardedContinuation.inputId, /^msg_/)
      assert.equal(forwardedContinuation.threadId, first.threadId)
      verified = true
    },
    async cleanup() {
      closeSockets?.()
      await subscription.cleanup()
    },
  }
}
