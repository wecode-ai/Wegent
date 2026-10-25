import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { stopProcessGroup } from '../process-lifecycle.mjs'
import { CLOUD_DEVICE_ID, REMOTE_DOCKER_DEVICE_ID } from '../modules/shared.mjs'
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
  let cloudProxy
  let cloudObservation
  let missedInstalledId
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
    cloud: cloudObservation,
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

  async function settledSetup(targets, operate, existing) {
    const previous = existing
      ? await cloud.queryDatabase(
          'SELECT device_id, CAST(last_sync_at AS CHAR) AS last_sync_at FROM plugin_device_installations WHERE user_id = %s AND installed_kind_id = %s',
          [1, existing.installedId]
        )
      : []
    const offsets = targets.map(target => target.observation.capabilities.length)
    const fixture = await operate()
    await Promise.all(
      targets.map(async (target, index) => {
        const requests = await until(
          () =>
            target.observation.capabilities
              .slice(offsets[index])
              .filter(
                value =>
                  value.scope === 'plugin_delta' &&
                  value.pluginIds.includes(String(fixture.installedId))
              ),
          values => values.length > 0,
          `${target.kind} did not receive its actual setup delta`,
          workbenchReadyTimeoutMs
        )
        assert.equal(requests.length, 1, `${target.kind} received duplicate setup deltas`)
        const [request] = requests
        const before = previous.find(row => row.device_id === target.persistedDeviceId)
        const settled = await until(
          async () => ({
            acknowledgement: target.observation.acknowledgements.find(
              value =>
                value.at >= request.at &&
                value.id === request.id &&
                value.namespace === request.namespace &&
                value.pluginSync?.generation === request.pluginSync.generation
            ),
            plugin: await materializedPlugin(target.home, fixture.installedId),
            rows: await cloud.queryDatabase(
              'SELECT state, desired_release_id, actual_release_id, error_code, CAST(last_sync_at AS CHAR) AS last_sync_at FROM plugin_device_installations WHERE user_id = %s AND installed_kind_id = %s AND device_id = %s',
              [1, fixture.installedId, target.persistedDeviceId]
            ),
          }),
          value =>
            value.acknowledgement?.success === true &&
            value.plugin?.plugin_sync_generation === request.pluginSync.generation &&
            value.rows.length === 1 &&
            value.rows[0].state === 'installed' &&
            value.rows[0].desired_release_id === fixture.releaseId &&
            value.rows[0].actual_release_id === fixture.releaseId &&
            !value.rows[0].error_code &&
            (!before || value.rows[0].last_sync_at !== before.last_sync_at),
          `${target.kind} setup ACK, Runtime generation and persisted result did not settle`,
          workbenchReadyTimeoutMs
        )
        assert.deepEqual(settled.acknowledgement.pluginSync, request.pluginSync)
        evidence.push({
          case: 'setup-delta-acknowledged-and-persisted-before-baseline',
          target: target.kind,
          installedId: fixture.installedId,
          generation: request.pluginSync.generation,
          persisted: settled.rows,
        })
      })
    )
    return fixture
  }

  async function waitForAutomaticRecovery({ target, item, baseline, retained }) {
    const { observation, home, deviceRouteId } = target
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
      const current = await materializedPlugin(home, item.installedId)
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
      const unchanged = await materializedPlugin(home, retained.installedId)
      assert.deepEqual(
        requests.length === 0 ? unchanged : pluginRuntime(unchanged),
        requests.length === 0 ? baseline.retained : pluginRuntime(baseline.retained),
        'The lost change or reconciliation altered an unrelated plugin runtime'
      )
      if (Date.now() - lastProgressAt >= 30_000) {
        lastProgressAt = Date.now()
        console.log(
          `[plugin-periodic-reconcile:${target.kind}] waiting for production timer: ` +
            `${Math.floor((Date.now() - baseline.registeredAt) / 1000)}s; ` +
            `heartbeats=${observation.heartbeats.length - baseline.heartbeatCount}`
        )
      }
      await new Promise(resolve => setTimeout(resolve, 2_000))
    }
    throw new Error('The production plugin reconcile timer did not recover the missed change')
  }

  async function configOnlyCloudTarget() {
    const original = await cloud.device(CLOUD_DEVICE_ID)
    assert.ok(original, 'The real cloud Executor has no owned Device fixture')
    await stopProcessGroup(cloud.remoteExecutor)
    await cloud.waitForDeviceStatus(CLOUD_DEVICE_ID, 'offline', cloud.remoteExecutorLogPath)
    const logicalId = 'plugin-periodic-cloud-logical'
    const changed = await cloud.executeDatabase(
      'UPDATE kinds SET name = %s, `json` = JSON_SET(JSON_REMOVE(`json`, %s), %s, %s, %s, JSON_OBJECT(%s, %s, %s, %s)) WHERE user_id = %s AND namespace = %s AND kind = %s AND id = %s AND name = %s',
      [
        logicalId,
        '$.spec.deviceId',
        '$.metadata.name',
        logicalId,
        '$.spec.cloudConfig',
        'deviceId',
        CLOUD_DEVICE_ID,
        'sandboxId',
        logicalId,
        1,
        'default',
        'Device',
        original.id,
        CLOUD_DEVICE_ID,
      ]
    )
    assert.equal(changed.affected, 1, 'Cloud identity fixture must update exactly its owned row')
    cloud.remoteExecutorEnv.WEGENT_BACKEND_URL = cloudProxy.url
    cloud.remoteExecutorEnv.WEGENT_SOCKET_URL = cloudProxy.url
    cloud.remoteExecutor = await cloud.spawnExecutor(
      cloud.remoteExecutorEnv,
      cloud.remoteExecutorLogPath
    )
    const registered = await until(
      () => cloud.devices(),
      devices => devices.some(device => device.id === original.id && device.status === 'online'),
      'The cloudConfig-only Device did not register through the real cloud matching path',
      workbenchReadyTimeoutMs
    ).then(devices => devices.find(device => device.id === original.id))
    assert.equal(registered.device_id, logicalId)
    assert.equal(registered.runtime_instance_id, original.runtime_instance_id)
    const rows = await cloud.queryDatabase(
      'SELECT name, JSON_CONTAINS_PATH(`json`, %s, %s) AS has_device_id, JSON_UNQUOTE(JSON_EXTRACT(`json`, %s)) AS socket_id FROM kinds WHERE user_id = %s AND namespace = %s AND kind = %s AND id = %s',
      ['one', '$.spec.deviceId', '$.spec.cloudConfig.deviceId', 1, 'default', 'Device', original.id]
    )
    assert.equal(rows.length, 1)
    assert.equal(rows[0].has_device_id, 0)
    assert.equal(rows[0].socket_id, CLOUD_DEVICE_ID)
    evidence.push({ case: 'real-cloud-registration-uses-only-cloudConfig-identity', rows })
    return {
      kind: 'cloudConfig-only',
      device: registered,
      deviceRouteId: CLOUD_DEVICE_ID,
      persistedDeviceId: logicalId,
      home: dirname(cloud.remoteCodexHome),
      proxy: cloudProxy,
      observation: cloudObservation,
    }
  }

  async function verifyRecovery(control) {
    const cloudTarget = await configOnlyCloudTarget()
    const local = await cloud.waitForConnectedAppDevice()
    const deviceRouteId = local.socket_device_id || local.execution_target_id
    assert.match(deviceRouteId, /^app-record-\d+$/, 'The App has no exact Runtime record route')
    const targets = [
      {
        kind: 'app',
        device: local,
        deviceRouteId,
        persistedDeviceId: deviceRouteId,
        home: executorHome,
        proxy,
        observation,
      },
      cloudTarget,
    ]
    // Do not open the plugin workspace: its user-facing catalog refresh and
    // initial auto-sync must not become a competing recovery trigger.
    const item = await settledSetup(targets, () =>
      install('periodic-reconcile-changed-plugin', deviceRouteId)
    )
    const retained = await settledSetup(targets, () =>
      install('periodic-reconcile-retained-plugin', deviceRouteId)
    )
    for (const fixture of [item, retained]) {
      await settledSetup(
        targets,
        async () => {
          // An explicit state write gives both Runtimes a fresh identifiable
          // delta, including the foreground App's normal same-release path.
          await update(fixture, deviceRouteId, { updatePolicy: 'manual', enabled: true })
          return fixture
        },
        fixture
      )
    }
    for (const target of targets) {
      await until(
        async () => ({
          changed: await materializedPlugin(target.home, item.installedId),
          retained: await materializedPlugin(target.home, retained.installedId),
        }),
        value => value.changed?.enabled === true && value.retained?.enabled === true,
        `${target.kind} did not materialize both real plugin fixtures`,
        workbenchReadyTimeoutMs
      )
      assert.ok(target.proxy.websockets.size > 0, `${target.kind} bypassed its real fault proxy`)
      const registered = target.observation.registrations.at(-1)
      assert.ok(registered, `${target.kind} registration was not observed`)
      assert.equal(registered.runtimeInstanceId, target.device.runtime_instance_id)
      target.before = JSON.parse(
        await readFile(join(target.home, 'capabilities/manifest-v2.json'), 'utf8')
      )
      target.retainedBefore = await materializedPlugin(target.home, retained.installedId)
      target.retainedSkillPath = join(
        target.retainedBefore.runtime.codex_link,
        'skills',
        retained.slug,
        'SKILL.md'
      )
      target.retainedSkill = await readFile(target.retainedSkillPath)
      target.baseline = {
        registeredAt: registered.at,
        registrationCount: target.observation.registrations.length,
        heartbeatCount: target.observation.heartbeats.length,
        reconciliationCount: target.observation.reconciliations.length,
        retained: target.retainedBefore,
        capturedAt: Date.now(),
      }
      assert.ok(
        Date.now() - registered.at < MIN_RECONCILE_DELAY_MS - 30_000,
        `${target.kind} fixture setup consumed the first production timer period`
      )
    }
    missedInstalledId = item.installedId
    const componentStates = { [`skill:${item.slug}`]: false }
    // A third real Runtime completes the account mutation. Both observed
    // Runtimes lose their own delta; neither reconnects nor manually refreshes.
    await update(item, REMOTE_DOCKER_DEVICE_ID, { enabled: false, componentStates })
    for (const target of targets) {
      const held = await until(
        () => {
          if (target.observation.gate.error) throw target.observation.gate.error
          return target.observation.gate.held
        },
        Boolean,
        `The account change did not dispatch a real delta to ${target.kind}`
      )
      assert.equal(held.scope, 'plugin_delta')
      assert.equal(held.pluginSync.complete, false)
      target.missed = target.observation.capabilities.find(
        value => value.pluginSync?.generation === held.pluginSync.generation
      )
      assert.deepEqual(target.missed.pluginIds, [String(item.installedId)])
      assert.deepEqual(target.missed.removedIds, [])
      assert.deepEqual(target.missed.skills, [])
      assert.deepEqual(target.missed.mcps, [])
      target.observation.gate.discard()
      assert.equal((await materializedPlugin(target.home, item.installedId)).enabled, true)
      evidence.push({
        case: 'real-runtime-state-change-notification-lost',
        target: target.kind,
        discarded: true,
        missed: target.missed,
      })
    }
    assert.equal((await accountPlugin(cloud, item.slug)).spec.enabled, false)
    await Promise.all(
      targets.map(target => verifyTargetRecovery(target, item, retained, componentStates))
    )
    await captureScreenshot(control, 'plugin-periodic-reconcile.png', 'body')
  }

  async function verifyTargetRecovery(target, item, retained, componentStates) {
    const { observation, deviceRouteId, persistedDeviceId, baseline, retainedBefore } = target
    const recovered = await waitForAutomaticRecovery({ target, item, baseline, retained })
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
    assert.equal(complete.deviceId, deviceRouteId)
    assert.ok(complete.pluginSync.generation > target.missed.pluginSync.generation)
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
          [1, item.installedId, persistedDeviceId]
        ),
      rows =>
        rows.length === 1 &&
        rows[0].state === 'installed' &&
        rows[0].desired_release_id === item.releaseId &&
        rows[0].actual_release_id === item.releaseId &&
        !rows[0].error_code,
      `Automatic reconciliation did not persist its canonical ${target.kind} acknowledgement`
    )
    const after = JSON.parse(
      await readFile(join(target.home, 'capabilities/manifest-v2.json'), 'utf8')
    )
    assert.deepEqual(
      pluginRuntime(await materializedPlugin(target.home, retained.installedId)),
      pluginRuntime(retainedBefore)
    )
    assert.deepEqual(await readFile(target.retainedSkillPath), target.retainedSkill)
    assert.deepEqual(after.skills, target.before.skills)
    assert.deepEqual(after.mcps, target.before.mcps)
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
    const currentDevice = (await cloud.devices()).find(device => device.id === target.device.id)
    assert.equal(currentDevice?.status, 'online')
    assert.equal(currentDevice?.runtime_instance_id, target.device.runtime_instance_id)
    assert.equal(currentDevice?.device_id, target.device.device_id)
    evidence.push({
      case: 'production-timer-recovers-missed-plugin-state-without-reconnect-or-refresh',
      target: target.kind,
      deviceRouteId,
      persistedDeviceId,
      runtimeInstanceId: target.device.runtime_instance_id,
      elapsedMs: recovered.elapsedMs,
      request: recovered.request,
      acknowledged,
      persisted,
      heartbeats: heartbeats.length,
      longestHeartbeatGapMs,
      unchangedPluginId: retained.installedId,
    })
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
      cloudProxy = await new TransportFaultProxy(backendUrl).start()
      cloudObservation = observePluginSyncTransport(cloudProxy, {
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
        await cloudProxy?.stop()
      } finally {
        await objectStorage.stop()
      }
    },
  }
}
