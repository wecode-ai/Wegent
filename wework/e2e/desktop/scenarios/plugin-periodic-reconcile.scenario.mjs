import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { CLOUD_DEVICE_ID } from '../modules/shared.mjs'
import {
  accountPlugin,
  materializedPlugin,
  pluginApi,
  until,
} from '../modules/plugin-regression-fixture.mjs'
import { observePluginSyncTransport } from '../modules/plugin-sync-observer.mjs'
import { startRealObjectStorage } from '../modules/real-object-storage.mjs'
import { TransportFaultProxy } from '../modules/transport-fault-proxy.mjs'

const MIN_RECONCILE_DELAY_MS = 600_000
const MAX_RECONCILE_DELAY_MS = 720_000
const REGISTRATION_ACK_TIMEOUT_MS = 10_000

// A complete reconciliation advances ordering metadata for all managed plugins.
// Compare the unrelated plugin's actual identity, content, state and runtime.
function pluginRuntime(plugin) {
  return Object.fromEntries(
    [
      'managed',
      'name',
      'key',
      'marketplace',
      'installed_plugin_id',
      'cloud_plugin_id',
      'version',
      'checksum',
      'enabled',
      'component_states',
      'store_path',
      'runtime',
      'previous',
    ].map(key => [key, plugin[key]])
  )
}

