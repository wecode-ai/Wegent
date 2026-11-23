import { createDesktopScenario as createNotifications } from './stand-in-assignment-notifications.scenario.mjs'
import { createDesktopScenario as createRecovery } from './stand-in-assignment-recovery.scenario.mjs'
import { createDesktopScenario as createAutomation } from './stand-in-automation-assignment.scenario.mjs'
import { createDesktopScenario as createConversations } from './stand-in-issue-conversations.scenario.mjs'
import { createDesktopScenario as createDelegation } from './stand-in-issue-delegation.scenario.mjs'
import { createEventFailureIsolation } from '../modules/stand-in-event-failure-isolation.mjs'

export function createDesktopScenario(options) {
  const notifications = createNotifications(options)
  const recovery = createRecovery(options)
  const automation = createAutomation(options)
  const conversations = createConversations(options)
  const delegation = createDelegation(options)
  const isolation = createEventFailureIsolation(options)
  let cloudFixture
  let active = conversations
  return {
    requiresCloudEnvironment: true,
    async prepareCloud(cloud) {
      cloudFixture = cloud
      await notifications.prepareCloud(cloud)
      await recovery.prepareCloud(cloud)
      await automation.prepareCloud(cloud)
      await conversations.prepareCloud(cloud)
      await delegation.prepareCloud(cloud)
    },
    setCloudEnvironment(environment) {
      notifications.setCloudEnvironment(environment)
      recovery.setCloudEnvironment(environment)
      automation.setCloudEnvironment(environment)
      conversations.setCloudEnvironment(environment)
      delegation.setCloudEnvironment(environment)
    },
    handleHttp(...args) {
      return active.handleHttp(...args)
    },
    async verify(control) {
      await conversations.verify(control)
      active = delegation
      await delegation.verify(control)
      // Finish the delegation view before reloading the notification inbox.
      const issueDetail =
        '[data-workspace-tab-content][aria-hidden="false"] [data-testid="collaboration-issue-detail"]'
      await control.command(
        'clickWhenEnabled',
        `${issueDetail} [data-testid="cloud-todo-detail-close"]`
      )
      await control.command('waitFor', issueDetail, { visible: false })
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
      active = isolation
      await isolation.verify(control, cloudFixture, delegation.diagnostics())
    },
    diagnostics() {
      return {
        notifications: notifications.diagnostics(),
        recovery: recovery.diagnostics(),
        automation: automation.diagnostics(),
        conversations: conversations.diagnostics(),
        delegation: delegation.diagnostics(),
      }
    },
    cleanup() {
      return conversations.cleanup()
    },
  }
}
