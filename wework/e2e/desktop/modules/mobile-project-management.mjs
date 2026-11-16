import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { loadMobileLocalPayloadBuilders } from './mobile-local-payload-builders.mjs'
import { until } from './plugin-regression-fixture.mjs'

export const PERSONAL_MANAGEMENT_METHODS = [
  'runtime.projects.upsert_local',
  'runtime.workspaces.rename',
  'runtime.workspaces.remove',
  'runtime.sidebar.projects.pin',
  'runtime.sidebar.tasks.pin',
  'runtime.tasks.rename',
  'runtime.tasks.archive',
  'runtime.archived_conversations.list',
  'runtime.archived_conversations.unarchive',
  'runtime.archived_conversations.delete',
]
const decode = value =>
  value?.encoding === 'gzip+base64+json'
    ? JSON.parse(gunzipSync(Buffer.from(value.payload, 'base64')).toString('utf8'))
    : value

// Reuses the real Backend, two APP installations and model-only fixture of remote-task-access.
export async function verifyMobileProjectManagement({ rpc, sourcePath, route, timeoutMs }) {
  const builders = await loadMobileLocalPayloadBuilders()
  const call = async (method, params) => {
    const response = await rpc(method, params)
    assert.equal(response.ok, true, `${method}: ${JSON.stringify(response.error)}`)
    const value = decode(response.result)
    assert.notEqual(value.accepted, false, `${method}: ${JSON.stringify(value)}`)
    if (method === 'runtime.tasks.archive') assert.ok(!value.cleanupError, value.cleanupError)
    return value
  }
  const read = async () =>
    builders.adaptRuntimeWorkListResponse(await call('runtime.tasks.list', {}), route)
  const projectKey = randomUUID()
  const project = { deviceId: route, projectKey, workspacePath: sourcePath, runtime: 'codex' }
  await call('runtime.projects.upsert_local', {
    deviceId: route,
    projectKey,
    name: 'Mobile management',
    roots: [sourcePath],
    runtime: 'codex',
  })
  await call('runtime.sidebar.projects.pin', { deviceId: route, projectKey, pinned: true })
  await call('runtime.workspaces.rename', { ...project, name: 'Renamed from mobile' })
  const work = await read()
  const group = work.projects.find(group => group.project.key === projectKey)
  assert.ok(group, 'Created project did not reach the production Mobile projection')
  assert.equal(group.project.name, 'Renamed from mobile')
  assert.equal(group.project.pinned, true)
  assert.equal(group.project.stateDeviceId, route)
  assert.deepEqual(group.project.roots, [{ kind: 'local', path: sourcePath }])
  await call('runtime.sidebar.projects.pin', { deviceId: route, projectKey, pinned: false })
  await call('runtime.workspaces.remove', project)
  assert.ok(!(await read()).projects.some(group => group.project.key === projectKey))
  await access(join(sourcePath, 'README.md'))

  const conversation = builders
    .flattenConversations(work)
    .find(item => !item.running && item.address.threadId)
  assert.ok(conversation, 'The existing checkpoint did not leave a completed conversation')
  const address = conversation.address
  const threadId = address.threadId
  await call('runtime.sidebar.tasks.pin', { deviceId: route, threadId, pinned: true })
  await call('runtime.tasks.rename', { address, title: 'Managed from mobile' })
  const renamed = builders
    .flattenConversations(await read())
    .find(item => item.address.taskId === address.taskId)
  assert.equal(renamed?.title, 'Managed from mobile')
  assert.equal(renamed?.pinned, true)
  await call('runtime.sidebar.tasks.pin', { deviceId: route, threadId, pinned: false })
  await call('runtime.tasks.archive', { ...address, cleanupWorktree: true })
  const archived = await call('runtime.archived_conversations.list', {})
  assert.ok(archived.items.some(item => item.taskId === address.taskId && item.deviceId === route))
  await call('runtime.archived_conversations.unarchive', address)
  assert.ok(
    builders.flattenConversations(await read()).some(item => item.address.taskId === address.taskId)
  )
  await call('runtime.tasks.archive', { ...address, cleanupWorktree: true })
  await call('runtime.archived_conversations.delete', address)
  await until(
    () => call('runtime.archived_conversations.list', {}),
    result => !result.items.some(item => item.taskId === address.taskId),
    'Permanent deletion did not finish',
    timeoutMs
  )
}
