import assert from 'node:assert/strict'
import { createDispatchIssueBoundaryRegression } from '../modules/dispatch-issue-boundary.mjs'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { verifyExecutionActivityOrder } from '../modules/issue-execution-activity-order.mjs'
import { readProjectChatMessages } from '../modules/project-chat-snapshot.mjs'
import {
  createSharedWorkspaceAgent,
  assertCreatedWorkspaceIssueAgent,
  createAndAssignCloudIssue,
  createWorkspaceAndProject,
  verifyRevokedWorkspaceIssueAgent,
  waitForValue,
} from '../modules/workspace-agent-setup.mjs'
import {
  assistantMessage,
  codexRequestKind,
  createSse,
  customToolCall,
  mcpToolRequestEvents,
  readRequestBody,
  requestAdvertisesProgrammaticExec,
  requestContainsToolOutput,
  requestToolSearchResults,
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
  configureFirstProjectExecutionEnvironment,
  selectCollaborationDomain,
  waitForControlValue,
} from '../modules/workspace-flows.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const MODEL = 'desktop-e2e-cloud-responses'
const MODEL_LABEL = 'gpt-6-astra'
const WORKSPACE = `远程单智能体空间-${process.pid}`
const PROJECT = `远程单智能体项目-${process.pid}`
const AGENT = `远程执行智能体-${process.pid}`
const ISSUE = `远程执行闭环-${process.pid}`
const UNCONFIGURED_ISSUE = `等待执行配置-${process.pid}`
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
  return [...topLevel, ...additional, ...requestToolSearchResults(body)].flatMap(tool => {
    const ownName = tool?.name ?? tool?.function?.name
    const nested = Array.isArray(tool?.tools)
      ? tool.tools.map(candidate => candidate?.name ?? candidate?.function?.name)
      : []
    return [ownName, ...nested].filter(name => typeof name === 'string' && name)
  })
}

export async function requestJson(baseUrl, token, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  })
  const text = await response.text()
  assert.equal(
    response.ok,
    true,
    `${options.method ?? 'GET'} ${pathname} failed with HTTP ${response.status}: ${text}`
  )
  return text ? JSON.parse(text) : null
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

