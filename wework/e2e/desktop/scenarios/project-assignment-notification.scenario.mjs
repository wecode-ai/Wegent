import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  commandOutputAsync,
  createSingleRootLocalProject,
  pathExists,
  selectE2EModel,
} from '../modules/shared.mjs'
import { waitForSnapshot } from '../modules/conversation-layout.mjs'
import {
  assistantMessage,
  createSse,
  customToolCall,
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
const EXECUTION_PROMPT = '完成当前分配的 Issue：在工作区创建验收文件并写入指定的验证内容。'
const EXECUTION_COMPLETION = 'WEWORK_ASSIGNMENT_RUNTIME_COMPLETED'
const EXECUTION_CALL_ID = 'wework-assignment-apply-patch'
const EXECUTION_ARTIFACT_NAME = 'wework-assignment-runtime-result.txt'
const EXECUTION_ARTIFACT_CONTENT = 'WEWORK_ASSIGNMENT_RUNTIME_ARTIFACT'
const DELIVERY_CREATE_SEARCH_ID = 'wework-assignment-search-create-delivery'
const DELIVERY_CREATE_CALL_ID = 'wework-assignment-create-delivery'
const DELIVERY_UPLOAD_SEARCH_ID = 'wework-assignment-search-upload-delivery'
const DELIVERY_UPLOAD_CALL_ID = 'wework-assignment-upload-delivery'
const DELIVERY_FINALIZE_SEARCH_ID = 'wework-assignment-search-finalize-delivery'
const DELIVERY_FINALIZE_CALL_ID = 'wework-assignment-finalize-delivery'
const MULTI_TURN_RESPONSE_TIMEOUT_MS = 30_000

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

async function waitForApiValue(load, predicate, message, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let latest = null
  while (Date.now() < deadline) {
    latest = await load()
    if (predicate(latest)) return latest
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  assert.fail(`${message}: ${JSON.stringify(latest)}`)
}

function findToolOutput(value, callId) {
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const output = findToolOutput(candidate, callId)
      if (output !== undefined) return output
    }
    return undefined
  }
  if (!value || typeof value !== 'object') return undefined
  if (
    ['function_call_output', 'custom_tool_call_output'].includes(value.type) &&
    value.call_id === callId
  ) {
    return value.output
  }
  for (const candidate of Object.values(value)) {
    const output = findToolOutput(candidate, callId)
    if (output !== undefined) return output
  }
  return undefined
}

function findDeliveryDraft(value) {
  if (typeof value === 'string') {
    try {
      return findDeliveryDraft(JSON.parse(value))
    } catch {
      return null
    }
  }
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const deliveryDraft = findDeliveryDraft(candidate)
      if (deliveryDraft) return deliveryDraft
    }
    return null
  }
  if (!value || typeof value !== 'object') return null
  if (value.id && value.status === 'draft') return value
  for (const candidate of Object.values(value)) {
    const deliveryDraft = findDeliveryDraft(candidate)
    if (deliveryDraft) return deliveryDraft
  }
  return null
}

