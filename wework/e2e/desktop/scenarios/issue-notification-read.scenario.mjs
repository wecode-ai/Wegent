import assert from 'node:assert/strict'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'

const ACTIVE = '[data-workspace-tab-content][aria-hidden="false"]'
const BADGE = '[data-testid="wework-notifications-unread"]'

export function createDesktopScenario({ uiTimeoutMs }) {
  let request
  let project
  let issues
  let notices

  async function waitForInbox(predicate) {
    const deadline = Date.now() + uiTimeoutMs
    let inbox
    while (Date.now() < deadline) {
      inbox = await request('/api/v1/wework-notifications')
      if (predicate(inbox)) return inbox
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.fail(`Issue notification read state did not settle: ${JSON.stringify(inbox)}`)
  }

  return {
    requiresCloudEnvironment: true,
    async prepareCloud({ backendUrl, authToken }) {
      request = async (path, body) => {
        const response = await fetch(`${backendUrl}${path}`, {
          method: body ? 'POST' : 'GET',
          headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}),
        })
        const value = await response.json()
        assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(value)}`)
        return value
      }
      const workspace = await request('/api/v1/workspaces', { name: `Issue read ${process.pid}` })
      project = await request(`/api/v1/workspaces/${workspace.id}/projects`, {
        projectKey: 'READ',
        name: 'Issue notification read',
        taskProvider: 'local',
        providerConfig: {},
        visibility: 'private',
      })
      issues = []
      notices = []
      for (const title of [
        'System notification destination',
        'Direct Issue destination',
        'Unrelated Issue',
      ]) {
        const issue = await request(`/api/v1/cloud-projects/${project.id}/loop-items`, { title })
        // Notifications must be consumed even when the Issue itself is already read.
        assert.equal(issue.is_unread, false)
        issues.push(issue)
        notices.push(
          await request('/api/v1/wework-notifications', {
            project_id: Number(project.id),
            item_id: issue.id,
            title,
            body: 'Read this Issue',
            url: `wework://boards/${project.id}/issues/${issue.id}`,
          })
        )
      }
    },

    async verify(control) {
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]')
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await control.command('click', '[data-testid="wework-notifications-button"]')
      await control.command('click', '[data-testid="wework-notifications-refresh"]')
      await control.command('waitFor', BADGE, { text: '3' })
      await control.command('click', '[data-testid="wework-notifications-button"]')

      for (const [index, action] of ['activateSystemNotification', 'openWeworkScheme'].entries()) {
        await control.command(action, 'body', {
          value: `wework://boards/${project.id}/issues/${issues[index].id}`,
        })
        await control.command('waitFor', `${ACTIVE} [data-testid="cloud-task-status-event-0"]`)
        const inbox = await waitForInbox(
          value => value.items.find(item => item.id === notices[index].id)?.read_at != null
        )
        assert.equal(inbox.unread_count, 2 - index)
        assert.equal(inbox.items.find(item => item.id === notices[2].id).read_at, null)
        // No manual notification refresh: the read response must update the badge immediately.
        await control.command('waitFor', BADGE, { text: String(2 - index) })
        await control.command('click', `${ACTIVE} [data-testid="cloud-todo-detail-close"]`)
      }
      await control.command('click', `${ACTIVE} [data-testid="cloud-todo-card-${issues[2].id}"]`)
      await control.command('waitFor', `${ACTIVE} [data-testid="cloud-task-status-event-0"]`)
      await waitForInbox(value => value.unread_count === 0)
      await control.command('waitFor', BADGE, { visible: false })

      const later = await request('/api/v1/wework-notifications', {
        project_id: Number(project.id),
        item_id: issues[2].id,
        title: 'A later notification for the open Issue',
        body: 'Open the same Issue again',
        url: `wework://boards/${project.id}/issues/${issues[2].id}`,
      })
      await control.command('click', '[data-testid="wework-notifications-button"]')
      await control.command('click', '[data-testid="wework-notifications-refresh"]')
      await control.command('waitFor', BADGE, { text: '1' })
      await control.command('click', '[data-testid="wework-notifications-button"]')
      await control.command('activateSystemNotification', 'body', { value: later.url })
      await waitForInbox(value => value.items.find(item => item.id === later.id)?.read_at != null)
      await control.command('waitFor', BADGE, { visible: false })
    },
  }
}
