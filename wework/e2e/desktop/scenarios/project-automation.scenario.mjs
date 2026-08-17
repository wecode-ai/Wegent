import assert from 'node:assert/strict'

import {
  CHECKPOINT_TASK_COMPLETION_TEXT,
  CHECKPOINT_TASK_PROMPT,
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_LABEL,
  selectE2EModel,
  withTimeout,
} from '../modules/shared.mjs'
import {
  assistantMessage,
  createSse,
  functionCall,
  namespacedFunctionCall,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
  selectMcpTool,
  selectToolSearch,
  streamingTextEvents,
  toolSearchResponseEvents,
} from '../modules/response-protocol.mjs'

const PROJECT_ID = '700000000000000001'
const AGENT_ID = 'agent-project-automation'
const RULE_ID = 'automation-rule-1'
const MODEL_NAME = 'gpt-5-codex'
const CLOUD_DEVICE_ID = 'wework-e2e-cloud-device'
const CLOUD_MODEL_NAME = 'desktop-e2e-public-model'
const PROJECT_CHAT_REMOTE_MODEL_NAME = 'desktop-e2e-project-chat-remote'
const PROJECT_CHAT_REMOTE_MODEL_LABEL = 'Project Chat Remote Codex'
const TEAM_ID = 88001

const PROJECT = {
  id: PROJECT_ID,
  public_id: 'e2e-project-automation',
  project_key: 'AUTO',
  name: '自动化验收项目',
  description: 'Wework 项目自动化桌面验收',
  created_by_user_id: 9001,
  status: 'active',
  task_provider: 'local',
  access_role: 'Owner',
  version: 1,
  created_at: '2026-08-11T00:00:00',
  updated_at: '2026-08-11T00:00:00',
}

const AGENT = {
  id: AGENT_ID,
  projectId: PROJECT_ID,
  name: 'Bug 修复机器人',
  runtime: 'codex',
  model: null,
  systemPrompt: '',
  capabilityDescription: '定位并修复可复现的软件缺陷',
  executionEnvironment: 'local',
  executionDeviceId: 'desktop-e2e-local-device',
  executionMode: 'auto',
  visibility: 'creator_admin',
  localProjectId: null,
  createdByUserId: 9001,
  createdByUserName: 'E2E Owner',
  status: 'active',
  version: 1,
  createdAt: '2026-08-11T00:00:00',
  updatedAt: '2026-08-11T00:00:00',
}

const TEAM = {
  id: TEAM_ID,
  name: 'board-review-team',
  displayName: '看板评审智能体',
  namespace: 'default',
  is_active: true,
  bots: [],
}

const MODEL = {
  name: MODEL_NAME,
  type: 'runtime',
  displayName: 'GPT-5 Codex',
  provider: 'openai',
  modelId: 'gpt-5-codex',
  namespace: 'default',
  config: {
    protocol: 'openai-responses',
    apiFormat: 'responses',
  },
  runtime: { family: 'openai.openai-responses' },
  isActive: true,
}

const LOCAL_CODEX_MODEL = {
  name: `codex-${DEFAULT_MODEL_ID}`,
  type: 'runtime',
  displayName: `${DEFAULT_MODEL_LABEL} (Codex)`,
  provider: 'openai',
  modelId: DEFAULT_MODEL_ID,
  namespace: 'default',
  config: {
    protocol: 'openai-responses',
    apiFormat: 'responses',
    weworkModelKind: 'codex-official',
    ui: { family: 'codex-official', modelLabel: DEFAULT_MODEL_LABEL },
  },
  runtime: { family: 'openai.openai-responses' },
  isActive: true,
}

const PROJECT_CHAT_REMOTE_MODEL = {
  name: PROJECT_CHAT_REMOTE_MODEL_NAME,
  type: 'public',
  displayName: PROJECT_CHAT_REMOTE_MODEL_LABEL,
  provider: 'openai',
  modelId: 'desktop-e2e-project-chat-remote-upstream',
  namespace: 'default',
  resourceUserId: 0,
  config: {
    protocol: 'openai-responses',
    apiFormat: 'responses',
    ui: { family: 'gpt', modelLabel: PROJECT_CHAT_REMOTE_MODEL_LABEL },
  },
  runtime: { family: 'openai.openai-responses' },
  isActive: true,
}

const RULE = {
  id: RULE_ID,
  projectId: PROJECT_ID,
  name: '每天扫描 Bug',
  prompt: '扫描当前项目中的可复现 Bug。',
  triggerType: 'schedule',
  eventType: null,
  eventConfig: {},
  assignmentMode: 'manual',
  managerType: null,
  webhookEventId: null,
  webhookSecret: null,
  cronExpression: '0 3 * * *',
  timezone: 'Asia/Shanghai',
  agentId: AGENT_ID,
  wegentTeamId: null,
  model: null,
  agentName: AGENT.name,
  executionEnvironment: 'local',
  executionDeviceId: AGENT.executionDeviceId,
  enabled: true,
  nextRunAt: '2026-08-12T19:00:00',
  lastRunAt: null,
  lastRunStatus: null,
  version: 1,
  createdAt: '2026-08-11T00:00:00',
  updatedAt: '2026-08-11T00:00:00',
}

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

function createHistoricalRuns() {
  return Array.from({ length: 8 }, (_, index) => ({
    id: `automation-run-history-${index + 1}`,
    automationId: 'automation-rule-created',
    projectId: PROJECT_ID,
    trigger: 'schedule',
    status: 'succeeded',
    scheduledFor: `2026-08-${String(10 - index).padStart(2, '0')}T09:00:00`,
    expiresAt: null,
    taskId: `AUTO-${100 - index}`,
    taskTitle: `历史自动化任务 ${index + 1}`,
    deviceId: AGENT.executionDeviceId,
    error: null,
    createdAt: `2026-08-${String(10 - index).padStart(2, '0')}T09:00:00`,
    updatedAt: `2026-08-${String(10 - index).padStart(2, '0')}T09:01:00`,
    retryable: false,
  }))
}

