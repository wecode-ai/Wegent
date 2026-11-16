import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { CLOUD_DEVICE_ID } from './shared.mjs'
import { openComposerPluginPicker } from './conversation-layout.mjs'
import { holdPluginWriteLease } from './plugin-write-lease.mjs'
import { verifyConcurrentPluginPreparation } from './plugin-concurrent-preparation.mjs'
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
  packageProxy,
  localDeviceId,
  executorHome,
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
  const refreshSurfaces = async (item, present = true) => {
    await openPlugin(control, item)
    await control.command('clickWhenEnabled', testId('plugins-refresh-button'))
    if (present) {
      await control.command('waitFor', testId(`plugin-marketplace-actions-${item.pluginId}`), {
        timeoutMs,
      })
    } else {
      await assertInstallButton(control, item)
    }
    // The composer catalog loads only when its real picker is opened.
    await control.command('click', testId('new-chat-button'))
    await openComposerPluginPicker(control)
    await assertInventory(control, item.slug, present)
    await control.command('click', testId('composer-plugin-picker-button'))
    await openPlugin(control, item)
    await assertSurfaces(control, item, present)
  }

  await verifyCanonicalNameReactivation({
    cloud,
    control,
    apiProxy,
    executorHome,
    refreshSurfaces,
    evidence,
    timeoutMs,
  })

  const responsive = {
    ...(await publish('coordination-e2e-responsive')),
    slug: 'coordination-e2e-responsive',
  }
  await openPlugin(control, responsive)
  await control.command('clickWhenEnabled', testId('plugins-refresh-button'))
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
  const retried = await until(
    () => accountPlugin(cloud, responsive.slug),
    Boolean,
    'A user retry did not install after the lease was released'
  )
  responsive.installedId = Number(retried.metadata.labels.id)
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
    acknowledged.installedId = installedId
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
        error => error.code === 'plugin_write_busy' && error.stage === 'plugin_ack'
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
  await verifyLateInstallAcknowledgementRemoval({
    cloud,
    apiProxy,
    deviceProxy,
    item: { ...acknowledged, installedId },
    remoteHome,
    refreshSurfaces,
    evidence,
    timeoutMs,
  })
  await verifyConcurrentPluginPreparation({
    cloud,
    control,
    packageProxy,
    remoteHome,
    evidence,
    timeoutMs,
  })
}

function installedPluginKindName(catalogNamespace, slug) {
  const digest = createHash('sha256')
    .update(`${catalogNamespace}:${slug}`)
    .digest('hex')
    .slice(0, 10)
  return `${slug.slice(0, 89)}-${digest}`
}

async function seedStaleInstallation({ cloud, item, staleIdentity }) {
  const [plugin] = await cloud.queryDatabase(
    'SELECT catalog_namespace, name, slug FROM plugins WHERE id = %s',
    [item.pluginId]
  )
  assert.ok(plugin, `Published plugin ${item.pluginId} is missing`)
  const kindName = installedPluginKindName(plugin.catalog_namespace, plugin.slug)
  await cloud.executeDatabase(
    'DELETE FROM kinds WHERE user_id = %s AND kind = %s AND name = %s AND namespace = %s',
    [1, 'InstalledPlugin', kindName, 'default']
  )
  const stalePluginId = item.pluginId + 1000
  const spec = {
    revision: 7,
    source: {
      type: 'marketplace',
      providerKey: 'wegent-market',
      pluginKey: plugin.name,
      marketplace: 'wegent',
    },
    origin: 'market',
    releaseId: item.releaseId,
    desiredVersion: '0.0.1',
    version: '0.0.1',
    installState: 'installed',
    enabled: false,
    componentStates: { review: false },
  }
  if (staleIdentity === 'legacy_plugin_id') {
    spec.pluginId = stalePluginId
    spec.source.catalogItemId = String(stalePluginId)
  }
  const document = {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledPlugin',
    metadata: { name: kindName, namespace: 'default' },
    spec,
  }
  await cloud.executeDatabase(
    'INSERT INTO kinds (user_id, kind, name, namespace, json, is_active, created_at, updated_at) VALUES (%s, %s, %s, %s, %s, 0, NOW(), NOW())',
    [1, 'InstalledPlugin', kindName, 'default', JSON.stringify(document)]
  )
  const [stale] = await cloud.queryDatabase(
    'SELECT id, is_active, JSON_UNQUOTE(JSON_EXTRACT(json, "$.spec.pluginId")) AS pluginId FROM kinds WHERE user_id = %s AND kind = %s AND name = %s AND namespace = %s',
    [1, 'InstalledPlugin', kindName, 'default']
  )
  assert.ok(stale, 'The stale installation fixture was not persisted')
  assert.equal(stale.is_active, 0)
  assert.equal(stale.pluginId, spec.pluginId == null ? null : String(spec.pluginId))
  return { id: Number(stale.id), kindName }
}

