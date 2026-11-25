import assert from 'node:assert/strict'
import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { until } from '../modules/plugin-regression-fixture.mjs'
import { runtimeTransportGates } from '../modules/runtime-transport-gates.mjs'
import { waitForCompletedRuntimeTaskThread } from '../modules/runtime-task-evidence.mjs'
import {
  ACTIVE_COMPOSER_SELECTOR,
  CHECKPOINT_TASK_COMPLETION_TEXT,
  CHECKPOINT_TASK_PROMPT,
  createSingleRootLocalProject,
  selectE2EModel,
} from '../modules/shared.mjs'
import { currentRuntimeTaskFromDebugSnapshot } from '../modules/workspace-flows.mjs'

export function createDesktopScenario({
  workspacePath,
  electronUserDataDirectory,
  uiTimeoutMs,
  modelResponseTimeoutMs,
}) {
  return {
    async verify(control) {
      await createSingleRootLocalProject(control, workspacePath, 'Bulk worktree archive')
      const tasks = []
      const filename = 'unsaved-bulk-archive.txt'
      control.setScenario('checkpoint_task')
      for (let index = 0; index < 3; index++) {
        if (index > 0) {
          await control.command('navigate', 'body', { value: '/' })
          await control.command('clickWhenEnabled', '[data-testid="new-chat-button"]')
        }
        await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR)
        await selectE2EModel(control)
        await control.command('click', '[data-testid="execution-mode-button"]')
        await control.command(
          'clickWhenEnabled',
          '[data-testid="execution-mode-git-worktree-button"]'
        )
        await control.command('fill', ACTIVE_COMPOSER_SELECTOR, {
          value: `${CHECKPOINT_TASK_PROMPT} Bulk archive fixture ${index + 1}.`,
        })
        await control.command('clickWhenEnabled', '[data-testid="send-message-button"]')
        await control.command('waitFor', '[data-testid="message-assistant"]', {
          text: CHECKPOINT_TASK_COMPLETION_TEXT,
          timeoutMs: modelResponseTimeoutMs,
        })
        const task = currentRuntimeTaskFromDebugSnapshot(
          JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
        )
        assert.ok(task?.taskId && task.workspacePath, 'The task must have an actual worktree')
        assert.notEqual(task.workspacePath, workspacePath)
        assert.ok(!tasks.some(previous => previous.workspacePath === task.workspacePath))
        await waitForCompletedRuntimeTaskThread(control, task.taskId, uiTimeoutMs)
        await writeFile(join(task.workspacePath, filename), task.taskId)
        tasks.push(task)
      }

      const gates = runtimeTransportGates(control)
      try {
        for (const task of tasks) {
          await gates.arm({
            id: task.taskId,
            kind: 'request',
            name: 'runtime.tasks.archive',
            where: [{ path: 'params.taskId', equals: task.taskId }],
          })
        }
        await control.command('clickWhenEnabled', '[data-testid="projects-section-menu"]')
        await control.command(
          'clickWhenEnabled',
          '[data-testid="projects-section-archive-all-chats"]'
        )
        await control.command(
          'clickWhenEnabled',
          '[data-testid="projects-section-archive-conversations-dialog-confirm-button"]'
        )
        const taskIds = tasks.map(task => task.taskId)
        const inFlight = await until(
          async () => (await Promise.all(taskIds.map(id => gates.read(id)))).map(Boolean),
          reached => reached.filter(Boolean).length === 2,
          'Two bulk archive requests did not reach the executor transport'
        )
        const transportLog = await readFile(
          join(electronUserDataDirectory, 'logs', 'executor-transport.log'),
          'utf8'
        )
        assert.equal(
          [
            ...transportLog.matchAll(
              /"method":"runtime\.tasks\.archive","stage":"background_queued"/g
            ),
          ].length,
          2,
          'The third bulk archive request must wait outside the transport queue'
        )
        await Promise.all(
          taskIds.filter((_, index) => inFlight[index]).map(id => gates.release(id))
        )
        const pending = taskIds.find((_, index) => !inFlight[index])
        assert.ok(pending)
        await gates.wait(pending)
        await gates.release(pending)
      } finally {
        await gates.reset()
      }

      await control.command('navigate', 'body', { value: '/settings/archived-conversations' })
      for (const task of tasks) {
        const suffix = `${task.deviceId}-${task.taskId}`.replace(/[^a-zA-Z0-9_-]/g, '-')
        await control.command('waitFor', `[data-testid="archived-unarchive-button-${suffix}"]`, {
          timeoutMs: uiTimeoutMs,
        })
        await until(
          async () => {
            try {
              await access(task.workspacePath)
              return false
            } catch (error) {
              if (error.code !== 'ENOENT') throw error
              return true
            }
          },
          removed => removed,
          `Archived worktree was not removed for ${task.taskId}`
        )
      }
      const task = tasks[0]
      const restored = await requestExecutor(
        control,
        'runtime.archived_conversations.unarchive',
        { taskId: task.taskId, workspacePath: task.workspacePath },
        uiTimeoutMs
      )
      assert.equal(restored.accepted, true, restored.error)
      assert.equal(await readFile(join(task.workspacePath, filename), 'utf8'), task.taskId)
    },
  }
}
