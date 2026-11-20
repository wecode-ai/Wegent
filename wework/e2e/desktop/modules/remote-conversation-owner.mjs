import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { withCloudRuntimeRequest } from './cloud-runtime-request.mjs'
import { CLOUD_COMPLETION_TEXT } from './shared.mjs'
import { waitForValue } from './workspace-agent-setup.mjs'

async function createOwnerFixture({ backendUrl, authToken }, ownerId) {
  const post = async (path, body) => {
    const response = await fetch(`${backendUrl}/api${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    assert.ok(response.ok, `Fixture request ${path} returned ${response.status}`)
    return response.json()
  }
  await post('/admin/setup-complete', {})
  const other = await post('/admin/users', {
    user_name: 'remote-device-other-owner',
    password: 'remote-device-fixture-only',
    role: 'user',
    auth_source: 'password',
  })
  assert.ok(Number.isSafeInteger(other.id) && other.id > 0)
  assert.notEqual(other.id, ownerId, 'The denial must use a distinct persisted account')
  return other.id
}

export async function verifyRemoteConversationOwnerRejection(
  cloudEnvironment,
  { deviceId, ownerId, taskId, apiLogPath }
) {
  const otherId = await createOwnerFixture(cloudEnvironment, ownerId)
  await withCloudRuntimeRequest(cloudEnvironment, async (request, requestAck) => {
    const taskIds = async () => {
      const { workspaces } = await request('runtime.tasks.list', {}, deviceId)
      return workspaces.flatMap(workspace => workspace.tasks.map(task => task.taskId)).sort()
    }
    const messages = async () => {
      const result = await request('runtime.tasks.transcript', { taskId, refresh: true }, deviceId)
      return result.messages
    }
    const [beforeTasks, beforeMessages] = await Promise.all([taskIds(), messages()])
    assert.ok(beforeTasks.includes(taskId), 'The remote task was missing from the baseline')
    assert.ok(
      JSON.stringify(beforeMessages).includes(CLOUD_COMPLETION_TEXT),
      'The remote transcript did not contain the authorized reply'
    )

    const logOffset = (await readFile(apiLogPath, 'utf8')).length
    // The Executor builds the conversation command from this explicit userId.
    const denied = await requestAck(
      'runtime.stand_in.conversation',
      {
        userId: otherId,
        commandId: randomUUID(),
        message: 'Denied remote owner message',
      },
      deviceId
    )
    assert.equal(denied.ok, false)
    assert.equal(denied.error?.code, 'permission_denied')
    assert.equal(denied.error?.message, 'The requested owner must match the connected account')
    await waitForValue(
      async () =>
        /\[API\] GET \/api\/devices\/runtime-owner 200 /.test(
          (await readFile(apiLogPath, 'utf8')).slice(logOffset)
        ),
      observed => observed,
      'Timed out waiting for the API key owner lookup after the denied remote message',
      5_000
    )
    const [afterTasks, afterMessages] = await Promise.all([taskIds(), messages()])
    assert.deepEqual(afterTasks, beforeTasks, 'The denied request changed the remote task list')
    assert.deepEqual(afterMessages, beforeMessages, 'The denied request changed the transcript')
    const rejectedTranscript = await requestAck(
      'runtime.tasks.transcript',
      { taskId: `stand-in-chat-${otherId}-primary`, identityOnly: true },
      deviceId
    )
    assert.equal(rejectedTranscript.ok, false)
    assert.equal(rejectedTranscript.error?.code, 'not_found')
  })
  console.log('[remote-device-onboarding] Cross-owner conversation rejected without side effects')
}
