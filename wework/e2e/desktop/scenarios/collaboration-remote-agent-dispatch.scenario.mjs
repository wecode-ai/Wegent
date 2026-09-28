import assert from 'node:assert/strict'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  assistantMessage,
  codexRequestKind,
  createSse,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'
import { REMOTE_DOCKER_DEVICE_ID } from '../modules/shared.mjs'
import {
  initializeFirstProjectExecutionEnvironment,
  selectCollaborationDomain,
} from '../modules/workspace-flows.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const MODEL = 'desktop-e2e-cloud-responses'
const MODEL_LABEL = 'gpt-6-astra'
const WORKSPACE = `远程单智能体空间-${process.pid}`
const PROJECT = `远程单智能体项目-${process.pid}`
const AGENT = `远程执行智能体-${process.pid}`
const ISSUE = `远程执行闭环-${process.pid}`
const MARKER = `REMOTE_AGENT_DISPATCH_${process.pid}`
const COMPLETION = `${MARKER}_COMPLETED_BY_REMOTE_EXECUTOR`
const MANAGEMENT_TOOLS = [
  'get_assignment_candidates',
  'assign_board_item',
  'submit_workflow_plan',
  'update_issue_status',
]

function scoped(selector) {
  return `${CONTENT} ${selector}`
}

function writeEvents(response, responseId, events) {
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
  response.end(createSse([responseCreated(responseId), ...events, responseCompleted(responseId)]))
}

