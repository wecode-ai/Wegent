import assert from 'node:assert/strict'

import { CLOUD_DEVICE_ID, CLOUD_PUBLIC_MODEL_NAME } from '../modules/shared.mjs'
import {
  assistantMessage,
  createSse,
  namespacedFunctionCall,
  requestContainsToolOutput,
  requestToolSearchResults,
  responseCompleted,
  responseCreated,
  selectMcpTool,
} from '../modules/response-protocol.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'

const PROJECT_KEY = 'EXT'
const PROJECT_NAME = '外部事件订阅验收'
const ISSUE_TITLE = '外部事件订阅 E2E 验收'
const STAGE_NAME = '开发并提交 MR'
const WAIT_NAME = '等待外部事件'
const ROBOT_NAME = 'MR 修复机器人'
const ROBOT_SYSTEM_PROMPT =
  'E2E_EXTERNAL_EVENT_ROBOT_MARKER 你负责开发并提交 MR，成功后登记外部引用，并根据外部事件修复问题。'
const STAGE_PROMPT = 'E2E_EXTERNAL_EVENT_STAGE_PROMPT 实现 Issue 描述的功能并提交 MR。'
const RERUN_PROMPT = 'E2E_EXTERNAL_EVENT_RERUN_PROMPT 修复 CI 失败后重新推送。'
const MR_REF = 'e2e-group/e2e-project!1'
const REGISTER_CALL_ID = 'external-ref-register'
const SEARCH_CALL_ID = 'external-ref-tool-search'
const PIPELINE_UUID = 'e2e-pipeline-uuid-1'
const MERGE_UUID = 'e2e-merge-uuid-1'

async function readJson(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

async function requestJson(baseUrl, token, pathname, options = {}) {
  const url = pathname.startsWith('http') ? pathname : `${baseUrl}${pathname}`
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
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

function nodeStatuses(issue) {
  return Object.fromEntries((issue.workflow?.nodes ?? []).map(node => [node.id, node.status]))
}

function toolOutputFor(request, callId) {
  const visit = value => {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item)
        if (found !== null) return found
      }
      return null
    }
    if (!value || typeof value !== 'object') return null
    if (
      (value.type === 'function_call_output' || value.type === 'custom_tool_call_output') &&
      value.call_id === callId
    ) {
      return value
    }
    for (const nested of Object.values(value)) {
      const found = visit(nested)
      if (found !== null) return found
    }
    return null
  }
  return visit(request.input ?? [])
}

