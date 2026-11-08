import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { until } from '../modules/plugin-regression-fixture.mjs'
import { verifyWeworkAppDeviceRegistrationFlow } from '../modules/desktop-build-flows.mjs'

/** Exercise the real hardware collector, host, executor and renderer across restarts. */
export function createDesktopScenario({ resultDir, workbenchReadyTimeoutMs }) {
  let restartDesktopApp
  let applicationId
  let cloud
  const dataDirectory = join(resultDir, 'electron-user-data')
  const identityPath = join(dataDirectory, 'desktop-device-id')
  const evidence = []

  async function observe(control, directory, label, expected = {}) {
    const persisted = (await readFile(join(directory, 'desktop-device-id'), 'utf8')).trim()
    const status = JSON.parse(await control.command('getLocalExecutorStatus', 'body'))
    if (expected.deviceId) assert.equal(persisted, expected.deviceId)
    else assert.match(persisted, /^electron-[0-9a-f]{64}$/)
    assert.equal(
      status.deviceId,
      persisted,
      'Renderer and real executor must use the host identity'
    )
    assert.equal(status.runtimeInstanceId, expected.runtimeInstanceId ?? `runtime-${persisted}`)
    const registered = await until(
      () => cloud.devices(),
      devices =>
        devices.find(device => device.app_device_id === persisted && device.status === 'online'),
      'The real cloud backend did not register this hardware/application identity',
      workbenchReadyTimeoutMs
    )
    const device = registered.find(
      device => device.app_device_id === persisted && device.status === 'online'
    )
    assert.equal(
      registered.filter(
        device => device.device_type === 'app' && device.app_device_id === persisted
      ).length,
      1,
      'Restarting or changing profile must not create a duplicate cloud device'
    )
    assert.equal(device.device_id, expected.registrationDeviceId ?? `device-${persisted}`)
    assert.notEqual(device.device_id, persisted)
    assert.equal(device.runtime_instance_id, status.runtimeInstanceId)
    const identity = {
      deviceId: persisted,
      registrationDeviceId: device.device_id,
      runtimeInstanceId: status.runtimeInstanceId,
      cloudRecordId: device.id,
      cloudRouteId: device.execution_target_id,
    }
    evidence.push({ label, ...identity })
    await writeFile(
      join(resultDir, 'desktop-device-identity.json'),
      JSON.stringify(evidence, null, 2)
    )
    return identity
  }

  return {
    requiresCloudEnvironment: true,
    setCloudEnvironment(value) {
      cloud = value
    },
    prepareApp({ appEnvironment }) {
      applicationId = appEnvironment.WEWORK_APP_IDENTIFIER
      assert.ok(applicationId, 'The runner must supply the application identifier')
    },
    setRestartDesktopApp(restart) {
      restartDesktopApp = restart
    },
    async verify(control) {
      await verifyWeworkAppDeviceRegistrationFlow(control, cloud)
      const original = await observe(control, dataDirectory, 'initial')
      await restartDesktopApp({ afterStop: () => rm(identityPath) })
      assert.deepEqual(await observe(control, dataDirectory, 'deleted-identity-file'), original)

      const otherDirectory = join(resultDir, 'other-user-data')
      await restartDesktopApp({
        afterStop: async () => {
          await mkdir(otherDirectory, { recursive: true })
        },
        appEnvironmentOverrides: {
          WEWORK_USER_DATA_DIR: otherDirectory,
          WEGENT_EXECUTOR_HOME: join(resultDir, 'other-executor-home'),
          WEGENT_CODEX_HOME: join(resultDir, 'other-executor-home', 'codex'),
        },
      })
      assert.deepEqual(await observe(control, otherDirectory, 'fresh-profile'), original)

      const brandedDirectory = join(resultDir, 'branded-user-data')
      await restartDesktopApp({
        appEnvironmentOverrides: {
          WEWORK_USER_DATA_DIR: brandedDirectory,
          WEWORK_APP_IDENTIFIER: `${applicationId}.other`,
          WEGENT_EXECUTOR_HOME: join(resultDir, 'branded-executor-home'),
          WEGENT_CODEX_HOME: join(resultDir, 'branded-executor-home', 'codex'),
        },
        expectNewDeviceIdentity: true,
      })
      const branded = await observe(control, brandedDirectory, 'different-application')
      assert.notEqual(branded.deviceId, original.deviceId)
      assert.notEqual(branded.runtimeInstanceId, original.runtimeInstanceId)
      assert.notEqual(branded.cloudRecordId, original.cloudRecordId)

      const legacyDirectory = join(resultDir, 'legacy-user-data')
      const legacyExecutorHome = join(resultDir, 'legacy-executor-home')
      const legacy = {
        deviceId: 'electron-12345678-1234-4567-89ab-123456789abc',
        registrationDeviceId: 'legacy-registration-device',
        runtimeInstanceId: 'runtime-legacy-instance',
      }
      await restartDesktopApp({
        afterStop: async () => {
          await mkdir(legacyDirectory, { recursive: true })
          await mkdir(legacyExecutorHome, { recursive: true })
          await writeFile(join(legacyDirectory, 'desktop-device-id'), `${legacy.deviceId}\n`)
          await writeFile(
            join(legacyExecutorHome, 'device-config.json'),
            JSON.stringify({
              device_id: legacy.registrationDeviceId,
              runtime_instance_id: legacy.runtimeInstanceId,
            })
          )
        },
        appEnvironmentOverrides: {
          WEWORK_USER_DATA_DIR: legacyDirectory,
          WEWORK_APP_IDENTIFIER: applicationId,
          WEGENT_EXECUTOR_HOME: legacyExecutorHome,
          WEGENT_CODEX_HOME: join(legacyExecutorHome, 'codex'),
        },
        expectNewDeviceIdentity: true,
      })
      const restored = await observe(control, legacyDirectory, 'persisted-legacy-identity', legacy)
      await restartDesktopApp()
      assert.deepEqual(
        await observe(control, legacyDirectory, 'persisted-legacy-restart', legacy),
        restored
      )
    },
  }
}