// Only the selected real Socket.IO change frame is withheld. MySQL, APIs,
// Electron, IPC, Executor, package storage and the production timer remain real.
export async function createDesktopScenario({
  captureScreenshot,
  executorHome,
  resultDir,
  workbenchReadyTimeoutMs,
}) {
  const objectStorage = await startRealObjectStorage(resultDir, workbenchReadyTimeoutMs)
  const appEnvironment = {}
  const evidence = []
  let cloud
  let proxy
  let observation
  let missedInstalledId
  const manifest = async () =>
    JSON.parse(await readFile(join(executorHome, 'capabilities/manifest-v2.json'), 'utf8'))
  const diagnostics = () => ({
    objectStorage: 'MinIO',
    evidence,
    capabilities: observation?.capabilities,
    acknowledgements: observation?.acknowledgements,
    registrations: observation?.registrations,
    heartbeats: observation?.heartbeats,
    reconciliations: observation?.reconciliations,
    requests: proxy?.requests,
    heldChange: observation?.gate.held,
  })

  async function update(item, deviceId, body) {
    const response = await fetch(
      `${cloud.backendUrl}/api/plugins/installed/${item.installedId}?device_id=${encodeURIComponent(deviceId)}`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${cloud.authToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(workbenchReadyTimeoutMs),
      }
    )
    assert.ok(response.ok, `Real plugin runtime-state update failed: HTTP ${response.status}`)
    return response.json()
  }

  async function install(slug, deviceRouteId) {
    const release = await cloud.publishPluginRelease({
      slug,
      version: '1.0.0',
      skills: { [slug]: `Use ${slug} for periodic recovery verification` },
    })
    await pluginApi(
      cloud,
      `/plugins/marketplace/${release.pluginId}/install?device_id=${encodeURIComponent(deviceRouteId)}`,
      'POST'
    )
    const installed = await accountPlugin(cloud, slug)
    assert.ok(installed, 'Real periodic-recovery fixture has no account installation')
    return { ...release, slug, installedId: Number(installed.metadata.labels.id) }
  }

  async function waitForAutomaticRecovery({ item, deviceRouteId, baseline, retained }) {
    const deadline = baseline.registeredAt + MAX_RECONCILE_DELAY_MS + workbenchReadyTimeoutMs
    let lastProgressAt = 0
    while (Date.now() < deadline) {
      if (observation.gate.error) throw observation.gate.error
      assert.equal(
        observation.registrations.length,
        baseline.registrationCount,
        'A reconnect replaced the periodic recovery path'
      )
      const requests = observation.reconciliations.slice(baseline.reconciliationCount)
      assert.ok(requests.length <= 1, 'Recovery issued duplicate reconcile requests')
      const current = await materializedPlugin(executorHome, item.installedId)
      if (
        current?.enabled === false &&
        current.component_states?.[`skill:${item.slug}`] === false
      ) {
        assert.equal(requests.length, 1, 'Runtime recovered without its production reconcile timer')
        const request = requests[0]
        assert.equal(request.reconcile, true)
        assert.equal(request.deviceId, deviceRouteId, 'Periodic pull used a stale device route')
        const elapsedMs = request.at - baseline.registeredAt
        assert.ok(
          elapsedMs >= MIN_RECONCILE_DELAY_MS &&
            elapsedMs <= MAX_RECONCILE_DELAY_MS + REGISTRATION_ACK_TIMEOUT_MS,
          `Periodic request did not use the real 600–720 second schedule: ${elapsedMs}ms`
        )
        return { current, request, elapsedMs }
      }
      const unchanged = await materializedPlugin(executorHome, retained.installedId)
      assert.deepEqual(
        requests.length === 0 ? unchanged : pluginRuntime(unchanged),
        requests.length === 0 ? baseline.retained : pluginRuntime(baseline.retained),
        'The lost change or reconciliation altered an unrelated plugin runtime'
      )
      if (Date.now() - lastProgressAt >= 30_000) {
        lastProgressAt = Date.now()
        console.log(
          `[plugin-periodic-reconcile] waiting for production timer: ` +
            `${Math.floor((Date.now() - baseline.registeredAt) / 1000)}s; ` +
            `heartbeats=${observation.heartbeats.length - baseline.heartbeatCount}`
        )
      }
      await new Promise(resolve => setTimeout(resolve, 2_000))
    }
    throw new Error('The production plugin reconcile timer did not recover the missed change')
  }

  async function verifyRecovery(control) {
    const local = await cloud.waitForConnectedAppDevice()
    const deviceRouteId = local.socket_device_id || local.execution_target_id
    assert.match(deviceRouteId, /^app-record-\d+$/, 'The App has no exact Runtime record route')
    // Do not open the plugin workspace: its user-facing catalog refresh and
    // initial auto-sync must not become a competing recovery trigger.
    const item = await install('periodic-reconcile-changed-plugin', deviceRouteId)
    const retained = await install('periodic-reconcile-retained-plugin', deviceRouteId)
    await update(item, deviceRouteId, { updatePolicy: 'manual' })
    await update(retained, deviceRouteId, { updatePolicy: 'manual' })
    await until(
      async () => ({
        changed: await materializedPlugin(executorHome, item.installedId),
        retained: await materializedPlugin(executorHome, retained.installedId),
      }),
      value => value.changed?.enabled === true && value.retained?.enabled === true,
      'The isolated local Executor did not materialize both plugin fixtures',
      workbenchReadyTimeoutMs
    )
    assert.ok(proxy.websockets.size > 0, 'The local Executor bypassed the real fault proxy')
    assert.ok(observation.registrations.length > 0, 'The local registration was not observed')
    const registered = observation.registrations.at(-1)
    assert.equal(registered.runtimeInstanceId, local.runtime_instance_id)
    const before = await manifest()
    const retainedBefore = await materializedPlugin(executorHome, retained.installedId)
    const retainedSkillPath = join(
      retainedBefore.runtime.codex_link,
      'skills',
      retained.slug,
      'SKILL.md'
    )
    const retainedSkill = await readFile(retainedSkillPath)
    const baseline = {
      registeredAt: registered.at,
      registrationCount: observation.registrations.length,
      heartbeatCount: observation.heartbeats.length,
      reconciliationCount: observation.reconciliations.length,
      retained: retainedBefore,
      capturedAt: Date.now(),
    }
    assert.ok(
      Date.now() - baseline.registeredAt < MIN_RECONCILE_DELAY_MS - 30_000,
      'Fixture setup consumed the first production timer period'
    )
    missedInstalledId = item.installedId
    const componentStates = { [`skill:${item.slug}`]: false }
    // The remote device completes the account mutation. Its background delta
    // to the current App is lost; no UI refresh, reconnect or manual sync follows.
    await update(item, CLOUD_DEVICE_ID, { enabled: false, componentStates })
    const held = await until(
      () => {
        if (observation.gate.error) throw observation.gate.error
        return observation.gate.held
      },
      Boolean,
      'The account change did not send the real targeted delta to the local Executor'
    )
    assert.equal(held.scope, 'plugin_delta')
    assert.equal(held.pluginSync.complete, false)
    const missed = observation.capabilities.find(
      value => value.pluginSync?.generation === held.pluginSync.generation
    )
    assert.deepEqual(missed.pluginIds, [String(item.installedId)])
    assert.deepEqual(missed.removedIds, [])
    assert.deepEqual(missed.skills, [])
    assert.deepEqual(missed.mcps, [])
    observation.gate.discard()
    assert.equal((await accountPlugin(cloud, item.slug)).spec.enabled, false)
    assert.equal((await materializedPlugin(executorHome, item.installedId)).enabled, true)
    evidence.push({ case: 'real-runtime-state-change-notification-lost', discarded: true, missed })

    const recovered = await waitForAutomaticRecovery({ item, deviceRouteId, baseline, retained })
    const complete = await until(
      () => observation.capabilities,
      values =>
        values.some(
          value =>
            value.at >= recovered.request.at &&
            value.scope === 'plugins' &&
            value.pluginSync?.complete === true
        ),
      'The timer request did not produce a real complete plugin snapshot'
    ).then(values =>
      values.find(
        value =>
          value.at >= recovered.request.at &&
          value.scope === 'plugins' &&
          value.pluginSync?.complete
      )
    )
    assert.deepEqual(complete.skills, [])
    assert.deepEqual(complete.mcps, [])
    assert.ok(complete.pluginSync.generation > missed.pluginSync.generation)
    const acknowledged = await until(
      () =>
        observation.acknowledgements.find(
          value =>
            value.at >= complete.at &&
            value.id === complete.id &&
            value.namespace === complete.namespace &&
            value.pluginSync?.generation === complete.pluginSync.generation
        ),
      Boolean,
      'The real Executor did not acknowledge automatic plugin reconciliation'
    )
    assert.equal(acknowledged.success, true)
    assert.equal(acknowledged.scope, 'plugins')
    assert.deepEqual(acknowledged.pluginSync, complete.pluginSync)
    const persisted = await until(
      () =>
        cloud.queryDatabase(
          'SELECT state, desired_release_id, actual_release_id, error_code FROM plugin_device_installations WHERE user_id = %s AND installed_kind_id = %s AND device_id = %s',
          [1, item.installedId, deviceRouteId]
        ),
      rows =>
        rows.length === 1 &&
        rows[0].state === 'installed' &&
        rows[0].desired_release_id === item.releaseId &&
        rows[0].actual_release_id === item.releaseId &&
        !rows[0].error_code,
      'Automatic reconciliation did not persist its real App-route acknowledgement'
    )
    const after = await manifest()
    assert.deepEqual(
      pluginRuntime(await materializedPlugin(executorHome, retained.installedId)),
      pluginRuntime(retainedBefore)
    )
    assert.deepEqual(await readFile(retainedSkillPath), retainedSkill)
    assert.deepEqual(after.skills, before.skills)
    assert.deepEqual(after.mcps, before.mcps)
    assert.equal(recovered.current.version, '1.0.0', 'State recovery changed the plugin release')
    assert.deepEqual(recovered.current.component_states, componentStates)
    const heartbeats = observation.heartbeats.slice(baseline.heartbeatCount)
    assert.ok(heartbeats.length >= 10, 'Holding one plugin notification blocked Runtime liveness')
    assert.ok(heartbeats.at(-1).at >= recovered.request.at - 60_000)
    const liveness = [baseline.capturedAt, ...heartbeats.map(value => value.at), Date.now()]
    const longestHeartbeatGapMs = Math.max(
      ...liveness.slice(1).map((at, index) => at - liveness[index])
    )
    assert.ok(
      longestHeartbeatGapMs < 60_000,
      'Missed plugin delivery interrupted Runtime heartbeats'
    )
    const currentDevice = (await cloud.devices()).find(device => device.id === local.id)
    assert.equal(currentDevice?.status, 'online')
    assert.equal(currentDevice?.runtime_instance_id, local.runtime_instance_id)
    assert.equal(currentDevice?.device_id, local.device_id)
    assert.equal(
      currentDevice?.socket_device_id || currentDevice?.execution_target_id,
      deviceRouteId
    )
    evidence.push({
      case: 'production-timer-recovers-missed-plugin-state-without-reconnect-or-refresh',
      deviceRouteId,
      runtimeInstanceId: local.runtime_instance_id,
      elapsedMs: recovered.elapsedMs,
      request: recovered.request,
      acknowledged,
      persisted,
      heartbeats: heartbeats.length,
      longestHeartbeatGapMs,
      unchangedPluginId: retained.installedId,
    })
    await captureScreenshot(control, 'plugin-periodic-reconcile.png', 'body')
  }

  return {
    requiresCloudEnvironment: true,
    backendEnv: objectStorage.backendEnv,
    appEnvironment,
    async prepareCloud({ backendUrl }) {
      proxy = await new TransportFaultProxy(backendUrl).start()
      observation = observePluginSyncTransport(proxy, {
        holdCapability: payload =>
          missedInstalledId !== undefined &&
          payload.scope === 'plugin_delta' &&
          payload.plugins?.some(
            plugin =>
              Number(plugin.installed_plugin_id) === missedInstalledId && plugin.enabled === false
          ),
      })
      appEnvironment.WEWORK_E2E_CLOUD_BACKEND_URL = proxy.url
      appEnvironment.WEWORK_BACKEND_URL = proxy.url
      appEnvironment.WEWORK_SOCKET_URL = proxy.url
    },
    setCloudEnvironment(value) {
      cloud = value
    },
    async verify(control) {
      try {
        await verifyRecovery(control)
      } finally {
        await writeFile(
          join(resultDir, 'plugin-periodic-reconcile-evidence.json'),
          JSON.stringify(diagnostics(), null, 2)
        )
      }
    },
    diagnostics,
    async cleanup() {
      try {
        await proxy?.stop()
      } finally {
        await objectStorage.stop()
      }
    },
  }
}
