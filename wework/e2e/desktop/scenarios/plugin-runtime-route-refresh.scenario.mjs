import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import {
  refreshPluginInventory,
  verifyPluginEnabledState,
} from '../modules/plugin-inventory-state.mjs'
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
  let restoredProxy
  let restoredTransport
  let transport
  let cleanedUp = false

  async function cleanup() {
    if (cleanedUp) return
    cleanedUp = true
    try {
      await restoredProxy?.stop()
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

  async function successfulAcknowledgement(sync) {
    const matches = value =>
      value.at >= sync.at &&
      value.namespace === sync.namespace &&
      value.id === sync.id &&
      value.pluginSync?.generation === sync.pluginSync.generation
    const acknowledgement = await until(
      () => transport.acknowledgements,
      values => values.some(value => matches(value) && value.success),
      'The current Runtime did not acknowledge its real plugin delta'
    ).then(values => values.find(value => matches(value) && value.success))
    assert.deepEqual(acknowledgement.pluginSync, sync.pluginSync)
    return acknowledgement
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
    const acknowledgement = await successfulAcknowledgement(sync[0])
    const installedIdentity = await identity(control)
    assert.equal(installedIdentity.description.device_route_id, current.execution_target_id)
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

  async function toggleInManager(control, current, stableDeviceId, fixture) {
    const toggle = testId(`installed-plugin-toggle-${fixture.installedId}`)
    for (const enabled of [false, true]) {
      await openPlugin(control, fixture)
      await control.command('click', testId('plugins-manage-button'))
      await control.command('waitFor', `${toggle}[aria-checked="${!enabled}"]`)
      const writeStart = transport.writes.length
      const capabilityStart = transport.capabilities.length

      await control.command('click', toggle)
      await until(
        () => accountPlugin(cloud, fixture.slug),
        plugin => plugin?.spec.enabled === enabled,
        'The manager toggle did not save the account enabled state'
      )
      const writes = transport.writes
        .slice(writeStart)
        .filter(
          request =>
            request.method === 'PUT' &&
            request.path === `/api/plugins/installed/${fixture.installedId}`
        )
      assert.equal(writes.length, 1, 'One manager toggle must issue one account update')
      assert.equal(writes[0].deviceId, current.execution_target_id)
      const sync = await until(
        () => transport.capabilities.slice(capabilityStart),
        values => values.some(value => value.pluginIds.includes(String(fixture.installedId))),
        'The manager toggle did not dispatch its actual current Runtime delta'
      ).then(values =>
        values.filter(value => value.pluginIds.includes(String(fixture.installedId)))
      )
      assert.equal(sync.length, 1, 'The manager toggle duplicated the current Runtime delta')
      assert.equal(sync[0].deviceId, current.execution_target_id)
      assert.equal(sync[0].scope, 'plugin_delta')
      assert.equal(sync[0].pluginSync.complete, false)
      assert.deepEqual(sync[0].pluginIds, [String(fixture.installedId)])
      const acknowledgement = await successfulAcknowledgement(sync[0])
      const runtime = await until(
        () => materializedPlugin(executorHome, fixture.installedId),
        plugin => plugin?.enabled === enabled,
        'The manager toggle did not update the current Runtime manifest',
        workbenchReadyTimeoutMs
      )
      await control.command('waitFor', `${toggle}[aria-checked="${enabled}"]`)
      await verifyPluginEnabledState(control, fixture, enabled, workbenchReadyTimeoutMs)
      const state = await inventory(control)
      assert.equal(state.sharedInventory.deviceId, stableDeviceId)
      assert.equal(
        state.sharedInventory.installedPlugins.filter(plugin => plugin.pluginKey === fixture.slug)
          .length,
        1
      )
      evidence.push({
        case: 'manager-toggle-after-route-refresh',
        enabled,
        writes,
        sync,
        acknowledgement,
        runtime,
        inventory: state,
      })
    }
  }

  async function pendingProfileMustNotReuseRoute(control, current, stableDeviceId, fixture) {
    const pendingSlug = 'plugin-route-pending-profile'
    const pending = {
      ...(await cloud.publishPluginRelease({
        slug: pendingSlug,
        version: '1.0.0',
        skills: { [pendingSlug]: 'Verify plugin routing while a real profile is configuring' },
      })),
      slug: pendingSlug,
    }
    const stored = JSON.parse(
      await control.command('getLocalStorageItem', 'body', { value: 'wework.cloudConnection' })
    )
    restoredProxy.rule = request =>
      request.method === 'POST' && request.path === '/api/users/me/wegent-runtime-token'
        ? 'hold-response'
        : null
    // Restore a real native profile through the production provider. The new
    // origin forwards to the same isolated backend; only its token response is
    // delayed. No status, API response or Executor identity is fabricated.
    await control.command('setAppPreferences', 'body', {
      value: JSON.stringify({
        cloudConnection: {
          ...stored,
          backendUrl: restoredProxy.url,
          apiBaseUrl: `${restoredProxy.url}/api`,
          socketBaseUrl: restoredProxy.url,
          socketBaseUrlOverride: restoredProxy.url,
          webUrl: restoredProxy.url,
        },
      }),
    })
    const readyCount = control.readyCount
    await control.command('reloadMainWindow', 'body')
    await control.awaitReadyAfter(readyCount)
    const held = await until(
      () => restoredProxy.requests,
      requests => requests.some(request => request.committedResponseHeld),
      'The restored profile did not wait for its real Runtime token response',
      workbenchReadyTimeoutMs
    ).then(requests => requests.find(request => request.committedResponseHeld))
    assert.equal(held.path, '/api/users/me/wegent-runtime-token')
    assert.equal(held.status, 200)
    const before = await identity(control)
    assert.equal(before.description.device_route_id, current.execution_target_id)
    assert.equal(before.deviceId, stableDeviceId)
    assert.ok(appProxy.websockets.size > 0, 'The previous real profile is no longer connected')
    assert.equal(restoredTransport.registrations.length, 0)
    const pendingDiagnostics = JSON.parse(
      await control.command('getPluginSyncDiagnostics', 'body', { value: stableDeviceId })
    )
    assert.equal(pendingDiagnostics.rendererConnected, false)

    try {
      const readOffset = restoredTransport.writes.length
      await openPlugin(control, fixture)
      await control.command('click', testId('plugins-manage-button'))
      const toggle = testId(`installed-plugin-toggle-${fixture.installedId}`)
      await control.command('waitFor', `${toggle}[aria-checked="true"]`)
      const reads = restoredTransport.writes
        .slice(readOffset)
        .filter(request => request.method === 'GET' && request.path === '/api/plugins/installed')
      assert.ok(reads.length > 0, 'The new profile did not read its real plugin account')
      assert.ok(reads.every(request => request.deviceId === null))
      const updateOffset = restoredTransport.writes.length
      await control.command('click', toggle)
      await until(
        () => accountPlugin(cloud, fixture.slug),
        plugin => plugin?.spec.enabled === false,
        'The account preference did not persist while Runtime configuration was pending'
      )
      const updates = restoredTransport.writes
        .slice(updateOffset)
        .filter(request => request.method === 'PUT')
      assert.equal(updates.length, 1)
      assert.equal(updates[0].deviceId, null, 'Account preference reused another profile route')
      await openPlugin(control, pending)
      await control.command('waitFor', testId(`plugin-marketplace-install-${pending.pluginId}`))
      const installOffset = restoredTransport.writes.length
      await control.command(
        'clickWhenEnabled',
        testId(`plugin-marketplace-install-${pending.pluginId}`)
      )
      await control.command('waitFor', testId('install-plugin-dialog-confirm'))
      await control.command('clickWhenEnabled', testId('install-plugin-dialog-confirm'))
      await control.command(
        'waitFor',
        `${testId('plugin-operation-notice')}[data-notice-kind="error"]`
      )
      const installs = restoredTransport.writes
        .slice(installOffset)
        .filter(request => request.method === 'POST' && request.path.endsWith('/install'))
      assert.deepEqual(installs, [], 'A required-device install reused another profile route')
      assert.equal(await accountPlugin(cloud, pending.slug), undefined)
      assert.equal(restoredTransport.registrations.length, 0)
      evidence.push({ case: 'restored-profile-token-pending', before, reads, updates, installs })
    } finally {
      restoredProxy.rule = () => null
      for (const request of restoredProxy.requests.filter(request => request.committedResponseHeld))
        await request.release()
    }
    await until(
      () => restoredTransport.registrations,
      registrations =>
        registrations.some(value => value.runtimeInstanceId === current.runtime_instance_id),
      'The real Runtime did not register on the restored profile after its token was released',
      workbenchReadyTimeoutMs
    )
    await until(
      async () =>
        JSON.parse(
          await control.command('getPluginSyncDiagnostics', 'body', { value: stableDeviceId })
        ),
      value => value.backend.connected && value.rendererConnected,
      'The restored profile registration did not become ready',
      workbenchReadyTimeoutMs
    )
    const recovered = await identity(control)
    assert.equal(recovered.deviceId, stableDeviceId)
    const offset = restoredTransport.writes.length
    await openPlugin(control, fixture)
    await control.command('click', testId('plugins-manage-button'))
    const toggle = testId(`installed-plugin-toggle-${fixture.installedId}`)
    await control.command('waitFor', `${toggle}[aria-checked="false"]`)
    await control.command('click', toggle)
    await until(
      () => accountPlugin(cloud, fixture.slug),
      plugin => plugin?.spec.enabled === true,
      'The account preference did not recover on the configured profile'
    )
    const updates = restoredTransport.writes
      .slice(offset)
      .filter(request => request.method === 'PUT')
    assert.equal(updates.length, 1)
    assert.equal(updates[0].deviceId, recovered.description.device_route_id)
    await openPlugin(control, pending)
    await control.command(
      'clickWhenEnabled',
      testId(`plugin-marketplace-install-${pending.pluginId}`)
    )
    await control.command('waitFor', testId('install-plugin-dialog-confirm'))
    await control.command('clickWhenEnabled', testId('install-plugin-dialog-confirm'))
    await control.command('waitFor', testId(`plugin-marketplace-actions-${pending.pluginId}`), {
      timeoutMs: workbenchReadyTimeoutMs,
    })
    const install = restoredTransport.writes
      .slice(offset)
      .filter(request => request.method === 'POST' && request.path.endsWith('/install'))
    assert.equal(install.length, 1)
    assert.equal(install[0].deviceId, recovered.description.device_route_id)
    assert.ok(await accountPlugin(cloud, pending.slug))
    evidence.push({ case: 'restored-profile-token-released', recovered, updates, install })
  }

  return {
    requiresCloudEnvironment: true,
    appEnvironment,
    backendEnv: objectStorage.backendEnv,
    async prepareCloud({ backendUrl }) {
      try {
        appProxy = await new TransportFaultProxy(backendUrl).start()
        transport = observePluginSyncTransport(appProxy)
        restoredProxy = await new TransportFaultProxy(backendUrl).start()
        restoredTransport = observePluginSyncTransport(restoredProxy)
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
        await toggleInManager(control, current, stableDeviceId, fixture)
        await pendingProfileMustNotReuseRoute(control, current, stableDeviceId, fixture)
        await captureScreenshot(control, 'plugin-runtime-route-refresh.png', 'body')
      } finally {
        appProxy.disconnectWebSockets(false)
        await writeFile(
          join(resultDir, 'plugin-runtime-route-refresh-evidence.json'),
          JSON.stringify({ evidence, transport, restoredTransport }, null, 2)
        )
      }
    },
    diagnostics: () => ({ evidence, transport, restoredTransport }),
    cleanup,
  }
}
