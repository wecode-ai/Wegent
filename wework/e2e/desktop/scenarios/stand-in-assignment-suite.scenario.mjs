import { createDesktopScenario as createNotifications } from './stand-in-assignment-notifications.scenario.mjs'
import { createDesktopScenario as createRecovery } from './stand-in-assignment-recovery.scenario.mjs'
import { createDesktopScenario as createAutomation } from './stand-in-automation-assignment.scenario.mjs'
import { createDesktopScenario as createConversations } from './stand-in-issue-conversations.scenario.mjs'

export function createDesktopScenario(options) {
  const notifications = createNotifications(options)
  const recovery = createRecovery(options)
  const automation = createAutomation(options)
  const conversations = createConversations(options)
  let active = conversations
  return {
    requiresCloudEnvironment: true,
    async prepareCloud(cloud) {
      await notifications.prepareCloud(cloud)
      await recovery.prepareCloud(cloud)
      await automation.prepareCloud(cloud)
      await conversations.prepareCloud(cloud)
    },
    setCloudEnvironment(environment) {
      notifications.setCloudEnvironment(environment)
      recovery.setCloudEnvironment(environment)
      automation.setCloudEnvironment(environment)
      conversations.setCloudEnvironment(environment)
    },
    handleHttp(...args) {
      return active.handleHttp(...args)
    },
    async verify(control) {
      await conversations.verify(control)
      active = notifications
      await notifications.verify(control)
      const popover = '[data-testid="wework-notifications-popover"]'
      if (Number(await control.command('getElementCount', popover)) > 0) {
        await control.command('click', '[data-testid="wework-notifications-button"]')
        await control.command('waitFor', popover, { visible: false })
      }
      active = recovery
      await recovery.verify(control)
      if (Number(await control.command('getElementCount', popover)) > 0) {
        await control.command('click', '[data-testid="wework-notifications-button"]')
        await control.command('waitFor', popover, { visible: false })
      }
      active = automation
      await automation.verify(control)
    },
    diagnostics() {
      return {
        notifications: notifications.diagnostics(),
        recovery: recovery.diagnostics(),
        automation: automation.diagnostics(),
        conversations: conversations.diagnostics(),
      }
    },
    cleanup() {
      return conversations.cleanup()
    },
  }
}
