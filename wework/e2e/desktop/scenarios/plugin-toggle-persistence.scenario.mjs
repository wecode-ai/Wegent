import { verifyPluginTogglePersistence } from '../modules/plugin-inventory-state.mjs'
import { installFixture } from '../modules/plugin-regression-fixture.mjs'

export function createDesktopScenario({ captureScreenshot, workbenchReadyTimeoutMs }) {
  let cloud
  let restartDesktopApp
  return {
    requiresCloudEnvironment: true,
    setCloudEnvironment(value) {
      cloud = value
    },
    setRestartDesktopApp(value) {
      restartDesktopApp = value
    },
    async verify(control) {
      const local = await cloud.waitForConnectedAppDevice()
      const fixture = await installFixture(
        cloud,
        control,
        'toggle-persistence-e2e',
        local.device_id,
        workbenchReadyTimeoutMs
      )
      await verifyPluginTogglePersistence({
        control,
        cloud,
        fixture,
        restartDesktopApp,
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await captureScreenshot(control, 'plugin-enabled-after-restart.png', 'body')
    },
  }
}
