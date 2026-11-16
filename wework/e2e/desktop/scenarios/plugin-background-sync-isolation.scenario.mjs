import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { stopProcessGroup } from '../process-lifecycle.mjs'
import { CLOUD_DEVICE_ID } from '../modules/shared.mjs'
import { refreshPluginInventory } from '../modules/plugin-inventory-state.mjs'
import {
  accountPlugin,
  assertInstallButton,
  assertSurfaces,
  installFixture,
  materializedPlugin,
  openPlugin,
  testId,
  until,
} from '../modules/plugin-regression-fixture.mjs'
import { observePluginSyncTransport } from '../modules/plugin-sync-observer.mjs'
import { startRealObjectStorage } from '../modules/real-object-storage.mjs'
import { TransportFaultProxy } from '../modules/transport-fault-proxy.mjs'

// QA: two real online Runtimes share an account with an unrelated plugin.
// Hold the other Runtime's real ACK, then disconnect it for a second install.
// Both foreground UI installs must finish on the current Runtime; only the
// changed plugin may advance on either Runtime, including after reconnection.
export async function createDesktopScenario({
  captureScreenshot,
  executorHome,
  resultDir,
  workbenchReadyTimeoutMs,
}) {
  const appEnvironment = {}
  const evidence = []
  const objectStorage = await startRealObjectStorage(resultDir, workbenchReadyTimeoutMs)
  let cloud
  let localProxy
  let remoteProxy
  let localTraffic
  let remoteTraffic
  let localDevice
  let currentRoute
  let retained
  let remoteHome

  const rows = installedId =>
    cloud.queryDatabase(
      'SELECT device_id, state, actual_release_id, desired_release_id FROM plugin_device_installations WHERE user_id = %s AND installed_kind_id = %s',
      [1, installedId]
    )
  const onDevice = (state, deviceId) => state.find(row => row.device_id === deviceId)
  const entry = (home, fixture) => materializedPlugin(home, fixture.installedId)
  const matching = (traffic, fixture, from) =>
    traffic.capabilities
      .slice(from)
      .filter(request => request.pluginIds.includes(String(fixture.installedId)))

  async function snapshotRetained() {
    return {
      local: await entry(executorHome, retained),
      remote: await entry(remoteHome, retained),
    }
  }

  function assertTargeted(requests, fixture, route) {
    assert.equal(requests.length, 1, 'A plugin change must dispatch exactly once per Runtime')
    const [request] = requests
    assert.equal(request.deviceId, route, 'Plugin delta targeted the wrong Runtime route')
    assert.equal(request.scope, 'plugin_delta')
    assert.equal(request.mode, 'merge')
    assert.equal(request.pluginSync?.version, 2)
    assert.equal(request.pluginSync.complete, false)
    assert.deepEqual(request.pluginIds, [String(fixture.installedId)])
    assert.deepEqual(request.removedIds, [])
    assert.deepEqual(request.skills, [])
    assert.deepEqual(request.mcps, [])
  }

  async function prepareInstall(control, suffix) {
    const slug = `background-sync-${suffix}`
    const fixture = {
      ...(await cloud.publishPluginRelease({
        slug,
        version: '1.0.0',
        skills: { [slug]: `Use ${slug} to verify isolated account plugin synchronization` },
      })),
      slug,
    }
    await openPlugin(control, fixture)
    await refreshPluginInventory(control, workbenchReadyTimeoutMs)
    await assertInstallButton(control, fixture)
    await control.command(
      'clickWhenEnabled',
      testId(`plugin-marketplace-install-${fixture.pluginId}`)
    )
    await control.command('waitFor', testId('install-plugin-dialog-confirm'))
    return fixture
  }

  async function installInCurrentRuntime(control, fixture) {
    const requestOffset = localProxy.requests.length
    const startedAt = Date.now()
    await control.command('clickWhenEnabled', testId('install-plugin-dialog-confirm'))
    await control.command('waitFor', testId(`plugin-marketplace-actions-${fixture.pluginId}`))
    const install = await until(
      () =>
        localProxy.requests
          .slice(requestOffset)
          .filter(
            request =>
              request.method === 'POST' &&
              request.path === `/api/plugins/marketplace/${fixture.pluginId}/install`
          ),
      requests => requests.length === 1 && requests[0].delivered,
      'The foreground install did not return while the other device was unavailable'
    )
    const elapsedMs = Date.now() - startedAt
    assert.equal(install[0].status, 200)
    assert.ok(elapsedMs < 10_000, `Another device delayed the foreground install: ${elapsedMs}ms`)
    const installed = await accountPlugin(cloud, fixture.slug)
    assert.ok(installed, 'Foreground success did not persist account membership')
    fixture.installedId = Number(installed.metadata.labels.id)
    const actual = await until(
      () => entry(executorHome, fixture),
      plugin => Boolean(plugin?.runtime?.codex_link),
      'The current real Runtime did not materialize its foreground install'
    )
    assert.ok(Number.isSafeInteger(actual.plugin_sync_generation))
    const state = onDevice(await rows(fixture.installedId), currentRoute)
    assert.equal(state?.state, 'installed')
    assert.equal(state.actual_release_id, fixture.releaseId)
    return { elapsedMs, actual }
  }

  async function verifyHeldOtherAck(control) {
    const fixture = await prepareInstall(control, 'held-ack')
    const before = await snapshotRetained()
    const localOffset = localTraffic.capabilities.length
    const remoteOffset = remoteTraffic.capabilities.length
    remoteProxy.pauseDeviceAcknowledgements(true)
    try {
      const result = await installInCurrentRuntime(control, fixture)
      const remote = await until(
        () => entry(remoteHome, fixture),
        plugin => Boolean(plugin?.runtime?.codex_link),
        'The other real Runtime never received and materialized its background delta',
        workbenchReadyTimeoutMs
      )
      const state = onDevice(await rows(fixture.installedId), CLOUD_DEVICE_ID)
      assert.equal(state?.state, 'pending', 'The held background ACK unexpectedly reached MySQL')
      const remoteRequests = matching(remoteTraffic, fixture, remoteOffset)
      assertTargeted(matching(localTraffic, fixture, localOffset), fixture, currentRoute)
      assertTargeted(remoteRequests, fixture, CLOUD_DEVICE_ID)
      assert.equal(
        remoteTraffic.acknowledgements.some(
          ack => ack.pluginSync?.generation === remoteRequests[0].pluginSync.generation
        ),
        false,
        'The foreground response was observed only after the background ACK was released'
      )
      assert.deepEqual(
        await snapshotRetained(),
        before,
        'Background delta changed an unrelated plugin'
      )
      evidence.push({
        case: 'foreground-install-completes-with-other-runtime-ack-held',
        installedId: fixture.installedId,
        responseMs: result.elapsedMs,
        currentGeneration: result.actual.plugin_sync_generation,
        otherGeneration: remote.plugin_sync_generation,
        persistedOtherState: state.state,
      })
    } finally {
      remoteProxy.pauseDeviceAcknowledgements(false)
    }
    await until(
      () => rows(fixture.installedId),
      state =>
        onDevice(state, CLOUD_DEVICE_ID)?.state === 'installed' &&
        onDevice(state, CLOUD_DEVICE_ID)?.actual_release_id === fixture.releaseId,
      'Releasing the real other-device ACK did not confirm its background install'
    )
    assertTargeted(matching(localTraffic, fixture, localOffset), fixture, currentRoute)
    assertTargeted(matching(remoteTraffic, fixture, remoteOffset), fixture, CLOUD_DEVICE_ID)
    assert.deepEqual(
      await snapshotRetained(),
      before,
      'ACK recovery changed an unrelated generation'
    )
    await assertSurfaces(control, fixture, true)
  }

  async function verifyOfflineOtherDevice(control) {
    const fixture = await prepareInstall(control, 'offline')
    const remoteExecutor = cloud.remoteExecutor
    cloud.remoteExecutor = null
    await stopProcessGroup(remoteExecutor)
    await cloud.waitForDeviceStatus(CLOUD_DEVICE_ID, 'offline', cloud.remoteExecutorLogPath)
    const before = await snapshotRetained()
    const localOffset = localTraffic.capabilities.length
    const remoteOffset = remoteTraffic.capabilities.length
    const result = await installInCurrentRuntime(control, fixture)
    assert.equal(
      await entry(remoteHome, fixture),
      null,
      'The offline Runtime received a new plugin'
    )
    assert.equal(onDevice(await rows(fixture.installedId), CLOUD_DEVICE_ID)?.state, 'pending')
    assertTargeted(matching(localTraffic, fixture, localOffset), fixture, currentRoute)
    assert.deepEqual(matching(remoteTraffic, fixture, remoteOffset), [])
    assert.deepEqual(await snapshotRetained(), before)
    evidence.push({
      case: 'foreground-install-completes-with-other-runtime-offline',
      installedId: fixture.installedId,
      responseMs: result.elapsedMs,
      currentGeneration: result.actual.plugin_sync_generation,
    })
    await cloud.restartCloudExecutor()
    await until(
      async () => ({
        plugin: await entry(remoteHome, fixture),
        rows: await rows(fixture.installedId),
      }),
      value =>
        Boolean(value.plugin?.runtime?.codex_link) &&
        onDevice(value.rows, CLOUD_DEVICE_ID)?.state === 'installed' &&
        onDevice(value.rows, CLOUD_DEVICE_ID)?.actual_release_id === fixture.releaseId,
      'The formerly offline Runtime did not recover its account install on registration',
      workbenchReadyTimeoutMs
    )
    // Registration is a complete account snapshot; it may advance the other
    // Runtime's retained generation. It must never resend the current Runtime.
    assertTargeted(matching(localTraffic, fixture, localOffset), fixture, currentRoute)
    assert.deepEqual((await snapshotRetained()).local, before.local)
    assert.equal((await entry(remoteHome, retained)).version, before.remote.version)
    await assertSurfaces(control, fixture, true)
    evidence.push({ case: 'offline-background-install-recovers-on-real-registration' })
  }

  return {
    requiresCloudEnvironment: true,
    appEnvironment,
    backendEnv: objectStorage.backendEnv,
    async prepareCloud({ backendUrl }) {
      localProxy = await new TransportFaultProxy(backendUrl).start()
      remoteProxy = await new TransportFaultProxy(backendUrl).start()
      localTraffic = observePluginSyncTransport(localProxy)
      remoteTraffic = observePluginSyncTransport(remoteProxy)
      appEnvironment.WEWORK_E2E_CLOUD_BACKEND_URL = localProxy.url
      appEnvironment.WEWORK_BACKEND_URL = localProxy.url
      appEnvironment.WEWORK_SOCKET_URL = localProxy.url
    },
    setCloudEnvironment(value) {
      cloud = value
    },
    async verify(control) {
      try {
        localDevice = await cloud.waitForConnectedAppDevice()
        currentRoute = localDevice.execution_target_id
        assert.match(
          currentRoute,
          /^app-record-\d+$/,
          'Current Runtime must use its registered app record route'
        )
        assert.equal(currentRoute, localDevice.socket_device_id)
        await cloud.stopRemoteDockerExecutorAndWaitOffline()
        cloud.remoteExecutorEnv.WEGENT_SOCKET_URL = remoteProxy.url
        await cloud.restartCloudExecutor()
        await until(
          () => ({ local: localProxy.websockets.size, remote: remoteProxy.websockets.size }),
          value => value.local > 0 && value.remote > 0,
          'Real current and other Runtime connections bypassed the fault observers'
        )
        remoteHome = dirname(cloud.remoteCodexHome)
        retained = await installFixture(
          cloud,
          control,
          'background-sync-retained',
          currentRoute,
          workbenchReadyTimeoutMs
        )
        await until(
          () => rows(retained.installedId),
          state => onDevice(state, CLOUD_DEVICE_ID)?.state === 'installed',
          'The unrelated baseline plugin did not converge on the other real Runtime',
          workbenchReadyTimeoutMs
        )
        const baseline = await snapshotRetained()
        assert.ok(Number.isSafeInteger(baseline.local?.plugin_sync_generation))
        assert.ok(Number.isSafeInteger(baseline.remote?.plugin_sync_generation))
        await verifyHeldOtherAck(control)
        await verifyOfflineOtherDevice(control)
        await captureScreenshot(control, 'plugin-background-sync-isolation.png', 'body')
      } finally {
        remoteProxy.pauseDeviceAcknowledgements(false)
        await writeFile(
          join(resultDir, 'plugin-background-sync-isolation-evidence.json'),
          JSON.stringify({ evidence, currentRoute, localTraffic, remoteTraffic }, null, 2)
        )
      }
    },
    diagnostics: () => ({ evidence, currentRoute, localTraffic, remoteTraffic }),
    async cleanup() {
      try {
        await Promise.all([localProxy?.stop(), remoteProxy?.stop()])
      } finally {
        await objectStorage.stop()
      }
    },
  }
}
