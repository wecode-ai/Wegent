import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { localHarnessCliPath } from '../modules/local-harness-cli.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  createSse,
  functionCall,
  mcpToolRequestEvents,
  namespacedFunctionCall,
  readRequestBody,
  requestContainsToolOutput,
  requestToolSearchResults,
  responseCompleted,
  responseCreated,
  selectMcpTool,
  streamingTextEvents,
} from '../modules/response-protocol.mjs'
import { CLOUD_DEVICE_ID } from '../modules/shared.mjs'

const ACTIVE_WORKBENCH_SELECTOR = '[data-workspace-tab-content][aria-hidden="false"]'
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const SKILL_NAME = 'wework-plugin-creator'
const SKILL_UI_REFERENCE = `codex/${SKILL_NAME}`
const MCP_NAMESPACE = 'wework_space'
const WORKSPACE_NAME = '协作链路验收空间'
const PROJECT_NAME = '双智能体自动处理项目'
const CODEX_AGENT_NAME = '协作链 Codex'
const CLAUDE_AGENT_NAME = '协作链 Claude Code'
const GROUP_NAME = 'Codex 到 Claude 协作小组'
const CODEX_STAGE_NAME = 'Codex 先行处理'
const CLAUDE_STAGE_NAME = 'Claude Code 复核收敛'
const MATCHING_TAG = '协作验收'
const CREATED_ISSUE_TITLE = '创建事件触发双智能体'
const TAG_ISSUE_TITLE = 'Tag 事件触发双智能体'
const CODEX_SYSTEM_MARKER = 'COLLABORATION_CODEX_AGENT_E2E'
const CLAUDE_SYSTEM_MARKER = 'COLLABORATION_CLAUDE_AGENT_E2E'
const MODEL_COMPLETION_MARKER = 'COLLABORATION_AUTOMATION_STAGE_COMPLETED'
const MODEL_NAME = 'desktop-e2e-public-model'
const TOOL_SEQUENCE = ['get_current_context', 'get_board_item', 'add_board_item_comment']

function scoped(selector) {
  return `${ACTIVE_WORKBENCH_SELECTOR} ${selector}`
}

async function resolveClaudeBinary() {
  const executableName = process.platform === 'win32' ? 'claude.cmd' : 'claude'
  const candidates = [
    process.env.WEWORK_E2E_CLAUDE_BINARY,
    localHarnessCliPath(
      join(REPOSITORY_ROOT, '.github', 'claude-code-cli', 'node_modules', '.bin'),
      'claude'
    ),
    ...String(process.env.PATH ?? '')
      .split(delimiter)
      .filter(Boolean)
      .map(directory => join(directory, executableName)),
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // Continue through explicit and PATH-based real Claude Code CLI candidates.
    }
  }
  assert.fail(`A real Claude Code CLI was not found: ${candidates.join(', ')}`)
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

async function waitForValue(read, predicate, message, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let latest = null
  while (Date.now() < deadline) {
    latest = await read()
    const result = predicate(latest)
    if (result) return result === true ? latest : result
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  assert.fail(`${message}; last value: ${JSON.stringify(latest)}`)
}

function findToolOutput(value, callId) {
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const output = findToolOutput(candidate, callId)
      if (output !== undefined) return output
    }
    return undefined
  }
  if (!value || typeof value !== 'object') return undefined
  if (
    [
      'function_call_output',
      'mcp_tool_call_output',
      'custom_tool_call_output',
      'tool_search_output',
    ].includes(value.type) &&
    value.call_id === callId
  ) {
    return value.output
  }
  for (const candidate of Object.values(value)) {
    const output = findToolOutput(candidate, callId)
    if (output !== undefined) return output
  }
  return undefined
}

function serializedToolOutput(body, callId) {
  const output = findToolOutput(body.input ?? [], callId)
  assert.notEqual(output, undefined, `Missing tool output for ${callId}`)
  return JSON.stringify(output)
}

function convertedToolName(body, toolName) {
  return (body.tools ?? [])
    .map(tool => tool?.name ?? tool?.function?.name)
    .find(name => name === toolName || name?.endsWith(`__${toolName}`))
}

function stageKey(issue, agent) {
  return `${issue.id}:${agent}`
}

function stageCallIds(issue, agent) {
  const prefix = `collaboration-${issue.id}-${agent}`
  return {
    contextSearch: `${prefix}-search-current-context`,
    contextCall: `${prefix}-get-current-context`,
    itemSearch: `${prefix}-search-board-item`,
    itemCall: `${prefix}-get-board-item`,
    commentSearch: `${prefix}-search-add-comment`,
    commentCall: `${prefix}-add-comment`,
  }
}

function stageComment(issue, agent) {
  const trigger = issue.title === CREATED_ISSUE_TITLE ? 'create' : 'tag'
  return `COLLAB_E2E:${issue.id}:${trigger}:${agent}:completed`
}

function executionItems(response, issueId) {
  return (response.items ?? []).filter(execution => execution.loopItemId === issueId)
}

function terminalExecution(execution) {
  return ['completed', 'failed', 'cancelled'].includes(execution.status)
}

function terminalAutomationRun(run) {
  return ['succeeded', 'failed', 'skipped', 'cancelled'].includes(run.status)
}

function agentList(response) {
  return Array.isArray(response) ? response : (response?.items ?? [])
}

function summarizeModelRequest(body, issue, agent, ids) {
  return {
    agent,
    issue: issue?.title ?? null,
    model: body.model ?? null,
    previousResponseId: body.previous_response_id ?? null,
    toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
    completedCalls: ids
      ? Object.entries(ids)
          .filter(([, callId]) => requestContainsToolOutput(body, callId))
          .map(([name]) => name)
      : [],
  }
}

