import assert from 'node:assert/strict'

import { verifySilentIssueSaves } from '../modules/issue-save-notification-flows.mjs'
import { verifyLinkedTasksScrolling } from '../modules/issue-linked-tasks.mjs'
import { verifyIssuePersonalTaskPrivacy } from '../modules/issue-personal-task-privacy.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  assistantMessage,
  codexRequestKind,
  createSse,
  mcpToolRequestEvents,
  namespacedFunctionCall,
  readRequestBody,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
  selectMcpTool,
} from '../modules/response-protocol.mjs'
import {
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_LABEL,
  REMOTE_DOCKER_DEVICE_ID,
  selectE2EModel,
} from '../modules/shared.mjs'
import {
  inCollaborationSidebar,
  inProjectCreateDialog,
  openDirectProjectCreation,
  configureFirstProjectExecutionEnvironment,
  selectCollaborationDomain,
} from '../modules/workspace-flows.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const MODEL = 'desktop-e2e-cloud-responses'
const MODEL_LABEL = 'gpt-6-astra'
const WORKSPACE = `直接分人空间-${process.pid}`
const PROJECT = `直接分人项目-${process.pid}`
const ISSUE = `人工验收项目周报-${process.pid}`
const MANUAL_ISSUE = `人工复核项目周报-${process.pid}`
const MARKER = `DIRECT_HUMAN_DISPATCH_${process.pid}`
const COMPLETION = `${MARKER}_DELIVERED`
const MANUAL_RESULT = `${MARKER}：已人工核对周报。`
const CALLS = {
  createSearch: `${MARKER}-create-search`,
  create: `${MARKER}-create`,
  finalizeSearch: `${MARKER}-finalize-search`,
  finalize: `${MARKER}-finalize`,
}

function scoped(selector) {
  return `${CONTENT} ${selector}`
}

function writeEvents(response, responseId, events) {
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
  response.end(createSse([responseCreated(responseId), ...events, responseCompleted(responseId)]))
}

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

function directMcpToolName(body, suffix) {
  return (body.tools ?? [])
    .map(tool => tool.name ?? tool.function?.name)
    .find(name => name?.endsWith(`__${suffix}`))
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
      const delivery = findDeliveryDraft(candidate)
      if (delivery) return delivery
    }
    return null
  }
  if (!value || typeof value !== 'object') return null
  if (value.id && value.status === 'draft') return value
  for (const candidate of Object.values(value)) {
    const delivery = findDeliveryDraft(candidate)
    if (delivery) return delivery
  }
  return null
}

async function waitForValue(load, predicate, message, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let latest = null
  while (Date.now() < deadline) {
    latest = await load()
    const result = predicate(latest)
    if (result) return result === true ? latest : result
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`${message}: ${JSON.stringify(latest)}`)
}

async function verifyCanonicalDeviceCatalog(control, request, timeoutMs) {
  const resources = await waitForValue(
    () => request('/api/v1/resources'),
    value =>
      value.execution_environments.some(
        device => device.device_key.startsWith('app-record-') && device.status === 'online'
      ),
    'The desktop Runtime did not register its canonical device resource',
    timeoutMs
  )
  await control.command(
    'click',
    inCollaborationSidebar('[data-testid="collaboration-primary-devices"]')
  )
  for (const device of resources.execution_environments) {
    await control.command(
      'waitFor',
      scoped(`[data-testid="collaboration-devices-row-${device.id}"]`),
      {
        timeoutMs,
      }
    )
  }
  assert.equal(
    Number(
      await control.command(
        'getElementCount',
        scoped('[data-testid^="collaboration-devices-row-"]')
      )
    ),
    resources.execution_environments.length,
    'The device page must show each registered resource once without a second local placeholder'
  )
  assert.equal(
    Number(
      await control.command(
        'getElementCount',
        scoped('[data-testid^="collaboration-devices-row-device:"]')
      )
    ),
    0,
    'The registered local Runtime was duplicated by a Local Executor placeholder'
  )
  await control.command(
    'click',
    inCollaborationSidebar('[data-testid="collaboration-primary-home"]')
  )
}

