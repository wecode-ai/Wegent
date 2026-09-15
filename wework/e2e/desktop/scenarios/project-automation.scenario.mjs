import assert from 'node:assert/strict'

import { verifyTeamCatalogPagination } from '../modules/team-catalog-pagination.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  assistantMessage,
  createSse,
  mcpToolRequestEvents,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'
import { CLOUD_DEVICE_ID, CLOUD_PUBLIC_MODEL_NAME } from '../modules/shared.mjs'

const ACTIVE_WORKBENCH_SELECTOR = '[data-workspace-tab-content][aria-hidden="false"]'
const LOCAL_WORKSPACE_ID = 'wework-local-workspace'
const WORKSPACE_NAME = '自动化策略验收空间'
const PROJECT_NAME = '自动化策略验收项目'
const POLICY_NAME = '每日检查待处理 Issue'
const ISSUE_TITLE = '顺序执行 Claude 与 Codex'
const CLAUDE_AGENT_NAME = 'Claude'
const CODEX_AGENT_NAME = 'Codex'
const CLAUDE_STAGE_NAME = 'Claude 实现'
const CODEX_STAGE_NAME = 'Codex 验证'
const CLAUDE_TASK_TITLE = 'Claude 完成实现'
const CODEX_TASK_TITLE = 'Codex 完成验证'
const CLAUDE_TASK_PROMPT = '完成 Claude 实现阶段，并通过项目空间工具报告 passed。'
const CODEX_TASK_PROMPT = '完成 Codex 验证阶段，并通过项目空间工具报告 passed。'
const CLAUDE_REPORT_CALL_ID = 'project-automation-report-claude'
const CLAUDE_REPORT_SEARCH_ID = 'project-automation-search-report-claude'
const CODEX_REPORT_CALL_ID = 'project-automation-report-codex'
const CODEX_REPORT_SEARCH_ID = 'project-automation-search-report-codex'
const CLAUDE_PLAN_CALL_ID = 'project-automation-plan-claude'
const CLAUDE_PLAN_SEARCH_ID = 'project-automation-search-plan-claude'
const CODEX_PLAN_CALL_ID = 'project-automation-plan-codex'
const CODEX_PLAN_SEARCH_ID = 'project-automation-search-plan-codex'
const POLICY_PROMPT =
  '检查项目内待处理的 Issue，拆分为可独立验证的工作，并把执行证据写回对应 Issue。'

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

function apiField(record, camelName, snakeName) {
  return record?.[camelName] ?? record?.[snakeName]
}

function scoped(selector) {
  return `${ACTIVE_WORKBENCH_SELECTOR} ${selector}`
}

async function snapshot(control, selector = ACTIVE_WORKBENCH_SELECTOR) {
  return JSON.parse(await control.command('snapshot', selector))
}

async function waitForApiValue(load, predicate, message, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let latest = null
  while (Date.now() < deadline) {
    latest = await load()
    const value = predicate(latest)
    if (value) return value === true ? latest : value
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`${message}: ${JSON.stringify(latest)}`)
}

