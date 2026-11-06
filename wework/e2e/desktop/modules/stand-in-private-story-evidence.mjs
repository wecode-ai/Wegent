import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Inspect only fixture-owned durable evidence; the public task API excludes execution profiles. */
export async function readStoryTaskEvidence(executorHome, taskId) {
  const index = JSON.parse(await readFile(join(executorHome, 'runtime-work/index.json'), 'utf8'))
  const task = index.tasks[taskId]
  if (!task) return null
  assert.equal(task.local_task_id, taskId)
  const handle = task.runtime_handle
  const completion = handle.standInResult
  const reportTo = completion?.generation?.reportTo
  const parentTaskId = completion?.generation?.delegation?.sourceTaskId
  return {
    taskId,
    threadId: task.thread_id,
    lastTurnId: handle.lastTurnId,
    completion: completion && {
      status: completion.status,
      turnId: completion.turnId,
      generation: {
        reportTo: reportTo ? { userId: reportTo.userId, taskId: reportTo.taskId } : reportTo,
        delegation: parentTaskId ? { sourceTaskId: parentTaskId } : null,
      },
    },
    receipt: handle.standInResultReceipt,
    delegation: {
      readSources: handle.executionRequest?.standInDelegation?.readSources?.map(source =>
        Object.fromEntries(['providerId', 'profile', 'kind', 'id'].map(key => [key, source[key]]))
      ),
    },
  }
}