async function createWorkspaceAndProject(control, request, uiTimeoutMs) {
  await control.command('click', scoped('[data-testid="collaboration-workspace-create"]'))
  await control.command('fill', scoped('[data-testid="collaboration-workspace-name-input"]'), {
    value: WORKSPACE,
  })
  await control.command(
    'clickWhenEnabled',
    scoped('[data-testid="collaboration-workspace-create-confirm"]'),
    { timeoutMs: uiTimeoutMs }
  )
  const workspace = await waitForValue(
    async () => (await request('/api/v1/workspaces')).items,
    items => items.find(item => item.name === WORKSPACE),
    '端上创建 Workspace 未持久化',
    uiTimeoutMs
  )

  await control.command(
    'waitFor',
    scoped('[data-testid="collaboration-workspace-project-create"]'),
    {
      timeoutMs: uiTimeoutMs,
    }
  )
  await openDirectProjectCreation(control, CONTENT)
  await control.command(
    'fill',
    inProjectCreateDialog('[data-testid="collaboration-project-name-input"]'),
    {
      value: PROJECT,
    }
  )
  await control.command(
    'click',
    inProjectCreateDialog('[data-testid="collaboration-project-create-advanced"]')
  )
  await control.command(
    'click',
    inProjectCreateDialog('[data-testid="cloud-project-task-provider-local"]')
  )
  await control.command(
    'clickWhenEnabled',
    inProjectCreateDialog('[data-testid="collaboration-project-create-confirm"]'),
    { timeoutMs: uiTimeoutMs }
  )
  const project = await waitForValue(
    async () => (await request(`/api/v1/workspaces/${workspace.id}/projects`)).items,
    items => items.find(item => item.name === PROJECT),
    '端上创建 Project 未持久化',
    uiTimeoutMs
  )
  assert.equal(project.task_provider, 'local')
  return project
}

