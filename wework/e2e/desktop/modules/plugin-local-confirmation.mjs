import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { holdPluginWriteLease } from './plugin-write-lease.mjs'
import {
  installFixture,
  materializedPlugin,
  pluginApi,
  requestPluginExecutor,
  until,
} from './plugin-regression-fixture.mjs'

// Extend the existing CI checkpoint using its real services and registered source.
export async function verifyPluginLocalConfirmation({
  cloud,
  control,
  apiProxy,
  executorHome,
  timeoutMs,
  evidence,
}) {
  const invoke = params =>
    requestPluginExecutor(
      control,
      'executor.plugins.local_sync',
      { backend_url: apiProxy.url, auth_token: cloud.authToken, ...params },
      { timeoutMs, requestId: randomUUID() }
    ).then(response => response.payload)
  const probe = await invoke({ probeOnly: true })
  const source = probe.result?.sourceDeviceId
  assert.match(source, /^app-record-\d+$/)
  const item = await installFixture(
    cloud,
    control,
    'local-confirmation-contention',
    source,
    timeoutMs
  )
  const scope = createHash('sha256')
    .update(`${apiProxy.url}:${probe.result.accountId}`)
    .digest('hex')
  const journal = async () =>
    JSON.parse(
      await readFile(resolve(executorHome, 'codex/plugin-local-sync', `${scope}.json`), 'utf8')
    )
  const originalRule = apiProxy.rule
  let held
  let pending
  apiProxy.pauseDeviceDelivery(true)
  try {
    held = await holdPluginWriteLease(cloud, item)
    const offset = apiProxy.requests.length
    let settled = false
    const progressId = randomUUID()
    pending = invoke({ installedPluginId: item.installedId, progressId }).then(
      value => {
        settled = true
        return value
      },
      error => {
        settled = true
        return { error }
      }
    )
    // The lease observer can see contention from another request on this plugin.
    await until(
      async () => {
        assert.equal(settled, false, 'Local application settled before entering confirmation')
        const progress = await invoke({ progressOnly: true, progressId })
        return progress.result?.confirming
      },
      confirming => confirming === true,
      'The targeted operation did not enter confirmation while holding the write lease',
      timeoutMs
    )
    await held.waitFor('contended')
    const request = await until(
      () =>
        apiProxy.requests
          .slice(offset)
          .find(entry => entry.path === '/api/plugins/local-sync/complete'),
      Boolean,
      'Local application did not reach its real HTTP confirmation',
      timeoutMs
    )
    // A deliberate negative observation window must exceed the old 3s limit.
    await until(
      () => {
        assert.equal(settled, false, 'Normal lease contention escaped as an installation error')
        return Date.now() - Date.parse(request.receivedAt)
      },
      elapsed => elapsed >= 6000,
      'The confirmation did not remain pending across the lease acquisition limit',
      timeoutMs
    )
    assert.ok(await materializedPlugin(executorHome, item.installedId))
    await held.release()
    held = null
    const completed = await pending
    assert.equal(completed.error, undefined, JSON.stringify(completed.error))
    assert.equal(completed.result.localCompleted, true)

    // A real disconnected receipt leaves actual files and durable recovery state.
    const update = await cloud.publishPluginRelease({
      slug: item.slug,
      version: '2.0.0',
      skills: { [item.slug]: 'Updated before server confirmation is interrupted' },
    })
    apiProxy.rule = request =>
      request.path === '/api/plugins/local-sync/complete' ? 'disconnect' : originalRule(request)
    const updateProgressId = randomUUID()
    const interrupted = await invoke({
      action: 'update',
      targetId: item.installedId,
      payload: { releaseId: update.releaseId },
      progressId: updateProgressId,
    })
    assert.equal(interrupted.error?.code, 'plugin_local_confirmation_pending')
    const unfinished = await journal()
    assert.equal(unfinished.reconcilePending, true)
    assert.equal(unfinished.confirmedDeviceRevision, null)
    const pendingUpdate = unfinished.pending.find(
      operation => operation.targetId === item.installedId && operation.accepted === true
    )
    assert.ok(pendingUpdate)
    assert.equal(pendingUpdate.progressId, updateProgressId)
    assert.ok(
      unfinished.lastResult.plugins.some(
        plugin => Number(plugin.id) === item.installedId && plugin.status === 'synced'
      )
    )
    assert.equal((await materializedPlugin(executorHome, item.installedId)).version, '2.0.0')
    apiProxy.rule = originalRule
    const recovered = await invoke({ full: true })
    assert.equal(recovered.error, undefined, JSON.stringify(recovered.error))
    assert.equal(recovered.result.localCompleted, true)
    assert.deepEqual(
      recovered.result.recoveryOutcomes.find(outcome => outcome.progressId === updateProgressId),
      {
        operationId: pendingUpdate.operationId,
        progressId: updateProgressId,
        status: 'reconciled',
        errorCode: null,
        httpStatus: null,
      }
    )
    assert.equal((await journal()).reconcilePending, false)
    const rows = await cloud.queryDatabase(
      'SELECT state,desired_release_id,actual_release_id FROM plugin_device_installations WHERE user_id=1 AND installed_kind_id=%s AND device_id=%s',
      [item.installedId, source]
    )
    assert.equal(rows.length, 1)
    assert.equal(rows[0].state, 'installed')
    assert.equal(rows[0].actual_release_id, update.releaseId)
    assert.equal(rows[0].desired_release_id, update.releaseId)
    evidence.push({
      case: 'local-confirmation-contention-and-recovery',
      installedId: item.installedId,
      minimumHeldMs: 6000,
    })
  } finally {
    apiProxy.rule = originalRule
    await held?.release()
    if (pending) await pending
    apiProxy.pauseDeviceDelivery(false)
    await pluginApi(
      cloud,
      `/plugins/installed/${item.installedId}?device_id=${encodeURIComponent(source)}`,
      'DELETE'
    )
  }
}
