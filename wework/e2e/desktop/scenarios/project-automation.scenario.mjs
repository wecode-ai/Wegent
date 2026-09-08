import assert from 'node:assert/strict'
import { join } from 'node:path'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'

import {
  AUTOMATION_SCHEDULE_TIMEOUT_MS,
  CHECKPOINT_TASK_COMPLETION_TEXT,
  CHECKPOINT_TASK_PROMPT,
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_LABEL,
  createSingleRootLocalProject,
  selectE2EModel,
  withTimeout,
} from '../modules/shared.mjs'
import {
  assistantMessage,
  createSse,
  mcpToolRequestEvents,
  namespacedFunctionCall,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
  selectMcpTool,
  streamingTextEvents,
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
const FIRST_CONTINUATION_PROMPT = '确认继续执行'
const QUEUED_CONTINUATION_PROMPT = '补充检查排队消息'
const MOONSHOT_OVERRIDE_ISSUE_TITLE = 'Issue 临时云端 Moonshot 覆盖本地 GPT'
const MOONSHOT_OVERRIDE_FOLLOW_UP =
  'WEWORK_PROJECT_AUTOMATION_MOONSHOT_FOLLOW_UP: verify immutable task model routing.'
const MOONSHOT_OVERRIDE_FOLLOW_UP_COMPLETION =
  'WEWORK_PROJECT_AUTOMATION_MOONSHOT_FOLLOW_UP_COMPLETE'
const CLOUD_MODEL_UPSTREAM_ID = 'desktop-e2e-public-upstream-model'

const PROJECT = {
  id: PROJECT_ID,
  public_id: 'e2e-project-automation',
  project_key: 'AUTO',
  name: '自动化验收项目',
  description: 'Wework 项目自动化桌面验收',
  project_store: 'backend',
  created_by_user_id: 9001,
  status: 'active',
  task_provider: 'local',
  access_role: 'Owner',
  version: 1,
  created_at: '2026-08-11T00:00:00',
  updated_at: '2026-08-11T00:00:00',
}

const PROJECT_MEMBERS = [
  {
    id: PROJECT.created_by_user_id,
    user_id: PROJECT.created_by_user_id,
    user_name: 'wework-desktop-e2e-cloud-user',
    email: 'desktop-e2e@wework.local',
    role: 'Owner',
    capability_description: '',
  },
]

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
  maxConcurrentExecutions: 1,
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

const RUNTIME_PROFILE = {
  id: 'runtime-profile-project-automation',
  name: '本机运行环境',
  executionEnvironment: 'local',
  executionDeviceId: 'local-device',
  model: MODEL_NAME,
  modelType: 'runtime',
  modelOptions: {},
  workspacePolicy: 'project',
  status: 'active',
  version: 1,
  createdAt: '2026-08-11T00:00:00',
  updatedAt: '2026-08-11T00:00:00',
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
  const states = ['waiting_runtime', 'queued', 'succeeded', 'failed']
  return Array.from({ length: 8 }, (_, index) => ({
    id: `automation-run-history-${index + 1}`,
    automationId: 'automation-rule-created',
    projectId: PROJECT_ID,
    trigger: 'schedule',
    status: states[index] ?? 'succeeded',
    scheduledFor: `2026-08-${String(10 - index).padStart(2, '0')}T09:00:00`,
    expiresAt: null,
    taskId: `AUTO-${100 - index}`,
    taskTitle: `历史自动化任务 ${index + 1}`,
    deviceId: AGENT.executionDeviceId,
    error: states[index] === 'failed' ? 'Historical execution failed.' : null,
    createdAt: `2026-08-${String(10 - index).padStart(2, '0')}T09:00:00`,
    updatedAt: `2026-08-${String(10 - index).padStart(2, '0')}T09:01:00`,
    completedAt:
      states[index] === 'succeeded' || states[index] === 'failed'
        ? `2026-08-${String(10 - index).padStart(2, '0')}T09:01:00`
        : null,
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

function runtimeWorkTasks(runtimeWork) {
  return [
    ...(runtimeWork.projects ?? []).flatMap(project => project.deviceWorkspaces ?? []),
    ...(runtimeWork.chats ?? []),
  ].flatMap(workspace => workspace.tasks ?? [])
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

export function createDesktopScenario({ captureScreenshot, uiTimeoutMs, workspacePath }) {
  // Cloud executions are claimed asynchronously. Keep the assertion budget
  // beyond one complete claim window so a commit at the boundary is observed.
  const automationRuntimeTimeoutMs = Math.max(
    uiTimeoutMs * 6,
    AUTOMATION_SCHEDULE_TIMEOUT_MS + 10_000
  )
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
  let createdAgentPayload = null
  let cancelRequested = false
  let retryRequested = false
  let modelRequests = 0
  const remoteProjectChatRequests = []
  let boardTeamAssignmentPayload = null
  let createdBoardItem = null
  let createdChildItem = null
  let workflowPlan = null
  let workflowPlanApprovalRequested = false
  let markBoardItemReadRequests = 0
  let cloudApi = null
  let cloudProject = null
  let cloudAgent = null
  let cloudRuntimeProfile = null
  let localDefaultAgent = null
  let wegentAgent = null
  let cloudTeam = null
  let personalApiKey = null
  let managerToolCalls = 0
  const upstreamResponseRequests = []
  let uiProject = { ...PROJECT }
  let nextBoardItemSequence = 201
  let orchestratedItemId = null
  let orchestratedMovePayload = null
  let workflowTaskBindings = []
  let resolveFirstContinuationStarted
  let releaseFirstContinuation
  const firstContinuationStarted = new Promise(resolve => {
    resolveFirstContinuationStarted = resolve
  })
  const firstContinuationRelease = new Promise(resolve => {
    releaseFirstContinuation = resolve
  })

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

  async function waitForCompletedExecution(
    projectId,
    taskId,
    executorType,
    timeoutMs = automationRuntimeTimeoutMs
  ) {
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
      timeoutMs
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

  async function waitForSucceededRun(
    projectId,
    ruleId,
    taskId = null,
    timeoutMs = automationRuntimeTimeoutMs
  ) {
    return waitForValue(
      () => cloudRequest(`/api/v1/cloud-projects/${projectId}/automations/${ruleId}/runs`),
      items =>
        items.find(
          item => item.status === 'succeeded' && (taskId === null || item.taskId === taskId)
        ),
      `Automation ${ruleId} did not reach succeeded${taskId ? ` for ${taskId}` : ''}`,
      timeoutMs
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
    const deviceResponse = await waitForValue(
      () => cloudRequest('/api/devices'),
      response =>
        response.items?.some(
          device => device.device_id === CLOUD_DEVICE_ID && device.status === 'online'
        ) &&
        response.items?.some(
          device =>
            device.device_id !== CLOUD_DEVICE_ID &&
            ['local', 'app'].includes(device.device_type) &&
            device.status === 'online'
        ),
      'Local and cloud execution devices did not register before project automation verification',
      uiTimeoutMs
    )
    const localDefaultDevice = deviceResponse.items.find(
      device =>
        device.device_id !== CLOUD_DEVICE_ID &&
        ['local', 'app'].includes(device.device_type) &&
        device.status === 'online'
    )
    const cloudExecutionDevice = deviceResponse.items.find(
      device => device.device_id === CLOUD_DEVICE_ID
    )
    assert.ok(localDefaultDevice?.device_id, 'Real Wework local executor fixture is missing')
    assert.ok(cloudExecutionDevice?.device_id, 'Real Wework cloud executor fixture is missing')
    cloudRuntimeProfile = await cloudRequest('/api/v1/runtime-profiles', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Project automation cloud Runtime',
        executionEnvironment: 'cloud',
        executionDeviceId: CLOUD_DEVICE_ID,
        model: CLOUD_MODEL_NAME,
        modelType: 'public',
        modelOptions: {
          weworkCloudModelNamespace: 'default',
          weworkCloudModelResourceUserId: '0',
          weworkCloudModelUpstreamApiFormat: 'openai-responses',
        },
        workspacePolicy: 'project',
      }),
    })
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
    localDefaultAgent = await cloudRequest(`/api/v1/cloud-projects/${projectId}/chat-agents`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'Local GPT default · Moonshot override regression',
        runtime: 'codex',
        model: DEFAULT_MODEL_ID,
        modelType: 'runtime',
        modelOptions: { reasoningEffort: 'high' },
        systemPrompt: '',
        capabilityDescription:
          'Defaults to the local GPT runtime so the Issue override must remain authoritative.',
        visibility: 'creator_admin',
        executionEnvironment: 'local',
        executionMode: 'auto',
        executionDeviceId: localDefaultDevice.device_id,
        workspaceBinding: { type: 'standalone' },
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
    assert.equal(localDefaultAgent.executionEnvironment, 'local')
    assert.equal(localDefaultAgent.executionDeviceId, localDefaultDevice.device_id)
    assert.equal(localDefaultAgent.model, DEFAULT_MODEL_ID)
    assert.equal(localDefaultAgent.modelType, 'runtime')
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
    const boardWorkspaceTabId = await control.command('getAttribute', activeBoard, {
      value: 'data-workspace-tab-content',
    })
    assert.ok(boardWorkspaceTabId, 'The project-space workspace tab ID was not observable')
    const boardWorkspaceTabSelector = `[data-testid="workspace-tab-select-${boardWorkspaceTabId}"]`
    const projectSelector = `${activeBoard} [data-testid="cloud-sidebar-project-${projectId}"]`
    await control.command('waitFor', projectSelector, { timeoutMs: uiTimeoutMs })
    await control.command('click', projectSelector)
    await control.command('waitFor', `${activeBoard} [data-testid="cloud-project-board-view"]`, {
      timeoutMs: uiTimeoutMs,
      visible: true,
    })
    await control.command('click', `${activeBoard} [data-testid="cloud-project-board-view"]`, {
      visible: true,
    })
    await control.command('waitFor', `${activeBoard} [data-testid="cloud-todo-add"]`, {
      timeoutMs: uiTimeoutMs,
      visible: true,
    })

    const statusWorkflowRule = await cloudRequest(
      `/api/v1/cloud-projects/${projectId}/automations`,
      {
        method: 'POST',
        body: JSON.stringify({
          name: '进入进行中绑定工作流',
          prompt: 'Issue 进入进行中后必须绑定工作流，不能启动单任务。',
          triggerType: 'event',
          eventType: 'task.status_changed',
          eventConfig: {
            transition: 'entered_processing',
            tags: ['status-wf-bind'],
            runtime_workflow_definition: {
              version: 1,
              stage_mode: 'dag',
              advancement_policy: 'manual',
              approval_policy: 'required',
              coordinator_prompt: '',
              ai_automation_rule_id: null,
              execution_config: null,
              nodes: [
                {
                  id: 'review',
                  name: '工作流评审',
                  prompt: '验证状态自动化已经绑定工作流。',
                  execution_mode: 'human',
                  depends_on: [],
                  dependency_context: {},
                  required: true,
                  required_deliverables: [],
                  workspace_policy: 'none',
                  automation_rule_id: null,
                  execution_config: null,
                  execution_config_override: false,
                },
              ],
            },
          },
          assignmentMode: 'manual',
          agentId: localDefaultAgent.id,
          enabled: true,
        }),
      }
    )
    const alternateStatusWorkflowRule = await cloudRequest(
      `/api/v1/cloud-projects/${projectId}/automations`,
      {
        method: 'POST',
        body: JSON.stringify({
          name: '进入进行中绑定替代工作流',
          prompt: 'Issue 进入进行中后选择替代工作流。',
          triggerType: 'event',
          eventType: 'task.status_changed',
          eventConfig: {
            transition: 'entered_processing',
            tags: ['status-wf-bind'],
            runtime_workflow_definition: {
              version: 1,
              stage_mode: 'dag',
              advancement_policy: 'manual',
              approval_policy: 'required',
              coordinator_prompt: '',
              ai_automation_rule_id: null,
              execution_config: null,
              nodes: [
                {
                  id: 'alternate-review',
                  name: '替代工作流评审',
                  prompt: '验证用户选择的状态自动化被唯一绑定。',
                  execution_mode: 'human',
                  depends_on: [],
                  dependency_context: {},
                  required: true,
                  required_deliverables: [],
                  workspace_policy: 'none',
                  automation_rule_id: null,
                  execution_config: null,
                  execution_config_override: false,
                },
              ],
            },
          },
          assignmentMode: 'manual',
          agentId: localDefaultAgent.id,
          enabled: true,
        }),
      }
    )
    const statusWorkflowIssue = await publicApiRequest(
      `/api/v1/cloud-projects/${projectId}/loop-items`,
      {
        method: 'POST',
        body: JSON.stringify({
          title: '收集箱进入进行中绑定自动化工作流',
          description: '移动后必须进入自动化工作流，不能创建单任务。',
          status: 'inbox',
          priority: 'high',
          tags: ['status-wf-bind'],
        }),
      }
    )
    const readyCountBeforeStatusWorkflowReload = control.readyCount
    await control.command('reloadMainWindow', 'body')
    await withTimeout(
      control.awaitReadyAfter(readyCountBeforeStatusWorkflowReload),
      uiTimeoutMs * 3,
      'The project board did not reconnect for the status workflow binding regression'
    )
    await control.command('waitFor', projectSelector, { timeoutMs: uiTimeoutMs })
    await control.command('click', projectSelector)
    await control.command('waitFor', `${activeBoard} [data-testid="cloud-project-board-view"]`, {
      timeoutMs: uiTimeoutMs,
      visible: true,
    })
    await control.command('click', `${activeBoard} [data-testid="cloud-project-board-view"]`, {
      visible: true,
    })
    const statusWorkflowCard = `${activeBoard} [data-testid="cloud-todo-card-${statusWorkflowIssue.id}"]`
    await control.command('waitFor', statusWorkflowCard, {
      text: statusWorkflowIssue.title,
      timeoutMs: uiTimeoutMs,
      visible: true,
    })
    await control.command('drag', statusWorkflowCard, {
      target: `${activeBoard} [data-testid="cloud-todo-column-dropzone-pending"]`,
    })
    await control.command('waitFor', '[data-testid="automation-selection-options"]', {
      timeoutMs: uiTimeoutMs,
      visible: true,
    })
    const issueBeforeAutomationSelection = await cloudRequest(
      `/api/v1/loop-items/${statusWorkflowIssue.id}`
    )
    assert.equal(
      issueBeforeAutomationSelection.status,
      'inbox',
      'The Issue moved before the user selected one matching automation'
    )
    await control.command(
      'click',
      `[data-testid="automation-selection-option-${alternateStatusWorkflowRule.id}"]`,
      { visible: true }
    )
    await control.command('click', '[data-testid="automation-selection-confirm"]', {
      visible: true,
    })
    const boundStatusWorkflowIssue = await waitForValue(
      () => cloudRequest(`/api/v1/loop-items/${statusWorkflowIssue.id}`),
      item =>
        item.status === 'pending' &&
        item.workflow?.nodes?.[0]?.id === 'alternate-review' &&
        item.workflow?.nodes?.[0]?.status === 'ready',
      'The status automation workflow was not bound before execution routing',
      uiTimeoutMs
    )
    assert.equal(boundStatusWorkflowIssue.workflow.nodes[0].execution_mode, 'human')
    assert.equal(
      Number(await control.command('getElementCount', '[data-testid="ai-chat-modal"]')),
      0,
      'Moving the Issue started a single-task composer instead of the bound workflow'
    )
    await captureScreenshot(control, 'project-automation-status-workflow-bound.png')
    await disableRule(projectId, statusWorkflowRule)
    await disableRule(projectId, alternateStatusWorkflowRule)

    const inheritedWorkflowIssue = await publicApiRequest(
      `/api/v1/cloud-projects/${projectId}/loop-items`,
      {
        method: 'POST',
        body: JSON.stringify({
          title: '工作流共享运行配置规范化',
          description: '旧快照只在首个节点保存运行配置，弹窗必须将其提升为共享配置并允许立即确认。',
          status: 'in_progress',
          priority: 'high',
          tags: ['workflow-shared-runtime-regression'],
          workflow: {
            version: 1,
            definition_version: 1,
            stage_mode: 'dag',
            advancement_policy: 'manual',
            execution_config: null,
            nodes: [
              {
                id: 'pwd',
                name: 'pwd',
                execution_mode: 'robot',
                depends_on: [],
                required: true,
                workspace_policy: 'composer',
                automation_rule_id: null,
                execution_config_override: false,
                execution_config: {
                  agent_id: null,
                  runtime_profile_id: null,
                  execution_device_id: localDefaultDevice.device_id,
                  model: DEFAULT_MODEL_ID,
                  model_type: 'runtime',
                  model_options: {},
                  workspace_binding: null,
                },
              },
              {
                id: 'ls',
                name: 'ls',
                execution_mode: 'robot',
                depends_on: ['pwd'],
                required: true,
                workspace_policy: 'composer',
                automation_rule_id: null,
                execution_config_override: false,
                execution_config: null,
              },
            ],
          },
        }),
      }
    )
    const readyCountBeforeInheritedWorkflowReload = control.readyCount
    await control.command('reloadMainWindow', 'body')
    await withTimeout(
      control.awaitReadyAfter(readyCountBeforeInheritedWorkflowReload),
      uiTimeoutMs * 3,
      'The project board did not reconnect for the shared workflow Runtime regression'
    )
    await control.command('waitFor', projectSelector, { timeoutMs: uiTimeoutMs })
    await control.command('click', projectSelector)
    await control.command('waitFor', `${activeBoard} [data-testid="cloud-project-board-view"]`, {
      timeoutMs: uiTimeoutMs,
      visible: true,
    })
    await control.command('click', `${activeBoard} [data-testid="cloud-project-board-view"]`, {
      visible: true,
    })
    const inheritedWorkflowCard = `${activeBoard} [data-testid="cloud-todo-card-${inheritedWorkflowIssue.id}"]`
    await control.command('waitFor', inheritedWorkflowCard, {
      text: inheritedWorkflowIssue.title,
      timeoutMs: uiTimeoutMs,
      visible: true,
    })
    const configureExecution = `${activeBoard} [data-testid="cloud-todo-card-configure-execution-${inheritedWorkflowIssue.id}"]`
    await control.command('scrollIntoView', configureExecution)
    await control.command('waitFor', configureExecution, {
      text: '去配置',
      timeoutMs: uiTimeoutMs,
      visible: true,
    })
    await control.command('click', configureExecution, {
      visible: true,
    })
    await control.command('waitFor', '[data-testid="issue-execution-config-dialog"]', {
      timeoutMs: uiTimeoutMs,
      visible: true,
    })
    await control.command('waitFor', '[data-testid="issue-execution-config-default-device"]', {
      timeoutMs: uiTimeoutMs,
      visible: true,
    })
    assert.equal(
      await control.command('getValue', '[data-testid="issue-execution-config-default-device"]'),
      localDefaultDevice.device_id,
      'The workflow dialog did not promote the legacy node device to the shared configuration'
    )
    assert.equal(
      await control.command('getValue', '[data-testid="issue-execution-config-default-model"]'),
      `runtime:${DEFAULT_MODEL_ID}`,
      'The workflow dialog did not promote the legacy node model to the shared configuration'
    )
    await control.command('click', '[data-testid="cloud-todo-modal-close"]', {
      visible: true,
    })
    await waitForValue(
      () => control.command('getElementCount', '[data-testid="issue-execution-config-dialog"]'),
      count => Number(count) === 0,
      'The execution configuration dialog did not close',
      uiTimeoutMs
    )
    await control.command('scrollIntoView', configureExecution)
    await control.command('waitFor', configureExecution, {
      text: '去配置',
      timeoutMs: uiTimeoutMs,
      visible: true,
    })
    await control.command('click', configureExecution, {
      visible: true,
    })
    await control.command('waitFor', '[data-testid="issue-execution-config-dialog"]', {
      timeoutMs: uiTimeoutMs,
      visible: true,
    })
    await captureScreenshot(control, 'project-automation-reopen-execution-configuration.png')
    await control.command('clickWhenEnabled', '[data-testid="issue-execution-config-confirm"]', {
      timeoutMs: uiTimeoutMs,
    })
    await waitForValue(
      () => cloudRequest(`/api/v1/loop-items/${inheritedWorkflowIssue.id}`),
      item =>
        item.workflow?.execution_config?.execution_device_id === localDefaultDevice.device_id &&
        item.workflow?.execution_config?.model === DEFAULT_MODEL_ID &&
        item.workflow?.nodes?.every(node => node.execution_config === null),
      'The normalized shared workflow Runtime snapshot was not persisted',
      uiTimeoutMs
    )

    const moonshotOverrideIssue = await publicApiRequest(
      `/api/v1/cloud-projects/${projectId}/loop-items`,
      {
        method: 'POST',
        body: JSON.stringify({
          title: MOONSHOT_OVERRIDE_ISSUE_TITLE,
          description:
            'The robot defaults to a local GPT runtime. This Issue must execute on the cloud public Moonshot fixture and preserve that identity for follow-up messages.',
          status: 'inbox',
          priority: 'high',
          tags: ['runtime-v2-model-override'],
          assignee_agent_id: localDefaultAgent.id,
          execution_config: {
            agent_id: localDefaultAgent.id,
            runtime_profile_id: null,
            execution_device_id: null,
            model: null,
            model_type: null,
            model_options: {},
            workspace_binding: { type: 'standalone' },
          },
        }),
      }
    )
    assert.equal(moonshotOverrideIssue.assignee_agent_id, localDefaultAgent.id)
    assert.equal(
      moonshotOverrideIssue.execution_config?.execution_device_id,
      null,
      'The Issue fixture unexpectedly persisted a resolved execution device'
    )
    assert.equal(
      moonshotOverrideIssue.execution_config?.model,
      null,
      'The Issue fixture unexpectedly persisted a resolved model'
    )

    const readyCountBeforeMoonshotOverrideReload = control.readyCount
    await control.command('reloadMainWindow', 'body')
    await withTimeout(
      control.awaitReadyAfter(readyCountBeforeMoonshotOverrideReload),
      uiTimeoutMs * 3,
      'The project board did not reconnect for the Moonshot override regression'
    )
    await control.command('waitFor', projectSelector, { timeoutMs: uiTimeoutMs })
    await control.command('click', projectSelector)
    await control.command('waitFor', `${activeBoard} [data-testid="cloud-project-board-view"]`, {
      timeoutMs: uiTimeoutMs,
      visible: true,
    })
    await control.command('click', `${activeBoard} [data-testid="cloud-project-board-view"]`, {
      visible: true,
    })
    const moonshotOverrideCard = `${activeBoard} [data-testid="cloud-todo-card-${moonshotOverrideIssue.id}"]`
    await control.command('waitFor', moonshotOverrideCard, {
      text: MOONSHOT_OVERRIDE_ISSUE_TITLE,
      timeoutMs: uiTimeoutMs,
      visible: true,
    })
    await control.command('drag', moonshotOverrideCard, {
      target: `${activeBoard} [data-testid="cloud-todo-column-dropzone-in_progress"]`,
    })
    await control.command('waitFor', '[data-testid="issue-execution-config-dialog"]', {
      timeoutMs: uiTimeoutMs,
      visible: true,
    })

    const executionConfigFields = '[data-testid="issue-execution-config-fields"]'
    const executionAgent = `${executionConfigFields} [data-testid="issue-execution-config-fields-agent"]`
    const executionDevice = `${executionConfigFields} [data-testid="issue-execution-config-fields-device"]`
    const executionModel = `${executionConfigFields} [data-testid="issue-execution-config-fields-model"]`
    const executionProject = `${executionConfigFields} [data-testid="issue-execution-config-fields-project"]`
    await control.command('waitFor', executionAgent, {
      timeoutMs: uiTimeoutMs,
      visible: true,
    })
    assert.equal(
      await control.command('getValue', executionAgent),
      localDefaultAgent.id,
      'The execution dialog lost the robot preset identity'
    )
    assert.equal(
      await control.command('getValue', executionDevice),
      localDefaultDevice.device_id,
      'The execution dialog did not expose the robot local-device default'
    )
    assert.equal(
      await control.command('getValue', executionModel),
      `runtime:${DEFAULT_MODEL_ID}`,
      'The execution dialog did not expose the robot GPT default'
    )
    await control.command('click', executionDevice, { visible: true })
    await control.command(
      'click',
      `[data-testid="issue-execution-config-fields-device-option-${CLOUD_DEVICE_ID}"]`,
      { visible: true }
    )
    await control.command('select', executionModel, { value: `public:${CLOUD_MODEL_NAME}` })
    await control.command('select', executionProject, { value: 'standalone' })
    const initialUpstreamRequestOffset = upstreamResponseRequests.length
    await control.command('setLocalProxyUrl', 'body', {
      value: 'http://127.0.0.1:1',
    })
    await control.command('clickWhenEnabled', '[data-testid="issue-execution-config-confirm"]', {
      timeoutMs: uiTimeoutMs,
    })

    const persistedMoonshotIssue = await waitForValue(
      () => cloudRequest(`/api/v1/cloud-projects/${projectId}/loop-items`),
      response => {
        const item = (response.items ?? []).find(
          candidate => candidate.id === moonshotOverrideIssue.id
        )
        return (
          item?.status === 'in_progress' &&
          item.execution_config?.agent_id === localDefaultAgent.id &&
          item.execution_config?.execution_device_id === CLOUD_DEVICE_ID &&
          item.execution_config?.model === CLOUD_MODEL_NAME &&
          item.execution_config?.model_type === 'public' &&
          item.execution_config?.workspace_binding?.type === 'standalone'
        )
      },
      'The Issue-owned cloud Moonshot execution snapshot was not persisted',
      uiTimeoutMs
    ).then(response => response.items.find(candidate => candidate.id === moonshotOverrideIssue.id))
    assert.equal(persistedMoonshotIssue.execution_config.model, CLOUD_MODEL_NAME)

    const moonshotExecution = await waitForCompletedExecution(
      projectId,
      moonshotOverrideIssue.id,
      'project_robot'
    )
    assert.equal(moonshotExecution.agentId, localDefaultAgent.id)
    assert.equal(
      moonshotExecution.executionDeviceId,
      CLOUD_DEVICE_ID,
      'The queue execution reverted to the robot local-device default'
    )
    assert.equal(
      moonshotExecution.runtimeDeviceId,
      CLOUD_DEVICE_ID,
      'The Runtime task was not created on the selected cloud device'
    )
    assert.ok(moonshotExecution.runtimeTaskId, 'The cloud execution did not expose a Runtime task')

    const moonshotIssueBindings = await waitForValue(
      () => cloudRequest(`/api/v1/loop-items/${moonshotOverrideIssue.id}/tasks`),
      bindings =>
        bindings.find(
          binding =>
            binding.device_id === CLOUD_DEVICE_ID &&
            binding.task_id === moonshotExecution.runtimeTaskId
        ),
      'The ordinary Issue execution was not persisted as an Issue task',
      uiTimeoutMs
    )
    const moonshotIssueBinding = moonshotIssueBindings.find(
      binding =>
        binding.device_id === CLOUD_DEVICE_ID && binding.task_id === moonshotExecution.runtimeTaskId
    )
    assert.equal(
      moonshotIssueBinding.workflow_node_id,
      null,
      'The ordinary Issue task was incorrectly assigned to a workflow stage'
    )

    const initialMoonshotRequests = await waitForValue(
      () => Promise.resolve(upstreamResponseRequests.slice(initialUpstreamRequestOffset)),
      requests =>
        requests.some(
          request =>
            request.model === CLOUD_MODEL_UPSTREAM_ID &&
            JSON.stringify(request).includes(`task_id: ${moonshotOverrideIssue.id}`)
        ),
      'The Issue execution did not reach the selected Moonshot model service',
      uiTimeoutMs
    )
    const initialIssueRequests = initialMoonshotRequests.filter(request =>
      JSON.stringify(request).includes(`task_id: ${moonshotOverrideIssue.id}`)
    )
    assert.ok(initialIssueRequests.length > 0, 'The Issue produced no correlated upstream request')
    assert.ok(
      initialIssueRequests.every(request => request.model === CLOUD_MODEL_UPSTREAM_ID),
      'The Issue produced a duplicate request through a model other than Moonshot'
    )
    await control.command('setLocalProxyUrl', 'body', { value: '' })

    const runtimeWork = await waitForValue(
      () => cloudRequest('/api/runtime-work'),
      response =>
        runtimeWorkTasks(response).find(task => task.taskId === moonshotExecution.runtimeTaskId),
      'The cloud Runtime task was not projected into Wework',
      uiTimeoutMs
    )
    const projectedMoonshotTask = runtimeWorkTasks(runtimeWork).find(
      task => task.taskId === moonshotExecution.runtimeTaskId
    )
    const runtimeTasksForIssue = runtimeWorkTasks(runtimeWork).filter(
      task => task.title === MOONSHOT_OVERRIDE_ISSUE_TITLE
    )
    assert.equal(runtimeTasksForIssue.length, 1, 'The Issue created more than one Runtime task')
    assert.equal(projectedMoonshotTask.modelSelection?.modelName, CLOUD_MODEL_NAME)
    assert.equal(projectedMoonshotTask.modelSelection?.modelType, 'public')
    assert.equal(
      Object.hasOwn(projectedMoonshotTask, 'runtimeHandle'),
      false,
      'The private Runtime handle escaped the cloud projection boundary'
    )

    await control.command('drag', moonshotOverrideCard, {
      target: `${activeBoard} [data-testid="cloud-todo-column-dropzone-in_review"]`,
    })
    await waitForValue(
      () => cloudRequest(`/api/v1/loop-items/${moonshotOverrideIssue.id}`),
      item => item.status === 'in_review',
      'The completed Issue did not reach the review state required for board follow-up',
      uiTimeoutMs
    )
    await control.command(
      'waitFor',
      `${activeBoard} [data-testid="cloud-todo-card-tasks-${moonshotOverrideIssue.id}"]`,
      {
        timeoutMs: uiTimeoutMs,
        visible: true,
      }
    )
    const moonshotProgressPopup = `[data-testid="cloud-todo-card-progress-popup-${moonshotOverrideIssue.id}"]`
    const moonshotPopupConversation = `${moonshotProgressPopup} [data-testid="cloud-todo-card-popup-conversation-${moonshotOverrideIssue.id}"]`
    const moonshotPopupModelSelector = `${moonshotPopupConversation} [data-testid="model-selector-button"]`
    const moonshotPopupInput = `${moonshotPopupConversation} [data-testid="chat-message-input"]`
    const moonshotPopupSend = `${moonshotPopupConversation} [data-testid="send-message-button"]`
    await control.command('scrollIntoView', moonshotOverrideCard, { visible: true })
    await control.command('hover', moonshotOverrideCard, { visible: true })
    await control.command('waitFor', moonshotProgressPopup, {
      timeoutMs: uiTimeoutMs,
      visible: true,
    })
    const followUpRequestOffset = upstreamResponseRequests.length
    await control.command('click', moonshotPopupInput, { visible: true })
    await waitForValue(
      () =>
        control.command(
          'getAttribute',
          `${moonshotPopupConversation} [data-testid="project-chat-composer-form"]`,
          { value: 'data-short-expanded' }
        ),
      value => value === 'true',
      'The board popup composer did not expand after focusing its input',
      uiTimeoutMs
    )
    await control.command('fill', moonshotPopupInput, {
      value: MOONSHOT_OVERRIDE_FOLLOW_UP,
    })
    const popupModelLabel = await control.command('getText', moonshotPopupModelSelector)
    assert.equal(
      popupModelLabel,
      `公网:${CLOUD_MODEL_UPSTREAM_ID}`,
      'The board popup displayed the global GPT default instead of the task model'
    )
    assert.ok(!popupModelLabel.includes(DEFAULT_MODEL_LABEL))
    await control.command('click', moonshotPopupSend, { visible: true })
    const followUpRequests = await waitForValue(
      () => Promise.resolve(upstreamResponseRequests.slice(followUpRequestOffset)),
      requests =>
        requests.some(request => JSON.stringify(request).includes(MOONSHOT_OVERRIDE_FOLLOW_UP)),
      'The board popup follow-up did not reach the task model service',
      uiTimeoutMs
    )
    const routedFollowUp = followUpRequests.find(request =>
      JSON.stringify(request).includes(MOONSHOT_OVERRIDE_FOLLOW_UP)
    )
    assert.equal(
      routedFollowUp?.model,
      CLOUD_MODEL_UPSTREAM_ID,
      'The board popup follow-up used the global default instead of the task model'
    )
    await control.command('press', 'body', { key: 'Escape' })

    await control.command('waitFor', `${activeBoard} [data-testid="cloud-project-board-view"]`, {
      timeoutMs: uiTimeoutMs,
      visible: true,
    })
    await control.command('click', `${activeBoard} [data-testid="cloud-project-board-view"]`, {
      visible: true,
    })
    await control.command('waitFor', `${activeBoard} [data-testid="cloud-todo-add"]`, {
      timeoutMs: uiTimeoutMs,
      visible: true,
    })
    await control.command('click', `${activeBoard} [data-testid="cloud-todo-add"]`)
    await control.command('waitFor', `${activeBoard} [data-testid="workspace-issue-input"]`, {
      timeoutMs: uiTimeoutMs,
    })
    assert.equal(
      Number(
        await control.command(
          'getElementCount',
          `${activeBoard} [data-testid="workspace-issue-input"] .composer-empty-caret`
        )
      ),
      0,
      'The empty board task composer replaced its native caret with a widget'
    )
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
    await control.command('fill', replyComposer, { value: FIRST_CONTINUATION_PROMPT })
    await control.command('press', replyComposer, { key: 'Enter' })
    await withTimeout(
      firstContinuationStarted,
      uiTimeoutMs,
      'The first native Wegent continuation did not reach the model service'
    )
    try {
      await control.command(
        'waitFor',
        '[data-testid^="cloud-task-activity-execution-badge-"][data-status="running"]',
        { timeoutMs: uiTimeoutMs }
      )
      await control.command('fill', replyComposer, { value: QUEUED_CONTINUATION_PROMPT })
      await control.command('press', replyComposer, { key: 'Enter' })
      await control.command(
        'waitFor',
        `[data-testid="cloud-task-activity-card-queue-${rootMessageId}"]`,
        {
          text: QUEUED_CONTINUATION_PROMPT,
          timeoutMs: uiTimeoutMs,
        }
      )
      await captureScreenshot(control, 'project-automation-board-team-queued-continuation.png')
    } finally {
      releaseFirstContinuation()
    }
    const continuedTask = await waitForValue(
      () => cloudRequest(`/api/tasks/${teamExecution.backendTaskId}`),
      task => {
        const prompts = (task.subtasks ?? []).map(subtask => subtask.prompt)
        const firstReplyIndex = prompts.indexOf(FIRST_CONTINUATION_PROMPT)
        const queuedReplyIndex = prompts.indexOf(QUEUED_CONTINUATION_PROMPT)
        return firstReplyIndex >= 0 && queuedReplyIndex > firstReplyIndex
      },
      'Queued board replies were not appended to the native Wegent Task in order',
      uiTimeoutMs * 3
    )
    assert.equal(continuedTask.id, teamExecution.backendTaskId)
    const agentExecutionBadgeSelector = '[data-testid^="cloud-task-activity-execution-badge-"]'
    await waitForValue(
      () => control.command('getElementCount', agentExecutionBadgeSelector),
      count => Number(count) === 3,
      'Queued native Wegent continuations were not projected as distinct agent comments',
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
    await control.command(
      'waitFor',
      `${activeBoard} [data-testid="cloud-project-automation-view"]`,
      {
        timeoutMs: uiTimeoutMs,
      }
    )
    await control.command('click', `${activeBoard} [data-testid="cloud-project-automation-view"]`)
    await control.command('waitFor', `${activeBoard} [data-testid="project-automation-view"]`, {
      timeoutMs: uiTimeoutMs,
      visible: true,
    })
    await captureScreenshot(control, 'project-automation-unified-home.png')

    const workflowProject = await cloudRequest(`/api/v1/cloud-projects/${projectId}`)
    await cloudRequest(`/api/v1/cloud-projects/${projectId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        version: workflowProject.version,
        workflow_definition: {
          version: 1,
          stage_mode: 'dag',
          advancement_policy: 'manual',
          approval_policy: 'required',
          coordinator_prompt: '',
          ai_automation_rule_id: null,
          nodes: [
            {
              id: 'stage-1',
              name: '真实后端开发阶段',
              prompt: '实现 Issue 中描述的功能并完成验证。',
              depends_on: [],
              dependency_context: {},
              required: true,
              required_deliverables: [],
              workspace_policy: 'composer',
              automation_rule_id: null,
            },
          ],
        },
      }),
    })

    await control.command('click', `${activeBoard} [data-testid="cloud-project-board-view"]`)
    const activeDetailClose = `${activeBoard} [data-testid="cloud-todo-detail-close"]`
    if ((await control.command('getElementCount', activeDetailClose, { visible: true })) > 0) {
      await control.command('click', activeDetailClose, { visible: true })
    }
    await control.command('waitFor', `${activeBoard} [data-testid="cloud-todo-add"]`, {
      timeoutMs: uiTimeoutMs,
      visible: true,
    })
    await control.command('click', `${activeBoard} [data-testid="cloud-todo-add"]`)
    await control.command('waitFor', `${activeBoard} [data-testid="workspace-issue-input"]`, {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('fill', `${activeBoard} [data-testid="workspace-issue-input"]`, {
      value: '真实后端阶段任务绑定',
    })
    await control.command('click', `${activeBoard} [data-testid="workspace-issue-submit"]`)
    await control.command('waitFor', `${activeBoard} [data-testid="cloud-todo-detail-title"]`, {
      text: '真实后端阶段任务绑定',
      timeoutMs: uiTimeoutMs,
    })
    const workflowIssue = await waitForValue(
      () => cloudRequest(`/api/v1/cloud-projects/${projectId}/loop-items`),
      response =>
        (response.items ?? []).find(item => item.title === '真实后端阶段任务绑定')?.workflow
          ?.nodes?.[0]?.status === 'ready',
      'The UI-created Issue did not persist its workflow snapshot',
      uiTimeoutMs
    ).then(response => response.items.find(item => item.title === '真实后端阶段任务绑定'))
    assert.equal(workflowIssue.workflow?.nodes?.[0]?.id, 'stage-1')
    await control.command('waitFor', '[data-testid="cloud-todo-create-workflow-task-stage-1"]', {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('click', '[data-testid="cloud-todo-create-workflow-task-stage-1"]')
    await control.command('waitFor', '[data-testid="ai-chat-modal"]', {
      timeoutMs: uiTimeoutMs,
    })
    const workflowTaskInput = '[data-testid="ai-chat-modal"] [data-testid="chat-message-input"]'
    const compiledWorkflowPrompt = await control.command('getValue', workflowTaskInput)
    assert.match(compiledWorkflowPrompt, /## 任务定位/)
    assert.match(compiledWorkflowPrompt, /真实后端阶段任务绑定/)
    assert.match(compiledWorkflowPrompt, /真实后端开发阶段/)
    assert.match(compiledWorkflowPrompt, /## 当前节点任务/)
    assert.match(compiledWorkflowPrompt, /实现 Issue 中描述的功能并完成验证。/)
    const issueComposerSnapshot = JSON.parse(await control.command('snapshot', 'body'))
    await control.command(
      'waitFor',
      '[data-testid="ai-chat-modal"] [data-testid="project-work-button"]',
      { timeoutMs: uiTimeoutMs }
    )
    await control.command(
      'click',
      '[data-testid="ai-chat-modal"] [data-testid="project-work-button"]'
    )
    await control.command(
      'waitFor',
      '[data-testid="ai-chat-modal"] [data-testid="project-options-list"]',
      {
        timeoutMs: uiTimeoutMs,
      }
    )
    const projectMenuSnapshot = await waitForValue(
      async () => JSON.parse(await control.command('snapshot', '[data-testid="ai-chat-modal"]')),
      snapshot => {
        const selectedId = snapshot.testIds
          .find(testId => testId.startsWith('project-selected-icon-'))
          ?.slice('project-selected-icon-'.length)
        return snapshot.testIds.some(
          testId =>
            testId.startsWith('project-option-') &&
            testId !== `project-option-${selectedId ?? ''}` &&
            !snapshot.testIds.includes(
              `project-bind-workspace-${testId.slice('project-option-'.length)}`
            )
        )
      },
      'Issue task composer requires another runtime project with a ready workspace',
      uiTimeoutMs
    )
    const selectedProjectTestId = projectMenuSnapshot.testIds.find(testId =>
      testId.startsWith('project-selected-icon-')
    )
    const selectedProjectId = selectedProjectTestId?.slice('project-selected-icon-'.length)
    const targetProjectCandidates = projectMenuSnapshot.testIds.filter(
      testId =>
        testId.startsWith('project-option-') &&
        testId !== `project-option-${selectedProjectId ?? ''}` &&
        !projectMenuSnapshot.testIds.includes(
          `project-bind-workspace-${testId.slice('project-option-'.length)}`
        )
    )
    let targetProjectTestId = null
    let selectedTargetProjectName = null
    for (const testId of targetProjectCandidates) {
      const projectText = await control.command(
        'getText',
        `[data-testid="ai-chat-modal"] [data-testid="${testId}"]`,
        { visible: true }
      )
      const projectName = ['project-automation-primary', 'project-automation-secondary'].find(
        name => projectText.includes(name)
      )
      if (projectName) {
        targetProjectTestId = testId
        selectedTargetProjectName = projectName
        break
      }
    }
    assert.ok(
      targetProjectTestId,
      'Issue task composer requires another runtime project for project-switch regression coverage'
    )
    assert.ok(selectedTargetProjectName, 'Unable to resolve the target runtime project name')
    await control.command(
      'click',
      `[data-testid="ai-chat-modal"] [data-testid="${targetProjectTestId}"]`,
      { visible: true }
    )
    const targetWorkspaceSelector =
      '[data-testid="ai-chat-modal"] [data-testid^="project-workspace-option-"]'
    if (
      Number(
        await control.command('getElementCount', targetWorkspaceSelector, {
          visible: true,
        })
      ) > 0
    ) {
      await control.command('clickWhenEnabled', targetWorkspaceSelector, {
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
    }
    await control.command(
      'waitFor',
      '[data-testid="ai-chat-modal"] [data-testid="project-work-button"]',
      {
        timeoutMs: uiTimeoutMs,
        text: selectedTargetProjectName,
        visible: true,
      }
    )
    const switchedComposerSnapshot = JSON.parse(await control.command('snapshot', 'body'))
    assert.equal(
      switchedComposerSnapshot.location,
      issueComposerSnapshot.location,
      'Switching the Issue task runtime project navigated away from the board'
    )
    assert.ok(
      switchedComposerSnapshot.testIds.includes('ai-chat-modal'),
      'Switching the Issue task runtime project closed the right-side composer'
    )
    await control.command('fill', workflowTaskInput, {
      value: '执行真实后端阶段任务绑定验证',
    })
    await control.command('press', workflowTaskInput, { key: 'Enter' })
    const workflowBindings = await waitForValue(
      () => cloudRequest(`/api/v1/loop-items/${workflowIssue.id}/tasks`),
      bindings => bindings.some(binding => binding.workflow_node_id === 'stage-1'),
      'The created task was not persisted against workflow stage-1',
      uiTimeoutMs * 2
    )
    const workflowBinding = workflowBindings.find(binding => binding.workflow_node_id === 'stage-1')
    assert.ok(workflowBinding)
    const workflowTaskRow = `${activeBoard} [data-testid="cloud-todo-open-workflow-task-stage-1-${workflowBinding.id}"]`
    const workflowTaskPanelBack = `${activeBoard} [data-testid="cloud-todo-compact-issue-back"]`
    await control.command('waitFor', workflowTaskPanelBack, {
      timeoutMs: uiTimeoutMs,
      visible: true,
    })
    await control.command('click', workflowTaskPanelBack, { visible: true })
    await control.command(
      'waitFor',
      `${activeBoard} [data-testid="cloud-todo-panel-stack"][data-conversation-open="false"]`,
      {
        timeoutMs: uiTimeoutMs,
        visible: true,
      }
    )
    await control.command('waitFor', `${activeBoard} [data-testid="cloud-todo-detail-title"]`, {
      text: workflowIssue.title,
      timeoutMs: uiTimeoutMs,
    })
    await control.command('waitFor', workflowTaskRow, {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('scrollIntoView', workflowTaskRow)
    await control.command('waitFor', workflowTaskRow, {
      timeoutMs: uiTimeoutMs,
      visible: true,
    })
    await captureScreenshot(control, 'project-automation-00-real-workflow-task-binding.png')

    const readyCountBeforeWorkflowBindingReload = control.readyCount
    await control.command('reloadMainWindow', 'body')
    await withTimeout(
      control.awaitReadyAfter(readyCountBeforeWorkflowBindingReload),
      uiTimeoutMs * 3,
      'The Wework WebView did not reconnect while verifying persisted workflow binding'
    )
    await control.command('waitFor', projectSelector, { timeoutMs: uiTimeoutMs })
    await control.command('click', projectSelector)
    await control.command('waitFor', `${activeBoard} [data-testid="cloud-project-board-view"]`, {
      timeoutMs: uiTimeoutMs,
      visible: true,
    })
    await control.command('click', `${activeBoard} [data-testid="cloud-project-board-view"]`, {
      visible: true,
    })
    const workflowIssueCard = `${activeBoard} [data-testid="cloud-todo-card-${workflowIssue.id}"]`
    await control.command('waitFor', workflowIssueCard, {
      text: workflowIssue.title,
      timeoutMs: uiTimeoutMs,
      visible: true,
    })
    await control.command('click', workflowIssueCard, { visible: true })
    await control.command('waitFor', `${activeBoard} [data-testid="cloud-todo-detail-title"]`, {
      text: workflowIssue.title,
      timeoutMs: uiTimeoutMs,
    })
    await control.command('waitFor', workflowTaskRow, {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('scrollIntoView', workflowTaskRow)
    await control.command('waitFor', workflowTaskRow, {
      timeoutMs: uiTimeoutMs,
      visible: true,
    })
    await control.command('click', `${activeBoard} [data-testid="cloud-todo-detail-close"]`, {
      visible: true,
    })
    await waitForValue(
      async () => JSON.parse(await control.command('snapshot', activeBoard)),
      snapshot =>
        !snapshot.testIds.includes('cloud-todo-workflow-dag') &&
        !snapshot.testIds.some(testId => testId.startsWith('cloud-todo-workflow-node-')),
      'Workflow nodes remained mounted after closing the Issue detail panel',
      uiTimeoutMs
    )
    await control.command('click', `${activeBoard} [data-testid="cloud-project-automation-view"]`, {
      visible: true,
    })
    await control.command('waitFor', `${activeBoard} [data-testid="project-automation-view"]`, {
      timeoutMs: uiTimeoutMs,
      visible: true,
    })

    await control.command('click', '[data-testid="automation-create-rule"]')
    await control.command('waitFor', '[data-testid="automation-rule-editor"]', {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('waitFor', '[data-testid="automation-trigger-node"].selected', {
      timeoutMs: uiTimeoutMs,
      visible: true,
    })
    await control.command('waitFor', '[data-testid="automation-editor-rightbar"]', {
      timeoutMs: uiTimeoutMs,
      visible: true,
    })
    await control.command('click', '[data-testid="workspace-tab-select-fixed-task"]')
    await control.command('waitFor', '[data-testid="desktop-empty-composer-frame"]', {
      timeoutMs: uiTimeoutMs,
      visible: true,
    })
    await control.command('waitFor', '[data-testid="automation-trigger-node"]', {
      timeoutMs: uiTimeoutMs,
      visible: false,
      stableMs: 250,
    })
    await captureScreenshot(control, 'project-automation-01-inactive-canvas-isolated.png')
    await control.command('click', boardWorkspaceTabSelector)
    await control.command('waitFor', '[data-testid="automation-trigger-node"].selected', {
      timeoutMs: uiTimeoutMs,
      visible: true,
    })
    await control.command('waitFor', '[data-testid="automation-editor-rightbar"]', {
      timeoutMs: uiTimeoutMs,
      visible: true,
    })
    await control.command('click', '[data-testid="automation-workflow-canvas"]', {
      visible: true,
    })
    await waitForValue(
      async () =>
        JSON.parse(await control.command('snapshot', '[data-testid="automation-rule-editor"]')),
      snapshot => !snapshot.testIds.includes('automation-editor-rightbar'),
      'Automation detail panel remained visible after clearing the canvas selection',
      uiTimeoutMs
    )
    await control.command('waitFor', '[data-testid="automation-trigger-node"]', {
      timeoutMs: uiTimeoutMs,
      visible: true,
      stableMs: 250,
    })
    await control.command('click', '[data-testid="automation-trigger-node"]', {
      visible: true,
    })
    await control.command('waitFor', '[data-testid="automation-editor-rightbar"]', {
      timeoutMs: uiTimeoutMs,
      visible: true,
    })
    await control.command('click', '[data-testid="automation-editor-name"]')
    await control.command('fill', '[data-testid="automation-editor-name-input"]', {
      value: '统一自动化回归',
    })
    await control.command('press', '[data-testid="automation-editor-name-input"]', {
      key: 'Enter',
    })
    await control.command('click', '[data-testid="automation-node-insert-after-trigger"]')
    await control.command('click', '[data-testid="automation-node-insert-after-task-trigger"]')
    await control.command('waitFor', '[data-testid^="execution-node-name-"]', {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('waitFor', '[data-testid="automation-editor-global-actions"]', {
      text: '等待补全',
      timeoutMs: uiTimeoutMs,
    })
    await control.command('press', '[data-testid^="execution-node-"]', {
      key: 'Backspace',
    })
    const deletedNodeSnapshot = JSON.parse(
      await control.command('snapshot', '[data-testid="automation-rule-editor"]')
    )
    assert.ok(
      !deletedNodeSnapshot.testIds.some(testId => testId.startsWith('execution-node-')),
      'Backspace did not delete the selected workflow node'
    )
    await control.command('click', '[data-testid="automation-node-insert-after-trigger"]')
    await control.command('click', '[data-testid="automation-node-insert-after-task-trigger"]')
    await control.command('waitFor', '[data-testid^="execution-node-name-"]', {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('fill', '[data-testid^="execution-node-name-"]', {
      value: '实现与验证',
    })
    await control.command('fill', '[data-testid^="execution-node-prompt-"]', {
      value: '根据 Issue 修改代码并运行相关测试。',
    })
    const automationExecutionEnvironment = '[data-testid^="execution-node-environment-"]'
    await control.command('scrollIntoView', automationExecutionEnvironment)
    await control.command('waitFor', automationExecutionEnvironment, {
      timeoutMs: uiTimeoutMs,
      visible: true,
    })
    await control.command('click', automationExecutionEnvironment, { visible: true })
    await control.command(
      'click',
      `[data-testid^="execution-node-environment-"][data-testid$="-option-${CLOUD_DEVICE_ID}"]`,
      { visible: true }
    )
    await control.command('select', '[data-testid^="execution-node-model-"]', {
      value: CLOUD_MODEL_NAME,
    })
    await control.command('select', '[data-testid^="execution-node-workspace-"]', {
      value: 'composer',
    })
    await control.command('click', '[data-testid^="execution-node-add-deliverable-"]', {
      visible: true,
    })
    await control.command('fill', '[data-testid^="execution-node-deliverable-name-"]', {
      value: '实现文件',
    })
    await control.command('select', '[data-testid^="execution-node-deliverable-type-"]', {
      value: 'file',
    })
    await control.command('waitFor', '[data-testid^="automation-node-insert-after-step-"]', {
      timeoutMs: uiTimeoutMs,
      visible: true,
    })
    await control.command('click', '[data-testid^="automation-node-insert-after-step-"]')
    await control.command('click', '[data-testid^="automation-node-insert-after-dynamic-step-"]')
    await control.command('waitFor', '[data-testid^="dag-stage-add-first-"]', {
      timeoutMs: uiTimeoutMs,
      visible: true,
    })
    await control.command('click', '[data-testid^="dag-stage-add-first-"]', {
      visible: true,
    })
    await control.command('waitFor', '[data-testid^="dag-stage-insert-after-"]', {
      timeoutMs: uiTimeoutMs,
      visible: true,
    })
    await control.command(
      'click',
      '[data-testid^="ai-allocation-node-"] .react-flow-group-header',
      {
        visible: true,
      }
    )
    await control.command('waitFor', '[data-testid="ai-coordinator-prompt"]', {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('click', '[data-testid^="execution-node-step-"]', {
      visible: true,
    })
    await control.command('click', '[data-testid="automation-canvas-fit-view"]', {
      visible: true,
    })
    await control.command('hover', '[data-testid^="execution-node-step-"]', {
      visible: true,
    })
    await control.command('waitFor', '[data-testid^="automation-node-insert-before-step-"]', {
      timeoutMs: uiTimeoutMs,
      visible: true,
    })
    const insertHoverSnapshot = JSON.parse(
      await control.command('snapshot', '[data-testid="automation-rule-editor"]')
    )
    assert.ok(
      insertHoverSnapshot.testIds.some(testId =>
        testId.startsWith('automation-node-insert-before-step-')
      ),
      'Workflow stages did not expose their predecessor insertion controls'
    )
    assert.ok(
      insertHoverSnapshot.testIds.some(testId =>
        testId.startsWith('automation-node-insert-after-step-')
      ),
      'Workflow stages did not expose their successor insertion controls'
    )
    assert.ok(
      !insertHoverSnapshot.testIds.some(testId => testId.startsWith('automation-insert-node-')),
      'The obsolete trailing insertion node remained mounted'
    )
    await captureScreenshot(control, 'project-automation-node-insert-hover.png')
    await captureScreenshot(control, 'project-automation-00-unified-editor.png')
    await control.command('waitFor', '[data-testid="automation-editor-global-actions"]', {
      text: '已保存',
      timeoutMs: uiTimeoutMs,
    })
    const unifiedRule = await waitForValue(
      () => cloudRequest(`/api/v1/cloud-projects/${projectId}/automations`),
      items => items.find(item => item.name === '统一自动化回归'),
      'Unified automation was not persisted by the real backend',
      uiTimeoutMs
    ).then(items => items.find(item => item.name === '统一自动化回归'))
    assert.equal(unifiedRule.assignmentMode, 'manual')
    assert.equal(unifiedRule.roleSource, 'generic')
    assert.equal(unifiedRule.runtimeSource, 'runtime_user')
    assert.equal(unifiedRule.eventType, 'task.created')
    assert.equal(unifiedRule.eventConfig.wework_flow.description, '')
    const unifiedExecutionConfig =
      unifiedRule.eventConfig.runtime_workflow_definition.nodes[0].execution_config
    assert.equal(unifiedExecutionConfig.execution_device_id, CLOUD_DEVICE_ID)
    assert.equal(unifiedExecutionConfig.model, CLOUD_MODEL_NAME)
    assert.equal(unifiedExecutionConfig.model_type, 'public')
    assert.equal(unifiedExecutionConfig.model_options.weworkCloudModelNamespace, 'default')
    assert.equal(unifiedExecutionConfig.model_options.weworkCloudModelResourceUserId, '0')
    assert.deepEqual(unifiedExecutionConfig.workspace_binding, { type: 'standalone' })
    const unifiedGraphNodes = unifiedRule.eventConfig.wework_flow.graph.nodes
    assert.equal(unifiedGraphNodes.length, 2)
    const unifiedDeliverable = unifiedGraphNodes[0].deliverables[0]
    assert.ok(unifiedDeliverable?.id)
    assert.deepEqual(unifiedDeliverable, {
      id: unifiedDeliverable.id,
      name: '实现文件',
      description: '',
      valueType: 'file',
      fileConstraints: {
        accepted_types: [],
        min_files: 1,
        max_files: 1,
      },
    })
    assert.deepEqual(
      unifiedRule.eventConfig.runtime_workflow_definition.nodes[0].required_deliverables,
      [
        {
          id: unifiedDeliverable.id,
          name: '实现文件',
          description: '',
          value_type: 'file',
          file_constraints: {
            accepted_types: [],
            min_files: 1,
            max_files: 1,
          },
        },
      ]
    )
    assert.equal(unifiedGraphNodes[1].kind, 'dynamic')
    assert.equal(unifiedGraphNodes[1].subgraph.nodes.length, 1)

    const executionPrompt = '[data-testid^="execution-node-prompt-"]'
    const unsavedPrompt = '尚未保存的自动化输入必须保留。'
    await control.command('click', '[data-testid^="execution-node-step-"]', {
      visible: true,
    })
    await control.command('fill', executionPrompt, { value: unsavedPrompt })
    await control.command('click', '[data-testid="workspace-tab-select-fixed-task"]')
    await control.command('waitFor', '[data-testid="desktop-empty-composer-frame"]', {
      timeoutMs: uiTimeoutMs,
      visible: true,
    })
    await control.command('click', boardWorkspaceTabSelector)
    await control.command('waitFor', executionPrompt, {
      timeoutMs: uiTimeoutMs,
      visible: true,
    })
    assert.equal(
      await control.command('getValue', executionPrompt),
      unsavedPrompt,
      'Automation editor lost unsaved input after its parent workspace rerendered'
    )
    await captureScreenshot(control, 'project-automation-unsaved-draft-preserved.png')
    await control.command('fill', executionPrompt, {
      value: '根据 Issue 修改代码并运行相关测试。',
    })
    await control.command('waitFor', '[data-testid="automation-editor-global-actions"]', {
      text: '已保存',
      timeoutMs: uiTimeoutMs,
      visible: true,
    })

    await disableRule(projectId, unifiedRule)
    const projectWithWorkflow = await cloudRequest(`/api/v1/cloud-projects/${projectId}`)
    await cloudRequest(`/api/v1/cloud-projects/${projectId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        version: projectWithWorkflow.version,
        workflow_definition: null,
      }),
    })

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
    const aiWorkflow = automationRuleId => ({
      version: 1,
      definition_version: 1,
      stage_mode: 'none',
      advancement_policy: 'ai',
      coordinator_prompt: '',
      approval_policy: 'automatic',
      ai_automation_rule_id: automationRuleId,
      orchestration_status: 'idle',
      active_run_id: null,
      active_plan_version: null,
      current_stage_id: null,
      nodes: [],
    })
    const workflowChild = parentId =>
      waitForValue(
        () => cloudRequest(`/api/v1/cloud-projects/${projectId}/loop-items`),
        response =>
          (response.items ?? []).find(
            item => item.parent_id === parentId && item.assignee_agent_id === cloudAgent.id
          ),
        `AI workflow did not create a robot child task for ${parentId}`,
        uiTimeoutMs * 3
      ).then(response =>
        response.items.find(
          item => item.parent_id === parentId && item.assignee_agent_id === cloudAgent.id
        )
      )

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
      runtimeSource: 'fixed_profile',
      runtimeProfileId: cloudRuntimeProfile.id,
      enabled: true,
    })
    const customToolCallsBefore = managerToolCalls
    const customManagerTask = await createTask('API · task.created 自定义 AI 调度', {
      workflow: aiWorkflow(customManagerRule.id),
    })
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
    const customChildTask = await workflowChild(customManagerTask.id)
    const customRobotExecution = await waitForCompletedExecution(
      projectId,
      customChildTask.id,
      'project_robot',
      uiTimeoutMs * 6
    )
    assert.equal(customManagerExecution.automationRunId, customManagerRun.id)
    assert.equal(customRobotExecution.automationRunId, customManagerRun.id)
    assert.ok(
      managerToolCalls > customToolCallsBefore,
      'Custom AI manager did not call submit_workflow_plan'
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
    await control.command(
      'waitFor',
      `${activeBoard} [data-testid="cloud-todo-open-child-task-${customChildTask.id}"]`,
      {
        text: customChildTask.title,
        timeoutMs: uiTimeoutMs,
        visible: true,
      }
    )
    const managerExecutionCard = `${activeBoard} [data-testid="cloud-todo-workflow-manager-run"]`
    await control.command('waitFor', managerExecutionCard, {
      text: '查看执行细节',
      timeoutMs: uiTimeoutMs,
    })
    await control.command('scrollIntoView', managerExecutionCard)
    await control.command('waitFor', managerExecutionCard, {
      text: '查看执行细节',
      timeoutMs: uiTimeoutMs,
      visible: true,
    })
    await control.command('click', managerExecutionCard, { visible: true })
    await control.command('waitFor', '[data-testid="runtime-execution-detail-overlay"]', {
      timeoutMs: uiTimeoutMs,
      visible: true,
    })
    await control.command('click', '[data-testid="runtime-execution-detail-close"]', {
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
        text.split('已通过看板工具提交编排方案。').length >= 3 &&
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
    const wegentManagerTask = await createTask('API · task.created Wegent 智能体调度', {
      workflow: aiWorkflow(wegentManagerRule.id),
    })
    const wegentManagerRun = await waitForSucceededRun(
      projectId,
      wegentManagerRule.id,
      wegentManagerTask.id
    )
    assert.ok(wegentManagerRun.backendTaskId > 0, 'Wegent manager did not persist its Backend Task')
    const wegentChildTask = await workflowChild(wegentManagerTask.id)
    const wegentRobotExecution = await waitForCompletedExecution(
      projectId,
      wegentChildTask.id,
      'project_robot'
    )
    assert.equal(wegentRobotExecution.automationRunId, wegentManagerRun.id)
    assert.ok(
      managerToolCalls > wegentToolCallsBefore,
      'Wegent manager did not call submit_workflow_plan'
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
    const readyCount = control.readyCount
    await control.command('reloadMainWindow', 'body')
    await withTimeout(
      control.awaitReadyAfter(readyCount),
      uiTimeoutMs * 3,
      'The board did not reconnect for hourly automation verification'
    )
    const scheduleProjectSelector = `[data-testid="cloud-sidebar-project-${projectId}"]`
    await control.command('waitFor', scheduleProjectSelector, { visible: true })
    await control.command('click', scheduleProjectSelector, { visible: true })
    await control.command('waitFor', '[data-testid="cloud-project-automation-view"]', {
      visible: true,
    })
    await control.command('click', '[data-testid="cloud-project-automation-view"]', {
      visible: true,
    })
    const scheduleCard = `[data-testid="automation-card-${scheduleRule.id}"]`
    await control.command('waitFor', scheduleCard, { visible: true })
    await control.command('click', scheduleCard, { visible: true })
    await control.command('select', '[data-testid="automation-trigger-frequency"]', {
      value: 'hourly',
    })
    await control.command('select', '[data-testid="automation-trigger-minute"]', { value: '59' })
    await control.command('waitFor', '[data-testid="automation-run"][disabled]', {
      visible: true,
    })
    await control.command('waitFor', '[data-testid="automation-editor-global-actions"]', {
      text: '已保存',
    })
    const persistedSchedule = await cloudRequest(
      `/api/v1/cloud-projects/${projectId}/automations`
    ).then(items => items.find(item => item.id === scheduleRule.id))
    assert.equal(persistedSchedule.cronExpression, '59 * * * *')
    assert.equal(persistedSchedule.timezone, 'Asia/Shanghai')
    await control.command('clickWhenEnabled', '[data-testid="automation-run"]')
    const queuedScheduleRun = await waitForValue(
      () => cloudRequest(`/api/v1/cloud-projects/${projectId}/automations/${scheduleRule.id}/runs`),
      items => items.some(item => item.trigger === 'manual'),
      'Editor run did not reach the real backend',
      uiTimeoutMs
    ).then(items => items.find(item => item.trigger === 'manual'))
    await control.command('click', '[data-testid="automation-editor-back"]')
    await control.command('waitFor', scheduleCard, { text: '59', visible: true })
    await control.command('clickWhenEnabled', `[data-testid="automation-run-${scheduleRule.id}"]`)
    const cardRun = await waitForValue(
      () => cloudRequest(`/api/v1/cloud-projects/${projectId}/automations/${scheduleRule.id}/runs`),
      items => items.some(item => item.trigger === 'manual' && item.id !== queuedScheduleRun.id),
      'Card run did not reach the real backend',
      uiTimeoutMs
    ).then(items =>
      items.find(item => item.trigger === 'manual' && item.id !== queuedScheduleRun.id)
    )
    await control.command('waitFor', scheduleCard, { visible: true })
    await control.command('click', scheduleCard)
    assert.equal(
      await control.command('getValue', '[data-testid="automation-trigger-frequency"]'),
      'hourly'
    )
    assert.equal(
      await control.command('getValue', '[data-testid="automation-trigger-minute"]'),
      '59'
    )
    await captureScreenshot(control, 'project-automation-hourly-manual-run.png')
    await waitForSucceededRun(projectId, scheduleRule.id, cardRun.taskId, uiTimeoutMs * 6)
    assert.ok(queuedScheduleRun.taskId, 'Run-now did not create its board task')
    const scheduleRun = await waitForSucceededRun(
      projectId,
      scheduleRule.id,
      queuedScheduleRun.taskId,
      uiTimeoutMs * 6
    )
    const scheduleExecution = await waitForCompletedExecution(
      projectId,
      scheduleRun.taskId,
      'generic_robot'
    )
    const boardItems = await cloudRequest(`/api/v1/cloud-projects/${projectId}/loop-items`)
    const scheduledTask = boardItems.items.find(item => item.id === scheduleRun.taskId)
    assert.ok(scheduledTask, 'Scheduled task was not projected back to the board')
    assert.equal(scheduledTask.workflow.nodes[0].status, 'completed')
    assert.equal(
      scheduleExecution.automationRunId,
      scheduledTask.workflow.nodes[0].automation_run_id
    )
    await disableRule(projectId, persistedSchedule)
    for (const task of [directTeamTask, manualEventTask, customManagerTask, wegentManagerTask]) {
      assert.ok(
        boardItems.items.some(item => item.id === task.id),
        `API-created task ${task.id} was not projected back to the board`
      )
    }
    await captureScreenshot(control, 'project-automation-05-public-api-matrix.png')
  }

  return {
    requiresCloudEnvironment: true,

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
        upstreamResponseRequests.push(payload)
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
        if (
          serialized.includes(FIRST_CONTINUATION_PROMPT) &&
          !serialized.includes(QUEUED_CONTINUATION_PROMPT)
        ) {
          response.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          })
          response.flushHeaders()
          response.write(createSse([responseCreated(responseId)]))
          resolveFirstContinuationStarted()
          await firstContinuationRelease
          response.end(
            createSse([assistantMessage('首条追加执行已完成。'), responseCompleted(responseId)])
          )
          return true
        }
        if (serialized.includes(MOONSHOT_OVERRIDE_FOLLOW_UP)) {
          writeEvents([
            responseCreated(responseId),
            assistantMessage(MOONSHOT_OVERRIDE_FOLLOW_UP_COMPLETION),
            responseCompleted(responseId),
          ])
          return true
        }
        if (serialized.includes('请确认当前分派结果')) {
          writeEvents([
            responseCreated(responseId),
            assistantMessage('已通过看板工具提交编排方案。'),
            responseCompleted(responseId),
          ])
          return true
        }
        const isManagerRequest = serialized.includes('你是看板的 AI 管家')
        if (isManagerRequest) {
          assert.ok(cloudAgent?.id, 'AI manager ran before the project robot was prepared')
          const plan = {
            summary: '创建一个可独立验收的开发子任务。',
            items: [
              {
                client_key: 'implement',
                title: '实现并验证自动化任务',
                description: '完成 Issue 中的工作并提交可复核结果。',
                assignee_type: 'agent',
                assignee_id: cloudAgent.id,
                assignee_name: cloudAgent.name,
                rationale: '该机器人具备对应的软件开发能力。',
              },
            ],
          }
          const searchItemCallId = 'project-automation-search-board-item'
          const readItemCallId = 'project-automation-read-board-item'
          const searchCandidatesCallId = 'project-automation-search-candidates'
          const candidatesCallId = 'project-automation-read-candidates'
          const searchSubmitCallId = 'project-automation-search-submit-plan'
          const submitCallId = 'project-automation-submit-workflow-plan'
          const requestManagerTool = ({ toolName, argumentsValue, searchCallId, toolCallId }) => {
            const advertisedToolNames = new Set(
              (Array.isArray(payload.tools) ? payload.tools : [])
                .map(tool => tool?.name ?? tool?.function?.name)
                .filter(Boolean)
            )
            const directToolName = [
              `wework_space__${toolName}`,
              `wegent-wework-space_${toolName}`,
            ].find(candidate => advertisedToolNames.has(candidate))
            const selection = mcpToolRequestEvents(payload, {
              toolName,
              argumentsValue,
              directToolName,
              searchCallId,
              toolCallId,
            })
            writeEvents([
              responseCreated(responseId),
              ...selection.events,
              responseCompleted(responseId),
            ])
            return selection.mode
          }
          if (requestContainsToolOutput(payload, submitCallId)) {
            writeEvents([
              responseCreated(responseId),
              assistantMessage('已通过看板工具提交编排方案。'),
              responseCompleted(responseId),
            ])
            return true
          }
          if (requestContainsToolOutput(payload, searchSubmitCallId)) {
            const tool = selectMcpTool(payload, 'wework_space', 'submit_workflow_plan', {
              plan,
            })
            managerToolCalls += 1
            writeEvents([
              responseCreated(responseId),
              ...namespacedFunctionCall(submitCallId, tool.namespace, tool.name, tool.arguments),
              responseCompleted(responseId),
            ])
            return true
          }
          if (requestContainsToolOutput(payload, candidatesCallId)) {
            const mode = requestManagerTool({
              toolName: 'submit_workflow_plan',
              argumentsValue: { plan },
              searchCallId: searchSubmitCallId,
              toolCallId: submitCallId,
            })
            if (mode === 'direct') managerToolCalls += 1
            return true
          }
          if (requestContainsToolOutput(payload, searchCandidatesCallId)) {
            const tool = selectMcpTool(payload, 'wework_space', 'get_assignment_candidates', {})
            writeEvents([
              responseCreated(responseId),
              ...namespacedFunctionCall(
                candidatesCallId,
                tool.namespace,
                tool.name,
                tool.arguments
              ),
              responseCompleted(responseId),
            ])
            return true
          }
          if (requestContainsToolOutput(payload, readItemCallId)) {
            requestManagerTool({
              toolName: 'get_assignment_candidates',
              argumentsValue: {},
              searchCallId: searchCandidatesCallId,
              toolCallId: candidatesCallId,
            })
            return true
          }
          if (requestContainsToolOutput(payload, searchItemCallId)) {
            const tool = selectMcpTool(payload, 'wework_space', 'get_board_item', {})
            writeEvents([
              responseCreated(responseId),
              ...namespacedFunctionCall(readItemCallId, tool.namespace, tool.name, tool.arguments),
              responseCompleted(responseId),
            ])
            return true
          }
          requestManagerTool({
            toolName: 'get_board_item',
            argumentsValue: {},
            searchCallId: searchItemCallId,
            toolCallId: readItemCallId,
          })
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
        json(response, 200, { items: [uiProject] })
        return true
      }
      if (request.method === 'PATCH' && url.pathname === `/api/v1/cloud-projects/${PROJECT_ID}`) {
        const payload = await readJson(request)
        assert.equal(payload.version, uiProject.version)
        uiProject = {
          ...uiProject,
          ...payload,
          version: uiProject.version + 1,
          updated_at: '2026-08-18T08:40:00Z',
        }
        json(response, 200, uiProject)
        return true
      }
      if (
        request.method === 'GET' &&
        url.pathname === `/api/v1/cloud-projects/${PROJECT_ID}/board-snapshot`
      ) {
        const items = [createdBoardItem, createdChildItem].filter(Boolean)
        const itemIds = new Set(items.map(item => item.id))
        json(response, 200, {
          items,
          task_bindings: workflowTaskBindings.filter(binding => itemIds.has(binding.loop_item_id)),
          members: PROJECT_MEMBERS,
          agents: archivedAgentPayload?.status === 'archived' ? [] : [AGENT],
        })
        return true
      }
      if (
        request.method === 'GET' &&
        url.pathname === `/api/v1/cloud-projects/${PROJECT_ID}/loop-items`
      ) {
        json(response, 200, {
          items: [createdBoardItem, createdChildItem].filter(Boolean),
        })
        return true
      }
      const taskBindingsMatch = url.pathname.match(/^\/api\/v1\/loop-items\/(AUTO-\d+)\/tasks$/)
      if (request.method === 'GET' && taskBindingsMatch) {
        json(response, 200, taskBindingsMatch[1] === orchestratedItemId ? workflowTaskBindings : [])
        return true
      }
      const workflowPlanMatch = url.pathname.match(
        /^\/api\/v1\/loop-items\/(AUTO-\d+)\/workflow-plan$/
      )
      if (request.method === 'GET' && workflowPlanMatch) {
        json(response, 200, workflowPlan?.issue_id === workflowPlanMatch[1] ? workflowPlan : null)
        return true
      }
      const approveWorkflowPlanMatch = url.pathname.match(
        /^\/api\/v1\/loop-items\/(AUTO-\d+)\/workflow-plan\/approve$/
      )
      if (
        request.method === 'POST' &&
        approveWorkflowPlanMatch &&
        workflowPlan?.issue_id === approveWorkflowPlanMatch[1]
      ) {
        assert.equal(workflowPlan.status, 'awaiting_approval')
        workflowPlanApprovalRequested = true
        workflowPlan = {
          ...workflowPlan,
          status: 'dispatching',
        }
        createdBoardItem = {
          ...createdBoardItem,
          workflow: {
            ...createdBoardItem.workflow,
            orchestration_status: 'dispatching',
          },
        }
        json(response, 200, workflowPlan)
        return true
      }
      if (
        request.method === 'POST' &&
        url.pathname === `/api/v1/cloud-projects/${PROJECT_ID}/loop-items`
      ) {
        const payload = await readJson(request)
        const workflowDefinition = uiProject.workflow_definition
        const stageMode =
          workflowDefinition?.stage_mode ?? (workflowDefinition?.nodes?.length > 0 ? 'dag' : 'none')
        const advancementPolicy = workflowDefinition?.advancement_policy ?? 'manual'
        const workflow =
          workflowDefinition && (stageMode === 'dag' || advancementPolicy === 'ai')
            ? {
                version: 1,
                definition_version: workflowDefinition.version,
                stage_mode: stageMode,
                advancement_policy: advancementPolicy,
                coordinator_prompt: workflowDefinition.coordinator_prompt ?? '',
                ai_automation_rule_id: workflowDefinition.ai_automation_rule_id ?? null,
                nodes:
                  stageMode === 'dag'
                    ? workflowDefinition.nodes.map(node => ({
                        ...node,
                        status: node.depends_on.length === 0 ? 'ready' : 'blocked',
                        task_binding_id: null,
                        task_ids: [],
                        task_statuses: {},
                        execution_id: null,
                        automation_run_id: null,
                      }))
                    : [],
              }
            : null
        const sequenceNumber = nextBoardItemSequence
        nextBoardItemSequence += 1
        createdBoardItem = {
          id: `AUTO-${sequenceNumber}`,
          cloud_project_id: PROJECT_ID,
          sequence_number: sequenceNumber,
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
          content_revision: 1,
          is_unread: payload.title === '由智能体评审看板状态',
          version: 1,
          created_at: '2026-08-15T00:00:00Z',
          updated_at: '2026-08-15T00:00:00Z',
          completed_at: null,
          workflow,
        }
        if (payload.title === '预置流程直接开始') {
          assert.ok(
            workflow,
            `Preset workflow fixture did not snapshot orchestration: ${JSON.stringify(workflowDefinition)}`
          )
          orchestratedItemId = createdBoardItem.id
        }
        json(response, 201, createdBoardItem)
        return true
      }
      if (
        request.method === 'POST' &&
        url.pathname === `/api/v1/loop-items/${createdBoardItem?.id}/read`
      ) {
        markBoardItemReadRequests += 1
        createdBoardItem = {
          ...createdBoardItem,
          is_unread: false,
        }
        json(response, 200, createdBoardItem)
        return true
      }
      const boardItemPatchMatch = url.pathname.match(/^\/api\/v1\/loop-items\/(AUTO-\d+)$/)
      if (
        request.method === 'PATCH' &&
        boardItemPatchMatch &&
        boardItemPatchMatch[1] === createdBoardItem?.id
      ) {
        const payload = await readJson(request)
        if (createdBoardItem.id === orchestratedItemId) orchestratedMovePayload = payload
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
        url.pathname === `/api/v1/cloud-projects/${PROJECT_ID}/loop-items/reorder`
      ) {
        const payload = await readJson(request)
        assert.equal(payload.status, createdBoardItem?.status)
        assert.ok(payload.item_ids.includes(createdBoardItem?.id))
        json(response, 200, {
          items: [createdBoardItem, createdChildItem].filter(Boolean),
        })
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
        request.method === 'POST' &&
        url.pathname === `/api/v1/cloud-projects/${PROJECT_ID}/chat-agents`
      ) {
        createdAgentPayload = await readJson(request)
        json(response, 201, {
          ...AGENT,
          ...createdAgentPayload,
          id: 'agent-created-without-model',
          model: createdAgentPayload.model ?? null,
          version: 1,
        })
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
      if (
        request.method === 'PATCH' &&
        url.pathname ===
          `/api/v1/cloud-projects/${PROJECT_ID}/chat-agents/agent-created-without-model`
      ) {
        const payload = await readJson(request)
        json(response, 200, {
          ...AGENT,
          ...createdAgentPayload,
          ...payload,
          id: 'agent-created-without-model',
          version: 2,
        })
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
      if (request.method === 'GET' && url.pathname === '/api/v1/runtime-profiles') {
        json(response, 200, [RUNTIME_PROFILE])
        return true
      }
      return false
    },

    async verify(control) {
      await ensureExperimentalFeaturesEnabled(control)
      if (cloudApi) {
        await createSingleRootLocalProject(control, workspacePath, 'project-automation-primary')
        await createSingleRootLocalProject(
          control,
          join(workspacePath, '..', 'secondary-project-root'),
          'project-automation-secondary'
        )
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
      const reloadActiveBoard = async errorMessage => {
        const readyCount = control.readyCount
        await control.command('reloadMainWindow', 'body')
        await withTimeout(control.awaitReadyAfter(readyCount), uiTimeoutMs * 3, errorMessage)
        await control.command(
          'waitFor',
          `${activeBoard} [data-testid="cloud-project-board-view"]`,
          {
            timeoutMs: uiTimeoutMs,
            visible: true,
          }
        )
      }
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
      await control.command('click', `${activeBoard} [data-testid="cloud-project-board-view"]`, {
        visible: true,
      })
      await control.command('waitFor', `${activeBoard} [data-testid="cloud-todo-add"]`, {
        timeoutMs: uiTimeoutMs,
        visible: true,
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
      await waitForValue(
        () => Promise.resolve(markBoardItemReadRequests),
        count => count === 1,
        'Opening an unread Issue did not persist its read cursor',
        uiTimeoutMs
      )
      const readBoardSnapshot = JSON.parse(await control.command('snapshot', activeBoard))
      assert.equal(
        readBoardSnapshot.testIds.includes('cloud-todo-card-unread-AUTO-201'),
        false,
        'The unread marker remained after opening the Issue'
      )
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
      await control.command('click', `${activeBoard} [data-testid="cloud-todo-detail-close"]`, {
        visible: true,
      })
      await control.command('waitFor', `${activeBoard} [data-testid="cloud-project-ask-ai"]`, {
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      await control.command('click', `${activeBoard} [data-testid="cloud-project-ask-ai"]`, {
        visible: true,
      })

      const projectChatSidebar = '[data-testid="project-space-chat-sidebar"]'
      const projectChatPanel = `${projectChatSidebar} [data-testid="project-space-chat-panel"]`
      const projectChatInput = `${projectChatPanel} [data-testid="chat-message-input"]`
      await control.command('waitFor', projectChatPanel, {
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      await selectE2EModel(
        control,
        PROJECT_CHAT_REMOTE_MODEL_NAME,
        PROJECT_CHAT_REMOTE_MODEL_LABEL,
        projectChatPanel
      )
      const remoteRequestCount = remoteProjectChatRequests.length
      await control.command('fill', projectChatInput, {
        value: CHECKPOINT_TASK_PROMPT,
        visible: true,
      })
      await control.command('press', projectChatInput, { key: 'Enter', visible: true })
      await waitForValue(
        () => Promise.resolve(remoteProjectChatRequests.length),
        count => count === remoteRequestCount + 1,
        'The Backend remote model did not receive the project-chat request',
        uiTimeoutMs
      )
      await control.command('waitFor', projectChatPanel, {
        text: CHECKPOINT_TASK_COMPLETION_TEXT,
        timeoutMs: uiTimeoutMs,
        visible: true,
      })

      const projectChatNew = `${projectChatSidebar} [data-testid="project-space-chat-new"]`
      await control.command('waitFor', projectChatNew, {
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      await control.command('click', projectChatNew, { visible: true })
      await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL, projectChatPanel)
      control.setScenario('checkpoint_task')
      const localRequest = control.awaitScenarioRequest('checkpoint_task')
      await control.command('fill', projectChatInput, {
        value: CHECKPOINT_TASK_PROMPT,
        visible: true,
      })
      await control.command('press', projectChatInput, { key: 'Enter', visible: true })
      const localModelRequest = await withTimeout(
        localRequest,
        uiTimeoutMs,
        'The local Codex model did not receive the project-chat request'
      )
      assert.ok(
        typeof localModelRequest.body.model === 'string' && localModelRequest.body.model.length > 0,
        'Project chat did not execute through the local Codex model server'
      )
      await control.command('waitFor', projectChatPanel, {
        text: CHECKPOINT_TASK_COMPLETION_TEXT,
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      await waitForValue(
        async () => JSON.parse(await control.command('snapshot', projectChatPanel)),
        snapshot =>
          !snapshot.testIds.includes('thinking-indicator') &&
          !snapshot.testIds.includes('message-assistant-waiting') &&
          !snapshot.testIds.includes('pause-response-button'),
        'Project chat remained in the thinking state after the runtime task completed',
        uiTimeoutMs
      )
      await captureScreenshot(control, 'project-chat-model-routing.png')
      await control.command(
        'click',
        `${projectChatSidebar} [data-testid="project-space-chat-close"]`,
        {
          visible: true,
        }
      )

      await control.command(
        'waitFor',
        `${activeBoard} [data-testid="cloud-project-automation-view"]`,
        {
          timeoutMs: uiTimeoutMs,
          visible: true,
        }
      )
      const modelDeadline = Date.now() + uiTimeoutMs
      while (modelRequests === 0 && Date.now() < modelDeadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
      }
      assert.ok(modelRequests >= 1, 'cloud model catalog did not load before the automation view')
      await control.command(
        'click',
        `${activeBoard} [data-testid="cloud-project-automation-view"]`,
        { visible: true }
      )
      await control.command('waitFor', `${activeBoard} [data-testid="project-automation-view"]`, {
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      const activeWorkflow = `${activeBoard} [data-testid="project-workflow-editor"]`
      await control.command(
        'scrollIntoView',
        `${activeBoard} [data-testid="project-automation-rules"]`
      )
      await control.command('waitFor', `${activeBoard} [data-testid="project-automation-rules"]`, {
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      assert.match(
        await control.command(
          'getAttribute',
          `${activeWorkflow} [data-testid="project-workflow-save"]`,
          { value: 'class' }
        ),
        /\bbg-text-primary\b/,
        'The workflow save action did not use the visible Wework primary color'
      )
      await control.command(
        'click',
        `${activeWorkflow} [data-testid="project-workflow-mode-workflow"]`
      )
      await control.command(
        'waitFor',
        `${activeWorkflow} [data-testid="project-workflow-empty-add"]`,
        { timeoutMs: uiTimeoutMs }
      )
      await control.command('click', `${activeWorkflow} [data-testid="project-workflow-empty-add"]`)
      await control.command(
        'waitFor',
        `${activeWorkflow} [data-testid="project-workflow-stage-executor-human-stage-1"]`,
        { timeoutMs: uiTimeoutMs }
      )
      await control.command(
        'waitFor',
        `${activeWorkflow} [data-testid="project-workflow-insert-after-stage-1"]`,
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      const selectedStageSnapshot = JSON.parse(
        await control.command('snapshot', `${activeWorkflow} [data-testid="project-workflow-dag"]`)
      )
      assert.ok(
        selectedStageSnapshot.testIds.includes('project-workflow-insert-before-stage-1'),
        'The selected workflow stage did not expose its predecessor insertion control'
      )
      assert.ok(
        selectedStageSnapshot.testIds.includes('project-workflow-insert-after-stage-1'),
        'The selected workflow stage did not expose its successor insertion control'
      )
      await control.command(
        'click',
        `${activeWorkflow} [data-testid="project-workflow-insert-after-stage-1"]`
      )
      await control.command(
        'waitFor',
        `${activeWorkflow} [data-testid="project-workflow-stage-stage-2"]`,
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      const insertedStageSnapshot = JSON.parse(
        await control.command('snapshot', `${activeWorkflow} [data-testid="project-workflow-dag"]`)
      )
      assert.ok(
        insertedStageSnapshot.testIds.includes('project-workflow-insert-after-stage-2'),
        'The inserted workflow stage did not become selected'
      )
      assert.equal(
        insertedStageSnapshot.testIds.includes('project-workflow-insert-after-stage-1'),
        false,
        'Insertion controls remained visible on an unselected workflow stage'
      )
      await control.command(
        'waitFor',
        `${activeWorkflow} [data-testid="project-workflow-edge-stage-1-stage-2"]`,
        { timeoutMs: uiTimeoutMs }
      )
      await control.command(
        'press',
        `${activeWorkflow} [data-testid="project-workflow-edge-stage-1-stage-2"]`,
        { key: 'Enter' }
      )
      await control.command(
        'press',
        `${activeWorkflow} [data-testid="project-workflow-edge-stage-1-stage-2"]`,
        { key: 'Delete' }
      )
      await control.command(
        'waitFor',
        `${activeWorkflow} [data-testid="project-workflow-edge-stage-1-stage-2"]`,
        {
          visible: false,
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command(
        'waitFor',
        `${activeWorkflow} [data-testid="project-workflow-stage-stage-1"]`,
        { timeoutMs: uiTimeoutMs }
      )
      await control.command(
        'waitFor',
        `${activeWorkflow} [data-testid="project-workflow-stage-stage-2"]`,
        { timeoutMs: uiTimeoutMs }
      )
      await control.command(
        'clickThenMacrotask',
        `${activeWorkflow} [data-testid="project-workflow-stage-stage-1"]`,
        {
          target: `${activeWorkflow} [data-testid="project-workflow-insert-after-stage-1"]`,
        }
      )
      await control.command(
        'waitFor',
        `${activeWorkflow} [data-testid="project-workflow-stage-stage-3"]`,
        { timeoutMs: uiTimeoutMs }
      )
      await control.command(
        'press',
        `${activeWorkflow} [data-testid="project-workflow-edge-stage-1-stage-3"]`,
        { key: 'Enter' }
      )
      await control.command(
        'click',
        `${activeWorkflow} [data-testid="project-workflow-stage-stage-3"]`
      )
      await control.command(
        'press',
        `${activeWorkflow} [data-testid="project-workflow-stage-stage-3"]`,
        { key: 'Backspace' }
      )
      await control.command(
        'waitFor',
        `${activeWorkflow} [data-testid="project-workflow-stage-stage-3"]`,
        {
          visible: false,
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command(
        'waitFor',
        `${activeWorkflow} [data-testid="project-workflow-stage-stage-1"]`,
        { timeoutMs: uiTimeoutMs }
      )
      await control.command(
        'click',
        `${activeWorkflow} [data-testid="project-workflow-stage-stage-1"]`
      )
      await control.command(
        'waitFor',
        `${activeWorkflow} [data-testid="project-workflow-stage-executor-human-stage-1"]`,
        { timeoutMs: uiTimeoutMs }
      )
      const stageInspectorSnapshot = JSON.parse(
        await control.command(
          'snapshot',
          `${activeWorkflow} [data-testid="project-workflow-inspector-stage-1"]`
        )
      )
      assert.equal(
        stageInspectorSnapshot.testIds.includes('project-workflow-stage-automation-stage-1'),
        false,
        'The human execution choice should not show a robot selector'
      )
      await control.command(
        'click',
        `${activeWorkflow} [data-testid="project-workflow-stage-executor-robot-stage-1"]`
      )
      await control.command(
        'scrollIntoView',
        '[data-testid="project-workflow-stage-automation-stage-1"]'
      )
      await control.command('click', '[data-testid="project-workflow-stage-automation-stage-1"]', {
        visible: true,
      })
      await control.command(
        'click',
        `[data-testid="project-workflow-stage-automation-stage-1-option-${AGENT_ID}"]`,
        { visible: true }
      )
      await control.command(
        'waitFor',
        '[data-testid="project-workflow-stage-automation-stage-1"]',
        { text: AGENT.name, timeoutMs: uiTimeoutMs }
      )
      const robotStageSnapshot = JSON.parse(
        await control.command(
          'snapshot',
          `${activeWorkflow} [data-testid="project-workflow-inspector-stage-1"]`
        )
      )
      assert.equal(
        robotStageSnapshot.testIds.includes('project-workflow-stage-runtime-stage-1'),
        false,
        'Robot defaults must not be repeated as a workflow Runtime selector'
      )
      await control.command('click', '[data-testid="project-workflow-stage-automation-stage-1"]', {
        visible: true,
      })
      await control.command('click', '[data-testid="project-workflow-stage-create-robot"]', {
        visible: true,
      })
      await control.command('waitFor', '[data-testid="cloud-project-chat-agent-editor"]', {
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      await captureScreenshot(control, 'project-automation-00-workflow-robot-executor.png')
      await control.command('click', '[data-testid="cloud-project-chat-agent-cancel"]', {
        visible: true,
      })
      await control.command(
        'click',
        `${activeWorkflow} [data-testid="project-workflow-stage-stage-1"]`
      )
      await control.command(
        'click',
        `${activeWorkflow} [data-testid="project-workflow-add-deliverable-stage-1"]`
      )
      await control.command(
        'scrollIntoView',
        '[data-testid="workflow-deliverable-requirement-name-deliverable-1"]'
      )
      await control.command(
        'waitFor',
        '[data-testid="workflow-deliverable-requirement-name-deliverable-1"]',
        { timeoutMs: uiTimeoutMs, visible: true }
      )
      await control.command(
        'fill',
        '[data-testid="workflow-deliverable-requirement-name-deliverable-1"]',
        {
          value: '测试报告',
        }
      )
      await control.command(
        'select',
        '[data-testid="workflow-deliverable-requirement-type-deliverable-1"]',
        {
          value: 'text',
        }
      )
      await control.command('click', '[data-testid="workflow-deliverable-requirements-save"]')
      await waitForValue(
        () => Promise.resolve(uiProject.workflow_definition?.nodes?.[0]?.required_deliverables),
        requirements =>
          requirements?.some(
            requirement =>
              requirement.id === 'deliverable-1' &&
              requirement.name === '测试报告' &&
              requirement.value_type === 'text'
          ),
        'The deliverable requirement was not persisted by the project update',
        uiTimeoutMs
      )
      await control.command('waitFor', `${activeWorkflow} [data-testid="project-workflow-save"]`, {
        enabled: true,
        timeoutMs: uiTimeoutMs,
      })
      uiProject = {
        ...uiProject,
        workflow_definition: {
          version: 1,
          stage_mode: 'dag',
          advancement_policy: 'manual',
          coordinator_prompt: '',
          ai_automation_rule_id: null,
          nodes: [
            {
              id: 'stage-1',
              name: '新阶段 1',
              prompt: '',
              depends_on: [],
              dependency_context: {},
              required: true,
              required_deliverables: [
                {
                  id: 'deliverable-1',
                  name: '测试报告',
                  description: '',
                  value_type: 'text',
                  file_constraints: null,
                },
              ],
              workspace_policy: 'composer',
              automation_rule_id: null,
            },
            {
              id: 'stage-3',
              name: '新阶段 3',
              prompt: '',
              depends_on: ['stage-1'],
              dependency_context: {},
              required: true,
              required_deliverables: [],
              workspace_policy: 'composer',
              automation_rule_id: null,
            },
            {
              id: 'stage-2',
              name: '新阶段 2',
              prompt: '',
              depends_on: ['stage-3'],
              dependency_context: {},
              required: true,
              required_deliverables: [],
              workspace_policy: 'composer',
              automation_rule_id: null,
            },
          ],
        },
      }
      await control.command('click', `${activeBoard} [data-testid="cloud-project-board-view"]`)
      await control.command('waitFor', `${activeBoard} [data-testid="cloud-todo-add"]`, {
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      await control.command('click', `${activeBoard} [data-testid="cloud-todo-add"]`)
      await control.command('fill', `${activeBoard} [data-testid="workspace-issue-input"]`, {
        value: '预置流程直接开始',
      })
      await control.command('click', `${activeBoard} [data-testid="workspace-issue-submit"]`)
      const createdOrchestratedItemId = await waitForValue(
        () => Promise.resolve(orchestratedItemId),
        Boolean,
        'Preset workflow Issue was not created',
        uiTimeoutMs
      )
      await control.command('waitFor', `${activeBoard} [data-testid="cloud-todo-detail-title"]`, {
        text: '预置流程直接开始',
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', `${activeBoard} [data-testid="cloud-todo-detail-close"]`)
      workflowTaskBindings = [
        {
          id: 9103,
          cloud_project_id: PROJECT_ID,
          loop_item_id: orchestratedItemId,
          task_user_id: 9001,
          device_id: 'local-device',
          task_id: 'workflow-task-3',
          task_title: '刚创建，状态尚未同步',
          backend_task_id: null,
          workflow_node_id: 'stage-1',
          linked_by_user_id: 9001,
          linked_at: '2026-08-18T08:43:00Z',
          unlinked_at: null,
        },
        {
          id: 9102,
          cloud_project_id: PROJECT_ID,
          loop_item_id: orchestratedItemId,
          task_user_id: 9001,
          device_id: 'local-device',
          task_id: 'workflow-task-2',
          task_title: '第二次执行',
          backend_task_id: null,
          workflow_node_id: 'stage-1',
          linked_by_user_id: 9001,
          linked_at: '2026-08-18T08:42:00Z',
          unlinked_at: null,
        },
        {
          id: 9101,
          cloud_project_id: PROJECT_ID,
          loop_item_id: orchestratedItemId,
          task_user_id: 9001,
          device_id: 'local-device',
          task_id: 'workflow-task-1',
          task_title: '第一次执行',
          backend_task_id: null,
          workflow_node_id: 'stage-1',
          linked_by_user_id: 9001,
          linked_at: '2026-08-18T08:41:00Z',
          unlinked_at: null,
        },
      ]
      const childSequenceNumber = nextBoardItemSequence
      nextBoardItemSequence += 1
      createdChildItem = {
        ...createdBoardItem,
        id: `AUTO-${childSequenceNumber}`,
        sequence_number: childSequenceNumber,
        parent_id: orchestratedItemId,
        title: 'AI 拆解的实现任务',
        status: 'pending',
        assignee_user_id: null,
        assignee_agent_id: AGENT_ID,
        assignee_agent_name: AGENT.name,
        workflow: null,
      }
      createdBoardItem = {
        ...createdBoardItem,
        workflow: {
          ...createdBoardItem.workflow,
          version: createdBoardItem.workflow.version + 1,
          nodes: createdBoardItem.workflow.nodes.map(node =>
            node.id === 'stage-1'
              ? {
                  ...node,
                  status: 'awaiting_approval',
                  task_ids: [
                    'local-device:workflow-task-3',
                    'local-device:workflow-task-2',
                    'local-device:workflow-task-1',
                  ],
                  task_statuses: {
                    'local-device:workflow-task-2': 'succeeded',
                    'local-device:workflow-task-1': 'failed',
                  },
                }
              : node
          ),
        },
      }
      await reloadActiveBoard(
        'The project board did not reconnect after adding the workflow child task'
      )
      await control.command('click', `${activeBoard} [data-testid="cloud-project-board-view"]`, {
        visible: true,
      })
      await control.command(
        'waitFor',
        `${activeBoard} [data-testid="cloud-todo-card-${createdOrchestratedItemId}"]`,
        {
          text: '预置流程直接开始',
          timeoutMs: uiTimeoutMs,
          visible: true,
        }
      )
      await control.command(
        'drag',
        `${activeBoard} [data-testid="cloud-todo-card-${createdOrchestratedItemId}"]`,
        {
          target: `${activeBoard} [data-testid="cloud-todo-column-dropzone-pending"]`,
        }
      )
      await waitForValue(
        () => Promise.resolve(orchestratedMovePayload),
        payload => payload?.status === 'pending',
        'Preset workflow drag did not move the Issue directly to Pending',
        uiTimeoutMs
      )
      const boardAfterOrchestratedMove = JSON.parse(await control.command('snapshot', activeBoard))
      assert.equal(
        boardAfterOrchestratedMove.testIds.includes('ai-chat-modal'),
        false,
        'Preset workflow drag opened the manual task Composer'
      )
      await control.command(
        'click',
        `${activeBoard} [data-testid="cloud-todo-card-${createdOrchestratedItemId}"]`,
        {
          visible: true,
        }
      )
      await control.command('waitFor', `${activeBoard} [data-testid="cloud-todo-detail"]`, {
        text: '预置流程直接开始',
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      await control.command(
        'waitFor',
        `${activeBoard} [data-testid="cloud-todo-workflow-action-stage-1"]`,
        {
          text: '待人工批准',
          timeoutMs: uiTimeoutMs,
          visible: true,
        }
      )
      await control.command(
        'waitFor',
        `${activeBoard} [data-testid="cloud-todo-workflow-node-stage-3"]`,
        {
          timeoutMs: uiTimeoutMs,
          visible: true,
        }
      )
      await control.command(
        'click',
        `${activeBoard} [data-testid="cloud-todo-workflow-node-stage-3"]`,
        {
          visible: true,
        }
      )
      await control.command(
        'waitFor',
        `${activeBoard} [data-testid="cloud-todo-workflow-action-stage-3"]`,
        {
          text: '等待前置任务',
          timeoutMs: uiTimeoutMs,
          visible: true,
        }
      )
      await control.command(
        'waitFor',
        `${activeBoard} [data-testid="cloud-todo-workflow-node-stage-1"]`,
        {
          timeoutMs: uiTimeoutMs,
          visible: true,
        }
      )
      await control.command(
        'click',
        `${activeBoard} [data-testid="cloud-todo-workflow-node-stage-1"]`,
        {
          visible: true,
        }
      )
      await control.command(
        'waitFor',
        `${activeBoard} [data-testid="cloud-todo-workflow-action-stage-1"]`,
        {
          text: '待人工批准',
          timeoutMs: uiTimeoutMs,
          visible: true,
        }
      )
      await control.command(
        'scrollIntoView',
        `${activeBoard} [data-testid="cloud-todo-workflow-task-status-stage-1-9103"]`
      )
      await control.command(
        'waitFor',
        `${activeBoard} [data-testid="cloud-todo-workflow-task-status-stage-1-9103"]`,
        {
          text: '等待执行',
          timeoutMs: uiTimeoutMs,
          visible: true,
        }
      )
      await control.command(
        'waitFor',
        `${activeBoard} [data-testid="cloud-todo-workflow-task-status-stage-1-9102"]`,
        {
          text: '成功',
          timeoutMs: uiTimeoutMs,
          visible: true,
        }
      )
      const failedWorkflowTaskStatus = `${activeBoard} [data-testid="cloud-todo-workflow-task-status-stage-1-9101"]`
      await control.command('scrollIntoView', failedWorkflowTaskStatus)
      await control.command('waitFor', failedWorkflowTaskStatus, {
        text: '失败',
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      await control.command(
        'waitFor',
        `${activeBoard} [data-testid="cloud-todo-workflow-action-stage-1"]`,
        {
          text: '测试报告',
          timeoutMs: uiTimeoutMs,
          visible: true,
        }
      )
      await control.command(
        'waitFor',
        `${activeBoard} [data-testid="cloud-todo-approve-workflow-node-stage-1"]`,
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await captureScreenshot(
        control,
        'project-automation-00-workflow-task-statuses.png',
        `${activeBoard} [data-testid="cloud-todo-detail"]`
      )

      const aiManagedItemId = `AUTO-${nextBoardItemSequence++}`
      const aiManagedChildId = `AUTO-${nextBoardItemSequence++}`
      createdBoardItem = {
        ...createdBoardItem,
        id: aiManagedItemId,
        sequence_number: Number(aiManagedItemId.split('-')[1]),
        parent_id: null,
        title: 'AI 管家持续编排',
        status: 'pending',
        workflow: {
          version: 1,
          definition_version: 1,
          stage_mode: 'none',
          advancement_policy: 'ai',
          approval_policy: 'required',
          orchestration_status: 'planning',
          active_run_id: 'workflow-run-e2e',
          active_plan_version: 1,
          current_stage_id: null,
          nodes: [],
        },
      }
      createdChildItem = null
      workflowPlan = {
        run_id: 'workflow-run-e2e',
        issue_id: aiManagedItemId,
        stage_id: '__issue__',
        plan_version: 1,
        approval_policy: 'required',
        status: 'planning',
        summary: '',
        items: [],
        manager_run: {
          id: 'manager-run-e2e',
          status: 'running',
          model: MODEL_NAME,
          execution_environment: 'cloud',
          device_id: CLOUD_DEVICE_ID,
          recent_activity: '正在读取 Issue 并生成编排方案',
          error: null,
          updated_at: '2026-08-20T10:00:00Z',
        },
      }
      await reloadActiveBoard(
        'The project board did not reconnect for AI manager projection verification'
      )
      await control.command('click', `${activeBoard} [data-testid="cloud-project-board-view"]`, {
        visible: true,
      })
      await control.command(
        'click',
        `${activeBoard} [data-testid="cloud-todo-card-${aiManagedItemId}"]`,
        { visible: true }
      )
      await control.command(
        'waitFor',
        `${activeBoard} [data-testid="cloud-todo-workflow-manager-run"]`,
        {
          text: '正在读取 Issue 并生成编排方案',
          timeoutMs: uiTimeoutMs,
          visible: true,
        }
      )

      createdBoardItem = {
        ...createdBoardItem,
        workflow: {
          ...createdBoardItem.workflow,
          orchestration_status: 'awaiting_approval',
        },
      }
      workflowPlan = {
        ...workflowPlan,
        status: 'awaiting_approval',
        summary: '实现并验证 AI 编排生命周期',
        items: [
          {
            id: 'workflow-plan-item-approval-e2e',
            client_key: 'implement-approval',
            stage_id: '__issue__',
            title: '实现 AI 编排生命周期',
            description: '确认后创建并启动子任务',
            assignee_type: 'agent',
            assignee_id: AGENT_ID,
            assignee_name: AGENT.name,
            rationale: '开发能力匹配',
            task_id: null,
            task_status: null,
            outcome_verdict: null,
            outcome_summary: '',
            status: 'proposed',
          },
        ],
        manager_run: {
          ...workflowPlan.manager_run,
          status: 'succeeded',
          recent_activity: '方案生成完成',
          error: null,
        },
      }
      await reloadActiveBoard(
        'The project board did not reconnect for workflow approval verification'
      )
      await control.command('click', `${activeBoard} [data-testid="cloud-project-board-view"]`, {
        visible: true,
      })
      await control.command(
        'click',
        `${activeBoard} [data-testid="cloud-todo-card-${aiManagedItemId}"]`,
        { visible: true }
      )
      await control.command(
        'waitFor',
        `${activeBoard} [data-testid="cloud-todo-workflow-approve"]`,
        {
          timeoutMs: uiTimeoutMs,
          visible: true,
        }
      )
      await control.command('click', `${activeBoard} [data-testid="cloud-todo-workflow-approve"]`, {
        visible: true,
      })
      await control.command(
        'waitFor',
        `${activeBoard} [data-testid="cloud-todo-workflow-plan-status"]`,
        {
          text: '正在创建并分配任务',
          timeoutMs: uiTimeoutMs,
          visible: true,
        }
      )
      assert.equal(workflowPlanApprovalRequested, true)

      createdChildItem = {
        ...createdBoardItem,
        id: aiManagedChildId,
        sequence_number: Number(aiManagedChildId.split('-')[1]),
        parent_id: aiManagedItemId,
        title: '实现 AI 编排生命周期',
        status: 'in_progress',
        workflow: null,
      }
      createdBoardItem = {
        ...createdBoardItem,
        status: 'in_progress',
        workflow: {
          ...createdBoardItem.workflow,
          orchestration_status: 'running',
        },
      }
      workflowPlan = {
        ...workflowPlan,
        status: 'running',
        items: workflowPlan.items.map(item => ({
          ...item,
          task_id: aiManagedChildId,
          task_status: 'in_progress',
          status: 'materialized',
        })),
      }
      await reloadActiveBoard(
        'The project board did not reconnect for workflow running verification'
      )
      await control.command('click', `${activeBoard} [data-testid="cloud-project-board-view"]`, {
        visible: true,
      })
      await control.command(
        'click',
        `${activeBoard} [data-testid="cloud-todo-card-${aiManagedItemId}"]`,
        { visible: true }
      )
      await control.command(
        'waitFor',
        `${activeBoard} [data-testid="cloud-todo-workflow-plan-status"]`,
        {
          text: '子任务执行中',
          timeoutMs: uiTimeoutMs,
          visible: true,
        }
      )

      createdChildItem = null
      createdBoardItem = {
        ...createdBoardItem,
        status: 'pending',
        workflow: {
          ...createdBoardItem.workflow,
          orchestration_status: 'awaiting_approval',
        },
      }
      workflowPlan = {
        ...workflowPlan,
        status: 'awaiting_approval',
        summary: '实现并验证 AI 编排可观测性',
        items: [
          {
            id: 'workflow-plan-item-e2e',
            client_key: 'implement',
            stage_id: '__issue__',
            title: '实现 AI 编排可观测性',
            description: '显示子任务状态与结果',
            assignee_type: 'agent',
            assignee_id: AGENT_ID,
            assignee_name: AGENT.name,
            rationale: '开发能力匹配',
            task_id: null,
            task_status: null,
            outcome_verdict: null,
            outcome_summary: '',
            status: 'proposed',
          },
        ],
        manager_run: {
          ...workflowPlan.manager_run,
          status: 'failed',
          recent_activity: 'AI 管家执行失败',
          error: 'AI manager finished without submitting a workflow plan.',
        },
      }
      await reloadActiveBoard(
        'The project board did not reconnect for manager conflict verification'
      )
      await control.command('click', `${activeBoard} [data-testid="cloud-project-board-view"]`, {
        visible: true,
      })
      await control.command(
        'click',
        `${activeBoard} [data-testid="cloud-todo-card-${aiManagedItemId}"]`,
        { visible: true }
      )
      await control.command(
        'waitFor',
        `${activeBoard} [data-testid="cloud-todo-workflow-plan-status"]`,
        {
          text: '生成方案失败',
          timeoutMs: uiTimeoutMs,
          visible: true,
        }
      )
      await control.command(
        'waitFor',
        `${activeBoard} [data-testid="cloud-todo-workflow-replan"]`,
        {
          text: '重新生成',
          timeoutMs: uiTimeoutMs,
          visible: true,
        }
      )
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            `${activeBoard} [data-testid="cloud-todo-workflow-approve"]`
          )
        ),
        0,
        'A failed AI manager must not leave the approval action available'
      )

      createdChildItem = {
        ...createdBoardItem,
        id: aiManagedChildId,
        sequence_number: Number(aiManagedChildId.split('-')[1]),
        parent_id: aiManagedItemId,
        title: '实现 AI 编排可观测性',
        status: 'in_review',
        workflow: null,
      }
      createdBoardItem = {
        ...createdBoardItem,
        workflow: {
          ...createdBoardItem.workflow,
          orchestration_status: 'awaiting_review',
        },
      }
      workflowPlan = {
        ...workflowPlan,
        status: 'awaiting_review',
        summary: '实现并验证 AI 编排可观测性',
        manager_run: {
          ...workflowPlan.manager_run,
          status: 'succeeded',
          recent_activity: '方案生成完成',
          error: null,
        },
        items: [
          {
            id: 'workflow-plan-item-e2e',
            client_key: 'implement',
            stage_id: '__issue__',
            title: createdChildItem.title,
            description: '显示子任务状态与结果',
            assignee_type: 'agent',
            assignee_id: AGENT_ID,
            assignee_name: AGENT.name,
            rationale: '开发能力匹配',
            task_id: aiManagedChildId,
            task_status: 'in_review',
            outcome_verdict: 'passed',
            outcome_summary: '实现和自动化测试均已通过',
            status: 'materialized',
          },
        ],
      }
      await reloadActiveBoard(
        'The project board did not reconnect for workflow history verification'
      )
      await control.command('click', `${activeBoard} [data-testid="cloud-project-board-view"]`, {
        visible: true,
      })
      await control.command(
        'click',
        `${activeBoard} [data-testid="cloud-todo-card-${aiManagedItemId}"]`,
        { visible: true }
      )
      await control.command(
        'waitFor',
        `${activeBoard} [data-testid="cloud-todo-workflow-plan-item-workflow-plan-item-e2e"]`,
        {
          text: '实现和自动化测试均已通过',
          timeoutMs: uiTimeoutMs,
          visible: true,
        }
      )
      await control.command(
        'waitFor',
        `${activeBoard} [data-testid="cloud-todo-open-plan-task-${aiManagedChildId}"]`,
        {
          text: '查看子任务',
          timeoutMs: uiTimeoutMs,
          visible: true,
        }
      )
      await captureScreenshot(control, 'project-automation-00-ai-workflow-history.png')
      await control.command('click', `${activeBoard} [data-testid="cloud-todo-detail-close"]`, {
        visible: true,
      })
      await control.command(
        'waitFor',
        `${activeBoard} [data-testid="cloud-project-automation-view"]`,
        {
          timeoutMs: uiTimeoutMs,
          visible: true,
        }
      )
      await control.command(
        'click',
        `${activeBoard} [data-testid="cloud-project-automation-view"]`,
        {
          visible: true,
        }
      )
      await control.command('waitFor', `${activeBoard} [data-testid="project-automation-view"]`, {
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      await control.command('click', '[data-testid="automation-create-rule"]', {
        visible: true,
      })
      await control.command('waitFor', '[data-testid="automation-rule-editor"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="automation-editor-name"]')
      await control.command('fill', '[data-testid="automation-editor-name-input"]', {
        value: '统一自动化回归',
      })
      await control.command('press', '[data-testid="automation-editor-name-input"]', {
        key: 'Enter',
      })
      await control.command('fill', '[data-testid="automation-rule-description"]', {
        value: '验证统一触发规则、执行节点和 DAG 持久化。',
      })
      await control.command('click', '[data-testid="automation-node-insert-after-trigger"]')
      await control.command('click', '[data-testid="automation-node-insert-after-task-trigger"]')
      await control.command('fill', '[data-testid^="execution-node-name-"]', {
        value: '实现与验证',
      })
      await control.command('fill', '[data-testid^="execution-node-prompt-"]', {
        value: '完成代码实现和测试。',
      })
      const executionEnvironment = '[data-testid^="execution-node-environment-"]'
      await control.command('scrollIntoView', executionEnvironment)
      await control.command('waitFor', executionEnvironment, {
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      await control.command('click', executionEnvironment, { visible: true })
      await control.command(
        'click',
        '[data-testid^="execution-node-environment-"][data-testid$="-option-none"]',
        { visible: true }
      )
      assert.equal(
        await control.command('getAttribute', `${executionEnvironment} [data-value]`, {
          name: 'data-value',
        }),
        '',
        'Execution environment selection was not cleared'
      )
      const executionModel = '[data-testid^="execution-node-model-"]'
      await control.command('select', executionModel, { value: '' })
      assert.equal(
        await control.command('getValue', executionModel),
        '',
        'Execution model selection was not cleared'
      )
      const pluginMenuTrigger = '[data-testid^="execution-node-add-plugin-"]'
      const pluginMenu = '[data-testid^="execution-node-add-plugin-"][data-testid$="-menu"]'
      await control.command('click', pluginMenuTrigger, { visible: true })
      await control.command('waitFor', pluginMenu, {
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      await control.command('click', '[data-testid^="execution-node-name-"]', {
        visible: true,
      })
      assert.equal(
        Number(await control.command('getElementCount', pluginMenu)),
        0,
        'Plugin menu did not close after an outside click'
      )
      await control.command('click', pluginMenuTrigger, { visible: true })
      await control.command('waitFor', pluginMenu, {
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      await control.command('press', 'body', { key: 'Escape' })
      assert.equal(
        Number(await control.command('getElementCount', pluginMenu)),
        0,
        'Plugin menu did not close after Escape'
      )
      await control.command('waitFor', '[data-testid^="automation-node-insert-after-step-"]', {
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      await control.command('click', '[data-testid^="automation-node-insert-after-step-"]')
      await control.command('click', '[data-testid^="automation-node-insert-after-dynamic-step-"]')
      await control.command('waitFor', '[data-testid^="dag-stage-add-first-"]', {
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      await control.command('click', '[data-testid^="dag-stage-add-first-"]', {
        visible: true,
      })
      await control.command('waitFor', '[data-testid^="dag-stage-insert-after-"]', {
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      await captureScreenshot(control, 'project-automation-00-unified-editor.png')
      await control.command('waitFor', '[data-testid="automation-editor-global-actions"]', {
        text: '已保存',
        timeoutMs: uiTimeoutMs,
      })
      const createdAutomation = createdPayloads.find(payload => payload.name === '统一自动化回归')
      assert.equal(createdAutomation?.assignmentMode, 'manual')
      assert.equal(createdAutomation?.roleSource, 'generic')
      assert.equal(createdAutomation?.runtimeSource, 'runtime_user')
      const createdGraphNodes = createdAutomation?.eventConfig.wework_flow.graph.nodes
      assert.equal(createdGraphNodes?.length, 2)
      assert.equal(createdGraphNodes?.[0].executionDeviceId, null)
      assert.equal(createdGraphNodes?.[0].model, '')
      assert.equal(
        createdAutomation?.eventConfig.runtime_workflow_definition.nodes[0].execution_config
          .execution_device_id,
        null
      )
      assert.equal(
        createdAutomation?.eventConfig.runtime_workflow_definition.nodes[0].execution_config.model,
        null
      )
      assert.equal(createdGraphNodes?.[1].kind, 'dynamic')
      assert.equal(createdGraphNodes?.[1].subgraph.nodes.length, 1)
      await control.command('click', '[data-testid="open-current-automation-runs"]', {
        visible: true,
      })
      await control.command('waitFor', '[data-testid="current-run-automation-run-history-1"]', {
        text: '待配置',
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      await control.command('waitFor', '[data-testid="current-run-automation-run-history-2"]', {
        text: '排队中',
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      await control.command('waitFor', '[data-testid="current-run-automation-run-history-3"]', {
        text: '成功',
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      const waitingRunText = await control.command(
        'getText',
        '[data-testid="current-run-automation-run-history-1"]'
      )
      assert.ok(!waitingRunText.includes('执行中'))
      assert.ok(!waitingRunText.includes('0 秒'))

      await control.command(
        'click',
        `${activeBoard} [data-testid="cloud-project-automation-view"]`,
        {
          visible: true,
        }
      )
      await control.command('scrollIntoView', '[data-testid="cloud-project-chat-agents"]', {
        visible: true,
      })
      await control.command('waitFor', '[data-testid="cloud-project-chat-agents"]', {
        timeoutMs: uiTimeoutMs,
        visible: true,
      })

      await control.command('scrollIntoView', '[data-testid="cloud-project-chat-agent-add"]', {
        visible: true,
      })
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
      await control.command('waitFor', '[data-testid="cloud-project-chat-agent-plugins-group"]', {
        text: '所选设备',
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      await control.command(
        'scrollIntoView',
        '[data-testid="cloud-project-chat-agent-access-group"]'
      )
      await control.command('waitFor', '[data-testid="cloud-project-chat-agent-access-group"]', {
        text: '访问权限',
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      await control.command(
        'scrollIntoView',
        '[data-testid="cloud-project-chat-agent-environment"]'
      )
      assert.equal(
        await control.command(
          'getAttribute',
          '[data-testid="cloud-project-chat-agent-environment"] [data-selection-state]',
          { value: 'data-selection-state', visible: true }
        ),
        'selected'
      )
      await control.command(
        'scrollIntoView',
        '[data-testid="cloud-project-chat-agent-runtime-configuration-mode"]'
      )
      await control.command(
        'waitFor',
        '[data-testid="cloud-project-chat-agent-runtime-configuration-mode"]',
        {
          text: '自定义',
          timeoutMs: uiTimeoutMs,
          visible: true,
        }
      )
      await control.command(
        'click',
        '[data-testid="cloud-project-chat-agent-runtime-configuration-mode"]',
        { visible: true }
      )
      await control.command(
        'click',
        '[data-testid="cloud-project-chat-agent-runtime-configuration-mode-option-template"]',
        { visible: true }
      )
      await control.command('waitFor', '[data-testid="cloud-project-chat-agent-runtime-profile"]', {
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      await control.command(
        'click',
        '[data-testid="cloud-project-chat-agent-runtime-configuration-mode"]',
        { visible: true }
      )
      await control.command(
        'click',
        '[data-testid="cloud-project-chat-agent-runtime-configuration-mode-option-custom"]',
        { visible: true }
      )
      assert.equal(
        await control.command(
          'getAttribute',
          '[data-testid="cloud-project-chat-agent-model"] [data-selection-state]',
          { value: 'data-selection-state', visible: true }
        ),
        'unselected'
      )
      await control.command('waitFor', '[data-testid="cloud-project-chat-agent-device"]', {
        text: 'local-device',
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      assert.equal(
        await control.command(
          'getAttribute',
          '[data-testid="cloud-project-chat-agent-device"] [data-selection-state]',
          { value: 'data-selection-state', visible: true }
        ),
        'selected'
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
      const saveWithoutModel = await control.command(
        'getAttribute',
        '[data-testid="cloud-project-chat-agent-save"]',
        { value: 'disabled', visible: true }
      )
      assert.equal(saveWithoutModel, '', 'save must allow validation while no model is selected')
      await control.command('click', '[data-testid="cloud-project-chat-agent-save"]', {
        visible: true,
      })
      await control.command('waitFor', '[data-testid="cloud-project-chat-agent-add"]', {
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      assert.equal(createdAgentPayload?.model, null)
      assert.equal(createdAgentPayload?.workspaceBinding?.type, 'standalone')
      await captureScreenshot(control, 'project-automation-05-robot-model-optional.png')

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
      await control.command(
        'click',
        '[data-testid="cloud-project-chat-agent-remove-agent-created-without-model"]',
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
      await control.command('click', '[data-testid="cloud-project-chat-agent-cancel"]', {
        visible: true,
      })
      await control.command(
        'click',
        `${activeBoard} [data-testid="cloud-project-automation-view"]`,
        { visible: true }
      )
      await control.command('waitFor', `${activeBoard} [data-testid="project-automation-view"]`, {
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      const activeFinalWorkflow = `${activeBoard} [data-testid="project-workflow-editor"]`
      const workflowSaveSelector = `${activeFinalWorkflow} [data-testid="project-workflow-save"]`
      assert.match(
        await control.command('getAttribute', workflowSaveSelector, {
          value: 'class',
        }),
        /\bbg-text-primary\b/,
        'The workflow save action did not use the visible Wework primary color'
      )
      await control.command(
        'waitFor',
        `${activeFinalWorkflow} [data-testid="project-workflow-stage-stage-1"]`,
        { timeoutMs: uiTimeoutMs }
      )
      await control.command('waitFor', `${activeBoard} [data-testid="cloud-project-board-view"]`, {
        visible: true,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', `${activeBoard} [data-testid="cloud-project-board-view"]`, {
        visible: true,
      })
      await control.command(
        'click',
        `${activeBoard} [data-testid="cloud-project-automation-view"]`,
        { visible: true }
      )
      const persistedStageSelector = `${activeBoard} [data-testid="project-workflow-stage-stage-1"]`
      await control.command('waitFor', persistedStageSelector, {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('scrollIntoView', persistedStageSelector)
      await control.command('waitFor', persistedStageSelector, {
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
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
        workflowPlanApprovalRequested,
        rules,
        runs,
      }
    },
  }
}