async function createIssue(
  control,
  projectId,
  request,
  owner,
  uiTimeoutMs,
  title = ISSUE,
  { notifyAssignee = true, beforeSave } = {}
) {
  await control.command('waitFor', scoped('[data-testid="collaboration-tab-board"]'), {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('click', scoped('[data-testid="collaboration-tab-board"]'))
  await control.command('clickWhenEnabled', scoped('[data-testid="collaboration-issue-create"]'))
  await control.command('fill', scoped('[data-testid="cloud-todo-title"]'), { value: title })
  await control.command('fill', scoped('[data-testid="cloud-todo-detail-description"]'), {
    value:
      title === ISSUE
        ? `${MARKER}。可创建关联任务整理周报，处理进展通过评论沟通。`
        : `${MARKER}。人工核对周报，通过评论沟通结果并直接变更状态。`,
  })
  await control.command('click', scoped('[data-testid="cloud-todo-create-assignee"]'))
  await control.command(
    'click',
    `[data-testid="cloud-todo-create-assignee-option-user:${owner.id}"]`
  )
  assert.equal(
    Number(
      await control.command('getElementCount', '[data-testid="wework-assignment-notify-confirm"]')
    ),
    0,
    'Selecting an assignee must not open a notification confirmation dialog'
  )
  await control.command('waitFor', scoped('[data-testid="cloud-todo-create-confirm"]'), {
    text: '保存并通知',
  })
  await control.command('click', scoped('[data-testid="cloud-todo-create-confirm-options"]'))
  const silentSave = '[data-testid="cloud-todo-create-confirm-without-notification"]'
  await control.command('waitFor', silentSave, { text: '仅保存不通知', visible: true })
  await control.command('press', silentSave, { key: 'Escape' })
  await waitForValue(
    () => control.command('getElementCount', silentSave),
    value => Number(value) === 0,
    'Escape must dismiss the save notification menu',
    uiTimeoutMs
  )
  await beforeSave?.()
  if (notifyAssignee) {
    await control.command('clickWhenEnabled', scoped('[data-testid="cloud-todo-create-confirm"]'), {
      timeoutMs: uiTimeoutMs,
    })
  } else {
    await control.command('click', scoped('[data-testid="cloud-todo-create-confirm-options"]'))
    await control.command('click', silentSave, { visible: true })
  }
  return waitForValue(
    async () => (await request(`/api/v1/cloud-projects/${projectId}/loop-items`)).items,
    items => items.find(item => item.title === title),
    '端上创建 Issue 未持久化',
    uiTimeoutMs
  )
}

async function verifyIssueTags(control, request, issue, uiTimeoutMs) {
  const tag = `验收标签-${process.pid}`
  const temporaryTag = `临时标签-${process.pid}`
  const trigger = scoped('[data-testid="cloud-todo-more-properties"]')
  const popover = '[data-testid="cloud-todo-more-properties-popover"]'
  const input = `${popover} [data-testid="cloud-todo-detail-tag-input"]`
  const chip = `${popover} [data-testid="cloud-todo-detail-tag-tag-${tag}"]`
  const assertDismissed = async () => {
    await waitForValue(
      () => control.command('getElementCount', popover),
      value => Number(value) === 0,
      'More properties did not dismiss',
      uiTimeoutMs
    )
    assert.equal(
      await control.command('getAttribute', trigger, { value: 'aria-expanded' }),
      'false'
    )
    assert.equal(
      Number(
        await control.command('getElementCount', scoped('[data-testid="cloud-todo-detail-title"]'))
      ),
      1
    )
  }
  await control.command('click', trigger)
  assert.equal(
    await control.command('getComputedStyleValue', input, { value: 'opacity' }),
    '1',
    'Issue tag text and caret must not be hidden by a transparent input overlay'
  )
  await control.command('fill', input, { value: tag })
  assert.equal(await control.command('getValue', input), tag)
  await control.command('pointerClick', scoped('[data-testid="cloud-todo-detail-title"]'))
  await assertDismissed()
  await control.command('click', trigger)
  await control.command('waitFor', chip, { visible: true, timeoutMs: uiTimeoutMs })
  await control.command('fill', input, { value: tag })
  await control.command('press', input, { key: 'Enter' })
  assert.equal(Number(await control.command('getElementCount', chip)), 1)
  await control.command('fill', input, { value: temporaryTag })
  await control.command('press', input, { key: 'Enter' })
  await control.command(
    'click',
    `${popover} [data-testid="cloud-todo-detail-tag-tag-remove-${temporaryTag}"]`
  )
  await control.command('press', input, { key: 'Escape' })
  await assertDismissed()
  await control.command('click', trigger)
  await control.command('waitFor', chip, { visible: true, timeoutMs: uiTimeoutMs })
  await control.command('pointerClick', scoped('[data-testid="cloud-todo-save"]'))
  await assertDismissed()
  const updated = await waitForValue(
    () => request(`/api/v1/loop-items/${issue.id}`),
    value => value.tags?.length === 1 && value.tags[0] === tag,
    'Issue tags were not persisted after adding, deduplicating and removing tags',
    uiTimeoutMs
  )
  await control.command('click', trigger)
  await control.command('waitFor', chip, { visible: true, timeoutMs: uiTimeoutMs })
  await control.command('pointerClick', scoped('[data-testid="cloud-todo-detail-title"]'))
  await assertDismissed()
  return updated
}

async function changeIssueStatus(control, request, issueId, status, uiTimeoutMs) {
  const statusSelect = scoped('select[data-testid="cloud-todo-detail-status"]:not(:disabled)')
  await control.command('waitFor', statusSelect, { timeoutMs: uiTimeoutMs })
  await control.command('select', statusSelect, {
    value: status,
  })
  await control.command('clickWhenEnabled', scoped('[data-testid="cloud-todo-save"]'), {
    timeoutMs: uiTimeoutMs,
  })
  return waitForValue(
    () => request(`/api/v1/loop-items/${issueId}`),
    value => value.status === status,
    `Issue 未能直接变更为 ${status}`,
    uiTimeoutMs
  )
}

async function verifyManualCommentFlow(control, request, projectId, owner, uiTimeoutMs, capture) {
  await control.command('click', '[data-testid="cloud-todo-detail-close"]')
  const manualIssue = await createIssue(
    control,
    projectId,
    request,
    owner,
    uiTimeoutMs,
    MANUAL_ISSUE
  )
  await changeIssueStatus(control, request, manualIssue.id, 'in_progress', uiTimeoutMs)
  assert.equal(
    Number(await control.command('getElementCount', '[data-testid="human-issue-work-panel"]')),
    0
  )
  const comment = scoped('[data-testid="cloud-task-activity-composer"]')
  await control.command('waitFor', comment, { visible: true, timeoutMs: uiTimeoutMs })
  await control.command('fill', comment, { value: MANUAL_RESULT })
  await control.command(
    'clickWhenEnabled',
    scoped('[data-testid="task-comment-form"] [data-testid="send-message-button"]')
  )
  await control.command('waitFor', scoped('[data-testid="cloud-task-activity-list"]'), {
    text: MANUAL_RESULT,
    visible: true,
    timeoutMs: uiTimeoutMs,
  })
  await changeIssueStatus(control, request, manualIssue.id, 'in_review', uiTimeoutMs)
  await changeIssueStatus(control, request, manualIssue.id, 'completed', uiTimeoutMs)
  assert.deepEqual(await request(`/api/v1/loop-items/${manualIssue.id}/tasks`), [])
  await capture('assignment-06-manual-comment-completed.png', CONTENT)

  const completed = await request(`/api/v1/loop-items/${manualIssue.id}`)
  const unassigned = await request(`/api/v1/loop-items/${manualIssue.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ version: completed.version, assignee_user_id: null }),
  })
  const reassigned = await request(
    `/api/v1/cloud-projects/${projectId}/loop-items/${manualIssue.id}/assign`,
    {
      method: 'POST',
      body: JSON.stringify({
        version: unassigned.version,
        assignee_type: 'user',
        assignee_id: String(owner.id),
      }),
    }
  )
  assert.equal(reassigned.status, 'completed')
  await changeIssueStatus(control, request, manualIssue.id, 'in_progress', uiTimeoutMs)
  await control.command('click', '[data-testid="cloud-todo-detail-close"]')
  const card = scoped(`[data-testid="cloud-todo-card-${manualIssue.id}"]`)
  await control.command('waitFor', card, { visible: true })
  await control.command('drag', card, {
    target: scoped('[data-testid="cloud-todo-column-dropzone-completed"]'),
  })
  await waitForValue(
    () => request(`/api/v1/loop-items/${manualIssue.id}`),
    value => value.status === 'completed',
    '看板拖拽未能直接完成 Issue',
    uiTimeoutMs
  )
  await control.command('scrollIntoView', scoped('[data-testid="cloud-todo-column-completed"]'))
  await control.command(
    'waitFor',
    scoped(
      `[data-testid="cloud-todo-column-completed"] [data-testid="cloud-todo-card-${manualIssue.id}"]`
    ),
    { visible: true }
  )
  await control.command('click', card)
  await control.command('waitFor', scoped('[data-testid="cloud-task-activity-list"]'), {
    text: MANUAL_RESULT,
    visible: true,
    timeoutMs: uiTimeoutMs,
  })
  const restarted = await changeIssueStatus(
    control,
    request,
    manualIssue.id,
    'in_progress',
    uiTimeoutMs
  )
  assert.equal(restarted.completed_at, null)
}

export function createDesktopScenario({
  captureScreenshot,
  modelResponseTimeoutMs,
  uiTimeoutMs,
  workbenchReadyTimeoutMs,
}) {
  let backendUrl = ''
  let cloudEnvironment = null
  let ownerToken = ''
  let owner = null
  let project = null
  let issue = null
  let notification = null
  let delivery = null
  let modelRequestCount = 0
  let runtimeTaskId = ''

  const ownerRequest = (pathname, options) => requestJson(backendUrl, ownerToken, pathname, options)

  return {
    requiresCloudEnvironment: true,

    async prepareCloud(cloud) {
      backendUrl = cloud.backendUrl
      ownerToken = cloud.authToken
      owner = await ownerRequest('/api/users/me')
      // A provider proxy must never intercept device-to-backend model traffic.
      await ownerRequest('/api/users/me/proxy-config', {
        method: 'PUT',
        body: JSON.stringify({ proxy_url: 'http://127.0.0.1:1' }),
      })
    },

    setCloudEnvironment(environment) {
      cloudEnvironment = environment
    },

    async handleHttp(requestMessage, response, url) {
      if (
        requestMessage.method !== 'POST' ||
        !['/responses', '/v1/responses'].includes(url.pathname)
      ) {
        return false
      }
      const body = await readRequestBody(requestMessage)
      const serialized = JSON.stringify(body)
      const responseId = `direct-human-${++modelRequestCount}`
      const kind = codexRequestKind(body)
      if (kind === 'prewarm' || kind === 'compaction') {
        writeEvents(response, responseId, [assistantMessage('Ready')])
        return true
      }
      if (!serialized.includes(MARKER)) {
        writeEvents(response, responseId, [])
        return true
      }

      let events
      if (requestContainsToolOutput(body, CALLS.finalize)) {
        delivery = await waitForValue(
          () => ownerRequest(`/api/v1/loop-items/${issue.id}/deliveries`),
          value => value.items?.find(item => item.status === 'delivered'),
          '个人 Runtime Task 没有完成 Delivery finalize',
          modelResponseTimeoutMs
        )
        events = [assistantMessage(COMPLETION)]
      } else if (requestContainsToolOutput(body, CALLS.finalizeSearch)) {
        const tool = selectMcpTool(body, 'wework_space', 'finalize_delivery', {
          delivery_id: delivery.id,
          fulfillments: [],
        })
        events = namespacedFunctionCall(CALLS.finalize, tool.namespace, tool.name, tool.arguments)
      } else if (requestContainsToolOutput(body, CALLS.create)) {
        delivery = findDeliveryDraft(findToolOutput(body.input ?? [], CALLS.create))
        assert.ok(delivery, 'create_delivery 没有返回持久化的 Delivery 草稿')
        events = mcpToolRequestEvents(body, {
          toolName: 'finalize_delivery',
          argumentsValue: {
            delivery_id: delivery.id,
            fulfillments: [],
          },
          directToolName: directMcpToolName(body, 'finalize_delivery'),
          searchCallId: CALLS.finalizeSearch,
          toolCallId: CALLS.finalize,
        }).events
      } else if (requestContainsToolOutput(body, CALLS.createSearch)) {
        const tool = selectMcpTool(body, 'wework_space', 'create_delivery', {
          markdown: `# ${ISSUE}\n\n${MARKER}：项目周报已经整理完成。`,
        })
        events = namespacedFunctionCall(CALLS.create, tool.namespace, tool.name, tool.arguments)
      } else {
        events = mcpToolRequestEvents(body, {
          toolName: 'create_delivery',
          argumentsValue: {
            markdown: `# ${ISSUE}\n\n${MARKER}：项目周报已经整理完成。`,
          },
          directToolName: directMcpToolName(body, 'create_delivery'),
          searchCallId: CALLS.createSearch,
          toolCallId: CALLS.create,
        }).events
      }
      writeEvents(response, responseId, events)
      return true
    },

    async verify(control) {
      assert.ok(owner?.id, '当前登录用户 fixture 缺失')
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('clearSystemNotifications', 'body')
      await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await control.command('waitFor', scoped('[data-testid="collaboration-platform-root"]'), {
        timeoutMs: uiTimeoutMs,
      })
      await selectCollaborationDomain(control, CONTENT, 'cloud')
      await verifyCanonicalDeviceCatalog(control, ownerRequest, uiTimeoutMs)

      project = await createWorkspaceAndProject(control, ownerRequest, uiTimeoutMs)
      assert.equal(Object.keys(project.execution_environment?.devices ?? {}).length, 0)
      issue = await createIssue(control, project.id, ownerRequest, owner, uiTimeoutMs)
      assert.equal(String(issue.assignee_user_id), String(owner.id))
      issue = await verifyIssueTags(control, ownerRequest, issue, uiTimeoutMs)
      await captureScreenshot(control, 'assignment-00-created-without-environment.png', CONTENT)
      await control.command('click', '[data-testid="cloud-todo-detail-close"]')
      const remoteDevice = await cloudEnvironment.waitForDeviceType(
        REMOTE_DOCKER_DEVICE_ID,
        'remote'
      )
      const currentApp = await cloudEnvironment.waitForConnectedAppDevice()
      assert.ok(remoteDevice?.id, 'The real remote Docker Executor device is unavailable')
      await configureFirstProjectExecutionEnvironment(
        control,
        CONTENT,
        modelResponseTimeoutMs,
        remoteDevice.id
      )
      notification = await waitForValue(
        () => ownerRequest('/api/v1/wework-notifications?category=collaboration'),
        value =>
          value.items?.find(
            item =>
              item.kind === 'issue_dispatch_assignment' &&
              item.payload?.itemId === issue.id &&
              item.payload?.action === 'open_issue'
          ),
        '直接分人通知没有写入 Wework 协作收件箱',
        uiTimeoutMs
      )
      assert.equal(notification.payload.roundId, 'direct')
      assert.equal(notification.payload.taskTitle, ISSUE)
      assert.match(notification.payload.instructions, new RegExp(MARKER))
      assert.match(notification.payload.dispatchId, /^direct-human:/)
      assert.ok(notification.payload.assignmentId)
      assert.ok(notification.payload.humanAssignmentId)
      await captureScreenshot(control, 'assignment-01-direct-human-notification.png', CONTENT)

      const beforeItems = await ownerRequest(`/api/v1/cloud-projects/${project.id}/loop-items`)
      assert.deepEqual(
        beforeItems.items.map(item => item.id),
        [issue.id],
        '直接分人错误创建了人工子 Issue'
      )

      // A notification hands the reader the project it names, so the click has
      // to switch the workbench back even when another tab is on screen.
      await control.command('click', '[data-testid="workspace-tab-select-fixed-task"]')
      await control.command(
        'waitFor',
        '[data-testid="workspace-tab-select-fixed-task"][aria-selected="true"]',
        { timeoutMs: uiTimeoutMs }
      )
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            scoped('[data-testid="collaboration-platform-root"]')
          )
        ),
        0,
        '分配通知必须在项目之外打开，才能验证点击会切回项目'
      )
      await control.command('click', '[data-testid="wework-notifications-button"]')
      await control.command('click', '[data-testid="wework-notifications-refresh"]')
      await control.command('click', '[data-testid="wework-notifications-category-collaboration"]')
      const notificationRow = `[data-testid="wework-notification-${notification.id}"]`
      await control.command('waitFor', notificationRow, {
        text: ISSUE,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', notificationRow)
      await control.command(
        'waitFor',
        '[data-testid="workspace-tab-select-fixed-board"][aria-selected="true"]',
        { timeoutMs: uiTimeoutMs }
      )
      if (issue.status !== 'pending') {
        await changeIssueStatus(control, ownerRequest, issue.id, 'pending', uiTimeoutMs)
      }
      const pendingIssue = await ownerRequest(`/api/v1/loop-items/${issue.id}`)
      assert.equal(pendingIssue.status, 'pending')
      assert.deepEqual(pendingIssue.human_task_binding, {
        humanAssignmentId: notification.payload.humanAssignmentId,
        dispatchId: notification.payload.dispatchId,
        dispatchRoundId: notification.payload.roundId,
        assignmentId: notification.payload.assignmentId,
      })
      await captureScreenshot(control, 'assignment-02-human-work-pending.png', CONTENT)
      await control.command('click', scoped('[data-testid="cloud-todo-personal-task-start"]'), {
        visible: true,
      })
      await control.command('waitFor', '[data-testid="ai-chat-modal"]', {
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      const taskPanel = '[data-testid="work-item-new-task-chat-panel"]'
      const composer = `${taskPanel} [data-testid="chat-message-input"]`
      await control.command('waitFor', composer, { timeoutMs: uiTimeoutMs, visible: true })
      const reference = await control.command('getValue', composer)
      assert.match(reference, new RegExp(issue.id))
      await control.command('fill', composer, {
        value: `${reference}\n\n请整理项目周报并创建交付，标记为 ${MARKER}。`,
      })
      await captureScreenshot(control, 'assignment-03-ai-panel-open.png', CONTENT)
      await control.command('waitFor', `${taskPanel} [data-testid="model-selector-button"]`, {
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      await selectE2EModel(control, MODEL, MODEL_LABEL, taskPanel)
      await captureScreenshot(control, 'assignment-03-optional-ai-draft.png', CONTENT)
      await control.command('press', composer, { key: 'Enter' })

      const binding = await waitForValue(
        () => ownerRequest(`/api/v1/loop-items/${issue.id}/tasks`),
        values =>
          values.find(
            value => value.human_assignment_id === notification.payload.humanAssignmentId
          ),
        '通知创建的个人 Runtime Task 没有绑定回原 Issue',
        modelResponseTimeoutMs
      )
      runtimeTaskId = binding.task_id
      assert.equal(
        binding.device_id,
        currentApp.app_device_id ?? currentApp.device_id,
        'Human AI assistance must run on the current computer even when the project environment is remote'
      )
      assert.equal(binding.assignment_id, notification.payload.assignmentId)
      assert.equal(binding.dispatch_id, notification.payload.dispatchId)
      assert.equal(binding.dispatch_round_id, notification.payload.roundId)
      assert.equal(binding.task_title, ISSUE)
      const contextQuery = new URLSearchParams({
        device_id: binding.device_id,
        task_id: binding.task_id,
      })
      const taskContext = await ownerRequest(`/api/v1/runtime-tasks/cloud-context?${contextQuery}`)
      assert.equal(taskContext.backend_task_id, null)
      assert.deepEqual(taskContext.loop_item.human_task_binding, pendingIssue.human_task_binding)
      assert.equal('human_work' in taskContext.loop_item, false)
      await control.command(
        'waitFor',
        '[data-testid="ai-chat-modal"] [data-testid="message-assistant"]',
        {
          text: COMPLETION,
          timeoutMs: modelResponseTimeoutMs,
        }
      )
      const issueAfterAiDraft = await waitForValue(
        () => ownerRequest(`/api/v1/loop-items/${issue.id}`),
        value => value.current_delivery_id === delivery.id && value.status === 'in_progress',
        '个人任务应启动原 Issue，AI 交付应关联该 Issue 并保留进行中状态',
        modelResponseTimeoutMs
      )
      // Task creation and delivery stay concurrent; only the task-start transition is allowed.
      assert.deepEqual(
        issueAfterAiDraft.status_history.slice(0, -1),
        pendingIssue.status_history,
        'AI 交付不应增加启动个人任务以外的 Issue 状态变更'
      )
      const startTransition = issueAfterAiDraft.status_history.at(-1)
      assert.deepEqual(
        {
          from_status: startTransition.from_status,
          to_status: startTransition.to_status,
          trigger: startTransition.trigger,
          by_user_id: startTransition.by_user_id,
        },
        {
          from_status: pendingIssue.status,
          to_status: 'in_progress',
          trigger: 'user_update',
          by_user_id: owner.id,
        },
        '原 Issue 应仅由用户启动个人任务进入进行中'
      )
      assert.equal(issueAfterAiDraft.completed_at, null)
      assert.equal(
        delivery.source_task_snapshot.humanAssignmentId,
        notification.payload.humanAssignmentId
      )
      assert.equal(delivery.source_task_snapshot.assignmentId, notification.payload.assignmentId)
      const assignmentStatus = await ownerRequest(
        `/api/v1/cloud-projects/${project.id}/executions/statuses`,
        {
          method: 'POST',
          body: JSON.stringify({
            loop_item_id: issue.id,
            human_assignment_ids: [notification.payload.humanAssignmentId],
          }),
        }
      )
      assert.equal(assignmentStatus.items[0].status, 'completed')
      assert.equal(assignmentStatus.items[0].runtime_task_id, binding.task_id)
      assert.equal(assignmentStatus.items[0].delivery_id, delivery.id)

      const afterItems = await ownerRequest(`/api/v1/cloud-projects/${project.id}/loop-items`)
      assert.deepEqual(
        afterItems.items.map(item => item.id),
        [issue.id],
        '完成个人任务后错误创建了人工子 Issue'
      )
      const bindingsAfterDelivery = await ownerRequest(`/api/v1/loop-items/${issue.id}/tasks`)
      assert.equal(
        bindingsAfterDelivery.filter(
          value => value.human_assignment_id === notification.payload.humanAssignmentId
        ).length,
        1,
        '同一人工 assignment 创建了重复 Task binding'
      )
      await captureScreenshot(control, 'assignment-04-ai-draft-attached-to-issue.png', CONTENT)

      await control.command('click', '[data-testid="ai-chat-modal-close"]', { visible: true })
      assert.equal(binding.modelSelection?.modelName, MODEL)
      // Change the new-chat default without sending, then reopen the bound personal
      // task through the Issue drawer. Its model must come from the binding.
      await control.command('click', scoped('[data-testid="cloud-todo-personal-task-start"]'), {
        visible: true,
      })
      await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL, taskPanel)
      await control.command('click', '[data-testid="ai-chat-modal-close"]', { visible: true })
      const boundTask = scoped(`[data-testid="cloud-todo-open-task-conversation-${binding.id}"]`)
      await control.command('waitFor', boundTask)
      await control.command('scrollIntoView', boundTask)
      await control.command('waitFor', boundTask, { visible: true })
      await control.command('click', boundTask, { visible: true })
      const boundModelSelector =
        '[data-testid="work-item-task-chat-panel"] [data-testid="model-selector-button"]'
      await control.command('waitFor', boundModelSelector, {
        text: MODEL_LABEL,
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      assert.equal(
        (await control.command('getText', boundModelSelector, { visible: true })).includes(
          DEFAULT_MODEL_LABEL
        ),
        false,
        'The bound personal task inherited the unrelated new-chat default'
      )
      await captureScreenshot(control, 'assignment-04-bound-task-model-preserved.png', CONTENT)
      await control.command('click', '[data-testid="ai-chat-modal-close"]', { visible: true })
      await changeIssueStatus(control, ownerRequest, issue.id, 'completed', uiTimeoutMs)
      await captureScreenshot(control, 'assignment-05-human-completed.png', CONTENT)
      await control.command('click', '[data-testid="wework-notifications-button"]')
      await control.command('click', '[data-testid="wework-notifications-refresh"]')
      await control.command('click', '[data-testid="wework-notifications-category-collaboration"]')
      await control.command('click', notificationRow)
      await control.command('waitFor', '[data-testid="cloud-todo-detail"]', {
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        Number(await control.command('getElementCount', '[data-testid="ai-chat-modal"]')),
        0,
        '重复点击通知错误打开了 AI 任务'
      )
      const bindingsAfterReopen = await ownerRequest(`/api/v1/loop-items/${issue.id}/tasks`)
      assert.equal(bindingsAfterReopen.length, bindingsAfterDelivery.length)
      const modelRequestsBeforeManualWork = modelRequestCount
      await verifyManualCommentFlow(
        control,
        ownerRequest,
        project.id,
        owner,
        uiTimeoutMs,
        filename => captureScreenshot(control, filename, CONTENT)
      )
      assert.equal(modelRequestCount, modelRequestsBeforeManualWork, '纯人工分支触发了 AI 模型请求')
      await verifySilentIssueSaves({
        control,
        projectId: project.id,
        owner,
        request: ownerRequest,
        requestJson: (token, path, options) => requestJson(backendUrl, token, path, options),
        createIssue,
        waitForValue,
        uiTimeoutMs,
        capture: filename => captureScreenshot(control, filename, CONTENT),
      })
      await verifyLinkedTasksScrolling(control, {
        request: ownerRequest,
        projectId: project.id,
        issueId: issue.id,
      })
      await verifyIssuePersonalTaskPrivacy({
        control,
        request: ownerRequest,
        requestJson: (token, path, options) => requestJson(backendUrl, token, path, options),
        backendUrl,
        projectId: project.id,
        issueId: issue.id,
        taskId: runtimeTaskId,
        uiTimeoutMs,
      })
    },

    diagnostics() {
      return {
        deliveryId: delivery?.id ?? null,
        humanAssignmentId: notification?.payload?.humanAssignmentId ?? null,
        issueId: issue?.id ?? null,
        modelRequestCount,
        projectId: project?.id ?? null,
        runtimeTaskId: runtimeTaskId || null,
      }
    },
  }
}
