import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { commandOutput, REMOTE_DOCKER_DEVICE_ID } from './shared.mjs'
import { until } from './plugin-regression-fixture.mjs'
import { holdDeviceRegistrationRow } from './plugin-write-lease.mjs'

export async function verifyCloudRegistrationDeletionRace(cloud, recordId, ownerId, document) {
  const startedAt = Date.now()
  const identityLocked = () =>
    commandOutput('redis-cli', [
      '-h',
      '127.0.0.1',
      '-p',
      String(cloud.redisPort),
      '--raw',
      'EXISTS',
      `device:identity-lock:${ownerId}`,
    ]).trim() === '1'
  const originalSpec = document.spec
  let rowLock
  let deletion
  try {
    await cloud.executeDatabase(
      'UPDATE kinds SET json=JSON_SET(json, %s, JSON_EXTRACT(%s, %s)) WHERE id=%s AND user_id=%s AND kind=%s AND namespace=%s',
      [
        '$.spec',
        JSON.stringify({
          ...originalSpec,
          deviceType: 'cloud',
          cloudConfig: { deviceId: REMOTE_DOCKER_DEVICE_ID, sandboxId: REMOTE_DOCKER_DEVICE_ID },
        }),
        '$',
        recordId,
        ownerId,
        'Device',
        'default',
      ]
    )
    rowLock = await holdDeviceRegistrationRow(cloud, ownerId, recordId)
    await until(identityLocked, locked => !locked, 'A previous registration retained its lock')
    cloud.remoteDockerExecutor = await cloud.spawnExecutor(
      { ...cloud.remoteDockerExecutorEnv, DEVICE_TYPE: 'cloud' },
      cloud.remoteDockerExecutorLogPath
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
    await cloud.waitForDeviceStatus(
      REMOTE_DOCKER_DEVICE_ID,
      'online',
      cloud.remoteDockerExecutorLogPath
    )
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
    if (cloud.remoteDockerExecutor) await cloud.stopRemoteDockerExecutorAndWaitOffline()
    await cloud.executeDatabase(
      'UPDATE kinds SET json=JSON_SET(json, %s, JSON_EXTRACT(%s, %s)) WHERE id=%s AND user_id=%s AND kind=%s AND namespace=%s',
      ['$.spec', JSON.stringify(originalSpec), '$', recordId, ownerId, 'Device', 'default']
    )
  }
}