function registrationResult(payload) {
  const output = toolOutputFor(payload, REGISTER_CALL_ID)
  assert.ok(output, 'register_external_reference output is missing from the request')
  const outputText =
    typeof output.output === 'string' ? output.output : JSON.stringify(output.output)
  const marker = outputText.indexOf('\nOutput:\n')
  const payloadStart = marker >= 0 ? marker + '\nOutput:\n'.length : outputText.search(/[\[{]/)
  const parsed = JSON.parse(outputText.slice(payloadStart))
  const content = Array.isArray(parsed) ? parsed[0] : {}
  const text = typeof content.text === 'string' ? content.text : JSON.stringify(content)
  return JSON.parse(text)
}

export function createDesktopScenario({ captureScreenshot, uiTimeoutMs }) {
  let cloudApi = null
  let cloudProject = null
  let cloudAgent = null
  let incomingHook = null
  let workflowRule = null
  let issue = null
  let stageRun = null
  let firstExecution = null
  let rerunExecution = null
  let registrationCompleted = false

  const cloudRequest = (pathname, options) => {
    assert.ok(cloudApi, 'Real cloud API was not prepared')
    return requestJson(cloudApi.backendUrl, cloudApi.authToken, pathname, options)
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

  async function waitForCompletedExecution(projectId, loopItemId, automationRunId, floorId) {
    const execution = await waitForValue(
      () => allExecutions(projectId),
      items =>
        items.find(
          item =>
            item.loopItemId === loopItemId &&
            item.executorType === 'project_robot' &&
            (automationRunId === null || item.automationRunId === automationRunId) &&
            (floorId === null || item.id > floorId) &&
            item.status === 'completed'
        ),
      `project_robot execution for ${loopItemId} did not reach completed`,
      uiTimeoutMs * 5
    ).then(items =>
      items.find(
        item =>
          item.loopItemId === loopItemId &&
          item.executorType === 'project_robot' &&
          (automationRunId === null || item.automationRunId === automationRunId) &&
          (floorId === null || item.id > floorId) &&
          item.status === 'completed'
      )
    )
    assert.equal(execution.observedState, 'succeeded')
    assert.equal(execution.syncState, 'in_sync')
    return execution
  }

  async function issueByTitle(projectId, title) {
    return waitForValue(
      () => cloudRequest(`/api/v1/cloud-projects/${projectId}/loop-items`),
      response =>
        (response.items ?? []).find(item => item.title === title && item.workflow?.nodes?.length),
      `UI-created Issue "${title}" did not persist its workflow snapshot`,
      uiTimeoutMs
    ).then(response => response.items.find(item => item.title === title))
  }

  async function deliverWebhook(payload, headers) {
    assert.ok(incomingHook?.webhook_url, 'Incoming hook fixture is missing')
    return requestJson(cloudApi.backendUrl, null, incomingHook.webhook_url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    })
  }

  async function verifyWorkflowEditor(control, activeBoard, projectId) {
    await control.command('click', '[data-testid="cloud-project-automation-view"]')
    await control.command('waitFor', '[data-testid="project-automation-rules"]', {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('click', '[data-testid="project-workflow-mode-workflow"]')
    await control.command('waitFor', '[data-testid="project-workflow-empty-add"]', {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('click', '[data-testid="project-workflow-empty-add"]')
    await control.command('waitFor', '[data-testid="project-workflow-dag"]', {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('waitFor', '[data-testid="project-workflow-stage-stage-1"]', {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('click', '[data-testid="project-workflow-add-wait"]')
    await control.command('waitFor', '[data-testid="project-workflow-wait-wait-1"]', {
      timeoutMs: uiTimeoutMs,
    })
    await captureScreenshot(control, 'external-event-01-workflow-dag-nodes.png')

    await control.command('click', '[data-testid="project-workflow-stage-stage-1"]')
    await control.command('waitFor', '[data-testid="project-workflow-inspector-stage-1"]', {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('fill', '[data-testid="project-workflow-stage-name-stage-1"]', {
      value: STAGE_NAME,
    })
    await control.command('fill', '[data-testid="project-workflow-stage-prompt-stage-1"]', {
      value: STAGE_PROMPT,
    })

    await control.command('click', '[data-testid="project-workflow-wait-wait-1"]')
    await control.command('waitFor', '[data-testid="project-workflow-inspector-wait-1"]', {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('fill', '[data-testid="project-workflow-wait-name-wait-1"]', {
      value: WAIT_NAME,
    })
    await control.command(
      'fill',
      '[data-testid="project-workflow-wait-rule-event-wait-1-rule-1"]',
      { value: 'merged' }
    )
    await control.command('click', '[data-testid="project-workflow-wait-rule-add-wait-1"]')
    await control.command('waitFor', '[data-testid="project-workflow-wait-rule-wait-1-rule-2"]', {
      timeoutMs: uiTimeoutMs,
    })
    await control.command(
      'fill',
      '[data-testid="project-workflow-wait-rule-event-wait-1-rule-2"]',
      { value: 'ci_failed' }
    )
    await control.command(
      'select',
      '[data-testid="project-workflow-wait-rule-action-wait-1-rule-2"]',
      { value: 'rerun' }
    )
    await control.command(
      'waitFor',
      '[data-testid="project-workflow-wait-rule-rerun-prompt-wait-1-rule-2"]',
      { timeoutMs: uiTimeoutMs }
    )
    await control.command(
      'fill',
      '[data-testid="project-workflow-wait-rule-rerun-prompt-wait-1-rule-2"]',
      { value: RERUN_PROMPT }
    )
    await control.command(
      'waitFor',
      `[data-testid="project-workflow-wait-robot-wait-1"] option[value="${cloudAgent.id}"]`,
      { timeoutMs: uiTimeoutMs * 2 }
    )
    await control.command('select', '[data-testid="project-workflow-wait-robot-wait-1"]', {
      value: String(cloudAgent.id),
    })
    await captureScreenshot(control, 'external-event-02-wait-rules-inspector.png')

    await control.command('click', '[data-testid="project-workflow-stage-stage-1"]')
    await control.command(
      'waitFor',
      '[data-testid="project-workflow-stage-executor-robot-stage-1"]',
      { timeoutMs: uiTimeoutMs }
    )
    await control.command('click', '[data-testid="project-workflow-stage-executor-robot-stage-1"]')
    await control.command('waitFor', '[data-testid="project-workflow-stage-automation-stage-1"]', {
      timeoutMs: uiTimeoutMs,
    })
    await control.command(
      'waitFor',
      `[data-testid="project-workflow-stage-automation-stage-1"] option[value="${cloudAgent.id}"]`,
      { timeoutMs: uiTimeoutMs * 2 }
    )
    await control.command('select', '[data-testid="project-workflow-stage-automation-stage-1"]', {
      value: String(cloudAgent.id),
    })
    workflowRule = await waitForValue(
      () => cloudRequest(`/api/v1/cloud-projects/${projectId}/automations`),
      items =>
        items.some(
          item =>
            item.triggerType === 'workflow' &&
            item.assignmentMode === 'manual' &&
            String(item.agentId) === String(cloudAgent.id)
        ),
      'Stage robot workflow rule was not created by the editor',
      uiTimeoutMs * 2
    ).then(items =>
      items.find(
        item =>
          item.triggerType === 'workflow' &&
          item.assignmentMode === 'manual' &&
          String(item.agentId) === String(cloudAgent.id)
      )
    )
    assert.ok(workflowRule?.id, 'Stage robot workflow rule id is missing')
    await control.command('clickWhenEnabled', '[data-testid="project-workflow-save"]', {
      timeoutMs: uiTimeoutMs,
    })
    await waitForValue(
      () => cloudRequest(`/api/v1/cloud-projects/${projectId}`),
      project => {
        const nodes = project.workflow_definition?.nodes ?? []
        const wait = nodes.find(node => node.id === 'wait-1')
        const stage = nodes.find(node => node.id === 'stage-1')
        return Boolean(
          wait?.node_type === 'wait' &&
          wait.wait_config?.rules?.some(rule => rule.event_type === 'merged') &&
          wait.wait_config?.rules?.some(
            rule => rule.event_type === 'ci_failed' && rule.action === 'rerun'
          ) &&
          wait.wait_config?.agent_id === String(cloudAgent.id) &&
          stage?.automation_rule_id === workflowRule.id &&
          stage?.workspace_policy === 'none'
        )
      },
      'The workflow definition was not persisted by the real backend',
      uiTimeoutMs
    )
    await captureScreenshot(control, 'external-event-03-workflow-persisted.png')
  }

  async function createIssueThroughUi(control, activeBoard) {
    await control.command('click', '[data-testid="cloud-project-board-view"]')
    if ((await control.command('getElementCount', '[data-testid="cloud-todo-detail-close"]')) > 0) {
      await control.command('click', '[data-testid="cloud-todo-detail-close"]')
    }
    await control.command('click', `${activeBoard} [data-testid="cloud-todo-add"]`)
    await control.command('waitFor', `${activeBoard} [data-testid="workspace-issue-input"]`, {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('click', `${activeBoard} [data-testid="workspace-create-task-tab"]`)
    await control.command('fill', `${activeBoard} [data-testid="workspace-issue-input"]`, {
      value: ISSUE_TITLE,
    })
    await control.command('click', `${activeBoard} [data-testid="workspace-issue-submit"]`)
    await control.command('waitFor', `${activeBoard} [data-testid="cloud-todo-detail-title"]`, {
      text: ISSUE_TITLE,
      timeoutMs: uiTimeoutMs * 2,
    })
  }

  return {
    requiresCloudEnvironment: true,

    async prepareCloud({ authToken, backendUrl }) {
      cloudApi = { authToken, backendUrl }
      cloudProject = await cloudRequest('/api/v1/cloud-projects', {
        method: 'POST',
        body: JSON.stringify({
          projectKey: PROJECT_KEY,
          name: PROJECT_NAME,
          description: 'Wework 外部事件订阅与 MR 自动修复桌面验收',
          taskProvider: 'local',
          providerConfig: {},
          visibility: 'private',
        }),
      })
      assert.ok(cloudProject?.id, 'Real cloud project fixture did not return an id')
      const projectId = String(cloudProject.id)
      incomingHook = await cloudRequest(`/api/v1/cloud-projects/${projectId}/incoming-hooks`, {
        method: 'POST',
        body: JSON.stringify({ name: 'GitLab E2E' }),
      })
      assert.ok(incomingHook?.webhook_url, 'Incoming hook fixture did not return a webhook URL')
      assert.match(incomingHook.webhook_url, /\/api\/v1\/incoming-hooks\//)
    },

    async handleHttp(request, response, url) {
      if (request.method === 'POST' && url.pathname === '/v1/responses' && cloudApi) {
        const payload = await readJson(request)
        const serialized = JSON.stringify(payload)
        const responseId = `external-event-real-${Date.now()}`
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
        if (serialized.includes('E2E_EXTERNAL_EVENT_ROBOT_MARKER')) {
          if (registrationCompleted) {
            assert.ok(
              serialized.includes('外部事件概述'),
              'The rerun instruction did not include the external event overview'
            )
            assert.ok(
              serialized.includes('Pipeline #456 failed'),
              'The rerun instruction did not include the pipeline summary'
            )
          }
          if (requestContainsToolOutput(payload, REGISTER_CALL_ID)) {
            const result = registrationResult(payload)
            assert.ok(
              result.binding_id,
              'register_external_reference did not return a persisted binding'
            )
            assert.equal(
              result.opaque_ref,
              MR_REF,
              'register_external_reference did not echo the registered opaque reference'
            )
            registrationCompleted = true
            writeEvents([
              responseCreated(responseId),
              assistantMessage('MR 已提交并登记外部引用，等待外部事件。'),
              responseCompleted(responseId),
            ])
            return true
          }
          if (registrationCompleted) {
            writeEvents([
              responseCreated(responseId),
              assistantMessage('外部事件修复执行完成。'),
              responseCompleted(responseId),
            ])
            return true
          }
          const namespace = requestToolSearchResults(payload).find(
            candidate => candidate?.type === 'namespace' && candidate.name === 'wework_space'
          )
          if (namespace) {
            const tool = selectMcpTool(payload, 'wework_space', 'register_external_reference', {
              provider: 'gitlab',
              opaque_ref: MR_REF,
            })
            writeEvents([
              responseCreated(responseId),
              ...namespacedFunctionCall(
                REGISTER_CALL_ID,
                tool.namespace,
                tool.name,
                tool.arguments
              ),
              responseCompleted(responseId),
            ])
            return true
          }
          writeEvents([
            responseCreated(responseId),
            {
              type: 'response.output_item.done',
              output_index: 0,
              item: {
                id: SEARCH_CALL_ID,
                type: 'tool_search_call',
                status: 'completed',
                call_id: SEARCH_CALL_ID,
                execution: 'client',
                arguments: {
                  query: 'register_external_reference',
                  limit: 8,
                },
              },
            },
            responseCompleted(responseId),
          ])
          return true
        }
        writeEvents([
          responseCreated(responseId),
          assistantMessage('外部事件 E2E 完成。'),
          responseCompleted(responseId),
        ])
        return true
      }
      return false
    },

    async verify(control) {
      await ensureExperimentalFeaturesEnabled(control)
      assert.ok(cloudProject?.id, 'Real cloud project fixture is missing')
      const projectId = String(cloudProject.id)

      await waitForValue(
        () => cloudRequest('/api/devices'),
        response =>
          response.items?.some(
            device => device.device_id === CLOUD_DEVICE_ID && device.status === 'online'
          ),
        'Cloud execution device did not register before the robot fixture was created',
        uiTimeoutMs
      )
      cloudAgent = await cloudRequest(`/api/v1/cloud-projects/${projectId}/chat-agents`, {
        method: 'POST',
        body: JSON.stringify({
          name: ROBOT_NAME,
          runtime: 'codex',
          model: CLOUD_PUBLIC_MODEL_NAME,
          systemPrompt: ROBOT_SYSTEM_PROMPT,
          capabilityDescription: '开发并提交 MR，随后根据外部事件修复问题。',
          visibility: 'creator_admin',
          executionEnvironment: 'cloud',
          executionMode: 'auto',
          executionDeviceId: CLOUD_DEVICE_ID,
          localProjectId: null,
        }),
      })
      assert.ok(cloudAgent?.id, 'Cloud robot fixture was not created')
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

      await verifyWorkflowEditor(control, activeBoard, projectId)
      await createIssueThroughUi(control, activeBoard)

      issue = await issueByTitle(projectId, ISSUE_TITLE)
      const initialStatuses = nodeStatuses(issue)
      assert.ok(
        ['ready', 'queued', 'running'].includes(initialStatuses['stage-1']),
        `stage-1 was not active after instantiation: ${JSON.stringify(initialStatuses)}`
      )
      assert.equal(initialStatuses['wait-1'], 'waiting')
      await control.command('waitFor', '[data-testid="cloud-todo-workflow-node-wait-1"]', {
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(control, 'external-event-04-issue-workflow-instantiated.png')

      const runs = await waitForValue(
        () =>
          cloudRequest(`/api/v1/cloud-projects/${projectId}/automations/${workflowRule.id}/runs`),
        items => items.find(item => item.taskId === issue.id),
        `Workflow automation run for "${ISSUE_TITLE}" was not created`,
        uiTimeoutMs
      )
      stageRun = runs.find(item => item.taskId === issue.id)
      assert.ok(stageRun?.id, 'Workflow automation run id is missing')
      assert.equal(String(stageRun.taskId), String(issue.id))

      firstExecution = await waitForCompletedExecution(
        projectId,
        issue.id,
        String(stageRun.id),
        null
      )
      assert.equal(firstExecution.attemptNo, 1)
      assert.equal(
        registrationCompleted,
        true,
        'The robot execution did not register the external reference'
      )
      await captureScreenshot(control, 'external-event-05-external-reference-registered.png')

      const pipelineReceipt = await deliverWebhook(
        {
          object_kind: 'pipeline',
          project: { path_with_namespace: 'e2e-group/e2e-project' },
          object_attributes: { id: 456, status: 'failed' },
          merge_request: { iid: 1 },
        },
        {
          'content-type': 'application/json',
          'x-gitlab-event': 'Pipeline Hook',
          'x-gitlab-event-uuid': PIPELINE_UUID,
        }
      )
      assert.equal(pipelineReceipt.status, 'created')

      rerunExecution = await waitForCompletedExecution(projectId, issue.id, null, firstExecution.id)
      assert.ok(
        rerunExecution.id > firstExecution.id,
        'Rerun execution did not follow the first run'
      )
      assert.equal(
        String(rerunExecution.agentId),
        String(cloudAgent.id),
        'The wait rerun did not run on the wait node robot'
      )
      issue = await issueByTitle(projectId, ISSUE_TITLE)
      const rerunStatuses = nodeStatuses(issue)
      assert.equal(rerunStatuses['wait-1'], 'waiting')
      const waitNode = issue.workflow.nodes.find(node => node.id === 'wait-1')
      assert.equal(waitNode.wait_round, 1, 'The ci_failed event did not bump the wait round')
      await captureScreenshot(control, 'external-event-06-ci-failed-rerun.png')

      const mergeReceipt = await deliverWebhook(
        {
          object_kind: 'merge_request',
          project: { path_with_namespace: 'e2e-group/e2e-project' },
          object_attributes: {
            id: 789,
            iid: 1,
            action: 'merge',
            url: 'https://gitlab.example/e2e-group/e2e-project/-/merge_requests/1',
            updated_at: '2026-08-20T10:00:00Z',
          },
        },
        {
          'content-type': 'application/json',
          'x-gitlab-event': 'Merge Request Hook',
          'x-gitlab-event-uuid': MERGE_UUID,
        }
      )
      assert.equal(mergeReceipt.status, 'created')

      issue = await waitForValue(
        () => cloudRequest(`/api/v1/cloud-projects/${projectId}/loop-items`),
        response => {
          const item = (response.items ?? []).find(candidate => candidate.id === issue.id)
          const statuses = nodeStatuses(item)
          return Boolean(item && statuses['wait-1'] === 'completed' && item.status === 'in_review')
        },
        'The merged event did not complete the wait node and move the Issue to in_review',
        uiTimeoutMs * 3
      ).then(response => response.items.find(candidate => candidate.id === issue.id))
      const finalStatuses = nodeStatuses(issue)
      assert.equal(finalStatuses['wait-1'], 'completed')
      assert.equal(issue.status, 'in_review')
      await control.command('waitFor', '[data-testid="cloud-todo-workflow-node-wait-1"]', {
        text: '已完成',
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(control, 'external-event-07-merged-issue-in-review.png')
    },

    diagnostics() {
      return {
        cloudProjectId: cloudProject?.id ?? null,
        cloudAgentId: cloudAgent?.id ?? null,
        workflowRuleId: workflowRule?.id ?? null,
        issueId: issue?.id ?? null,
        stageRunId: stageRun?.id ?? null,
        firstExecutionId: firstExecution?.id ?? null,
        rerunExecutionId: rerunExecution?.id ?? null,
        registrationCompleted,
      }
    },
  }
}
