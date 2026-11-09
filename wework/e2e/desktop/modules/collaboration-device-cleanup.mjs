import assert from 'node:assert/strict'
import { REMOTE_DOCKER_DEVICE_ID } from './shared.mjs'
import { verifyCloudRegistrationDeletionRace } from './collaboration-device-registration-race.mjs'

// Exercise the existing real runner and database; legacy rows are persisted fixtures.
export async function verifyCollaborationDeviceCleanup({
  cloud,
  control,
  scoped,
  timeoutMs,
  capture,
}) {
  const request = async (path, options = {}) => {
    const response = await fetch(`${cloud.backendUrl}${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${cloud.authToken}`, ...options.headers },
    })
    const body = await response.json()
    assert.ok(response.ok, `${path}: HTTP ${response.status} ${JSON.stringify(body)}`)
    return body
  }
  const original = (await request('/api/devices')).items.find(
    device => device.device_id === REMOTE_DOCKER_DEVICE_ID
  )
  assert.ok(original?.last_seen_at, 'Real Executor registration did not persist its online time')
  const ownerId = (await request('/api/users/me')).id
  const snapshot = await cloud.queryDatabase('SELECT json FROM kinds WHERE id = %s', [original.id])
  const originalDocument =
    typeof snapshot[0].json === 'string' ? JSON.parse(snapshot[0].json) : snapshot[0].json
  assert.ok(
    originalDocument.status?.lastSeenAt,
    'The online time exists only in the expiring cache'
  )

  const ids = []
  for (const suffix of ['history', 'unknown']) {
    const name = `device-cleanup-${process.pid}-${suffix}`
    const document = {
      apiVersion: 'agent.wecode.io/v1',
      kind: 'Device',
      metadata: { name, namespace: 'default' },
      spec: {
        deviceId: name,
        deviceType: 'app',
        displayName: original.name,
        runtimeInstanceId: `runtime-${name}`,
        appDeviceId: `electron-device-cleanup-${process.pid}`,
        bindShell: 'claudecode',
      },
      status: suffix === 'history' ? { lastSeenAt: '2026-01-02T03:04:05+00:00' } : {},
    }
    await cloud.executeDatabase(
      'INSERT INTO kinds (user_id, kind, name, namespace, json, is_active, created_at, updated_at) VALUES (%s, %s, %s, %s, %s, 1, NOW(), NOW())',
      [ownerId, 'Device', name, 'default', JSON.stringify(document)]
    )
    const rows = await cloud.queryDatabase(
      'SELECT id FROM kinds WHERE user_id = %s AND name = %s AND kind = %s AND namespace = %s',
      [ownerId, name, 'Device', 'default']
    )
    ids.push(rows[0].id)
  }
  const [historyId, unknownId] = ids
  const space = (await request('/api/v1/workspaces')).items.find(
    workspace => workspace.access_role === 'Owner'
  )
  assert.ok(space?.id, 'The shared checkpoint did not prepare an owned workspace')
  await request(`/api/v1/workspaces/${space.id}/execution-environments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: historyId }),
  })
  assert.ok(
    (await request('/api/devices')).items
      .find(device => device.id === historyId)
      .workspace_ids.includes(String(space.id))
  )
  await control.command('click', scoped('[data-testid="collaboration-primary-home"]'))
  await control.command('click', scoped('[data-testid="collaboration-primary-devices"]'))
  for (const id of ids)
    await control.command('waitFor', scoped(`[data-testid="collaboration-devices-delete-${id}"]`), {
      timeoutMs,
    })
  assert.match(
    await control.command(
      'getText',
      scoped(`[data-testid="collaboration-device-last-seen-${unknownId}"]`)
    ),
    /暂无记录|No record/
  )
  assert.doesNotMatch(
    await control.command(
      'getText',
      scoped(`[data-testid="collaboration-device-last-seen-${historyId}"]`)
    ),
    /暂无记录|No record/
  )
  assert.equal(
    Number(
      await control.command(
        'getElementCount',
        scoped(`[data-testid="collaboration-devices-delete-${original.id}"]`)
      )
    ),
    0,
    'Online runner offered deletion'
  )

  await capture?.('collaboration-device-cleanup-catalog.png')
  const onlineDelete = await fetch(
    `${cloud.backendUrl}/api/devices/records/${original.id}?offline_only=true`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${cloud.authToken}` },
    }
  )
  assert.equal(onlineDelete.status, 409, 'The server accepted deletion of a live runner')
  await control.command(
    'click',
    scoped(`[data-testid="collaboration-devices-delete-${historyId}"]`)
  )
  assert.ok(
    (
      await control.command('getText', scoped('[data-testid="collaboration-delete-device-dialog"]'))
    ).includes(space.name),
    'The removal confirmation omitted the affected workspace'
  )
  await capture?.('collaboration-device-cleanup-confirm.png')
  await control.command('click', scoped('[data-testid="collaboration-delete-device-cancel"]'))
  assert.equal(
    (await cloud.queryDatabase('SELECT is_active FROM kinds WHERE id = %s', [historyId]))[0]
      .is_active,
    1
  )
  await control.command(
    'click',
    scoped(`[data-testid="collaboration-devices-delete-${historyId}"]`)
  )
  await control.command('click', scoped('[data-testid="collaboration-delete-device-confirm"]'))
  await control.command(
    'waitFor',
    scoped(`[data-testid="collaboration-devices-row-${historyId}"]`),
    { visible: false, timeoutMs }
  )
  assert.equal(
    (await cloud.queryDatabase('SELECT is_active FROM kinds WHERE id = %s', [historyId]))[0]
      .is_active,
    0
  )
  assert.equal(
    (await cloud.queryDatabase('SELECT is_active FROM kinds WHERE id = %s', [unknownId]))[0]
      .is_active,
    1
  )
  assert.equal(
    (await request('/api/devices')).items.some(device => device.id === historyId),
    false
  )

  assert.equal(
    (await request(`/api/v1/workspaces/${space.id}/execution-environments`)).items.some(
      device => device.device_id === historyId
    ),
    false,
    'A removed registration remained selectable in its workspace'
  )

  const observedBeforeDisconnect = (await request('/api/devices')).items.find(
    device => device.id === original.id
  ).last_seen_at
  await cloud.stopRemoteDockerExecutorAndWaitOffline()
  const offline = (await request('/api/devices')).items.find(device => device.id === original.id)
  assert.equal(offline.status, 'offline')
  assert.ok(offline.last_seen_at, 'The last online time disappeared after disconnection')
  assert.ok(Date.parse(offline.last_seen_at) >= Date.parse(original.last_seen_at))
  const persistedOffline = (
    await cloud.queryDatabase('SELECT json FROM kinds WHERE id = %s', [original.id])
  )[0].json
  const offlineDocument =
    typeof persistedOffline === 'string' ? JSON.parse(persistedOffline) : persistedOffline
  assert.ok(
    Date.parse(offlineDocument.status.lastSeenAt) >= Date.parse(observedBeforeDisconnect),
    'The final real heartbeat was not persisted before the online cache was removed'
  )
  await verifyCloudRegistrationDeletionRace(cloud, ownerId)
  await control.command('click', scoped('[data-testid="collaboration-primary-home"]'))
  await control.command('click', scoped('[data-testid="collaboration-primary-devices"]'))
  await control.command(
    'waitFor',
    scoped(`[data-testid="collaboration-devices-delete-${original.id}"]`),
    { timeoutMs }
  )
  await control.command(
    'click',
    scoped(`[data-testid="collaboration-devices-delete-${original.id}"]`)
  )
  cloud.remoteDockerExecutor = await cloud.spawnExecutor(
    cloud.remoteDockerExecutorEnv,
    cloud.remoteDockerExecutorLogPath
  )
  await cloud.waitForDeviceStatus(
    REMOTE_DOCKER_DEVICE_ID,
    'online',
    cloud.remoteDockerExecutorLogPath
  )
  await control.command('click', scoped('[data-testid="collaboration-delete-device-confirm"]'))
  const error = scoped('[data-testid="collaboration-delete-device-dialog"] [role="alert"]')
  await control.command('waitFor', error, { visible: true, timeoutMs })
  assert.match(await control.command('getText', error), /设备已上线|device is online/)
  assert.equal(
    (await cloud.queryDatabase('SELECT is_active FROM kinds WHERE id = %s', [original.id]))[0]
      .is_active,
    1
  )
  await control.command('click', scoped('[data-testid="collaboration-delete-device-cancel"]'))
  // Remove the remaining isolated legacy fixture through the production endpoint.
  await request(`/api/devices/records/${unknownId}?offline_only=true`, { method: 'DELETE' })
  console.log(
    '[desktop-e2e] PASS device-cleanup: record isolation, cancel, workspace removal, persistent heartbeat and reconnect conflict'
  )
}
