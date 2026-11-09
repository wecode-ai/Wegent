import assert from 'node:assert/strict'
import { requestExecutor } from './executor-rpc.mjs'
import { runtimeTransportGates } from './runtime-transport-gates.mjs'
import { waitForValue } from './workspace-agent-setup.mjs'
import { waitForCompletedRuntimeTaskThread } from './runtime-task-evidence.mjs'
import {
  assistantMessage,
  createSse,
  responseCompleted,
  responseCreated,
} from './response-protocol.mjs'

const MARKER = 'WEWORK_BOARD_REFRESH_ISOLATION'
const TASK_ID = 'board-refresh-isolation'
const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const OBSERVATION_MS = 2_000

function boardReadRule(projectId) {
  return {
    id: 'board-refresh-read',
    kind: 'request',
    name: 'todos.list',
    where: [{ path: 'params.project_id', equals: projectId }],
    hold: false,
  }
}

// Observe real requests until initial loading and scheduled refreshes have drained.
async function waitForQuietBoard(gates, projectId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let quietSince = Date.now()
  await gates.arm(boardReadRule(projectId))
  while (Date.now() < deadline) {
    if (await gates.read('board-refresh-read')) {
      await gates.reset()
      await gates.arm(boardReadRule(projectId))
      quietSince = Date.now()
    } else if (Date.now() - quietSince >= OBSERVATION_MS) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail('The board never stopped issuing reads before the metadata update')
}

export function createBoardRefreshVerification({ workspacePath, uiTimeoutMs, resultDir }) {
  let release
  let requested = false
  const held = new Promise(resolve => {
    release = resolve
  })
  return {
    async handleBody(body, response) {
      if (!JSON.stringify(body.input ?? []).includes(MARKER)) return false
      requested = true
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      response.write(createSse([responseCreated(MARKER)]))
      response.flushHeaders()
      await held
      if (!response.destroyed) {
        response.end(createSse([assistantMessage('Finished'), responseCompleted(MARKER)]))
      }
      return true
    },
    cleanup() {
      release()
    },
    async verify(control) {
      const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
      const gates = runtimeTransportGates(control)
      const catalog = await rpc('runtime.runner.catalog', {})
      const model = catalog.models.find(value => value.runtime === 'codex' && value.is_default)
      assert.ok(model, 'The real Runtime must advertise its default Codex model')
      const created = await rpc('runtime.tasks.create', {
        taskId: TASK_ID,
        title: MARKER,
        workspacePath,
        runtime: 'codex',
        message: MARKER,
        executionRequest: {
          task_id: TASK_ID,
          subtask_id: `${TASK_ID}-initial`,
          user_id: 9001,
          prompt: MARKER,
          new_session: true,
          bot: [{ shell_type: 'Codex', name: MARKER }],
          model_config: {
            model_id: model.local_model_id,
            model_provider: model.provider,
            runtime_config: { codex: { use_user_config: true, configured: true } },
          },
        },
      })
      assert.equal(created.accepted, true)
      try {
        await waitForValue(
          async () => requested,
          Boolean,
          'The model request never started',
          uiTimeoutMs
        )
        const running = await waitForValue(
          () => rpc('runtime.tasks.get', { taskId: TASK_ID }),
          value => value.task?.executionState?.phase === 'running' && value.task,
          'The native task did not enter running state',
          uiTimeoutMs
        )
        const system = await rpc('runtime_tasks.system_context', {
          device_id: created.deviceId,
          task_id: TASK_ID,
        })
        assert.ok(system.loop_item_id, 'The task must have a real persisted My Tasks binding')
        const project = await rpc('projects.create', { name: `${MARKER} unrelated project` })

        for (const projectId of [project.id, 'default-work-items']) {
          await control.command('navigate', 'body', {
            value: `/todo?projectStore=local&projectId=${encodeURIComponent(projectId)}`,
          })
          const owner = projectId === project.id ? 'collaboration-root' : 'cloud-todo-workspace'
          await control.command('waitFor', `${CONTENT} [data-testid="${owner}"]`)
          if (projectId === 'default-work-items') {
            await control.command(
              'waitFor',
              `${CONTENT} [data-testid="cloud-todo-card-${system.loop_item_id}"]`
            )
          }
          await waitForQuietBoard(gates, projectId, uiTimeoutMs)
          await gates.arm({
            id: 'board-refresh-native-event',
            kind: 'event',
            name: 'runtime.turn.updated',
            where: [{ path: 'payload.taskId', equals: TASK_ID }],
          })
          const updated = await rpc('runtime.tasks.goal.set', {
            taskId: TASK_ID,
            objective: `${MARKER} ${projectId}`,
            status: 'active',
          })
          assert.equal(updated.success, true)
          const event = await gates.wait('board-refresh-native-event')
          const task = event.value.payload.data.task
          assert.equal(task.executionState.phase, 'running')
          assert.ok(BigInt(task.executionState.revision) > BigInt(running.executionState.revision))
          await gates.release('board-refresh-native-event')
          // The original native event is delivered, not fabricated or replaced.
          // Cover both immediate My Tasks reads and all 0/500/1500 ms project refreshes.
          const deadline = Date.now() + OBSERVATION_MS
          do {
            assert.equal(
              await gates.read('board-refresh-read'),
              null,
              `Unchanged execution status refreshed board ${projectId}`
            )
            await new Promise(resolve => setTimeout(resolve, 100))
          } while (Date.now() < deadline)
          await gates.save(resultDir, `board-refresh-${projectId}.json`, [
            'board-refresh-read',
            'board-refresh-native-event',
          ])
          await gates.reset()
        }

        const completedGoal = await rpc('runtime.tasks.goal.set', {
          taskId: TASK_ID,
          status: 'complete',
        })
        assert.equal(completedGoal.success, true)
        await gates.arm(boardReadRule('default-work-items'))
        release()
        await waitForCompletedRuntimeTaskThread(control, TASK_ID, uiTimeoutMs)
        await gates.wait('board-refresh-read')
        await control.command('waitFor', `${CONTENT} [data-testid="cloud-todo-column-in_review"]`, {
          text: MARKER,
        })
        const persisted = await rpc('todos.get', {
          project_id: 'default-work-items',
          task_id: system.loop_item_id,
        })
        assert.equal(
          persisted.status,
          'in_review',
          'Real completion must still persist Issue review'
        )
      } finally {
        release()
        await gates.reset()
        await rpc('runtime.tasks.goal.clear', { taskId: TASK_ID })
      }
    },
  }
}
