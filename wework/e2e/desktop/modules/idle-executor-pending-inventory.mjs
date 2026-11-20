import assert from 'node:assert/strict'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { waitForValue } from './collaboration-cloud-story-checks.mjs'
import { requestExecutor } from './executor-rpc.mjs'

export async function verifyPendingInventoryProjection(control, { executorHome, resultDir }) {
  const runtimeWork = join(executorHome, 'runtime-work')
  const indexPath = join(runtimeWork, 'index.json')
  const workspacePath = join(executorHome, 'pending-inventory-workspace')
  await mkdir(runtimeWork, { recursive: true })
  await mkdir(workspacePath, { recursive: true })
  const index = await readFile(indexPath, 'utf8').then(JSON.parse, error => {
    if (error.code !== 'ENOENT') throw error
    return { version: 1 }
  })
  assert.deepEqual(
    Object.keys(index.tasks ?? {}),
    [],
    'The pending inventory fixture must be isolated'
  )

  const entries = [
    ['inventory-ordinary', null, false],
    ['inventory-waiting', 'waitingForUserInput', false],
    ['inventory-reply', 'awaitingUserReply', false],
    ['inventory-archived', 'awaitingUserReply', true],
    ['inventory-ephemeral', 'awaitingUserReply', false, true],
  ]
  index.tasks = Object.fromEntries(
    entries.map(([id, status, archived, ephemeral = false]) => [
      id,
      {
        local_task_id: id,
        title: id,
        workspace_path: workspacePath,
        runtime: 'codex',
        archived,
        ephemeral,
        interaction_status: status,
      },
    ])
  )
  const temporaryIndex = join(runtimeWork, 'pending-inventory-fixture.json')
  await writeFile(temporaryIndex, JSON.stringify(index))
  await rename(temporaryIndex, indexPath)

  const logPath = join(resultDir, 'executor.log')
  const logOffset = (await readFile(logPath, 'utf8')).length
  const list = params => requestExecutor(control, 'runtime.tasks.list', params, 10_000)
  const taskIds = response =>
    response.workspaces.flatMap(row => row.tasks.map(task => task.taskId)).sort()
  const pending = await list({ preferCached: true, pendingOnly: true })
  assert.deepEqual(taskIds(pending), ['inventory-reply', 'inventory-waiting'])
  const finished = await waitForValue(
    async () =>
      (await readFile(logPath, 'utf8'))
        .slice(logOffset)
        .split('\n')
        .find(
          line =>
            line.includes('runtime work list finished') &&
            line.includes('pending_only=true') &&
            /\btasks=2\b/.test(line)
        ),
    Boolean,
    'Executor did not record the pending inventory request with two waiting tasks',
    10_000
  )
  assert.match(finished, /\bcandidate_tasks=2\b/, 'Unrelated tasks reached the summary stage')
  assert.deepEqual(taskIds(await list({ preferCached: true })), [
    'inventory-ordinary',
    'inventory-reply',
    'inventory-waiting',
  ])
}
