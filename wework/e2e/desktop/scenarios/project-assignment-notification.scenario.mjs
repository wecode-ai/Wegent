import assert from 'node:assert/strict'

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
  initializeFirstProjectExecutionEnvironment,
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
const REVISED_RESULT = `${MANUAL_RESULT} 已补充验收证据。`
const RETURN_REASON = '请补充验收证据'
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

  await control.command('click', scoped('[data-testid="collaboration-workspace-project-create"]'))
  await control.command('click', '[data-testid="collaboration-workspace-project-create-blank"]')
  await control.command('fill', scoped('[data-testid="collaboration-project-name-input"]'), {
    value: PROJECT,
  })
  await control.command('click', scoped('[data-testid="collaboration-project-create-advanced"]'))
  await control.command('click', scoped('[data-testid="cloud-project-task-provider-local"]'))
  await control.command(
    'clickWhenEnabled',
    scoped('[data-testid="collaboration-project-create-confirm"]'),
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

async function createIssue(control, projectId, request, owner, uiTimeoutMs, title = ISSUE) {
  await control.command('waitFor', scoped('[data-testid="collaboration-tab-board"]'), {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('click', scoped('[data-testid="collaboration-tab-board"]'))
  await control.command('click', scoped('[data-testid="collaboration-issue-create"]'))
  await control.command('fill', scoped('[data-testid="cloud-todo-title"]'), { value: title })
  await control.command('fill', scoped('[data-testid="cloud-todo-detail-description"]'), {
    value:
      title === ISSUE
        ? `${MARKER}。处理人可请 AI 起草周报，检查后亲自提交处理结果。`
        : `${MARKER}。处理人亲自核对周报并提交处理结果。`,
  })
  await control.command('click', scoped('[data-testid="cloud-todo-create-assignee"]'))
  await control.command(
    'click',
    `[data-testid="cloud-todo-create-assignee-option-user:${owner.id}"]`
  )
  await control.command('clickWhenEnabled', scoped('[data-testid="cloud-todo-create-confirm"]'), {
    timeoutMs: uiTimeoutMs,
  })
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

async function verifyManualReviewCycle(control, request, projectId, owner, uiTimeoutMs, capture) {
  await control.command('click', '[data-testid="cloud-todo-detail-close"]')
  const manualIssue = await createIssue(
    control,
    projectId,
    request,
    owner,
    uiTimeoutMs,
    MANUAL_ISSUE
  )
  const notification = await waitForValue(
    () => request('/api/v1/wework-notifications?category=collaboration'),
    value =>
      value.items?.find(
        item =>
          item.kind === 'issue_dispatch_assignment' &&
          item.payload?.itemId === manualIssue.id &&
          item.payload?.action === 'open_issue'
      ),
    '纯人工 Issue 没有创建协作通知',
    uiTimeoutMs
  )
  await control.command('click', '[data-testid="wework-notifications-button"]')
  await control.command('click', '[data-testid="wework-notifications-refresh"]')
  await control.command('click', '[data-testid="wework-notifications-category-collaboration"]')
  await control.command('click', `[data-testid="wework-notification-${notification.id}"]`)
  await control.command('clickElementWithText', '[data-testid="human-issue-start"]', {
    text: '接手处理',
    timeoutMs: uiTimeoutMs,
    visible: true,
  })
  const resultSelector = scoped('[data-testid="human-issue-result"]')
  await control.command('waitFor', resultSelector, { timeoutMs: uiTimeoutMs, visible: true })
  assert.equal(Number(await control.command('getElementCount', '[data-testid="ai-chat-modal"]')), 0)
  await control.command('fill', resultSelector, { value: MANUAL_RESULT })
  await control.command('click', '[data-testid="human-issue-submit"]', { visible: true })
  await control.command('click', '[data-testid="human-issue-work-cancel"]', { visible: true })
  assert.equal((await request(`/api/v1/loop-items/${manualIssue.id}`)).status, 'in_progress')
  assert.equal(await control.command('getValue', resultSelector), MANUAL_RESULT)
  await control.command('click', '[data-testid="human-issue-submit"]', { visible: true })
  await control.command('click', '[data-testid="human-issue-work-confirm"]', { visible: true })
  await waitForValue(
    () => request(`/api/v1/loop-items/${manualIssue.id}`),
    value => value.status === 'in_review' && value.human_work?.state === 'submitted',
    '纯人工结果没有进入待确认',
    uiTimeoutMs
  )
  await control.command('waitFor', '[data-testid="human-issue-request-changes"]', {
    visible: true,
    timeoutMs: uiTimeoutMs,
  })
  await control.command('click', '[data-testid="human-issue-request-changes"]', {
    visible: true,
  })
  await control.command('waitFor', '[data-testid="human-issue-work-dialog"]', {
    visible: true,
    timeoutMs: uiTimeoutMs,
  })
  assert.equal(
    await control.command('getAttribute', '[data-testid="human-issue-work-confirm"]', {
      value: 'disabled',
    }),
    ''
  )
  await control.command('fill', '[data-testid="human-issue-return-reason-input"]', {
    value: RETURN_REASON,
  })
  await control.command('click', '[data-testid="human-issue-work-confirm"]', { visible: true })
  await waitForValue(
    () => request(`/api/v1/loop-items/${manualIssue.id}`),
    value =>
      value.status === 'in_progress' &&
      value.human_work?.state === 'changes_requested' &&
      value.human_work?.return_reason === RETURN_REASON,
    '验收退回没有恢复到人工处理中',
    uiTimeoutMs
  )
  await control.command('waitFor', '[data-testid="human-issue-return-reason"]', {
    text: RETURN_REASON,
    timeoutMs: uiTimeoutMs,
  })
  assert.equal(await control.command('getValue', resultSelector), MANUAL_RESULT)
  await capture('assignment-06-manual-changes-requested.png', CONTENT)
  await control.command('fill', resultSelector, { value: REVISED_RESULT })
  await control.command('click', '[data-testid="human-issue-submit"]', { visible: true })
  await control.command('click', '[data-testid="human-issue-work-confirm"]', { visible: true })
  await waitForValue(
    () => request(`/api/v1/loop-items/${manualIssue.id}`),
    value =>
      value.status === 'in_review' &&
      value.human_work?.state === 'submitted' &&
      value.human_work?.result === REVISED_RESULT,
    '修改后的纯人工结果没有重新提交',
    uiTimeoutMs
  )
  await control.command('waitFor', '[data-testid="human-issue-accept"]', {
    visible: true,
    timeoutMs: uiTimeoutMs,
  })
  await control.command('click', '[data-testid="human-issue-accept"]', { visible: true })
  await waitForValue(
    () => request(`/api/v1/loop-items/${manualIssue.id}`),
    value => value.status === 'completed' && value.human_work?.state === 'accepted',
    '退回重提后的人工 Issue 未完成验收',
    uiTimeoutMs
  )
  assert.deepEqual(await request(`/api/v1/loop-items/${manualIssue.id}/tasks`), [])
  await capture('assignment-07-manual-resubmitted-accepted.png', CONTENT)

  // Establish a new assignment without changing the completed Issue's status.
  const acceptedIssue = await request(`/api/v1/loop-items/${manualIssue.id}`)
  const unassigned = await request(`/api/v1/loop-items/${manualIssue.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ version: acceptedIssue.version, assignee_user_id: null }),
  })
  assert.equal(unassigned.status, 'completed')
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
  assert.equal(reassigned.human_work?.state, 'none')
  assert.equal(reassigned.human_work?.can_start, true)
  await control.command('waitFor', '[data-testid="human-issue-start"]', {
    visible: true,
    timeoutMs: uiTimeoutMs,
  })
  await control.command('click', '[data-testid="human-issue-start"]', { visible: true })
  await waitForValue(
    () => request(`/api/v1/loop-items/${manualIssue.id}`),
    value => value.status === 'in_progress',
    '重新指派后的显式接手没有进入进行中',
    uiTimeoutMs
  )
  assert.deepEqual(await request(`/api/v1/loop-items/${manualIssue.id}/tasks`), [])
  await capture('assignment-08-reassigned-human-work-started.png', CONTENT)
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
      assert.ok(remoteDevice?.id, 'The real remote Docker Executor device is unavailable')
      await initializeFirstProjectExecutionEnvironment(
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

      await control.command('click', '[data-testid="wework-notifications-button"]')
      await control.command('click', '[data-testid="wework-notifications-refresh"]')
      await control.command('click', '[data-testid="wework-notifications-category-collaboration"]')
      const notificationRow = `[data-testid="wework-notification-${notification.id}"]`
      await control.command('waitFor', notificationRow, {
        text: ISSUE,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', notificationRow)
      await control.command('clickElementWithText', '[data-testid="human-issue-start"]', {
        text: '接手处理',
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      await control.command('waitFor', '[data-testid="human-issue-result"]', {
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      await captureScreenshot(control, 'assignment-02-human-work-started.png', CONTENT)
      await control.command('clickElementWithText', '[data-testid="human-issue-ai-assist"]', {
        text: 'AI 辅助',
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      await control.command('waitFor', '[data-testid="ai-chat-modal"]', {
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      const taskPanel = '[data-testid="work-item-new-task-chat-panel"]'
      const composer = `${taskPanel} [data-testid="chat-message-input"]`
      await control.command('waitFor', composer, { timeoutMs: uiTimeoutMs, visible: true })
      assert.match(await control.command('getValue', composer), new RegExp(MARKER))
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
        remoteDevice.device_id,
        'AI assistance must use the prepared remote environment, not Local Executor'
      )
      assert.equal(binding.assignment_id, notification.payload.assignmentId)
      assert.equal(binding.task_title, ISSUE)
      await control.command(
        'waitFor',
        '[data-testid="ai-chat-modal"] [data-testid="message-assistant"]',
        {
          text: COMPLETION,
          timeoutMs: modelResponseTimeoutMs,
        }
      )
      await waitForValue(
        () => ownerRequest(`/api/v1/loop-items/${issue.id}`),
        value =>
          value.status === 'in_progress' && value.human_work?.ai_draft_delivery_id === delivery.id,
        'AI 草稿不应替处理人提交原 Issue',
        modelResponseTimeoutMs
      )
      assert.equal(
        delivery.source_task_snapshot.humanAssignmentId,
        notification.payload.humanAssignmentId
      )
      assert.equal(delivery.source_task_snapshot.assignmentId, notification.payload.assignmentId)

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
      // Change the new-chat default without sending, then reopen the bound remote
      // task through the Issue drawer. Its model must come from the binding.
      await control.command('click', '[data-testid="cloud-todo-create-task"]', { visible: true })
      await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL, taskPanel)
      await control.command('click', '[data-testid="ai-chat-modal-close"]', { visible: true })
      await control.command('click', '[data-testid="cloud-todo-toggle-tasks"]', { visible: true })
      await control.command(
        'click',
        `[data-testid="cloud-todo-open-task-conversation-${binding.id}"]`,
        { visible: true }
      )
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
        'The bound remote task inherited the unrelated new-chat default'
      )
      await captureScreenshot(control, 'assignment-04-bound-task-model-preserved.png', CONTENT)
      await control.command('click', '[data-testid="ai-chat-modal-close"]', { visible: true })
      await control.command('click', '[data-testid="cloud-todo-toggle-tasks"]', { visible: true })
      await control.command('waitFor', '[data-testid="human-issue-use-ai-draft"]', {
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      await control.command('click', '[data-testid="human-issue-use-ai-draft"]', { visible: true })
      await waitForValue(
        () => control.command('getValue', scoped('[data-testid="human-issue-result"]')),
        value => value.includes(MARKER),
        'AI 草稿没有填入处理结果',
        uiTimeoutMs
      )
      await control.command('click', '[data-testid="human-issue-submit"]', { visible: true })
      await control.command('click', '[data-testid="human-issue-work-confirm"]', { visible: true })
      await waitForValue(
        () => ownerRequest(`/api/v1/loop-items/${issue.id}`),
        value => value.status === 'in_review' && value.human_work?.state === 'submitted',
        '处理人没有亲自提交结果进入待确认',
        uiTimeoutMs
      )
      await control.command('waitFor', '[data-testid="human-issue-accept"]', {
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      await control.command('click', '[data-testid="human-issue-accept"]', { visible: true })
      await waitForValue(
        () => ownerRequest(`/api/v1/loop-items/${issue.id}`),
        value => value.status === 'completed' && value.human_work?.state === 'accepted',
        '验收通过没有完成原 Issue',
        uiTimeoutMs
      )
      await captureScreenshot(control, 'assignment-05-human-accepted.png', CONTENT)
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
      await verifyManualReviewCycle(
        control,
        ownerRequest,
        project.id,
        owner,
        uiTimeoutMs,
        filename => captureScreenshot(control, filename, CONTENT)
      )
      assert.equal(modelRequestCount, modelRequestsBeforeManualWork, '纯人工分支触发了 AI 模型请求')
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
