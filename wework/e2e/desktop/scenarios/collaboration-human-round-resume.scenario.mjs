import assert from 'node:assert/strict'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  assistantMessage,
  codexRequestKind,
  createSse,
  mcpToolRequestEvents,
  readRequestBody,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'
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
  plan: `${MARKER}-plan`,
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

function managerToolEvents(body, toolName, toolCallId, argumentsValue) {
  return mcpToolRequestEvents(body, {
    toolName,
    argumentsValue,
    searchCallId: `${toolCallId}-search`,
    toolCallId,
  })
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
  let owner = null
  let project = null
  let member = null
  let rootIssue = null
  let humanItemId = null
  let managerRuntimeTaskId = null
  let managerStage = 'initial'
  let managerContinuationCount = 0
  let managerContinuationObserved = false
  let aiRequestCount = 0
  let releaseAi
  let resolveAiStarted
  let resolveAiCompleted
  let resolveHumanAssigned
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
  const humanAssigned = new Promise(resolve => {
    resolveHumanAssigned = resolve
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

      if (serialized.includes(`${MARKER}。你只完成负责人分配的 AI 子任务。`)) {
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

      assert.ok(
        serialized.includes(`${MARKER}。你是负责人`),
        '协作调度请求既不是负责人运行，也不是执行成员运行'
      )
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
              assignment_id: `${MARKER}-human-assignment`,
              title: HUMAN_TASK,
              instructions: `${MARKER}。人工核对 AI 证据并提交摘要。`,
              assignee_type: 'human',
              assignee_id: String(owner.id),
            },
          ],
        },
      }
      const updateStatusArguments = {
        status: 'in_review',
        reason: 'AI 任务完成且人工成员已正式提交，本轮证据齐全。',
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
        const created = await waitForValue(
          async () => (await request(`/api/v1/cloud-projects/${project.id}/loop-items`)).items,
          values =>
            values.find(
              value =>
                value.title === HUMAN_TASK &&
                String(value.parent_id ?? value.parentId) === String(rootIssue.id)
            ),
          'submit_workflow_plan 已返回，但人工子任务没有持久化',
          uiTimeoutMs
        )
        humanItemId = String(created.id)
        managerStage = 'waiting-round'
        resolveHumanAssigned(humanItemId)
        writeEvents(response, responseId, [
          assistantMessage('本轮智能体任务和人工任务已交给 Executor，等待全部交付。'),
        ])
        return true
      }

      if (managerStage === 'initial') {
        assert.ok(
          serialized.includes('AI 与人工任务可并发；所有人工任务正式提交后，负责人继续评估。'),
          '项目协作规则没有作为负责人本轮用户消息的一部分传入'
        )
        const selection = managerToolEvents(body, 'submit_workflow_plan', CALLS.plan, planArguments)
        if (selection.mode === 'direct') managerStage = 'plan-called'
        writeEvents(response, responseId, selection.events)
        return true
      }

      if (managerStage === 'waiting-round') {
        assert.ok(
          serialized.includes(`${AI_TASK} 已完成：AI 证据已提交给负责人。`),
          'barrier 后恢复的负责人没有收到 AI 执行结果'
        )
        assert.ok(
          serialized.includes(`${MARKER} 人工证据已核对，结果可供负责人继续评估。`),
          'barrier 后恢复的负责人没有收到人工交付'
        )
        if (!managerContinuationObserved) {
          managerContinuationObserved = true
          managerContinuationCount = 1
          resolveManagerResumed()
        }
        const selection = managerToolEvents(
          body,
          'update_issue_status',
          CALLS.updateStatus,
          updateStatusArguments
        )
        if (selection.mode === 'direct') managerStage = 'updating-status'
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

      await waitForPromise(humanAssigned, modelResponseTimeoutMs, '负责人没有创建并分配人工子任务')
      await waitForPromise(aiStarted, modelResponseTimeoutMs, '负责人没有启动独立的 AI 执行任务')
      await control.command('waitFor', scoped('[data-testid="cloud-task-activity-list"]'), {
        text: AI_TASK,
        timeoutMs: modelResponseTimeoutMs,
      })
      await control.command('waitFor', scoped('[data-testid="cloud-task-activity-list"]'), {
        text: HUMAN_TASK,
        timeoutMs: modelResponseTimeoutMs,
      })
      const humanItem = await request(`/api/v1/loop-items/${humanItemId}`)
      if (humanItem?.assignee_user_id !== owner.id || !humanItem?.human_work?.can_start) {
        const assignments = await request(`/api/v1/loop-items/${humanItemId}/assignments`)
        const projectState = await request(`/api/v1/cloud-projects/${project.id}`)
        assert.fail(
          `人工子任务没有成为可接手的真实人工工作: ${JSON.stringify({
            humanItem,
            assignments,
            projectState,
          })}`
        )
      }
      const initialExecutions = await waitForValue(
        () => request(`/api/v1/cloud-projects/${project.id}/executions?include_terminal=true`),
        response => {
          const rows = response.items.filter(
            execution => String(execution.loopItemId) === String(rootIssue.id)
          )
          const manager = rows.find(
            execution => execution.executorType === 'collaboration_group_dispatch'
          )
          const agent = rows.find(
            execution =>
              execution.executorType !== 'collaboration_group_dispatch' &&
              execution.agentId === member.id
          )
          return manager?.runtimeTaskId && agent ? { agent, manager, rows } : false
        },
        'submit_workflow_plan 没有创建一个负责人调度和一个独立 AI execution',
        modelResponseTimeoutMs
      )
      managerRuntimeTaskId = initialExecutions.manager.runtimeTaskId
      assert.equal(initialExecutions.rows.length, 2, '混合轮次创建了冗余 execution')
      await captureScreenshot(control, 'human-round-01-human-and-ai-assigned.png', CONTENT)

      releaseAi()
      await waitForPromise(
        aiCompleted,
        modelResponseTimeoutMs,
        'AI 子任务没有通过独立 Executor execution 完成'
      )
      await new Promise(resolve => setTimeout(resolve, 1_000))
      assert.equal(managerContinuationCount, 0, '只有 AI 完成时负责人被错误恢复')
      assert.equal(managerStage, 'waiting-round')
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
        '人工正式提交后，Executor 没有越过整轮 barrier 并恢复负责人'
      )
      await waitForValue(
        () => request(`/api/v1/loop-items/${rootIssue.id}`),
        value => value?.status === 'in_review',
        '负责人恢复后没有显式更新根 Issue 状态',
        modelResponseTimeoutMs
      )
      const afterExecutions = await request(
        `/api/v1/cloud-projects/${project.id}/executions?include_terminal=true`
      )
      const afterRows = afterExecutions.items.filter(
        execution => String(execution.loopItemId) === String(rootIssue.id)
      )
      const managerRows = afterRows.filter(
        execution => execution.executorType === 'collaboration_group_dispatch'
      )
      assert.equal(managerRows.length, 1, '人工提交后系统创建了冗余负责人调度')
      assert.equal(
        managerRows[0].runtimeTaskId,
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
