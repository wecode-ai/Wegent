import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { CLOUD_DEVICE_ID, commandOutput, redisCliBinary, stopProcessGroup } from './shared.mjs'
import { until } from './plugin-regression-fixture.mjs'
import { holdDeviceRegistrationRow } from './plugin-write-lease.mjs'

export async function verifyCloudRegistrationDeletionRace(cloud, ownerId) {
  const startedAt = Date.now()
  const original = await cloud.device(CLOUD_DEVICE_ID)
  assert.equal(original?.status, 'online', 'The real cloud fixture must start online')
  assert.ok(
    original.runtime_instance_id,
    'The cloud fixture must have a persisted runtime identity'
  )
  const recordId = original.id
  await stopProcessGroup(cloud.remoteExecutor)
  cloud.remoteExecutor = null
  await cloud.waitForDeviceStatus(CLOUD_DEVICE_ID, 'offline', cloud.remoteExecutorLogPath)

  const identityLocked = () =>
    commandOutput(redisCliBinary(), [
      '-h',
      '127.0.0.1',
      '-p',
      String(cloud.redisPort),
      '--raw',
      'EXISTS',
      `device:identity-lock:${ownerId}`,
    ]).trim() === '1'
  let rowLock
  let deletion
  try {
    rowLock = await holdDeviceRegistrationRow(cloud, ownerId, recordId)
    await until(identityLocked, locked => !locked, 'A previous registration retained its lock')
    cloud.remoteExecutor = await cloud.spawnExecutor(
      cloud.remoteExecutorEnv,
      cloud.remoteExecutorLogPath
    )
    await until(
      identityLocked,
      Boolean,
      'Cloud registration did not lock its database-to-online transition'
    )
    const requestId = `device-delete-race-${process.pid}-${recordId}`
    const response = fetch(
      `${cloud.backendUrl}/api/devices/records/${recordId}?offline_only=true`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${cloud.authToken}`, 'X-Request-ID': requestId },
        signal: AbortSignal.timeout(10_000),
      }
    )
    deletion = response.then(
      value => ({ value }),
      error => ({ error })
    )
    await until(
      () => readFile(cloud.backendLogPath, 'utf8'),
      log =>
        log.split('\n').some(line => line.includes(requestId) && line.includes('request : DELETE')),
      'The competing deletion never reached the real Python handler'
    )
    // This negative observation window proves removal cannot finish while registration is held.
    const completedWhileHeld = await Promise.race([
      deletion.then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), 200)),
    ])
    assert.equal(completedWhileHeld, false, 'Removal bypassed the in-flight cloud registration')
    assert.equal(
      identityLocked(),
      true,
      'Registration released its identity lock before publication'
    )
    await rowLock.release()
    const result = await deletion
    if (result.error) throw result.error
    assert.equal(
      result.value.status,
      409,
      'Removal accepted a cloud runner reconnecting concurrently'
    )
    const reconnected = await cloud.waitForDeviceStatus(
      CLOUD_DEVICE_ID,
      'online',
      cloud.remoteExecutorLogPath
    )
    assert.equal(reconnected.id, recordId, 'The cloud runner registered a different record')
    assert.equal(reconnected.runtime_instance_id, original.runtime_instance_id)
    const [persisted] = await cloud.queryDatabase(
      'SELECT is_active FROM kinds WHERE id=%s AND user_id=%s AND kind=%s AND namespace=%s',
      [recordId, ownerId, 'Device', 'default']
    )
    assert.equal(persisted.is_active, 1, 'An online cloud runner points at an inactive record')
    console.log(
      `[desktop-e2e] PASS device-cleanup-cloud-race: held registration, concurrent removal rejected, active online record preserved; durationMs=${Date.now() - startedAt}`
    )
  } finally {
    await rowLock?.release()
    if (deletion) await deletion
  }
}
