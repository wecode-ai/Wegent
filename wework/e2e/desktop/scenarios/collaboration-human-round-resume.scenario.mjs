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
import { isCollaborationSubagentRequest } from '../modules/subagent-request.mjs'
import { selectCollaborationDomain, waitForTestIdByText } from '../modules/workspace-flows.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const MODEL = 'desktop-e2e-cloud-responses'
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
const CALLS = {
  context: `${MARKER}-context`,
  candidates: `${MARKER}-candidates`,
  createHuman: `${MARKER}-create-human`,
  assignHuman: `${MARKER}-assign-human`,
  registerRound: `${MARKER}-register-round`,
  spawnAgent: `${MARKER}-spawn-agent`,
  waitAgent: `${MARKER}-wait-agent`,
  updateStatus: `${MARKER}-update-status`,
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

function findToolOutput(value, callId) {
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const found = findToolOutput(candidate, callId)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (!value || typeof value !== 'object') return undefined
  if (
    ['function_call_output', 'mcp_tool_call_output', 'custom_tool_call_output'].includes(
      value.type
    ) &&
    value.call_id === callId
  ) {
    if (typeof value.output !== 'string') return value.output
    try {
      return JSON.parse(value.output)
    } catch {
      return value.output
    }
  }
  for (const candidate of Object.values(value)) {
    const found = findToolOutput(candidate, callId)
    if (found !== undefined) return found
  }
  return undefined
}

function contextFromOutput(value) {
  if (typeof value === 'string') {
    try {
      return contextFromOutput(JSON.parse(value))
    } catch {
      return null
    }
  }
  if (!value || typeof value !== 'object') return null
  const spaceId = value.space_id ?? value.spaceId ?? value.space?.id ?? value.project?.id
  const itemId = value.item_id ?? value.itemId ?? value.item?.id
  if (spaceId && itemId) return { spaceId: String(spaceId), itemId: String(itemId) }
  for (const candidate of Object.values(value)) {
    const found = contextFromOutput(candidate)
    if (found) return found
  }
  return null
}

function projectToolEvents(body, { callId, searchCallId, toolName, argumentsValue }) {
  if (requestContainsToolOutput(body, searchCallId)) {
    const tool = selectMcpTool(body, 'wework_space', toolName, argumentsValue)
    return namespacedFunctionCall(callId, tool.namespace, tool.name, tool.arguments)
  }
  return mcpToolRequestEvents(body, {
    toolName,
    argumentsValue,
    searchCallId,
    toolCallId: callId,
  }).events
}

function collaborationToolEvents(body, { callId, searchCallId, toolName, argumentsValue }) {
  if (requestContainsToolOutput(body, searchCallId)) {
    const tool = selectMcpTool(body, 'collaboration', toolName, argumentsValue)
    return namespacedFunctionCall(callId, tool.namespace, tool.name, tool.arguments)
  }
  return mcpToolRequestEvents(body, {
    toolName,
    argumentsValue,
    searchCallId,
    toolCallId: callId,
  }).events
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
  return { workspace, project }
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
    value: '验证 AI 任务和人工任务并发完成后，由同一负责人继续评估。',
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
  const group = await waitForValue(
    () => request(`/api/v1/cloud-projects/${projectId}/collaboration-groups`),
    response => response.items?.find(value => value.name === GROUP),
    '端上创建人机协作小组未持久化',
    uiTimeoutMs
  )
  await control.command('click', scoped('[data-testid="collaboration-group-detail-tab-rules"]'))
  await control.command('fill', scoped('[data-testid="collaboration-group-detail-instructions"]'), {
    value: `${MARKER}：AI 与人工任务可并发；所有人工任务正式提交后，负责人继续评估。`,
  })
  await control.command(
    'clickWhenEnabled',
    scoped('[data-testid="collaboration-group-detail-save"]'),
    { timeoutMs: uiTimeoutMs }
  )
  return group
}

async function createAndAssignIssue(control, request, projectId, uiTimeoutMs) {
  await control.command('click', scoped('[data-testid="collaboration-tab-board"]'))
  await control.command('click', scoped('[data-testid="collaboration-issue-create"]'))
  await control.command('fill', scoped('[data-testid="cloud-todo-title"]'), { value: ISSUE })
  await control.command('fill', scoped('[data-testid="cloud-todo-detail-description"]'), {
    value: `${MARKER}。负责人必须并发分配一个 AI 任务和一个人工任务，等待人工正式提交后继续。`,
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

export function createDesktopScenario({
  captureScreenshot,
  modelResponseTimeoutMs,
  uiTimeoutMs,
  workbenchReadyTimeoutMs,
}) {
  let backendUrl = ''
  let authToken = ''
  let queryDatabase = null
  let owner = null
  let project = null
  let rootIssue = null
  let humanItemId = null
  let managerRuntimeTaskId = null
  let managerStage = 'initial'
  let managerContinuationCount = 0
  let aiRequestCount = 0
  let releaseAi
  let resolveHumanAssigned
  let resolveManagerInitialFinished
  let resolveManagerResumed
  const aiRelease = new Promise(resolve => {
    releaseAi = resolve
  })
  const humanAssigned = new Promise(resolve => {
    resolveHumanAssigned = resolve
  })
  const managerInitialFinished = new Promise(resolve => {
    resolveManagerInitialFinished = resolve
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
      queryDatabase = cloud.queryDatabase
      owner = await request('/api/users/me')
      await request('/api/admin/setup-complete', { method: 'POST' })
    },

    async handleHttp(requestMessage, response, url) {
      if (
        requestMessage.method !== 'POST' ||
        !['/responses', '/v1/responses'].includes(url.pathname)
      ) {
        return false
      }
      const body = await readRequestBody(requestMessage)
      const responseId = `human-round-${Date.now()}-${managerStage}-${aiRequestCount}`
      const kind = codexRequestKind(body)
      if (kind === 'prewarm' || kind === 'compaction') {
        writeEvents(response, responseId, [assistantMessage('Ready')])
        return true
      }
      if (isCollaborationSubagentRequest(requestMessage.headers)) {
        aiRequestCount += 1
        await aiRelease
        writeEvents(response, responseId, [
          assistantMessage(`${AI_TASK} 已完成：AI 证据已提交给负责人。`),
        ])
        return true
      }
      const serialized = JSON.stringify(body)
      if (!serialized.includes(MARKER) && !serialized.includes('全部人工任务已经提交')) {
        writeEvents(response, responseId, [])
        return true
      }

      const updateStatusArgs = {
        status: 'in_review',
        reason: 'AI 任务完成且人工成员已正式提交，本轮证据齐全。',
      }
      const roundArgs = {
        round_id: ROUND_ID,
        assignments: [
          {
            item_id: humanItemId,
            title: HUMAN_TASK,
            assignee_type: 'human',
            assignee_id: String(owner.id),
          },
        ],
      }
      const searchCalls = [
        [CALLS.context, 'get_current_context', {}, () => managerStage === 'reading-context'],
        [
          CALLS.candidates,
          'get_assignment_candidates',
          { space_id: String(project.id) },
          () => managerStage === 'reading-candidates',
        ],
        [
          CALLS.createHuman,
          'create_board_item',
          {
            space_id: String(project.id),
            item: {
              title: HUMAN_TASK,
              description: `${MARKER}。人工核对 AI 证据并提交摘要。`,
              parent_id: rootIssue.id,
              status: 'pending',
            },
          },
          () => managerStage === 'creating-human',
        ],
        [
          CALLS.assignHuman,
          'assign_board_item',
          {
            space_id: String(project.id),
            item_id: humanItemId,
            assignee_type: 'user',
            assignee_id: String(owner.id),
          },
          () => managerStage === 'assigning-human',
        ],
        [
          CALLS.registerRound,
          'register_coordination_round',
          roundArgs,
          () => managerStage === 'registering-round',
        ],
        [
          CALLS.updateStatus,
          'update_issue_status',
          updateStatusArgs,
          () => managerStage === 'resumed',
        ],
      ]
      for (const [callId, toolName, argumentsValue, isExpectedStage] of searchCalls) {
        if (
          isExpectedStage() &&
          !requestContainsToolOutput(body, callId) &&
          requestContainsToolOutput(body, `${callId}-search`)
        ) {
          writeEvents(
            response,
            responseId,
            projectToolEvents(body, {
              callId,
              searchCallId: `${callId}-search`,
              toolName,
              argumentsValue,
            })
          )
          return true
        }
      }
      if (requestContainsToolOutput(body, CALLS.updateStatus)) {
        managerStage = 'complete'
        writeEvents(response, responseId, [
          assistantMessage('负责人已在同一会话中评估本轮交付，并显式将 Issue 更新为待确认。'),
        ])
        return true
      }
      if (serialized.includes('全部人工任务已经提交')) {
        managerContinuationCount += 1
        assert.equal(managerStage, 'waiting-human', '人工提交前负责人状态不正确')
        managerStage = 'resumed'
        resolveManagerResumed()
        writeEvents(
          response,
          responseId,
          projectToolEvents(body, {
            callId: CALLS.updateStatus,
            searchCallId: `${CALLS.updateStatus}-search`,
            toolName: 'update_issue_status',
            argumentsValue: updateStatusArgs,
          })
        )
        return true
      }
      if (requestContainsToolOutput(body, CALLS.waitAgent)) {
        managerStage = 'waiting-human'
        resolveManagerInitialFinished()
        writeEvents(response, responseId, [
          assistantMessage('AI 任务已完成；人工任务尚未正式提交，负责人继续等待。'),
        ])
        return true
      }
      if (requestContainsToolOutput(body, CALLS.spawnAgent)) {
        managerStage = 'waiting-ai'
        writeEvents(
          response,
          responseId,
          collaborationToolEvents(body, {
            callId: CALLS.waitAgent,
            searchCallId: `${CALLS.waitAgent}-search`,
            toolName: 'wait_agent',
            argumentsValue: { timeout_ms: 60_000 },
          })
        )
        return true
      }
      if (requestContainsToolOutput(body, CALLS.registerRound)) {
        managerStage = 'spawning-ai'
        writeEvents(
          response,
          responseId,
          collaborationToolEvents(body, {
            callId: CALLS.spawnAgent,
            searchCallId: `${CALLS.spawnAgent}-search`,
            toolName: 'spawn_agent',
            argumentsValue: {
              task_name: 'collect_ai_evidence',
              message: `任务标题：${AI_TASK}\n${MARKER}。采集一份独立证据，不更新 Issue 状态。`,
              agent_type: 'wegent_member_1',
              fork_turns: 'none',
            },
          })
        )
        return true
      }
      if (requestContainsToolOutput(body, CALLS.assignHuman)) {
        managerStage = 'registering-round'
        resolveHumanAssigned(humanItemId)
        writeEvents(
          response,
          responseId,
          projectToolEvents(body, {
            callId: CALLS.registerRound,
            searchCallId: `${CALLS.registerRound}-search`,
            toolName: 'register_coordination_round',
            argumentsValue: roundArgs,
          })
        )
        return true
      }
      if (requestContainsToolOutput(body, CALLS.createHuman)) {
        const created = await waitForValue(
          async () => (await request(`/api/v1/cloud-projects/${project.id}/loop-items`)).items,
          values =>
            values.find(
              value =>
                value.title === HUMAN_TASK &&
                String(value.parent_id ?? value.parentId) === String(rootIssue.id)
            ),
          'create_board_item 已返回，但人工子任务没有持久化',
          uiTimeoutMs
        )
        humanItemId = String(created.id)
        managerStage = 'assigning-human'
        writeEvents(
          response,
          responseId,
          projectToolEvents(body, {
            callId: CALLS.assignHuman,
            searchCallId: `${CALLS.assignHuman}-search`,
            toolName: 'assign_board_item',
            argumentsValue: {
              space_id: String(project.id),
              item_id: humanItemId,
              assignee_type: 'user',
              assignee_id: String(owner.id),
            },
          })
        )
        return true
      }
      if (requestContainsToolOutput(body, CALLS.candidates)) {
        managerStage = 'creating-human'
        writeEvents(
          response,
          responseId,
          projectToolEvents(body, {
            callId: CALLS.createHuman,
            searchCallId: `${CALLS.createHuman}-search`,
            toolName: 'create_board_item',
            argumentsValue: {
              space_id: String(project.id),
              item: {
                title: HUMAN_TASK,
                description: `${MARKER}。人工核对 AI 证据并提交摘要。`,
                parent_id: rootIssue.id,
                status: 'pending',
              },
            },
          })
        )
        return true
      }
      if (requestContainsToolOutput(body, CALLS.context)) {
        const context = contextFromOutput(findToolOutput(body, CALLS.context))
        assert.equal(context?.itemId, rootIssue.id, '负责人上下文不是根 Issue')
        managerStage = 'reading-candidates'
        writeEvents(
          response,
          responseId,
          projectToolEvents(body, {
            callId: CALLS.candidates,
            searchCallId: `${CALLS.candidates}-search`,
            toolName: 'get_assignment_candidates',
            argumentsValue: { space_id: String(project.id) },
          })
        )
        return true
      }
      assert.equal(managerStage, 'initial', `Unexpected manager stage: ${managerStage}`)
      managerStage = 'reading-context'
      writeEvents(
        response,
        responseId,
        projectToolEvents(body, {
          callId: CALLS.context,
          searchCallId: `${CALLS.context}-search`,
          toolName: 'get_current_context',
          argumentsValue: {},
        })
      )
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
      await createAgent(
        control,
        request,
        project.id,
        MEMBER,
        `${MARKER}。你只完成负责人分配的 AI 子任务。`,
        uiTimeoutMs
      )
      await createGroup(control, request, project.id, owner.id, uiTimeoutMs)
      rootIssue = await createAndAssignIssue(control, request, project.id, uiTimeoutMs)

      await waitForPromise(humanAssigned, modelResponseTimeoutMs, '负责人没有创建并分配人工子任务')
      const humanItem = await request(`/api/v1/loop-items/${humanItemId}`)
      if (humanItem?.assignee_user_id !== owner.id || !humanItem?.human_work?.can_start) {
        const assignments = await request(`/api/v1/loop-items/${humanItemId}/assignments`)
        const projectState = await request(`/api/v1/cloud-projects/${project.id}`)
        const assignmentRows = await queryDatabase(
          `SELECT id,
                  JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.action')) AS action,
                  JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.assignment_event_id')) AS assignment_event_id,
                  JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.target_type')) AS target_type,
                  JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.target_id')) AS target_id,
                  JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.workflow_step')) AS workflow_step,
                  JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.trigger')) AS assignment_trigger
           FROM loop_items
           WHERE resource_type = 'comment' AND loop_item_id = %s
           ORDER BY created_at ASC, id ASC`,
          [humanItemId]
        )
        assert.fail(
          `人工子任务没有成为可接手的真实人工工作: ${JSON.stringify({
            humanItem,
            assignments,
            projectState,
            assignmentRows,
          })}`
        )
      }
      const executionRows = await waitForValue(
        () =>
          queryDatabase(
            `SELECT runtime_task_id, status FROM loop_item_executions
             WHERE loop_item_id = %s ORDER BY id ASC`,
            [rootIssue.id]
          ),
        rows => rows.length === 1 && rows[0].runtime_task_id && rows,
        '负责人没有唯一 Runtime Task',
        modelResponseTimeoutMs
      )
      managerRuntimeTaskId = executionRows[0].runtime_task_id
      await captureScreenshot(control, 'human-round-01-human-and-ai-assigned.png', CONTENT)

      releaseAi()
      await waitForPromise(
        managerInitialFinished,
        modelResponseTimeoutMs,
        'AI 子任务完成后负责人没有结束本轮等待'
      )
      await new Promise(resolve => setTimeout(resolve, 1_000))
      assert.equal(managerContinuationCount, 0, '只有 AI 完成时负责人被错误恢复')
      assert.equal(managerStage, 'waiting-human')
      await captureScreenshot(control, 'human-round-02-ai-finished-human-pending.png', CONTENT)

      await control.command('click', scoped('[data-testid="cloud-todo-detail-close"]'))
      const humanCard = scoped(`[data-testid="cloud-todo-card-${humanItemId}"]`)
      await control.command('waitFor', humanCard, { timeoutMs: uiTimeoutMs })
      await control.command('click', humanCard)
      await control.command('waitFor', scoped('[data-testid="human-issue-start"]'), {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', scoped('[data-testid="human-issue-start"]'))
      await control.command('waitFor', scoped('[data-testid="human-issue-submit"]'), {
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(control, 'human-round-03-human-started.png', CONTENT)
      await control.command('click', scoped('[data-testid="human-issue-submit"]'))
      await control.command('fill', scoped('[data-testid="human-issue-work-text"]'), {
        value: `${MARKER} 人工证据已核对，结果可供负责人继续评估。`,
      })
      await control.command('click', scoped('[data-testid="human-issue-work-confirm"]'))

      await waitForPromise(
        managerResumed,
        modelResponseTimeoutMs,
        '人工正式提交后，Backend 没有向 Executor 投递 human_submitted 事实并恢复负责人'
      )
      await waitForValue(
        () => request(`/api/v1/loop-items/${rootIssue.id}`),
        value => value?.status === 'in_review',
        '负责人恢复后没有显式更新根 Issue 状态',
        modelResponseTimeoutMs
      )
      const afterRows = await queryDatabase(
        `SELECT runtime_task_id, status FROM loop_item_executions
         WHERE loop_item_id = %s ORDER BY id ASC`,
        [rootIssue.id]
      )
      assert.equal(afterRows.length, 1, '人工提交后系统创建了第二个负责人执行')
      assert.equal(
        afterRows[0].runtime_task_id,
        managerRuntimeTaskId,
        '人工提交后没有恢复同一负责人 Runtime Task'
      )
      assert.equal(managerContinuationCount, 1)
      assert.equal(managerStage, 'complete')
      await captureScreenshot(control, 'human-round-04-same-manager-resumed.png', CONTENT)
    },

    diagnostics() {
      return {
        aiRequestCount,
        humanItemId,
        managerContinuationCount,
        managerRuntimeTaskId,
        managerStage,
        projectId: project?.id,
        rootIssueId: rootIssue?.id,
      }
    },
  }
}
