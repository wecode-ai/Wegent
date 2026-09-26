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
import { REMOTE_DOCKER_DEVICE_ID, selectE2EModel } from '../modules/shared.mjs'
import { selectCollaborationDomain } from '../modules/workspace-flows.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const MODEL = 'desktop-e2e-cloud-responses'
const MODEL_LABEL = 'gpt-6-astra'
const WORKSPACE = `直接分人空间-${process.pid}`
const PROJECT = `直接分人项目-${process.pid}`
const ISSUE = `人工验收项目周报-${process.pid}`
const MARKER = `DIRECT_HUMAN_DISPATCH_${process.pid}`
const COMPLETION = `${MARKER}_DELIVERED`
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

async function createIssue(control, projectId, request, owner, uiTimeoutMs) {
  await control.command('waitFor', scoped('[data-testid="collaboration-tab-board"]'), {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('click', scoped('[data-testid="collaboration-tab-board"]'))
  await control.command('click', scoped('[data-testid="collaboration-issue-create"]'))
  await control.command('fill', scoped('[data-testid="cloud-todo-title"]'), { value: ISSUE })
  await control.command('fill', scoped('[data-testid="cloud-todo-detail-description"]'), {
    value: `${MARKER}。通过个人 Runtime Task 整理项目周报并提交 Delivery。`,
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
    items => items.find(item => item.title === ISSUE),
    '端上创建 Issue 未持久化',
    uiTimeoutMs
  )
}

async function initializeRemoteEnvironment(control, remoteDevice, timeoutMs) {
  await control.command('click', scoped('[data-testid="collaboration-tab-manage"]'))
  await control.command(
    'click',
    scoped('[data-testid="collaboration-project-settings-environments"]')
  )
  await control.command(
    'click',
    scoped('[data-testid="collaboration-project-execution-environment-add"]')
  )
  await control.command(
    'clickWhenEnabled',
    scoped(
      `[data-testid="collaboration-project-execution-environment-candidate-${remoteDevice.id}"]`
    ),
    { timeoutMs }
  )
  await control.command(
    'clickWhenEnabled',
    scoped(
      `[data-testid="collaboration-project-execution-environment-initialize-${remoteDevice.id}"]`
    ),
    { timeoutMs }
  )
  await control.command(
    'waitFor',
    scoped('[data-testid="collaboration-project-execution-environment-completion-status"]'),
    { text: '环境已初始化', timeoutMs }
  )
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

      project = await createWorkspaceAndProject(control, ownerRequest, uiTimeoutMs)
      const remoteDevice = await cloudEnvironment.waitForDeviceType(
        REMOTE_DOCKER_DEVICE_ID,
        'remote'
      )
      assert.ok(remoteDevice?.id, 'The real remote Docker Executor device is unavailable')
      await initializeRemoteEnvironment(control, remoteDevice, modelResponseTimeoutMs)
      issue = await createIssue(control, project.id, ownerRequest, owner, uiTimeoutMs)
      assert.equal(String(issue.assignee_user_id), String(owner.id))
      notification = await waitForValue(
        () => ownerRequest('/api/v1/wework-notifications?category=collaboration'),
        value =>
          value.items?.find(
            item =>
              item.kind === 'issue_dispatch_assignment' &&
              item.payload?.itemId === issue.id &&
              item.payload?.action === 'create_personal_task'
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
      await control.command('waitFor', '[data-testid="issue-dispatch-notification-create-task"]', {
        text: ISSUE,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="issue-dispatch-notification-create-task"]')
      await control.command('waitFor', scoped('[data-testid="ai-chat-modal"]'), {
        timeoutMs: uiTimeoutMs,
      })
      const taskPanel = scoped('[data-testid="work-item-new-task-chat-panel"]')
      const composer = `${taskPanel} [data-testid="chat-message-input"]`
      await control.command('waitFor', composer, { timeoutMs: uiTimeoutMs })
      assert.match(await control.command('getValue', composer), new RegExp(MARKER))
      await selectE2EModel(control, MODEL, MODEL_LABEL, taskPanel)
      await captureScreenshot(control, 'assignment-02-personal-runtime-task.png', CONTENT)
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
      assert.equal(binding.assignment_id, notification.payload.assignmentId)
      assert.equal(binding.task_title, ISSUE)
      await control.command(
        'waitFor',
        scoped('[data-testid="ai-chat-modal"] [data-testid="message-assistant"]'),
        {
          text: COMPLETION,
          timeoutMs: modelResponseTimeoutMs,
        }
      )
      await waitForValue(
        () => ownerRequest(`/api/v1/loop-items/${issue.id}`),
        value => value.status === 'in_review',
        '直接人工交付没有把原 Issue 更新为待确认',
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
      await captureScreenshot(control, 'assignment-03-delivery-updated-origin-issue.png', CONTENT)

      await control.command('click', scoped('[data-testid="ai-chat-modal-close"]'))
      await control.command('click', '[data-testid="wework-notifications-button"]')
      await control.command('click', '[data-testid="wework-notifications-refresh"]')
      await control.command('click', '[data-testid="wework-notifications-category-collaboration"]')
      await control.command('click', '[data-testid="issue-dispatch-notification-create-task"]')
      await control.command('waitFor', scoped('[data-testid="ai-chat-modal"]'), {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', scoped('[data-testid="work-item-task-chat-panel"]'), {
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            scoped('[data-testid="work-item-new-task-chat-panel"]')
          )
        ),
        0,
        '重复点击通知错误打开了新建 Runtime Task'
      )
      const bindingsAfterReopen = await ownerRequest(`/api/v1/loop-items/${issue.id}/tasks`)
      assert.equal(bindingsAfterReopen.length, bindingsAfterDelivery.length)
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
