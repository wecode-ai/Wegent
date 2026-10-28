import { createDesktopScenario as createNotifications } from './stand-in-assignment-notifications.scenario.mjs'
import { createDesktopScenario as createRecovery } from './stand-in-assignment-recovery.scenario.mjs'

export function createDesktopScenario(options) {
  const notifications = createNotifications(options)
  const recovery = createRecovery(options)
  let active = notifications
  return {
    requiresCloudEnvironment: true,
    async prepareCloud(cloud) {
      await notifications.prepareCloud(cloud)
      await recovery.prepareCloud(cloud)
    },
    setCloudEnvironment(environment) {
      notifications.setCloudEnvironment(environment)
      recovery.setCloudEnvironment(environment)
    },
    handleHttp(...args) {
      return active.handleHttp(...args)
    },
    async verify(control) {
      await notifications.verify(control)
      const popover = '[data-testid="wework-notifications-popover"]'
      if (Number(await control.command('getElementCount', popover)) > 0) {
        await control.command('click', '[data-testid="wework-notifications-button"]')
        await control.command('waitFor', popover, { visible: false })
      }
      active = recovery
      await recovery.verify(control)
    },
    diagnostics() {
      return { notifications: notifications.diagnostics(), recovery: recovery.diagnostics() }
    },
  }
}
