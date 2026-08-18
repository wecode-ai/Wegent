import assert from 'node:assert/strict'

const PROJECT_NAME = '任务分配通知验收'
const ASSIGNER_NAME = 'desktop-e2e-assigner'
const ASSIGNER_PASSWORD = 'desktop-e2e-assigner-password'
const ASSIGNED_TASK_TITLE = '准备项目周报'
const SELF_ASSIGNED_TASK_TITLE = '负责人自分配任务'

async function requestJson(baseUrl, token, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  })
  const text = await response.text()
  const body = text ? JSON.parse(text) : null
  assert.equal(
    response.ok,
    true,
    `${options.method ?? 'GET'} ${pathname} failed with HTTP ${response.status}: ${text}`
  )
  return body
}

async function systemNotifications(control) {
  return JSON.parse(await control.command('getSystemNotifications', 'body'))
}

async function waitForNotification(control, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let notifications = []
  while (Date.now() < deadline) {
    notifications = await systemNotifications(control)
    if (notifications.some(predicate)) return notifications
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  assert.fail(`Expected system notification was not received: ${JSON.stringify(notifications)}`)
}

async function assertNoNotification(control, message, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const notifications = await systemNotifications(control)
    assert.equal(notifications.length, 0, message)
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
}

export function createDesktopScenario({ uiTimeoutMs }) {
  let backendUrl = ''
  let ownerToken = ''
  let owner = null
  let assigner = null
  let assignerToken = ''
  let project = null
  let assignedTask = null
  let selfAssignedTask = null

  const ownerRequest = (pathname, options) => requestJson(backendUrl, ownerToken, pathname, options)
  const assignerRequest = (pathname, options) =>
    requestJson(backendUrl, assignerToken, pathname, options)

  return {
    requiresCloudEnvironment: true,

    async prepareCloud(cloud) {
      backendUrl = cloud.backendUrl
      ownerToken = cloud.authToken
      owner = await ownerRequest('/api/users/me')
      assigner = await ownerRequest('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          user_name: ASSIGNER_NAME,
          password: ASSIGNER_PASSWORD,
          role: 'user',
          auth_source: 'password',
        }),
      })
      const login = await requestJson(backendUrl, null, '/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          user_name: ASSIGNER_NAME,
          password: ASSIGNER_PASSWORD,
        }),
      })
      assignerToken = login.access_token
      project = await ownerRequest('/api/v1/cloud-projects', {
        method: 'POST',
        body: JSON.stringify({
          projectKey: 'NOTIFY',
          name: PROJECT_NAME,
          description: 'Desktop E2E project assignment notification',
          taskProvider: 'local',
          providerConfig: {},
          visibility: 'private',
        }),
      })
      await ownerRequest(`/api/v1/cloud-projects/${project.id}/members`, {
        method: 'POST',
        body: JSON.stringify({
          user_id: assigner.id,
          role: 'Maintainer',
          capability_description: 'Assign project tasks during desktop E2E',
        }),
      })
      assignedTask = await assignerRequest(`/api/v1/cloud-projects/${project.id}/loop-items`, {
        method: 'POST',
        body: JSON.stringify({ title: ASSIGNED_TASK_TITLE }),
      })
      selfAssignedTask = await ownerRequest(`/api/v1/cloud-projects/${project.id}/loop-items`, {
        method: 'POST',
        body: JSON.stringify({ title: SELF_ASSIGNED_TASK_TITLE }),
      })
    },

    async verify(control) {
      assert.ok(owner?.id, 'Notification recipient fixture is missing')
      assert.ok(assigner?.id, 'Notification assigner fixture is missing')
      assert.ok(project?.id, 'Notification project fixture is missing')
      assert.ok(assignedTask?.id, 'Assigned task fixture is missing')
      assert.ok(selfAssignedTask?.id, 'Self-assigned task fixture is missing')

      await control.command('waitFor', '[data-testid="workspace-tab-add"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('clearSystemNotifications', 'body')

      assignedTask = await assignerRequest(
        `/api/v1/cloud-projects/${project.id}/loop-items/${assignedTask.id}/assign`,
        {
          method: 'POST',
          body: JSON.stringify({
            version: assignedTask.version,
            assignee_type: 'user',
            assignee_id: String(owner.id),
          }),
        }
      )
      const notifications = await waitForNotification(
        control,
        notification =>
          notification.title === '你有一个新的看板任务' &&
          notification.body.includes(ASSIGNER_NAME) &&
          notification.body.includes(ASSIGNED_TASK_TITLE) &&
          notification.body.includes(PROJECT_NAME),
        uiTimeoutMs
      )
      assert.equal(notifications.length, 1, 'One assignment produced duplicate notifications')

      await control.command('clearSystemNotifications', 'body')
      assignedTask = await assignerRequest(
        `/api/v1/cloud-projects/${project.id}/loop-items/${assignedTask.id}/assign`,
        {
          method: 'POST',
          body: JSON.stringify({
            version: assignedTask.version,
            assignee_type: 'user',
            assignee_id: String(owner.id),
          }),
        }
      )
      await assertNoNotification(
        control,
        'Repeated assignment to the same person produced a notification',
        uiTimeoutMs
      )

      await control.command('clearSystemNotifications', 'body')
      await ownerRequest(
        `/api/v1/cloud-projects/${project.id}/loop-items/${selfAssignedTask.id}/assign`,
        {
          method: 'POST',
          body: JSON.stringify({
            version: selfAssignedTask.version,
            assignee_type: 'user',
            assignee_id: String(owner.id),
          }),
        }
      )
      await assertNoNotification(control, 'Self-assignment produced a notification', uiTimeoutMs)
    },

    diagnostics() {
      return {
        assignerId: assigner?.id ?? null,
        assignedTaskId: assignedTask?.id ?? null,
        ownerId: owner?.id ?? null,
        projectId: project?.id ?? null,
        selfAssignedTaskId: selfAssignedTask?.id ?? null,
      }
    },
  }
}
