import { createDesktopScenario as createBridgeScenario } from './stand-in-plugin-bridge.scenario.mjs'
import { createDesktopScenario as createAutomationScenario } from './connection-automations.scenario.mjs'

// Share the existing CI checkpoint's Electron, Core and Executor lifecycle.
export function createDesktopScenario(options) {
  const bridge = createBridgeScenario(options)
  const automations = createAutomationScenario(options)
  return {
    async prepareApp(context) {
      await bridge.prepareApp(context)
      await automations.prepareApp(context)
    },
    async handleHttp(...args) {
      return (await automations.handleHttp(...args)) || bridge.handleHttp(...args)
    },
    async verify(control) {
      await bridge.verify(control)
      await automations.verify(control)
    },
  }
}
