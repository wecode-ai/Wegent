import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { CLOUD_DEVICE_ID } from './shared.mjs'
import { openComposerPluginPicker } from './conversation-layout.mjs'
import { holdPluginWriteLease } from './plugin-write-lease.mjs'
import {
  accountPlugin,
  assertInstallButton,
  assertInventory,
  assertSurfaces,
  materializedPlugin,
  openPlugin,
  pluginApi,
  testId,
  until,
} from './plugin-regression-fixture.mjs'

export async function verifyPluginWriteCoordination({
  cloud,
  control,
  apiProxy,
  deviceProxy,
  localDeviceId,
  evidence,
  timeoutMs,
}) {
  const publish = slug =>
    cloud.publishPluginRelease({ slug, version: '1.0.0', skills: { [slug]: slug } })
  const startInstall = (item, deviceId) =>
    fetch(
      `${apiProxy.url}/api/plugins/marketplace/${item.pluginId}/install?device_id=${encodeURIComponent(deviceId)}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${cloud.authToken}` },
        signal: AbortSignal.timeout(timeoutMs),
      }
    ).then(
      response => ({ response }),
      error => ({ error })
    )
  const installResponse = async pending => {
    const outcome = await pending
    if (outcome.error) throw outcome.error
    return outcome.response
  }
  const refreshSurfaces = async item => {
    await openPlugin(control, item)
    await control.command('click', testId('plugins-refresh-button'))
    await control.command('waitFor', testId(`plugin-marketplace-actions-${item.pluginId}`), {
      timeoutMs,
    })
    // The composer catalog loads only when its real picker is opened.
    await control.command('click', testId('new-chat-button'))
    await openComposerPluginPicker(control)
    await assertInventory(control, item.slug, true)
    await control.command('click', testId('composer-plugin-picker-button'))
    await openPlugin(control, item)
    await assertSurfaces(control, item, true)
  }

  const responsive = {
    ...(await publish('coordination-e2e-responsive')),
    slug: 'coordination-e2e-responsive',
  }
  await openPlugin(control, responsive)
  await control.command('click', testId('plugins-refresh-button'))
  await assertInstallButton(control, responsive)
  let lease = await holdPluginWriteLease(cloud)
  let pending
  try {
    pending = startInstall(responsive, localDeviceId)
    await lease.waitFor('contended')
    const startedAt = Date.now()
    // Bypass Rust's liveness handler: this must share the Python ASGI loop
    // with the contended plugin install. The real lease remains held.
    const health = await fetch(`http://127.0.0.1:${cloud.pythonBackendPort}/health`, {
      signal: AbortSignal.timeout(1000),
    })
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { status: 'healthy' })
    const healthResponseMs = Date.now() - startedAt
    assert.ok(healthResponseMs < 1000, 'Plugin contention stalled the Python event loop')
    const response = await installResponse(pending)
    assert.equal(response.status, 503, 'A precommit lock conflict must reject the install')
    assert.equal((await response.json()).detail, 'plugin_write_busy')
    assert.equal(await accountPlugin(cloud, responsive.slug), undefined)
    evidence.push({ case: 'plugin-write-contention-keeps-asgi-responsive', healthResponseMs })
  } finally {
    await lease.release()
    if (pending) await pending
  }
  await control.command(
    'clickWhenEnabled',
    testId(`plugin-marketplace-install-${responsive.pluginId}`)
  )
  await control.command('waitFor', testId('install-plugin-dialog-confirm'))
  await control.command('clickWhenEnabled', testId('install-plugin-dialog-confirm'))
  await until(
    () => accountPlugin(cloud, responsive.slug),
    Boolean,
    'A user retry did not install after the lease was released'
  )
  await until(
    () =>
      apiProxy.requests.filter(
        request =>
          request.method === 'POST' &&
          request.path === `/api/plugins/marketplace/${responsive.pluginId}/install`
      ),
    requests => requests.length === 2 && requests[1].status === 200,
    'The explicit user retry did not finish its real install request',
    timeoutMs
  )
  await refreshSurfaces(responsive)

  const acknowledged = { ...(await publish('coordination-e2e-ack')), slug: 'coordination-e2e-ack' }
  const remoteHome = dirname(cloud.remoteCodexHome)
  let installedId
  lease = null
  pending = null
  // Let the real Executor receive and materialize the new package, while its
  // acknowledgement waits in the transport rather than being synthesized.
  deviceProxy.pauseDeviceAcknowledgements(true)
  try {
    pending = startInstall(acknowledged, CLOUD_DEVICE_ID)
    const committed = await until(
      () => accountPlugin(cloud, acknowledged.slug),
      Boolean,
      'Install never committed account membership before the device acknowledgement'
    )
    installedId = Number(committed.metadata.labels.id)
    await until(
      () => materializedPlugin(remoteHome, installedId),
      plugin => Boolean(plugin?.runtime?.codex_link),
      'The real remote Executor did not materialize the committed install',
      timeoutMs
    )
    lease = await holdPluginWriteLease(cloud)
    deviceProxy.pauseDeviceAcknowledgements(false)
    await lease.waitFor('contended')
    const response = await installResponse(pending)
    assert.equal(
      response.status,
      200,
      'A device ACK conflict misreported a committed install as failed'
    )
    const result = await response.json()
    assert.equal(Number(result.plugin.metadata.labels.id), installedId)
    assert.equal(result.plugin.spec.releaseId, acknowledged.releaseId)
    assert.equal(result.sync.success, false, 'Deferred acknowledgement must be explicit')
    assert.ok(
      result.sync.errors.some(
        error => error.code === 'plugin_write_busy' && error.stage === 'global_ack'
      ),
      'The committed response omitted the acknowledgement coordination error'
    )
    assert.ok(await accountPlugin(cloud, acknowledged.slug))
    evidence.push({
      case: 'committed-install-survives-device-ack-contention',
      installedId,
      status: response.status,
      errors: result.sync.errors,
    })
  } finally {
    deviceProxy.pauseDeviceAcknowledgements(false)
    await lease?.release()
    if (pending) await pending
  }
  await refreshSurfaces(acknowledged)
  for (const deviceId of [CLOUD_DEVICE_ID, localDeviceId]) {
    const recovered = await pluginApi(
      cloud,
      `/plugins/installed/${installedId}/sync-device?device_id=${encodeURIComponent(deviceId)}`,
      'POST'
    )
    assert.equal(recovered.sync.success, true, 'A later real sync did not recover the deferred ACK')
  }
  const rows = await cloud.queryDatabase(
    'SELECT state, actual_release_id, desired_release_id FROM plugin_device_installations WHERE user_id = %s AND installed_kind_id = %s AND device_id = %s',
    [1, installedId, CLOUD_DEVICE_ID]
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].state, 'installed')
  assert.equal(rows[0].actual_release_id, acknowledged.releaseId)
  assert.equal(rows[0].desired_release_id, acknowledged.releaseId)
  await refreshSurfaces(acknowledged)
  evidence.push({ case: 'deferred-plugin-ack-recovers-on-next-sync', installedId })
}
