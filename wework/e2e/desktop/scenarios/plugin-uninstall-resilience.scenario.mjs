import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { CLOUD_DEVICE_ID } from '../modules/shared.mjs'
import { PluginFaultProxy } from '../modules/plugin-fault-proxy.mjs'
import {
  accountPlugin,
  assertInstallButton,
  assertInventory,
  assertSurfaces,
  installFixture,
  materializedPlugin,
  openPlugin,
  pathExists,
  pluginApi,
  testId,
  uninstallInUi,
  until,
} from '../modules/plugin-regression-fixture.mjs'

// Real MySQL, Python API, gateway, Executor and Electron. Only the network
// transport is faulted; no plugin responses or cache state are synthesized.
export async function createDesktopScenario({
  captureScreenshot,
  resultDir,
  workbenchReadyTimeoutMs,
}) {
  const appEnvironment = {}
  const evidence = []
  let cloud
  let apiProxy
  let deviceProxy
  let local
  const fixture = suffix =>
    installFixture(
      cloud,
      controlRef,
      `uninstall-e2e-${suffix}`,
      local.device_id,
      workbenchReadyTimeoutMs
    )
  let controlRef
  const deletePath = item => `/api/plugins/installed/${item.installedId}`
  const deletes = item =>
    apiProxy.requests.filter(
      request => request.method === 'DELETE' && request.path === deletePath(item)
    )
  const pendingRows = item =>
    cloud.queryDatabase(
      'SELECT state FROM plugin_device_installations WHERE user_id = %s AND installed_kind_id = %s AND device_id = %s',
      [1, item.installedId, CLOUD_DEVICE_ID]
    )

  async function lostResponse(control) {
    const item = await fixture('lost-response')
    const startIndex = apiProxy.requests.length
    apiProxy.rule = request =>
      request.method === 'DELETE' && request.path === deletePath(item) ? 'hold-response' : null
    await uninstallInUi(control, item)
    await until(
      () => deletes(item),
      requests => requests.some(request => request.status === 204 && request.committedResponseHeld),
      'Real DELETE never committed'
    )
    assert.equal(await accountPlugin(cloud, item.slug), undefined)
    await assertInstallButton(control, item, 20_000)
    assert.equal(deletes(item).length, 1, 'Lost response caused a second destructive DELETE')
    assert.ok(
      apiProxy.requests
        .slice(startIndex)
        .some(
          request =>
            request.method === 'GET' &&
            request.path === '/api/plugins/installed' &&
            request.unscoped
        ),
      'Missing authoritative account verification GET'
    )
    await assertSurfaces(control, item, false)
    evidence.push({ case: 'committed-delete-lost-response', deleteCount: deletes(item).length })
    apiProxy.rule = () => null
  }

  async function unknownResult(control) {
    const item = await fixture('unknown-result')
    const startIndex = apiProxy.requests.length
    apiProxy.rule = request =>
      (request.method === 'DELETE' && request.path === deletePath(item)) ||
      (request.method === 'GET' && request.path === '/api/plugins/installed' && request.unscoped)
        ? 'hold-request'
        : null
    const started = await uninstallInUi(control, item)
    await control.command('waitFor', testId('plugin-operation-notice'), {
      text: '暂时无法确认卸载结果',
      timeoutMs: 30_000,
    })
    const elapsedMs = Date.now() - started
    assert.ok(elapsedMs < 30_000, `Unknown outcome kept loading for ${elapsedMs}ms`)
    assert.equal(deletes(item).length, 1)
    assert.ok(
      apiProxy.requests
        .slice(startIndex)
        .some(
          request =>
            request.method === 'GET' &&
            request.unscoped &&
            request.path === '/api/plugins/installed' &&
            request.fault === 'hold-request'
        )
    )
    assert.ok(await accountPlugin(cloud, item.slug), 'Canceled DELETE reached the backend')
    await control.command('waitFor', testId(`plugin-marketplace-actions-${item.pluginId}`), {
      enabled: true,
    })
    await assertInventory(control, item.slug, true)
    apiProxy.rule = () => null
    await assertSurfaces(control, item, true)
    // An explicit user retry is allowed only after the first attempt has settled.
    await uninstallInUi(control, item)
    await assertInstallButton(control, item)
    assert.equal(deletes(item).length, 2, 'Explicit retry must issue exactly one fresh DELETE')
    await assertSurfaces(control, item, false)
    evidence.push({ case: 'unknown-outcome-and-explicit-retry', elapsedMs })
  }

  async function heldCleanup(control, suffix) {
    const item = await fixture(suffix)
    const remoteHome = dirname(cloud.remoteCodexHome)
    const installed = await until(
      () => materializedPlugin(remoteHome, item.installedId),
      Boolean,
      'Fixture did not reach real remote Executor',
      workbenchReadyTimeoutMs
    )
    assert.ok(installed.runtime?.codex_link)
    const runtimePath = resolve(remoteHome, 'capabilities', installed.runtime.codex_link)
    assert.ok(await pathExists(runtimePath), 'Fixture has no real runtime files')
    assert.ok(deviceProxy.websockets.size > 0, 'Device fault proxy has no real connection')
    deviceProxy.pauseDeviceDelivery(true)
    const started = await uninstallInUi(control, item)
    await assertInstallButton(control, item)
    const elapsedMs = Date.now() - started
    assert.ok(elapsedMs < 10_000, 'Account DELETE waited for device cleanup')
    await until(
      () => pendingRows(item),
      rows => rows.some(row => row.state === 'uninstalling'),
      'Pending cleanup was not persisted'
    )
    assert.ok(await pathExists(runtimePath), 'Fault did not actually delay device cleanup')
    assert.equal(await accountPlugin(cloud, item.slug), undefined)
    await assertSurfaces(control, item, false)
    await openPlugin(control, item)
    await control.command('click', testId('plugins-refresh-button'))
    await assertInstallButton(control, item)
    await assertInventory(control, item.slug, false)
    assert.ok(await pathExists(runtimePath), 'Cleanup unexpectedly finished before fault release')
    evidence.push({ case: suffix, accountResponseMs: elapsedMs })
    return { item, runtimePath, remoteHome }
  }

  async function restartRecovery(control) {
    const { item, runtimePath, remoteHome } = await heldCleanup(control, 'restart-pending')
    // Stop real processes, losing the in-memory in-flight set while retaining MySQL.
    await cloud.stopBackend()
    assert.ok((await pendingRows(item)).some(row => row.state === 'uninstalling'))
    await cloud.launchBackend()
    deviceProxy.pauseDeviceDelivery(false)
    await cloud.waitForDeviceStatus(CLOUD_DEVICE_ID, 'online', cloud.remoteExecutorLogPath)
    await until(
      async () => ({
        plugin: await materializedPlugin(remoteHome, item.installedId),
        exists: await pathExists(runtimePath),
        rows: await pendingRows(item),
      }),
      value => !value.plugin && !value.exists && value.rows.length === 0,
      'Reconnect/heartbeat did not finish persisted cleanup and remove runtime files',
      workbenchReadyTimeoutMs
    )
    assert.equal(deletes(item).length, 1, 'Recovery sent another DELETE')
    await openPlugin(control, item)
    await assertInstallButton(control, item)
    await assertSurfaces(control, item, false)
  }

  async function reinstallRace(control) {
    const { item, remoteHome } = await heldCleanup(control, 'reinstall-pending')
    const release = await cloud.publishPluginRelease({
      slug: item.slug,
      version: '2.0.0',
      skills: { [item.slug]: 'Reinstalled version two' },
    })
    // Start a real install while the old removal is still awaiting its device ACK.
    const install = pluginApi(
      cloud,
      `/plugins/marketplace/${release.pluginId}/install?device_id=${encodeURIComponent(local.device_id)}`,
      'POST'
    )
    const installOutcome = install.then(
      value => ({ value }),
      error => ({ error })
    )
    try {
      const current = await until(
        () => accountPlugin(cloud, item.slug),
        plugin => plugin?.spec.version === '2.0.0',
        'Reinstall did not commit while cleanup was held'
      )
      deviceProxy.pauseDeviceDelivery(false)
      const outcome = await installOutcome
      if (outcome.error) throw outcome.error
      const currentId = Number(current.metadata.labels.id)
      await until(
        async () => {
          const plugin = await materializedPlugin(remoteHome, currentId)
          if (!plugin?.runtime?.codex_link) return null
          const path = resolve(
            remoteHome,
            'capabilities',
            plugin.runtime.codex_link,
            '.codex-plugin/plugin.json'
          )
          if (!(await pathExists(path))) return null
          return JSON.parse(await readFile(path, 'utf8'))
        },
        manifest => manifest?.version === '2.0.0',
        'Stale cleanup removed the reinstalled runtime',
        workbenchReadyTimeoutMs
      )
      await until(
        () => pendingRows(item),
        rows => rows.every(row => row.state !== 'uninstalling'),
        'Stale cleanup never settled',
        workbenchReadyTimeoutMs
      )
      assert.equal((await accountPlugin(cloud, item.slug)).spec.version, '2.0.0')
      await openPlugin(control, item)
      await control.command('click', testId('plugins-refresh-button'))
      await control.command('waitFor', testId(`plugin-marketplace-actions-${item.pluginId}`))
      await assertSurfaces(control, item, true)
      assert.equal(deletes(item).length, 1)
    } finally {
      deviceProxy.pauseDeviceDelivery(false)
      await installOutcome
    }
  }

  return {
    requiresCloudEnvironment: true,
    appEnvironment,
    async prepareCloud({ backendUrl }) {
      apiProxy = await new PluginFaultProxy(backendUrl).start()
      deviceProxy = await new PluginFaultProxy(backendUrl).start()
      appEnvironment.WEWORK_E2E_CLOUD_BACKEND_URL = apiProxy.url
    },
    setCloudEnvironment(value) {
      cloud = value
    },
    async verify(control) {
      controlRef = control
      local = await cloud.waitForConnectedAppDevice()
      cloud.remoteExecutorEnv.WEGENT_SOCKET_URL = deviceProxy.url
      await cloud.restartCloudExecutor()
      await until(
        () => deviceProxy.websockets.size,
        count => count > 0,
        'Remote device bypassed fault proxy'
      )
      try {
        await lostResponse(control)
        await unknownResult(control)
        await restartRecovery(control)
        await reinstallRace(control)
        await captureScreenshot(control, 'plugin-uninstall-resilience.png', 'body')
      } finally {
        apiProxy.rule = () => null
        deviceProxy.pauseDeviceDelivery(false)
        await writeFile(
          join(resultDir, 'plugin-uninstall-evidence.json'),
          JSON.stringify({ evidence, requests: apiProxy.requests }, null, 2)
        )
      }
    },
    diagnostics: () => ({ evidence, requests: apiProxy?.requests }),
    async cleanup() {
      await Promise.all([apiProxy?.stop(), deviceProxy?.stop()])
    },
  }
}
