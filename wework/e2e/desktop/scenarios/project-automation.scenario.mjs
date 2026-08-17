import assert from 'node:assert/strict'

import {
  CHECKPOINT_TASK_COMPLETION_TEXT,
  CHECKPOINT_TASK_PROMPT,
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_LABEL,
  selectE2EModel,
  withTimeout,
} from '../modules/shared.mjs'
import { createSse, streamingTextEvents } from '../modules/response-protocol.mjs'

const PROJECT_ID = '700000000000000001'
const AGENT_ID = 'agent-project-automation'
const RULE_ID = 'automation-rule-1'
const MODEL_NAME = 'gpt-5-codex'
const CLOUD_DEVICE_ID = 'wework-e2e-cloud-device'
const CLOUD_MODEL_NAME = 'desktop-e2e-public-model'
const PROJECT_CHAT_REMOTE_MODEL_NAME = 'desktop-e2e-project-chat-remote'
const PROJECT_CHAT_REMOTE_MODEL_LABEL = 'Project Chat Remote Codex'

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
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${authToken}`,
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
  let cloudApi = null
  let cloudProject = null
  let cloudAgent = null

  const cloudRequest = (pathname, options) => {
    assert.ok(cloudApi, 'Real cloud API was not prepared')
    return requestJson(cloudApi.backendUrl, cloudApi.authToken, pathname, options)
  }

  async function verifyRealCloud(control) {
    assert.ok(cloudProject?.id, 'Real cloud project fixture is missing')
    const projectId = String(cloudProject.id)
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
    const projectSelector = `[data-testid="cloud-sidebar-project-${projectId}"]`
    await control.command('waitFor', projectSelector, { timeoutMs: uiTimeoutMs })
    await control.command('click', projectSelector)
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
    await captureScreenshot(control, 'project-automation-04-real-robot-binding.png')
  }

  return {
    async prepareCloud({ authToken, backendUrl }) {
      cloudApi = { authToken, backendUrl }
      cloudProject = await requestJson(backendUrl, authToken, '/api/v1/cloud-projects', {
        method: 'POST',
        body: JSON.stringify({
          projectKey: 'AUTO',
          name: PROJECT.name,
          description: PROJECT.description,
          taskProvider: 'local',
          providerConfig: {},
          visibility: 'private',
        }),
      })
      assert.ok(cloudProject?.id, 'Real cloud project fixture did not return an id')
    },

    async handleHttp(request, response, url) {
      if (request.method === 'GET' && url.pathname === '/api/v1/cloud-projects') {
        json(response, 200, { items: [PROJECT] })
        return true
      }
      if (
        request.method === 'GET' &&
        url.pathname === `/api/v1/cloud-projects/${PROJECT_ID}/loop-items`
      ) {
        json(response, 200, { items: [] })
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
        json(response, 200, { items: [], total: 0 })
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
      const projectSelector = `[data-testid="cloud-sidebar-project-${PROJECT_ID}"]`
      await control.command('waitFor', projectSelector, { timeoutMs: uiTimeoutMs })
      await control.command('click', projectSelector)
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
        rules,
        runs,
      }
    },
  }
}