function deferred() {
  let resolve = () => undefined
  const promise = new Promise(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

export async function createDesktopScenario({
  captureScreenshot,
  uiTimeoutMs,
  workbenchReadyTimeoutMs,
}) {
  const claudeBinary = await resolveClaudeBinary()
  let backendUrl = ''
  let authToken = ''
  let workspace = null
  let project = null
  let codexAgent = null
  let claudeAgent = null
  let collaborationGroup = null
  let createdRule = null
  let tagRule = null
  let createdIssue = null
  let tagIssue = null
  let active = false
  let fixtureArchived = false
  const modelRequests = []
  const modelStages = []
  const actualToolCalls = []
  const persistedComments = []
  const pendingCompletions = new Map()

  const request = (pathname, options) => requestJson(backendUrl, authToken, pathname, options)
  const capture = (control, name) => captureScreenshot(control, name, ACTIVE_WORKBENCH_SELECTOR)

  function issueFromRequest(serialized) {
    for (const issue of [createdIssue, tagIssue].filter(Boolean)) {
      for (const agent of ['codex', 'claude_code']) {
        if (Object.values(stageCallIds(issue, agent)).some(callId => serialized.includes(callId))) {
          return issue
        }
      }
    }
    if (createdIssue && serialized.includes(CREATED_ISSUE_TITLE)) return createdIssue
    if (tagIssue && serialized.includes(TAG_ISSUE_TITLE)) return tagIssue
    return null
  }

  function agentFromRequest(serialized, issue) {
    if (issue) {
      for (const agent of ['codex', 'claude_code']) {
        const callIds = Object.values(stageCallIds(issue, agent))
        if (callIds.some(callId => serialized.includes(callId))) return agent
      }
    }
    if (serialized.includes(CODEX_SYSTEM_MARKER)) return 'codex'
    if (serialized.includes(CLAUDE_SYSTEM_MARKER)) return 'claude_code'
    return null
  }

  async function commentsFor(issue) {
    return request(`/api/v1/loop-items/${issue.id}/comments`)
  }

  async function waitForComment(issue, agent, timeoutMs) {
    const body = stageComment(issue, agent)
    const comments = await waitForValue(
      () => commentsFor(issue),
      values => {
        const matches = values.filter(comment => comment.body === body)
        return matches.length === 1 ? values : false
      },
      `The real wework_space MCP did not persist exactly one ${agent} comment for ${issue.title}`,
      timeoutMs
    )
    return comments.find(comment => comment.body === body)
  }

  function writeEvents(response, responseId, events) {
    response.writeHead(200, {
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'content-type': 'text/event-stream; charset=utf-8',
    })
    response.end(createSse([responseCreated(responseId), ...events, responseCompleted(responseId)]))
  }

  function directOrSearchEvents(body, toolName, argumentsValue, searchCallId, toolCallId) {
    return mcpToolRequestEvents(body, {
      toolName,
      argumentsValue,
      directToolName: convertedToolName(body, toolName),
      searchCallId,
      toolCallId,
    })
  }

  function namespacedCallAfterSearch(body, toolName, argumentsValue, toolCallId) {
    const searchedTools = requestToolSearchResults(body)
    const namespace = [...(body.tools ?? []), ...searchedTools].find(
      candidate =>
        candidate?.type === 'namespace' &&
        candidate.name === MCP_NAMESPACE &&
        candidate.tools?.some(tool => tool?.type === 'function' && tool.name === toolName)
    )
    if (namespace) {
      const tool = selectMcpTool(body, MCP_NAMESPACE, toolName, argumentsValue)
      return namespacedFunctionCall(toolCallId, tool.namespace, tool.name, tool.arguments)
    }
    const convertedName = [...(body.tools ?? []), ...searchedTools]
      .map(tool => tool?.name ?? tool?.function?.name)
      .find(name => name === toolName || name?.endsWith(`__${toolName}`))
    assert.ok(
      convertedName,
      `Deferred tool search did not expose ${MCP_NAMESPACE}.${toolName} or a converted Claude tool`
    )
    return functionCall(toolCallId, convertedName, argumentsValue)
  }

  function recordToolCall(issue, agent, toolName) {
    actualToolCalls.push({
      agent,
      issueId: issue.id,
      issueTitle: issue.title,
      toolName,
      sequence: actualToolCalls.length + 1,
    })
  }

  async function archiveFixture() {
    if (fixtureArchived) return
    if (project) {
      const rules = [createdRule, tagRule].filter(Boolean)
      for (const rule of rules) {
        const runs = await request(
          `/api/v1/cloud-projects/${project.id}/automations/${rule.id}/runs`
        )
        for (const run of runs.filter(candidate => !terminalAutomationRun(candidate))) {
          await request(`/api/v1/cloud-projects/${project.id}/automation-runs/${run.id}/cancel`, {
            method: 'POST',
          })
        }
      }
      const cleanupTimeoutMs = Math.max(uiTimeoutMs, 30_000)
      await waitForValue(
        () => request(`/api/v1/cloud-projects/${project.id}/executions?include_terminal=true`),
        response => response.items.every(terminalExecution),
        'Project executions remained active during fixture cleanup',
        cleanupTimeoutMs
      )
      for (const rule of rules) {
        await waitForValue(
          () => request(`/api/v1/cloud-projects/${project.id}/automations/${rule.id}/runs`),
          runs => runs.every(terminalAutomationRun),
          `Automation runs remained active for rule ${rule.id}`,
          cleanupTimeoutMs
        )
      }
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
    fixtureArchived = true
  }

  async function createWorkspaceAndProject(control) {
    await ensureExperimentalFeaturesEnabled(control)
    await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
      timeoutMs: workbenchReadyTimeoutMs,
    })
    await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
    await control.command('waitFor', scoped('[data-testid="collaboration-platform-root"]'), {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('waitFor', scoped('[data-testid="collaboration-workspace-create"]'), {
      visible: true,
      timeoutMs: uiTimeoutMs,
    })
    await capture(control, 'collaboration-agent-chain-01-workspaces.png')

    const workspaceName = `${WORKSPACE_NAME}-${process.pid}`
    await control.command('click', scoped('[data-testid="collaboration-workspace-create"]'))
    await control.command('waitFor', scoped('[data-testid="collaboration-workspace-name-input"]'), {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('fill', scoped('[data-testid="collaboration-workspace-name-input"]'), {
      value: workspaceName,
    })
    await control.command(
      'fill',
      scoped('[data-testid="collaboration-workspace-description-input"]'),
      { value: '真实桌面 E2E：双智能体、协作小组与事件自动处理。' }
    )
    await control.command(
      'clickWhenEnabled',
      scoped('[data-testid="collaboration-workspace-create-confirm"]'),
      { timeoutMs: uiTimeoutMs }
    )
    workspace = await waitForValue(
      async () => {
        const response = await request('/api/v1/workspaces')
        return response.items?.find(candidate => candidate.name === workspaceName) ?? null
      },
      Boolean,
      'The collaboration Workspace was not persisted by the real API',
      uiTimeoutMs
    )
    await capture(control, 'collaboration-agent-chain-02-workspace-created.png')

    const projectName = `${PROJECT_NAME}-${process.pid}`
    await control.command('click', scoped('[data-testid="collaboration-workspace-project-create"]'))
    await control.command('waitFor', scoped('[data-testid="collaboration-project-name-input"]'), {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('fill', scoped('[data-testid="collaboration-project-name-input"]'), {
      value: projectName,
    })
    await control.command(
      'fill',
      scoped('[data-testid="collaboration-project-description-input"]'),
      { value: '验证 Codex → Claude Code 的真实自动处理执行链。' }
    )
    await control.command(
      'clickWhenEnabled',
      scoped('[data-testid="collaboration-project-create-confirm"]'),
      { timeoutMs: uiTimeoutMs }
    )
    project = await waitForValue(
      async () => {
        const response = await request(`/api/v1/workspaces/${workspace.id}/projects`)
        return response.items?.find(candidate => candidate.name === projectName) ?? null
      },
      Boolean,
      'The collaboration Project was not persisted by the real API',
      uiTimeoutMs
    )
    await control.command('waitFor', scoped('[data-testid="cloud-project-header-title"]'), {
      text: projectName,
      timeoutMs: uiTimeoutMs,
    })
    await capture(control, 'collaboration-agent-chain-03-project-created.png')
  }

  async function configureExecutionDevice(control) {
    await control.command('click', scoped('[data-testid="collaboration-tab-manage"]'))
    await control.command(
      'click',
      scoped('[data-testid="collaboration-project-settings-environments"]')
    )
    await control.command(
      'waitFor',
      scoped('[data-testid="collaboration-project-execution-environment-select"]'),
      { timeoutMs: uiTimeoutMs }
    )
    const devices = await request('/api/devices')
    const device = devices.items.find(candidate => candidate.device_id === CLOUD_DEVICE_ID)
    assert.ok(device?.id, 'The real cloud Executor device was not registered')
    await control.command(
      'select',
      scoped('[data-testid="collaboration-project-execution-environment-select"]'),
      { value: String(device.id) }
    )
    await control.command(
      'clickWhenEnabled',
      scoped('[data-testid="collaboration-project-execution-environment-add"]'),
      { timeoutMs: uiTimeoutMs }
    )
    await control.command(
      'waitFor',
      scoped(`[data-testid="collaboration-project-execution-environment-${device.id}"]`),
      { timeoutMs: uiTimeoutMs }
    )
    const environments = await request(
      `/api/v1/cloud-projects/${project.id}/execution-environments`
    )
    assert.ok(
      environments.items.some(environment => environment.device_id === device.id),
      'The project device pool did not persist the real cloud Executor'
    )
    await capture(control, 'collaboration-agent-chain-04-device-pool.png')
  }

  async function createProjectAgentThroughUi(control, { name, runtime, systemMarker }) {
    const modelCatalog = await request(
      '/api/models/unified?include_config=true&scope=all&model_category_type=llm&client_origin=wework'
    )
    const selectableModels = (modelCatalog.data ?? []).filter(
      model => model.isActive !== false && model.modelCategoryType !== 'image'
    )
    const publicModelIndex = selectableModels.findIndex(
      model => model.name === MODEL_NAME && model.type === 'public'
    )
    assert.notEqual(publicModelIndex, -1, `${MODEL_NAME} is missing from the real model catalog`)
    await control.command('click', scoped('[data-testid="project-agent-add"]'))
    await control.command('waitFor', '[data-testid="project-agent-dialog"]', {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('click', '[data-testid="project-agent-mode-create"]')
    await control.command('waitFor', '[data-testid="project-agent-standard-create-form"]', {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('fill', '[data-testid="project-agent-local-name"]', {
      value: name,
    })
    await control.command('select', '[data-testid="project-agent-local-runtime"]', {
      value: runtime,
    })
    await control.command('select', '[data-testid="project-agent-local-model"]', {
      value: String(publicModelIndex),
    })
    await control.command('fill', '[data-testid="project-agent-local-capability"]', {
      value: `${name} 负责协作小组中的固定阶段。`,
    })
    await control.command('fill', '[data-testid="project-agent-local-system-prompt"]', {
      value: `${systemMarker}。按 Skill 约束工作，并严格依次调用 get_current_context、get_board_item、add_board_item_comment。`,
    })
    await control.command('fill', '[data-testid="project-agent-local-skills"]', {
      value: SKILL_UI_REFERENCE,
    })
    await control.command('fill', '[data-testid="project-agent-local-mcp"]', {
      value: '{}',
    })
    await control.command('clickWhenEnabled', '[data-testid="project-agent-local-create"]', {
      timeoutMs: uiTimeoutMs,
    })
    const agent = await waitForValue(
      () => request(`/api/v1/cloud-projects/${project.id}/chat-agents`),
      response => agentList(response).find(candidate => candidate.name === name) ?? false,
      `The ${runtime} Agent created through the real project UI was not persisted`,
      uiTimeoutMs
    )
    assert.equal(agent.runtime, runtime)
    assert.equal(agent.model, MODEL_NAME)
    assert.equal(agent.modelType, 'public')
    assert.equal(agent.modelOptions?.weworkCloudModelNamespace, 'default')
    assert.equal(agent.modelOptions?.weworkCloudModelResourceUserId, '0')
    assert.equal(agent.modelOptions?.weworkCloudModelUpstreamApiFormat, 'openai-responses')
    assert.ok(
      agent.additionalSkills?.some(
        skill => skill.name === SKILL_NAME && skill.namespace === 'codex'
      ),
      `${name} did not persist ${SKILL_UI_REFERENCE}`
    )
    assert.deepEqual(
      agent.mcpServers ?? {},
      {},
      `${name} must use the executor-owned wework_space MCP, not a test MCP server`
    )
    await control.command('waitFor', scoped(`[data-testid="project-agent-row-${agent.id}"]`), {
      text: name,
      timeoutMs: uiTimeoutMs,
    })
    return agent
  }

  async function configureAgents(control) {
    await control.command(
      'click',
      scoped('[data-testid="collaboration-project-settings-participants"]')
    )
    await control.command('click', scoped('[data-testid="collaboration-participants-tab-agents"]'))
    await control.command('waitFor', scoped('[data-testid="project-agent-config"]'), {
      timeoutMs: uiTimeoutMs,
    })
    codexAgent = await createProjectAgentThroughUi(control, {
      name: CODEX_AGENT_NAME,
      runtime: 'codex',
      systemMarker: CODEX_SYSTEM_MARKER,
    })
    await capture(control, 'collaboration-agent-chain-05-codex-configured.png')
    claudeAgent = await createProjectAgentThroughUi(control, {
      name: CLAUDE_AGENT_NAME,
      runtime: 'claude_code',
      systemMarker: CLAUDE_SYSTEM_MARKER,
    })
    assert.notEqual(codexAgent.id, claudeAgent.id)
    await capture(control, 'collaboration-agent-chain-06-claude-configured.png')
    await capture(control, 'collaboration-agent-chain-07-two-agents.png')
  }

  async function createCollaborationGroup(control) {
    await control.command('click', scoped('[data-testid="collaboration-participants-tab-groups"]'))
    await control.command('waitFor', scoped('[data-testid="collaboration-group-open-create"]'), {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('click', scoped('[data-testid="collaboration-group-open-create"]'))
    await control.command('fill', scoped('[data-testid="collaboration-group-name"]'), {
      value: GROUP_NAME,
    })
    await control.command('fill', scoped('[data-testid="collaboration-group-description"]'), {
      value: 'Codex 先完成实现，Claude Code 再复核并收敛。',
    })
    await control.command('select', scoped('[data-testid="collaboration-group-leader"]'), {
      value: `agent:${codexAgent.id}`,
    })
    await control.command(
      'clickWhenEnabled',
      scoped('[data-testid="collaboration-group-create"]'),
      { timeoutMs: uiTimeoutMs }
    )
    collaborationGroup = await waitForValue(
      async () => {
        const response = await request(`/api/v1/cloud-projects/${project.id}/collaboration-groups`)
        return response.items?.find(candidate => candidate.name === GROUP_NAME) ?? null
      },
      Boolean,
      'The collaboration group was not persisted',
      uiTimeoutMs
    )
    await control.command(
      'waitFor',
      scoped(`[data-testid="collaboration-group-detail-${collaborationGroup.id}"]`),
      { timeoutMs: uiTimeoutMs }
    )
    await capture(control, 'collaboration-agent-chain-08-group-created.png')

    await control.command(
      'click',
      scoped(`[data-testid="collaboration-group-detail-member-agent-${claudeAgent.id}"]`)
    )
    await control.command(
      'fill',
      scoped(`[data-testid="collaboration-group-detail-responsibility-agent-${codexAgent.id}"]`),
      { value: '先实现并给出可验证结果' }
    )
    await control.command(
      'fill',
      scoped(`[data-testid="collaboration-group-detail-responsibility-agent-${claudeAgent.id}"]`),
      { value: '复核前序结果并完成收敛' }
    )

    for (const stage of [
      {
        name: CODEX_STAGE_NAME,
        description: '先由 Codex 处理 Issue。',
        assignee: `agent:${codexAgent.id}`,
      },
      {
        name: CLAUDE_STAGE_NAME,
        description: 'Codex 完成后再由 Claude Code 处理。',
        assignee: `agent:${claudeAgent.id}`,
      },
    ]) {
      const before = new Set(
        JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR)).testIds.filter(
          testId => testId.startsWith('collaboration-group-stage-')
        )
      )
      await control.command('click', scoped('[data-testid="collaboration-group-stage-add"]'))
      const stageTestId = await waitForValue(
        async () =>
          JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR)).testIds.find(
            testId => testId.startsWith('collaboration-group-stage-') && !before.has(testId)
          ) ?? null,
        Boolean,
        `The ${stage.name} row was not added`,
        uiTimeoutMs
      )
      await control.command('fill', scoped(`[data-testid="${stageTestId}"] input`), {
        value: stage.name,
      })
      await control.command('fill', scoped(`[data-testid="${stageTestId}"] textarea`), {
        value: stage.description,
      })
      await control.command('select', scoped(`[data-testid="${stageTestId}"] select`), {
        value: stage.assignee,
      })
    }
    await control.command(
      'clickWhenEnabled',
      scoped('[data-testid="collaboration-group-detail-save"]'),
      { timeoutMs: uiTimeoutMs }
    )
    collaborationGroup = await waitForValue(
      async () => {
        const response = await request(`/api/v1/cloud-projects/${project.id}/collaboration-groups`)
        return response.items?.find(candidate => candidate.id === collaborationGroup.id) ?? null
      },
      group =>
        group?.members?.length === 2 &&
        group?.stages?.length === 2 &&
        group.stages[0].assignee?.id === codexAgent.id &&
        group.stages[1].assignee?.id === claudeAgent.id,
      'The Codex → Claude collaboration stages were not persisted in order',
      uiTimeoutMs
    )
    assert.deepEqual(
      collaborationGroup.stages.map(stage => ({
        assignee: `${stage.assignee.kind}:${stage.assignee.id}`,
        name: stage.name,
      })),
      [
        { assignee: `agent:${codexAgent.id}`, name: CODEX_STAGE_NAME },
        { assignee: `agent:${claudeAgent.id}`, name: CLAUDE_STAGE_NAME },
      ]
    )
    await capture(control, 'collaboration-agent-chain-09-group-stages.png')
  }

  async function selectGroupTarget(control) {
    await control.command(
      'click',
      scoped('[data-testid="automatic-processing-target-kind-collaboration_group"]')
    )
    await control.command('click', scoped('[data-testid="automatic-processing-target"]'))
    await control.command(
      'click',
      scoped(
        `[data-testid="automatic-processing-target-option-collaboration_group-${collaborationGroup.id}"]`
      )
    )
  }

  async function configureAutomaticProcessing(control) {
    await control.command(
      'click',
      scoped('[data-testid="collaboration-project-settings-automatic-processing"]')
    )
    await control.command('waitFor', scoped('[data-testid="automatic-processing"]'), {
      timeoutMs: uiTimeoutMs,
    })

    await control.command('click', scoped('[data-testid="automatic-processing-create"]'))
    await control.command('waitFor', scoped('[data-testid="automatic-processing-form"]'), {
      timeoutMs: uiTimeoutMs,
    })
    await selectGroupTarget(control)
    await control.command('clickWhenEnabled', scoped('[data-testid="automatic-processing-save"]'), {
      timeoutMs: uiTimeoutMs,
    })
    createdRule = await waitForValue(
      () => request(`/api/v1/cloud-projects/${project.id}/automations`),
      rules =>
        rules.find(
          rule =>
            rule.eventType === 'task.created' &&
            rule.targetKind === 'collaboration_group' &&
            rule.targetId === collaborationGroup.id
        ) ?? false,
      'The Issue-created collaboration-group rule was not persisted',
      uiTimeoutMs
    )

    await control.command('click', scoped('[data-testid="automatic-processing-create"]'))
    await control.command('click', scoped('[data-testid="automatic-processing-trigger-tag_added"]'))
    await control.command('fill', scoped('[data-testid="automatic-processing-tag"]'), {
      value: MATCHING_TAG,
    })
    await selectGroupTarget(control)
    await control.command('clickWhenEnabled', scoped('[data-testid="automatic-processing-save"]'), {
      timeoutMs: uiTimeoutMs,
    })
    tagRule = await waitForValue(
      () => request(`/api/v1/cloud-projects/${project.id}/automations`),
      rules =>
        rules.find(
          rule =>
            rule.eventType === 'task.tag_added' &&
            rule.eventConfig?.tags?.includes(MATCHING_TAG) &&
            rule.targetKind === 'collaboration_group' &&
            rule.targetId === collaborationGroup.id
        ) ?? false,
      'The Tag-added collaboration-group rule was not persisted',
      uiTimeoutMs
    )
    await control.command(
      'waitFor',
      scoped(`[data-testid="automatic-processing-rule-${createdRule.id}"]`),
      { timeoutMs: uiTimeoutMs }
    )
    await control.command(
      'waitFor',
      scoped(`[data-testid="automatic-processing-rule-${tagRule.id}"]`),
      { timeoutMs: uiTimeoutMs }
    )
    await capture(control, 'collaboration-agent-chain-10-automatic-rules.png')
  }

  async function createIssue(control, title) {
    await control.command('click', scoped('[data-testid="collaboration-tab-board"]'))
    await control.command('click', scoped('[data-testid="collaboration-issue-create"]'))
    await control.command('waitFor', scoped('[data-testid="cloud-todo-title"]'), {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('fill', scoped('[data-testid="cloud-todo-title"]'), { value: title })
    await control.command('fill', scoped('[data-testid="cloud-todo-detail-description"]'), {
      value: `真实自动处理验收：${title}`,
    })
    await control.command('clickWhenEnabled', scoped('[data-testid="cloud-todo-create-confirm"]'), {
      timeoutMs: uiTimeoutMs,
    })
    const issue = await waitForValue(
      async () => {
        const response = await request(`/api/v1/cloud-projects/${project.id}/loop-items`)
        return response.items?.find(candidate => candidate.title === title) ?? null
      },
      Boolean,
      `The Issue "${title}" was not persisted`,
      uiTimeoutMs
    )
    await control.command('waitFor', scoped('[data-testid="collaboration-issue-detail"]'), {
      timeoutMs: uiTimeoutMs,
    })
    return issue
  }

  async function waitForExecutionStage(issue, expectedAgent, expectedCount, timeoutMs) {
    return waitForValue(
      () => request(`/api/v1/cloud-projects/${project.id}/executions?include_terminal=true`),
      response => {
        const items = executionItems(response, issue.id)
        if (items.length !== expectedCount) return false
        const current = items.at(-1)
        return current?.agentId === expectedAgent.id &&
          current.executionEnvironment === 'cloud' &&
          current.executionDeviceId === CLOUD_DEVICE_ID &&
          current.runtimeDeviceId === CLOUD_DEVICE_ID &&
          current.runtimeInstanceId &&
          !terminalExecution(current) &&
          current.runtimeTaskId
          ? { current, items }
          : false
      },
      `${expectedAgent.name} did not become execution ${expectedCount} for ${issue.title}`,
      timeoutMs
    )
  }

  async function waitForChainCompleted(issue, expectedAgents, timeoutMs) {
    const result = await waitForValue(
      async () => {
        const [latestIssue, executions] = await Promise.all([
          request(`/api/v1/loop-items/${issue.id}`),
          request(`/api/v1/cloud-projects/${project.id}/executions?include_terminal=true`),
        ])
        return { executions: executionItems(executions, issue.id), issue: latestIssue }
      },
      value =>
        ['in_review', 'completed'].includes(value.issue.status) &&
        value.executions.length === expectedAgents.length &&
        value.executions.every(execution => execution.status === 'completed'),
      `Every collaboration stage did not complete for Issue ${issue.title}`,
      timeoutMs
    )
    assert.deepEqual(
      result.executions.map(execution => execution.agentId),
      expectedAgents.map(agent => agent.id)
    )
    return result
  }

  async function runIssueChain(control, issue, expectedRule, screenshotPrefix) {
    const runtimeTimeoutMs = Math.max(uiTimeoutMs, 60_000)
    await waitForExecutionStage(issue, codexAgent, 1, runtimeTimeoutMs)
    const codexGate = await waitForValue(
      () => pendingCompletions.get(stageKey(issue, 'codex')) ?? null,
      Boolean,
      `Codex did not finish the real MCP sequence for ${issue.title}`,
      runtimeTimeoutMs
    )
    const codexComment = await waitForComment(issue, 'codex', runtimeTimeoutMs)
    const beforeClaude = await request(
      `/api/v1/cloud-projects/${project.id}/executions?include_terminal=true`
    )
    assert.equal(
      executionItems(beforeClaude, issue.id).some(
        execution => execution.agentId === claudeAgent.id
      ),
      false,
      'Claude Code started before the Codex MCP comment was persisted and Codex completed'
    )
    await control.command('waitFor', scoped('[data-testid="collaboration-automation-stage-0"]'), {
      text: `执行中 · ${codexAgent.name}`,
      timeoutMs: runtimeTimeoutMs,
      visible: true,
    })
    await control.command(
      'waitFor',
      scoped(
        `[data-testid="cloud-todo-card-tool-${issue.id}-${stageCallIds(issue, 'codex').commentCall}"]`
      ),
      {
        timeoutMs: runtimeTimeoutMs,
        visible: true,
      }
    )
    await capture(control, `${screenshotPrefix}-codex-running.png`)
    codexGate.resolve()

    const claudeStage = await waitForExecutionStage(issue, claudeAgent, 2, runtimeTimeoutMs)
    const [codexExecution, claudeExecution] = claudeStage.items
    assert.equal(codexExecution.status, 'completed')
    assert.equal(claudeExecution.previousExecutionId, codexExecution.id)
    assert.ok(
      new Date(codexExecution.completedAt).getTime() <=
        new Date(claudeExecution.queuedAt).getTime(),
      'Claude Code was queued before Codex reached its terminal state'
    )
    assert.equal(claudeExecution.runtimeInstanceId, codexExecution.runtimeInstanceId)
    const claudeGate = await waitForValue(
      () => pendingCompletions.get(stageKey(issue, 'claude_code')) ?? null,
      Boolean,
      `Claude Code did not finish the real MCP sequence for ${issue.title}`,
      runtimeTimeoutMs
    )
    const claudeComment = await waitForComment(issue, 'claude_code', runtimeTimeoutMs)
    assert.ok(
      new Date(codexComment.created_at).getTime() <= new Date(claudeComment.created_at).getTime(),
      'The persisted Claude Code comment predates the Codex comment'
    )
    assert.deepEqual(
      modelStages.filter(stage => stage.issueId === issue.id).map(stage => stage.agent),
      ['codex', 'claude_code']
    )
    await control.command('waitFor', scoped('[data-testid="collaboration-automation-stage-1"]'), {
      text: `执行中 · ${claudeAgent.name}`,
      timeoutMs: runtimeTimeoutMs,
      visible: true,
    })
    await control.command(
      'waitFor',
      scoped(
        `[data-testid="cloud-todo-card-tool-${issue.id}-${stageCallIds(issue, 'claude_code').commentCall}"]`
      ),
      {
        timeoutMs: runtimeTimeoutMs,
        visible: true,
      }
    )
    await capture(control, `${screenshotPrefix}-claude-running.png`)
    claudeGate.resolve()

    const completed = await waitForChainCompleted(
      issue,
      [codexAgent, claudeAgent],
      runtimeTimeoutMs
    )
    const runs = await waitForValue(
      () => request(`/api/v1/cloud-projects/${project.id}/automations/${expectedRule.id}/runs`),
      values =>
        values.length === 1 && values[0].taskId === issue.id && values[0].status === 'succeeded'
          ? values
          : false,
      `The expected Automation Run did not succeed for ${issue.title}`,
      runtimeTimeoutMs
    )
    assert.equal(runs[0].eventType, expectedRule.eventType)
    assert.equal(runs[0].trigger, 'event')
    assert.deepEqual(
      completed.issue.workflow.nodes.map(node => node.automation_run_id),
      completed.executions.map(execution => execution.automationRunId)
    )
    assert.deepEqual(
      actualToolCalls
        .filter(call => call.issueId === issue.id)
        .map(call => `${call.agent}:${call.toolName}`),
      [
        ...TOOL_SEQUENCE.map(tool => `codex:${tool}`),
        ...TOOL_SEQUENCE.map(tool => `claude_code:${tool}`),
      ]
    )
    const comments = await commentsFor(issue)
    assert.deepEqual(
      comments
        .filter(comment => comment.body.startsWith(`COLLAB_E2E:${issue.id}:`))
        .map(comment => comment.body),
      [stageComment(issue, 'codex'), stageComment(issue, 'claude_code')]
    )
    await control.command('waitFor', scoped('[data-testid="collaboration-automation-progress"]'), {
      text: '2 / 2',
      timeoutMs: runtimeTimeoutMs,
      visible: true,
    })
    await control.command('waitFor', scoped('[data-testid="collaboration-automation-execution"]'), {
      text: '所有自动化阶段已完成，Issue 已自动完成',
      timeoutMs: runtimeTimeoutMs,
      visible: true,
    })
    await capture(control, `${screenshotPrefix}-completed.png`)
  }

  return {
    claudeBinary,
    requiresCloudEnvironment: true,

    async prepareCloud(cloud) {
      backendUrl = cloud.backendUrl
      authToken = cloud.authToken
      await request('/api/admin/setup-complete', { method: 'POST' })
    },

    async handleHttp(requestMessage, response, url) {
      if (
        !active ||
        requestMessage.method !== 'POST' ||
        ![
          '/responses',
          '/v1/responses',
          '/api/runtime-work/llm-responses-proxy/responses',
        ].includes(url.pathname)
      ) {
        return false
      }
      const body = await readRequestBody(requestMessage)
      const serialized = JSON.stringify(body)
      const issue = issueFromRequest(serialized)
      const agent = agentFromRequest(serialized, issue)
      const ids = issue && agent ? stageCallIds(issue, agent) : null
      const requestSummary = summarizeModelRequest(body, issue, agent, ids)
      requestSummary.requestNumber = modelRequests.length + 1
      modelRequests.push(requestSummary)
      const responseId = `collaboration-agent-chain-${Date.now()}-${modelRequests.length}`
      if (!issue || !agent || !ids) {
        assert.fail(
          `Active collaboration execution emitted an unrecognized model request: ${JSON.stringify(requestSummary)}`
        )
      }

      if (requestContainsToolOutput(body, ids.commentCall)) {
        const output = serializedToolOutput(body, ids.commentCall)
        assert.ok(
          output.includes(stageComment(issue, agent)),
          `${agent} did not receive the persisted comment from the real wework_space MCP`
        )
        const comment = await waitForComment(issue, agent, Math.max(uiTimeoutMs, 30_000))
        persistedComments.push({
          agent,
          body: comment.body,
          createdAt: comment.created_at,
          issueId: issue.id,
        })
        const gate = deferred()
        pendingCompletions.set(stageKey(issue, agent), gate)
        const completion = streamingTextEvents(
          responseId,
          `${MODEL_COMPLETION_MARKER}:${issue.id}:${agent}`
        )
        response.writeHead(200, {
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'content-type': 'text/event-stream; charset=utf-8',
        })
        response.flushHeaders()
        response.write(createSse(completion.start))
        await gate.promise
        response.end(
          createSse([
            ...completion.chunks.map((delta, index) => ({
              type: 'response.output_text.delta',
              item_id: completion.itemId,
              output_index: 0,
              content_index: 0,
              delta,
              offset: completion.chunks.slice(0, index).join('').length,
            })),
            ...completion.finish,
          ])
        )
        return true
      }

      if (requestContainsToolOutput(body, ids.commentSearch)) {
        recordToolCall(issue, agent, 'add_board_item_comment')
        writeEvents(
          response,
          responseId,
          namespacedCallAfterSearch(
            body,
            'add_board_item_comment',
            {
              space_id: String(project.id),
              item_id: issue.id,
              body: stageComment(issue, agent),
            },
            ids.commentCall
          )
        )
        return true
      }

      if (requestContainsToolOutput(body, ids.itemCall)) {
        const output = serializedToolOutput(body, ids.itemCall)
        assert.ok(output.includes(issue.id), `${agent} get_board_item returned the wrong Issue id`)
        assert.ok(
          output.includes(issue.title),
          `${agent} get_board_item did not return the real Issue title`
        )
        if (issue.title === TAG_ISSUE_TITLE) {
          assert.ok(
            output.includes(MATCHING_TAG),
            `${agent} get_board_item did not return the persisted matching Tag`
          )
        }
        const selection = directOrSearchEvents(
          body,
          'add_board_item_comment',
          {
            space_id: String(project.id),
            item_id: issue.id,
            body: stageComment(issue, agent),
          },
          ids.commentSearch,
          ids.commentCall
        )
        if (selection.mode === 'direct') {
          recordToolCall(issue, agent, 'add_board_item_comment')
        }
        writeEvents(response, responseId, selection.events)
        return true
      }

      if (requestContainsToolOutput(body, ids.itemSearch)) {
        recordToolCall(issue, agent, 'get_board_item')
        writeEvents(
          response,
          responseId,
          namespacedCallAfterSearch(
            body,
            'get_board_item',
            { space_id: String(project.id), item_id: issue.id },
            ids.itemCall
          )
        )
        return true
      }

      if (requestContainsToolOutput(body, ids.contextCall)) {
        const output = serializedToolOutput(body, ids.contextCall)
        assert.ok(
          output.includes(String(project.id)),
          `${agent} get_current_context returned the wrong project`
        )
        assert.ok(
          output.includes(issue.id),
          `${agent} get_current_context returned the wrong bound Issue`
        )
        const selection = directOrSearchEvents(
          body,
          'get_board_item',
          { space_id: String(project.id), item_id: issue.id },
          ids.itemSearch,
          ids.itemCall
        )
        if (selection.mode === 'direct') {
          recordToolCall(issue, agent, 'get_board_item')
        }
        writeEvents(response, responseId, selection.events)
        return true
      }

      if (requestContainsToolOutput(body, ids.contextSearch)) {
        recordToolCall(issue, agent, 'get_current_context')
        writeEvents(
          response,
          responseId,
          namespacedCallAfterSearch(body, 'get_current_context', {}, ids.contextCall)
        )
        return true
      }

      assert.ok(serialized.includes(SKILL_NAME), `${agent} did not receive its configured Skill`)
      modelStages.push({ agent, issueId: issue.id, issueTitle: issue.title })
      const selection = directOrSearchEvents(
        body,
        'get_current_context',
        {},
        ids.contextSearch,
        ids.contextCall
      )
      if (selection.mode === 'direct') {
        recordToolCall(issue, agent, 'get_current_context')
      }
      writeEvents(response, responseId, selection.events)
      return true
    },

    async verify(control) {
      active = true
      let failure = null
      try {
        await createWorkspaceAndProject(control)
        await configureExecutionDevice(control)
        await configureAgents(control)
        await createCollaborationGroup(control)
        await configureAutomaticProcessing(control)

        createdIssue = await createIssue(control, CREATED_ISSUE_TITLE)
        await capture(control, 'collaboration-agent-chain-11-created-issue.png')
        await runIssueChain(
          control,
          createdIssue,
          createdRule,
          'collaboration-agent-chain-12-created'
        )

        await control.command('click', scoped('[data-testid="collaboration-tab-manage"]'))
        await control.command(
          'click',
          scoped('[data-testid="collaboration-project-settings-automatic-processing"]')
        )
        await control.command(
          'click',
          scoped(`[data-testid="automatic-processing-enabled-${createdRule.id}"]`)
        )
        createdRule = await waitForValue(
          () => request(`/api/v1/cloud-projects/${project.id}/automations`),
          rules => rules.find(rule => rule.id === createdRule.id && !rule.enabled) ?? false,
          'The Issue-created rule was not disabled before the Tag scenario',
          uiTimeoutMs
        )

        tagIssue = await createIssue(control, TAG_ISSUE_TITLE)
        await capture(control, 'collaboration-agent-chain-13-tag-issue-created.png')
        const beforeTag = await request(
          `/api/v1/cloud-projects/${project.id}/executions?include_terminal=true`
        )
        assert.equal(
          executionItems(beforeTag, tagIssue.id).length,
          0,
          'The Tag scenario started before the matching Tag was added'
        )
        assert.deepEqual(await commentsFor(tagIssue), [])
        await control.command('fill', scoped('[data-testid="cloud-todo-detail-tag-input"]'), {
          value: MATCHING_TAG,
        })
        await control.command('press', scoped('[data-testid="cloud-todo-detail-tag-input"]'), {
          key: 'Enter',
        })
        await control.command('clickWhenEnabled', scoped('[data-testid="cloud-todo-save"]'), {
          timeoutMs: uiTimeoutMs,
        })
        tagIssue = await waitForValue(
          () => request(`/api/v1/loop-items/${tagIssue.id}`),
          value => (value.tags?.includes(MATCHING_TAG) ? value : false),
          'The matching Tag was not persisted through the Issue UI',
          uiTimeoutMs
        )
        await capture(control, 'collaboration-agent-chain-14-tag-added.png')
        await runIssueChain(control, tagIssue, tagRule, 'collaboration-agent-chain-15-tag')
      } catch (error) {
        failure = error
      } finally {
        active = false
        for (const gate of pendingCompletions.values()) gate.resolve()
        try {
          await archiveFixture()
        } catch (cleanupError) {
          failure = failure
            ? new AggregateError(
                [failure, cleanupError],
                'Collaboration automation verification and fixture cleanup both failed'
              )
            : cleanupError
        }
      }
      if (failure) throw failure
    },

    async cleanup() {
      active = false
      for (const gate of pendingCompletions.values()) gate.resolve()
      await archiveFixture()
    },

    diagnostics() {
      return {
        agents: [
          codexAgent
            ? { id: codexAgent.id, name: codexAgent.name, runtime: codexAgent.runtime }
            : null,
          claudeAgent
            ? { id: claudeAgent.id, name: claudeAgent.name, runtime: claudeAgent.runtime }
            : null,
        ].filter(Boolean),
        actualToolCalls,
        collaborationGroupId: collaborationGroup?.id ?? null,
        createdIssueId: createdIssue?.id ?? null,
        createdRuleId: createdRule?.id ?? null,
        fixtureArchived,
        modelRequests,
        modelStages,
        persistedComments,
        projectId: project?.id ?? null,
        tagIssueId: tagIssue?.id ?? null,
        tagRuleId: tagRule?.id ?? null,
        workspaceId: workspace?.id ?? null,
      }
    },
  }
}
