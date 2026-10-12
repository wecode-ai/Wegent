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
import { selectCollaborationDomain } from '../modules/workspace-flows.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const WORKSPACE = `机器人接手空间-${process.pid}`
const PROJECT = `机器人接手项目-${process.pid}`
const MANUAL_AGENT = `待配置机器人-${process.pid}`
const DEVICE_AGENT = `跟随设备机器人-${process.pid}`
const BLOCKED_ISSUE = `机器人接手待配置-${process.pid}`
const QUEUED_ISSUE = `机器人接手可直接排队-${process.pid}`
const MARKER = `ISSUE_ROBOT_ASSIGNMENT_${process.pid}`
// The blocked robot must never reach the model; the runnable one legitimately does.
const BLOCKED_MARKER = `${MARKER}_NEEDS_CONFIG`
const RUNNABLE_MARKER = `${MARKER}_FOLLOW_DEVICE`
const RUNNABLE_RESULT = `${MARKER}_RUNNABLE_COMPLETED`

function scoped(selector) {
  return `${CONTENT} ${selector}`
}

function configurationBadge(issueId) {
  return scoped(`[data-testid="cloud-todo-card-needs-execution-config-${issueId}"]`)
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

async function waitForValue(load, predicate, message, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let latest = null
  while (Date.now() < deadline) {
    latest = await load()
    const result = predicate(latest)
    if (result) return result === true ? latest : result
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.fail(`${message}: ${JSON.stringify(latest)}`)
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

  await control.command(
    'waitFor',
    scoped('[data-testid="collaboration-workspace-project-create"]'),
    { visible: true, timeoutMs }
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

async function createAgent(request, projectId, name, capabilityMode, marker, timeoutMs) {
  const agent = await request(`/api/v1/cloud-projects/${projectId}/chat-agents`, {
    method: 'POST',
    body: JSON.stringify({
      name,
      capability_mode: capabilityMode,
      visibility: 'public',
      system_prompt: `${marker}。你是直接执行成员，只完成分配给你的 Issue。`,
    }),
  })
  assert.equal(agent.name, name)
  assert.equal(agent.model ?? null, null, `${name} must start without a configured model`)
  return waitForValue(
    () => request(`/api/v1/cloud-projects/${projectId}/chat-agents`),
    agents => agents.find(candidate => candidate.name === name),
    `The Backend did not list agent ${name}`,
    timeoutMs
  )
}

async function createIssue(control, title, timeoutMs) {
  await control.command('click', scoped('[data-testid="collaboration-issue-create"]'))
  await control.command('waitFor', scoped('[data-testid="cloud-todo-title"]'), {
    visible: true,
    timeoutMs,
  })
  await control.command('fill', scoped('[data-testid="cloud-todo-title"]'), { value: title })
  await control.command('fill', scoped('[data-testid="cloud-todo-detail-description"]'), {
    value: `${MARKER}。验证负责人被设置为机器人后 Issue 直接进入进行中。`,
  })
  await control.command('clickWhenEnabled', scoped('[data-testid="cloud-todo-create-confirm"]'), {
    timeoutMs,
  })
  await control.command('waitFor', scoped('[data-testid="collaboration-issue-detail"]'), {
    text: title,
    timeoutMs,
  })
}

async function assignAgent(control, agentId, timeoutMs) {
  await control.command('click', scoped('[data-testid="cloud-todo-detail-assignee"]'))
  await control.command(
    'click',
    `[data-testid="cloud-todo-detail-assignee-option-agent:${agentId}"]`
  )
  await control.command('clickWhenEnabled', scoped('[data-testid="cloud-todo-save"]'), {
    timeoutMs,
  })
  await control.command('waitFor', scoped('[data-testid="cloud-todo-save"]'), { visible: false })
}

async function closeIssueDetail(control, timeoutMs) {
  await control.command('click', scoped('[data-testid="cloud-todo-detail-close"]'))
  await control.command('waitFor', scoped('[data-testid="collaboration-issue-detail"]'), {
    visible: false,
    timeoutMs,
  })
}

export function createDesktopScenario({
  captureScreenshot,
  modelResponseTimeoutMs,
  uiTimeoutMs,
  workbenchReadyTimeoutMs,
}) {
  let backendUrl = ''
  let authToken = ''
  let project = null
  let modelRequests = 0
  const blockedIssueId = { value: null }
  const queuedIssueId = { value: null }
  const request = (pathname, options) => requestJson(backendUrl, authToken, pathname, options)
  const loadIssue = async title => {
    const issues = await request(`/api/v1/cloud-projects/${project.id}/loop-items`)
    return issues.items.find(item => item.title === title) ?? null
  }

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
      const responseId = `issue-robot-assignment-${Date.now()}`
      const kind = codexRequestKind(body)
      if (kind === 'prewarm' || kind === 'compaction') {
        writeEvents(response, responseId, [assistantMessage('Ready')])
        return true
      }
      const serialized = JSON.stringify(body)
      if (serialized.includes(BLOCKED_MARKER) || serialized.includes(BLOCKED_ISSUE)) {
        assert.fail(
          'A robot whose Run is waiting for runtime configuration must not start a model request'
        )
      }
      if (serialized.includes(RUNNABLE_MARKER)) {
        modelRequests += 1
        writeEvents(response, responseId, [assistantMessage(RUNNABLE_RESULT)])
        return true
      }
      writeEvents(response, responseId, [])
      return true
    },

    async verify(control) {
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await selectCollaborationDomain(control, CONTENT, 'cloud')
      project = await createWorkspaceAndProject(control, request, uiTimeoutMs)
      // A manual-capability robot without a model cannot start its Run: this is
      // the state the board card must explain instead of showing a bare
      // "in progress".
      const blockedAgent = await createAgent(
        request,
        project.id,
        MANUAL_AGENT,
        'manual',
        BLOCKED_MARKER,
        uiTimeoutMs
      )
      // The same "no model" robot that follows the device is runnable, so its
      // Run queues without needing configuration and must not show the reason.
      const deviceAgent = await createAgent(
        request,
        project.id,
        DEVICE_AGENT,
        'follow_device',
        RUNNABLE_MARKER,
        uiTimeoutMs
      )

      await control.command('click', scoped('[data-testid="collaboration-tab-board"]'))
      await createIssue(control, BLOCKED_ISSUE, uiTimeoutMs)
      const blockedIssue = await waitForValue(
        () => loadIssue(BLOCKED_ISSUE),
        item => item,
        'The Backend did not persist the Issue',
        uiTimeoutMs
      )
      blockedIssueId.value = blockedIssue.id
      assert.notEqual(
        await control.command('getValue', scoped('[data-testid="cloud-todo-detail-status"]')),
        'in_progress',
        'A new Issue must not start in the in-progress column'
      )
      assert.equal(blockedIssue.execution_id ?? null, null)

      await assignAgent(control, blockedAgent.id, uiTimeoutMs)
      await control.command('waitFor', scoped('[data-testid="cloud-todo-detail-status"]'), {
        value: 'in_progress',
        timeoutMs: modelResponseTimeoutMs,
      })
      const waitingIssue = await waitForValue(
        () => loadIssue(BLOCKED_ISSUE),
        item => (item.execution_id && item.execution_state === 'waiting_runtime' ? item : null),
        'Assigning a robot did not create a Run that waits for runtime configuration',
        modelResponseTimeoutMs
      )
      assert.equal(waitingIssue.status, 'in_progress')
      const waitingExecution = await waitForValue(
        async () => {
          const result = await request(
            `/api/v1/cloud-projects/${project.id}/executions?include_terminal=true`
          )
          return result.items.find(candidate => candidate.loopItemId === waitingIssue.id) ?? null
        },
        candidate => candidate,
        'The robot assignment did not persist its Run',
        modelResponseTimeoutMs
      )
      assert.equal(waitingExecution.executorType, 'project_robot')
      assert.equal(waitingExecution.agentId, blockedAgent.id)
      assert.equal(waitingExecution.displayState, 'waiting_runtime')

      await closeIssueDetail(control, uiTimeoutMs)
      await control.command(
        'waitFor',
        scoped(
          `[data-testid="cloud-todo-column-in_progress"] [data-testid="collaboration-issue-${waitingIssue.id}"]`
        ),
        { visible: true, timeoutMs: modelResponseTimeoutMs }
      )
      await control.command('waitFor', configurationBadge(waitingIssue.id), {
        text: '待配置',
        visible: true,
        timeoutMs: modelResponseTimeoutMs,
      })
      await captureScreenshot(control, 'issue-robot-assignment-01-waiting-config.png', CONTENT)

      await createIssue(control, QUEUED_ISSUE, uiTimeoutMs)
      const queuedIssue = await waitForValue(
        () => loadIssue(QUEUED_ISSUE),
        item => item,
        'The Backend did not persist the comparison Issue',
        uiTimeoutMs
      )
      queuedIssueId.value = queuedIssue.id
      await assignAgent(control, deviceAgent.id, uiTimeoutMs)
      const runnableIssue = await waitForValue(
        () => loadIssue(QUEUED_ISSUE),
        item => (item.execution_id && item.execution_state !== 'waiting_runtime' ? item : null),
        'A device-following robot assignment did not queue a runnable Run',
        modelResponseTimeoutMs
      )
      assert.notEqual(runnableIssue.status, 'inbox')

      await closeIssueDetail(control, uiTimeoutMs)
      await control.command(
        'waitFor',
        scoped(`[data-testid="collaboration-issue-${runnableIssue.id}"]`),
        { visible: true, timeoutMs: modelResponseTimeoutMs }
      )
      assert.equal(
        Number(await control.command('getElementCount', configurationBadge(runnableIssue.id))),
        0,
        'A runnable robot Run must not be reported as needing configuration'
      )
      await captureScreenshot(control, 'issue-robot-assignment-02-runnable.png', CONTENT)
    },

    diagnostics() {
      return {
        blockedIssueId: blockedIssueId.value,
        modelRequests,
        projectId: project?.id ?? null,
        queuedIssueId: queuedIssueId.value,
      }
    },
  }
}
