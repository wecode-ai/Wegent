import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { testId } from '../modules/plugin-regression-fixture.mjs'
import { waitForCompletedRuntimeTaskThread } from '../modules/runtime-task-evidence.mjs'
import { runtimeTransportGates } from '../modules/runtime-transport-gates.mjs'
import {
  ACTIVE_COMPOSER_SELECTOR,
  CHECKPOINT_TASK_COMPLETION_TEXT,
  CHECKPOINT_TASK_PROMPT,
  createSingleRootLocalProject,
  selectE2EModel,
} from '../modules/shared.mjs'
import { currentRuntimeTaskFromDebugSnapshot } from '../modules/workspace-flows.mjs'

const archiveMethod = 'runtime.tasks.archive'
const taskRow = taskId => testId(`runtime-local-task-row-${taskId}`)

async function createArchiveTasks(control, workspacePath, uiTimeoutMs) {
  await createSingleRootLocalProject(control, workspacePath, 'Consecutive task archive')
  control.setScenario('checkpoint_task')
  const tasks = []
  for (let index = 0; index < 3; index++) {
    if (index > 0) {
      await control.command('navigate', 'body', { value: '/' })
      await control.command('clickWhenEnabled', testId('new-chat-button'))
    }
    await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR)
    await selectE2EModel(control)
    await control.command('fill', ACTIVE_COMPOSER_SELECTOR, {
      value: `${CHECKPOINT_TASK_PROMPT} Consecutive archive fixture ${index + 1}.`,
    })
    await control.command('clickWhenEnabled', testId('send-message-button'))
    await control.command('waitFor', testId('message-assistant'), {
      text: CHECKPOINT_TASK_COMPLETION_TEXT,
      timeoutMs: uiTimeoutMs,
    })
    const task = currentRuntimeTaskFromDebugSnapshot(
      JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
    )
    assert.ok(task?.taskId && task.deviceId, 'The archive fixture must have a runtime address')
    assert.ok(!tasks.some(previous => previous.taskId === task.taskId), 'Expected a new task')
    await waitForCompletedRuntimeTaskThread(control, task.taskId, uiTimeoutMs)
    tasks.push(task)
  }
  return tasks
}

export function createDesktopScenario({ workspacePath, electronUserDataDirectory, uiTimeoutMs }) {
  return {
    async verify(control) {
      const tasks = await createArchiveTasks(control, workspacePath, uiTimeoutMs)
      const [first, second, third] = tasks.map(task => task.taskId)
      const logPath = join(electronUserDataDirectory, 'logs', 'executor-transport.log')
      const countTransportEnqueues = async () =>
        [
          ...(await readFile(logPath, 'utf8')).matchAll(
            /"method":"runtime\.tasks\.archive","stage":"background_queued"/g
          ),
        ].length
      const initialEnqueues = await countTransportEnqueues()
      const gates = runtimeTransportGates(control)

      try {
        for (const { taskId } of tasks) {
          await gates.arm({
            id: taskId,
            kind: 'request',
            name: archiveMethod,
            where: [{ path: 'params.taskId', equals: taskId }],
          })
        }
        for (const { taskId } of tasks) {
          await control.command('hover', taskRow(taskId))
          await control.command('clickWhenEnabled', testId(`runtime-local-task-archive-${taskId}`))
          await control.command('waitFor', testId(`runtime-local-task-archive-toast-${taskId}`), {
            visible: true,
          })
        }
        await gates.wait(first)
        await gates.wait(second)
        // The third undo window has elapsed while both requests are still held.
        await control.command('waitFor', testId(`runtime-local-task-archive-toast-${third}`), {
          visible: false,
          stableMs: 300,
        })
        assert.equal(
          (await countTransportEnqueues()) - initialEnqueues,
          2,
          'The third sidebar archive must wait outside the transport queue'
        )
        await gates.release(first)
        await gates.wait(third)
        await gates.release(third)
        await gates.release(second)
      } finally {
        await gates.reset()
      }

      for (const { taskId } of tasks) {
        await control.command('waitFor', taskRow(taskId), { visible: false })
      }
      await control.command('navigate', 'body', { value: '/settings/archived-conversations' })
      for (const { deviceId, taskId } of tasks) {
        const suffix = `${deviceId}-${taskId}`.replace(/[^a-zA-Z0-9_-]/g, '-')
        await control.command('waitFor', testId(`archived-unarchive-button-${suffix}`))
      }
    },
  }
}
