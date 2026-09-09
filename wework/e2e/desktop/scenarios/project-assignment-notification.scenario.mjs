import assert from 'node:assert/strict'
import { createSingleRootLocalProject, selectE2EModel } from '../modules/shared.mjs'
import { waitForSnapshot } from '../modules/conversation-layout.mjs'
import {
  assistantMessage,
  createSse,
  mcpToolRequestEvents,
  namespacedFunctionCall,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
  selectMcpTool,
} from '../modules/response-protocol.mjs'

const PROJECT_NAME = '任务分配通知验收'
const ASSIGNER_NAME = 'desktop-e2e-assigner'
const ASSIGNER_PASSWORD = 'desktop-e2e-assigner-password'
const ASSIGNED_TASK_TITLE = '准备项目周报'
const SELF_ASSIGNED_TASK_TITLE = '负责人自分配任务'
const NOTIFICATION_PROMPT = '给我发个通知，说你好'
const NOTIFICATION_COMPLETION = 'WEWORK_GENERAL_NOTIFICATION_SENT'
const NOTIFICATION_CALL_ID = 'send-general-notification'
const NOTIFICATION_SEARCH_ID = 'search-general-notification'
const CLICK_PROMPT = '给我发个你好的通知，然后点击打开看板页面'
const CLICK_COMPLETION = 'WEWORK_CLICK_NOTIFICATION_SENT'

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

