import assert from 'node:assert/strict'
import { pluginApi, until } from './plugin-regression-fixture.mjs'

function acknowledgedInstallations(rows, fixtures, deviceIds) {
  return fixtures.every(fixture =>
    deviceIds.every(deviceId => {
      const row = rows.find(
        row => Number(row.installed_kind_id) === fixture.installedId && row.device_id === deviceId
      )
      return (
        row?.state === 'installed' &&
        Number(row.actual_release_id) === fixture.releaseId &&
        Number(row.desired_release_id) === fixture.releaseId &&
        Boolean(row.last_sync_at)
      )
    })
  )
}

export async function cleanupPluginUpgradeFixtures(cloud, installations, timeoutMs = 10_000) {
  const [user, devices] = await Promise.all([
    pluginApi(cloud, '/users/me'),
    pluginApi(cloud, '/devices/online'),
  ])
  const fixtures = installations.map(({ plugin }) => ({
    installedId: Number(plugin.metadata.labels.id),
    releaseId: Number(plugin.spec.releaseId),
  }))
  const deviceIds = [
    ...new Set(
      devices.items.map(device =>
        device.device_type === 'app' ? device.execution_target_id : device.device_id
      )
    ),
  ]
  assert.ok(Number.isSafeInteger(user.id) && user.id > 0, 'Cleanup requires the fixture owner')
  assert.ok(
    fixtures.length > 0 && deviceIds.length > 0,
    'Cleanup requires fixtures and online devices'
  )
  assert.ok(
    deviceIds.every(id => typeof id === 'string' && id.length > 0),
    'Device routes are missing'
  )
  assert.ok(
    fixtures.every(({ installedId, releaseId }) =>
      [installedId, releaseId].every(id => Number.isSafeInteger(id) && id > 0)
    ),
    'Cleanup requires exact installation and release identities'
  )
  const placeholders = values => values.map(() => '%s').join(', ')
  const read = () =>
    cloud.queryDatabase(
      `SELECT installed_kind_id, device_id, state, actual_release_id, desired_release_id, last_sync_at
       FROM plugin_device_installations WHERE user_id = %s
       AND installed_kind_id IN (${placeholders(fixtures)}) AND device_id IN (${placeholders(deviceIds)})`,
      [user.id, ...fixtures.map(fixture => fixture.installedId), ...deviceIds]
    )
  // The install response acknowledges the initiating device; fanout is asynchronous.
  await until(
    read,
    rows => acknowledgedInstallations(rows, fixtures, deviceIds),
    'Parallel plugin fixtures did not finish installation on every online device before cleanup',
    timeoutMs
  )
  for (const { installedId } of fixtures) {
    const removed = await fetch(`${cloud.backendUrl}/api/plugins/installed/${installedId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${cloud.authToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
    assert.equal(removed.status, 204, `Fixture uninstall ${installedId} must return 204`)
    // A removal ACK deletes its device row; 204 only commits account removal.
    await until(
      read,
      rows => rows.every(row => Number(row.installed_kind_id) !== installedId),
      `Plugin fixture ${installedId} did not finish removal on every online device`,
      timeoutMs
    )
  }
}