async function verifyCanonicalNameReactivation({
  cloud,
  control,
  apiProxy,
  executorHome,
  refreshSurfaces,
  evidence,
  timeoutMs,
}) {
  for (const staleIdentity of ['legacy_plugin_id', 'missing_plugin_id']) {
    const suffix = staleIdentity.replaceAll('_', '-')
    const slug = `coordination-e2e-${suffix}`
    const item = {
      ...(await cloud.publishPluginRelease({
        slug,
        version: '1.0.0',
        skills: { [slug]: slug },
      })),
      slug,
    }
    const stale = await seedStaleInstallation({ cloud, item, staleIdentity })
    await openPlugin(control, item)
    await control.command('clickWhenEnabled', testId('plugins-refresh-button'))
    await assertInstallButton(control, item)
    await control.command('clickWhenEnabled', testId(`plugin-marketplace-install-${item.pluginId}`))
    await control.command('waitFor', testId('install-plugin-dialog-confirm'))
    await control.command('clickWhenEnabled', testId('install-plugin-dialog-confirm'))
    const response = await until(
      () =>
        apiProxy.requests.find(
          request =>
            request.method === 'POST' &&
            request.path === `/api/plugins/marketplace/${item.pluginId}/install`
        ),
      request => request?.responseCompleted === true,
      `${staleIdentity} marketplace install request did not complete`,
      timeoutMs
    )
    assert.equal(response.status, 200)
    const installed = await until(
      () => accountPlugin(cloud, slug),
      Boolean,
      `${staleIdentity} did not install through the real marketplace UI`,
      timeoutMs
    )
    item.installedId = Number(installed.metadata.labels.id)
    assert.equal(item.installedId, stale.id, 'Install did not reuse the canonical Kind ID')
    assert.equal(installed.spec.pluginId, item.pluginId)
    assert.equal(installed.spec.releaseId, item.releaseId)
    const runtime = await until(
      () => materializedPlugin(executorHome, stale.id),
      plugin => plugin?.version === '1.0.0',
      `${staleIdentity} did not materialize the installed plugin version`,
      timeoutMs
    )
    const devices = await cloud.queryDatabase(
      'SELECT device_id, state, actual_release_id, desired_release_id FROM plugin_device_installations WHERE user_id = %s AND installed_kind_id = %s AND state = %s',
      [1, stale.id, 'installed']
    )
    const device = devices.find(
      row =>
        Number(row.actual_release_id) === item.releaseId &&
        Number(row.desired_release_id) === item.releaseId
    )
    assert.ok(device, `${staleIdentity} did not persist a synchronized device state`)
    const marketplace = await pluginApi(
      cloud,
      `/plugins/marketplace/${item.pluginId}?device_id=${encodeURIComponent(device.device_id)}`
    )
    assert.equal(marketplace.installed, true)
    assert.equal(marketplace.installedPluginId, stale.id)
    await refreshSurfaces(item)
    evidence.push({
      case: 'marketplace-install-reuses-stale-kind',
      staleIdentity,
      pluginKey: slug,
      kindId: stale.id,
      kindName: stale.kindName,
      deviceId: device.device_id,
      actualReleaseId: device.actual_release_id,
      runtimeVersion: runtime.version,
    })
  }
}

