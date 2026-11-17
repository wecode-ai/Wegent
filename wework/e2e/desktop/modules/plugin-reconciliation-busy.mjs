import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { holdPluginScanLock } from './plugin-write-lease.mjs'
import { reloadMainWindow } from './workspace-flows.mjs'
import {
  accountPlugin,
  materializedPlugin,
  openPlugin,
  requestPluginExecutor,
  testId,
  until,
} from './plugin-regression-fixture.mjs'

// Exercise the production file lock and renderer recovery in the existing real
// write-coordination checkpoint, without changing an RPC or HTTP response.
export async function verifyPluginReconciliationBusy({
  cloud,
  control,
  apiProxy,
  executorHome,
  resultDir,
  timeoutMs,
  evidence,
  captureScreenshot,
}) {
  const invoke = async params => {
    const response = await requestPluginExecutor(
      control,
      'executor.plugins.local_sync',
      { backend_url: apiProxy.url, auth_token: cloud.authToken, ...params },
      { timeoutMs }
    )
    assert.equal(response.payload.error, undefined, JSON.stringify(response.payload.error))
    return response.payload.result
  }
  const slug = 'reconciliation-busy-e2e'
  const first = await cloud.publishPluginRelease({
    slug,
    version: '1.0.0',
    skills: { [slug]: 'Before a deferred installation-state check' },
  })
  const foregroundSlug = 'foreground-during-check-e2e'
  const foreground = await cloud.publishPluginRelease({
    slug: foregroundSlug,
    version: '1.0.0',
    skills: { [foregroundSlug]: 'An independent foreground install during a deferred check' },
  })
  let installedId
  let lock
  try {
    const installed = await invoke({ action: 'install', targetId: first.pluginId })
    assert.equal(installed.localCompleted, true)
    installedId = Number(installed.operation.plugin.metadata.labels.id)
    assert.ok(Number.isSafeInteger(installedId) && installedId > 0)
    const probe = await invoke({ probeOnly: true })
    assert.ok(Number.isSafeInteger(probe.accountId) && probe.accountId > 0)
    await reloadMainWindow(control, 'The plugin check did not reconnect after reload')
    await control.command('waitFor', testId('plugins-button'), { timeoutMs })
    await openPlugin(control, { ...first, slug })
    const refresh = testId('plugins-refresh-button')
    await control.command('waitFor', `${refresh}[data-local-sync="true"]:not(:disabled)`)
    await control.command('clickIfPresent', testId('plugin-operation-notice-dismiss'))
    const revision = Number(
      await control.command('getAttribute', refresh, { value: 'data-reconciliation-revision' })
    )
    assert.ok(Number.isSafeInteger(revision) && revision >= 0)
    const scope = createHash('sha256').update(`${apiProxy.url}:${probe.accountId}`).digest('hex')
    const path = resolve(executorHome, 'codex/plugin-local-sync', `${scope}.scan.lock`)
    const logPath = resolve(resultDir, 'executor.log')
    const logOffset = (await readFile(logPath, 'utf8')).length
    lock = await holdPluginScanLock(cloud, path, executorHome)
    await control.command('clickWhenEnabled', refresh)
    await until(
      async () => {
        const log = (await readFile(logPath, 'utf8')).slice(logOffset)
        return new Set(
          [
            ...log.matchAll(
              /request_id=(\S+).*method=executor\.plugins\.local_sync.*code=plugin_local_sync_busy/g
            ),
          ].map(match => match[1])
        ).size
      },
      count => count >= 2,
      'The real status check did not defer after the native scan lock was busy'
    )
    await control.command(
      'waitFor',
      `${testId('plugins-reconciliation-status')}[data-stage="waiting"]`
    )
    assert.equal(
      Number(
        await control.command(
          'getElementCount',
          `${testId('plugin-operation-notice')}[data-notice-kind="error"]`
        )
      ),
      0,
      'A transient Native busy state was presented as an installation-check failure'
    )
    assert.equal(
      Number(
        await control.command('getAttribute', refresh, { value: 'data-reconciliation-revision' })
      ),
      revision,
      'The blocked check was reported complete before its inventory was verified'
    )
    await captureScreenshot(control, 'plugin-check-busy-waiting.png', 'body')
    await openPlugin(control, { ...foreground, slug: foregroundSlug })
    await control.command(
      'clickWhenEnabled',
      testId(`plugin-marketplace-install-${foreground.pluginId}`)
    )
    await control.command('clickWhenEnabled', testId('install-plugin-dialog-confirm'))
    const foregroundAccount = await until(
      () => accountPlugin(cloud, foregroundSlug),
      Boolean,
      'A queued installation-state check blocked the independent UI installation'
    )
    const foregroundId = Number(foregroundAccount.metadata.labels.id)
    assert.ok(Number.isSafeInteger(foregroundId) && foregroundId > 0)
    await until(
      () => materializedPlugin(executorHome, foregroundId),
      Boolean,
      'The independent UI installation did not finish while the scan lock was held'
    )
    await control.command('waitFor', testId(`plugin-marketplace-actions-${foreground.pluginId}`))
    assert.equal(
      apiProxy.requests.filter(
        request =>
          request.method === 'POST' &&
          request.path === `/api/plugins/marketplace/${foreground.pluginId}/install`
      ).length,
      1,
      'Rescheduling the status check repeated the foreground account mutation'
    )
    assert.equal(
      Number(
        await control.command('getAttribute', refresh, { value: 'data-reconciliation-revision' })
      ),
      revision,
      'The held scan was reported complete during the foreground installation'
    )
    const next = await cloud.publishPluginRelease({
      slug,
      version: '2.0.0',
      skills: { [slug]: 'Updated while the full state check is deferred' },
    })
    const updated = await invoke({
      action: 'update',
      targetId: installedId,
      payload: { releaseId: next.releaseId },
    })
    assert.equal(updated.localCompleted, true)
    assert.equal((await materializedPlugin(executorHome, installedId)).version, '2.0.0')
    await lock.release()
    lock = undefined
    await control.command(
      'waitFor',
      `${refresh}[data-reconciliation-revision="${revision + 1}"]:not(:disabled)`,
      { timeoutMs }
    )
    await control.command(
      'waitFor',
      `${testId('plugin-operation-notice')}[data-notice-kind="success"]`
    )
    assert.equal((await materializedPlugin(executorHome, installedId)).version, '2.0.0')
    await captureScreenshot(control, 'plugin-check-busy-completed.png', 'body')
    evidence.push({
      case: 'plugin-reconciliation-busy-rescheduled',
      installedId,
      realScanLock: true,
      multipleBusyAttempts: true,
      noFailureOrFalseCompletionWhileWaiting: true,
      foregroundUpdateCompleted: true,
      independentUiInstallCompletedWhileDeferred: true,
      completedAfterFreshVerification: true,
    })
  } finally {
    await lock?.release()
    if (installedId) await invoke({ action: 'uninstall', targetId: installedId })
    const leftover = await accountPlugin(cloud, foregroundSlug)
    if (leftover)
      await invoke({ action: 'uninstall', targetId: Number(leftover.metadata.labels.id) })
  }
}
