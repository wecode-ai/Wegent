import assert from 'node:assert/strict'
import { requestExecutor } from './executor-rpc.mjs'
import { waitForValue } from './workspace-agent-setup.mjs'
import { waitForCompletedRuntimeTaskThread } from './runtime-task-evidence.mjs'
import {
  assistantMessage,
  createSse,
  responseCompleted,
  responseCreated,
} from './response-protocol.mjs'

const PREFIX = 'WEWORK_GOAL_CONCURRENCY_'

export function createGoalConcurrencyVerification({ workspacePath, uiTimeoutMs }) {
  const requests = []
  const replacementRequests = new Set()
  const releases = []
  const taskIds = ['goal-concurrency-owner', 'goal-concurrency-waiter']
  const rpc = (control, method, params) => requestExecutor(control, method, params, uiTimeoutMs)
  return {
    async handleBody(body, response) {
      const text = JSON.stringify(body.input ?? [])
      const taskId = taskIds.find(id => text.includes(`${PREFIX}${id}`))
      if (!taskId) return false
      const index = requests.length
      const held = new Promise(resolve => releases.push(resolve))
      requests.push(taskId)
      if (text.includes(`${PREFIX}${taskIds[0]}_replacement`)) replacementRequests.add(index)
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      response.write(createSse([responseCreated(`goal-concurrency-${index}`)]))
      response.flushHeaders()
      await held
      if (!response.destroyed)
        response.end(
          createSse([
            assistantMessage('Turn finished'),
            responseCompleted(`goal-concurrency-${index}`),
          ])
        )
      return true
    },
    cleanup() {
      for (const release of releases) release()
    },
    diagnostics() {
      return { requests, replacementRequests: [...replacementRequests] }
    },
    async verify(control) {
      const original = await rpc(control, 'runtime.settings.get', {})
      const catalog = await rpc(control, 'runtime.runner.catalog', {})
      const model = catalog.models.find(value => value.runtime === 'codex' && value.is_default)
      assert.ok(model)
      const capacity = () => rpc(control, 'runtime.capacity.get', {})
      const waitRequests = count =>
        waitForValue(
          async () => requests,
          current => current.length >= count,
          `Goal concurrency fixture did not reach ${count} model requests`,
          uiTimeoutMs
        )
      const submit = async (method, taskId, suffix, extra = {}) => {
        const prompt = `${PREFIX}${taskId}_${suffix}`
        const result = await rpc(control, method, {
          taskId,
          title: prompt,
          workspacePath,
          runtime: 'codex',
          message: prompt,
          executionRequest: {
            task_id: taskId,
            subtask_id: `${taskId}-${suffix}`,
            user_id: 9001,
            prompt,
            // Exercise policy reload while preserving native Goal continuation semantics.
            system_prompt: `Goal concurrency fixture ${suffix}`,
            new_session: method === 'runtime.tasks.create',
            bot: [{ shell_type: 'Codex', name: 'Goal concurrency verification' }],
            model_config: {
              model_id: model.local_model_id,
              model_provider: model.provider,
              runtime_config: { codex: { use_user_config: true, configured: true } },
            },
          },
          ...extra,
        })
        assert.equal(result.accepted, true)
        return result
      }
      try {
        await rpc(control, 'runtime.settings.update', { maxConcurrentTasks: 1 })
        await submit('runtime.tasks.create', taskIds[0], 'initial')
        await waitRequests(1)
        const goal = await rpc(control, 'runtime.tasks.goal.set', {
          taskId: taskIds[0],
          objective: `${PREFIX}${taskIds[0]}`,
          status: 'active',
        })
        assert.equal(goal.success, true)
        await submit('runtime.tasks.create', taskIds[1], 'initial')
        assert.equal((await capacity()).categories.personal.queued, 1)
        releases[0]()
        await waitRequests(2)
        assert.deepEqual(
          requests,
          [taskIds[0], taskIds[0]],
          'A Goal created during a turn released its slot while native continuation was still running'
        )
        const continuing = await capacity()
        assert.deepEqual(continuing.categories.personal.active_task_ids, [taskIds[0]])
        assert.equal(continuing.categories.personal.queued, 1)
        await waitForValue(
          () => rpc(control, 'runtime.tasks.running_count', {}),
          state => state.runningCount === 0,
          'Native continuation must retain capacity independently of local request control',
          uiTimeoutMs
        )
        const completed = await rpc(control, 'runtime.tasks.goal.set', {
          taskId: taskIds[0],
          status: 'complete',
        })
        assert.equal(completed.success, true)
        releases[1]()
        await waitRequests(3)
        assert.deepEqual(requests, [taskIds[0], taskIds[0], taskIds[1]])
        releases[2]()
        for (const taskId of taskIds)
          await waitForCompletedRuntimeTaskThread(control, taskId, uiTimeoutMs)
        await waitForValue(
          capacity,
          state => state.active === 0 && state.queued === 0,
          'Goal concurrency fixture did not release capacity',
          uiTimeoutMs
        )

        // Interrupting a Goal must not leave native work outside scheduler ownership.
        await submit('runtime.tasks.send', taskIds[0], 'goal', {
          initialGoal: { objective: `${PREFIX}${taskIds[0]}`, status: 'active' },
        })
        await waitRequests(4)
        await submit('runtime.tasks.send', taskIds[1], 'waiter')
        const interrupted = await submit(
          'runtime.tasks.interrupt_and_send',
          taskIds[0],
          'replacement'
        )
        assert.equal(interrupted.status, 'queued')
        await waitRequests(5)
        const expected = [taskIds[0], taskIds[0], taskIds[1], taskIds[0], taskIds[1]]
        // This observation window proves no native continuation races the held waiter.
        const deadline = Date.now() + 1000
        while (Date.now() < deadline) {
          assert.deepEqual(
            requests,
            expected,
            'An interrupted Goal continued outside the concurrency limit'
          )
          assert.deepEqual((await capacity()).categories.personal.active_task_ids, [taskIds[1]])
          await new Promise(resolve => setTimeout(resolve, 50))
        }
        releases[4]()
        await waitRequests(6)
        const finished = await rpc(control, 'runtime.tasks.goal.set', {
          taskId: taskIds[0],
          status: 'complete',
        })
        assert.equal(finished.success, true)
        // Cold resume may run the Goal before the explicitly submitted input.
        // Identify actual input delivery rather than assuming a platform's turn count.
        const replacementIndex = await waitForValue(
          async () => {
            for (let index = expected.length; index < requests.length; index++) {
              if (!replacementRequests.has(index)) releases[index]()
            }
            return [...replacementRequests].find(index => index >= expected.length)
          },
          index => typeof index === 'number',
          'The queued replacement input never reached the real model',
          uiTimeoutMs
        )
        assert.deepEqual(requests.slice(0, expected.length), expected)
        assert.ok(requests.slice(expected.length).every(taskId => taskId === taskIds[0]))
        assert.equal(
          replacementRequests.size,
          1,
          'The replacement input was submitted more than once'
        )
        assert.deepEqual((await capacity()).categories.personal.active_task_ids, [taskIds[0]])
        releases[replacementIndex]()
        for (const taskId of taskIds)
          await waitForCompletedRuntimeTaskThread(control, taskId, uiTimeoutMs)
        await waitForValue(
          capacity,
          state => state.active === 0 && state.queued === 0,
          'Interrupted Goal did not release capacity',
          uiTimeoutMs
        )
      } finally {
        for (const release of releases) release()
        for (const taskId of taskIds) {
          await rpc(control, 'runtime.tasks.goal.clear', { taskId })
          await rpc(control, 'runtime.tasks.cancel', { taskId })
        }
        await rpc(control, 'runtime.settings.update', original)
      }
    },
  }
}