export function createDesktopScenario({ captureScreenshot, uiTimeoutMs, workbenchReadyTimeoutMs }) {
  let backendUrl = ''
  let authToken = ''
  let workspace = null
  let project = null
  let policy = null
  let runtimeProfile = null
  let cloudDevice = null
  let issue = null
  let claudeAgent = null
  let codexAgent = null
  let claudeTask = null
  let codexTask = null
  let fixtureArchived = false
  let modelRequestCount = 0
  const submittedStages = new Set()
  const reportedStages = new Set()
  let releaseClaudeReport = () => undefined
  let releaseCodexReport = () => undefined
  const claudeReportGate = new Promise(resolve => {
    releaseClaudeReport = resolve
  })
  const codexReportGate = new Promise(resolve => {
    releaseCodexReport = resolve
  })

  const request = (pathname, options) => requestJson(backendUrl, authToken, pathname, options)
  const capture = (control, name) => captureScreenshot(control, name, ACTIVE_WORKBENCH_SELECTOR)

  async function archiveFixture() {
    if (fixtureArchived) return
    try {
      if (project) {
        const latestProject = await request(`/api/v1/cloud-projects/${project.id}`)
        if (latestProject.status !== 'archived') {
          await request(`/api/v1/cloud-projects/${project.id}?version=${latestProject.version}`, {
            method: 'DELETE',
          })
        }
      }
      if (workspace) {
        const latestWorkspace = await request(`/api/v1/workspaces/${workspace.id}`)
        if (latestWorkspace.status !== 'archived') {
          await request(`/api/v1/workspaces/${workspace.id}?version=${latestWorkspace.version}`, {
            method: 'DELETE',
          })
        }
      }
    } finally {
      fixtureArchived = true
    }
  }

  return {
    requiresCloudEnvironment: true,

    async handleHttp(incomingRequest, response, url) {
      if (
        incomingRequest.method !== 'POST' ||
        !['/responses', '/v1/responses'].includes(url.pathname)
      ) {
        return false
      }
      const chunks = []
      for await (const chunk of incomingRequest) chunks.push(chunk)
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const serialized = JSON.stringify(payload)
      const responseId = `project-automation-${++modelRequestCount}`
      if (
        serialized.includes('"request_kind":"prewarm"') ||
        (modelRequestCount === 1 && !payload.tools?.length)
      ) {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
        response.end(createSse([responseCreated(responseId), responseCompleted(responseId)]))
        return true
      }

      const managerRequest = serialized.includes('你是看板的 AI 管家，只负责编排')
      if (managerRequest) {
        const stage = requestContainsToolOutput(payload, CLAUDE_PLAN_CALL_ID)
          ? {
              callId: CLAUDE_PLAN_CALL_ID,
              searchId: CLAUDE_PLAN_SEARCH_ID,
              completion: 'CLAUDE_STAGE_PLAN_SUBMITTED',
              plan: {
                summary: 'Run the required Claude stage.',
                items: [
                  {
                    client_key: 'claude-stage-task',
                    title: CLAUDE_TASK_TITLE,
                    description: CLAUDE_TASK_PROMPT,
                    assignee_type: 'agent',
                    assignee_id: claudeAgent.id,
                    assignee_name: claudeAgent.name,
                    rationale: 'The first stage is constrained to Claude.',
                  },
                ],
              },
            }
          : requestContainsToolOutput(payload, CODEX_PLAN_CALL_ID) ||
              submittedStages.has(CLAUDE_PLAN_CALL_ID)
            ? {
                callId: CODEX_PLAN_CALL_ID,
                searchId: CODEX_PLAN_SEARCH_ID,
                completion: 'CODEX_STAGE_PLAN_SUBMITTED',
                plan: {
                  summary: 'Run the required Codex stage.',
                  items: [
                    {
                      client_key: 'codex-stage-task',
                      title: CODEX_TASK_TITLE,
                      description: CODEX_TASK_PROMPT,
                      assignee_type: 'agent',
                      assignee_id: codexAgent.id,
                      assignee_name: codexAgent.name,
                      rationale: 'The second stage is constrained to Codex.',
                    },
                  ],
                },
              }
            : {
                callId: CLAUDE_PLAN_CALL_ID,
                searchId: CLAUDE_PLAN_SEARCH_ID,
                completion: 'CLAUDE_STAGE_PLAN_SUBMITTED',
                plan: {
                  summary: 'Run the required Claude stage.',
                  items: [
                    {
                      client_key: 'claude-stage-task',
                      title: CLAUDE_TASK_TITLE,
                      description: CLAUDE_TASK_PROMPT,
                      assignee_type: 'agent',
                      assignee_id: claudeAgent.id,
                      assignee_name: claudeAgent.name,
                      rationale: 'The first stage is constrained to Claude.',
                    },
                  ],
                },
              }
        const submitted = requestContainsToolOutput(payload, stage.callId)
        if (submitted) submittedStages.add(stage.callId)
        const events = submitted
          ? [assistantMessage(stage.completion)]
          : mcpToolRequestEvents(payload, {
              toolName: 'submit_workflow_plan',
              argumentsValue: { plan: stage.plan },
              searchCallId: stage.searchId,
              toolCallId: stage.callId,
            }).events
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
        response.end(
          createSse([responseCreated(responseId), ...events, responseCompleted(responseId)])
        )
        return true
      }

      const stage = serialized.includes(CLAUDE_TASK_PROMPT)
        ? {
            callId: CLAUDE_REPORT_CALL_ID,
            searchId: CLAUDE_REPORT_SEARCH_ID,
            summary: 'Claude implementation completed.',
            completion: 'CLAUDE_STAGE_REPORTED_PASSED',
          }
        : serialized.includes(CODEX_TASK_PROMPT)
          ? {
              callId: CODEX_REPORT_CALL_ID,
              searchId: CODEX_REPORT_SEARCH_ID,
              summary: 'Codex verification completed.',
              completion: 'CODEX_STAGE_REPORTED_PASSED',
            }
          : null
      if (!stage) return false

      const reported = requestContainsToolOutput(payload, stage.callId)
      if (reported) reportedStages.add(stage.callId)
      if (!reported) {
        await (stage.callId === CLAUDE_REPORT_CALL_ID ? claudeReportGate : codexReportGate)
      }
      const events = reported
        ? [assistantMessage(stage.completion)]
        : mcpToolRequestEvents(payload, {
            toolName: 'report_workflow_outcome',
            argumentsValue: {
              verdict: 'passed',
              summary: stage.summary,
              findings: [],
            },
            searchCallId: stage.searchId,
            toolCallId: stage.callId,
          }).events
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(
        createSse([responseCreated(responseId), ...events, responseCompleted(responseId)])
      )
      return true
    },

    async prepareCloud(cloud) {
      backendUrl = cloud.backendUrl
      authToken = cloud.authToken
      await request('/api/admin/setup-complete', { method: 'POST' })
    },

    async verify(control) {
      try {
        await ensureExperimentalFeaturesEnabled(control)
        const catalog = await request('/api/teams?page=1&limit=100')
        const sourceTeam = catalog.items?.[0]
        assert.ok(sourceTeam?.id, 'Team catalog pagination requires a real Team fixture')
        await verifyTeamCatalogPagination(control, request, sourceTeam)
        await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
          timeoutMs: workbenchReadyTimeoutMs,
        })
        await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
        await control.command('waitFor', scoped('[data-testid="wework-collaboration-platform"]'), {
          timeoutMs: uiTimeoutMs,
        })
        await control.command('waitFor', scoped('[data-testid="collaboration-platform-root"]'), {
          timeoutMs: uiTimeoutMs,
        })

        const platformSnapshot = await snapshot(control)
        assert.ok(
          platformSnapshot.testIds.includes('wework-collaboration-platform') &&
            platformSnapshot.testIds.includes('collaboration-platform-root'),
          'The Collaboration tab did not render the native shared module'
        )
        assert.equal(
          Number(await control.command('getElementCount', scoped('iframe'))),
          0,
          'Wework Collaboration must not render the shared module through an iframe'
        )
        await control.command(
          'waitFor',
          scoped(`[data-testid="collaboration-workspace-${LOCAL_WORKSPACE_ID}"]`),
          {
            text: '本地空间',
            timeoutMs: uiTimeoutMs,
          }
        )
        await capture(control, 'project-automation-01-shared-platform.png')

        const workspaceName = `${WORKSPACE_NAME}-${process.pid}`
        await control.command('click', scoped('[data-testid="collaboration-workspace-create"]'))
        await control.command(
          'waitFor',
          scoped('[data-testid="collaboration-workspace-name-input"]'),
          { timeoutMs: uiTimeoutMs }
        )
        await control.command(
          'fill',
          scoped('[data-testid="collaboration-workspace-name-input"]'),
          { value: workspaceName }
        )
        await control.command(
          'fill',
          scoped('[data-testid="collaboration-workspace-description-input"]'),
          { value: '验证 Wework 原生共享协作模块中的云端自动化策略。' }
        )
        await control.command(
          'clickWhenEnabled',
          scoped('[data-testid="collaboration-workspace-create-confirm"]'),
          { timeoutMs: uiTimeoutMs }
        )
        workspace = await waitForApiValue(
          async () => {
            const response = await request('/api/v1/workspaces')
            return response.items?.find(candidate => candidate.name === workspaceName) ?? null
          },
          value => Boolean(value),
          'Creating the cloud Workspace through the shared module did not persist',
          uiTimeoutMs
        )
        await control.command(
          'waitFor',
          scoped('[data-testid="collaboration-workspace-project-create"]'),
          { timeoutMs: uiTimeoutMs }
        )

        const projectName = `${PROJECT_NAME}-${process.pid}`
        await control.command(
          'click',
          scoped('[data-testid="collaboration-workspace-project-create"]')
        )
        await control.command(
          'waitFor',
          scoped('[data-testid="collaboration-project-create-dialog"]'),
          { timeoutMs: uiTimeoutMs }
        )
        await control.command('waitFor', scoped('[data-testid="cloud-project-location-cloud"]'), {
          text: '云端',
          timeoutMs: uiTimeoutMs,
        })
        assert.equal(
          await control.command(
            'getAttribute',
            scoped('[data-testid="cloud-project-location-cloud"]'),
            { value: 'aria-pressed' }
          ),
          '',
          'A cloud Workspace must show an immutable cloud location summary, not a location toggle'
        )
        assert.equal(
          Number(
            await control.command(
              'getElementCount',
              scoped('[data-testid="cloud-project-location-local"]')
            )
          ),
          0,
          'A cloud Workspace must not offer local project storage'
        )
        await control.command('fill', scoped('[data-testid="collaboration-project-name-input"]'), {
          value: projectName,
        })
        await control.command(
          'fill',
          scoped('[data-testid="collaboration-project-description-input"]'),
          { value: '自动化策略属于项目设置，不是独立画布。' }
        )
        await control.command(
          'clickWhenEnabled',
          scoped('[data-testid="collaboration-project-create-confirm"]'),
          { timeoutMs: uiTimeoutMs }
        )
        project = await waitForApiValue(
          async () => {
            const response = await request(`/api/v1/workspaces/${workspace.id}/projects`)
            return response.items?.find(candidate => candidate.name === projectName) ?? null
          },
          value => Boolean(value),
          'Creating the cloud Project through the shared module did not persist',
          uiTimeoutMs
        )
        const profiles = await request('/api/v1/runtime-profiles')
        runtimeProfile =
          profiles.find(candidate => candidate.name === `${POLICY_NAME}-${process.pid}`) ??
          (await request('/api/v1/runtime-profiles', {
            method: 'POST',
            body: JSON.stringify({
              name: `${POLICY_NAME}-${process.pid}`,
              executionEnvironment: 'cloud',
              executionDeviceId: CLOUD_DEVICE_ID,
              model: CLOUD_PUBLIC_MODEL_NAME,
              modelType: 'public',
              modelOptions: {
                weworkCloudModelNamespace: 'default',
                weworkCloudModelResourceUserId: '0',
                weworkCloudModelUpstreamApiFormat: 'openai-responses',
              },
              workspacePolicy: 'project',
            }),
          }))
        await request(`/api/v1/cloud-projects/${project.id}/runtime-default`, {
          method: 'PUT',
          body: JSON.stringify({ runtimeProfileId: runtimeProfile.id }),
        })
        cloudDevice = await waitForApiValue(
          async () => {
            const devices = await request('/api/devices')
            return devices.items?.find(device => device.device_id === CLOUD_DEVICE_ID) ?? null
          },
          value => Boolean(value?.id),
          'The cloud execution device was not registered',
          uiTimeoutMs
        )
        await request(`/api/v1/cloud-projects/${project.id}/execution-environments`, {
          method: 'POST',
          body: JSON.stringify({ device_id: cloudDevice.id }),
        })
        claudeAgent = await request(`/api/v1/cloud-projects/${project.id}/chat-agents`, {
          method: 'POST',
          body: JSON.stringify({
            name: CLAUDE_AGENT_NAME,
            runtime: 'codex',
            systemPrompt: CLAUDE_TASK_PROMPT,
            capabilityDescription: 'Implements the first workflow stage.',
            visibility: 'creator_admin',
            executionEnvironment: 'local',
            executionMode: 'auto',
            executionDeviceId: CLOUD_DEVICE_ID,
            model: CLOUD_PUBLIC_MODEL_NAME,
            modelType: 'public',
            modelOptions: {
              weworkCloudModelNamespace: 'default',
              weworkCloudModelResourceUserId: '0',
              weworkCloudModelUpstreamApiFormat: 'openai-responses',
            },
            workspaceBinding: { type: 'standalone' },
            maxConcurrentExecutions: 1,
            workspacePolicy: 'project',
            plugins: [],
          }),
        })
        codexAgent = await request(`/api/v1/cloud-projects/${project.id}/chat-agents`, {
          method: 'POST',
          body: JSON.stringify({
            name: CODEX_AGENT_NAME,
            runtime: 'codex',
            systemPrompt: CODEX_TASK_PROMPT,
            capabilityDescription: 'Verifies the second workflow stage.',
            visibility: 'creator_admin',
            executionEnvironment: 'local',
            executionMode: 'auto',
            executionDeviceId: CLOUD_DEVICE_ID,
            model: CLOUD_PUBLIC_MODEL_NAME,
            modelType: 'public',
            modelOptions: {
              weworkCloudModelNamespace: 'default',
              weworkCloudModelResourceUserId: '0',
              weworkCloudModelUpstreamApiFormat: 'openai-responses',
            },
            workspaceBinding: { type: 'standalone' },
            maxConcurrentExecutions: 1,
            workspacePolicy: 'project',
            plugins: [],
          }),
        })
        await control.command(
          'click',
          scoped('[data-testid="collaboration-workspace-nav-projects"]')
        )
        await control.command(
          'click',
          scoped(`[data-testid="collaboration-workspace-project-${project.id}"]`)
        )
        await control.command('waitFor', scoped('[data-testid="collaboration-tab-manage"]'), {
          timeoutMs: uiTimeoutMs,
        })

        const projectSnapshot = await snapshot(control)
        assert.ok(
          projectSnapshot.testIds.includes('collaboration-tab-board') &&
            projectSnapshot.testIds.includes('collaboration-tab-table') &&
            projectSnapshot.testIds.includes('collaboration-tab-manage'),
          'The shared Project did not expose Board, Issue table, and Project settings'
        )
        assert.equal(
          projectSnapshot.testIds.includes('collaboration-tab-automation'),
          false,
          'Automation must not be a top-level Project tab'
        )
        await control.command('click', scoped('[data-testid="collaboration-tab-manage"]'))
        await control.command(
          'waitFor',
          scoped('[data-testid="collaboration-project-settings-dispatch"]'),
          { timeoutMs: uiTimeoutMs }
        )
        await control.command(
          'click',
          scoped('[data-testid="collaboration-project-settings-dispatch"]')
        )
        await control.command('waitFor', scoped('[data-testid="project-automation-policy"]'), {
          timeoutMs: uiTimeoutMs,
        })
        await capture(control, 'project-automation-02-policy-welcome.png')

        await control.command('click', scoped('[data-testid="automation-welcome-create-policy"]'))
        await control.command('waitFor', scoped('[data-testid="automation-policy-name"]'), {
          timeoutMs: uiTimeoutMs,
        })
        await control.command('click', scoped('[data-testid="automation-trigger-created"]'))
        await control.command('fill', scoped('[data-testid="automation-policy-name"]'), {
          value: POLICY_NAME,
        })
        await control.command('fill', scoped('[data-testid="automation-coordinator-prompt"]'), {
          value: POLICY_PROMPT,
        })
        await control.command('click', scoped('[data-testid="automation-approval-automatic"]'))
        await control.command('click', scoped('[data-testid="automation-empty-add-workflow-step"]'))
        await control.command('fill', scoped('[data-testid="automation-workflow-step-name-0"]'), {
          value: CLAUDE_STAGE_NAME,
        })
        await control.command(
          'fill',
          scoped('[data-testid="automation-workflow-step-description-0"]'),
          { value: CLAUDE_TASK_PROMPT }
        )
        await control.command(
          'select',
          scoped('[data-testid="automation-workflow-step-agent-0"]'),
          { value: claudeAgent.id }
        )
        await control.command('click', scoped('[data-testid="automation-add-workflow-step"]'))
        await control.command('fill', scoped('[data-testid="automation-workflow-step-name-1"]'), {
          value: CODEX_STAGE_NAME,
        })
        await control.command(
          'fill',
          scoped('[data-testid="automation-workflow-step-description-1"]'),
          { value: CODEX_TASK_PROMPT }
        )
        await control.command(
          'select',
          scoped('[data-testid="automation-workflow-step-agent-1"]'),
          { value: codexAgent.id }
        )
        await control.command(
          'clickWhenEnabled',
          scoped('[data-testid="automation-save-policy"]'),
          { timeoutMs: uiTimeoutMs }
        )
        policy = await waitForApiValue(
          () => request(`/api/v1/cloud-projects/${project.id}/automations`),
          rules => rules.find(rule => rule.name === POLICY_NAME) ?? null,
          'Saving the automation policy through Project settings did not persist',
          uiTimeoutMs
        )
        assert.equal(apiField(policy, 'triggerType', 'trigger_type'), 'event')
        assert.equal(apiField(policy, 'eventType', 'event_type'), 'task.created')
        assert.equal(apiField(policy, 'assignmentMode', 'assignment_mode'), 'ai_managed')
        assert.equal(apiField(policy, 'managerType', 'manager_type'), 'custom')
        assert.ok(
          policy.prompt.includes(POLICY_PROMPT),
          'The executable automation prompt lost the coordinator policy'
        )
        const policyEventConfig = apiField(policy, 'eventConfig', 'event_config')
        assert.equal(
          policyEventConfig.runtime_workflow_definition.coordinator_prompt,
          POLICY_PROMPT,
          'The canonical workflow definition did not preserve the natural-language policy'
        )
        const workflowDefinition = policyEventConfig.runtime_workflow_definition
        assert.deepEqual(
          workflowDefinition.nodes.map(node => ({
            name: node.name,
            dependsOn: node.depends_on,
            assigneeType: node.required_assignee_type,
            assigneeId: node.required_assignee_id,
          })),
          [
            {
              name: CLAUDE_STAGE_NAME,
              dependsOn: [],
              assigneeType: 'agent',
              assigneeId: claudeAgent.id,
            },
            {
              name: CODEX_STAGE_NAME,
              dependsOn: [workflowDefinition.nodes[0].id],
              assigneeType: 'agent',
              assigneeId: codexAgent.id,
            },
          ],
          'The saved automation did not preserve the Claude to Codex stage dependency'
        )
        await control.command('waitFor', scoped('[data-testid="automation-save-policy"]'), {
          text: '已保存',
          timeoutMs: uiTimeoutMs,
        })
        await capture(control, 'project-automation-03-policy-saved.png')

        await control.command('click', scoped('[data-testid="collaboration-tab-board"]'))
        await control.command('waitFor', scoped('[data-testid="collaboration-empty-project"]'), {
          timeoutMs: uiTimeoutMs,
        })
        await control.command('click', scoped('[data-testid="collaboration-tab-manage"]'))
        await control.command(
          'click',
          scoped('[data-testid="collaboration-project-settings-dispatch"]')
        )
        await control.command('waitFor', scoped('[data-testid="automation-policy-name"]'), {
          timeoutMs: uiTimeoutMs,
        })
        assert.equal(
          await control.command('getValue', scoped('[data-testid="automation-policy-name"]')),
          POLICY_NAME,
          'Re-entering Project settings did not restore the persisted policy'
        )

        issue = await request(`/api/v1/cloud-projects/${project.id}/loop-items`, {
          method: 'POST',
          body: JSON.stringify({
            title: ISSUE_TITLE,
            description: 'The same Issue must advance through Claude and then Codex.',
            status: 'inbox',
            automation_rule_id: policy.id,
          }),
        })
        issue = await waitForApiValue(
          () => request(`/api/v1/loop-items/${issue.id}`),
          value => value?.workflow?.nodes?.length === 2,
          'The selected automation did not snapshot its workflow onto the created Issue',
          uiTimeoutMs
        )
        assert.equal(issue.workflow.ai_automation_rule_id, policy.id)

        const claudePlan = await waitForApiValue(
          () => request(`/api/v1/loop-items/${issue.id}/workflow-plan`),
          value =>
            value?.status === 'running' &&
            value.stage_id === workflowDefinition.nodes[0].id &&
            value.items?.length === 1,
          'The AI manager did not submit the Claude-stage workflow plan',
          Math.max(uiTimeoutMs, 60_000)
        )
        assert.equal(claudePlan.stage_id, workflowDefinition.nodes[0].id)
        assert.equal(claudePlan.status, 'running')
        issue = await waitForApiValue(
          () => request(`/api/v1/loop-items/${issue.id}`),
          value =>
            value?.status === 'in_progress' &&
            value.workflow?.nodes?.[0]?.status === 'running' &&
            value.workflow?.nodes?.[1]?.status === 'blocked',
          'The Claude child execution did not enter running while Codex stayed blocked',
          Math.max(uiTimeoutMs, 60_000)
        )
        assert.equal(issue.status, 'in_progress')
        assert.deepEqual(
          issue.workflow.nodes.map(node => node.status),
          ['running', 'blocked'],
          'The Issue did not keep Codex blocked while the Claude stage was running'
        )
        await control.command('click', scoped('[data-testid="collaboration-tab-board"]'))
        const issueCard = scoped(`[data-testid="cloud-todo-card-${issue.id}"]`)
        await control.command('waitFor', issueCard, { timeoutMs: uiTimeoutMs })
        await control.command('click', issueCard)
        await control.command('waitFor', scoped('[data-testid="collaboration-issue-detail"]'), {
          timeoutMs: uiTimeoutMs,
        })
        await control.command(
          'waitFor',
          scoped('[data-testid="collaboration-automation-stage-0"][data-status="running"]'),
          { text: '执行中 · Claude · 云端空间', timeoutMs: uiTimeoutMs }
        )
        await control.command(
          'waitFor',
          scoped('[data-testid="collaboration-automation-stage-1"][data-status="blocked"]'),
          { text: `等待 ${CLAUDE_STAGE_NAME} 完成`, timeoutMs: uiTimeoutMs }
        )
        await capture(control, 'project-automation-04-claude-running-codex-blocked.png')
        releaseClaudeReport()
        claudeTask = await waitForApiValue(
          () => request(`/api/v1/loop-items/${claudePlan.items[0].task_id}`),
          value => value?.status === 'completed',
          'The real Claude-stage child task did not complete and report passed',
          Math.max(uiTimeoutMs, 60_000)
        )
        const codexPlan = await waitForApiValue(
          () => request(`/api/v1/loop-items/${issue.id}/workflow-plan`),
          value =>
            value?.status === 'running' &&
            value.stage_id === workflowDefinition.nodes[1].id &&
            value.items?.length === 1,
          'The passed Claude stage did not dispatch the same AI manager for Codex planning',
          Math.max(uiTimeoutMs, 60_000)
        )
        issue = await waitForApiValue(
          () => request(`/api/v1/loop-items/${issue.id}`),
          value =>
            value?.status === 'in_progress' &&
            value.workflow?.nodes?.[0]?.status === 'completed' &&
            value.workflow?.nodes?.[1]?.status === 'running',
          'The Codex child execution did not start after Claude completed',
          Math.max(uiTimeoutMs, 60_000)
        )
        assert.equal(issue.status, 'in_progress')
        assert.deepEqual(
          issue.workflow.nodes.map(node => node.status),
          ['completed', 'running'],
          'The Issue advanced out of order or did not start Codex after Claude passed'
        )
        await control.command('click', scoped('[data-testid="cloud-todo-detail-close"]'))
        await control.command(
          'waitFor',
          scoped(`[data-testid="cloud-todo-card-workflow-stage-${issue.id}"]`),
          {
            text: CODEX_STAGE_NAME,
            timeoutMs: uiTimeoutMs,
          }
        )
        await control.command('click', issueCard)
        await control.command('waitFor', scoped('[data-testid="collaboration-issue-detail"]'), {
          timeoutMs: uiTimeoutMs,
        })
        await control.command(
          'waitFor',
          scoped('[data-testid="collaboration-automation-stage-0"][data-status="completed"]'),
          { text: '已完成 · Claude · 云端空间', timeoutMs: uiTimeoutMs }
        )
        await control.command(
          'waitFor',
          scoped('[data-testid="collaboration-automation-stage-1"][data-status="running"]'),
          { text: '执行中 · Codex · 云端空间', timeoutMs: uiTimeoutMs }
        )
        await capture(control, 'project-automation-05-claude-completed-codex-running.png')
        const claudeExecutions = await waitForApiValue(
          () =>
            request(
              `/api/v1/cloud-projects/${project.id}/executions?agent_id=${encodeURIComponent(claudeAgent.id)}&include_terminal=true`
            ),
          value =>
            value?.items.some(
              execution =>
                execution.loopItemId === claudeTask.id && execution.status === 'completed'
            ),
          'The Claude-stage child task reported passed before its real execution completed',
          uiTimeoutMs
        )
        assert.ok(
          claudeExecutions.items.some(
            execution => execution.loopItemId === claudeTask.id && execution.status === 'completed'
          ),
          'The Claude-stage child task completed without a completed real execution'
        )

        assert.equal(codexPlan.stage_id, workflowDefinition.nodes[1].id)
        assert.equal(codexPlan.status, 'running')
        releaseCodexReport()
        codexTask = await waitForApiValue(
          () => request(`/api/v1/loop-items/${codexPlan.items[0].task_id}`),
          value => value?.status === 'completed',
          'The real Codex-stage child task did not complete and report passed',
          Math.max(uiTimeoutMs, 60_000)
        )
        issue = await waitForApiValue(
          () => request(`/api/v1/loop-items/${issue.id}`),
          value =>
            value?.status === 'completed' &&
            value.workflow?.orchestration_status === 'completed' &&
            value.workflow.nodes.every(node => node.status === 'completed'),
          'The same Issue did not complete after Claude and Codex both reported passed',
          uiTimeoutMs
        )
        const codexExecutions = await waitForApiValue(
          () =>
            request(
              `/api/v1/cloud-projects/${project.id}/executions?agent_id=${encodeURIComponent(codexAgent.id)}&include_terminal=true`
            ),
          value =>
            value?.items.some(
              execution => execution.loopItemId === codexTask.id && execution.status === 'completed'
            ),
          'The Codex-stage child task reported passed before its real execution completed',
          uiTimeoutMs
        )
        assert.ok(
          codexExecutions.items.some(
            execution => execution.loopItemId === codexTask.id && execution.status === 'completed'
          ),
          'The Codex-stage child task completed without a completed real execution'
        )
        assert.ok(
          issue.status_history.some(entry => entry.trigger === 'workflow_stage_advanced') &&
            issue.status_history.some(entry => entry.to_status === 'completed'),
          'The final Issue response did not preserve the stage advance and completion history'
        )
        assert.deepEqual(
          [...reportedStages].sort(),
          [CLAUDE_REPORT_CALL_ID, CODEX_REPORT_CALL_ID].sort(),
          'Both workflow tasks must successfully return from report_workflow_outcome'
        )
        assert.deepEqual(
          [...submittedStages].sort(),
          [CLAUDE_PLAN_CALL_ID, CODEX_PLAN_CALL_ID].sort(),
          'The same AI manager must successfully submit both sequential workflow plans'
        )
        await control.command('click', scoped('[data-testid="collaboration-tab-board"]'))
        const completedCard = scoped(
          `[data-testid="cloud-todo-column-completed"] [data-testid="cloud-todo-card-${issue.id}"]`
        )
        await control.command('waitFor', completedCard, { timeoutMs: uiTimeoutMs })
        await control.command('click', completedCard)
        await control.command('waitFor', scoped('[data-testid="collaboration-issue-detail"]'), {
          timeoutMs: uiTimeoutMs,
        })
        assert.equal(
          await control.command('getValue', scoped('[data-testid="cloud-todo-detail-status"]')),
          'completed',
          'The completed workflow state was not rendered in the Issue detail'
        )
        await control.command(
          'waitFor',
          scoped('[data-testid="collaboration-automation-progress"]'),
          { text: '2 / 2', timeoutMs: uiTimeoutMs }
        )
        await control.command(
          'waitFor',
          scoped('[data-testid="collaboration-automation-execution"]'),
          {
            text: '所有自动化阶段已完成，Issue 已自动完成',
            timeoutMs: uiTimeoutMs,
          }
        )
        await capture(control, 'project-automation-06-sequential-workflow-completed.png')
      } finally {
        releaseClaudeReport()
        releaseCodexReport()
        try {
          await archiveFixture()
        } catch (error) {
          console.warn(
            `[project-automation] fixture cleanup deferred after verification failure: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
    },

    async cleanup() {
      await archiveFixture()
    },

    diagnostics() {
      return {
        claudeAgentId: claudeAgent?.id ?? null,
        claudeTaskId: claudeTask?.id ?? null,
        codexAgentId: codexAgent?.id ?? null,
        codexTaskId: codexTask?.id ?? null,
        fixtureArchived,
        issueId: issue?.id ?? null,
        modelRequestCount,
        policyId: policy?.id ?? null,
        projectId: project?.id ?? null,
        reportedStages: [...reportedStages],
        runtimeProfileId: runtimeProfile?.id ?? null,
        submittedStages: [...submittedStages],
        workspaceId: workspace?.id ?? null,
      }
    },
  }
}
