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
import { selectE2EModel } from '../modules/shared.mjs'
import { selectCollaborationDomain, waitForTestIdByText } from '../modules/workspace-flows.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const MODEL = 'desktop-e2e-cloud-responses'
const MODEL_LABEL = 'gpt-6-astra'
const WORKSPACE = `人工闭环空间-${process.pid}`
const PROJECT = `人工闭环项目-${process.pid}`
const LEADER = `人工闭环负责人-${process.pid}`
const MEMBER = `人工闭环执行者-${process.pid}`
const GROUP = `人机协作小组-${process.pid}`
const ISSUE = `验证人工交付恢复负责人-${process.pid}`
const HUMAN_TASK = `人工核对证据-${process.pid}`
const AI_TASK = `智能体采集证据-${process.pid}`
const MARKER = `HUMAN_ROUND_RESUME_${process.pid}`
const ROUND_ID = `${MARKER}-round-1`
const HUMAN_ASSIGNMENT_ID = `${MARKER}-human-assignment`
const HUMAN_DELIVERY_COMPLETION = `${HUMAN_TASK} 已交付：人工证据已核对。`
const REMOTE_DOCKER_DEVICE_ID = 'wework-e2e-remote-docker-device'
const CALLS = {
  plan: `${MARKER}-plan`,
  updateStatus: `${MARKER}-update-status`,
  humanCreateSearch: `${MARKER}-human-create-search`,
  humanCreate: `${MARKER}-human-create`,
  humanFinalizeSearch: `${MARKER}-human-finalize-search`,
  humanFinalize: `${MARKER}-human-finalize`,
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
      Authorization: `Bearer ${token}`,
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

function managerToolEvents(body, toolName, toolCallId, argumentsValue) {
  return mcpToolRequestEvents(body, {
    toolName,
    argumentsValue,
    searchCallId: `${toolCallId}-search`,
    toolCallId,
  })
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

async function waitForPromise(promise, timeoutMs, message) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function selectAgentModel(control, modelName, timeoutMs) {
  const selector = '[data-testid="wework-agent-model"]'
  const deadline = Date.now() + timeoutMs
  let availableModels = []
  while (Date.now() < deadline) {
    const optionCount = Number(await control.command('getElementCount', `${selector} option`))
    availableModels = []
    for (let index = 1; index <= optionCount; index += 1) {
      const option = `${selector} option:nth-child(${index})`
      const label = await control.command('getText', option)
      const value = await control.command('getAttribute', option, { value: 'value' })
      availableModels.push({ label, value })
      if (label === modelName) {
        await control.command('select', selector, { value })
        return
      }
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(
    `Responses 模型 ${modelName} 未出现在 Agent 编辑器: ${JSON.stringify(availableModels)}`
  )
}

async function createWorkspaceAndProject(control, request, uiTimeoutMs) {
  await control.command('waitFor', scoped('[data-testid="collaboration-workspace-create"]'), {
    timeoutMs: uiTimeoutMs,
  })
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
    values => values?.find(value => value.name === WORKSPACE),
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
    values => values?.find(value => value.name === PROJECT),
    '端上创建 Project 未持久化',
    uiTimeoutMs
  )
  assert.equal(project.task_provider, 'local', '端上创建的项目没有使用本地看板数据源')
  await control.command('waitFor', scoped('[data-testid="collaboration-tab-manage"]'), {
    timeoutMs: uiTimeoutMs,
  })
  return { project }
}

async function createAgent(control, request, projectId, name, prompt, uiTimeoutMs) {
  await control.command('clickWhenEnabled', scoped('[data-testid="project-agent-add"]'), {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('waitFor', '[data-testid="wework-agent-resource-creator"]', {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('fill', '[data-testid="wework-agent-display-name"]', { value: name })
  await selectAgentModel(control, MODEL, uiTimeoutMs)
  await control.command('fill', '[data-testid="wework-agent-system-prompt"]', { value: prompt })
  await control.command('clickWhenEnabled', '[data-testid="wework-agent-resource-create"]', {
    timeoutMs: uiTimeoutMs,
  })
  const agent = await waitForValue(
    () => request(`/api/v1/cloud-projects/${projectId}/chat-agents`),
    values => values.find(value => value.name === name),
    `端上创建智能体 ${name} 未持久化`,
    uiTimeoutMs
  )
  await control.command('waitFor', '[data-testid="wework-agent-resource-creator"]', {
    visible: false,
    timeoutMs: uiTimeoutMs,
  })
  return agent
}

async function createGroup(control, request, projectId, ownerId, uiTimeoutMs) {
  await control.command('click', scoped('[data-testid="collaboration-participants-tab-groups"]'))
  await control.command('click', scoped('[data-testid="collaboration-group-open-create"]'))
  await control.command('fill', scoped('[data-testid="collaboration-group-name"]'), {
    value: GROUP,
  })
  await control.command('fill', scoped('[data-testid="collaboration-group-description"]'), {
    value: '验证 AI 任务和人工任务并发完成后，由新的负责人运行继续评估。',
  })
  await control.command('click', scoped('[data-testid="collaboration-group-create-add-members"]'))
  const leaderTestId = await waitForTestIdByText(
    control,
    CONTENT,
    'collaboration-group-create-member-agent-',
    LEADER,
    uiTimeoutMs
  )
  const memberTestId = await waitForTestIdByText(
    control,
    CONTENT,
    'collaboration-group-create-member-agent-',
    MEMBER,
    uiTimeoutMs
  )
  const humanTestId = `collaboration-group-create-member-human-${ownerId}`
  await control.command('click', `[data-testid="${leaderTestId}"]`)
  await control.command('click', `[data-testid="${memberTestId}"]`)
  await control.command('click', `[data-testid="${humanTestId}"]`)
  await control.command('click', scoped('[data-testid="collaboration-group-create-add-members"]'))
  await control.command('click', scoped('[data-testid="collaboration-group-leader"]'))
  const leaderId = leaderTestId.slice('collaboration-group-create-member-agent-'.length)
  await control.command('click', `[data-testid="collaboration-group-leader-agent-${leaderId}"]`)
  await control.command('clickWhenEnabled', scoped('[data-testid="collaboration-group-create"]'), {
    timeoutMs: uiTimeoutMs,
  })
  await waitForValue(
    () => request(`/api/v1/cloud-projects/${projectId}/collaboration-groups`),
    response => response.items?.find(value => value.name === GROUP),
    '端上创建人机协作小组未持久化',
    uiTimeoutMs
  )
  await control.command('click', scoped('[data-testid="collaboration-group-detail-tab-rules"]'))
  await control.command('fill', scoped('[data-testid="collaboration-group-detail-instructions"]'), {
    value: `${MARKER}：AI 与人工任务可并发；整轮全部交付后必须启动新的负责人运行继续评估。`,
  })
  await control.command(
    'clickWhenEnabled',
    scoped('[data-testid="collaboration-group-detail-save"]'),
    { timeoutMs: uiTimeoutMs }
  )
  await waitForValue(
    () => request(`/api/v1/cloud-projects/${projectId}/collaboration-groups`),
    response =>
      response.items?.find(
        value =>
          value.name === GROUP &&
          value.instructions?.includes('AI 与人工任务可并发；整轮全部交付后必须启动新的负责人运行')
      ),
    '协作小组规则保存后未持久化',
    uiTimeoutMs
  )
}

async function createAndAssignIssue(control, request, projectId, uiTimeoutMs) {
  await control.command('click', scoped('[data-testid="collaboration-tab-board"]'))
  await control.command('click', scoped('[data-testid="collaboration-issue-create"]'))
  await control.command('fill', scoped('[data-testid="cloud-todo-title"]'), { value: ISSUE })
  await control.command('fill', scoped('[data-testid="cloud-todo-detail-description"]'), {
    value: `${MARKER}。负责人必须并发分配一个 AI 任务和一个人工任务，等待个人 Task 正式交付后继续。`,
  })
  await control.command('clickWhenEnabled', scoped('[data-testid="cloud-todo-create-confirm"]'), {
    timeoutMs: uiTimeoutMs,
  })
  const issue = await waitForValue(
    async () => (await request(`/api/v1/cloud-projects/${projectId}/loop-items`)).items,
    values => values.find(value => value.title === ISSUE),
    '端上创建根 Issue 未持久化',
    uiTimeoutMs
  )
  await control.command('click', scoped('[data-testid="cloud-todo-detail-assignee"]'))
  const groupOption = await waitForTestIdByText(
    control,
    'body',
    'cloud-todo-detail-assignee-option-group:',
    GROUP,
    uiTimeoutMs
  )
  await control.command('click', `[data-testid="${groupOption}"]`)
  await control.command('clickWhenEnabled', scoped('[data-testid="cloud-todo-save"]'), {
    timeoutMs: uiTimeoutMs,
  })
  return issue
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
  let authToken = ''
  let cloudEnvironment = null
  let owner = null
  let project = null
  let member = null
  let rootIssue = null
  let humanAssignment = null
  let humanDelivery = null
  let managerStage = 'initial'
  let managerRuns = 0
  let aiRequestCount = 0
  let releaseAi
  let resolveAiStarted
  let resolveAiCompleted
  let resolveHumanCompleted
  let resolveManagerResumed
  const aiRelease = new Promise(resolve => {
    releaseAi = resolve
  })
  const aiStarted = new Promise(resolve => {
    resolveAiStarted = resolve
  })
  const aiCompleted = new Promise(resolve => {
    resolveAiCompleted = resolve
  })
  const humanCompleted = new Promise(resolve => {
    resolveHumanCompleted = resolve
  })
  const managerResumed = new Promise(resolve => {
    resolveManagerResumed = resolve
  })
  const request = (pathname, options) => requestJson(backendUrl, authToken, pathname, options)

  return {
    requiresCloudEnvironment: true,

    async prepareCloud(cloud) {
      backendUrl = cloud.backendUrl
      authToken = cloud.authToken
      owner = await request('/api/users/me')
      await request('/api/admin/setup-complete', { method: 'POST' })
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
      const responseId = `human-round-${Date.now()}-${managerStage}-${aiRequestCount}`
      const kind = codexRequestKind(body)
      if (kind === 'prewarm' || kind === 'compaction') {
        writeEvents(response, responseId, [assistantMessage('Ready')])
        return true
      }
      if (!serialized.includes(MARKER)) {
        writeEvents(response, responseId, [])
        return true
      }

      const isManagerRequest = serialized.includes('You are the manager for one project Issue.')
      if (!isManagerRequest && serialized.includes(`${MARKER}。你只完成负责人分配的 AI 子任务。`)) {
        assert.equal(aiRequestCount, 0, '同一 AI 子任务产生了重复模型运行')
        assert.ok(serialized.includes(AI_TASK), '执行成员请求没有使用负责人分配的任务标题')
        aiRequestCount = 1
        resolveAiStarted()
        await aiRelease
        writeEvents(response, responseId, [
          assistantMessage(`${AI_TASK} 已完成：AI 证据已提交给负责人。`),
        ])
        resolveAiCompleted()
        return true
      }

      if (!isManagerRequest) {
        assert.ok(serialized.includes(HUMAN_TASK), '个人 Runtime Task 没有使用负责人分配的标题')
        let events
        if (requestContainsToolOutput(body, CALLS.humanFinalize)) {
          resolveHumanCompleted()
          events = [assistantMessage(HUMAN_DELIVERY_COMPLETION)]
        } else if (requestContainsToolOutput(body, CALLS.humanFinalizeSearch)) {
          const tool = selectMcpTool(body, 'wework_space', 'finalize_delivery', {
            delivery_id: humanDelivery.id,
            fulfillments: [],
          })
          events = namespacedFunctionCall(
            CALLS.humanFinalize,
            tool.namespace,
            tool.name,
            tool.arguments
          )
        } else if (requestContainsToolOutput(body, CALLS.humanCreate)) {
          humanDelivery = findDeliveryDraft(findToolOutput(body.input ?? [], CALLS.humanCreate))
          assert.ok(humanDelivery, '个人 Runtime Task 没有返回持久化的 Delivery 草稿')
          events = mcpToolRequestEvents(body, {
            toolName: 'finalize_delivery',
            argumentsValue: {
              delivery_id: humanDelivery.id,
              fulfillments: [],
            },
            directToolName: directMcpToolName(body, 'finalize_delivery'),
            searchCallId: CALLS.humanFinalizeSearch,
            toolCallId: CALLS.humanFinalize,
          }).events
        } else if (requestContainsToolOutput(body, CALLS.humanCreateSearch)) {
          const tool = selectMcpTool(body, 'wework_space', 'create_delivery', {
            markdown: `# ${HUMAN_TASK}\n\n${MARKER} 人工证据已核对，结果可供负责人继续评估。`,
          })
          events = namespacedFunctionCall(
            CALLS.humanCreate,
            tool.namespace,
            tool.name,
            tool.arguments
          )
        } else {
          events = mcpToolRequestEvents(body, {
            toolName: 'create_delivery',
            argumentsValue: {
              markdown: `# ${HUMAN_TASK}\n\n${MARKER} 人工证据已核对，结果可供负责人继续评估。`,
            },
            directToolName: directMcpToolName(body, 'create_delivery'),
            searchCallId: CALLS.humanCreateSearch,
            toolCallId: CALLS.humanCreate,
          }).events
        }
        writeEvents(response, responseId, events)
        return true
      }

      assert.ok(serialized.includes(ISSUE), '负责人请求没有使用根 Issue 标题')

      const planArguments = {
        plan: {
          round_id: ROUND_ID,
          summary: '并发完成一项智能体证据采集和一项人工证据核对。',
          items: [
            {
              assignment_id: `${MARKER}-agent-assignment`,
              title: AI_TASK,
              instructions: `${MARKER}。采集一份独立证据，不更新 Issue 状态。`,
              assignee_type: 'agent',
              assignee_id: String(member.id),
            },
            {
              assignment_id: HUMAN_ASSIGNMENT_ID,
              title: HUMAN_TASK,
              instructions: `${MARKER}。人工核对 AI 证据并通过个人 Task 提交 Delivery。`,
              assignee_type: 'human',
              assignee_id: String(owner.id),
            },
          ],
        },
      }
      const updateStatusArguments = {
        status: 'in_review',
        reason: 'AI 任务完成且人工个人 Task 已正式交付，本轮证据齐全。',
        comment: '负责人已综合智能体证据和人工交付，将 Issue 提交待确认。',
      }

      if (requestContainsToolOutput(body, CALLS.updateStatus)) {
        managerStage = 'complete'
        writeEvents(response, responseId, [
          assistantMessage('负责人已评估本轮全部交付，并显式将 Issue 更新为待确认。'),
        ])
        return true
      }
      if (requestContainsToolOutput(body, CALLS.plan)) {
        managerStage = 'waiting-round'
        writeEvents(response, responseId, [
          assistantMessage('本轮智能体任务和人工任务已交给 Executor，等待全部交付。'),
        ])
        return true
      }

      if (managerStage === 'initial') {
        assert.ok(
          serialized.includes('AI 与人工任务可并发；整轮全部交付后必须启动新的负责人运行'),
          '项目协作规则没有作为负责人本轮用户消息的一部分传入'
        )
        const selection = managerToolEvents(body, 'submit_workflow_plan', CALLS.plan, planArguments)
        if (selection.mode === 'direct') {
          managerRuns += 1
          managerStage = 'waiting-round'
        }
        writeEvents(response, responseId, selection.events)
        return true
      }

      if (managerStage === 'waiting-round') {
        assert.equal(
          requestContainsToolOutput(body, CALLS.plan),
          false,
          '整轮完成后负责人恢复了旧会话，而不是启动新的 Runtime Task'
        )
        assert.equal(
          serialized.includes(CALLS.plan),
          false,
          '新的负责人 Runtime Task 仍携带上一轮 submit_workflow_plan 会话历史'
        )
        assert.ok(
          serialized.includes(`${AI_TASK} 已完成：AI 证据已提交给负责人。`),
          'barrier 后的新负责人运行没有收到 AI 执行结果'
        )
        assert.ok(
          serialized.includes(`${MARKER} 人工证据已核对，结果可供负责人继续评估。`),
          'barrier 后的新负责人运行没有收到人工 Delivery'
        )
        const selection = managerToolEvents(
          body,
          'update_issue_status',
          CALLS.updateStatus,
          updateStatusArguments
        )
        if (selection.mode === 'direct') {
          managerRuns += 1
          resolveManagerResumed()
          managerStage = 'updating-status'
        }
        writeEvents(response, responseId, selection.events)
        return true
      }

      assert.fail(`Unexpected manager stage: ${managerStage}`)
      return true
    },

    async verify(control) {
      assert.ok(owner?.id, '云端当前用户 fixture 缺失')
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await control.command('waitFor', scoped('[data-testid="collaboration-platform-root"]'), {
        timeoutMs: uiTimeoutMs,
      })
      await selectCollaborationDomain(control, CONTENT, 'cloud')
      const created = await createWorkspaceAndProject(control, request, uiTimeoutMs)
      project = created.project
      const remoteDevice = await cloudEnvironment.waitForDeviceType(
        REMOTE_DOCKER_DEVICE_ID,
        'remote'
      )
      assert.ok(remoteDevice?.id, 'The real remote Docker Executor device is unavailable')
      await initializeRemoteEnvironment(control, remoteDevice, modelResponseTimeoutMs)

      await control.command('click', scoped('[data-testid="collaboration-tab-manage"]'))
      await control.command(
        'click',
        scoped('[data-testid="collaboration-project-settings-participants"]')
      )
      await control.command(
        'click',
        scoped('[data-testid="collaboration-participants-tab-agents"]')
      )
      await createAgent(
        control,
        request,
        project.id,
        LEADER,
        `${MARKER}。你是负责人，按轮次分配 AI 与人工任务并验收。`,
        uiTimeoutMs
      )
      member = await createAgent(
        control,
        request,
        project.id,
        MEMBER,
        `${MARKER}。你只完成负责人分配的 AI 子任务。`,
        uiTimeoutMs
      )
      await createGroup(control, request, project.id, owner.id, uiTimeoutMs)
      rootIssue = await createAndAssignIssue(control, request, project.id, uiTimeoutMs)

      humanAssignment = await waitForValue(
        () => request('/api/v1/wework-notifications?category=collaboration'),
        value =>
          value.items?.find(
            item =>
              item.kind === 'issue_dispatch_assignment' &&
              item.payload?.assignmentId === HUMAN_ASSIGNMENT_ID
          ),
        '负责人没有创建人工任务通知',
        modelResponseTimeoutMs
      )
      await waitForPromise(aiStarted, modelResponseTimeoutMs, '负责人没有启动独立的 AI 执行任务')
      await control.command('waitFor', scoped('[data-testid="cloud-task-activity-list"]'), {
        text: MEMBER,
        timeoutMs: modelResponseTimeoutMs,
      })
      await control.command('waitFor', scoped('[data-testid="cloud-task-activity-list"]'), {
        text: owner.user_name,
        timeoutMs: modelResponseTimeoutMs,
      })
      const loopItems = await request(`/api/v1/cloud-projects/${project.id}/loop-items`)
      assert.equal(
        loopItems.items.some(
          item =>
            item.title === HUMAN_TASK &&
            String(item.parent_id ?? item.parentId) === String(rootIssue.id)
        ),
        false,
        '人工 assignment 被错误实现为人工子 Issue'
      )
      assert.equal(humanAssignment.payload.action, 'create_personal_task')
      assert.equal(humanAssignment.payload.itemId, String(rootIssue.id))
      assert.equal(humanAssignment.payload.assignmentId, HUMAN_ASSIGNMENT_ID)
      assert.ok(humanAssignment.payload.humanAssignmentId)
      await captureScreenshot(control, 'human-round-01-human-and-ai-assigned.png', CONTENT)

      releaseAi()
      await waitForPromise(
        aiCompleted,
        modelResponseTimeoutMs,
        'AI 子任务没有通过独立 Executor execution 完成'
      )
      await new Promise(resolve => setTimeout(resolve, 1_000))
      assert.equal(managerRuns, 1, '只有 AI 完成时负责人被错误恢复')
      assert.equal(managerStage, 'waiting-round')
      assert.equal(
        (await request(`/api/v1/loop-items/${rootIssue.id}`)).status,
        'in_progress',
        '人工交付前根 Issue 被错误迁移'
      )
      await captureScreenshot(control, 'human-round-02-ai-finished-human-pending.png', CONTENT)

      await control.command('click', '[data-testid="wework-notifications-button"]')
      await control.command('click', '[data-testid="wework-notifications-refresh"]')
      await control.command('click', '[data-testid="wework-notifications-category-collaboration"]')
      await control.command('waitFor', '[data-testid="issue-dispatch-notification-create-task"]', {
        text: HUMAN_TASK,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="issue-dispatch-notification-create-task"]')
      await control.command('waitFor', scoped('[data-testid="ai-chat-modal"]'), {
        timeoutMs: uiTimeoutMs,
      })
      const taskPanel = scoped('[data-testid="work-item-new-task-chat-panel"]')
      const taskComposer = `${taskPanel} [data-testid="chat-message-input"]`
      await control.command('waitFor', taskComposer, { timeoutMs: uiTimeoutMs })
      assert.match(
        await control.command('getValue', taskComposer),
        new RegExp(MARKER),
        '通知创建的个人 Task 没有带入负责人分配的 instructions'
      )
      await selectE2EModel(control, MODEL, MODEL_LABEL, taskPanel)
      await captureScreenshot(control, 'human-round-03-personal-task-created.png', CONTENT)
      await control.command('press', taskComposer, { key: 'Enter' })

      const binding = await waitForValue(
        () => request(`/api/v1/loop-items/${rootIssue.id}/tasks`),
        values =>
          values.find(
            value => value.human_assignment_id === humanAssignment.payload.humanAssignmentId
          ),
        '点击通知并发送个人 Task 后，没有创建 human assignment 绑定',
        modelResponseTimeoutMs
      )
      assert.equal(binding.assignment_id, HUMAN_ASSIGNMENT_ID)
      assert.equal(binding.task_title, HUMAN_TASK)
      await waitForPromise(
        humanCompleted,
        modelResponseTimeoutMs,
        '个人 Runtime Task 没有通过真实 wework_space Delivery 完成交付'
      )
      await control.command(
        'waitFor',
        scoped('[data-testid="ai-chat-modal"] [data-testid="message-assistant"]'),
        {
          text: HUMAN_DELIVERY_COMPLETION,
          timeoutMs: modelResponseTimeoutMs,
        }
      )
      const delivery = await waitForValue(
        () => request(`/api/v1/loop-items/${rootIssue.id}/deliveries`),
        value =>
          value.items?.find(
            item =>
              item.status === 'delivered' &&
              item.source_task_snapshot?.humanAssignmentId ===
                humanAssignment.payload.humanAssignmentId
          ),
        '个人 Runtime Task 的 Delivery 没有绑定 humanAssignmentId',
        modelResponseTimeoutMs
      )
      assert.equal(delivery.source_task_snapshot.assignmentId, HUMAN_ASSIGNMENT_ID)

      await waitForPromise(
        managerResumed,
        modelResponseTimeoutMs,
        '人工 Delivery 后，Executor 没有越过整轮 barrier 并启动新的负责人运行'
      )
      await waitForValue(
        () => request(`/api/v1/loop-items/${rootIssue.id}`),
        value => value?.status === 'in_review',
        '新负责人运行没有显式更新根 Issue 状态',
        modelResponseTimeoutMs
      )
      assert.equal(managerRuns, 2, '整轮完成后没有且仅有一个新的负责人运行')
      assert.equal(managerStage, 'complete')
      await control.command('waitFor', scoped('[data-testid="cloud-task-activity-list"]'), {
        text: '负责人已综合智能体证据和人工交付，将 Issue 提交待确认。',
        timeoutMs: modelResponseTimeoutMs,
      })
      await captureScreenshot(control, 'human-round-04-fresh-manager-completed.png', CONTENT)
    },

    diagnostics() {
      return {
        aiRequestCount,
        humanAssignmentId: humanAssignment?.payload?.humanAssignmentId ?? null,
        humanDeliveryId: humanDelivery?.id ?? null,
        managerRuns,
        managerStage,
        projectId: project?.id,
        rootIssueId: rootIssue?.id,
      }
    },
  }
}