async function readJson(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

async function requestJson(baseUrl, authToken, pathname, options = {}) {
  const { useApiKey = false, ...fetchOptions } = options
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...fetchOptions,
    headers: {
      ...(useApiKey ? { 'X-API-Key': authToken } : { Authorization: `Bearer ${authToken}` }),
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

async function waitForValue(read, predicate, message, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let value
  while (Date.now() < deadline) {
    value = await read()
    if (predicate(value)) return value
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  assert.fail(`${message}; last value: ${JSON.stringify(value)}`)
}

function assertExecutionTruthContract(execution) {
  assert.equal(execution.runtimeTaskId, `codex-queue-${execution.id}`)
  assert.ok(execution.attemptNo >= 1)
  assert.ok(execution.lastEventSeq >= 0)
  if (
    !['completed', 'failed', 'cancelled'].includes(execution.status) &&
    ['stale', 'diverged'].includes(execution.syncState)
  ) {
    assert.equal(execution.displayState, 'unknown')
    return
  }
  if (execution.status === 'claimed') {
    assert.equal(
      execution.displayState,
      execution.observedState === 'unconfirmed' ? 'starting' : 'waiting_runtime'
    )
    return
  }
  const expectedDisplayState = {
    pending_approval: 'waiting_approval',
    queued: 'queued',
    running: 'running',
    cancel_requested: 'cancelling',
    completed: 'succeeded',
    failed: 'failed',
    cancelled: 'cancelled',
  }[execution.status]
  assert.equal(execution.displayState, expectedDisplayState)
  if (execution.status === 'running') {
    assert.equal(execution.observedState, 'running')
    assert.ok(execution.lastEventSeq > 0)
  }
  if (execution.status === 'completed') {
    assert.equal(execution.observedState, 'succeeded')
    assert.ok(execution.lastEventSeq > 0)
  }
}

export function createDesktopScenario({ captureScreenshot, uiTimeoutMs }) {
  const rules = [RULE]
  const runs = [
    {
      id: 'automation-run-failed',
      automationId: 'automation-rule-created',
      projectId: PROJECT_ID,
      trigger: 'schedule',
      status: 'failed',
      scheduledFor: '2026-08-11T09:00:00',
      expiresAt: null,
      taskId: 'AUTO-101',
      taskTitle: '待恢复的失败任务',
      deviceId: AGENT.executionDeviceId,
      error: 'The worker stopped after recording the execution result.',
      createdAt: '2026-08-11T09:00:00',
      updatedAt: '2026-08-11T09:01:00',
      retryable: true,
    },
    ...createHistoricalRuns(),
  ]
  const createdPayloads = []
  let archivedAgentPayload = null
  let cancelRequested = false
  let retryRequested = false
  let modelRequests = 0
  const remoteProjectChatRequests = []
  let boardTeamAssignmentPayload = null
  let createdBoardItem = null
  let cloudApi = null
  let cloudProject = null
  let cloudAgent = null
  let wegentAgent = null
  let cloudTeam = null
  let personalApiKey = null
  let managerToolCalls = 0

  const cloudRequest = (pathname, options) => {
    assert.ok(cloudApi, 'Real cloud API was not prepared')
    return requestJson(cloudApi.backendUrl, cloudApi.authToken, pathname, options)
  }

  const publicApiRequest = (pathname, options) => {
    assert.ok(personalApiKey, 'Personal API key was not prepared')
    return requestJson(cloudApi.backendUrl, personalApiKey, pathname, {
      ...options,
      useApiKey: true,
    })
  }

  async function allExecutions(projectId) {
    const responses = await Promise.all(
      [null, 'completed', 'failed', 'cancelled'].map(status =>
        cloudRequest(
          `/api/v1/cloud-projects/${projectId}/executions${status ? `?status=${status}` : ''}`
        )
      )
    )
    return [
      ...new Map(
        responses.flatMap(response => response.items ?? []).map(item => [item.id, item])
      ).values(),
    ]
  }

  async function waitForCompletedExecution(projectId, taskId, executorType) {
    const execution = await waitForValue(
      () => allExecutions(projectId),
      items =>
        items.find(
          item =>
            item.loopItemId === taskId &&
            item.executorType === executorType &&
            item.status === 'completed'
        ),
      `${executorType} execution for ${taskId} did not reach completed`,
      uiTimeoutMs * 3
    ).then(items =>
      items.find(
        item =>
          item.loopItemId === taskId &&
          item.executorType === executorType &&
          item.status === 'completed'
      )
    )
    assert.equal(execution.observedState, 'succeeded')
    assert.equal(execution.displayState, 'succeeded')
    assert.equal(execution.syncState, 'in_sync')
    return execution
  }

  async function waitForSucceededRun(projectId, ruleId, taskId = null) {
    return waitForValue(
      () => cloudRequest(`/api/v1/cloud-projects/${projectId}/automations/${ruleId}/runs`),
      items =>
        items.find(
          item => item.status === 'succeeded' && (taskId === null || item.taskId === taskId)
        ),
      `Automation ${ruleId} did not reach succeeded${taskId ? ` for ${taskId}` : ''}`,
      uiTimeoutMs * 3
    ).then(items =>
      items.find(item => item.status === 'succeeded' && (taskId === null || item.taskId === taskId))
    )
  }

  async function disableRule(projectId, rule) {
    const rules = await cloudRequest(`/api/v1/cloud-projects/${projectId}/automations`)
    const current = rules.find(item => item.id === rule.id)
    assert.ok(current, `Automation ${rule.id} disappeared before disable`)
    return cloudRequest(`/api/v1/cloud-projects/${projectId}/automations/${rule.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ version: current.version, enabled: false }),
    })
  }

  async function verifyRealCloud(control) {
    assert.ok(cloudProject?.id, 'Real cloud project fixture is missing')
    const projectId = String(cloudProject.id)
    const teamResponse = await cloudRequest('/api/teams?page=1&limit=100')
    const boardTeam = (teamResponse.items ?? []).find(
      team => Number(team.id) === Number(cloudTeam?.id)
    )
    assert.ok(boardTeam?.id, 'Real backend has no runnable Wegent Team fixture')
    await waitForValue(
      () => cloudRequest('/api/devices'),
      response =>
        response.items?.some(
          device => device.device_id === CLOUD_DEVICE_ID && device.status === 'online'
        ),
      'Cloud execution device did not register before project automation verification',
      uiTimeoutMs
    )
    cloudAgent = await cloudRequest(`/api/v1/cloud-projects/${projectId}/chat-agents`, {
      method: 'POST',
      body: JSON.stringify({
        name: AGENT.name,
        runtime: 'codex',
        model: CLOUD_MODEL_NAME,
        systemPrompt: '',
        capabilityDescription: AGENT.capabilityDescription,
        visibility: 'creator_admin',
        executionEnvironment: 'cloud',
        executionMode: 'auto',
        executionDeviceId: CLOUD_DEVICE_ID,
        localProjectId: null,
      }),
    })
    wegentAgent = await cloudRequest(`/api/v1/cloud-projects/${projectId}/chat-agents`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'Wegent Runtime Robot',
        runtime: 'wegent',
        wegentTeamId: Number(boardTeam.id),
        systemPrompt: '',
        capabilityDescription: 'Execute through the bound Wegent Agent.',
        visibility: 'creator_admin',
        executionMode: 'auto',
      }),
    })
    assert.equal(wegentAgent.runtime, 'wegent')
    assert.equal(Number(wegentAgent.wegentTeamId), Number(boardTeam.id))
    assert.equal(
      cloudAgent.executionDeviceId,
      CLOUD_DEVICE_ID,
      'Cloud robot response lost its persisted execution device'
    )

    await control.command('waitFor', '[data-testid="workspace-tab-add"]', {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('click', '[data-testid="workspace-tab-add"]')
    await control.command('waitFor', '[data-testid="workspace-tab-add-menu"]', {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('click', '[data-testid="workspace-tab-add-board"]')
    await control.command('waitFor', '[data-testid="cloud-todo-workspace"]', {
      timeoutMs: uiTimeoutMs,
    })
    const activeBoard = '[data-workspace-tab-content][aria-hidden="false"]'
    const projectSelector = `${activeBoard} [data-testid="cloud-sidebar-project-${projectId}"]`
    await control.command('waitFor', projectSelector, { timeoutMs: uiTimeoutMs })
    await control.command('click', projectSelector)
    await control.command('waitFor', `${activeBoard} [data-testid="cloud-todo-add"]`, {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('click', `${activeBoard} [data-testid="cloud-todo-add"]`)
    await control.command('waitFor', `${activeBoard} [data-testid="workspace-issue-input"]`, {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('fill', `${activeBoard} [data-testid="workspace-issue-input"]`, {
      value: '真实后端智能体看板任务',
    })
    await control.command('click', `${activeBoard} [data-testid="workspace-issue-submit"]`)
    await control.command('waitFor', `${activeBoard} [data-testid="cloud-todo-detail-title"]`, {
      timeoutMs: uiTimeoutMs,
    })
    const assigneeSelector = `${activeBoard} [data-testid="cloud-todo-detail-assignee"]`
    await control.command('waitFor', assigneeSelector, {
      text: wegentAgent.name,
      timeoutMs: uiTimeoutMs,
    })
    await control.command('fill', assigneeSelector, {
      value: `agent:${wegentAgent.id}`,
    })
    assert.equal(await control.command('getValue', assigneeSelector), `agent:${wegentAgent.id}`)
    await control.command('clickWhenEnabled', `${activeBoard} [data-testid="cloud-todo-save"]`, {
      timeoutMs: uiTimeoutMs,
    })
    const teamTask = await waitForValue(
      () => cloudRequest(`/api/v1/cloud-projects/${projectId}/loop-items`),
      response =>
        (response.items ?? []).find(
          item =>
            item.title === '真实后端智能体看板任务' && item.assignee_agent_id === wegentAgent.id
        ),
      'Board task was not assigned to the Wegent-runtime robot by the real backend',
      uiTimeoutMs
    ).then(response => response.items.find(item => item.title === '真实后端智能体看板任务'))
    const teamExecution = await waitForCompletedExecution(projectId, teamTask.id, 'project_robot')
    assert.equal(teamExecution.executorType, 'project_robot')
    assert.equal(teamExecution.agentId, wegentAgent.id)
    assert.equal(Number(teamExecution.teamId), Number(boardTeam.id))
    assert.ok(teamExecution.backendTaskId > 0)
    const projectedTeamTask = await waitForValue(
      () => cloudRequest(`/api/v1/cloud-projects/${projectId}/loop-items`),
      response =>
        (response.items ?? []).find(item => item.id === teamTask.id)?.ai_state
          ?.project_chat_message_id,
      'The completed Wegent execution did not project its board message identity',
      uiTimeoutMs
    ).then(response => response.items.find(item => item.id === teamTask.id))
    const rootMessageId = projectedTeamTask.ai_state.project_chat_message_id
    await control.command('waitFor', `[data-testid="cloud-todo-detail"]`, {
      text: wegentAgent.name,
      timeoutMs: uiTimeoutMs,
    })
    await control.command(
      'waitFor',
      `[data-testid="cloud-task-activity-message-${rootMessageId}"]`,
      { text: wegentAgent.name, timeoutMs: uiTimeoutMs }
    )
    const replyComposer = `[data-testid="cloud-task-activity-card-composer-${rootMessageId}"]`
    await control.command('fill', replyComposer, { value: '确认继续执行' })
    await control.command('press', replyComposer, { key: 'Enter' })
    const continuedTask = await waitForValue(
      () => cloudRequest(`/api/tasks/${teamExecution.backendTaskId}`),
      task => (task.subtasks ?? []).some(subtask => subtask.prompt === '确认继续执行'),
      'The board reply did not append a user turn to the native Wegent Task',
      uiTimeoutMs * 3
    )
    assert.equal(continuedTask.id, teamExecution.backendTaskId)
    const agentExecutionBadgeSelector = '[data-testid^="cloud-task-activity-execution-badge-"]'
    await waitForValue(
      () => control.command('getElementCount', agentExecutionBadgeSelector),
      count => Number(count) === 2,
      'The native Wegent continuation was not projected as a second agent comment',
      uiTimeoutMs * 3
    )
    const unchangedExecution = await waitForCompletedExecution(
      projectId,
      teamTask.id,
      'project_robot'
    )
    assert.equal(unchangedExecution.id, teamExecution.id)
    assert.equal(unchangedExecution.backendTaskId, teamExecution.backendTaskId)
    await captureScreenshot(control, 'project-automation-board-team-continuation.png')
    await captureScreenshot(control, 'project-automation-board-team-real.png')
    await control.command('waitFor', '[data-testid="cloud-project-automation-view"]', {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('click', '[data-testid="cloud-project-automation-view"]')
    await control.command('waitFor', '[data-testid="project-automation-rules"]', {
      timeoutMs: uiTimeoutMs,
    })

    await control.command('click', '[data-testid="project-automation-create"]')
    await control.command('fill', '[data-testid="project-automation-name"]', {
      value: '凌晨回归扫描',
    })
    await control.command('fill', '[data-testid="project-automation-prompt"]', {
      value: '扫描回归 Bug，并为每个 Bug 创建独立修复任务。',
    })
    await control.command('click', '[data-testid="project-automation-agent"]')
    await control.command(
      'click',
      `[data-testid="project-automation-agent-option-${cloudAgent.id}"]`
    )
    await captureScreenshot(control, 'project-automation-00-create-dialog.png')
    await control.command('click', '[data-testid="project-automation-save"]')
    const manualRule = await waitForValue(
      () => cloudRequest(`/api/v1/cloud-projects/${projectId}/automations`),
      items => items.find(item => item.name === '凌晨回归扫描'),
      'Manual project automation was not persisted by the real backend',
      uiTimeoutMs
    ).then(items => items.find(item => item.name === '凌晨回归扫描'))
    assert.equal(manualRule.assignmentMode, 'manual')
    assert.equal(manualRule.agentId, cloudAgent.id)
    assert.equal(manualRule.executionDeviceId, CLOUD_DEVICE_ID)
    const manualRuleSelector = `[data-testid="project-automation-rule-${manualRule.id}"]`
    await control.command('waitFor', manualRuleSelector, { timeoutMs: uiTimeoutMs })
    await captureScreenshot(control, 'project-automation-01-created-rule.png')

    await control.command('click', '[data-testid="project-automation-create"]')
    await control.command('fill', '[data-testid="project-automation-name"]', {
      value: '新任务 AI 分配',
    })
    await control.command('click', '[data-testid="project-automation-executor-type"]')
    await control.command(
      'click',
      '[data-testid="project-automation-executor-type-option-ai_managed"]'
    )
    await control.command('waitFor', '[data-testid="project-automation-manager-type"]', {
      timeoutMs: uiTimeoutMs,
    })
    await captureScreenshot(control, 'project-automation-02-ai-managed-dialog.png')
    await control.command('click', '[data-testid="project-automation-save"]')
    const managedRule = await waitForValue(
      () => cloudRequest(`/api/v1/cloud-projects/${projectId}/automations`),
      items => items.find(item => item.name === '新任务 AI 分配'),
      'AI-managed project automation was not persisted by the real backend',
      uiTimeoutMs
    ).then(items => items.find(item => item.name === '新任务 AI 分配'))
    assert.equal(managedRule.assignmentMode, 'ai_managed')
    assert.equal(managedRule.managerType, 'custom')
    assert.equal(managedRule.agentId, null)
    assert.ok(managedRule.model, 'AI-managed automation must persist a model')
    assert.ok(
      managedRule.executionDeviceId,
      'AI-managed automation must persist an execution device'
    )
    await control.command('waitFor', `[data-testid="project-automation-rule-${managedRule.id}"]`, {
      timeoutMs: uiTimeoutMs,
    })

    await control.command('click', manualRuleSelector)
    await control.command('waitFor', '[data-testid="project-automation-run-now"]', {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('click', '[data-testid="project-automation-run-now"]')
    const runs = await waitForValue(
      () => cloudRequest(`/api/v1/cloud-projects/${projectId}/automations/${manualRule.id}/runs`),
      items => items.length > 0 && Boolean(items[0].taskId),
      'Manual automation did not create a durable task through the real backend',
      uiTimeoutMs
    )
    assert.ok(
      ['queued', 'waiting_device', 'running', 'succeeded'].includes(runs[0].status),
      `Manual automation entered an unexpected state: ${runs[0].status}`
    )
    const execution = await waitForValue(
      async () => {
        const responses = await Promise.all(
          [null, 'completed', 'failed', 'cancelled'].map(status =>
            cloudRequest(
              `/api/v1/cloud-projects/${projectId}/executions${status ? `?status=${status}` : ''}`
            )
          )
        )
        return responses
          .flatMap(response => response.items ?? [])
          .filter(item => item.loopItemId === runs[0].taskId)
          .sort((left, right) => right.id - left.id)[0]
      },
      value => Boolean(value),
      'Manual automation did not expose authoritative execution truth',
      uiTimeoutMs
    )
    assertExecutionTruthContract(execution)
    await control.command('waitFor', `[data-testid="project-automation-run-task-${runs[0].id}"]`, {
      timeoutMs: uiTimeoutMs,
    })
    await captureScreenshot(control, 'project-automation-03-real-run.png')

    await control.command('click', '[data-testid="cloud-todo-modal-close"]', { visible: true })
    await control.command('click', '[data-testid="cloud-project-automation-view"]', {
      visible: true,
    })
    await control.command('waitFor', '[data-testid="cloud-project-chat-agents"]', {
      timeoutMs: uiTimeoutMs,
      visible: true,
    })
    await control.command('click', `[data-testid="cloud-project-chat-agent-${cloudAgent.id}"]`, {
      visible: true,
    })
    assert.equal(
      await control.command('getValue', '[data-testid="cloud-project-chat-agent-capability"]', {
        visible: true,
      }),
      AGENT.capabilityDescription
    )
    assert.equal(
      await control.command(
        'getAttribute',
        '[data-testid="cloud-project-chat-agent-device"] [data-selection-state]',
        { value: 'data-selection-state', visible: true }
      ),
      'selected'
    )
    const concurrencySelector = '[data-testid="cloud-project-chat-agent-max-concurrent-executions"]'
    assert.equal(
      await control.command('getValue', concurrencySelector, { visible: true }),
      '1',
      'Robot concurrency did not default to one'
    )
    await control.command('fill', concurrencySelector, { value: '2', visible: true })
    await control.command('click', '[data-testid="cloud-project-chat-agent-save"]', {
      visible: true,
    })
    const updatedAgents = await waitForValue(
      () => cloudRequest(`/api/v1/cloud-projects/${projectId}/chat-agents`),
      items => items.some(item => item.id === cloudAgent.id && item.maxConcurrentExecutions === 2),
      'Robot concurrency was not persisted by the real backend',
      uiTimeoutMs
    )
    cloudAgent = updatedAgents.find(item => item.id === cloudAgent.id)
    await captureScreenshot(control, 'project-automation-04-real-robot-binding.png')
    await verifyPublicApiAutomationMatrix(control)
  }

  async function verifyPublicApiAutomationMatrix(control) {
    const projectId = String(cloudProject.id)
    const createTask = (title, values = {}) =>
      publicApiRequest(`/api/v1/cloud-projects/${projectId}/loop-items`, {
        method: 'POST',
        body: JSON.stringify({
          title,
          description: `${title} must complete through the real automation runtime.`,
          priority: 'high',
          tags: ['api-e2e'],
          ...values,
        }),
      })
    const createRule = values =>
      cloudRequest(`/api/v1/cloud-projects/${projectId}/automations`, {
        method: 'POST',
        body: JSON.stringify(values),
      })

    const directTeamTask = await createTask('API · Wegent runtime 机器人执行', {
      assignee_agent_id: wegentAgent.id,
    })
    assert.equal(directTeamTask.assignee_agent_id, wegentAgent.id)
    const directTeamExecution = await waitForCompletedExecution(
      projectId,
      directTeamTask.id,
      'project_robot'
    )
    assert.equal(directTeamExecution.agentId, wegentAgent.id)
    assert.equal(Number(directTeamExecution.teamId), Number(cloudTeam.id))
    assert.ok(directTeamExecution.backendTaskId > 0)

    const manualEventRule = await createRule({
      name: 'API task.created · manual robot',
      prompt: 'Complete the API-created board task.',
      triggerType: 'event',
      eventType: 'task.created',
      eventConfig: { tags: ['api-e2e'] },
      assignmentMode: 'manual',
      agentId: cloudAgent.id,
      enabled: true,
    })
    const manualEventTask = await createTask('API · task.created 手动机器人')
    const manualEventRun = await waitForSucceededRun(
      projectId,
      manualEventRule.id,
      manualEventTask.id
    )
    const manualEventExecution = await waitForCompletedExecution(
      projectId,
      manualEventTask.id,
      'project_robot'
    )
    assert.equal(manualEventExecution.automationRunId, manualEventRun.id)
    await disableRule(projectId, manualEventRule)

    const customManagerRule = await createRule({
      name: 'API task.created · custom manager',
      prompt: 'Use the board assignment tool to choose the configured project robot.',
      triggerType: 'event',
      eventType: 'task.created',
      eventConfig: { tags: ['api-e2e'] },
      assignmentMode: 'ai_managed',
      managerType: 'custom',
      model: CLOUD_MODEL_NAME,
      executionEnvironment: 'cloud',
      executionDeviceId: CLOUD_DEVICE_ID,
      enabled: true,
    })
    const customToolCallsBefore = managerToolCalls
    const customManagerTask = await createTask('API · task.created 自定义 AI 调度')
    const customManagerRun = await waitForSucceededRun(
      projectId,
      customManagerRule.id,
      customManagerTask.id
    )
    const customManagerExecution = await waitForCompletedExecution(
      projectId,
      customManagerTask.id,
      'automation_manager'
    )
    const customRobotExecution = await waitForCompletedExecution(
      projectId,
      customManagerTask.id,
      'project_robot'
    )
    assert.equal(customManagerExecution.automationRunId, customManagerRun.id)
    assert.equal(customRobotExecution.automationRunId, customManagerRun.id)
    assert.ok(
      managerToolCalls > customToolCallsBefore,
      'Custom AI manager did not call assign_board_item'
    )
    const readyCountBeforeBoardReload = control.readyCount
    await control.command('reloadMainWindow', 'body')
    await withTimeout(
      control.awaitReadyAfter(readyCountBeforeBoardReload),
      uiTimeoutMs * 3,
      'The redesigned project board did not reconnect after loading API-created issues'
    )
    const activeBoard = '[data-workspace-tab-content][aria-hidden="false"]'
    await control.command('waitFor', `${activeBoard} [data-testid="cloud-project-board-view"]`, {
      timeoutMs: uiTimeoutMs,
      visible: true,
    })
    await control.command('click', `${activeBoard} [data-testid="cloud-project-board-view"]`, {
      visible: true,
    })
    const taskSearchToggle = `${activeBoard} [data-testid="cloud-project-task-search-toggle"]`
    await control.command('waitFor', taskSearchToggle, {
      timeoutMs: uiTimeoutMs,
      visible: true,
    })
    await control.command('click', taskSearchToggle, { visible: true })
    await control.command(
      'fill',
      `${activeBoard} [data-testid="cloud-project-task-search-input"]`,
      {
        value: customManagerTask.id,
        visible: true,
      }
    )
    const customManagerTaskResult = `${activeBoard} [data-testid="cloud-task-search-result-${customManagerTask.id}"]`
    await control.command('waitFor', customManagerTaskResult, {
      text: customManagerTask.title,
      timeoutMs: uiTimeoutMs,
      visible: true,
    })
    await control.command('click', customManagerTaskResult, { visible: true })
    await control.command('waitFor', `${activeBoard} [data-testid="cloud-todo-detail"]`, {
      text: customManagerTask.title,
      timeoutMs: uiTimeoutMs,
      visible: true,
    })
    const customManagerCard = `${activeBoard} [data-executor-type="automation_manager"][data-manager-type="custom"]`
    await control.command('waitFor', customManagerCard, {
      text: '自定义 AI 调度员',
      timeoutMs: uiTimeoutMs,
    })
    await control.command('scrollIntoView', customManagerCard)
    await control.command('waitFor', customManagerCard, {
      text: '自定义 AI 调度员',
      timeoutMs: uiTimeoutMs,
      visible: true,
    })
    const managerReplyComposer = `${customManagerCard} [data-testid^="cloud-task-activity-card-composer-"]`
    await control.command('fill', managerReplyComposer, {
      value: '请确认当前分派结果',
      visible: true,
    })
    await control.command('press', managerReplyComposer, {
      key: 'Enter',
      visible: true,
    })
    await waitForValue(
      () => control.command('getText', customManagerCard),
      text =>
        text.includes('请确认当前分派结果') &&
        text.split('已通过看板工具完成机器人分派。').length >= 3 &&
        text.split('自定义 AI 调度员').length >= 3,
      'The custom manager did not append a distinct reply to its comment thread',
      uiTimeoutMs * 3
    )
    await control.command('scrollIntoView', customManagerCard)
    const managerExecutionsAfterReply = await allExecutions(projectId)
    assert.equal(
      managerExecutionsAfterReply.filter(
        execution =>
          execution.loopItemId === customManagerTask.id &&
          execution.executorType === 'automation_manager'
      ).length,
      1,
      'Manager conversation created a second board execution'
    )
    await captureScreenshot(control, 'project-automation-custom-manager-continuation.png')
    await disableRule(projectId, customManagerRule)

    const wegentManagerRule = await createRule({
      name: 'API task.created · Wegent manager',
      prompt: 'Use the board assignment tool to choose the configured project robot.',
      triggerType: 'event',
      eventType: 'task.created',
      eventConfig: { tags: ['api-e2e'] },
      assignmentMode: 'ai_managed',
      managerType: 'wegent',
      wegentTeamId: Number(cloudTeam.id),
      enabled: true,
    })
    const wegentToolCallsBefore = managerToolCalls
    const wegentManagerTask = await createTask('API · task.created Wegent 智能体调度')
    const wegentManagerRun = await waitForSucceededRun(
      projectId,
      wegentManagerRule.id,
      wegentManagerTask.id
    )
    assert.ok(wegentManagerRun.backendTaskId > 0, 'Wegent manager did not persist its Backend Task')
    const wegentRobotExecution = await waitForCompletedExecution(
      projectId,
      wegentManagerTask.id,
      'project_robot'
    )
    assert.equal(wegentRobotExecution.automationRunId, wegentManagerRun.id)
    assert.ok(
      managerToolCalls > wegentToolCallsBefore,
      'Wegent manager did not call assign_board_item'
    )
    await disableRule(projectId, wegentManagerRule)

    const scheduleRule = await createRule({
      name: 'API schedule · manual robot',
      prompt: 'Complete the scheduled board task.',
      triggerType: 'schedule',
      cronExpression: '0 3 * * *',
      timezone: 'Asia/Shanghai',
      assignmentMode: 'manual',
      agentId: cloudAgent.id,
      enabled: true,
    })
    const queuedScheduleRun = await cloudRequest(
      `/api/v1/cloud-projects/${projectId}/automations/${scheduleRule.id}/run`,
      { method: 'POST' }
    )
    assert.ok(queuedScheduleRun.taskId, 'Run-now did not create its board task')
    const scheduleRun = await waitForSucceededRun(
      projectId,
      scheduleRule.id,
      queuedScheduleRun.taskId
    )
    const scheduleExecution = await waitForCompletedExecution(
      projectId,
      scheduleRun.taskId,
      'project_robot'
    )
    assert.equal(scheduleExecution.automationRunId, scheduleRun.id)

    const boardItems = await cloudRequest(`/api/v1/cloud-projects/${projectId}/loop-items`)
    for (const task of [directTeamTask, manualEventTask, customManagerTask, wegentManagerTask]) {
      assert.ok(
        boardItems.items.some(item => item.id === task.id),
        `API-created task ${task.id} was not projected back to the board`
      )
    }
    await captureScreenshot(control, 'project-automation-05-public-api-matrix.png')
  }

  return {
    async prepareCloud({ authToken, backendUrl }) {
      cloudApi = { authToken, backendUrl }
      const createdKey = await requestJson(backendUrl, authToken, '/api/api-keys', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Project automation public API E2E',
          description: 'Creates a board and tasks through the public API contract',
        }),
      })
      personalApiKey = createdKey.key
      assert.match(personalApiKey, /^wg-/, 'Personal API key did not use the public key format')
      cloudProject = await requestJson(backendUrl, personalApiKey, '/api/v1/cloud-projects', {
        method: 'POST',
        useApiKey: true,
        body: JSON.stringify({
          project_key: 'AUTO',
          name: PROJECT.name,
          description: PROJECT.description,
          task_provider: 'local',
          provider_config: {},
          visibility: 'private',
        }),
      })
      assert.ok(cloudProject?.id, 'Real cloud project fixture did not return an id')
      const bot = await requestJson(backendUrl, authToken, '/api/bots', {
        method: 'POST',
        body: JSON.stringify({
          name: `project-automation-e2e-bot-${process.pid}`,
          shell_name: 'Chat',
          agent_config: {
            bind_model: CLOUD_MODEL_NAME,
            bind_model_type: 'public',
          },
          system_prompt: 'Complete the assigned board task and report success.',
          namespace: 'default',
        }),
      })
      cloudTeam = await requestJson(backendUrl, authToken, '/api/teams', {
        method: 'POST',
        body: JSON.stringify({
          name: `project-automation-e2e-team-${process.pid}`,
          displayName: 'Project Automation E2E Team',
          description: 'Deterministic real-backend automation team',
          bots: [
            {
              bot_id: bot.id,
              role: 'leader',
              bot_prompt: '',
              requireConfirmation: false,
              contextPassing: 'none',
            },
          ],
          workflow: { mode: 'solo' },
          bind_mode: ['wework'],
          namespace: 'default',
          is_active: true,
        }),
      })
      assert.ok(cloudTeam?.id, 'Real cloud Team fixture did not return an id')
    },

    async handleHttp(request, response, url) {
      if (request.method === 'POST' && url.pathname === '/v1/responses' && cloudApi) {
        const payload = await readJson(request)
        const responseId = `project-automation-real-${Date.now()}`
        const serialized = JSON.stringify(payload)
        const writeEvents = events => {
          response.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          })
          response.end(createSse(events))
        }
        if (serialized.includes('"request_kind":"prewarm"')) {
          writeEvents([responseCreated(responseId), responseCompleted(responseId)])
          return true
        }
        const isManagerRequest = serialized.includes(
          '请读取候选执行者并按调度要求完成分派，不要执行任务。'
        )
        if (isManagerRequest) {
          assert.ok(cloudAgent?.id, 'AI manager ran before the project robot was prepared')
          const assignment = {
            assignee_type: 'agent',
            assignee_id: cloudAgent.id,
          }
          const searchCallId = 'project-automation-search-assignee'
          const assignCallId = 'project-automation-assign-board-item'
          if (requestContainsToolOutput(payload, assignCallId)) {
            writeEvents([
              responseCreated(responseId),
              assistantMessage('已通过看板工具完成机器人分派。'),
              responseCompleted(responseId),
            ])
            return true
          }
          if (requestContainsToolOutput(payload, searchCallId)) {
            const tool = selectMcpTool(payload, 'wework_space', 'assign_board_item', assignment)
            managerToolCalls += 1
            writeEvents([
              responseCreated(responseId),
              ...namespacedFunctionCall(assignCallId, tool.namespace, tool.name, tool.arguments),
              responseCompleted(responseId),
            ])
            return true
          }
          const namespace = payload.tools?.find(
            tool =>
              tool?.type === 'namespace' &&
              tool.name === 'wework_space' &&
              tool.tools?.some(candidate => candidate?.name === 'assign_board_item')
          )
          const convertedName = payload.tools
            ?.map(tool => tool?.name ?? tool?.function?.name)
            .find(
              name =>
                name === 'assign_board_item' ||
                name?.endsWith('_assign_board_item') ||
                name === 'assign_task' ||
                name?.endsWith('_assign_task')
            )
          if (namespace) {
            managerToolCalls += 1
            writeEvents([
              responseCreated(responseId),
              ...namespacedFunctionCall(
                assignCallId,
                namespace.name,
                'assign_board_item',
                assignment
              ),
              responseCompleted(responseId),
            ])
            return true
          }
          if (convertedName) {
            let convertedArguments = assignment
            if (convertedName.endsWith('assign_task')) {
              const taskId = serialized.match(/AUTO-\d+/g)?.at(-1)
              assert.ok(taskId, 'Chat manager request did not retain its board task id')
              convertedArguments = {
                project_id: String(cloudProject.id),
                task_id: taskId,
                ...assignment,
              }
            }
            managerToolCalls += 1
            writeEvents([
              responseCreated(responseId),
              ...functionCall(assignCallId, convertedName, convertedArguments),
              responseCompleted(responseId),
            ])
            return true
          }
          const search = selectToolSearch(payload, 'assign_board_item')
          writeEvents([
            responseCreated(responseId),
            ...toolSearchResponseEvents(searchCallId, search),
            responseCompleted(responseId),
          ])
          return true
        }
        writeEvents([
          responseCreated(responseId),
          assistantMessage('真实自动化执行已完成。'),
          responseCompleted(responseId),
        ])
        return true
      }
      if (request.method === 'GET' && url.pathname === '/api/v1/cloud-projects') {
        json(response, 200, { items: [PROJECT] })
        return true
      }
      if (
        request.method === 'GET' &&
        url.pathname === `/api/v1/cloud-projects/${PROJECT_ID}/loop-items`
      ) {
        json(response, 200, { items: createdBoardItem ? [createdBoardItem] : [] })
        return true
      }
      if (
        request.method === 'POST' &&
        url.pathname === `/api/v1/cloud-projects/${PROJECT_ID}/loop-items`
      ) {
        const payload = await readJson(request)
        createdBoardItem = {
          id: 'AUTO-201',
          cloud_project_id: PROJECT_ID,
          sequence_number: 201,
          parent_id: null,
          created_by_user_id: 9001,
          assignee_user_id: 9001,
          assignee_agent_id: null,
          assignee_team_id: null,
          title: payload.title,
          description: payload.description ?? '',
          status: payload.status ?? 'inbox',
          priority: payload.priority ?? 'none',
          due_at: null,
          tags: payload.tags ?? [],
          sort_order: 0,
          current_delivery_id: null,
          version: 1,
          created_at: '2026-08-15T00:00:00Z',
          updated_at: '2026-08-15T00:00:00Z',
          completed_at: null,
        }
        json(response, 201, createdBoardItem)
        return true
      }
      if (request.method === 'PATCH' && url.pathname === '/api/v1/loop-items/AUTO-201') {
        const payload = await readJson(request)
        createdBoardItem = {
          ...createdBoardItem,
          ...payload,
          version: createdBoardItem.version + 1,
          updated_at: '2026-08-15T00:01:00Z',
        }
        json(response, 200, createdBoardItem)
        return true
      }
      if (
        request.method === 'POST' &&
        url.pathname === `/api/v1/cloud-projects/${PROJECT_ID}/loop-items/AUTO-201/assign`
      ) {
        boardTeamAssignmentPayload = await readJson(request)
        createdBoardItem = {
          ...createdBoardItem,
          assignee_user_id: null,
          assignee_team_id: TEAM_ID,
          assignee_team_name: TEAM.displayName,
          execution_state: 'queued',
          execution_control_state: 'queued',
          version: createdBoardItem.version + 1,
        }
        json(response, 200, createdBoardItem)
        return true
      }
      if (
        request.method === 'GET' &&
        url.pathname === `/api/v1/cloud-projects/${PROJECT_ID}/chat-agents`
      ) {
        json(response, 200, [AGENT])
        return true
      }
      if (
        request.method === 'PATCH' &&
        url.pathname === `/api/v1/cloud-projects/${PROJECT_ID}/chat-agents/${AGENT_ID}`
      ) {
        archivedAgentPayload = await readJson(request)
        json(response, 200, { ...AGENT, ...archivedAgentPayload, version: AGENT.version + 1 })
        return true
      }
      if (request.method === 'GET' && url.pathname === '/api/models/unified') {
        modelRequests += 1
        json(response, 200, { data: [LOCAL_CODEX_MODEL, PROJECT_CHAT_REMOTE_MODEL, MODEL] })
        return true
      }
      if (
        request.method === 'POST' &&
        url.pathname === '/api/runtime-work/llm-responses-proxy/responses'
      ) {
        const payload = await readJson(request)
        remoteProjectChatRequests.push(payload)
        assert.equal(request.headers['x-wegent-model-type'], 'public')
        assert.equal(request.headers['x-wegent-model-namespace'], 'default')
        assert.equal(request.headers['x-wegent-model-user-id'], '0')
        assert.equal(payload.model, PROJECT_CHAT_REMOTE_MODEL_NAME)
        assert.ok(
          JSON.stringify(payload).includes(CHECKPOINT_TASK_PROMPT),
          'The remote project-chat request lost the user prompt'
        )
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        const stream = streamingTextEvents('project-chat-remote', CHECKPOINT_TASK_COMPLETION_TEXT)
        response.end(createSse([...stream.start, ...stream.finish]))
        return true
      }
      if (request.method === 'GET' && url.pathname === '/api/teams') {
        json(response, 200, { items: [TEAM], total: 1 })
        return true
      }
      if (
        request.method === 'GET' &&
        url.pathname === `/api/v1/cloud-projects/${PROJECT_ID}/automations`
      ) {
        json(response, 200, rules)
        return true
      }
      if (
        request.method === 'POST' &&
        url.pathname === `/api/v1/cloud-projects/${PROJECT_ID}/automations`
      ) {
        const createdPayload = await readJson(request)
        createdPayloads.push(createdPayload)
        const created = {
          ...RULE,
          id:
            createdPayload.assignmentMode === 'ai_managed'
              ? 'automation-rule-managed'
              : 'automation-rule-created',
          ...createdPayload,
          agentName: AGENT.name,
          executionEnvironment: AGENT.executionEnvironment,
          executionDeviceId: AGENT.executionDeviceId,
          nextRunAt: '2026-08-12T19:00:00',
          lastRunAt: null,
          lastRunStatus: null,
        }
        rules.push(created)
        json(response, 201, created)
        return true
      }
      const runsMatch = url.pathname.match(
        new RegExp(`^/api/v1/cloud-projects/${PROJECT_ID}/automations/([^/]+)/runs$`)
      )
      if (request.method === 'GET' && runsMatch) {
        json(
          response,
          200,
          runs.filter(run => run.automationId === runsMatch[1])
        )
        return true
      }
      const runNowMatch = url.pathname.match(
        new RegExp(`^/api/v1/cloud-projects/${PROJECT_ID}/automations/([^/]+)/run$`)
      )
      if (request.method === 'POST' && runNowMatch) {
        const run = {
          id: 'automation-run-queued',
          automationId: runNowMatch[1],
          projectId: PROJECT_ID,
          trigger: 'manual',
          status: 'queued',
          scheduledFor: '2026-08-11T10:00:00',
          expiresAt: null,
          taskId: null,
          deviceId: AGENT.executionDeviceId,
          error: null,
          createdAt: '2026-08-11T10:00:00',
          updatedAt: '2026-08-11T10:00:00',
        }
        runs.unshift(run)
        json(response, 200, run)
        return true
      }
      if (
        request.method === 'POST' &&
        url.pathname ===
          `/api/v1/cloud-projects/${PROJECT_ID}/automation-runs/automation-run-queued/cancel`
      ) {
        cancelRequested = true
        runs[0] = { ...runs[0], status: 'cancelled' }
        json(response, 200, runs[0])
        return true
      }
      const retryMatch = url.pathname.match(
        new RegExp(`^/api/v1/cloud-projects/${PROJECT_ID}/automation-runs/([^/]+)/retry$`)
      )
      if (request.method === 'POST' && retryMatch) {
        const failedRun = runs.find(run => run.id === retryMatch[1])
        assert.equal(failedRun?.status, 'failed')
        retryRequested = true
        const retriedRun = {
          ...failedRun,
          status: 'queued',
          error: null,
          updatedAt: '2026-08-11T10:02:00',
          retryable: false,
        }
        runs.splice(runs.indexOf(failedRun), 1, retriedRun)
        json(response, 200, retriedRun)
        return true
      }
      if (
        request.method === 'GET' &&
        url.pathname.startsWith(`/api/v1/cloud-projects/${PROJECT_ID}/executions`)
      ) {
        json(response, 200, { items: [] })
        return true
      }
      if (request.method === 'GET' && url.pathname === '/api/devices') {
        json(response, 200, {
          items: [
            {
              device_id: 'local-device',
              device_name: 'E2E Mac',
              device_type: 'local',
              status: 'offline',
              executor_version: 'e2e',
              capabilities: [],
            },
          ],
        })
        return true
      }
      return false
    },

    async verify(control) {
      if (cloudApi) {
        await verifyRealCloud(control)
        return
      }
      await control.command('waitFor', '[data-testid="workspace-tab-add"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-add"]')
      await control.command('waitFor', '[data-testid="workspace-tab-add-menu"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-add-board"]')
      await control.command('waitFor', '[data-testid="cloud-todo-workspace"]', {
        timeoutMs: uiTimeoutMs,
      })
      const activeBoard = '[data-workspace-tab-content][aria-hidden="false"]'
      await control.command('click', `${activeBoard} [data-testid="cloud-project-settings"]`)
      await control.command('waitFor', `${activeBoard} [data-testid="project-space-settings"]`, {
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      await control.command('waitFor', `${activeBoard} [data-testid="project-space-api-wiki"]`, {
        text: 'POST /api/v1/cloud-projects',
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      await control.command(
        'waitFor',
        `${activeBoard} [data-testid="project-space-device-concurrency"]`,
        {
          timeoutMs: uiTimeoutMs,
          visible: true,
        }
      )
      const projectSelector = `${activeBoard} [data-testid="cloud-sidebar-project-${PROJECT_ID}"]`
      await control.command('waitFor', projectSelector, { timeoutMs: uiTimeoutMs })
      await control.command('click', projectSelector)
      await control.command('waitFor', `${activeBoard} [data-testid="cloud-todo-add"]`, {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', `${activeBoard} [data-testid="cloud-todo-add"]`)
      await control.command('waitFor', `${activeBoard} [data-testid="workspace-issue-input"]`, {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('fill', `${activeBoard} [data-testid="workspace-issue-input"]`, {
        value: '由智能体评审看板状态',
      })
      await control.command('click', `${activeBoard} [data-testid="workspace-issue-submit"]`)
      await control.command('waitFor', `${activeBoard} [data-testid="cloud-todo-detail-title"]`, {
        timeoutMs: uiTimeoutMs,
      })
      const assigneeSelector = `${activeBoard} [data-testid="cloud-todo-detail-assignee"]`
      await control.command('waitFor', assigneeSelector, {
        text: TEAM.displayName,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('fill', assigneeSelector, {
        value: `team:${TEAM_ID}`,
      })
      assert.equal(await control.command('getValue', assigneeSelector), `team:${TEAM_ID}`)
      await control.command('clickWhenEnabled', `${activeBoard} [data-testid="cloud-todo-save"]`, {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', `${activeBoard} [data-testid="cloud-todo-card-AUTO-201"]`, {
        text: TEAM.displayName,
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(boardTeamAssignmentPayload?.assigneeType, 'team')
      assert.equal(boardTeamAssignmentPayload?.assigneeId, String(TEAM_ID))
      await captureScreenshot(control, 'project-automation-board-team-assignment.png')
      await control.command('waitFor', '[data-testid="cloud-project-ask-ai"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="cloud-project-ask-ai"]')
      await control.command('waitFor', '[data-testid="project-space-chat-panel"]', {
        timeoutMs: uiTimeoutMs,
      })

      const projectChatInput =
        '[data-testid="project-space-chat-panel"] [data-testid="chat-message-input"]'
      const projectChatPanel = '[data-testid="project-space-chat-panel"]'
      await selectE2EModel(
        control,
        PROJECT_CHAT_REMOTE_MODEL_NAME,
        PROJECT_CHAT_REMOTE_MODEL_LABEL,
        projectChatPanel
      )
      const remoteRequestCount = remoteProjectChatRequests.length
      await control.command('fill', projectChatInput, { value: CHECKPOINT_TASK_PROMPT })
      await control.command('press', projectChatInput, { key: 'Enter' })
      await waitForValue(
        () => Promise.resolve(remoteProjectChatRequests.length),
        count => count === remoteRequestCount + 1,
        'The Backend remote model did not receive the project-chat request',
        uiTimeoutMs
      )
      await control.command('waitFor', '[data-testid="project-space-chat-panel"]', {
        text: CHECKPOINT_TASK_COMPLETION_TEXT,
        timeoutMs: uiTimeoutMs,
      })

      await control.command('click', '[data-testid="project-space-chat-new"]')
      await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL, projectChatPanel)
      control.setScenario('checkpoint_task')
      const localRequest = control.awaitScenarioRequest('checkpoint_task')
      await control.command('fill', projectChatInput, { value: CHECKPOINT_TASK_PROMPT })
      await control.command('press', projectChatInput, { key: 'Enter' })
      const localModelRequest = await withTimeout(
        localRequest,
        uiTimeoutMs,
        'The local Codex model did not receive the project-chat request'
      )
      assert.ok(
        typeof localModelRequest.body.model === 'string' && localModelRequest.body.model.length > 0,
        'Project chat did not execute through the local Codex model server'
      )
      await control.command('waitFor', '[data-testid="project-space-chat-panel"]', {
        text: CHECKPOINT_TASK_COMPLETION_TEXT,
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(control, 'project-chat-model-routing.png')
      await control.command('click', '[data-testid="project-space-chat-close"]')

      await control.command('waitFor', '[data-testid="cloud-project-automation-view"]', {
        timeoutMs: uiTimeoutMs,
      })
      const modelDeadline = Date.now() + uiTimeoutMs
      while (modelRequests === 0 && Date.now() < modelDeadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
      }
      assert.ok(modelRequests >= 1, 'cloud model catalog did not load before the automation view')
      await control.command('click', '[data-testid="cloud-project-automation-view"]')
      await control.command('waitFor', '[data-testid="project-automation-view"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="project-automation-rules"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="project-automation-create"]')
      await control.command('fill', '[data-testid="project-automation-name"]', {
        value: '凌晨回归扫描',
      })
      await control.command('fill', '[data-testid="project-automation-prompt"]', {
        value: '扫描回归 Bug，并为每个 Bug 创建独立修复任务。',
      })
      await control.command('click', '[data-testid="project-automation-agent"]')
      await control.command('click', `[data-testid="project-automation-agent-option-${AGENT_ID}"]`)
      await captureScreenshot(control, 'project-automation-00-create-dialog.png')
      await control.command('click', '[data-testid="project-automation-save"]')
      await control.command(
        'waitFor',
        '[data-testid="project-automation-rule-automation-rule-created"]',
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      assert.equal(createdPayloads[0]?.name, '凌晨回归扫描')
      assert.equal(createdPayloads[0]?.assignmentMode, 'manual')
      assert.equal(createdPayloads[0]?.managerType, null)
      assert.equal(createdPayloads[0]?.agentId, AGENT_ID)
      await control.command(
        'click',
        '[data-testid="project-automation-rule-automation-rule-created"]'
      )
      await control.command('waitFor', '[data-testid="project-automation-run-list"]', {
        timeoutMs: uiTimeoutMs,
      })
      const runListSelector = '[data-testid="project-automation-run-list"]'
      const [runListMetrics] = JSON.parse(
        await control.command('getElementMetrics', runListSelector)
      )
      assert.ok(
        runListMetrics.scrollHeight > runListMetrics.clientHeight,
        'Long automation run history did not become scrollable'
      )
      await control.command(
        'scrollIntoView',
        '[data-testid="project-automation-run-task-automation-run-history-8"]'
      )
      const [scrolledRunListMetrics] = JSON.parse(
        await control.command('getElementMetrics', runListSelector)
      )
      assert.ok(scrolledRunListMetrics.scrollTop > 0, 'Automation run history did not scroll')
      await captureScreenshot(control, 'project-automation-01-created-rule.png')
      await control.command('click', '[data-testid="cloud-todo-modal-close"]')

      await control.command('click', '[data-testid="project-automation-create"]')
      await control.command('fill', '[data-testid="project-automation-name"]', {
        value: '新任务 AI 分配',
      })
      await control.command('click', '[data-testid="project-automation-executor-type"]')
      await control.command(
        'click',
        '[data-testid="project-automation-executor-type-option-ai_managed"]'
      )
      await control.command('waitFor', '[data-testid="project-automation-manager-type"]', {
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(control, 'project-automation-02-ai-managed-dialog.png')
      await control.command('click', '[data-testid="project-automation-save"]')
      await control.command(
        'waitFor',
        '[data-testid="project-automation-rule-automation-rule-managed"]',
        { timeoutMs: uiTimeoutMs }
      )
      assert.equal(createdPayloads[1]?.assignmentMode, 'ai_managed')
      assert.equal(createdPayloads[1]?.managerType, 'custom')
      assert.equal(createdPayloads[1]?.agentId, null)
      assert.ok(createdPayloads[1]?.model, 'AI-managed automation must select a model')
      assert.equal(createdPayloads[1]?.executionDeviceId, 'local-device')

      await control.command(
        'click',
        '[data-testid="project-automation-rule-automation-rule-created"]'
      )
      await control.command('waitFor', '[data-testid="project-automation-run-now"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="project-automation-run-now"]')
      await control.command(
        'waitFor',
        '[data-testid="project-automation-cancel-run-automation-run-queued"]',
        { timeoutMs: uiTimeoutMs }
      )
      await control.command(
        'click',
        '[data-testid="project-automation-cancel-run-automation-run-queued"]'
      )
      const cancelDeadline = Date.now() + uiTimeoutMs
      while (!cancelRequested && Date.now() < cancelDeadline) {
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      assert.equal(cancelRequested, true)
      await captureScreenshot(control, 'project-automation-03-cancelled-run.png')
      await control.command(
        'waitFor',
        '[data-testid="project-automation-retry-run-automation-run-failed"]',
        { timeoutMs: uiTimeoutMs }
      )
      await control.command(
        'click',
        '[data-testid="project-automation-retry-run-automation-run-failed"]'
      )
      await control.command(
        'waitFor',
        '[data-testid="project-automation-cancel-run-automation-run-failed"]',
        { timeoutMs: uiTimeoutMs }
      )
      assert.equal(retryRequested, true)
      await captureScreenshot(control, 'project-automation-04-retried-run.png')
      await control.command('click', '[data-testid="cloud-todo-modal-close"]', { visible: true })
      await control.command('click', '[data-testid="cloud-project-automation-view"]', {
        visible: true,
      })
      await control.command('waitFor', '[data-testid="cloud-project-chat-agents"]', {
        timeoutMs: uiTimeoutMs,
        visible: true,
      })

      await control.command('scrollIntoView', '[data-testid="cloud-project-chat-agent-add"]')
      await control.command('click', '[data-testid="cloud-project-chat-agent-add"]', {
        visible: true,
      })
      await control.command('waitFor', '[data-testid="cloud-project-chat-agent-model"]', {
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      await control.command('waitFor', '[data-testid="cloud-project-chat-agent-runtime-group"]', {
        text: '运行环境',
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      await control.command('waitFor', '[data-testid="cloud-project-chat-agent-execution-group"]', {
        text: '执行策略',
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      await control.command('waitFor', '[data-testid="cloud-project-chat-agent-access-group"]', {
        text: '访问权限',
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      assert.equal(
        await control.command(
          'getAttribute',
          '[data-testid="cloud-project-chat-agent-environment"] [data-selection-state]',
          { value: 'data-selection-state', visible: true }
        ),
        'selected'
      )
      assert.equal(
        await control.command(
          'getAttribute',
          '[data-testid="cloud-project-chat-agent-model"] [data-selection-state]',
          { value: 'data-selection-state', visible: true }
        ),
        'unselected'
      )
      assert.equal(
        await control.command(
          'getAttribute',
          '[data-testid="cloud-project-chat-agent-device"] [data-selection-state]',
          { value: 'data-selection-state', visible: true }
        ),
        'unselected'
      )
      assert.equal(
        await control.command(
          'getAttribute',
          '[data-testid="cloud-project-chat-agent-execution-project"] [data-selection-state]',
          { value: 'data-selection-state', visible: true }
        ),
        'unselected'
      )
      await control.command('click', '[data-testid="cloud-project-chat-agent-model"]', {
        visible: true,
      })
      await control.command('waitFor', '[data-testid="cloud-project-chat-agent-model-menu"]', {
        text: 'GPT-5 Codex',
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      await control.command('click', '[data-testid="cloud-project-chat-agent-model"]', {
        visible: true,
      })
      await control.command('fill', '[data-testid="cloud-project-chat-agent-name"]', {
        value: '回归巡检机器人',
        visible: true,
      })
      await control.command('click', '[data-testid="cloud-project-chat-agent-device"]', {
        visible: true,
      })
      await control.command('waitFor', '[data-testid="cloud-project-chat-agent-device-menu"]', {
        text: 'local-device',
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      await control.command(
        'click',
        '[data-testid="cloud-project-chat-agent-device-option-local-device"]',
        { visible: true }
      )
      const saveWithoutModel = await control.command(
        'getAttribute',
        '[data-testid="cloud-project-chat-agent-save"]',
        { value: 'disabled', visible: true }
      )
      assert.equal(saveWithoutModel, '', 'save must allow validation while no model is selected')
      await control.command('click', '[data-testid="cloud-project-chat-agent-save"]', {
        visible: true,
      })
      assert.equal(
        await control.command('getAttribute', '[data-testid="cloud-project-chat-agent-model"]', {
          value: 'aria-invalid',
          visible: true,
        }),
        'true'
      )
      await captureScreenshot(control, 'project-automation-05-robot-model-required.png')

      await control.command('click', '[data-testid="cloud-project-chat-agent-cancel"]', {
        visible: true,
      })
      await control.command('click', `[data-testid="cloud-project-chat-agent-${AGENT_ID}"]`, {
        visible: true,
      })
      const configuredCapability = await control.command(
        'getValue',
        '[data-testid="cloud-project-chat-agent-capability"]',
        { visible: true }
      )
      assert.equal(configuredCapability, AGENT.capabilityDescription)
      await captureScreenshot(control, 'project-automation-06-robot-capability.png')

      await control.command('click', '[data-testid="cloud-project-chat-agent-cancel"]', {
        visible: true,
      })
      await control.command(
        'click',
        `[data-testid="cloud-project-chat-agent-remove-${AGENT_ID}"]`,
        { visible: true }
      )
      await control.command('waitFor', '[data-testid="project-chat-agent-template-development"]', {
        stableMs: 100,
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      assert.equal(archivedAgentPayload?.status, 'archived')
      await captureScreenshot(control, 'project-automation-07-robot-templates.png')
      await control.command('click', '[data-testid="project-chat-agent-template-development"]', {
        visible: true,
      })
      const templateName = await control.command(
        'getValue',
        '[data-testid="cloud-project-chat-agent-name"]',
        { visible: true }
      )
      const templateCapability = await control.command(
        'getValue',
        '[data-testid="cloud-project-chat-agent-capability"]',
        { visible: true }
      )
      const templatePrompt = await control.command(
        'getValue',
        '[data-testid="cloud-project-chat-agent-system-prompt"]',
        { visible: true }
      )
      assert.equal(templateName, '开发实现机器人')
      assert.equal(templateCapability, '编写代码、修复问题并完成必要验证')
      assert.match(templatePrompt ?? '', /完成被指派的开发任务/)
      await captureScreenshot(control, 'project-automation-08-robot-template-dialog.png')
    },

    diagnostics() {
      return {
        archivedAgentPayload,
        cancelRequested,
        createdPayloads,
        modelRequests,
        retryRequested,
        boardTeamAssignmentPayload,
        managerToolCalls,
        rules,
        runs,
      }
    },
  }
}