async function verifyUnconfiguredAssignment(
  control,
  request,
  projectId,
  timeoutMs,
  captureScreenshot
) {
  const agent = await request(`/api/v1/cloud-projects/${projectId}/chat-agents`, {
    method: 'POST',
    body: JSON.stringify({
      name: `缺少配置的执行者-${process.pid}`,
      capability_mode: 'manual',
      visibility: 'public',
    }),
  })
  const issue = await createAndAssignCloudIssue(control, request, {
    contentSelector: CONTENT,
    projectId,
    title: UNCONFIGURED_ISSUE,
    description: `${MARKER}。由单个智能体在远程 Executor 上完成并提交待确认。`,
    assigneeTarget: `agent:${agent.id}`,
    timeoutMs,
  })
  await waitForValue(
    () => request(`/api/v1/loop-items/${issue.id}`),
    item => item.status === 'in_progress' && item.execution_state === 'waiting_runtime',
    'An assigned robot without configuration did not expose its blocked Run',
    timeoutMs
  )
  await control.command('waitFor', scoped('[data-testid="cloud-todo-detail-status"]'), {
    value: 'in_progress',
    timeoutMs,
  })
  await control.command('click', scoped('[data-testid="cloud-todo-detail-close"]'))
  await control.command(
    'waitFor',
    scoped(
      `[data-testid="cloud-todo-column-in_progress"] [data-testid="collaboration-issue-${issue.id}"]`
    ),
    { visible: true, timeoutMs }
  )
  await control.command(
    'waitFor',
    scoped(`[data-testid="cloud-todo-card-needs-execution-config-${issue.id}"]`),
    { text: '待配置', visible: true, timeoutMs }
  )
  await captureScreenshot(control, 'remote-agent-dispatch-00-waiting-configuration.png', CONTENT)
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
  // Persistence can be visible before the create dialog becomes the saved Issue.
  await waitForControlValue(
    control,
    scoped('[data-testid="cloud-todo-detail-title"]'),
    title,
    'The newly created Issue detail was not opened',
    timeoutMs
  )
  await control.command('clickWhenEnabled', scoped('[data-testid="cloud-todo-more-properties"]'), {
    timeoutMs,
  })
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

async function verifyManualSessionReply(
  control,
  request,
  cloud,
  issueId,
  timeoutMs,
  captureScreenshot
) {
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
  assert.equal(manualBinding.device_id, REMOTE_DOCKER_DEVICE_ID)

  const persistedMessages = await readProjectChatMessages(cloud, issueId, timeoutMs)
  const manualResponse = persistedMessages.find(message => message.messageId === rootId)
  const userRoot = persistedMessages.find(
    message => message.messageId === manualResponse?.rootMessageId
  )
  assert.equal(userRoot?.sender.type, 'user', 'Manual execution must retain its user comment root')
  assert.equal(manualResponse.triggerMessageId, userRoot.messageId)
  assert.equal(manualResponse.runtimeAddress.taskId, manualBinding.task_id)

  const cardTestId = await control.command(
    'getAttribute',
    scoped(
      `[data-testid^="cloud-task-activity-card-"]:has([data-testid="cloud-task-activity-execution-badge-${rootId}"])`
    ),
    { value: 'data-testid' }
  )
  assert.ok(cardTestId?.startsWith('cloud-task-activity-card-'))
  const executionCardId = cardTestId.slice('cloud-task-activity-card-'.length)
  assert.equal(executionCardId, rootId, 'The execution must have its own activity card')
  const beforeReply = await activityIds(control)
  await control.command(
    'click',
    scoped(`[data-testid="cloud-task-activity-reply-toggle-${executionCardId}"]`)
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
  await control.command(
    'waitFor',
    scoped(`[data-testid="cloud-task-activity-execution-badge-${replyId}"]`),
    { text: '已完成', timeoutMs }
  )
  // Read the settled reply in the same command that observes its final text.
  const replyText = await control.command('waitFor', content, {
    text: CONTINUATION_RESULT,
    stableMs: 300,
    timeoutMs,
  })
  assert.equal(replyText.trim(), CONTINUATION_RESULT)
  const replyMessages = await readProjectChatMessages(cloud, issueId, timeoutMs)
  const continuedResponse = replyMessages.find(message => message.messageId === replyId)
  assert.equal(continuedResponse?.rootMessageId, userRoot.messageId)
  assert.deepEqual(continuedResponse.runtimeAddress, manualResponse.runtimeAddress)
  const afterReply = await request(`/api/v1/loop-items/${issueId}/tasks`)
  assert.deepEqual(
    afterReply.map(binding => [binding.device_id, binding.task_id]).sort(),
    bindings.map(binding => [binding.device_id, binding.task_id]).sort(),
    'The reply created a new task instead of continuing the bound session'
  )
  await waitForValue(
    () => readProjectChatMessages(cloud, issueId, timeoutMs),
    messages =>
      messages.some(
        message =>
          message.messageId === replyId &&
          message.status === 'completed' &&
          message.content.trim() === CONTINUATION_RESULT
      ),
    'The completed reply was not persisted before refreshing its Issue',
    timeoutMs
  )
  const completedIssue = await request(`/api/v1/loop-items/${issueId}`)
  const refreshedTitle = `${completedIssue.title} · refreshed`
  const refreshedIssue = await request(`/api/v1/loop-items/${issueId}`, {
    method: 'PATCH',
    body: JSON.stringify({ version: completedIssue.version, title: refreshedTitle }),
  })
  assert.ok(refreshedIssue.version > completedIssue.version)
  assert.equal(refreshedIssue.status, completedIssue.status)
  await waitForValue(
    () => control.command('getValue', scoped('[data-testid="cloud-todo-detail-title"]')),
    value => value === refreshedTitle,
    'The Issue update did not refresh the open activity view',
    timeoutMs
  )
  await control.command('waitFor', content, {
    text: CONTINUATION_RESULT,
    stableMs: 500,
    timeoutMs,
  })
  assert.equal((await control.command('getText', content)).trim(), CONTINUATION_RESULT)
  await control.command(
    'waitFor',
    scoped(`[data-testid="cloud-task-activity-execution-badge-${replyId}"]`),
    { text: '已完成', stableMs: 500, timeoutMs }
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
  await control.command(
    'waitFor',
    scoped(`[data-testid="${ENVIRONMENT_PREFIX}-preparation"]:not([open])`)
  )
  await control.command('click', scoped(`[data-testid="${ENVIRONMENT_PREFIX}-preparation-toggle"]`))
  await control.command(
    'waitFor',
    scoped(`[data-testid="${ENVIRONMENT_PREFIX}-preparation"][open]`)
  )
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
  await control.command(
    'click',
    scoped(`[data-testid="${ENVIRONMENT_PREFIX}-actions-toggle-${remoteDeviceId}"]`)
  )
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
    scoped(
      `[data-testid="${ENVIRONMENT_PREFIX}-${remoteDeviceId}"][data-preparation-state="ready"]`
    ),
    { timeoutMs }
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
  await control.command('clickWhenEnabled', scoped('[data-testid="automatic-processing-create"]'))
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
  let toolSearchRequests = 0
  let releaseModel
  let resolveModelStarted
  const modelRelease = new Promise(resolve => {
    releaseModel = resolve
  })
  const modelStarted = new Promise(resolve => {
    resolveModelStarted = resolve
  })
  const request = (pathname, options) => requestJson(backendUrl, authToken, pathname, options)
  const dispatchBoundary = createDispatchIssueBoundaryRegression(request)

  return {
    requiresCloudEnvironment: true,
    backendEnv: { WEGENT_BACKEND_PUBLIC_URL: 'http://backend-public-unreachable.invalid:8000' },

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
      assert.equal(
        serialized.includes(UNCONFIGURED_ISSUE),
        false,
        'A robot blocked on missing configuration invoked the model'
      )
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
              dispatchBoundary.script(),
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
        await dispatchBoundary.verify()
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
      if (modelRequests >= 3) {
        if (!dispatchBoundary.verified) {
          const events = await dispatchBoundary.events(body)
          if (events) {
            writeEvents(response, responseId, events)
            return true
          }
        }
        if (!requestContainsToolOutput(body, MANUAL_READ_CALL)) {
          const selection = mcpToolRequestEvents(body, {
            toolName: 'get_board_item',
            argumentsValue: { space_id: project.id, item_id: issue.id },
            directToolName: toolNames.find(name => name.endsWith('get_board_item')),
            searchCallId: `${MANUAL_READ_CALL}_SEARCH`,
            toolCallId: MANUAL_READ_CALL,
          })
          if (selection.mode === 'search') {
            toolSearchRequests += 1
            assert.equal(toolSearchRequests, 1, 'The Issue tool must be discovered only once')
          }
          writeEvents(response, responseId, selection.events)
          return true
        }
        const rawOutput = body.input.find(
          item =>
            ['function_call_output', 'mcp_tool_call_output'].includes(item.type) &&
            item.call_id === MANUAL_READ_CALL
        )?.output
        const output = typeof rawOutput === 'string' ? JSON.parse(rawOutput) : rawOutput
        assert.notEqual(output?.isError, true, 'The bound Issue MCP read failed')
        assert.ok(
          JSON.stringify(output)?.includes(issue.id),
          'The real MCP read did not return the bound Issue'
        )
      }
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
      project = await createWorkspaceAndProject(control, request, {
        contentSelector: CONTENT,
        workspaceName: WORKSPACE,
        projectName: PROJECT,
        timeoutMs: uiTimeoutMs,
      })
      await verifyUnconfiguredAssignment(
        control,
        request,
        project.id,
        modelResponseTimeoutMs,
        captureScreenshot
      )
      await configureFirstProjectExecutionEnvironment(
        control,
        CONTENT,
        modelResponseTimeoutMs,
        remoteDevice.id
      )
      const authorizedProject = await request(`/api/v1/cloud-projects/${project.id}`)
      await dispatchBoundary.prepare(authorizedProject)
      assert.equal(
        authorizedProject.execution_environment?.repositories?.length ?? 0,
        0,
        'Direct assignment must work with an authorized runner and no code repository'
      )
      const source = await createSharedWorkspaceAgent(control, request, {
        contentSelector: CONTENT,
        project,
        name: AGENT,
        model: MODEL,
        environmentId: remoteDevice.id,
        systemPrompt: `${MARKER}。直接执行当前 Issue，不创建工作流、不调用负责人或协作小组。`,
        timeoutMs: uiTimeoutMs,
      })
      issue = await createAndAssignCloudIssue(control, request, {
        contentSelector: CONTENT,
        projectId: project.id,
        title: ISSUE,
        description: `${MARKER}。由单个智能体在远程 Executor 上完成并提交待确认。`,
        assigneeTarget: `resource:${source.id}`,
        assignDuringCreate: true,
        beforeSave: () =>
          verifyRevokedWorkspaceIssueAgent(control, request, {
            contentSelector: CONTENT,
            project,
            source,
            title: ISSUE,
            timeoutMs: uiTimeoutMs,
          }),
        timeoutMs: uiTimeoutMs,
      })
      const agent = await waitForValue(
        () => request(`/api/v1/cloud-projects/${project.id}/chat-agents`),
        agents =>
          agents.find(
            candidate => candidate.wegentTeamId === source.team_id && candidate.name === AGENT
          ),
        'Selecting the workspace Agent as Issue assignee did not persist a project binding',
        uiTimeoutMs
      )

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
        await verifyExecutionActivityOrder(control, scoped, 'running', uiTimeoutMs)
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
      assert.ok(
        runtimeTask.workspacePath,
        'Direct assignment did not create a standalone workspace'
      )

      const persistedIssue = await waitForValue(
        () => request(`/api/v1/loop-items/${issue.id}`),
        item => item?.status === 'in_review',
        'The same Issue did not synchronize back to in_review',
        modelResponseTimeoutMs
      )
      assert.equal(String(persistedIssue.id), String(issue.id))
      assert.equal(String(persistedIssue.assignee_agent_id), String(agent.id))
      await assertCreatedWorkspaceIssueAgent(request, {
        projectId: project.id,
        source,
        issue: persistedIssue,
      })
      await control.command('waitFor', scoped('[data-testid="cloud-todo-detail-status"]'), {
        value: 'in_review',
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', scoped('[data-testid="cloud-task-activity-list"]'), {
        text: COMPLETION,
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(control, 'remote-agent-dispatch-02-in-review.png', CONTENT)
      await verifyExecutionActivityOrder(control, scoped, 'completed', uiTimeoutMs)

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
        { backendUrl, authToken, projectId: project.id },
        issue.id,
        modelResponseTimeoutMs,
        captureScreenshot
      )
      assert.equal(
        modelRequests - toolSearchRequests - dispatchBoundary.modelRequests,
        5,
        'Manual execution and its reply made unexpected model requests'
      )
      const requestsAfterReply = modelRequests
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
      assert.equal(
        modelRequests,
        requestsAfterReply,
        'Managing a default human automation invoked the model'
      )
      assert.equal(dispatchBoundary.verified, true, 'Dispatch scope tools were not exercised')
    },

    diagnostics() {
      return {
        issueId: issue?.id ?? null,
        modelRequests,
        toolSearchRequests,
        projectId: project?.id ?? null,
        remoteDeviceId: remoteDevice?.device_id ?? null,
      }
    },
  }
}
