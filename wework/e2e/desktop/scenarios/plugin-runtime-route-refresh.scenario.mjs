import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { refreshPluginInventory } from '../modules/plugin-inventory-state.mjs'
import {
  accountPlugin,
  assertInventory,
  assertSurfaces,
  inventory,
  materializedPlugin,
  openPlugin,
  testId,
  until,
} from '../modules/plugin-regression-fixture.mjs'
import { observePluginSyncTransport } from '../modules/plugin-sync-observer.mjs'
import { startRealObjectStorage } from '../modules/real-object-storage.mjs'
import { createSingleRootLocalProject } from '../modules/shared.mjs'
import { TransportFaultProxy } from '../modules/transport-fault-proxy.mjs'

// Device rows are isolated fixture data. All registrations, IPC descriptions,
// renderer installs, package downloads and capability ACKs use real services.
export async function createDesktopScenario({
  captureScreenshot,
  executorHome,
  resultDir,
  workspacePath,
  workbenchReadyTimeoutMs,
}) {
  const appEnvironment = {}
  const evidence = []
  const objectStorage = await startRealObjectStorage(resultDir, workbenchReadyTimeoutMs)
  let cloud
  let appProxy
  let transport
  let cleanedUp = false

  async function cleanup() {
    if (cleanedUp) return
    cleanedUp = true
    try {
      await appProxy?.stop()
    } finally {
      await objectStorage.stop()
    }
  }

  const identity = async control =>
    JSON.parse(await control.command('getLocalExecutorIdentityDiagnostics', 'body'))
  const appRecord = (devices, status) =>
    devices.find(
      device =>
        device.device_type === 'app' &&
        device.runtime_instance_id === status.runtimeInstanceId &&
        device.app_device_id === status.deviceId &&
        device.status === 'online'
    )

  async function refreshRoute(control) {
    const before = await identity(control)
    const original = appRecord(await cloud.devices(), before.status)
    assert.ok(original, 'The initial real IPC identity has no online App registration')
    assert.equal(before.description.device_route_id, original.execution_target_id)
    assert.equal(before.deviceId, before.status.deviceId)
    assert.notEqual(before.status.deviceId, original.device_id)

    await cloud.startDuplicateAppDeviceIdentity()
    const duplicate = (await cloud.devices()).find(
      device =>
        device.device_type === 'app' &&
        device.device_id === original.device_id &&
        device.id !== original.id
    )
    assert.ok(duplicate, 'Missing the second real Runtime sharing the historical device ID')
    assert.notEqual(duplicate.runtime_instance_id, original.runtime_instance_id)
    assert.notEqual(duplicate.execution_target_id, original.execution_target_id)
    assert.equal(duplicate.app_device_id, before.status.deviceId)

    // Model a restored historical registration without changing the real
    // Executor home, Runtime identity, renderer process or its initialized cache.
    appProxy.disconnectWebSockets(true)
    await until(
      () => cloud.devices(),
      devices => devices.find(device => device.id === original.id)?.status === 'offline',
      'The current Runtime did not disconnect before historical row preparation',
      workbenchReadyTimeoutMs
    )
    const historicalRuntime = `historical-plugin-route-${original.id}`
    const changed = await cloud.executeDatabase(
      'UPDATE kinds SET `json` = JSON_SET(`json`, %s, %s) WHERE user_id = %s AND namespace = %s AND kind = %s AND id = %s AND JSON_UNQUOTE(JSON_EXTRACT(`json`, %s)) = %s',
      [
        '$.spec.runtimeInstanceId',
        historicalRuntime,
        1,
        'default',
        'Device',
        original.id,
        '$.spec.runtimeInstanceId',
        original.runtime_instance_id,
      ]
    )
    assert.equal(changed.affected, 1, 'Historical fixture must change exactly its owned Device row')
    appProxy.disconnectWebSockets(false)
    const current = await until(
      () => cloud.devices(),
      devices => appRecord(devices, before.status),
      'The unchanged real Runtime did not receive a fresh registration route',
      workbenchReadyTimeoutMs
    ).then(devices => appRecord(devices, before.status))
    assert.notEqual(current.id, original.id)
    assert.notEqual(current.execution_target_id, original.execution_target_id)
    assert.notEqual(current.execution_target_id, duplicate.execution_target_id)
    // Observe the ACK through raw IPC without changing the renderer cache.
    // Normal device-event refreshes may already have updated the cached route.
    const refreshed = await until(
      () => identity(control),
      value => value.description.device_route_id === current.execution_target_id,
      'The new registration route did not reach the real Executor IPC description',
      workbenchReadyTimeoutMs
    )
    assert.equal(refreshed.status.runtimeInstanceId, before.status.runtimeInstanceId)
    assert.equal(refreshed.status.deviceId, before.status.deviceId)
    assert.equal(refreshed.description.device_id, before.status.deviceId)
    assert.equal(refreshed.deviceId, before.status.deviceId)
    const devices = await cloud.devices()
    assert.equal(
      devices.find(device => device.id === original.id)?.runtime_instance_id,
      historicalRuntime
    )
    assert.equal(devices.find(device => device.id === original.id)?.status, 'offline')
    assert.equal(devices.find(device => device.id === duplicate.id)?.status, 'online')
    evidence.push({
      case: 'same-runtime-registration-route-refresh',
      before,
      refreshed,
      original,
      current,
      duplicate,
    })
    return { current, stableDeviceId: before.status.deviceId }
  }

  async function prepareInstall(control) {
    const slug = 'plugin-runtime-route-refresh'
    const release = await cloud.publishPluginRelease({
      slug,
      version: '1.0.0',
      skills: { [slug]: 'Verify installation on the current record-scoped Runtime' },
    })
    const fixture = { ...release, slug }
    await openPlugin(control, fixture)
    await refreshPluginInventory(control, workbenchReadyTimeoutMs)
    await control.command('waitFor', testId(`plugin-marketplace-install-${release.pluginId}`))
    return fixture
  }

  async function installOnCurrentRuntime(control, current, stableDeviceId, fixture) {
    const { slug, pluginId } = fixture
    const writeStart = transport.writes.length
    const capabilityStart = transport.capabilities.length
    await control.command('clickWhenEnabled', testId(`plugin-marketplace-install-${pluginId}`))
    await control.command('waitFor', testId('install-plugin-dialog-confirm'))
    await control.command('clickWhenEnabled', testId('install-plugin-dialog-confirm'))
    const installed = await until(
      () => accountPlugin(cloud, slug),
      Boolean,
      'The real UI install did not persist account membership'
    )
    fixture.installedId = Number(installed.metadata.labels.id)
    const runtime = await until(
      () => materializedPlugin(executorHome, fixture.installedId),
      value => Boolean(value?.runtime?.codex_link),
      'The UI install did not materialize on the Electron-owned current Runtime',
      workbenchReadyTimeoutMs
    )
    const root = resolve(executorHome, 'capabilities', runtime.runtime.codex_link)
    const manifest = JSON.parse(await readFile(join(root, '.codex-plugin/plugin.json'), 'utf8'))
    assert.equal(manifest.name, slug)
    assert.equal(manifest.version, '1.0.0')
    assert.ok((await readFile(join(root, 'skills', slug, 'SKILL.md'), 'utf8')).includes(slug))
    const writes = transport.writes
      .slice(writeStart)
      .filter(
        request =>
          request.method === 'POST' &&
          request.path === `/api/plugins/marketplace/${pluginId}/install`
      )
    assert.equal(writes.length, 1, 'One UI confirmation must issue one account install')
    assert.equal(writes[0].deviceId, current.execution_target_id)
    const sync = await until(
      () => transport.capabilities.slice(capabilityStart),
      requests => requests.some(request => request.pluginIds.includes(String(fixture.installedId))),
      'Current Runtime never received the actual plugin capability delta'
    ).then(requests =>
      requests.filter(request => request.pluginIds.includes(String(fixture.installedId)))
    )
    assert.equal(sync.length, 1, 'The current Runtime received a duplicate plugin delta')
    assert.equal(sync[0].deviceId, current.execution_target_id)
    assert.equal(sync[0].scope, 'plugin_delta')
    assert.equal(sync[0].pluginSync.complete, false)
    assert.deepEqual(sync[0].pluginIds, [String(fixture.installedId)])
    const acknowledgesInstall = value =>
      value.at >= sync[0].at &&
      value.namespace === sync[0].namespace &&
      value.id === sync[0].id &&
      value.pluginSync?.generation === sync[0].pluginSync.generation
    const acknowledgement = await until(
      () => transport.acknowledgements,
      values => values.some(value => acknowledgesInstall(value) && value.success),
      'The current Runtime did not acknowledge its real plugin install'
    ).then(values => values.find(acknowledgesInstall))
    assert.deepEqual(acknowledgement.pluginSync, sync[0].pluginSync)
    const installedIdentity = await identity(control)
    assert.equal(installedIdentity.deviceRouteId, current.execution_target_id)
    assert.equal(installedIdentity.deviceId, stableDeviceId)
    await control.command('waitFor', testId(`plugin-marketplace-actions-${pluginId}`), {
      timeoutMs: workbenchReadyTimeoutMs,
    })
    await control.command('click', testId('new-chat-button'))
    await control.command('click', testId('composer-plugin-picker-button'))
    await control.command('waitFor', testId('composer-plugin-picker'))
    await assertInventory(control, slug, true, workbenchReadyTimeoutMs)
    const state = await inventory(control)
    assert.equal(
      state.sharedInventory.deviceId,
      stableDeviceId,
      'Record routes leaked into stable renderer inventory identity'
    )
    assert.equal(
      state.sharedInventory.installedPlugins.filter(plugin => plugin.pluginKey === slug).length,
      1
    )
    assert.equal(state.composerApps.filter(plugin => plugin.pluginKey === slug).length, 1)
    await control.command('click', testId('composer-plugin-picker-button'))
    await openPlugin(control, fixture)
    await assertSurfaces(control, fixture, true)
    evidence.push({
      case: 'ui-install-after-route-refresh',
      fixture,
      writes,
      sync,
      acknowledgement,
      inventory: state,
      installedIdentity,
    })
  }

  return {
    requiresCloudEnvironment: true,
    appEnvironment,
    backendEnv: objectStorage.backendEnv,
    async prepareCloud({ backendUrl }) {
      try {
        appProxy = await new TransportFaultProxy(backendUrl).start()
        transport = observePluginSyncTransport(appProxy)
        appEnvironment.WEWORK_E2E_CLOUD_BACKEND_URL = appProxy.url
        appEnvironment.WEWORK_BACKEND_URL = appProxy.url
        appEnvironment.WEWORK_SOCKET_URL = appProxy.url
      } catch (error) {
        await cleanup()
        throw error
      }
    },
    setCloudEnvironment(value) {
      cloud = value
    },
    async verify(control) {
      try {
        await cloud.waitForConnectedAppDevice()
        await createSingleRootLocalProject(control, workspacePath, 'plugin-route-refresh-workspace')
        const fixture = await prepareInstall(control)
        const { current, stableDeviceId } = await refreshRoute(control)
        await installOnCurrentRuntime(control, current, stableDeviceId, fixture)
        await captureScreenshot(control, 'plugin-runtime-route-refresh.png', 'body')
      } finally {
        appProxy.disconnectWebSockets(false)
        await writeFile(
          join(resultDir, 'plugin-runtime-route-refresh-evidence.json'),
          JSON.stringify({ evidence, transport }, null, 2)
        )
      }
    },
    diagnostics: () => ({ evidence, transport }),
    cleanup,
  }
}
