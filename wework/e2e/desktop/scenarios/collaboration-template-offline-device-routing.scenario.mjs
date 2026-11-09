import assert from 'node:assert/strict'

import { createDesktopScenario as createAppDeviceRoutingScenario } from './collaboration-template-app-device-routing.scenario.mjs'

export function createDesktopScenario(options) {
  const scenario = createAppDeviceRoutingScenario(options)
  let environment
  return {
    ...scenario,
    setCloudEnvironment(value) {
      environment = value
      scenario.setCloudEnvironment(value)
    },
    async verify(control) {
      // Register and disconnect a real Executor to retain a historical identity.
      const historical = await environment.createOfflineLocalSidebarAlias()
      const current = await environment.waitForConnectedAppDevice()
      const persisted = (await environment.devices()).find(device => device.id === historical.id)
      assert.equal(persisted?.status, 'offline')
      assert.equal(historical.device_id, current.app_device_id)
      assert.notEqual(historical.id, current.id)
      await scenario.verify(control)
    },
  }
}
