import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  accountPlugin,
  materializedPlugin,
  pluginApi,
  requestPluginExecutor,
  until,
} from './plugin-regression-fixture.mjs'

// Runs at the end of the existing CI-covered write-coordination checkpoint.
// Real Backend, MySQL, Redis, package storage and Executor; Socket and HTTP
// transport faults exercise recovery. No additional desktop service or build.
export async function verifyPluginLocalSync({
  cloud,
  control,
  apiProxy,
  executorHome,
  localDeviceId,
  deviceId,
  evidence,
}) {
  const flags = { ...cloud.backendEnv }
  const current = await requestPluginExecutor(control, 'executor.backend.status')
  assert.equal(current.payload.result.backend_url, apiProxy.url)
  const slug = 'local-http-no-registration'
  const release = await cloud.publishPluginRelease({
    slug,
    version: '1.0.0',
    skills: { [slug]: slug },
  })
  const rows = await cloud.queryDatabase(
    "SELECT id FROM kinds WHERE user_id = %s AND kind = 'Device' AND namespace = 'default' AND (name = %s OR JSON_UNQUOTE(JSON_EXTRACT(json, '$.spec.deviceId')) = %s OR JSON_UNQUOTE(JSON_EXTRACT(json, '$.spec.appDeviceId')) = %s)",
    [1, localDeviceId, localDeviceId, deviceId]
  )
  assert.ok(rows.length > 0, 'The isolated local registration was not identified')
  try {
    await cloud.stopBackend()
    cloud.backendEnv = {
      ...flags,
      PLUGIN_LOCAL_SYNC_ENABLED: 'true',
    }
    apiProxy.disconnectWebSockets(true)
    await cloud.launchBackend()
    for (const row of rows)
      await cloud.executeDatabase('UPDATE kinds SET is_active = 0 WHERE user_id = 1 AND id = %s', [
        row.id,
      ])
    apiProxy.rule = request => null
    const invoke = async params => {
      const response = await requestPluginExecutor(control, 'executor.plugins.local_sync', {
        backend_url: apiProxy.url,
        auth_token: cloud.authToken,
        ...params,
      })
      assert.equal(response.status, 200)
      assert.equal(response.payload.error, undefined, JSON.stringify(response.payload.error))
      return response.payload.result
    }
    const capabilities = await invoke({ probeOnly: true })
    assert.equal(capabilities.enabled, true)
    const scope = createHash('sha256')
      .update(`${apiProxy.url}:${capabilities.accountId}`)
      .digest('hex')
    // This checkpoint configures WEGENT_CODEX_HOME as executorHome/codex.
    const journal = async () =>
      JSON.parse(
        await readFile(resolve(executorHome, 'codex', 'plugin-local-sync', `${scope}.json`), 'utf8')
      )
    const request = params =>
      requestPluginExecutor(control, 'executor.plugins.local_sync', {
        backend_url: apiProxy.url,
        auth_token: cloud.authToken,
        ...params,
      })
    const installed = await invoke({ action: 'install', targetId: release.pluginId })
    assert.equal(installed.localCompleted, true)
    const id = Number(installed.operation.plugin.metadata.labels.id)
    assert.ok(await materializedPlugin(executorHome, id), 'HTTP install did not publish real files')
    assert.equal(
      (await requestPluginExecutor(control, 'executor.backend.status')).payload.result.connected,
      false
    )
    // Keep an older uninstall in the real Native journal without letting it
    // reach Backend. The next update must supersede even its first arrival.
    let blockRemoval = true
    apiProxy.rule = request => {
      if (
        blockRemoval &&
        request.method === 'DELETE' &&
        request.path === `/api/plugins/installed/${id}`
      )
        return 'disconnect'
      return null
    }
    const pendingRemoval = await requestPluginExecutor(control, 'executor.plugins.local_sync', {
      backend_url: apiProxy.url,
      auth_token: cloud.authToken,
      action: 'uninstall',
      targetId: id,
    })
    assert.equal(pendingRemoval.payload.error?.code, 'plugin_local_http_unavailable')
    const obsolete = pending(await journal(), 'uninstall', id)
    assert.ok(obsolete)
    assert.ok(await materializedPlugin(executorHome, id))
    const upgraded = await cloud.publishPluginRelease({
      slug,
      version: '2.0.0',
      skills: { [slug]: `${slug} updated` },
    })
    assert.equal(
      (await invoke({ action: 'update', targetId: id, payload: { releaseId: upgraded.releaseId } }))
        .localCompleted,
      true
    )
    assert.equal((await materializedPlugin(executorHome, id)).version, '2.0.0')
    blockRemoval = false
    const recovered = await requestPluginExecutor(control, 'executor.plugins.local_sync', {
      backend_url: apiProxy.url,
      auth_token: cloud.authToken,
    })
    assert.equal(recovered.payload.result?.localCompleted, true)
    await until(
      () => apiProxy.requests,
      entries =>
        entries.some(
          entry =>
            entry.method === 'DELETE' &&
            entry.path === `/api/plugins/installed/${id}` &&
            entry.status === 409
        ),
      'The obsolete uninstall never reached the real ordering guard'
    )
    await until(
      journal,
      state =>
        state.supersededOperations?.some(entry => entry.operationId === obsolete.operationId),
      'The obsolete pending uninstall was not retired'
    )
    assert.equal((await accountPlugin(cloud, slug)).spec.releaseId, upgraded.releaseId)
    assert.equal((await materializedPlugin(executorHome, id)).version, '2.0.0')
    await verifyRejectedRecovery({ request, invoke, apiProxy, journal })
    await verifyUncertainRecovery({ request, invoke, apiProxy, journal, cloud, id })
    assert.equal((await invoke({ action: 'uninstall', targetId: id })).localCompleted, true)
    assert.equal(await materializedPlugin(executorHome, id), null)
    assert.equal(await accountPlugin(cloud, slug), undefined)
    evidence.push({
      case: 'plugin-local-http-without-registration',
      install: true,
      update: true,
      uninstall: true,
      noReceiptRequests: true,
      olderUnsubmittedUninstallFenced: true,
      rejectedPendingDoesNotBlockReconciliation: true,
      uncertainAcceptanceRetainsOriginalOperation: true,
      failedFullDoesNotBlockPendingRecovery: true,
    })
  } finally {
    apiProxy.rule = () => null
    apiProxy.disconnectWebSockets(false)
    for (const row of rows)
      await cloud.executeDatabase('UPDATE kinds SET is_active = 1 WHERE user_id = 1 AND id = %s', [
        row.id,
      ])
    await cloud.stopBackend()
    cloud.backendEnv = flags
    await cloud.launchBackend()
  }
}

