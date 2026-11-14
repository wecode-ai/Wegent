import { CLOUD_DEVICE_ID, DEFAULT_STEP_TIMEOUT_MS, assert, fetchJson } from './shared.mjs'
import { findOwnedRuntimeProject, findOwnedRuntimeTask } from './workspace-attachment-evidence.mjs'

// Exercise the cloud APIs used by Mobile's menu against the checkpoint's completed fixture.
// The shared cloud environment owns fixture teardown; this is protocol, not native UI, coverage.
export async function verifyCloudConversationMenu({ cloudEnvironment, address, workspacePath }) {
  const request = (path, body) =>
    fetchJson(`${cloudEnvironment.backendUrl}/api/runtime-work${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${cloudEnvironment.authToken}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(DEFAULT_STEP_TIMEOUT_MS),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const readTask = async () =>
    findOwnedRuntimeTask(await request(''), address.deviceId, address.taskId)
  assert.equal(
    address.deviceId,
    CLOUD_DEVICE_ID,
    'The menu fixture must belong to the cloud device'
  )
  assert.equal(
    address.workspacePath,
    workspacePath,
    'The menu fixture must use the isolated workspace'
  )
  const work = await request('')
  const initial = findOwnedRuntimeTask(work, address.deviceId, address.taskId)
  assert.ok(initial, 'The attachment fixture must exist before testing conversation mutations')
  assert.equal(initial.task.runtime, 'codex', 'The fixture must be a persisted Codex conversation')
  assert.notEqual(initial.task.optimistic, true, 'The menu fixture must be persisted')
  assert.notEqual(
    initial.task.workspaceKind,
    'worktree',
    'This fixture must not own a managed worktree'
  )
  assert.ok(!initial.task.worktreeId, 'This fixture must not require worktree deletion')
  const { projectWork } = findOwnedRuntimeProject(work, address.deviceId, workspacePath)
  const threadId = [
    initial.task.threadId,
    initial.task.runtimeHandle?.threadId,
    initial.task.runtimeHandle?.thread_id,
    initial.task.taskId,
  ]
    .find(value => typeof value === 'string' && value.trim())
    ?.trim()
  assert.ok(threadId, 'The persisted conversation must expose its runtime thread ID')
  const pinTarget = { deviceId: projectWork.project.stateDeviceId || address.deviceId, threadId }
  const taskAddress = { ...address, runtime: initial.task.runtime }

  const pinned = await request('/sidebar/tasks/pin', { ...pinTarget, pinned: true })
  assert.equal(pinned.accepted, true, pinned.error || 'Pinning the conversation failed')
  assert.equal((await readTask())?.task.pinned, true, 'A fresh work list must retain the pin')

  const title = `Mobile conversation menu ${address.taskId}`
  const renamed = await request('/rename', { address: taskAddress, title })
  assert.equal(renamed.accepted, true, renamed.error || 'Renaming the conversation failed')
  const afterRename = await readTask()
  assert.equal(afterRename?.task.title, title, 'A fresh work list must retain the new title')
  assert.equal(afterRename?.task.pinned, true, 'Renaming must preserve the pin')

  const unpinned = await request('/sidebar/tasks/pin', { ...pinTarget, pinned: false })
  assert.equal(unpinned.accepted, true, unpinned.error || 'Unpinning the conversation failed')
  assert.equal((await readTask())?.task.pinned, false, 'A fresh work list must retain the unpin')

  const archived = await request('/archived-conversations/archive', taskAddress)
  assert.equal(archived.accepted, true, archived.error || 'Archiving the conversation failed')
  assert.equal(
    await readTask(),
    undefined,
    'Archived conversations must leave the active work list'
  )
  const catalog = await request('/archived-conversations/list', {
    deviceId: address.deviceId,
    workspacePath,
    source: 'cloud',
  })
  const item = catalog.items.find(
    value => value.deviceId === address.deviceId && value.taskId === address.taskId
  )
  assert.ok(item, 'The archive catalog must contain the exact cloud conversation')
  assert.equal(item.title, title, 'The archive catalog must preserve the renamed title')
  assert.equal(item.workspacePath, workspacePath, 'Archiving must preserve workspace ownership')
}
