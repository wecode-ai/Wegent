import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { requestExecutor } from './executor-rpc.mjs'
import { waitForValue } from './workspace-agent-setup.mjs'
import {
  assistantMessage,
  createSse,
  handleEmptyReplyPrediction,
  readRequestBody,
  responseCompleted,
  responseCreated,
  selectedToolCall,
  selectTool,
} from './response-protocol.mjs'

const MARKER = 'WEWORK_GOAL_ADMISSION_RECOVERY'

export function createGoalAdmissionRecovery({ workspacePath, uiTimeoutMs }) {
  let active = false
  let requests = 0
  let release
  const held = new Promise(resolve => {
    release = resolve
  })
  return {
    get active() {
      return active
    },
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      assert.ok(JSON.stringify(body).includes(MARKER), 'Recovery lost the original Goal history')
      const current = ++requests
      assert.ok(current <= 3, 'Goal admission submitted duplicate model work')
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(createSse([responseCreated(`${MARKER}-${current}`)]))
      if (current === 2) await held
      response.end(
        createSse([
          ...(current === 2
            ? selectedToolCall(
                'goal-admission-complete',
                selectTool(body, 'update_goal', { status: 'complete' })
              )
            : [assistantMessage(MARKER)]),
          responseCompleted(`${MARKER}-${current}`),
        ])
      )
      return true
    },
    async verify(control) {
      active = true
      const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
      const catalog = await rpc('runtime.runner.catalog', {})
      const model = catalog.models.find(model => model.runtime === 'codex' && model.is_default)
      assert.ok(model, 'Goal recovery requires the configured local Codex model')
      const taskId = `goal-admission-${randomUUID()}`
      const execution = {
        task_id: taskId,
        subtask_id: `${taskId}-initial`,
        user_id: 9001,
        prompt: MARKER,
        new_session: true,
        bot: [{ shell_type: 'Codex', name: 'Goal admission recovery' }],
        model_config: {
          model_id: model.local_model_id,
          model_provider: model.provider,
          runtime_config: { codex: { use_user_config: true, configured: true } },
        },
      }
      let address
      const task = async () => (await rpc('runtime.tasks.get', { taskId })).task
      const waitDone = () =>
        waitForValue(
          task,
          value => {
            assert.notEqual(value?.status, 'failed', JSON.stringify(value))
            return value?.status === 'done'
          },
          'The real Goal recovery did not finish',
          uiTimeoutMs
        )
      try {
        const created = await rpc('runtime.tasks.create', {
          taskId,
          title: MARKER,
          runtime: 'codex',
          workspacePath,
          message: MARKER,
          executionRequest: execution,
        })
        assert.equal(created.accepted, true, created.error)
        address = { deviceId: created.deviceId, taskId, workspacePath }
        const original = await waitDone()
        // Start from an unloaded thread; activation must durably own its native resume.
        await waitForValue(
          () => rpc('runtime.codex.app_server.restart', { ifIdle: true }),
          value => value.restarted === true,
          'The idle native process did not stop before cold Goal recovery',
          uiTimeoutMs
        )
        const set = await rpc('runtime.tasks.goal.set', {
          address,
          objective: MARKER,
          status: 'active',
        })
        assert.equal(set.accepted, true, set.error)
        const before = set.goal
        assert.equal(before.status, 'active')
        assert.equal(set.resumed, true, 'Activation must admit the owned Goal recovery')
        await waitForValue(
          task,
          value => requests === 2 && value.running === true,
          'The active Goal waited for its own resume instead of reaching the model',
          uiTimeoutMs
        )
        const protectedProcess = await rpc('runtime.codex.app_server.restart', { ifIdle: true })
        assert.equal(
          protectedProcess.restarted,
          false,
          'Pending Goal work must protect idle restart'
        )

        const sent = await rpc('runtime.tasks.send', {
          address,
          message: MARKER,
          executionRequest: {
            ...execution,
            subtask_id: `${taskId}-recovery`,
            new_session: false,
            wegent_resume_goal_only: true,
          },
        })
        assert.equal(sent.success, false, 'A second recovery must not replace its active owner')
        assert.equal(sent.code, 'bad_request')
        assert.equal(sent.error, 'runtime task is already running')
        assert.equal(requests, 2, 'Duplicate recovery submitted another model turn')
        const after = (await rpc('runtime.tasks.goal.get', { address })).goal
        for (const key of ['objective', 'createdAt', 'tokenBudget'])
          assert.equal(after[key], before[key], `Recovery replaced Goal ${key}`)
        assert.ok(after.tokensUsed >= before.tokensUsed)
        assert.ok(after.timeUsedSeconds >= before.timeUsedSeconds)
        release()
        const recovered = await waitDone()
        assert.equal(recovered.threadId, original.threadId, 'Recovery replaced the original thread')
        assert.equal((await rpc('runtime.tasks.goal.get', { address })).goal.status, 'complete')
        assert.equal(requests, 3)
      } finally {
        release()
        if (address) await rpc('runtime.tasks.goal.clear', { address })
        active = false
      }
    },
  }
}