const noFault = entry => null
const pending = (state, action, target) =>
  state.pending.find(entry => entry.action === action && entry.targetId === target)

async function verifyRejectedRecovery({ request, invoke, apiProxy, journal }) {
  const missing = 999999999
  let disconnected = true
  apiProxy.rule = entry =>
    entry.method === 'POST' &&
    entry.path === `/api/plugins/marketplace/${missing}/install` &&
    disconnected
      ? 'disconnect'
      : noFault(entry)
  const failed = await request({ action: 'install', targetId: missing })
  assert.equal(failed.payload.error?.code, 'plugin_local_http_unavailable')
  const original = pending(await journal(), 'install', missing)
  assert.ok(original, 'A transport failure discarded its pending intent')
  const attempts = () =>
    apiProxy.requests.filter(
      entry =>
        entry.method === 'POST' && entry.path === `/api/plugins/marketplace/${missing}/install`
    ).length
  const before = attempts()
  assert.equal((await invoke({ full: true })).localCompleted, true)
  await until(
    async () => ({ state: await journal(), attempts: attempts() }),
    observed =>
      observed.attempts > before &&
      pending(observed.state, 'install', missing)?.lastErrorCode ===
        'plugin_local_http_unavailable',
    'Unknown work did not remain recoverable independently of full reconciliation'
  )
  const retained = pending(await journal(), 'install', missing)
  assert.equal(retained.operationId, original.operationId)
  assert.equal(retained.intentOrder, original.intentOrder)
  disconnected = false
  assert.equal((await invoke({ full: true })).localCompleted, true)
  await until(
    journal,
    state =>
      !pending(state, 'install', missing) &&
      state.rejectedOperations?.some(
        entry => entry.request.operationId === original.operationId && entry.httpStatus === 404
      ),
    'The real Backend rejection was not archived'
  )
}

