import assert from 'node:assert/strict'
import { join } from 'node:path'
import { verifyPersonalPluginVersionSubmission } from '../modules/plugin-personal-version-flow.mjs'

export function createDesktopScenario({
  executorHome,
  electronUserDataDirectory,
  restartDesktopApp,
}) {
  let cloudEnvironment
  return {
    requiresCloudEnvironment: true,
    setCloudEnvironment(value) {
      cloudEnvironment = value
    },
    async verify(control) {
      assert.ok(cloudEnvironment, 'Personal publication requires the real Cloud fixture')
      assert.equal(typeof restartDesktopApp, 'function', 'The desktop restart hook is required')
      await cloudEnvironment.waitForConnectedAppDevice()
      await verifyPersonalPluginVersionSubmission({
        cloudEnvironment,
        control,
        restartDesktopApp,
        executorHome,
        codexHome: join(executorHome, 'codex'),
        userDataDirectory: electronUserDataDirectory,
      })
    },
  }
}
