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

const PREFIX = 'WEWORK_OWNER_CONCURRENCY_'

export function createConcurrencyExecutionVerification({ workspacePath, uiTimeoutMs }) {
  const requested = new Set()
  const releases = new Map()
  const taskIds = []
  const rpc = (control, method, params) => requestExecutor(control, method, params, uiTimeoutMs)
  const promptFor = (kind, index) => `${PREFIX}${kind}_${index}`
  const taskIdFor = (kind, index) =>
    kind === 'standIn'
      ? `stand-in-chat-9001-role-concurrency-${index}`
      : `owner-concurrency-${kind}-${index}`
  const release = (kind, index) => releases.get(promptFor(kind, index))?.()
  return {
    async handleBody(body, response) {
      const text = JSON.stringify(body.input ?? [])
      const prompt = ['personal', 'standIn', 'agent']
        .flatMap(kind => [1, 2, 'followup'].map(index => promptFor(kind, index)))
        .map(value => ({ value, position: text.lastIndexOf(value) }))
        .filter(candidate => candidate.position >= 0)
        .sort((left, right) => right.position - left.position)[0]?.value
      if (!prompt) return false
      const id = `owner-concurrency-${requested.size}`
      const held = new Promise(resolve => releases.set(prompt, resolve))
      requested.add(prompt)
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      response.write(createSse([responseCreated(id)]))
      response.flushHeaders()
      await held
      if (!response.destroyed)
        response.end(createSse([assistantMessage(`${prompt}_DONE`), responseCompleted(id)]))
      return true
    },
    cleanup() {
      for (const resolve of releases.values()) resolve()
    },
    async verify(control) {
      const original = await rpc(control, 'runtime.settings.get', {})
      const settings = {
        maxConcurrentTasks: 1,
        maxConcurrentStandInTasks: 1,
        maxConcurrentAgentTasks: 1,
      }
      const capacity = () => rpc(control, 'runtime.capacity.get', {})
      const waitRequested = prompt =>
        waitForValue(
          async () => [...requested],
          values => values.includes(prompt),
          `No real model request for ${prompt}`,
          uiTimeoutMs
        )
      const catalog = await rpc(control, 'runtime.runner.catalog', {})
      const model = catalog.models.find(value => value.runtime === 'codex' && value.is_default)
      assert.ok(model, 'The concurrency fixture requires the configured real Codex model route')
      const personal = await rpc(control, 'runtime.stand_in.personal.get', { userId: 9001 })
      try {
        await rpc(control, 'runtime.stand_in.personal.save', {
          userId: 9001,
          settings: {
            ...personal,
            roles: [
              ...personal.roles,
              ...[1, 2].map(index => ({
                id: `concurrency-${index}`,
                name: `Concurrency ${index}`,
                enabled: true,
                prompt: '',
                executionDeviceId: personal.executionDeviceId,
                tags: [],
                collaboration: {
                  enabled: false,
                  allProjects: false,
                  projects: [],
                  excludedProjects: [],
                  tags: [],
                },
              })),
            ],
          },
        })
        await rpc(control, 'runtime.settings.update', settings)
        for (const kind of ['personal', 'standIn', 'agent']) {
          for (const index of [1, 2]) {
            const taskId = taskIdFor(kind, index)
            const prompt = promptFor(kind, index)
            const origin =
              kind === 'standIn'
                ? {
                    type: 'stand_in_identity',
                    initiatedBy: 'stand_in_identity',
                    userId: 9001,
                    deviceId: personal.executionDeviceId,
                    standInId: `concurrency-${index}`,
                  }
                : kind === 'agent'
                  ? { type: 'project_automation' }
                  : null
            taskIds.push(taskId)
            const created = await rpc(control, 'runtime.tasks.create', {
              taskId,
              title: prompt,
              runtime: 'codex',
              workspacePath,
              message: prompt,
              ...(index === 2 ? { origin } : {}),
              executionRequest: {
                task_id: taskId,
                subtask_id: `${taskId}-initial`,
                user_id: 9001,
                prompt,
                new_session: true,
                origin,
                bot: [{ shell_type: 'Codex', name: 'Concurrency verification' }],
                model_config: {
                  model_id: model.local_model_id,
                  model_provider: model.provider,
                  runtime_config: { codex: { use_user_config: true, configured: true } },
                },
              },
            })
            assert.equal(created.accepted, true)
            if (index === 1) await waitRequested(prompt)
            else {
              const state = await capacity()
              assert.equal(state.categories[kind].queued, 1)
              assert.equal(
                requested.has(prompt),
                false,
                'A saturated category started its second model turn'
              )
            }
          }
        }
        const full = await capacity()
        assert.equal(full.active, 3)
        assert.equal(full.queued, 3)
        for (const kind of ['personal', 'standIn', 'agent']) {
          assert.equal(full.categories[kind].active, 1)
          assert.equal(full.categories[kind].queued, 1)
        }
        release('standIn', 1)
        await waitRequested(promptFor('standIn', 2))
        assert.equal(requested.has(promptFor('personal', 2)), false)
        assert.equal(requested.has(promptFor('agent', 2)), false)
        await rpc(control, 'runtime.settings.update', { maxConcurrentAgentTasks: 2 })
        await waitRequested(promptFor('agent', 2))
        await rpc(control, 'runtime.settings.update', { maxConcurrentAgentTasks: 1 })
        const lowered = await capacity()
        assert.equal(
          lowered.categories.agent.active,
          2,
          'Lowering a limit interrupted an active task'
        )
        assert.equal(lowered.categories.personal.queued, 1)
        release('personal', 1)
        await waitRequested(promptFor('personal', 2))
        for (const kind of ['personal', 'standIn', 'agent'])
          for (const index of [1, 2]) release(kind, index)
        for (const taskId of taskIds)
          await waitForCompletedRuntimeTaskThread(control, taskId, uiTimeoutMs)
        await waitForValue(
          capacity,
          state => state.active === 0 && state.queued === 0,
          'Concurrency fixture did not settle',
          uiTimeoutMs
        )
        for (const kind of ['standIn', 'agent']) {
          const taskId = taskIdFor(kind, 1)
          const prompt = promptFor(kind, 'followup')
          const response = await rpc(control, 'runtime.tasks.send', {
            taskId,
            message: prompt,
            executionRequest: {
              task_id: taskId,
              subtask_id: `${taskId}-followup`,
              user_id: 9001,
              prompt,
              new_session: false,
              bot: [{ shell_type: 'Codex', name: 'Concurrency verification' }],
              model_config: {
                model_id: model.local_model_id,
                model_provider: model.provider,
                runtime_config: { codex: { use_user_config: true, configured: true } },
              },
            },
          })
          assert.equal(response.accepted, true)
          await waitRequested(prompt)
          const state = await capacity()
          assert.equal(
            state.categories[kind].active,
            1,
            'A follow-up lost its original execution owner'
          )
          assert.equal(
            state.categories.personal.active,
            0,
            'A background follow-up consumed personal capacity'
          )
          release(kind, 'followup')
          await waitForCompletedRuntimeTaskThread(control, taskId, uiTimeoutMs)
          await waitForValue(
            capacity,
            current => current.active === 0 && current.queued === 0,
            'The follow-up did not release its owner capacity',
            uiTimeoutMs
          )
        }
      } finally {
        for (const resolve of releases.values()) resolve()
        for (const taskId of taskIds) await rpc(control, 'runtime.tasks.cancel', { taskId })
        await rpc(control, 'runtime.settings.update', original)
        const current = await rpc(control, 'runtime.stand_in.personal.get', { userId: 9001 })
        await rpc(control, 'runtime.stand_in.personal.save', {
          userId: 9001,
          settings: { ...personal, version: current.version },
        })
      }
    },
  }
}