async function verifyUncertainRecovery({ request, invoke, apiProxy, journal, cloud, id }) {
  const slug = 'local-http-failed-full'
  const release = await cloud.publishPluginRelease({
    slug,
    version: '1.0.0',
    skills: { [slug]: 'Verify recovery despite an unrelated package download failure' },
  })
  await pluginApi(cloud, `/plugins/marketplace/${release.pluginId}/install`, 'POST')
  const blockedId = Number((await accountPlugin(cloud, slug)).metadata.labels.id)
  assert.ok(blockedId > 0)
  let blockDownload = true
  let drop = true
  const path = `/api/plugins/installed/${id}`
  apiProxy.rule = entry => {
    if (
      blockDownload &&
      entry.method === 'GET' &&
      entry.path === `/api/plugins/installed/${blockedId}/download`
    )
      return 'disconnect'
    if (entry.method !== 'PUT' || entry.path !== path) return noFault(entry)
    if (drop) {
      drop = false
      return 'drop-response'
    }
    return 'hold-response'
  }
  const failed = await request({ action: 'update', targetId: id, payload: { enabled: false } })
  assert.equal(failed.payload.error?.code, 'plugin_local_http_unavailable')
  const original = pending(await journal(), 'update', id)
  assert.ok(original, 'A lost acceptance response discarded its operation')
  const failedFull = await request({ full: true })
  assert.equal(failedFull.payload.error?.code, 'plugin_local_apply_failed')
  const held = await until(
    () => apiProxy.requests,
    entries =>
      entries.find(
        entry =>
          entry.method === 'PUT' &&
          entry.path === path &&
          entry.fault === 'hold-response' &&
          typeof entry.release === 'function'
      ),
    'Idempotent recovery did not reach Backend'
  )
  // until returns the observed collection; select its real held HTTP reply.
  const response = held.find(
    entry =>
      entry.method === 'PUT' &&
      entry.path === path &&
      entry.fault === 'hold-response' &&
      typeof entry.release === 'function'
  )
  const retained = pending(await journal(), 'update', id)
  assert.equal(retained.operationId, original.operationId)
  assert.equal(retained.intentOrder, original.intentOrder)
  assert.notEqual(retained.accepted, true)
  assert.equal(await response.release(), true)
  await until(
    journal,
    state => pending(state, 'update', id)?.accepted === true,
    'The original operation was not confirmed after response recovery'
  )
  const rows = await cloud.queryDatabase(
    "SELECT json FROM kinds WHERE user_id=1 AND kind='PluginSyncState' AND namespace='plugin-sync' AND name='account'"
  )
  const accountState = typeof rows[0].json === 'string' ? JSON.parse(rows[0].json) : rows[0].json
  const slots = Object.values(accountState.spec.localIntents).flatMap(Object.values)
  assert.equal(slots.filter(slot => slot.operationId === original.operationId).length, 1)
  const ledger = await cloud.queryDatabase(
    "SELECT COUNT(*) AS n FROM kinds WHERE namespace='plugin-local-sync'"
  )
  assert.equal(Number(ledger[0].n), 0)
  assert.ok(!apiProxy.requests.some(entry => entry.path === '/api/plugins/local-sync/receipts'))
  blockDownload = false
  assert.equal((await invoke({ full: true })).localCompleted, true)
  assert.ok(!(await journal()).pending.some(entry => entry.operationId === original.operationId))
  assert.equal((await invoke({ action: 'uninstall', targetId: blockedId })).localCompleted, true)
  apiProxy.rule = noFault
}
