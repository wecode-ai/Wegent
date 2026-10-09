import assert from 'node:assert/strict'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  assistantMessage,
  codexRequestKind,
  createSse,
  customToolCall,
  readRequestBody,
  requestAdvertisesProgrammaticExec,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
  selectProgrammaticExec,
} from '../modules/response-protocol.mjs'
import {
  REMOTE_DOCKER_DEVICE_ID,
  join,
  pathToFileURL,
  readFile,
  resultDir,
} from '../modules/shared.mjs'
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
const CONTINUATION = `${MARKER}_CONTINUE_MANUAL_SESSION`
const CONTINUATION_RESULT = `${MARKER}_MANUAL_CONTINUATION_COMPLETE`
const MANUAL_READ_CALL = `${MARKER}_MANUAL_READ_ISSUE`
const MANUAL_READ_OK = `${MARKER}_BOARD_READ_OK`
const ENVIRONMENT_MARKER = `${MARKER}_ENVIRONMENT_READY`
const ENVIRONMENT_PREFIX = 'collaboration-project-execution-environment'
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

async function createAutoTaggedIssue(control, request, projectId, agent, timeoutMs) {
  const rule = await request(`/api/v1/cloud-projects/${projectId}/automations`, {
    method: 'POST',
    body: JSON.stringify({
      name: `${MARKER}_AUTO_TAG`,
      prompt: 'Complete the bound Issue with the configured agent model.',
      trigger_type: 'event',
      event_type: 'task.tag_added',
      event_config: { executionTarget: 'existing_issue', tags: ['auto'] },
      target_kind: 'agent',
      target_id: String(agent.id),
    }),
  })
  await control.command('click', scoped('[data-testid="cloud-todo-detail-close"]'))
  await control.command('click', scoped('[data-testid="collaboration-issue-create"]'))
  const title = `${ISSUE}-auto`
  await control.command('fill', scoped('[data-testid="cloud-todo-title"]'), { value: title })
  await control.command('fill', scoped('[data-testid="cloud-todo-detail-description"]'), {
    value: `${MARKER}。添加 auto 标签后由配置的智能体完成并提交待确认。`,
  })
  await control.command('clickWhenEnabled', scoped('[data-testid="cloud-todo-create-confirm"]'), {
    timeoutMs,
  })
  const issue = await waitForValue(
    async () => (await request(`/api/v1/cloud-projects/${projectId}/loop-items`)).items,
    items => items.find(item => item.title === title),
    'The auto-tagged Issue was not persisted',
    timeoutMs
  )
  await control.command('click', scoped('[data-testid="cloud-todo-more-properties"]'))
  await control.command('fill', '[data-testid="cloud-todo-detail-tag-input"]', { value: 'auto' })
  await control.command('press', '[data-testid="cloud-todo-detail-tag-input"]', { key: 'Enter' })
  await control.command('pointerClick', scoped('[data-testid="cloud-todo-detail-title"]'))
  await control.command('waitFor', '[data-testid="cloud-todo-more-properties-popover"]', {
    visible: false,
    timeoutMs,
  })
  await control.command('clickWhenEnabled', scoped('[data-testid="cloud-todo-save"]'), {
    timeoutMs,
  })
  return { issue, rule }
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

async function activityIds(control) {
  const snapshot = JSON.parse(
    await control.command('snapshot', scoped('[data-testid="cloud-task-activity-list"]'))
  )
  const prefix = 'cloud-task-activity-execution-badge-'
  return snapshot.testIds.filter(id => id.startsWith(prefix)).map(id => id.slice(prefix.length))
}

async function verifyManualSessionReply(control, request, issueId, timeoutMs, captureScreenshot) {
  const previousIds = await activityIds(control)
  const previousBindings = await request(`/api/v1/loop-items/${issueId}/tasks`)
  await control.command(
    'clickWhenEnabled',
    scoped(`[data-testid="cloud-task-activity-rerun-${issueId}"]`)
  )
  const rootId = await waitForValue(
    () => activityIds(control),
    ids => ids.find(id => !previousIds.includes(id)),
    'Manual execution did not create an agent activity',
    timeoutMs
  )
  await control.command('waitFor', scoped(`[data-testid="task-activity-content-${rootId}"]`), {
    text: COMPLETION,
    timeoutMs,
  })
  await control.command(
    'waitFor',
    scoped(`[data-testid="cloud-task-activity-execution-badge-${rootId}"]`),
    { text: '已完成', timeoutMs }
  )
  const bindings = await request(`/api/v1/loop-items/${issueId}/tasks`)
  const manualBinding = bindings.find(
    binding => !previousBindings.some(previous => previous.task_id === binding.task_id)
  )
  assert.ok(manualBinding?.task_id, 'Manual execution did not persist its TaskBinding')

  const beforeReply = await activityIds(control)
  await control.command(
    'click',
    scoped(`[data-testid="cloud-task-activity-reply-toggle-${rootId}"]`)
  )
  const composer = scoped('[data-testid="issue-reply-composer"]')
  await control.command('fill', `${composer} [data-testid="cloud-task-activity-composer"]`, {
    value: CONTINUATION,
  })
  await control.command('clickWhenEnabled', `${composer} [data-testid="send-message-button"]`)
  const replyId = await waitForValue(
    () => activityIds(control),
    ids => ids.find(id => !beforeReply.includes(id)),
    'The manual session reply did not create an agent response',
    timeoutMs
  )
  const content = scoped(`[data-testid="task-activity-content-${replyId}"]`)
  await control.command('waitFor', content, { text: CONTINUATION_RESULT, timeoutMs })
  assert.equal((await control.command('getText', content)).trim(), CONTINUATION_RESULT)
  await control.command(
    'waitFor',
    scoped(`[data-testid="cloud-task-activity-execution-badge-${replyId}"]`),
    { text: '已完成', timeoutMs }
  )
  const afterReply = await request(`/api/v1/loop-items/${issueId}/tasks`)
  assert.deepEqual(
    afterReply.map(binding => [binding.device_id, binding.task_id]).sort(),
    bindings.map(binding => [binding.device_id, binding.task_id]).sort(),
    'The reply created a new task instead of continuing the bound session'
  )
  await control.command('scrollIntoView', content)
  await captureScreenshot(control, 'remote-agent-dispatch-04-manual-reply-completed.png', CONTENT)
}

async function verifyConfiguredExecutionEnvironment(
  control,
  request,
  projectId,
  remoteDeviceId,
  timeoutMs,
  captureScreenshot
) {
  await control.command('click', scoped('[data-testid="collaboration-tab-manage"]'))
  await control.command(
    'click',
    scoped('[data-testid="collaboration-project-settings-environments"]')
  )
  const repositoryUrl = pathToFileURL(join(resultDir, 'workspace')).href
  await control.command('click', scoped(`[data-testid="${ENVIRONMENT_PREFIX}-add-repository"]`))
  await control.command('fill', scoped(`[data-testid="${ENVIRONMENT_PREFIX}-repository-url-0"]`), {
    value: repositoryUrl,
  })
  await control.command('click', scoped(`[data-testid="${ENVIRONMENT_PREFIX}-add-setup-step"]`))
  const setupCommand = scoped(`[data-testid="${ENVIRONMENT_PREFIX}-setup-command-0"]`)
  await control.command('fill', setupCommand, { value: 'false' })
  await control.command(
    'clickWhenEnabled',
    scoped(`[data-testid="${ENVIRONMENT_PREFIX}-save-configuration"]`),
    { timeoutMs }
  )
  await control.command(
    'waitFor',
    scoped(`[data-testid="${ENVIRONMENT_PREFIX}-configuration-status"]`),
    {
      text: '配置已保存',
      timeoutMs,
    }
  )
  const initialize = scoped(`[data-testid="${ENVIRONMENT_PREFIX}-initialize-${remoteDeviceId}"]`)
  await control.command('clickWhenEnabled', initialize, { timeoutMs })
  await waitForValue(
    () => request(`/api/v1/cloud-projects/${projectId}`),
    value =>
      Object.values(value.execution_environment?.devices ?? {}).find(
        device =>
          device.status === 'error' && device.error?.includes('setup command 1 exited with code 1')
      ),
    'The failed setup step did not report an actionable initialization error',
    timeoutMs
  )
  const failedProject = await request(`/api/v1/cloud-projects/${projectId}`)
  assert.equal(failedProject.execution_environment.repositories[0].url, repositoryUrl)
  const environmentError = scoped(`[data-testid="${ENVIRONMENT_PREFIX}-environment-error"]`)
  await control.command('waitFor', environmentError, { timeoutMs })
  await control.command('scrollIntoView', environmentError)
  await control.command('waitFor', environmentError, { visible: true, timeoutMs })
  await captureScreenshot(control, 'remote-environment-01-setup-failed.png', CONTENT)

  await control.command('fill', setupCommand, {
    value: `test -f auth.ts && printf ${ENVIRONMENT_MARKER} > .remote-env-ready`,
  })
  await control.command(
    'clickWhenEnabled',
    scoped(`[data-testid="${ENVIRONMENT_PREFIX}-save-configuration"]`),
    { timeoutMs }
  )
  await control.command(
    'waitFor',
    scoped(`[data-testid="${ENVIRONMENT_PREFIX}-configuration-status"]`),
    {
      text: '配置已保存',
      timeoutMs,
    }
  )
  await control.command('clickWhenEnabled', initialize, { timeoutMs })
  const readyDevice = await waitForValue(
    () => request(`/api/v1/cloud-projects/${projectId}`),
    value =>
      Object.values(value.execution_environment?.devices ?? {}).find(
        device => device.status === 'ready' && device.workspace_path
      ),
    'The corrected repository and setup step did not initialize the remote environment',
    timeoutMs
  )
  assert.equal(
    await readFile(join(readyDevice.workspace_path, '.remote-env-ready'), 'utf8'),
    ENVIRONMENT_MARKER
  )
  await control.command(
    'waitFor',
    scoped(`[data-testid="${ENVIRONMENT_PREFIX}-completion-status"]`),
    {
      text: '环境已初始化',
      timeoutMs,
    }
  )
  await captureScreenshot(control, 'remote-environment-02-retried-ready.png', CONTENT)
}

async function verifyAutomaticProcessingControls(
  control,
  request,
  projectId,
  timeoutMs,
  captureScreenshot
) {
  await control.command(
    'click',
    scoped('[data-testid="collaboration-project-settings-automatic-processing"]')
  )
  await control.command(
    'waitFor',
    scoped('[data-testid="collaboration-project-automatic-processing-page"]'),
    { timeoutMs }
  )
  await control.command('click', scoped('[data-testid="automatic-processing-create"]'))
  const form = scoped('[data-testid="automatic-processing-form"]')
  await control.command('waitFor', form, { visible: true, timeoutMs })
  assert.equal(
    await control.command(
      'getAttribute',
      scoped('[data-testid="automatic-processing-trigger-created"]'),
      { value: 'checked' }
    ),
    ''
  )
  await control.command('click', scoped('[data-testid="automatic-processing-target-kind-human"]'))
  assert.equal(
    await control.command(
      'getAttribute',
      scoped('[data-testid="automatic-processing-target-kind-human"]'),
      { value: 'aria-pressed' }
    ),
    'true'
  )
  await control.command('clickWhenEnabled', scoped('[data-testid="automatic-processing-save"]'), {
    timeoutMs,
  })
  const rule = await waitForValue(
    () => request(`/api/v1/cloud-projects/${projectId}/automations`),
    rules =>
      rules.find(
        candidate => candidate.eventType === 'task.created' && candidate.targetKind === 'human'
      ),
    'The human automatic processing rule was not persisted',
    timeoutMs
  )
  const ruleSelector = scoped(`[data-testid="automatic-processing-rule-${rule.id}"]`)
  await control.command('waitFor', ruleSelector, { visible: true, timeoutMs })
  await captureScreenshot(control, 'remote-automatic-processing-01-created.png', CONTENT)
  const enabledSelector = scoped(`[data-testid="automatic-processing-enabled-${rule.id}"]`)
  await control.command('click', enabledSelector)
  await waitForValue(
    () => request(`/api/v1/cloud-projects/${projectId}/automations`),
    rules => rules.find(candidate => candidate.id === rule.id && candidate.enabled === false),
    'The automatic processing rule did not pause',
    timeoutMs
  )
  await control.command('waitFor', enabledSelector, {
    attribute: 'aria-checked',
    value: 'false',
    timeoutMs,
  })
  await control.command('click', enabledSelector)
  await waitForValue(
    () => request(`/api/v1/cloud-projects/${projectId}/automations`),
    rules => rules.find(candidate => candidate.id === rule.id && candidate.enabled === true),
    'The automatic processing rule did not resume',
    timeoutMs
  )
  await control.command('waitFor', enabledSelector, {
    attribute: 'aria-checked',
    value: 'true',
    timeoutMs,
  })
  await control.command('click', scoped(`[data-testid="automatic-processing-edit-${rule.id}"]`))
  await control.command('waitFor', form, { visible: true, timeoutMs })
  await control.command('click', scoped('[data-testid="automatic-processing-cancel"]'))
  await control.command('waitFor', form, { visible: false, timeoutMs })
  await control.command('click', scoped(`[data-testid="automatic-processing-delete-${rule.id}"]`))
  await waitForValue(
    () => request(`/api/v1/cloud-projects/${projectId}/automations`),
    rules => !rules.some(candidate => candidate.id === rule.id),
    'The automatic processing rule was not deleted',
    timeoutMs
  )
  await control.command('waitFor', scoped('[data-testid="automatic-processing"]'), {
    text: '暂无自动处理规则',
    timeoutMs,
  })
  await captureScreenshot(control, 'remote-automatic-processing-02-deleted.png', CONTENT)
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
      assert.equal(body.model, MODEL_LABEL, 'The executor did not use the assigned Team model')
      assert.equal(
        serialized.includes('You are the manager for one project Issue.'),
        false,
        'Direct agent dispatch incorrectly entered the collaboration manager path'
      )
      const toolNames = advertisedToolNames(body)
      if (requestAdvertisesProgrammaticExec(body)) {
        if (!requestContainsToolOutput(body, MANUAL_READ_CALL)) {
          const selection = selectProgrammaticExec(
            body,
            [
              `const toolsForSpace = ALL_TOOLS.filter(tool => tool.name.includes('wework_space'))`,
              `for (const name of ${JSON.stringify(MANAGEMENT_TOOLS)}) {`,
              `  if (toolsForSpace.some(tool => tool.name.endsWith(name))) throw new Error('Executor exposed management tool: ' + name)`,
              `}`,
              `const read = toolsForSpace.find(tool => tool.name.endsWith('get_board_item'))`,
              `if (!read) throw new Error('Executor cannot read its bound Issue')`,
              `const result = await tools[read.name](${JSON.stringify({ space_id: project.id, item_id: issue.id })})`,
              `if (result.isError || !JSON.stringify(result).includes(${JSON.stringify(issue.id)})) throw new Error('Bound Issue read failed')`,
              `text(${JSON.stringify(MANUAL_READ_OK)})`,
            ].join('\n')
          )
          const event = customToolCall(MANUAL_READ_CALL, selection.name, selection.input)
          event.item.namespace = 'functions'
          writeEvents(response, responseId, [event])
          return true
        }
        const output = body.input.find(
          item => item.type === 'custom_tool_call_output' && item.call_id === MANUAL_READ_CALL
        )?.output
        assert.ok(
          JSON.stringify(output)?.includes(MANUAL_READ_OK),
          `The real bound Issue read did not succeed: ${JSON.stringify(output)}`
        )
        writeEvents(response, responseId, [
          assistantMessage(serialized.includes(CONTINUATION) ? CONTINUATION_RESULT : COMPLETION),
        ])
        return true
      }
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
      writeEvents(response, responseId, [
        assistantMessage(serialized.includes(CONTINUATION) ? CONTINUATION_RESULT : COMPLETION),
      ])
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
      const tagged = await createAutoTaggedIssue(control, request, project.id, agent, uiTimeoutMs)
      issue = tagged.issue
      const autoExecution = await waitForValue(
        async () => {
          const result = await request(
            `/api/v1/cloud-projects/${project.id}/executions?include_terminal=true`
          )
          return result.items.find(candidate => directExecution(candidate, issue.id)) ?? null
        },
        candidate => candidate?.status === 'completed' || candidate?.status === 'succeeded',
        'Adding auto did not complete the assigned agent execution',
        modelResponseTimeoutMs
      )
      assert.equal(runtimeDeviceId(autoExecution), REMOTE_DOCKER_DEVICE_ID)
      assert.equal(String(autoExecution.agentId), String(agent.id))
      assert.ok(autoExecution.runtimeTaskId, 'Auto processing did not bind a real runtime task')
      await waitForValue(
        () => request(`/api/v1/loop-items/${issue.id}`),
        item => item?.status === 'in_review',
        'Auto processing did not synchronize the Issue to in_review',
        modelResponseTimeoutMs
      )
      await control.command('waitFor', scoped('[data-testid="cloud-task-activity-list"]'), {
        text: COMPLETION,
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(modelRequests, 2, 'The auto tag did not invoke the agent model exactly once')
      await captureScreenshot(control, 'remote-agent-dispatch-03-auto-tag-in-review.png', CONTENT)
      await request(`/api/v1/cloud-projects/${project.id}/automations/${tagged.rule.id}`, {
        method: 'DELETE',
      })
      await verifyManualSessionReply(
        control,
        request,
        issue.id,
        modelResponseTimeoutMs,
        captureScreenshot
      )
      assert.equal(modelRequests, 5, 'Manual execution and its reply did not use the Team model')
      await verifyConfiguredExecutionEnvironment(
        control,
        request,
        project.id,
        remoteDevice.id,
        modelResponseTimeoutMs,
        captureScreenshot
      )
      await verifyAutomaticProcessingControls(
        control,
        request,
        project.id,
        uiTimeoutMs,
        captureScreenshot
      )
      assert.equal(modelRequests, 5, 'Managing a default human automation invoked the model')
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
