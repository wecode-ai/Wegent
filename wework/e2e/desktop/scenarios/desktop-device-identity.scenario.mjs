import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Exercise the real hardware collector, host, executor and renderer across restarts. */
export function createDesktopScenario({ resultDir }) {
  let restartDesktopApp
  let applicationId
  const dataDirectory = join(resultDir, 'electron-user-data')
  const identityPath = join(dataDirectory, 'desktop-device-id')
  const evidence = []

  async function observe(control, directory, label) {
    const persisted = (await readFile(join(directory, 'desktop-device-id'), 'utf8')).trim()
    const status = JSON.parse(await control.command('getLocalExecutorStatus', 'body'))
    assert.match(persisted, /^electron-[0-9a-f]{64}$/)
    assert.equal(
      status.deviceId,
      persisted,
      'Renderer and real executor must use the host identity'
    )
    evidence.push({ label, deviceId: persisted })
    await writeFile(
      join(resultDir, 'desktop-device-identity.json'),
      JSON.stringify(evidence, null, 2)
    )
    return persisted
  }

  return {
    prepareApp({ appEnvironment }) {
      applicationId = appEnvironment.WEWORK_APP_IDENTIFIER
    },
    setRestartDesktopApp(restart) {
      restartDesktopApp = restart
    },
    async verify(control) {
      const original = await observe(control, dataDirectory, 'initial')
      await restartDesktopApp({ afterStop: () => rm(identityPath) })
      assert.equal(await observe(control, dataDirectory, 'deleted-identity-file'), original)

      const otherDirectory = join(resultDir, 'other-user-data')
      await restartDesktopApp({
        afterStop: async () => {
          await mkdir(otherDirectory, { recursive: true })
          await writeFile(join(otherDirectory, 'desktop-device-id'), 'electron-stale-random-id\n')
        },
        appEnvironmentOverrides: { WEWORK_USER_DATA_DIR: otherDirectory },
      })
      assert.equal(await observe(control, otherDirectory, 'fresh-profile'), original)

      const brandedDirectory = join(resultDir, 'branded-user-data')
      await restartDesktopApp({
        appEnvironmentOverrides: {
          WEWORK_USER_DATA_DIR: brandedDirectory,
          WEWORK_APP_IDENTIFIER: `${applicationId}.other`,
        },
        expectNewDeviceIdentity: true,
      })
      assert.notEqual(await observe(control, brandedDirectory, 'different-application'), original)
    },
  }
}
