import assert from 'node:assert/strict'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { accountCommandResult } from '../modules/account-auth-command.mjs'
import {
  shellCommandResponse,
  shellCommandPollResponse,
} from '../modules/shell-command-response.mjs'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  createSingleRootLocalProject,
  fetchJson,
  selectE2EModel,
} from '../modules/shared.mjs'
import {
  assistantMessage,
  createSse,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const MARKER = 'WEWORK_REPLY_PREDICTION_AUTH'
const API_KEY = 'reply-prediction-fixture-key'
const MODEL = 'reply-prediction-auth-model'
const ENV_CALL = 'prediction-parent-shell-identity'
const ENV_OK = 'PREDICTION_PARENT_SHELL_IDENTITY_OK'
const GHOST = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input-prediction"]`
const PENDING = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input-prediction-pending"]`
const ERROR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="reply-prediction-error"]`

export function createDesktopScenario({ workspacePath, modelResponseTimeoutMs }) {
  let normalRequests = 0
  let predictionRequests = 0
  let rejectedPredictions = 0
  let shellIdentityVerified = false
  let identity

  async function assertRedactedTask(control) {
    const state = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
    const address = state.workbench?.currentRuntimeTask
    assert.ok(address?.taskId, 'The conversation address is missing')
    const origin = await control.command('getLocationOrigin', 'body')
    const response = await fetchJson(`${origin}/wework/executor/v1/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'prediction-auth-task',
        method: 'runtime.tasks.get',
        params: { address },
      }),
      signal: AbortSignal.timeout(modelResponseTimeoutMs),
    })
    assert.equal(response.ok, true)
    const task = response.result?.task
    assert.ok(task?.threadId)
    assert.ok(!JSON.stringify(task).includes(API_KEY), 'Prediction credentials were persisted')
    const current = { taskId: task.taskId, threadId: task.threadId }
    if (identity)
      assert.deepEqual(current, identity, 'Prediction recovery changed the conversation')
    identity = current
  }

  async function send(control, round) {
    await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: `${MARKER} ${round}` })
    await control.command(
      'clickWhenEnabled',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`
    )
    await control.command(
      'waitFor',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
      {
        text: `${MARKER} answer ${round}`,
        timeoutMs: modelResponseTimeoutMs,
      }
    )
  }

  return {
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      const input = JSON.stringify(body.input ?? [])
      if (!input.includes(MARKER)) return false
      const prediction = input.includes('Predict one natural next USER message')
      assert.equal(
        request.headers.authorization,
        `Bearer ${API_KEY}`,
        'The model request lost its current credentials'
      )
      assert.equal(body.model, MODEL, 'Prediction changed the selected model')
      const command = shellIdentityVerified ? null : accountCommandResult(body.input, ENV_CALL)
      if (!prediction && command) {
        const id = `${ENV_CALL}-result`
        const events = command.sessionId
          ? shellCommandPollResponse(body, command.pollId, command.sessionId)
          : [assistantMessage(`${MARKER} answer ${normalRequests}`)]
        if (!command.sessionId) {
          assert.ok(command.output.includes(ENV_OK), command.output)
          shellIdentityVerified = true
        }
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
        return true
      }
      if (prediction) predictionRequests += 1
      else normalRequests += 1
      if (!prediction && normalRequests === 2) {
        const id = `${ENV_CALL}-start`
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.end(
          createSse([
            responseCreated(id),
            ...shellCommandResponse(
              body,
              ENV_CALL,
              // Native Windows paths and POSIX shell PWD are different representations.
              `node -e "const fs=require('node:fs');const assert=require('node:assert/strict');fs.accessSync(process.env.WEGENT_EXECUTOR_BINARY,fs.constants.X_OK);assert.ok(fs.statSync(process.env.WEGENT_EXECUTOR_BINARY).isFile());assert.equal(fs.realpathSync(process.env.WEGENT_TASK_WORKSPACE),fs.realpathSync(process.cwd()));console.log('${ENV_OK}')"`,
              workspacePath
            ),
            responseCompleted(id),
          ])
        )
        return true
      }
      if (prediction && normalRequests === 2) {
        rejectedPredictions += 1
        response.writeHead(401, { 'Content-Type': 'application/json' })
        response.end(
          JSON.stringify({
            error: { type: 'authentication_error', message: 'Fixture credentials rejected' },
          })
        )
        return true
      }
      const text = prediction
        ? JSON.stringify({ suggestion: `继续第 ${normalRequests} 轮方案` })
        : `${MARKER} answer ${normalRequests}`
      const id = `prediction-auth-${normalRequests}-${predictionRequests}`
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), assistantMessage(text), responseCompleted(id)]))
      return true
    },
    async verify(control) {
      await control.command('navigate', 'body', { value: '/settings/general' })
      await control.command('waitFor', '[data-testid="reply-prediction-enabled"]')
      await control.command('scrollIntoView', '[data-testid="reply-prediction-settings"]')
      await control.command(
        'waitFor',
        '[data-testid="reply-prediction-enabled"][aria-checked="true"]'
      )

      await control.command('navigate', 'body', { value: '/settings/personal/models' })
      await control.command('waitFor', '[data-testid="provider-add"]')
      await control.command('click', '[data-testid="provider-add"]')
      await control.command('waitFor', '[data-testid="provider-editor"]')
      await control.command('select', '[data-testid="provider-preset"]', { value: 'custom' })
      await control.command('fill', '[data-testid="provider-name"]', { value: MODEL })
      await control.command('select', '[data-testid="provider-protocol"]', {
        value: 'openai-responses',
      })
      await control.command('fill', '[data-testid="provider-base-url"]', {
        value: `${control.url}/v1`,
      })
      await control.command('fill', '[data-testid="provider-api-key"]', { value: API_KEY })
      await control.command('click', '[data-testid="provider-model-add"]')
      const editor = JSON.parse(
        await control.command('snapshot', '[data-testid="provider-editor"]')
      )
      const input = editor.testIds.find(id => id.startsWith('provider-model-id-'))
      assert.ok(input)
      const modelId = input.slice('provider-model-id-'.length)
      await control.command('fill', `[data-testid="${input}"]`, { value: MODEL })
      await control.command('click', '[data-testid="provider-editor-save"]')
      await control.command('waitFor', '[data-testid="provider-editor"]', { visible: false })
      await control.command('navigate', 'body', { value: '/' })
      await createSingleRootLocalProject(control, workspacePath, '回复建议认证回归')
      await selectE2EModel(control, `local-model:${modelId}`, MODEL)
      await send(control, 1)
      await control.command('waitFor', GHOST, {
        text: '继续第 1 轮方案',
        timeoutMs: modelResponseTimeoutMs,
      })
      await assertRedactedTask(control)
      // Make prediction the first reader to restore this parent after a native restart.
      // The following real shell call must retain task identity even in this ordering.
      const restarted = JSON.parse(
        await control.command('restartLocalCodexAppServerIfIdle', 'body')
      )
      assert.equal(restarted.restarted, true, 'The parent must be unloaded before prediction')
      const predicted = await requestExecutor(
        control,
        'runtime.text.predict_reply',
        {
          ...identity,
          requestId: 'prediction-auth-cold-parent',
          modelConfig: {
            model_id: MODEL,
            base_url: `${control.url}/v1`,
            api_key: API_KEY,
            api_format: 'openai-responses',
          },
        },
        modelResponseTimeoutMs
      )
      assert.equal(predicted.suggestion, '继续第 1 轮方案')
      await send(control, 2)
      await control.command('waitFor', ERROR, {
        text: '回复建议生成失败',
        timeoutMs: modelResponseTimeoutMs,
      })
      assert.equal(Number(await control.command('getElementCount', PENDING)), 0)
      assert.equal(Number(await control.command('getElementCount', GHOST)), 0)
      assert.ok(rejectedPredictions > 0, 'The failure case never reached the model')
      await send(control, 3)
      await control.command('waitFor', GHOST, {
        text: '继续第 3 轮方案',
        timeoutMs: modelResponseTimeoutMs,
      })
      assert.equal(Number(await control.command('getElementCount', ERROR)), 0)
      await assertRedactedTask(control)
      assert.equal(normalRequests, 3, 'Predictions sent a user message')
      assert.equal(
        shellIdentityVerified,
        true,
        'The resumed parent never verified its shell environment'
      )
    },
    diagnostics() {
      return { normalRequests, predictionRequests, rejectedPredictions }
    },
  }
}
