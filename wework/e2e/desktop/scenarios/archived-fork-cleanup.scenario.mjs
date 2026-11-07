import assert from 'node:assert/strict'
import { createSingleRootLocalProject, selectE2EModel } from '../modules/shared.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { createSse, streamingTextEvents } from '../modules/response-protocol.mjs'
import {
  findRuntimeWorkTask,
  waitForCompletedRuntimeTaskThread,
} from '../modules/runtime-task-evidence.mjs'

const ACTIVE = '[data-workspace-tab-content][aria-hidden="false"]'
const INPUT = `${ACTIVE} [data-testid="chat-message-input"]`
const ANSWER = 'ARCHIVED_FORK_CLEANUP_READY'
const CHAIN_LENGTH = 5

function taskAddress(task) {
  return {
    deviceId: task.deviceId,
    taskId: task.taskId,
    workspacePath: task.workspacePath,
    threadId: task.threadId,
    title: task.title,
    runtimeHandle: task.runtimeHandle,
  }
}

async function waitForTask(control, taskId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const runtimeWork = JSON.parse(await control.command('getLocalRuntimeWork', 'body'))
    const task = findRuntimeWorkTask(runtimeWork, taskId)
    if (task?.threadId?.trim()) return task
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Executor did not expose forked task ${taskId} within ${timeoutMs}ms`)
}

async function waitForArchivedTasks(rpc, taskIds, present, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const archived = await rpc('runtime.archived_conversations.list', {})
    const archivedIds = new Set((archived.items ?? []).map(item => item.taskId))
    if (taskIds.every(taskId => archivedIds.has(taskId) === present)) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(
    `Archived task state did not settle for ${taskIds.join(', ')} within ${timeoutMs}ms`
  )
}

async function latestTurnId(rpc, task) {
  const mappedTurnIds = Object.values(task.runtimeHandle?.turnIdsBySubtask ?? {}).filter(
    value => typeof value === 'string' && value.trim()
  )
  if (mappedTurnIds.length > 0) return mappedTurnIds.at(-1)
  const transcript = await rpc('runtime.tasks.transcript', { taskId: task.taskId })
  assert.equal(transcript.success, true, 'The executor must read the real Codex transcript')
  assert.ok(Array.isArray(transcript.turns) && transcript.turns.length > 0)
  const turnId = transcript.turns.at(-1)?.id
  assert.equal(typeof turnId, 'string', 'The Codex transcript must expose a turn ID')
  return turnId
}

export function createDesktopScenario({ workspacePath, uiTimeoutMs, modelResponseTimeoutMs }) {
  return {
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      for await (const _chunk of request) {
        /* Drain the real model request. */
      }
      const events = streamingTextEvents(`archive-fork-${Date.now()}`, ANSWER, 'final_answer')
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.end(createSse([...events.start, ...events.finish]))
      return true
    },
    async verify(control) {
      const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
      await createSingleRootLocalProject(control, workspacePath, '归档分叉清理验证')
      await control.command('waitFor', INPUT)
      await selectE2EModel(control)
      await control.command('fill', INPUT, { value: 'Reply ARCHIVED_FORK_CLEANUP_READY.' })
      await control.command('press', INPUT, { key: 'Enter' })
      await control.command('waitFor', `${ACTIVE} [data-testid="message-assistant"]`, {
        text: ANSWER,
        timeoutMs: modelResponseTimeoutMs,
      })

      const debug = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
      const selected = debug.workbench.currentRuntimeTask
      const threadId = await waitForCompletedRuntimeTaskThread(
        control,
        selected.taskId,
        uiTimeoutMs
      )
      const rootTask = await waitForTask(control, selected.taskId, uiTimeoutMs)
      const chain = [
        {
          deviceId: selected.deviceId,
          taskId: rootTask.taskId,
          workspacePath: rootTask.workspacePath,
          threadId,
          title: rootTask.title,
          runtimeHandle: rootTask.runtimeHandle,
        },
      ]
      const forkTurnId = await latestTurnId(rpc, rootTask)

      for (let index = 1; index < CHAIN_LENGTH; index += 1) {
        const source = chain.at(-1)
        const fork = await rpc('runtime.tasks.fork_at_turn', {
          ...taskAddress(source),
          lastTurnId: forkTurnId,
          title: `Archived fork ${index}`,
        })
        assert.equal(fork.accepted, true, JSON.stringify(fork))
        assert.equal(fork.setupError ?? null, null, JSON.stringify(fork))
        const targetTask = await waitForTask(control, fork.target.taskId, uiTimeoutMs)
        assert.equal(
          targetTask.parent?.taskId,
          source.taskId,
          'Each real Codex fork must reference the previous thread'
        )
        chain.push({
          deviceId: selected.deviceId,
          taskId: targetTask.taskId,
          workspacePath: targetTask.workspacePath,
          threadId: targetTask.threadId,
          title: targetTask.title,
          runtimeHandle: targetTask.runtimeHandle,
        })
      }
      assert.equal(new Set(chain.map(task => task.taskId)).size, CHAIN_LENGTH)

      const firstFour = chain.slice(0, -1)
      for (const task of firstFour) {
        assert.equal((await rpc('runtime.tasks.archive', task)).accepted, true)
      }
      await waitForArchivedTasks(
        rpc,
        firstFour.map(task => task.taskId),
        true,
        uiTimeoutMs
      )

      await control.command('navigate', 'body', { value: '/settings/archived-conversations' })
      const parentSuffix = `${chain[0].deviceId}-${chain[0].taskId}`.replace(/[^a-zA-Z0-9_-]/g, '-')
      const parentDelete = `[data-testid="archived-delete-button-${parentSuffix}"]`
      await control.command('waitFor', parentDelete)
      await control.command('click', parentDelete)
      await control.command(
        'click',
        '[data-testid="archived-delete-confirm-dialog-confirm-button"]'
      )
      await control.command('waitFor', '[data-testid="archived-operation-error"]', {
        text: 'forked history still references it',
        timeoutMs: uiTimeoutMs,
      })
      await waitForArchivedTasks(rpc, [chain[0].taskId], true, uiTimeoutMs)
      assert.equal(
        Number(await control.command('getElementCount', parentDelete)),
        1,
        'An archive still referenced by an undeleted fork must remain visible'
      )

      assert.equal((await rpc('runtime.tasks.archive', chain.at(-1))).accepted, true)
      await waitForArchivedTasks(
        rpc,
        chain.map(task => task.taskId),
        true,
        uiTimeoutMs
      )
      const deleted = await rpc('runtime.archived_conversations.delete_bulk', {
        items: chain.map(taskAddress),
      })
      assert.equal(deleted.accepted, true, JSON.stringify(deleted))
      assert.equal(deleted.acceptedCount, CHAIN_LENGTH)

      const cleanupTimeoutMs = uiTimeoutMs + 20_000
      await waitForArchivedTasks(
        rpc,
        chain.map(task => task.taskId),
        false,
        cleanupTimeoutMs
      )
      await control.command('navigate', 'body', { value: '/' })
      await control.command('navigate', 'body', { value: '/settings/archived-conversations' })
      await control.command('waitFor', '[data-testid="archived-conversations-settings-page"]')
      assert.equal(
        Number(await control.command('getElementCount', parentDelete)),
        0,
        'The complete fork chain must be removed after batch cleanup'
      )
    },
  }
}
