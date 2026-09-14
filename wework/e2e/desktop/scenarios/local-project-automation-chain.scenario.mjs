import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  assistantMessage,
  createSse,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const ACTIVE_WORKBENCH_SELECTOR = '[data-workspace-tab-content][aria-hidden="false"]'
const LOCAL_WORKSPACE_ID = 'wework-local-workspace'
const CLAUDE_AGENT_NAME = 'Claude'
const CODEX_AGENT_NAME = 'Codex'
const CLAUDE_STAGE_NAME = 'Claude 实现'
const CODEX_STAGE_NAME = 'Codex 验证'
const CLAUDE_PROMPT = '实现 Issue 目标并提交可验证结果'
const CODEX_PROMPT = '验证 Claude 结果并确认 Issue 可以完成'
const CLAUDE_COMPLETION_MARKER = 'LOCAL_AUTOMATION_CLAUDE_STAGE_E2E_COMPLETED'
const CODEX_COMPLETION_MARKER = 'LOCAL_AUTOMATION_CODEX_STAGE_E2E_COMPLETED'
const ISSUE_TITLE = '本地 Claude 到 Codex 顺序执行'

function scoped(selector) {
  return `${ACTIVE_WORKBENCH_SELECTOR} ${selector}`
}

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

function deferred() {
  let resolve = () => undefined
  const promise = new Promise(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback
  return JSON.parse(value)
}

async function waitForValue(read, predicate, message, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let latest = null
  while (Date.now() < deadline) {
    try {
      latest = await read()
      const result = predicate(latest)
      if (result) return result === true ? latest : result
    } catch (error) {
      if (error?.code !== 'SQLITE_BUSY' && error?.code !== 'SQLITE_CANTOPEN') throw error
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`${message}; last value: ${JSON.stringify(latest)}`)
}

export function createDesktopScenario({
  captureScreenshot,
  executorHome,
  uiTimeoutMs,
  workbenchReadyTimeoutMs,
}) {
  const databasePath = join(executorHome, 'data', 'tasks.sqlite')
  const projectName = `本地自动化链验收-${process.pid}`
  const claudeGate = deferred()
  const codexGate = deferred()
  const modelRequests = []
  let active = false
  let project = null
  let issue = null
  let claudeAgent = null
  let codexAgent = null
  let workflowNodes = []

  function withDatabase(action) {
    const database = new DatabaseSync(databasePath)
    try {
      return action(database)
    } finally {
      database.close()
    }
  }

  function resourceByName(resourceType, name) {
    return withDatabase(database => {
      const row = database
        .prepare(
          `select id, name, title, status, assignee_agent_id, metadata
             from loop_items
            where resource_type = ?
              and (name = ? or title = ?)
              and deleted_at is null
            order by created_at desc
            limit 1`
        )
        .get(resourceType, name, name)
      return row
        ? {
            ...row,
            metadata: parseJson(row.metadata),
          }
        : null
    })
  }

  function issueState() {
    if (!issue) return null
    return withDatabase(database => {
      const row = database
        .prepare(
          `select id, status, assignee_agent_id, completed_at, metadata
             from loop_items
            where id = ? and resource_type = 'task'`
        )
        .get(issue.id)
      if (!row) return null
      const executions = database
        .prepare(
          `select id, agent_id, status, runtime_task_id, execution_payload
             from loop_item_executions
            where loop_item_id = ?
            order by id`
        )
        .all(issue.id)
        .map(execution => ({
          ...execution,
          execution_payload: parseJson(execution.execution_payload),
        }))
      return {
        ...row,
        metadata: parseJson(row.metadata),
        executions,
      }
    })
  }

  async function createProjectAgent(control, name, prompt) {
    await control.command('click', scoped('[data-testid="project-agent-add"]'))
    await control.command('waitFor', scoped('[data-testid="project-agent-dialog"]'), {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('click', scoped('[data-testid="project-agent-mode-codex"]'))
    await control.command('fill', scoped('[data-testid="project-agent-codex-name"]'), {
      value: name,
    })
    await control.command('fill', scoped('[data-testid="project-agent-codex-capability"]'), {
      value: `${name} 负责固定工作流中的独立阶段。`,
    })
    await control.command('fill', scoped('[data-testid="project-agent-codex-prompt"]'), {
      value: prompt,
    })
    await control.command('waitFor', scoped('[data-testid="project-agent-codex-environment"]'), {
      enabled: true,
      timeoutMs: uiTimeoutMs,
    })
    const environmentOptionSelector = scoped(
      '[data-testid="project-agent-codex-environment"] option:not([value=""])'
    )
    await control.command('waitFor', environmentOptionSelector, {
      timeoutMs: uiTimeoutMs,
    })
    const environmentId = await control.command('getAttribute', environmentOptionSelector, {
      value: 'value',
    })
    assert.match(environmentId, /^device:/, 'The selected environment must be a local device')
    await control.command('select', scoped('[data-testid="project-agent-codex-environment"]'), {
      value: environmentId,
    })
    await control.command(
      'clickWhenEnabled',
      scoped('[data-testid="project-agent-codex-create"]'),
      { timeoutMs: uiTimeoutMs }
    )
    await control.command('waitFor', scoped('[data-testid^="project-agent-row-"]'), {
      text: name,
      timeoutMs: uiTimeoutMs,
    })
    return waitForValue(
      () => resourceByName('chat_agent', name),
      value => Boolean(value),
      `The ${name} project agent was not persisted`,
      uiTimeoutMs
    )
  }

  return {
    async handleHttp(request, response, url) {
      if (
        request.method === 'GET' &&
        ['/api/v1/workspaces', '/v1/workspaces'].includes(url.pathname)
      ) {
        json(response, 200, { items: [] })
        return true
      }
      if (
        request.method === 'GET' &&
        ['/api/v1/resources', '/v1/resources'].includes(url.pathname)
      ) {
        json(response, 200, { agents: [], execution_environments: [] })
        return true
      }
      if (request.method === 'GET' && ['/api/teams', '/teams'].includes(url.pathname)) {
        json(response, 200, { items: [], total: 0 })
        return true
      }
      if (request.method === 'GET' && ['/api/devices', '/devices'].includes(url.pathname)) {
        json(response, 200, { items: [] })
        return true
      }
      if (
        !active ||
        request.method !== 'POST' ||
        !['/responses', '/v1/responses'].includes(url.pathname)
      ) {
        return false
      }
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const serialized = JSON.stringify(payload)
      const stage = serialized.includes(CLAUDE_PROMPT)
        ? {
            name: CLAUDE_AGENT_NAME,
            prompt: CLAUDE_PROMPT,
            completionMarker: CLAUDE_COMPLETION_MARKER,
            gate: claudeGate,
          }
        : serialized.includes(CODEX_PROMPT)
          ? {
              name: CODEX_AGENT_NAME,
              prompt: CODEX_PROMPT,
              completionMarker: CODEX_COMPLETION_MARKER,
              gate: codexGate,
            }
          : null
      const responseId = `local-project-automation-${modelRequests.length + 1}`
      response.writeHead(200, {
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
      })
      if (!stage) {
        response.end(createSse([responseCreated(responseId), responseCompleted(responseId)]))
        return true
      }
      modelRequests.push({
        name: stage.name,
        runtime: payload.runtime ?? 'codex',
      })
      response.flushHeaders()
      response.write(createSse([responseCreated(responseId)]))
      await stage.gate.promise
      response.end(
        createSse([assistantMessage(stage.completionMarker), responseCompleted(responseId)])
      )
      return true
    },

    async verify(control) {
      try {
        await ensureExperimentalFeaturesEnabled(control)
        await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
          timeoutMs: workbenchReadyTimeoutMs,
        })
        await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
        await control.command('waitFor', scoped('[data-testid="collaboration-platform-root"]'), {
          timeoutMs: uiTimeoutMs,
        })
        await control.command(
          'waitFor',
          scoped(`[data-testid="collaboration-workspace-${LOCAL_WORKSPACE_ID}"]`),
          {
            text: '本地空间',
            timeoutMs: uiTimeoutMs,
          }
        )
        await control.command(
          'click',
          scoped(`[data-testid="collaboration-workspace-${LOCAL_WORKSPACE_ID}"]`)
        )
        await control.command(
          'waitFor',
          scoped('[data-testid="collaboration-workspace-project-create"]'),
          { timeoutMs: uiTimeoutMs }
        )

        await control.command(
          'click',
          scoped('[data-testid="collaboration-workspace-project-create"]')
        )
        await control.command(
          'waitFor',
          scoped('[data-testid="collaboration-project-create-dialog"]'),
          { timeoutMs: uiTimeoutMs }
        )
        await control.command('fill', scoped('[data-testid="collaboration-project-name-input"]'), {
          value: projectName,
        })
        await control.command(
          'fill',
          scoped('[data-testid="collaboration-project-description-input"]'),
          { value: '通过真实本地 Executor 验证固定两阶段自动化。' }
        )
        await control.command(
          'clickWhenEnabled',
          scoped('[data-testid="collaboration-project-create-confirm"]'),
          { timeoutMs: uiTimeoutMs }
        )
        await control.command('waitFor', scoped('[data-testid="cloud-project-header-title"]'), {
          text: projectName,
          timeoutMs: uiTimeoutMs,
        })
        project = await waitForValue(
          () => resourceByName('project', projectName),
          value => Boolean(value),
          'The local project created through the UI was not persisted',
          uiTimeoutMs
        )

        await control.command('click', scoped('[data-testid="collaboration-tab-manage"]'))
        await control.command(
          'waitFor',
          scoped('[data-testid="collaboration-project-settings-agents"]'),
          { timeoutMs: uiTimeoutMs }
        )
        await control.command(
          'click',
          scoped('[data-testid="collaboration-project-settings-agents"]')
        )
        await control.command('waitFor', scoped('[data-testid="project-agent-config"]'), {
          timeoutMs: uiTimeoutMs,
        })
        claudeAgent = await createProjectAgent(control, CLAUDE_AGENT_NAME, CLAUDE_PROMPT)
        codexAgent = await createProjectAgent(control, CODEX_AGENT_NAME, CODEX_PROMPT)
        assert.equal(
          claudeAgent.metadata.runtime,
          'codex',
          'The agent named Claude must disclose its actual local runtime as codex'
        )
        assert.equal(codexAgent.metadata.runtime, 'codex')
        assert.notEqual(
          claudeAgent.id,
          codexAgent.id,
          'Claude and Codex must be independent project agents'
        )

        await control.command(
          'click',
          scoped('[data-testid="collaboration-project-settings-dispatch"]')
        )
        await control.command('waitFor', scoped('[data-testid="project-automation-policy"]'), {
          timeoutMs: uiTimeoutMs,
        })
        const dispatchSnapshot = JSON.parse(
          await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR)
        )
        if (dispatchSnapshot.testIds.includes('automation-welcome-create-policy')) {
          await control.command('click', scoped('[data-testid="automation-welcome-create-policy"]'))
        }
        await control.command('waitFor', scoped('[data-testid="automation-policy-name"]'), {
          timeoutMs: uiTimeoutMs,
        })
        await control.command('click', scoped('[data-testid="automation-trigger-created"]'))
        await control.command('fill', scoped('[data-testid="automation-policy-name"]'), {
          value: 'Claude 到 Codex 固定执行',
        })
        await control.command('click', scoped('[data-testid="automation-approval-automatic"]'))
        await control.command('click', scoped('[data-testid="automation-empty-add-workflow-step"]'))
        await control.command('fill', scoped('[data-testid="automation-workflow-step-name-0"]'), {
          value: CLAUDE_STAGE_NAME,
        })
        await control.command(
          'fill',
          scoped('[data-testid="automation-workflow-step-description-0"]'),
          { value: CLAUDE_PROMPT }
        )
        await control.command(
          'waitFor',
          scoped(
            `[data-testid="automation-workflow-step-agent-0"] option[value="${claudeAgent.id}"]`
          ),
          { timeoutMs: uiTimeoutMs }
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
          { value: CODEX_PROMPT }
        )
        await control.command(
          'waitFor',
          scoped(
            `[data-testid="automation-workflow-step-agent-1"] option[value="${codexAgent.id}"]`
          ),
          { timeoutMs: uiTimeoutMs }
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
        project = await waitForValue(
          () => resourceByName('project', projectName),
          value => value?.metadata?.workflow_definition?.nodes?.length === 2,
          'The fixed local workflow was not saved on the project',
          uiTimeoutMs
        )
        workflowNodes = project.metadata.workflow_definition.nodes
        assert.deepEqual(
          workflowNodes.map(node => ({
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
              dependsOn: [workflowNodes[0].id],
              assigneeType: 'agent',
              assigneeId: codexAgent.id,
            },
          ]
        )
        await captureScreenshot(
          control,
          'local-project-automation-01-fixed-rule.png',
          ACTIVE_WORKBENCH_SELECTOR
        )

        await control.command('click', scoped('[data-testid="collaboration-tab-board"]'))
        await control.command('waitFor', scoped('[data-testid="collaboration-issue-create"]'), {
          timeoutMs: uiTimeoutMs,
        })
        active = true
        await control.command('click', scoped('[data-testid="collaboration-issue-create"]'))
        await control.command('waitFor', scoped('[data-testid="cloud-todo-title"]'), {
          timeoutMs: uiTimeoutMs,
        })
        await control.command('fill', scoped('[data-testid="cloud-todo-title"]'), {
          value: ISSUE_TITLE,
        })
        await control.command(
          'clickWhenEnabled',
          scoped('[data-testid="cloud-todo-create-confirm"]'),
          { timeoutMs: uiTimeoutMs }
        )
        await control.command('waitFor', scoped('[data-testid="collaboration-issue-detail"]'), {
          timeoutMs: uiTimeoutMs,
        })
        issue = await waitForValue(
          () => resourceByName('task', ISSUE_TITLE),
          value => Boolean(value),
          'The Issue created through the UI was not persisted',
          uiTimeoutMs
        )

        const claudeRunning = await waitForValue(
          issueState,
          state => {
            const nodes = state?.metadata?.workflow?.nodes ?? []
            return (
              state?.status === 'in_progress' &&
              nodes[0]?.status === 'running' &&
              nodes[1]?.status === 'blocked' &&
              state.executions.length === 1 &&
              state.executions[0].agent_id === claudeAgent.id &&
              state.executions[0].status === 'running'
            )
          },
          'Claude did not become the only running stage while Codex remained blocked',
          Math.max(uiTimeoutMs, 30_000)
        )
        await waitForValue(
          () => modelRequests,
          requests => requests.length === 1,
          'The Claude runtime did not reach the model service',
          Math.max(uiTimeoutMs, 30_000)
        )
        assert.deepEqual(modelRequests, [{ name: CLAUDE_AGENT_NAME, runtime: 'codex' }])
        assert.equal(
          claudeRunning.executions[0].execution_payload.workflow_node_id,
          workflowNodes[0].id
        )
        const issueCard = scoped(`[data-testid="cloud-todo-card-${issue.id}"]`)
        await control.command(
          'waitFor',
          scoped(`[data-testid="cloud-todo-card-workflow-stage-${issue.id}"]`),
          {
            text: CLAUDE_STAGE_NAME,
            timeoutMs: uiTimeoutMs,
          }
        )
        await control.command(
          'waitFor',
          scoped(`[data-testid="cloud-todo-card-workflow-status-${issue.id}"]`),
          {
            text: '执行中',
            timeoutMs: uiTimeoutMs,
            visible: true,
          }
        )
        await control.command(
          'waitFor',
          scoped('[data-testid="collaboration-automation-stage-0"][data-status="running"]'),
          { text: '执行中 · Claude · 本地空间', timeoutMs: uiTimeoutMs }
        )
        await control.command(
          'waitFor',
          scoped('[data-testid="collaboration-automation-stage-1"][data-status="blocked"]'),
          { text: `等待 ${CLAUDE_STAGE_NAME} 完成`, timeoutMs: uiTimeoutMs }
        )
        await captureScreenshot(
          control,
          'local-project-automation-02-claude-running-codex-blocked.png',
          ACTIVE_WORKBENCH_SELECTOR
        )

        claudeGate.resolve()
        const codexRunning = await waitForValue(
          issueState,
          state => {
            const nodes = state?.metadata?.workflow?.nodes ?? []
            return (
              state?.status === 'in_progress' &&
              nodes[0]?.status === 'completed' &&
              nodes[1]?.status === 'running' &&
              state.executions.length === 2 &&
              state.executions[0].status === 'completed' &&
              state.executions[1].agent_id === codexAgent.id &&
              state.executions[1].status === 'running'
            )
          },
          'Codex did not start only after Claude completed',
          Math.max(uiTimeoutMs, 30_000)
        )
        await waitForValue(
          () => modelRequests,
          requests => requests.length === 2,
          'The Codex runtime did not reach the model service',
          Math.max(uiTimeoutMs, 30_000)
        )
        assert.deepEqual(modelRequests, [
          { name: CLAUDE_AGENT_NAME, runtime: 'codex' },
          { name: CODEX_AGENT_NAME, runtime: 'codex' },
        ])
        assert.equal(
          codexRunning.executions[1].execution_payload.workflow_node_id,
          workflowNodes[1].id
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
          scoped(`[data-testid="cloud-todo-card-workflow-status-${issue.id}"]`),
          {
            text: '执行中',
            timeoutMs: uiTimeoutMs,
            visible: true,
          }
        )
        await control.command(
          'waitFor',
          scoped('[data-testid="collaboration-automation-stage-0"][data-status="completed"]'),
          { text: '已完成 · Claude · 本地空间', timeoutMs: uiTimeoutMs }
        )
        await control.command(
          'waitFor',
          scoped('[data-testid="collaboration-automation-stage-1"][data-status="running"]'),
          { text: '执行中 · Codex · 本地空间', timeoutMs: uiTimeoutMs }
        )
        await captureScreenshot(
          control,
          'local-project-automation-03-claude-completed-codex-running.png',
          ACTIVE_WORKBENCH_SELECTOR
        )

        codexGate.resolve()
        const completed = await waitForValue(
          issueState,
          state => {
            const nodes = state?.metadata?.workflow?.nodes ?? []
            return (
              state?.status === 'completed' &&
              Boolean(state.completed_at) &&
              state.assignee_agent_id === null &&
              nodes.length === 2 &&
              nodes.every(node => node.status === 'completed') &&
              state.executions.every(execution => execution.status === 'completed')
            )
          },
          'The same local Issue did not complete after both real executions finished',
          Math.max(uiTimeoutMs, 30_000)
        )
        assert.deepEqual(
          completed.executions.map(execution => execution.agent_id),
          [claudeAgent.id, codexAgent.id]
        )
        await control.command('click', scoped('[data-testid="cloud-todo-detail-close"]'))
        const completedCard = scoped(
          `[data-testid="cloud-todo-column-completed"] [data-testid="cloud-todo-card-${issue.id}"]`
        )
        await control.command('waitFor', completedCard, { timeoutMs: uiTimeoutMs })
        await control.command('click', completedCard)
        await control.command('waitFor', scoped('[data-testid="collaboration-issue-detail"]'), {
          timeoutMs: uiTimeoutMs,
        })
        await control.command('waitFor', scoped('[data-testid="cloud-todo-detail-status"]'), {
          timeoutMs: uiTimeoutMs,
        })
        assert.equal(
          await control.command('getValue', scoped('[data-testid="cloud-todo-detail-status"]')),
          'completed'
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
        await captureScreenshot(
          control,
          'local-project-automation-04-issue-completed.png',
          ACTIVE_WORKBENCH_SELECTOR
        )
      } finally {
        active = false
        claudeGate.resolve()
        codexGate.resolve()
      }
    },

    diagnostics() {
      return {
        agents: [
          claudeAgent
            ? { id: claudeAgent.id, name: claudeAgent.name, runtime: claudeAgent.metadata.runtime }
            : null,
          codexAgent
            ? { id: codexAgent.id, name: codexAgent.name, runtime: codexAgent.metadata.runtime }
            : null,
        ].filter(Boolean),
        issueId: issue?.id ?? null,
        modelRequests,
        projectId: project?.id ?? null,
        workflowNodeIds: workflowNodes.map(node => node.id),
      }
    },
  }
}