async function verifyLateInstallAcknowledgementRemoval({
  cloud,
  apiProxy,
  deviceProxy,
  item,
  remoteHome,
  refreshSurfaces,
  evidence,
  timeoutMs,
}) {
  const pendingRows = () =>
    cloud.queryDatabase(
      'SELECT state, actual_release_id, desired_release_id FROM plugin_device_installations WHERE user_id = %s AND installed_kind_id = %s AND device_id = %s',
      [1, item.installedId, CLOUD_DEVICE_ID]
    )
  const manifestRevision = async () =>
    JSON.parse(await readFile(resolve(remoteHome, 'capabilities/manifest-v2.json'), 'utf8'))
      .revision
  const beforeRevision = await manifestRevision()
  assert.ok(Number.isSafeInteger(beforeRevision), 'The real capability manifest has no revision')
  const logOffset = (await readFile(cloud.backendLogPath, 'utf8')).length
  const controller = new AbortController()
  let pending
  let reconnecting
  deviceProxy.pauseDeviceAcknowledgements(true)
  try {
    pending = pluginApi(
      cloud,
      `/plugins/installed/${item.installedId}/sync-device?device_id=${encodeURIComponent(CLOUD_DEVICE_ID)}`,
      'POST',
      { signal: controller.signal }
    ).then(
      value => ({ value }),
      error => ({ error })
    )
    await until(
      manifestRevision,
      revision => revision > beforeRevision,
      'The real Executor did not finish the targeted install before its ACK was held',
      timeoutMs
    )
    assert.ok(await materializedPlugin(remoteHome, item.installedId))
    // The held install ACK may return, but the subsequent removal cannot reach
    // the device. It must remain durable until a real removal is acknowledged.
    deviceProxy.pauseDeviceDelivery(true)
    const deletePath = `/api/plugins/installed/${item.installedId}`
    const deleted = await fetch(`${apiProxy.url}${deletePath}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${cloud.authToken}` },
      signal: AbortSignal.timeout(10_000),
    })
    assert.equal(deleted.status, 204)
    await until(
      pendingRows,
      rows => rows.length === 1 && rows[0].state === 'uninstalling',
      'The committed uninstall did not persist the held device removal'
    )
    assert.equal(await accountPlugin(cloud, item.slug), undefined)
    deviceProxy.pauseDeviceAcknowledgements(false)
    await until(
      async () => (await readFile(cloud.backendLogPath, 'utf8')).slice(logOffset),
      log => hasLateInstallCorrection(log, item.installedId, CLOUD_DEVICE_ID),
      'The late targeted install ACK did not trigger a fresh removal snapshot',
      10_000
    )
    const afterInstallAck = await pendingRows()
    assert.equal(afterInstallAck.length, 1, 'An install ACK deleted the pending removal')
    assert.equal(afterInstallAck[0].state, 'uninstalling')
    assert.ok(await materializedPlugin(remoteHome, item.installedId))
    // The API now waits for the corrective removal, whose delivery is held.
    // Cancel that obsolete HTTP waiter before exercising disconnect recovery.
    controller.abort()
    const cancelled = await pending
    assert.equal(cancelled.error?.name, 'AbortError', 'The held correction unexpectedly completed')
    // This checks the real transport and persistence invariant. The precise
    // final-snapshot-to-ACK-worker race is covered by the backend concurrency test.
    evidence.push({
      case: 'late-targeted-install-ack-preserves-unconfirmed-removal',
      installedId: item.installedId,
      afterInstallAck,
    })
    reconnecting = cloud.restartCloudExecutor().then(
      value => ({ value }),
      error => ({ error })
    )
    await cloud.waitForDeviceStatus(CLOUD_DEVICE_ID, 'offline', cloud.remoteExecutorLogPath)
    assert.equal((await pendingRows())[0]?.state, 'uninstalling')
    assert.ok(await materializedPlugin(remoteHome, item.installedId))
    deviceProxy.pauseDeviceDelivery(false)
    const reconnected = await reconnecting
    if (reconnected.error) throw reconnected.error
    await until(
      async () => ({
        plugin: await materializedPlugin(remoteHome, item.installedId),
        rows: await pendingRows(),
      }),
      value => !value.plugin && value.rows.length === 0,
      'Reconnect did not acknowledge and finish the durable removal',
      timeoutMs
    )
    assert.equal(
      apiProxy.requests.filter(
        request => request.method === 'DELETE' && request.path === deletePath
      ).length,
      1,
      'Device recovery repeated the account uninstall'
    )
    await refreshSurfaces(item, false)
    evidence.push({
      case: 'late-install-ack-removal-recovers-after-disconnect',
      installedId: item.installedId,
    })
  } finally {
    controller.abort()
    deviceProxy.pauseDeviceAcknowledgements(false)
    deviceProxy.pauseDeviceDelivery(false)
    if (pending) await pending
    if (reconnecting) await reconnecting
  }
}

export function hasLateInstallCorrection(log, installedId, deviceId) {
  const allLines = log.split('\n')
  const request = allLines.find(line =>
    line.includes(
      `request : POST /api/plugins/installed/${installedId}/sync-device device_id=${deviceId} `
    )
  )
  const requestId = request?.match(/\bINFO \[([^\]]+)\]/)?.[1]
  if (!requestId) return false
  const lines = allLines.filter(line => line.includes(`[${requestId}]`))
  const delivered = lines.findIndex(line =>
    line.includes(
      `Capability sync delivered: user_id=1 device_id=${deviceId} skills=0 plugins=1 mcps=0`
    )
  )
  const retry = lines.findIndex(line =>
    line.includes(
      `Capability desired state changed during sync; retrying latest snapshot: user_id=1 device_id=${deviceId} attempt=1`
    )
  )
  return delivered >= 0 && retry > delivered
}
