import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { CLOUD_DEVICE_ID } from './shared.mjs'
import {
  accountPlugin,
  materializedPlugin,
  pluginApi,
  requestPluginExecutor,
  until,
} from './plugin-regression-fixture.mjs'

// Reuse the write-coordination checkpoint's real Electron, Socket, storage,
// Backend and database. Hold real package bytes while both transports arrive.
export async function verifyPluginDuplicateDelivery({
  cloud,
  control,
  apiProxy,
  packageProxy,
  executorHome,
  resultDir,
  timeoutMs,
  evidence,
}) {
  await until(
    () => requestPluginExecutor(control, 'executor.backend.status'),
    response => response.payload.result?.connected === true,
    'The local Executor did not reconnect before duplicate delivery verification',
    timeoutMs
  )
  const invoke = params =>
    requestPluginExecutor(
      control,
      'executor.plugins.local_sync',
      { backend_url: apiProxy.url, auth_token: cloud.authToken, ...params },
      { timeoutMs }
    )
  const probe = await invoke({ probeOnly: true })
  const source = probe.payload.result?.sourceDeviceId
  assert.match(source, /^app-record-\d+$/, 'Native did not publish its precise registered route')
  const sourceId = Number(source.slice('app-record-'.length))
  const slug = 'local-http-socket-duplicate'
  const item = await cloud.publishPluginRelease({
    slug,
    version: '1.0.0',
    skills: { [slug]: 'Concurrent local and Socket delivery' },
  })
  const marker = 'plugin-duplicate-delivery-e2e'
  const originalRule = packageProxy.rule
  const offset = packageProxy.requests.length
  const downloads = () =>
    packageProxy.requests
      .slice(offset)
      .filter(request => request.method === 'GET' && request.path.endsWith(`/${item.storageKey}`))
  const manifest = async () =>
    JSON.parse(await readFile(resolve(executorHome, 'capabilities/manifest-v2.json'), 'utf8'))
  let pending
  let pushed
  let installedId
  try {
    await cloud.executeDatabase(
      "INSERT INTO kinds (user_id,kind,name,namespace,json,is_active,created_at,updated_at) SELECT user_id,kind,name,namespace,JSON_SET(json,'$.metadata',JSON_SET(COALESCE(JSON_EXTRACT(json,'$.metadata'),JSON_OBJECT()),'$.duplicateDeliveryFixture',%s)),1,NOW(),NOW() FROM kinds WHERE user_id=1 AND id=%s AND kind='Device' AND namespace='default'",
      [marker, sourceId]
    )
    const duplicates = await cloud.queryDatabase(
      "SELECT id FROM kinds WHERE user_id=1 AND kind='Device' AND namespace='default' AND JSON_UNQUOTE(JSON_EXTRACT(json,'$.metadata.duplicateDeliveryFixture'))=%s",
      [marker]
    )
    assert.equal(duplicates.length, 1, 'The duplicate legacy identity fixture was not created')
    packageProxy.rule = request =>
      request.method === 'GET' && request.path.endsWith(`/${item.storageKey}`)
        ? 'hold-response'
        : originalRule(request)
    pending = invoke({ action: 'install', targetId: item.pluginId }).then(
      value => ({ value }),
      error => ({ error })
    )
    const account = await until(
      () => accountPlugin(cloud, slug),
      Boolean,
      'The single local install never committed its account intent',
      timeoutMs
    )
    installedId = Number(account.metadata.labels.id)
    const first = await until(
      manifest,
      state => state.plugin_sync?.entries?.[`${slug}@wegent`]?.pending === true,
      'The local installation never entered package preparation',
      timeoutMs
    )
    await until(
      downloads,
      entries => entries.some(entry => entry.committedResponseHeld),
      'The real package response was not held',
      timeoutMs
    )
    const firstGeneration = first.plugin_sync.entries[`${slug}@wegent`].generation
    const rows = await until(
      () =>
        cloud.queryDatabase(
          'SELECT device_id FROM plugin_device_installations WHERE user_id=1 AND installed_kind_id=%s',
          [installedId]
        ),
      entries => entries.some(entry => entry.device_id === CLOUD_DEVICE_ID),
      'The account mutation did not prepare synchronization of the other real device',
      timeoutMs
    )
    assert.ok(
      rows.every(row => row.device_id !== source),
      'The automatic background broadcast included the initiating installation'
    )
    const accepted = apiProxy.requests.filter(
      request =>
        request.method === 'POST' &&
        request.path === `/api/plugins/marketplace/${item.pluginId}/install`
    )
    assert.equal(accepted.length, 1, 'The fixture sent more than one user install')
    const backendLog = await readFile(cloud.backendLogPath, 'utf8')
    assert.ok(
      backendLog
        .split('\n')
        .some(
          line =>
            line.includes(`/api/plugins/marketplace/${item.pluginId}/install `) &&
            line.includes(`source_device_id=${source}`)
        ),
      'The HTTP installation did not identify its precise originating route'
    )

    // An explicit real device sync can still race the HTTP installation. The
    // shared installer must join it, even though it has a newer generation.
    pushed = pluginApi(
      cloud,
      `/plugins/installed/${installedId}/sync-device?device_id=${encodeURIComponent(source)}`,
      'POST'
    ).then(
      value => ({ value }),
      error => ({ error })
    )
    await until(
      manifest,
      state => state.plugin_sync?.entries?.[`${slug}@wegent`]?.generation > firstGeneration,
      'The real Socket duplicate was not accepted during the held HTTP installation',
      timeoutMs
    )
    packageProxy.rule = originalRule
    for (const entry of downloads())
      if (entry.committedResponseHeld && !entry.released) await entry.release()
    const local = await pending
    if (local.error) throw local.error
    assert.equal(local.value.status, 200)
    assert.equal(local.value.payload.error, undefined, JSON.stringify(local.value.payload.error))
    assert.equal(local.value.payload.result.localCompleted, true)
    const remote = await pushed
    if (remote.error) throw remote.error
    assert.equal(remote.value.sync.success, true)
    assert.equal((await materializedPlugin(executorHome, installedId)).version, '1.0.0')
    const log = await readFile(resolve(resultDir, 'executor.log'), 'utf8')
    assert.ok(
      log.includes(`plugin_target_coalesced plugin=${slug}@wegent`),
      'The two real transport requests did not share one target publication'
    )
    evidence.push({
      case: 'local-http-socket-duplicate-delivery',
      source,
      installedId,
      firstGeneration,
      singleUserInstall: true,
      ambiguousLegacyAliasExcluded: true,
      bothTransportsSucceeded: true,
    })
  } finally {
    packageProxy.rule = originalRule
    for (const entry of downloads())
      if (entry.committedResponseHeld && !entry.released) await entry.release()
    if (pending) await pending
    if (pushed) await pushed
    try {
      if (installedId) {
        const removed = await invoke({ action: 'uninstall', targetId: installedId })
        assert.equal(removed.payload.error, undefined, JSON.stringify(removed.payload.error))
        assert.equal(removed.payload.result.localCompleted, true)
      }
    } finally {
      if (installedId)
        await cloud.executeDatabase(
          "DELETE p FROM plugin_device_installations AS p JOIN kinds AS d ON p.device_id=CONCAT('app-record-',d.id) WHERE p.user_id=1 AND p.installed_kind_id=%s AND d.user_id=1 AND d.kind='Device' AND d.namespace='default' AND JSON_UNQUOTE(JSON_EXTRACT(d.json,'$.metadata.duplicateDeliveryFixture'))=%s",
          [installedId, marker]
        )
      await cloud.executeDatabase(
        "DELETE FROM kinds WHERE user_id=1 AND kind='Device' AND namespace='default' AND JSON_UNQUOTE(JSON_EXTRACT(json,'$.metadata.duplicateDeliveryFixture'))=%s",
        [marker]
      )
    }
  }
}