export function createDesktopScenario({ uiTimeoutMs, captureScreenshot, workspacePath }) {
  let backendUrl = ''
  let databasePath = ''
  let ownerToken = ''
  let owner = null
  let assigner = null
  let assignerToken = ''
  let workspace = null
  let project = null
  let assignedTask = null
  let selfAssignedTask = null
  let delivery = null
  let executionBinding = null
  let cloudEnvironment = null
  let executionEnvironment = null
  let executionSourceWorkspacePath = ''
  let modelRequestCount = 0
  let clickRequested = false
  let executionCompletionReleased = false
  let executionWorkspacePath = null
  let releaseExecutionCompletionResolve = null
  let resolveExecutionWorkspacePath = null
  const executionCompletionGate = new Promise(resolve => {
    releaseExecutionCompletionResolve = resolve
  })
  const executionWorkspacePathReady = new Promise(resolve => {
    resolveExecutionWorkspacePath = resolve
  })
  const modelRequests = []

  const ownerRequest = (pathname, options) => requestJson(backendUrl, ownerToken, pathname, options)
  const assignerRequest = (pathname, options) =>
    requestJson(backendUrl, assignerToken, pathname, options)
  const releaseExecutionCompletion = () => {
    if (executionCompletionReleased) return
    executionCompletionReleased = true
    releaseExecutionCompletionResolve()
  }
  const setExecutionWorkspacePath = path => {
    if (executionWorkspacePath) return
    executionWorkspacePath = path
    resolveExecutionWorkspacePath(path)
  }
  const readCleanupIntent = () => {
    const database = new DatabaseSync(databasePath, { readOnly: true })
    try {
      database.exec('PRAGMA busy_timeout = 30000')
      return database
        .prepare(
          `SELECT id, status, version, due_at, completed_at, metadata
           FROM loop_items
           WHERE resource_type = 'workspace_cleanup' AND loop_item_id = ?
           ORDER BY created_at DESC
           LIMIT 1`
        )
        .get(assignedTask.id)
    } finally {
      database.close()
    }
  }

  return {
    backendEnv: {
      WORKTREE_CLEANUP_RETENTION_DAYS: '0',
    },
    requiresCloudEnvironment: true,

    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const serializedPayload = JSON.stringify(payload)
      modelRequests.push({
        model: payload.model,
        toolNames: (payload.tools ?? []).map(tool => tool.name ?? tool.type),
        metadata: payload.metadata,
      })
      const responseId = `wework-notification-${++modelRequestCount}`
      // Codex can send its first prewarm before tools or request metadata exist.
      if (
        serializedPayload.includes('"request_kind":"prewarm"') ||
        (modelRequestCount === 1 && !payload.tools?.length)
      ) {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
        response.end(createSse([responseCreated(responseId), responseCompleted(responseId)]))
        return true
      }
      if (
        serializedPayload.includes(EXECUTION_PROMPT) ||
        requestContainsToolOutput(payload, EXECUTION_CALL_ID)
      ) {
        let events
        if (requestContainsToolOutput(payload, DELIVERY_FINALIZE_CALL_ID)) {
          const deliveries = await ownerRequest(`/api/v1/loop-items/${assignedTask.id}/deliveries`)
          delivery = deliveries.items.find(candidate => candidate.status === 'delivered')
          assert.ok(delivery, 'The real local Codex runtime did not finalize its Delivery')
          assert.equal(delivery.assets.length, 1)
          assert.equal(delivery.assets[0].relative_path, EXECUTION_ARTIFACT_NAME)
          await executionCompletionGate
          events = [assistantMessage(EXECUTION_COMPLETION)]
        } else if (requestContainsToolOutput(payload, DELIVERY_FINALIZE_SEARCH_ID)) {
          const tool = selectMcpTool(payload, 'wework_space', 'finalize_delivery', {
            delivery_id: delivery.id,
            fulfillments: [],
          })
          events = namespacedFunctionCall(
            DELIVERY_FINALIZE_CALL_ID,
            tool.namespace,
            tool.name,
            tool.arguments
          )
        } else if (requestContainsToolOutput(payload, DELIVERY_UPLOAD_CALL_ID)) {
          const directToolName = (payload.tools ?? [])
            .map(tool => tool.name ?? tool.function?.name)
            .find(name => name?.endsWith('__finalize_delivery'))
          events = mcpToolRequestEvents(payload, {
            toolName: 'finalize_delivery',
            argumentsValue: {
              delivery_id: delivery.id,
              fulfillments: [],
            },
            directToolName,
            searchCallId: DELIVERY_FINALIZE_SEARCH_ID,
            toolCallId: DELIVERY_FINALIZE_CALL_ID,
          }).events
        } else if (requestContainsToolOutput(payload, DELIVERY_UPLOAD_SEARCH_ID)) {
          const artifactWorkspacePath = await executionWorkspacePathReady
          const tool = selectMcpTool(payload, 'wework_space', 'upload_delivery_asset', {
            delivery_id: delivery.id,
            file_path: join(artifactWorkspacePath, EXECUTION_ARTIFACT_NAME),
            relative_path: EXECUTION_ARTIFACT_NAME,
            display_name: EXECUTION_ARTIFACT_NAME,
            content_type: 'text/plain',
          })
          events = namespacedFunctionCall(
            DELIVERY_UPLOAD_CALL_ID,
            tool.namespace,
            tool.name,
            tool.arguments
          )
        } else if (requestContainsToolOutput(payload, DELIVERY_CREATE_CALL_ID)) {
          const createDeliveryOutput = findToolOutput(payload.input ?? [], DELIVERY_CREATE_CALL_ID)
          delivery = findDeliveryDraft(createDeliveryOutput)
          assert.ok(
            delivery,
            `The real local Codex runtime did not return its persisted Delivery draft: ${JSON.stringify(createDeliveryOutput)}`
          )
          const directToolName = (payload.tools ?? [])
            .map(tool => tool.name ?? tool.function?.name)
            .find(name => name?.endsWith('__upload_delivery_asset'))
          const artifactWorkspacePath = await executionWorkspacePathReady
          events = mcpToolRequestEvents(payload, {
            toolName: 'upload_delivery_asset',
            argumentsValue: {
              delivery_id: delivery.id,
              file_path: join(artifactWorkspacePath, EXECUTION_ARTIFACT_NAME),
              relative_path: EXECUTION_ARTIFACT_NAME,
              display_name: EXECUTION_ARTIFACT_NAME,
              content_type: 'text/plain',
            },
            directToolName,
            searchCallId: DELIVERY_UPLOAD_SEARCH_ID,
            toolCallId: DELIVERY_UPLOAD_CALL_ID,
          }).events
        } else if (requestContainsToolOutput(payload, DELIVERY_CREATE_SEARCH_ID)) {
          const tool = selectMcpTool(payload, 'wework_space', 'create_delivery', {
            markdown: `# ${ASSIGNED_TASK_TITLE}\n\n${EXECUTION_COMPLETION}`,
          })
          events = namespacedFunctionCall(
            DELIVERY_CREATE_CALL_ID,
            tool.namespace,
            tool.name,
            tool.arguments
          )
        } else if (requestContainsToolOutput(payload, EXECUTION_CALL_ID)) {
          const directToolName = (payload.tools ?? [])
            .map(tool => tool.name ?? tool.function?.name)
            .find(name => name?.endsWith('__create_delivery'))
          events = mcpToolRequestEvents(payload, {
            toolName: 'create_delivery',
            argumentsValue: {
              markdown: `# ${ASSIGNED_TASK_TITLE}\n\n${EXECUTION_COMPLETION}`,
            },
            directToolName,
            searchCallId: DELIVERY_CREATE_SEARCH_ID,
            toolCallId: DELIVERY_CREATE_CALL_ID,
          }).events
        } else {
          const applyPatch = (payload.tools ?? []).find(tool => tool?.name === 'apply_patch')
          assert.ok(applyPatch, 'The real local Codex runtime did not advertise apply_patch')
          const patch = [
            '*** Begin Patch',
            `*** Add File: ${EXECUTION_ARTIFACT_NAME}`,
            `+${EXECUTION_ARTIFACT_CONTENT}`,
            '*** End Patch',
          ].join('\n')
          events = [customToolCall(EXECUTION_CALL_ID, 'apply_patch', patch)]
        }
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
        response.end(
          createSse([responseCreated(responseId), ...events, responseCompleted(responseId)])
        )
        return true
      }
      const withClick = clickRequested
      assert.ok(serializedPayload.includes(withClick ? CLICK_PROMPT : NOTIFICATION_PROMPT))
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
        const tool = selectMcpTool(payload, 'wework_notifications', 'send_notification', args)
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

    setCloudEnvironment(environment) {
      cloudEnvironment = environment
    },

    async prepareCloud(cloud) {
      backendUrl = cloud.backendUrl
      databasePath = cloud.databasePath
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
      workspace = await ownerRequest('/api/v1/workspaces', {
        method: 'POST',
        body: JSON.stringify({
          name: `${PROJECT_NAME}-${process.pid}`,
          description: 'Desktop E2E Workspace for assigned human execution',
        }),
      })
      await ownerRequest(`/api/v1/workspaces/${workspace.id}/members`, {
        method: 'POST',
        body: JSON.stringify({
          user_id: assigner.id,
          role: 'Maintainer',
        }),
      })
      project = await ownerRequest(`/api/v1/workspaces/${workspace.id}/projects`, {
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
      assert.ok(workspace?.id, 'Notification Workspace fixture is missing')
      assert.ok(project?.id, 'Notification project fixture is missing')
      assert.ok(assignedTask?.id, 'Assigned task fixture is missing')
      assert.ok(selfAssignedTask?.id, 'Self-assigned task fixture is missing')
      const workspaceProjects = await ownerRequest(`/api/v1/workspaces/${workspace.id}/projects`)
      assert.ok(
        workspaceProjects.items.some(candidate => candidate.id === project.id),
        'The assigned human Project is not owned by its Workspace'
      )

      await control.command('waitFor', '[data-testid="workspace-tab-add"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('clearSystemNotifications', 'body')

      await createSingleRootLocalProject(control, workspacePath, 'general-notification')
      const configuredDevice = await cloudEnvironment.waitForConnectedAppDevice()
      project = await ownerRequest(`/api/v1/cloud-projects/${project.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          version: project.version,
          execution_environment: {
            repositories: [
              {
                name: 'assignment-fixture',
                url: workspacePath,
                ref: '',
                path: 'assignment-fixture',
                primary: true,
              },
            ],
            setup_steps: [],
          },
        }),
      })
      executionEnvironment = await ownerRequest(
        `/api/v1/cloud-projects/${project.id}/execution-environments`,
        {
          method: 'POST',
          body: JSON.stringify({ device_id: configuredDevice.id }),
        }
      )
      project = await ownerRequest(
        `/api/v1/cloud-projects/${project.id}/execution-environment/initialize`,
        {
          method: 'POST',
          body: JSON.stringify({
            device_id: configuredDevice.id,
            version: project.version,
          }),
        }
      )
      const preparedEnvironment =
        project.execution_environment?.devices?.[executionEnvironment.device_key]
      assert.equal(
        preparedEnvironment?.status,
        'ready',
        'The assigned Project execution environment was not prepared'
      )
      assert.ok(
        preparedEnvironment?.workspace_path,
        'The assigned Project execution environment has no workspace path'
      )
      executionSourceWorkspacePath = preparedEnvironment.workspace_path
      await selectE2EModel(control)
      const activeSurface = '[data-workspace-tab-content][aria-hidden="false"]'
      const composer = `${activeSurface} [data-testid="chat-message-input"]`
      await control.command('waitFor', composer, { timeoutMs: uiTimeoutMs })
      await control.command('fill', composer, { value: NOTIFICATION_PROMPT })
      await control.command('press', composer, { key: 'Enter' })
      await control.command('waitFor', `${activeSurface} [data-testid="message-assistant"]`, {
        text: NOTIFICATION_COMPLETION,
        timeoutMs: Math.max(uiTimeoutMs, MULTI_TURN_RESPONSE_TIMEOUT_MS),
      })
      await waitForSnapshot(
        control,
        snapshot => !snapshot.testIds.includes('pause-response-button'),
        'The general notification response rendered before its Runtime Task became idle',
        uiTimeoutMs,
        activeSurface
      )
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
      await control.command('click', '[data-testid="wework-notifications-category-general"]')
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
        timeoutMs: Math.max(uiTimeoutMs, MULTI_TURN_RESPONSE_TIMEOUT_MS),
      })
      await waitForSnapshot(
        control,
        snapshot => !snapshot.testIds.includes('pause-response-button'),
        'The clickable notification response rendered before its Runtime Task became idle',
        uiTimeoutMs,
        activeSurface
      )
      const clickInbox = await ownerRequest('/api/v1/wework-notifications')
      const clickable = clickInbox.items.find(item => item.title === '点击打开看板')
      assert.ok(clickable, 'The real MCP must persist the requested click target')
      assert.equal(clickable.url, 'wework://boards')
      // The conversation remains active until the user clicks the notification.
      await control.command('waitFor', composer)
      await control.command('click', '[data-testid="wework-notifications-button"]')
      await control.command('click', '[data-testid="wework-notifications-refresh"]')
      await control.command('click', '[data-testid="wework-notifications-category-general"]')
      await control.command('waitFor', `[data-testid="wework-notification-${clickable.id}"]`)
      await control.command('click', `[data-testid="wework-notification-${clickable.id}"]`)
      await control.command(
        'waitFor',
        `${activeSurface} [data-testid="wework-collaboration-platform"]`,
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command(
        'waitFor',
        `${activeSurface} [data-testid="collaboration-platform-root"]`,
        {
          timeoutMs: uiTimeoutMs,
        }
      )
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
      await control.command('click', '[data-testid="wework-notifications-category-collaboration"]')
      await control.command('waitFor', `[data-testid="wework-notification-${saved.id}"]`, {
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(control, 'assignment-01-notification.png')
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
      await captureScreenshot(control, 'assignment-02-issue-opened.png', activeSurface)
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

      const startWorkButton = `${activeSurface} [data-testid="human-issue-start"]`
      await control.command('waitFor', startWorkButton, { timeoutMs: uiTimeoutMs })
      const actionGroup = `${activeSurface} [data-testid="human-issue-actions"]`
      assert.ok(
        (await control.command('getAttribute', actionGroup, { value: 'class' })).includes(
          'bg-muted/60'
        ),
        'Human Issue actions must render as one compact visual group'
      )
      assert.match(
        await control.command('getAttribute', startWorkButton, { value: 'class' }),
        /(?:^|\s)bg-primary(?:\s|$)/,
        'The human Issue primary action must be visually prominent'
      )
      await control.command('click', startWorkButton)
      const startedIssue = await waitForApiValue(
        () => ownerRequest(`/api/v1/loop-items/${assignedTask.id}`),
        value => value?.status === 'in_progress',
        'The human assignee did not start the Issue',
        uiTimeoutMs
      )
      assert.equal(startedIssue.human_work.can_submit, true)
      const createTaskButton = `${activeSurface} [data-testid="human-issue-ai-assist"]`
      const taskPanel = `${activeSurface} [data-testid="work-item-new-task-chat-panel"]`
      const boundTaskPanel = `${activeSurface} [data-testid="work-item-task-chat-panel"]`
      const taskComposer = `${taskPanel} [data-testid="chat-message-input"]`
      await control.command('click', createTaskButton)
      await control.command('waitFor', `${activeSurface} [data-testid="ai-chat-modal"]`, {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', taskPanel, { timeoutMs: uiTimeoutMs })
      await control.command('waitFor', taskComposer, { timeoutMs: uiTimeoutMs })
      const codeProjectButton = `${taskPanel} [data-testid="project-work-button"]`
      assert.equal(
        Number(await control.command('getElementCount', codeProjectButton)),
        0,
        'A manually handled Issue with a prepared environment must not expose project selection'
      )
      const taskBridge = JSON.parse(await control.command('snapshot', activeSurface))
      assert.ok(
        taskBridge.text.includes(project.name) &&
          taskBridge.text.includes(assignedTask.id) &&
          taskBridge.text.includes(ASSIGNED_TASK_TITLE),
        'The real Wework Task bridge lost the assigned Project or Issue context'
      )
      await selectE2EModel(control, undefined, undefined, taskPanel)
      await captureScreenshot(control, 'assignment-03-task-created.png', activeSurface)

      try {
        await control.command('fill', taskComposer, { value: EXECUTION_PROMPT })
        await control.command('press', taskComposer, { key: 'Enter' })
        const taskBindings = await waitForApiValue(
          () => ownerRequest(`/api/v1/loop-items/${assignedTask.id}/tasks`),
          value => Array.isArray(value) && value.length > 0,
          'Starting work did not bind a real Runtime Task to the assigned Issue',
          uiTimeoutMs
        )
        const binding = taskBindings[0]
        executionBinding = binding
        assert.equal(
          Number(
            await control.command(
              'getElementCount',
              `${activeSurface} [data-testid="chat-input-error"]`
            )
          ),
          0,
          'The prepared execution environment was incorrectly reported as unavailable'
        )
        assert.equal(
          binding.loopItemId ?? binding.loop_item_id,
          assignedTask.id,
          'The Runtime Task binding points at a different Issue'
        )
        assert.ok(
          binding.deviceId ?? binding.device_id,
          'The Runtime Task binding has no local Executor device'
        )
        assert.equal(
          binding.deviceId ?? binding.device_id,
          executionEnvironment.device_key,
          'The Runtime Task did not use the Project execution environment device'
        )
        assert.ok(
          binding.taskId ?? binding.task_id,
          'The Runtime Task binding has no Runtime Task identity'
        )
        const runtimeTaskId = binding.taskId ?? binding.task_id
        const runtimeIndexPath = join(
          dirname(workspacePath),
          'executor-home',
          'runtime-work',
          'index.json'
        )
        const worktreeStatePath = join(
          dirname(workspacePath),
          'executor-home',
          'runtime-work',
          'worktrees.json'
        )
        const runtimeTask = await waitForApiValue(
          async () => {
            try {
              const runtimeIndex = JSON.parse(await readFile(runtimeIndexPath, 'utf8'))
              const task = runtimeIndex.tasks?.[runtimeTaskId]
              if (!task?.workspace_path) return null
              const worktreeState = JSON.parse(await readFile(worktreeStatePath, 'utf8'))
              const worktree = worktreeState.records?.[task.workspace_path]
              return task
                ? {
                    taskId: runtimeTaskId,
                    workspacePath: task.workspace_path,
                    worktree,
                  }
                : null
            } catch {
              return null
            }
          },
          value =>
            value?.taskId === runtimeTaskId &&
            Boolean(value.workspacePath) &&
            value.worktree?.state === 'active',
          'The assigned Runtime Task did not expose its managed Worktree',
          uiTimeoutMs
        )
        assert.equal(
          runtimeTask.worktree.worktreeId,
          runtimeTaskId,
          'The managed Worktree identity does not match the assigned Runtime Task'
        )
        assert.equal(
          runtimeTask.worktree.state,
          'active',
          'The assigned collaboration Runtime Task Worktree is not active'
        )
        assert.notEqual(
          runtimeTask.workspacePath,
          executionSourceWorkspacePath,
          'The assigned collaboration Runtime Task reused its prepared environment workspace'
        )
        const gitWorktrees = await commandOutputAsync('git', ['worktree', 'list', '--porcelain'], {
          cwd: executionSourceWorkspacePath,
        })
        assert.ok(
          gitWorktrees.includes(`worktree ${runtimeTask.workspacePath}`),
          'Git does not report the assigned Runtime workspace as a Worktree'
        )
        setExecutionWorkspacePath(runtimeTask.workspacePath)
        await control.command('waitFor', boundTaskPanel, { timeoutMs: uiTimeoutMs })
        const runningIssue = await waitForApiValue(
          () => ownerRequest(`/api/v1/loop-items/${assignedTask.id}`),
          value => value?.status === 'in_progress',
          'The assigned Issue did not enter in_progress while its Runtime Task was running',
          uiTimeoutMs
        )
        assert.equal(runningIssue.status, 'in_progress')
        await waitForSnapshot(
          control,
          snapshot => snapshot.testIds.includes('pause-response-button'),
          'The real local Executor did not expose the running Runtime Task state',
          uiTimeoutMs,
          activeSurface
        )
        await captureScreenshot(control, 'assignment-04-task-running.png', activeSurface)
        const runtimeArtifact = await waitForApiValue(
          () =>
            readFile(join(runtimeTask.workspacePath, EXECUTION_ARTIFACT_NAME), 'utf8').catch(
              () => null
            ),
          value => value?.trim() === EXECUTION_ARTIFACT_CONTENT,
          'The real local Executor did not write the expected isolated workspace artifact',
          uiTimeoutMs
        )
        assert.equal(
          runtimeArtifact.trim(),
          EXECUTION_ARTIFACT_CONTENT,
          'The real local Executor did not write the expected isolated workspace artifact'
        )
      } finally {
        releaseExecutionCompletion()
      }

      await control.command('waitFor', `${boundTaskPanel} [data-testid="message-assistant"]`, {
        text: EXECUTION_COMPLETION,
        timeoutMs: Math.max(uiTimeoutMs, MULTI_TURN_RESPONSE_TIMEOUT_MS),
      })
      await waitForSnapshot(
        control,
        snapshot => !snapshot.testIds.includes('pause-response-button'),
        'The real local Executor returned a final response but the Runtime Task stayed active',
        uiTimeoutMs,
        activeSurface
      )
      assert.equal(
        (await readFile(join(executionWorkspacePath, EXECUTION_ARTIFACT_NAME), 'utf8')).trim(),
        EXECUTION_ARTIFACT_CONTENT,
        'The real local Executor did not write the expected isolated workspace artifact'
      )
      const deliveredIssue = await waitForApiValue(
        () => ownerRequest(`/api/v1/loop-items/${assignedTask.id}`),
        value => value?.current_delivery_id && value?.status === 'in_progress',
        'Finalizing AI assistance must preserve human ownership and review',
        uiTimeoutMs
      )
      assert.equal(deliveredIssue.status, 'in_progress')
      const deliveredFiles = await ownerRequest(
        `/api/v1/cloud-projects/${project.id}/delivery-files`
      )
      const deliveredArtifact = deliveredFiles.items.find(
        candidate =>
          candidate.loop_item_id === assignedTask.id &&
          candidate.relative_path === EXECUTION_ARTIFACT_NAME
      )
      assert.ok(
        deliveredArtifact,
        'The completed Wework Task did not synchronize its artifact to the Project Delivery view'
      )
      const deliveredContent = await fetch(
        `${backendUrl}/api/v1/delivery-assets/${deliveredArtifact.asset_id}/content`,
        { headers: { Authorization: `Bearer ${ownerToken}` } }
      )
      assert.equal(deliveredContent.ok, true)
      assert.equal((await deliveredContent.text()).trim(), EXECUTION_ARTIFACT_CONTENT)
      await captureScreenshot(control, 'assignment-05-task-completed.png', activeSurface)
      await control.command('click', `${activeSurface} [data-testid="ai-chat-modal-close"]`)
      await control.command('waitFor', `${activeSurface} [data-testid="ai-chat-modal"]`, {
        visible: false,
        timeoutMs: uiTimeoutMs,
      })
      const workingCard = `${activeSurface} [data-testid="cloud-todo-column-in_progress"] [data-testid="cloud-todo-card-${assignedTask.id}"]`
      await control.command('waitFor', workingCard, { timeoutMs: uiTimeoutMs })
      await control.command('click', workingCard)
      await control.command('waitFor', `${activeSurface} [data-testid="cloud-todo-detail"]`, {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', `${activeSurface} [data-testid="human-issue-submit"]`)
      await control.command('fill', `${activeSurface} [data-testid="human-issue-work-text"]`, {
        value: 'Runtime artifact created and checked; ready for review.',
      })
      await control.command('click', `${activeSurface} [data-testid="human-issue-work-confirm"]`)
      const submittedIssue = await waitForApiValue(
        () => ownerRequest(`/api/v1/loop-items/${assignedTask.id}`),
        value => value?.status === 'in_review',
        'The human assignee could not submit the Issue for review',
        uiTimeoutMs
      )
      const reviewerIssue = await assignerRequest(`/api/v1/loop-items/${assignedTask.id}`)
      assert.equal(reviewerIssue.human_work.can_review, true)
      const acceptedWork = await assignerRequest(
        `/api/v1/loop-items/${assignedTask.id}/work/review`,
        {
          method: 'POST',
          body: JSON.stringify({
            version: submittedIssue.version,
            request_id: `desktop-human-review-${Date.now()}`,
            decision: 'accept',
          }),
        }
      )
      assert.equal(acceptedWork.issue.status, 'completed')
      await waitForApiValue(
        async () => ({
          intent: readCleanupIntent(),
          worktreeExists: await pathExists(executionWorkspacePath),
        }),
        value =>
          value.intent?.status === 'acknowledged' &&
          Number(value.intent.version) === acceptedWork.issue.version &&
          value.worktreeExists === false,
        'The local Executor did not delete and acknowledge the accepted Issue Worktree',
        uiTimeoutMs
      )
      const acceptedInbox = await waitForApiValue(
        () => ownerRequest('/api/v1/wework-notifications'),
        value =>
          value?.items?.some(
            notification =>
              notification.kind === 'human_work' &&
              notification.title === 'Issue 验收通过' &&
              notification.payload.itemId === assignedTask.id
          ),
        'The assignee did not receive the human review result',
        uiTimeoutMs
      )
      const acceptedNotification = acceptedInbox.items.find(
        notification =>
          notification.kind === 'human_work' && notification.payload.itemId === assignedTask.id
      )
      assert.equal(
        acceptedNotification.url,
        `wework://boards/${project.id}/issues/${encodeURIComponent(assignedTask.id)}`
      )
      await control.command('click', '[data-testid="wework-notifications-button"]')
      await control.command('click', '[data-testid="wework-notifications-refresh"]')
      await control.command('click', '[data-testid="wework-notifications-category-collaboration"]')
      await control.command(
        'waitFor',
        `[data-testid="wework-notification-${acceptedNotification.id}"]`,
        { text: 'Issue 验收通过', timeoutMs: uiTimeoutMs }
      )
      await control.command(
        'click',
        `[data-testid="wework-notification-${acceptedNotification.id}"]`
      )
      const synchronizedCard = `${activeSurface} [data-testid="cloud-todo-column-completed"] [data-testid="cloud-todo-card-${assignedTask.id}"]`
      await control.command('waitFor', synchronizedCard, { timeoutMs: uiTimeoutMs })
      await control.command(
        'waitFor',
        `${activeSurface} [data-testid="cloud-todo-detail-status"]`,
        { timeoutMs: uiTimeoutMs }
      )
      const synchronizedDetailStatus = await waitForApiValue(
        async () => {
          try {
            return await control.command(
              'getValue',
              `${activeSurface} [data-testid="cloud-todo-detail-status"]`
            )
          } catch (error) {
            if (String(error).includes('Unable to find selector')) return null
            throw error
          }
        },
        value => value === 'completed',
        'The completed Runtime Task status was not reflected in the open Issue detail',
        uiTimeoutMs
      )
      assert.equal(
        synchronizedDetailStatus,
        'completed',
        'The completed Runtime Task status was not reflected in the open Issue detail'
      )
      await control.command('click', `${activeSurface} [data-testid="cloud-todo-toggle-tasks"]`)
      const executionTaskRow = `${activeSurface} [data-testid^="cloud-todo-open-task-conversation-"]`
      const workbenchSnapshot = JSON.parse(
        await control.command('getWorkbenchDebugSnapshot', 'body')
      )
      const devices = workbenchSnapshot.workbench?.devices ?? []
      const executionDeviceId = executionBinding.deviceId ?? executionBinding.device_id
      const executionDevice = devices.find(device =>
        [
          device.device_id,
          device.execution_target_id,
          device.app_device_id,
          device.socket_device_id,
          device.runtime_instance_id,
          ...(device.runtime_routes ?? []).flatMap(route => [
            route.device_id,
            route.runtime_device_id,
          ]),
        ].includes(executionDeviceId)
      )
      assert.ok(executionDevice?.name, 'The Runtime Task device has no display name')
      await control.command('waitFor', executionTaskRow, {
        text: executionDevice.name,
        timeoutMs: uiTimeoutMs,
      })
      assert.doesNotMatch(
        await control.command('getText', executionTaskRow),
        new RegExp(executionDeviceId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        'The Issue execution list exposed the device ID instead of its display name'
      )
      await control.command('waitFor', `${activeSurface} [data-testid="todo-detail-deliveries"]`, {
        text: '1 个附件',
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(control, 'assignment-06-issue-synchronized.png', activeSurface)

      await control.command('clearSystemNotifications', 'body')
      const latestAssignedTask = await ownerRequest(`/api/v1/loop-items/${assignedTask.id}`)
      assignedTask = await assignerRequest(
        `/api/v1/cloud-projects/${project.id}/loop-items/${assignedTask.id}/assign`,
        {
          method: 'POST',
          body: JSON.stringify({
            version: latestAssignedTask.version,
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
        finalInbox.items.filter(
          item => item.payload.itemId === assignedTask.id && item.kind === 'assignment'
        ).length,
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
      await control.command('click', '[data-testid="wework-notifications-category-general"]')
      await control.command('waitFor', `[data-testid="wework-notification-${custom.id}"]`, {
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(control, 'wework-notifications-inbox.png')
      await control.command('click', '[data-testid="wework-notifications-back"]')
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
        workspaceId: workspace?.id ?? null,
        projectId: project?.id ?? null,
        deliveryId: delivery?.id ?? null,
        selfAssignedTaskId: selfAssignedTask?.id ?? null,
      }
    },
  }
}