export function createDesktopScenario({ uiTimeoutMs, captureScreenshot, workspacePath }) {
  let backendUrl = ''
  let ownerToken = ''
  let owner = null
  let assigner = null
  let assignerToken = ''
  let project = null
  let assignedTask = null
  let selfAssignedTask = null
  let modelRequestCount = 0
  let clickRequested = false
  const modelRequests = []

  const ownerRequest = (pathname, options) => requestJson(backendUrl, ownerToken, pathname, options)
  const assignerRequest = (pathname, options) =>
    requestJson(backendUrl, assignerToken, pathname, options)

  return {
    requiresCloudEnvironment: true,

    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      modelRequests.push({
        model: payload.model,
        toolNames: (payload.tools ?? []).map(tool => tool.name ?? tool.type),
        metadata: payload.metadata,
      })
      const responseId = `wework-notification-${++modelRequestCount}`
      // Codex can send its first prewarm before tools or request metadata exist.
      if (
        JSON.stringify(payload).includes('"request_kind":"prewarm"') ||
        (modelRequestCount === 1 && !payload.tools?.length)
      ) {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
        response.end(createSse([responseCreated(responseId), responseCompleted(responseId)]))
        return true
      }
      const withClick = clickRequested
      assert.ok(JSON.stringify(payload).includes(withClick ? CLICK_PROMPT : NOTIFICATION_PROMPT))
      const callId = withClick ? 'send-click-notification' : NOTIFICATION_CALL_ID
      const searchId = withClick ? 'search-click-notification' : NOTIFICATION_SEARCH_ID
      const args = withClick
        ? { title: '点击打开看板', body: '你好', url: 'wework://boards' }
        : { title: 'Wework 通知', body: '你好' }
      let events
      if (requestContainsToolOutput(payload, callId)) {
        const inbox = await ownerRequest('/api/v1/wework-notifications')
        assert.ok(inbox.items.some(item => item.title === args.title && item.body === args.body))
        events = [assistantMessage(withClick ? CLICK_COMPLETION : NOTIFICATION_COMPLETION)]
      } else if (requestContainsToolOutput(payload, searchId)) {
        const tool = selectMcpTool(payload, 'wework_space', 'send_notification', args)
        events = namespacedFunctionCall(callId, tool.namespace, tool.name, tool.arguments)
      } else {
        const directToolName = (payload.tools ?? [])
          .map(tool => tool.name ?? tool.function?.name)
          .find(name => name?.endsWith('__send_notification'))
        events = mcpToolRequestEvents(payload, {
          toolName: 'send_notification',
          argumentsValue: args,
          directToolName,
          searchCallId: searchId,
          toolCallId: callId,
        }).events
      }
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(
        createSse([responseCreated(responseId), ...events, responseCompleted(responseId)])
      )
      return true
    },

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

      await createSingleRootLocalProject(control, workspacePath, 'general-notification')
      await selectE2EModel(control)
      const activeSurface = '[data-workspace-tab-content][aria-hidden="false"]'
      const composer = `${activeSurface} [data-testid="chat-message-input"]`
      await control.command('waitFor', composer, { timeoutMs: uiTimeoutMs })
      await control.command('fill', composer, { value: NOTIFICATION_PROMPT })
      await control.command('press', composer, { key: 'Enter' })
      await control.command('waitFor', `${activeSurface} [data-testid="message-assistant"]`, {
        text: NOTIFICATION_COMPLETION,
        timeoutMs: uiTimeoutMs,
      })
      const sentInbox = await ownerRequest('/api/v1/wework-notifications')
      const general = sentInbox.items.find(
        item => item.title === 'Wework 通知' && item.body === '你好'
      )
      assert.ok(general, 'Ordinary chat must invoke the real MCP tool and persist the notification')
      assert.equal(general.url, null, 'General notifications must not invent a board target')
      const otherInbox = await assignerRequest('/api/v1/wework-notifications')
      assert.equal(
        otherInbox.items.some(item => item.id === general.id),
        false
      )
      await control.command('click', '[data-testid="wework-notifications-button"]')
      await control.command('click', '[data-testid="wework-notifications-refresh"]')
      await control.command('waitFor', `[data-testid="wework-notification-${general.id}"]`, {
        text: '你好',
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', `[data-testid="wework-notification-${general.id}"]`)
      await waitForSnapshot(
        control,
        snapshot =>
          snapshot.testIds.includes(`wework-notification-${general.id}`) &&
          !snapshot.testIds.includes('wework-notifications-unread'),
        'General notification did not stay visible with its saved read state',
        uiTimeoutMs
      )
      const generalInbox = await ownerRequest('/api/v1/wework-notifications')
      assert.ok(generalInbox.items.find(item => item.id === general.id)?.read_at)
      await captureScreenshot(control, 'wework-general-notification.png')
      await control.command('click', '[data-testid="wework-notifications-button"]')
      clickRequested = true
      await control.command('fill', composer, { value: CLICK_PROMPT })
      await control.command('press', composer, { key: 'Enter' })
      await control.command('waitFor', `${activeSurface} [data-testid="message-assistant"]`, {
        text: CLICK_COMPLETION,
        timeoutMs: uiTimeoutMs,
      })
      const clickInbox = await ownerRequest('/api/v1/wework-notifications')
      const clickable = clickInbox.items.find(item => item.title === '点击打开看板')
      assert.ok(clickable, 'The real MCP must persist the requested click target')
      assert.equal(clickable.url, 'wework://boards')
      // The conversation remains active until the user clicks the notification.
      await control.command('waitFor', composer)
      await control.command('click', '[data-testid="wework-notifications-button"]')
      await control.command('click', '[data-testid="wework-notifications-refresh"]')
      await control.command('waitFor', `[data-testid="wework-notification-${clickable.id}"]`)
      await control.command('click', `[data-testid="wework-notification-${clickable.id}"]`)
      await control.command('waitFor', `${activeSurface} [data-testid="cloud-todo-workspace"]`)
      const afterClick = await ownerRequest('/api/v1/wework-notifications')
      assert.ok(afterClick.items.find(item => item.id === clickable.id)?.read_at)
      await captureScreenshot(control, 'wework-notification-board-home.png')
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
      console.log(
        '[notification-e2e] notifications after assignment:',
        JSON.stringify(notifications)
      )
      assert.equal(
        notifications.filter(notification => notification.title === '你有一个新的看板任务').length,
        1,
        `One assignment produced duplicate notifications: ${JSON.stringify(notifications)}`
      )

      const inbox = await ownerRequest('/api/v1/wework-notifications')
      const saved = inbox.items.find(item => item.payload.itemId === assignedTask.id)
      assert.ok(saved, 'Assignment must persist in the Backend inbox')
      assert.equal(
        saved.url,
        `wework://boards/${project.id}/issues/${encodeURIComponent(assignedTask.id)}`
      )
      assert.equal(saved.read_at, null)
      await control.command('click', '[data-testid="wework-notifications-button"]')
      await control.command('waitFor', `[data-testid="wework-notification-${saved.id}"]`, {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', `[data-testid="wework-notification-${saved.id}"]`)
      await control.command(
        'waitFor',
        '[data-workspace-tab-content][aria-hidden="false"] [data-testid="cloud-todo-detail-title"]',
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      assert.equal(
        await control.command(
          'getValue',
          '[data-workspace-tab-content][aria-hidden="false"] [data-testid="cloud-todo-detail-title"]'
        ),
        ASSIGNED_TASK_TITLE
      )
      const readInbox = await ownerRequest('/api/v1/wework-notifications')
      assert.ok(
        readInbox.items.find(item => item.id === saved.id)?.read_at,
        'Opening a notification must persist its read state'
      )
      const forbiddenRead = await fetch(
        `${backendUrl}/api/v1/wework-notifications/${saved.id}/read`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${assignerToken}` },
        }
      )
      assert.equal(forbiddenRead.status, 404, 'Another user must not read the recipient inbox')

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

      const silent = await assignerRequest(`/api/v1/cloud-projects/${project.id}/loop-items`, {
        method: 'POST',
        body: JSON.stringify({ title: 'Silent assignment' }),
      })
      await assignerRequest(`/api/v1/cloud-projects/${project.id}/loop-items/${silent.id}/assign`, {
        method: 'POST',
        body: JSON.stringify({
          version: silent.version,
          assigneeType: 'user',
          assigneeId: String(owner.id),
          notifyAssignee: false,
        }),
      })
      const finalInbox = await ownerRequest('/api/v1/wework-notifications')
      assert.equal(
        finalInbox.items.filter(item => item.payload.itemId === assignedTask.id).length,
        1
      )
      assert.equal(
        finalInbox.items.some(item => item.payload.itemId === silent.id),
        false
      )
      await control.command('openWeworkScheme', 'body', {
        value: `wework://boards/${project.id}/issues/${selfAssignedTask.id}`,
      })
      await control.command(
        'waitFor',
        '[data-workspace-tab-content][aria-hidden="false"] [data-testid="cloud-todo-detail-title"]',
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command(
        'waitFor',
        '[data-workspace-tab-content][aria-hidden="false"] [data-testid="cloud-todo-detail-title"]',
        {
          text: SELF_ASSIGNED_TASK_TITLE,
          timeoutMs: uiTimeoutMs,
        }
      )
      assert.equal(
        await control.command(
          'getValue',
          '[data-workspace-tab-content][aria-hidden="false"] [data-testid="cloud-todo-detail-title"]'
        ),
        SELF_ASSIGNED_TASK_TITLE
      )
      const custom = await ownerRequest('/api/v1/wework-notifications', {
        method: 'POST',
        body: JSON.stringify({
          project_id: project.id,
          item_id: assignedTask.id,
          title: 'Review failed',
          body: 'Please review the blocked Issue',
        }),
      })
      await control.command('click', '[data-testid="wework-notifications-button"]')
      await control.command('click', '[data-testid="wework-notifications-refresh"]')
      await control.command('waitFor', `[data-testid="wework-notification-${custom.id}"]`, {
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(control, 'wework-notifications-inbox.png')
      await control.command('click', '[data-testid="wework-notifications-read-all"]')
      await control.command('waitFor', '[data-testid="wework-notifications-popover"]', {
        timeoutMs: uiTimeoutMs,
      })
    },

    diagnostics() {
      return {
        modelRequestCount,
        modelRequests,
        assignerId: assigner?.id ?? null,
        assignedTaskId: assignedTask?.id ?? null,
        ownerId: owner?.id ?? null,
        projectId: project?.id ?? null,
        selfAssignedTaskId: selfAssignedTask?.id ?? null,
      }
    },
  }
}
