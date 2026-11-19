import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { commandOutputAsync, DEFAULT_MODEL_ID, fetchJson, repoDir } from './shared.mjs'
import { requestExecutor } from './executor-rpc.mjs'
import { setNativeCatalogOverride } from './model-catalog-recovery.mjs'
import { interpretedImReplyEvents } from './runtime-im-question-understanding.mjs'
import { until } from './plugin-regression-fixture.mjs'
import {
  waitForBackendRuntimeTerminal,
  waitForCompletedRuntimeTaskThread,
} from './runtime-task-evidence.mjs'
import {
  assistantMessage,
  createSse,
  handleEmptyReplyPrediction,
  readRequestBody,
  responseCompleted,
  responseCreated,
  selectedToolCall,
  selectTool,
  toolOutputText,
} from './response-protocol.mjs'

const PREFIX = 'WEWORK_IM_QUESTION_'

// Protocol integration: only the model and external DingTalk API are simulated.
export function createRuntimeImQuestions({ workspacePath, uiTimeoutMs, modelResponseTimeoutMs }) {
  let active = false
  let cloud
  let api
  let userId
  let seeded = false
  let standInSnapshot
  let nativeControl
  let standInTaskId
  let finishBusyResponse
  let transientSendFailed = false
  let heldQuestionText = null
  const delivered = []
  const requested = new Set()
  const fixture = async payload => {
    const output = await commandOutputAsync(
      'uv',
      ['run', '--no-sync', 'python', 'tests/e2e/runtime_question_reply_fixture.py'],
      {
        cwd: join(repoDir, 'backend'),
        env: {
          ...cloud.backendEnv,
          PYTHONPATH: [repoDir, join(repoDir, 'backend')].join(delimiter),
          WEWORK_IM_QUESTION_FIXTURE: JSON.stringify({ userId, ...payload }),
        },
      }
    )
    return JSON.parse(output.trim().split('\n').at(-1))
  }
  return {
    async handleHttp(request, response, url) {
      if (
        !active ||
        request.method !== 'POST' ||
        !['/responses', '/v1/responses'].includes(url.pathname)
      )
        return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      if (JSON.stringify(body.input).includes(`${PREFIX}delivery-probe`)) {
        const id = `${PREFIX}delivery-probe`
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(
          createSse([
            responseCreated(id),
            assistantMessage(`${id}_complete`),
            responseCompleted(id),
          ])
        )
        return true
      }
      const interpreted = interpretedImReplyEvents(body)
      if (interpreted) {
        const id = `${PREFIX}stand_in_reply`
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(createSse([responseCreated(id), ...interpreted, responseCompleted(id)]))
        return true
      }
      const mode = ['inferred-sync', 'inferred-async', 'busy-async', 'sync', 'async', 'im'].find(
        value => JSON.stringify(body).includes(`${PREFIX}${value}`)
      )
      if (!mode) return false
      const callId = `${PREFIX}${mode}_call`
      const answered = JSON.stringify(body.input).includes(`${PREFIX}${mode}_answer`)
      if (mode === 'busy-async' && !answered && toolOutputText(body, callId) !== null) {
        assert.equal(
          finishBusyResponse,
          undefined,
          'The active model request must not be duplicated'
        )
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(createSse([responseCreated(callId)]))
        let finished = false
        finishBusyResponse = () => {
          if (finished) return
          finished = true
          response.end(createSse([assistantMessage('独立工作已完成。'), responseCompleted(callId)]))
        }
        return true
      }
      const output = answered
        ? [assistantMessage(`${PREFIX}${mode}_complete`)]
        : toolOutputText(body, callId) !== null
          ? [assistantMessage('等待用户回答。')]
          : selectedToolCall(
              callId,
              selectTool(
                body,
                mode.endsWith('sync') && !mode.endsWith('async')
                  ? 'request_user_input'
                  : 'request_user_input_async',
                mode === 'sync' || mode === 'inferred-sync'
                  ? {
                      questions: [
                        {
                          id: 'scope',
                          header: 'Scope',
                          question: `${PREFIX}${mode}_question`,
                          options: [
                            { label: '确认', description: '继续原任务' },
                            { label: '调整', description: '提供补充要求' },
                          ],
                        },
                      ],
                    }
                  : { questions: [{ title: `${PREFIX}${mode}_question`, options: ['确认'] }] }
              )
            )
      if (!answered && toolOutputText(body, callId) === null) {
        assert.equal(requested.has(mode), false, 'The model asked the same question twice')
        requested.add(mode)
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(createSse([responseCreated(callId), ...output, responseCompleted(callId)]))
      return true
    },
    async verify(environment, control) {
      cloud = environment
      nativeControl = control
      active = true
      const user = await fetchJson(`${cloud.backendUrl}/api/users/me`, {
        headers: { Authorization: `Bearer ${cloud.authToken}` },
      })
      userId = user.id
      await setNativeCatalogOverride(
        control,
        DEFAULT_MODEL_ID,
        {
          experimental_supported_tools: ['request_user_input_async'],
        },
        uiTimeoutMs
      )
      const catalog = await requestExecutor(control, 'runtime.runner.catalog', {}, uiTimeoutMs)
      const model = catalog.models.find(value => value.runtime === 'codex' && value.is_default)
      assert.ok(model, 'The real Codex model route must be configured')
      const app = await cloud.waitForConnectedAppDevice()
      const createTask = async (mode, options = {}) => {
        const taskId = `im-question-${mode}-${randomUUID()}`
        const workspace = join(workspacePath, taskId)
        await mkdir(workspace, { recursive: true })
        const created = await requestExecutor(
          control,
          'runtime.tasks.create',
          {
            taskId,
            workspacePath: workspace,
            message: `${PREFIX}${mode}`,
            title: taskId,
            ...options,
            executionRequest: {
              task_id: taskId,
              subtask_id: `${taskId}-initial`,
              user_id: userId,
              prompt: `${PREFIX}${mode}`,
              new_session: true,
              bot: [{ shell_type: 'Codex', name: 'IM question verification' }],
              model_config: {
                model_id: model.local_model_id,
                model_provider: model.provider,
                runtime_config: { codex: { use_user_config: true, configured: true } },
              },
            },
          },
          uiTimeoutMs
        )
        assert.equal(created.accepted, true, created.error)
        return taskId
      }
      control.performance.recordExternalServiceProtocols(['dingtalk'])
      api = createServer(async (req, res) => {
        try {
          const body = await readRequestBody(req)
          res.setHeader('content-type', 'application/json')
          if (req.url === '/v1.0/oauth2/accessToken') {
            assert.deepEqual(body, { appKey: 'question-ci-app', appSecret: 'question-ci-secret' })
            res.end(JSON.stringify({ accessToken: 'question-ci-access', expireIn: 7200 }))
          } else {
            assert.equal(req.url, '/v1.0/robot/oToMessages/batchSend')
            assert.deepEqual(body.userIds, ['question-ci-staff'])
            assert.equal(body.msgKey, 'sampleText')
            const text = JSON.parse(body.msgParam).content
            assert.notEqual(
              text,
              heldQuestionText,
              'A provider timeout must not hide a blocked Runtime event turn'
            )
            if (!transientSendFailed && text.includes(`${PREFIX}sync_question`)) {
              transientSendFailed = true
              heldQuestionText = text
              // Keep this provider request open while a later event must pass
              // through the same real device connection and Rust FIFO handler.
              const probeTaskId = await createTask('delivery-probe')
              await waitForBackendRuntimeTerminal(
                cloud,
                app.socket_device_id,
                probeTaskId,
                uiTimeoutMs
              )
              assert.equal(
                res.destroyed,
                false,
                'Later Runtime events must pass before IM times out'
              )
              heldQuestionText = null
              res.writeHead(503).end(JSON.stringify({ message: 'Temporary provider failure' }))
              return
            }
            const id = `question-ci-${delivered.length + 1}`
            delivered.push({ id, text })
            res.end(JSON.stringify({ processQueryKey: id }))
          }
        } catch (error) {
          api.failure = error
          res.writeHead(500).end('{}')
        }
      })
      await new Promise(resolve => api.listen(0, '127.0.0.1', resolve))
      try {
        seeded = true
        const session = await fixture({
          operation: 'seed',
          apiBase: `http://127.0.0.1:${api.address().port}`,
        })
        standInSnapshot = await requestExecutor(
          control,
          'runtime.stand_in.personal.get',
          { userId },
          uiTimeoutMs
        )
        const roleId = 'im-question-context'
        const projectKey = 'im-question-context-workspace'
        await control.command('seedLocalProject', 'body', {
          value: JSON.stringify({ projectKey, name: projectKey, path: workspacePath }),
        })
        await requestExecutor(
          control,
          'runtime.stand_in.personal.save',
          {
            userId,
            settings: {
              ...standInSnapshot,
              roles: [
                ...standInSnapshot.roles,
                {
                  id: roleId,
                  name: 'IM question context',
                  enabled: true,
                  prompt: '',
                  executionDeviceId: standInSnapshot.executionDeviceId,
                  model,
                  workspace: { projectKey, workspacePath, executionMode: 'current_workspace' },
                  connections: [],
                  tags: [],
                  collaboration: {
                    enabled: false,
                    allProjects: false,
                    projects: [],
                    excludedProjects: [],
                    tags: [],
                  },
                },
              ],
            },
          },
          uiTimeoutMs
        )
        standInTaskId = `stand-in-chat-${userId}-role-${roleId}`
        await fetchJson(
          `${cloud.backendUrl}/api/im/private-sessions/${encodeURIComponent(session.sessionKey)}/stand-in`,
          {
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${cloud.authToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ deviceId: standInSnapshot.executionDeviceId, roleId }),
          }
        )
        for (const mode of [
          'sync',
          'async',
          'busy-async',
          'inferred-sync',
          'inferred-async',
          'im',
        ]) {
          const synchronous = mode === 'sync' || mode === 'inferred-sync'

          if (mode === 'im') await fixture({ operation: 'disable' })
          const taskId = await createTask(mode, {
            ...(synchronous ? { modelOptions: { collaboration_mode: 'plan' } } : {}),
            ...(mode === 'im'
              ? {
                  source: {
                    source: 'im',
                    external_id: session.sessionKey,
                    channel_type: 'dingtalk',
                    channel_id: 779179,
                    conversation_id: 'question-ci',
                    sender_id: 'question-ci-owner',
                  },
                }
              : {}),
          })
          const message = await until(
            () => {
              assert.ifError(api.failure)
              return delivered.find(value => value.text.includes(`${PREFIX}${mode}_question`))
            },
            Boolean,
            `The ${mode} question was not delivered to IM`,
            modelResponseTimeoutMs
          )
          assert.equal(
            transientSendFailed,
            true,
            'The real delivery path must recover from a provider failure'
          )
          if (mode === 'busy-async')
            await until(
              () => Boolean(finishBusyResponse),
              Boolean,
              'The async task must continue into an active model request before the IM answer',
              modelResponseTimeoutMs
            )
          else if (!synchronous)
            await waitForCompletedRuntimeTaskThread(control, taskId, modelResponseTimeoutMs)
          if (mode.startsWith('inferred-')) {
            await fixture({
              operation: 'send',
              messageId: `${mode}-chat`,
              message: `${PREFIX}chat_${mode}`,
            })
            await until(
              () =>
                requestExecutor(
                  control,
                  'runtime.tasks.transcript',
                  { taskId: standInTaskId, limit: 100, includeFullContent: true },
                  uiTimeoutMs
                ),
              transcript =>
                JSON.stringify(transcript.turns).includes(`${PREFIX}chat_${mode}_complete`),
              'Unrelated IM chat must enter the actual stand-in conversation',
              modelResponseTimeoutMs
            )
            const before = await requestExecutor(
              control,
              'runtime.tasks.transcript',
              { taskId, limit: 100, includeFullContent: true },
              uiTimeoutMs
            )
            assert.equal(
              JSON.stringify(before.turns).includes(`${PREFIX}${mode}_complete`),
              false,
              'Unrelated chat must leave the original question unanswered'
            )
            await fixture({
              operation: 'send',
              messageId: `${mode}-answer`,
              message: `${PREFIX}interpret_${mode}`,
            })
            await until(
              () =>
                requestExecutor(
                  control,
                  'runtime.tasks.transcript',
                  { taskId: standInTaskId, limit: 100, includeFullContent: true },
                  uiTimeoutMs
                ),
              transcript =>
                JSON.stringify(transcript.turns).includes(`${PREFIX}interpreted_${mode}`),
              'The stand-in must submit the answer through its real scoped MCP tool',
              modelResponseTimeoutMs
            )
          } else {
            const sent = await fixture({
              operation: 'send',
              messageId: `${mode}-answer`,
              message: `${PREFIX}${mode}_answer`,
              replyTo: message.id,
            })
            assert.equal(sent.accepted, true)
            assert.ok(sent.replies.includes('已将回答提交给原任务。'), JSON.stringify(sent))
            if (mode === 'busy-async') finishBusyResponse()
          }
          await until(
            async () =>
              requestExecutor(
                control,
                'runtime.tasks.transcript',
                {
                  taskId,
                  limit: 100,
                  includeFullContent: true,
                },
                uiTimeoutMs
              ),
            transcript => JSON.stringify(transcript.turns).includes(`${PREFIX}${mode}_complete`),
            `The ${mode} IM answer did not continue its original task`,
            modelResponseTimeoutMs
          )
          const duplicate = await fixture({
            operation: 'send',
            messageId: `${mode}-duplicate`,
            replyTo: message.id,
            message: `${PREFIX}${mode}_answer`,
          })
          assert.equal(duplicate.accepted, true)
          assert.ok(
            duplicate.replies.some(text => text.includes('已回答')),
            JSON.stringify(duplicate)
          )
          assert.equal(
            delivered.filter(value => value.text.includes(`${PREFIX}${mode}_question`)).length,
            1
          )
        }
      } finally {
        await this.cleanup()
      }
    },
    async cleanup() {
      finishBusyResponse?.()
      active = false
      try {
        if (seeded) {
          seeded = false
          await fixture({ operation: 'cleanup' })
        }
      } finally {
        try {
          if (standInSnapshot && nativeControl) {
            const current = await requestExecutor(
              nativeControl,
              'runtime.stand_in.personal.get',
              { userId },
              uiTimeoutMs
            )
            await requestExecutor(
              nativeControl,
              'runtime.stand_in.personal.save',
              { userId, settings: { ...standInSnapshot, version: current.version } },
              uiTimeoutMs
            )
            standInSnapshot = undefined
          }
        } finally {
          if (api?.listening) {
            api.closeAllConnections()
            await new Promise(resolve => api.close(resolve))
          }
        }
      }
    },
  }
}
