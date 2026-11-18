import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createCloudConfigModelService } from '../modules/cloud-config-model-service.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { waitForValue } from '../modules/workspace-agent-setup.mjs'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  createSingleRootLocalProject,
  selectE2EModel,
  waitForLogPattern,
} from '../modules/shared.mjs'
import {
  assistantMessage,
  createSse,
  isReplyPredictionRequest,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'
import { join } from 'node:path'

const MODEL = 'gpt-6.1-sol'
const MARKER = 'WEWORK_OFFICIAL_REPLY_PREDICTION'
const SUGGESTION = '请继续验证官方模型的回复建议。'
const GHOST = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input-prediction"]`

// Only the subscription model service is simulated. Electron, OAuth account
// loading, Codex forks, proxy authorization, persistence and IPC remain real.
export function createDesktopScenario({ resultDir, workspacePath, modelResponseTimeoutMs }) {
  const subscription = createCloudConfigModelService()
  let normalRequests = 0
  let predictionRequests = 0
  const predictionThreads = new Set()

  return {
    modelProviderId: 'openai',
    modelId: MODEL,
    handlesReplyPredictions: true,
    prepareApp: subscription.prepareApp,
    attachServer: subscription.attachServer,
    close: subscription.close,
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || url.pathname !== '/backend-api/codex/responses') return false
      const body = await readRequestBody(request)
      const prediction = isReplyPredictionRequest(body)
      const input = JSON.stringify(body.input ?? [])
      if (!input.includes(MARKER)) return false
      assert.equal(body.model, MODEL)
      assert.equal(request.headers.authorization, subscription.authorizationHeader())
      assert.equal(request.headers['chatgpt-account-id'], 'cloud-config-recovery-enterprise')
      if (prediction) {
        predictionRequests += 1
        assert.equal(body.reasoning?.effort, 'low')
        assert.ok(body.client_metadata?.thread_id, 'Prediction lost its native thread identity')
        predictionThreads.add(body.client_metadata.thread_id)
      } else normalRequests += 1
      const id = randomUUID()
      const text = prediction
        ? JSON.stringify({ suggestion: SUGGESTION })
        : `${MARKER} answer ${normalRequests}`
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), assistantMessage(text), responseCompleted(id)]))
      return true
    },
    async verify(control) {
      const preferences = JSON.parse(
        await control.command('setAppPreferences', 'body', {
          value: JSON.stringify({ replyPredictionsEnabled: true, trayUsageEnabled: false }),
        })
      )
      assert.equal(preferences.replyPredictionsEnabled, true)
      await createSingleRootLocalProject(control, workspacePath, '官方模型回复建议回归')
      await selectE2EModel(control, MODEL, 'GPT-6.1 Sol', ACTIVE_WORKBENCH_SELECTOR, 'openai')
      const send = async round => {
        await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: `${MARKER} ${round}` })
        await control.command(
          'clickWhenEnabled',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`
        )
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
          { text: `${MARKER} answer ${round}`, timeoutMs: modelResponseTimeoutMs }
        )
        await control.command('waitFor', GHOST, {
          text: SUGGESTION,
          timeoutMs: modelResponseTimeoutMs,
        })
      }
      await send(1)
      assert.equal(predictionRequests, 1, 'The first completed turn did not predict exactly once')
      const snapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
      const address = snapshot.workbench?.currentRuntimeTask
      assert.ok(address?.taskId)
      const { task: before } = await requestExecutor(control, 'runtime.tasks.get', { address })
      assert.ok(before.threadId)
      assert.ok(!predictionThreads.has(before.threadId), 'Prediction ran on the parent thread')
      await send(2)
      assert.equal(normalRequests, 2, 'Predictions sent a foreground message')
      assert.equal(predictionRequests, 2, 'Parent follow-up lost its inherited route')
      const { task: after } = await requestExecutor(control, 'runtime.tasks.get', { address })
      assert.equal(after.threadId, before.threadId, 'Prediction replaced the parent conversation')
      assert.equal(predictionThreads.size, 2, 'Each prediction must use its own temporary fork')
      await waitForLogPattern(
        join(resultDir, 'executor.log'),
        /route=local_proxy_official_subscription/,
        { timeoutMs: modelResponseTimeoutMs }
      )
      await waitForValue(
        async () => JSON.parse(await control.command('restartLocalCodexAppServerIfIdle', 'body')),
        value => value.restarted === true,
        'The native app server did not become idle before cold prediction',
        modelResponseTimeoutMs
      )
      const cold = await requestExecutor(
        control,
        'runtime.text.predict_reply',
        {
          address,
          requestId: randomUUID(),
          latestTurnId: after.executionState.latestTurnId,
        },
        modelResponseTimeoutMs
      )
      assert.equal(cold.suggestion, SUGGESTION, 'Restored official conversation lost predictions')
      assert.equal(predictionRequests, 3)
      await send(3)
      const { task: resumed } = await requestExecutor(control, 'runtime.tasks.get', { address })
      assert.equal(resumed.threadId, before.threadId)
      assert.equal(normalRequests, 3)
      assert.equal(predictionRequests, 4)
    },
    diagnostics() {
      return { normalRequests, predictionRequests, predictionThreadCount: predictionThreads.size }
    },
  }
}