function advertisedToolNames(body) {
  const topLevel = Array.isArray(body.tools) ? body.tools : []
  const additional = Array.isArray(body.input)
    ? body.input
        .filter(item => item?.type === 'additional_tools')
        .flatMap(item => (Array.isArray(item.tools) ? item.tools : []))
    : []
  return [...topLevel, ...additional].flatMap(tool => {
    const ownName = tool?.name ?? tool?.function?.name
    const nested = Array.isArray(tool?.tools)
      ? tool.tools.map(candidate => candidate?.name ?? candidate?.function?.name)
      : []
    return [ownName, ...nested].filter(name => typeof name === 'string' && name)
  })
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

async function waitForPromise(promise, message, timeoutMs) {
  let timer
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function selectOptionByLabel(control, selector, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let options = []
  while (Date.now() < deadline) {
    const count = Number(await control.command('getElementCount', `${selector} option`))
    options = []
    for (let index = 1; index <= count; index += 1) {
      const option = `${selector} option:nth-child(${index})`
      const optionLabel = await control.command('getText', option)
      const value = await control.command('getAttribute', option, { value: 'value' })
      options.push({ label: optionLabel, value })
      if (optionLabel === label) {
        await control.command('select', selector, { value })
        return
      }
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`Option ${label} was not available in ${selector}: ${JSON.stringify(options)}`)
}

async function createWorkspaceAndProject(control, request, timeoutMs) {
  await control.command('click', scoped('[data-testid="collaboration-workspace-create"]'))
  await control.command('fill', scoped('[data-testid="collaboration-workspace-name-input"]'), {
    value: WORKSPACE,
  })
  await control.command(
    'clickWhenEnabled',
    scoped('[data-testid="collaboration-workspace-create-confirm"]'),
    { timeoutMs }
  )
  const workspace = await waitForValue(
    async () => (await request('/api/v1/workspaces')).items,
    items => items?.find(item => item.name === WORKSPACE),
    'Wework UI did not persist the workspace',
    timeoutMs
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
    { timeoutMs }
  )
  return waitForValue(
    async () => (await request(`/api/v1/workspaces/${workspace.id}/projects`)).items,
    items => items?.find(item => item.name === PROJECT),
    'Wework UI did not persist the project',
    timeoutMs
  )
}

async function createAgent(control, request, projectId, timeoutMs) {
  await control.command(
    'click',
    scoped('[data-testid="collaboration-project-settings-participants"]')
  )
  await control.command('click', scoped('[data-testid="collaboration-participants-tab-agents"]'))
  await control.command('clickWhenEnabled', scoped('[data-testid="project-agent-add"]'), {
    timeoutMs,
  })
  await control.command('waitFor', '[data-testid="wework-agent-resource-creator"]', { timeoutMs })
  await control.command('fill', '[data-testid="wework-agent-display-name"]', { value: AGENT })
  await selectOptionByLabel(control, '[data-testid="wework-agent-model"]', MODEL, timeoutMs)
  await control.command('fill', '[data-testid="wework-agent-system-prompt"]', {
    value: `${MARKER}。直接执行当前 Issue，不创建工作流、不调用负责人或协作小组。`,
  })
  await control.command('clickWhenEnabled', '[data-testid="wework-agent-resource-create"]', {
    timeoutMs,
  })
  return waitForValue(
    () => request(`/api/v1/cloud-projects/${projectId}/chat-agents`),
    agents => agents.find(agent => agent.name === AGENT),
    'Wework UI did not persist the agent',
    timeoutMs
  )
}

async function createAndAssignIssue(control, request, projectId, agent, timeoutMs) {
  await control.command('click', scoped('[data-testid="collaboration-tab-board"]'))
  await control.command('click', scoped('[data-testid="collaboration-issue-create"]'))
  await control.command('fill', scoped('[data-testid="cloud-todo-title"]'), { value: ISSUE })
  await control.command('fill', scoped('[data-testid="cloud-todo-detail-description"]'), {
    value: `${MARKER}。由单个智能体在远程 Executor 上完成并提交待确认。`,
  })
  await control.command('clickWhenEnabled', scoped('[data-testid="cloud-todo-create-confirm"]'), {
    timeoutMs,
  })
  const issue = await waitForValue(
    async () => (await request(`/api/v1/cloud-projects/${projectId}/loop-items`)).items,
    items => items.find(item => item.title === ISSUE),
    'Wework UI did not persist the Issue',
    timeoutMs
  )
  await control.command('click', scoped('[data-testid="cloud-todo-detail-assignee"]'))
  await control.command(
    'click',
    `[data-testid="cloud-todo-detail-assignee-option-agent:${agent.id}"]`
  )
  await control.command('clickWhenEnabled', scoped('[data-testid="cloud-todo-save"]'), {
    timeoutMs,
  })
  return issue
}

function directExecution(execution, issueId) {
  return String(execution.loopItemId ?? execution.loop_item_id) === String(issueId)
}

function runtimeDeviceId(execution) {
  return execution.runtimeDeviceId ?? execution.runtime_device_id
}

function findRuntimeTask(runtimeWork, taskId) {
  const workspaces = [
    ...(runtimeWork.projects ?? []).flatMap(project => project.deviceWorkspaces ?? []),
    ...(runtimeWork.chats ?? []),
  ]
  return workspaces.flatMap(workspace => workspace.tasks ?? []).find(task => task.taskId === taskId)
}

export function createDesktopScenario({
  captureScreenshot,
  modelResponseTimeoutMs,
  uiTimeoutMs,
  workbenchReadyTimeoutMs,
}) {
  let backendUrl = ''
  let authToken = ''
  let remoteDevice = null
  let project = null
  let issue = null
  let modelRequests = 0
  let releaseModel
  let resolveModelStarted
  const modelRelease = new Promise(resolve => {
    releaseModel = resolve
  })
  const modelStarted = new Promise(resolve => {
    resolveModelStarted = resolve
  })
  const request = (pathname, options) => requestJson(backendUrl, authToken, pathname, options)

  return {
    requiresCloudEnvironment: true,

    async prepareCloud(cloud) {
      backendUrl = cloud.backendUrl
      authToken = cloud.authToken
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
      const responseId = `remote-agent-dispatch-${Date.now()}`
      const kind = codexRequestKind(body)
      if (kind === 'prewarm' || kind === 'compaction') {
        writeEvents(response, responseId, [assistantMessage('Ready')])
        return true
      }
      const serialized = JSON.stringify(body)
      if (!serialized.includes(MARKER)) {
        writeEvents(response, responseId, [])
        return true
      }
      modelRequests += 1
      assert.equal(
        serialized.includes('You are the manager for one project Issue.'),
        false,
        'Direct agent dispatch incorrectly entered the collaboration manager path'
      )
      const toolNames = advertisedToolNames(body)
      for (const toolName of MANAGEMENT_TOOLS) {
        assert.equal(
          toolNames.some(name => name.endsWith(toolName)),
          false,
          `Direct agent dispatch exposed management tool ${toolName}`
        )
      }
      assert.ok(
        serialized.includes(`cloud://projects/${project.id}/todos/${issue.id}`),
        'Direct execution did not receive the bound Issue reference'
      )
      assert.ok(
        toolNames.some(name => name.endsWith('get_board_item')),
        'Direct execution cannot read its bound Issue through the execution tool set'
      )
      resolveModelStarted()
      await modelRelease
      writeEvents(response, responseId, [assistantMessage(COMPLETION)])
      return true
    },

    async verify(control) {
      remoteDevice = await waitForValue(
        async () => (await request('/api/devices/online')).items,
        devices =>
          devices.find(
            device =>
              device.device_id === REMOTE_DOCKER_DEVICE_ID &&
              device.device_type === 'remote' &&
              device.status === 'online'
          ),
        'The real remote Docker Executor device did not become online',
        workbenchReadyTimeoutMs
      )
      assert.ok(remoteDevice?.id, 'The real remote Docker Executor device is unavailable')
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await control.command('waitFor', scoped('[data-testid="collaboration-platform-root"]'), {
        timeoutMs: uiTimeoutMs,
      })
      await selectCollaborationDomain(control, CONTENT, 'cloud')
      project = await createWorkspaceAndProject(control, request, uiTimeoutMs)
      await initializeFirstProjectExecutionEnvironment(
        control,
        CONTENT,
        modelResponseTimeoutMs,
        remoteDevice.id
      )
      const agent = await createAgent(control, request, project.id, uiTimeoutMs)
      issue = await createAndAssignIssue(control, request, project.id, agent, uiTimeoutMs)

      try {
        await waitForPromise(
          modelStarted,
          'The remote Executor did not start the assigned Agent model',
          modelResponseTimeoutMs
        )
        const runningExecution = await waitForValue(
          async () => {
            const result = await request(
              `/api/v1/cloud-projects/${project.id}/executions?include_terminal=true`
            )
            return result.items.find(candidate => directExecution(candidate, issue.id)) ?? null
          },
          candidate => Boolean(candidate?.status === 'running' && candidate.runtimeTaskId),
          'The remote Executor did not persist the direct Agent execution as running',
          modelResponseTimeoutMs
        )
        assert.equal(runtimeDeviceId(runningExecution), REMOTE_DOCKER_DEVICE_ID)
        await control.command('waitFor', scoped('[data-testid="cloud-todo-detail-status"]'), {
          value: 'in_progress',
          timeoutMs: uiTimeoutMs,
        })
        await captureScreenshot(control, 'remote-agent-dispatch-01-running.png', CONTENT)
      } finally {
        releaseModel()
      }

      const execution = await waitForValue(
        async () => {
          const result = await request(
            `/api/v1/cloud-projects/${project.id}/executions?include_terminal=true`
          )
          return result.items.find(candidate => directExecution(candidate, issue.id)) ?? null
        },
        candidate =>
          Boolean(
            candidate &&
            ['completed', 'succeeded'].includes(candidate.status) &&
            candidate.runtimeTaskId
          ),
        'The remote Executor did not complete the direct agent execution',
        modelResponseTimeoutMs
      )
      assert.equal(runtimeDeviceId(execution), REMOTE_DOCKER_DEVICE_ID)
      assert.equal(String(execution.agentId), String(agent.id))
      assert.equal(execution.teamId ?? null, null)
      assert.notEqual(execution.executorType, 'collaboration_group_dispatch')

      const runtimeTask = await waitForValue(
        async () => findRuntimeTask(await request('/api/runtime-work'), execution.runtimeTaskId),
        task => task,
        'The completed execution was not persisted by a real Executor runtime task',
        uiTimeoutMs
      )
      assert.equal(runtimeTask.taskId, execution.runtimeTaskId)

      const persistedIssue = await waitForValue(
        () => request(`/api/v1/loop-items/${issue.id}`),
        item => item?.status === 'in_review',
        'The same Issue did not synchronize back to in_review',
        modelResponseTimeoutMs
      )
      assert.equal(String(persistedIssue.id), String(issue.id))
      await control.command('waitFor', scoped('[data-testid="cloud-todo-detail-status"]'), {
        value: 'in_review',
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', scoped('[data-testid="cloud-task-activity-list"]'), {
        text: COMPLETION,
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(control, 'remote-agent-dispatch-02-in-review.png', CONTENT)

      const executions = await request(
        `/api/v1/cloud-projects/${project.id}/executions?include_terminal=true`
      )
      const issueExecutions = executions.items.filter(candidate =>
        directExecution(candidate, issue.id)
      )
      assert.equal(issueExecutions.length, 1, 'Direct assignment created extra manager/member runs')
      assert.equal(
        issueExecutions.some(
          candidate =>
            candidate.teamId != null || candidate.executorType === 'collaboration_group_dispatch'
        ),
        false,
        'Direct assignment entered a manager/group execution path'
      )
      assert.equal(modelRequests, 1, 'Direct agent assignment invoked the model more than once')
    },

    diagnostics() {
      return {
        issueId: issue?.id ?? null,
        modelRequests,
        projectId: project?.id ?? null,
        remoteDeviceId: remoteDevice?.device_id ?? null,
      }
    },
  }
}
