import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { reloadMainWindow } from './workspace-flows.mjs'
import {
  installFixture,
  materializedPlugin,
  openPlugin,
  requestPluginExecutor,
  testId,
  until,
  uninstallInUi,
  assertInstallButton,
  accountPlugin,
} from './plugin-regression-fixture.mjs'

// Only Native HTTP completion can update the source while real Socket delivery is paused.
export async function verifyPluginHttpReinstall({
  cloud,
  control,
  apiProxy,
  executorHome,
  timeoutMs,
  evidence,
}) {
  const invoke = async params =>
    (
      await requestPluginExecutor(
        control,
        'executor.plugins.local_sync',
        {
          backend_url: apiProxy.url,
          auth_token: cloud.authToken,
          ...params,
        },
        { timeoutMs, requestId: `http-reinstall-${randomUUID()}` }
      )
    ).payload
  const ready = await until(
    () => invoke({ probeOnly: true }),
    response => /^app-record-\d+$/.test(response.result?.sourceDeviceId ?? ''),
    'The source device did not reconnect after the real backend restart',
    timeoutMs
  )
  const source = ready.result.sourceDeviceId
  assert.match(source, /^app-record-\d+$/)
  const slug = 'http-source-device-reinstall'
  const item = await installFixture(cloud, control, slug, source, timeoutMs)
  const rows = () =>
    cloud.queryDatabase(
      'SELECT state, desired_release_id, actual_release_id FROM plugin_device_installations WHERE user_id=1 AND installed_kind_id=%s AND device_id=%s',
      [item.installedId, source]
    )
  const originalRule = apiProxy.rule
  let held
  let oldRemoval
  apiProxy.pauseDeviceDelivery(true)
  try {
    await uninstallInUi(control, item)
    await assertInstallButton(control, item)
    assert.equal(await materializedPlugin(executorHome, item.installedId), null)
    assert.equal(await accountPlugin(cloud, slug), undefined)
    assert.deepEqual(await rows(), [], 'HTTP uninstall did not confirm source removal')
    await control.command(
      'clickWhenEnabled',
      `button${testId(`plugin-marketplace-install-${item.pluginId}`)}`
    )
    await control.command('clickWhenEnabled', testId('install-plugin-dialog-confirm'))
    await control.command('waitFor', testId(`plugin-marketplace-actions-${item.pluginId}`))
    const installed = await accountPlugin(cloud, slug)
    assert.equal(Number(installed.metadata.labels.id), item.installedId)
    assert.equal(
      (await materializedPlugin(executorHome, item.installedId)).version,
      installed.spec.version
    )
    const current = await rows()
    assert.equal(current.length, 1)
    assert.equal(current[0].state, 'installed')
    assert.equal(current[0].actual_release_id, installed.spec.releaseId)
    assert.equal(current[0].desired_release_id, installed.spec.releaseId)
    const persisted = JSON.parse(
      await control.command('getLocalStorageItem', 'body', { value: 'wework.plugins.inventory.v2' })
    )
    const cached = Object.values(persisted.entries).find(entry =>
      entry.installedPlugins.some(plugin => Number(plugin.metadata.labels?.id) === item.installedId)
    )
    assert.ok(cached, 'The accepted reinstall was not durably saved')
    assert.equal(
      typeof cached.marketplaceItems,
      'string',
      'Directory encoding was not separated from installation state'
    )
    await reloadMainWindow(control, 'The plugin cache did not reconnect after reload')
    await control.command('waitFor', testId('plugins-button'), { visible: true })
    await openPlugin(control, item)
    await control.command('waitFor', testId(`plugin-marketplace-actions-${item.pluginId}`))
    assert.equal((await rows())[0].state, 'installed', 'Reload lost the confirmed reinstall')
    await until(
      () => invoke({ probeOnly: true }),
      response => response.result?.sourceDeviceId === source,
      'The source device did not reconnect after cache restoration',
      timeoutMs
    )
    const reconciled = await invoke({ full: true })
    assert.equal(reconciled.error, undefined, JSON.stringify(reconciled.error))
    assert.equal(reconciled.result.localCompleted, true)

    let pause = true
    apiProxy.rule = (entry, request) => {
      if (pause && entry.path === '/api/plugins/local-sync/complete') {
        pause = false
        return 'pause-request'
      }
      return originalRule(entry, request)
    }
    oldRemoval = invoke({ action: 'uninstall', targetId: item.installedId })
    const observed = await until(
      () => apiProxy.requests,
      entries =>
        entries.some(
          entry =>
            entry.path === '/api/plugins/local-sync/complete' &&
            entry.fault === 'pause-request' &&
            !entry.released
        ),
      'The real removal confirmation was not paused'
    )
    held = observed.find(
      entry =>
        entry.path === '/api/plugins/local-sync/complete' &&
        entry.fault === 'pause-request' &&
        !entry.released
    )
    assert.equal(await materializedPlugin(executorHome, item.installedId), null)
    assert.equal((await rows())[0].state, 'uninstalling')
    const reinstalled = await invoke({ action: 'install', targetId: item.pluginId })
    assert.equal(reinstalled.error, undefined, JSON.stringify(reinstalled.error))
    assert.equal(reinstalled.result.localCompleted, true)
    assert.equal(
      (await rows())[0].state,
      'installed',
      'Reinstall retained the earlier uninstall state'
    )
    assert.equal(held.release(), true)
    assert.equal((await oldRemoval).error?.code, 'INTENT_SUPERSEDED')
    assert.ok(await materializedPlugin(executorHome, item.installedId))
    assert.ok(await accountPlugin(cloud, slug))
    assert.equal((await rows())[0].state, 'installed', 'Late removal overwrote the reinstall')
    await openPlugin(control, item)
    await control.command('waitFor', testId(`plugin-marketplace-actions-${item.pluginId}`))
    assert.ok(
      !(
        await control.command('getText', testId(`plugin-marketplace-row-${item.pluginId}`))
      ).includes('正在卸载')
    )
    evidence.push({
      case: 'native-http-source-device-uninstall-reinstall',
      source,
      installedId: item.installedId,
      lateRemovalIgnored: true,
    })
  } catch (error) {
    evidence.push({
      case: 'native-http-source-device-uninstall-reinstall-failure',
      source,
      installedId: item.installedId,
      error: String(error),
      deviceRows: await rows(),
      installation: await cloud.queryDatabase(
        "SELECT is_active, JSON_EXTRACT(json,'$.spec.revision') AS revision FROM kinds WHERE user_id=1 AND kind='InstalledPlugin' AND namespace='default' AND id=%s",
        [item.installedId]
      ),
    })
    throw error
  } finally {
    apiProxy.rule = originalRule
    if (held && !held.released) held.release()
    if (oldRemoval) await oldRemoval
    apiProxy.pauseDeviceDelivery(false)
    const cleanup = await invoke({ action: 'uninstall', targetId: item.installedId })
    assert.equal(cleanup.error, undefined, JSON.stringify(cleanup.error))
  }
}
