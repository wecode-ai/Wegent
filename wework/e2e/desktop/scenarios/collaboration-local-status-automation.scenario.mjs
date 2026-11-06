// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict'
import { createDesktopScenario as createAgentDispatch } from './collaboration-local-agent-dispatch.scenario.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { waitForBoardValue } from '../modules/collaboration-board-flows.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  configureFirstProjectExecutionEnvironment,
  createLocalCollaborationProject,
  enterLocalCollaborationWorkspace,
  inCollaborationSidebar,
  openProjectAgentCreator,
  reloadMainWindow,
  selectCollaborationProjectView,
  selectProjectRunnerModel,
} from '../modules/workspace-flows.mjs'
import {
  assistantMessage,
  codexRequestKind,
  createSse,
  handleEmptyReplyPrediction,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const CHECKPOINT = 'collaboration-local-status-automation'
const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const scoped = name => `${CONTENT} [data-testid="${name}"]`
const MARKER = `LOCAL_STATUS_AUTOMATION_${process.pid}`
const PROMPT = `LOCAL_AUTOMATION_PROMPT_${process.pid}\n进入验收状态后检查交付物，保留中文与 \`code\` 格式。`
const UPDATED_PROMPT = `LOCAL_AUTOMATION_UPDATED_PROMPT_${process.pid}\n复核完成后整理结论，并说明验证结果。`
const PROJECT = `本地状态触发-${process.pid}`
const AGENT = `状态处理智能体-${process.pid}`

function createStatusAutomation({ uiTimeoutMs, workbenchReadyTimeoutMs, modelResponseTimeoutMs }) {
  let control
  let projectId
  let issueId
  let ruleId
  let modelRequests = 0
  let expectedPrompt = PROMPT
  const observedPrompts = new Set()
  const rpc = (method, params = {}) => requestExecutor(control, method, params, uiTimeoutMs)
  const project = async () => {
    const current = (await rpc('projects.list')).find(candidate => candidate.id === projectId)
    assert.ok(current, 'The local project must remain persisted')
    return current
  }
  const rule = async () =>
    (await project()).metadata.automatic_processing_rules.find(candidate => candidate.id === ruleId)
  const issue = () => rpc('todos.get', { project_id: projectId, task_id: issueId })
  const runs = () =>
    rpc('projects.automation.runs', { project_id: projectId, automation_id: ruleId })
  const executions = () => rpc('executions.list', { project_id: projectId, include_terminal: true })
  const click = name => control.command('click', scoped(name))
  const wait = (name, values = {}) => control.command('waitFor', scoped(name), values)
  const patchIssue = async values =>
    rpc('todos.update', {
      project_id: projectId,
      task_id: issueId,
      todo: { version: (await issue()).version, ...values },
    })
  const openRules = async () => {
    await selectCollaborationProjectView(control, CONTENT, 'manage', uiTimeoutMs)
    await click('collaboration-project-settings-automatic-processing')
    await wait('automatic-processing')
  }
  const reopenProject = async message => {
    await reloadMainWindow(control, message)
    const boardTab = '[data-testid="workspace-tab-select-fixed-board"]'
    await control.command('clickWhenEnabled', boardTab, { timeoutMs: workbenchReadyTimeoutMs })
    await control.command('waitFor', `${boardTab}[aria-selected="true"]`, {
      timeoutMs: workbenchReadyTimeoutMs,
    })
    await enterLocalCollaborationWorkspace(control, CONTENT)
    await control.command(
      'clickWhenEnabled',
      inCollaborationSidebar(
        `[data-testid="collaboration-workspace-project-${projectId}"]`,
        CONTENT
      )
    )
    await wait('cloud-project-header-title', { text: PROJECT })
  }
  const saveRule = async () => {
    await control.command('clickWhenEnabled', scoped('automatic-processing-save'))
    await wait('automatic-processing-form', { visible: false })
  }
  const noNewRun = async expectedIds => {
    // Observe the real runtime after the mutation, including asynchronous queue ticks.
    const deadline = Date.now() + 400
    do {
      assert.deepEqual((await runs()).map(run => run.id).sort(), [...expectedIds].sort())
      await new Promise(resolve => setTimeout(resolve, 100))
    } while (Date.now() < deadline)
  }
  const finishedRuns = async (count, expectedStatus) => {
    await waitForBoardValue(
      async () => (await runs()).map(run => run.status),
      Array(count).fill('succeeded'),
      'Each matching transition must finish exactly one real automation run',
      modelResponseTimeoutMs
    )
    const actual = await executions()
    assert.equal(actual.length, count)
    assert.ok(actual.every(execution => execution.status === 'completed'))
    assert.equal((await issue()).status, expectedStatus)
    return runs()
  }

  return {
    requiresCloudEnvironment: true,
    async prepareCloud(environment) {
      const response = await fetch(`${environment.backendUrl}/api/admin/setup-complete`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${environment.authToken}` },
      })
      assert.equal(response.ok, true, 'The real backend must complete initial setup')
    },
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      const auxiliary = ['prewarm', 'compaction'].includes(codexRequestKind(body))
      if (!auxiliary) {
        assert.ok(JSON.stringify(body).includes(MARKER), 'The Agent must receive the source Issue')
        assert.ok(
          JSON.stringify(body).includes(JSON.stringify(expectedPrompt).slice(1, -1)),
          'The real model request must receive the saved multiline automation prompt'
        )
        observedPrompts.add(expectedPrompt)
        modelRequests += 1
      }
      const id = `${MARKER}-${Date.now()}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(
        createSse([
          responseCreated(id),
          assistantMessage(auxiliary ? 'Ready' : `${MARKER}_DONE`),
          responseCompleted(id),
        ])
      )
      return true
    },
    async verify(appControl) {
      control = appControl
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await createLocalCollaborationProject(control, CONTENT, PROJECT)
      await configureFirstProjectExecutionEnvironment(control, CONTENT, uiTimeoutMs)
      projectId = (await rpc('projects.list')).find(candidate => candidate.name === PROJECT)?.id
      assert.ok(projectId, 'The scenario must create its own local project')
      await selectCollaborationProjectView(control, CONTENT, 'manage', uiTimeoutMs)
      await click('collaboration-project-settings-agents')
      await openProjectAgentCreator(control, scoped('project-agent-add'), uiTimeoutMs)
      await control.command('fill', '[data-testid="cloud-project-chat-agent-display-name"]', {
        value: AGENT,
      })
      await selectProjectRunnerModel(control, uiTimeoutMs)
      await control.command('clickWhenEnabled', '[data-testid="cloud-project-chat-agent-save"]')
      await control.command('waitFor', '[data-testid="cloud-project-chat-agent-editor"]', {
        visible: false,
      })
      const agents = await rpc('chat_agents.list', { project_id: projectId })
      const agent = agents.find(candidate => candidate.display_name === AGENT)
      assert.ok(agent, 'The scenario must create its own available Agent')
      await rpc('projects.update', {
        project_id: projectId,
        project: {
          version: (await project()).version,
          board_config: {
            group_by: 'status',
            processing_start_status_id: 'acceptance',
            statuses: [
              { id: 'inbox', name: '收集箱', color: 'gray' },
              { id: 'acceptance', name: '验收', color: 'purple' },
              { id: 'completed', name: '已完成', color: 'green' },
            ],
          },
        },
      })
      assert.deepEqual(
        (await project()).metadata.board_config.statuses.map(status => status.id),
        ['inbox', 'acceptance', 'completed']
      )
      await reopenProject('The custom status board did not reopen after reload')
      const created = await rpc('todos.create', {
        project_id: projectId,
        todo: { title: MARKER, description: MARKER, status: 'inbox', priority: 'none', tags: [] },
      })
      issueId = created.id
      assert.equal(Object.hasOwn(created, 'assignee_agent_id'), false)

      await openRules()
      await control.command('clickWhenEnabled', scoped('automatic-processing-create'))
      await control.command(
        'click',
        `${CONTENT} label:has(> [data-testid="automatic-processing-trigger-status_changed"])`
      )
      await control.command('select', scoped('automatic-processing-status'), {
        value: 'acceptance',
      })
      await control.command('clickWhenEnabled', scoped('automatic-processing-target-kind-agent'))
      await click('automatic-processing-target')
      await click(`automatic-processing-target-option-agent-${agent.id}`)
      await control.command('fill', scoped('automatic-processing-prompt'), { value: PROMPT })
      await saveRule()
      const persisted = (await project()).metadata.automatic_processing_rules
      assert.equal(persisted.length, 1)
      const saved = persisted[0]
      ruleId = saved.id
      assert.equal(saved.eventType, 'task.status_changed')
      assert.equal(saved.targetKind, 'agent')
      assert.equal(saved.targetId, agent.id)
      assert.equal(saved.prompt, PROMPT)
      assert.deepEqual(saved.eventConfig.statuses, ['acceptance'])
      assert.equal(saved.eventConfig.transition, 'any')
      assert.equal(saved.eventConfig.executionTarget, 'existing_issue')
      await reopenProject('The local status rule did not reopen after reload')
      await openRules()
      await control.command('clickWhenEnabled', scoped(`automatic-processing-edit-${ruleId}`))
      assert.equal(
        await control.command('getValue', scoped('automatic-processing-status')),
        'acceptance'
      )
      assert.deepEqual((await rule()).eventConfig.statuses, ['acceptance'])
      assert.equal(await control.command('getValue', scoped('automatic-processing-prompt')), PROMPT)
      await click('automatic-processing-cancel')

      await selectCollaborationProjectView(control, CONTENT, 'board', uiTimeoutMs)
      await control.command('clickWhenEnabled', scoped(`cloud-todo-card-${issueId}`))
      await wait('collaboration-issue-detail', { text: MARKER })
      await control.command('select', scoped('cloud-todo-detail-status'), { value: 'acceptance' })
      const initial = await finishedRuns(1, 'acceptance')
      assert.equal((await issue()).assignee_agent_id, agent.id)
      await wait('cloud-task-activity-list', { text: `${MARKER}_DONE` })
      await patchIssue({ status: 'acceptance' })
      await noNewRun(initial.map(run => run.id))
      await click('cloud-todo-detail-close')
      await wait(`cloud-todo-card-${issueId}`)
      await openRules()
      await click(`automatic-processing-enabled-${ruleId}`)
      await waitForBoardValue(
        async () => (await rule()).enabled,
        false,
        'The rule must disable',
        uiTimeoutMs
      )
      assert.equal((await rule()).prompt, PROMPT)
      await patchIssue({ status: 'inbox' })
      await patchIssue({ status: 'acceptance' })
      await noNewRun(initial.map(run => run.id))
      await patchIssue({ status: 'completed' })
      await click(`automatic-processing-edit-${ruleId}`)
      await control.command('select', scoped('automatic-processing-status'), { value: 'completed' })
      await control.command('fill', scoped('automatic-processing-prompt'), {
        value: UPDATED_PROMPT,
      })
      await saveRule()
      assert.deepEqual((await rule()).eventConfig.statuses, ['completed'])
      assert.equal((await rule()).enabled, false)
      assert.equal((await rule()).prompt, UPDATED_PROMPT)
      expectedPrompt = UPDATED_PROMPT
      await control.command('clickWhenEnabled', scoped(`automatic-processing-enabled-${ruleId}`))
      await waitForBoardValue(
        async () => (await rule()).enabled,
        true,
        'The rule must re-enable',
        uiTimeoutMs
      )
      await noNewRun(initial.map(run => run.id))
      await patchIssue({ status: 'completed' })
      await noNewRun(initial.map(run => run.id))
      await patchIssue({ status: 'inbox' })
      await patchIssue({ status: 'completed' })
      const repeated = await finishedRuns(2, 'completed')
      assert.equal(new Set(repeated.map(run => run.id)).size, 2)
      assert.equal((await issue()).assignee_agent_id, agent.id)
      assert.equal((await issue()).description, MARKER)
      assert.ok(modelRequests >= 2, 'Both persisted executions must reach the model service')
      assert.deepEqual([...observedPrompts].sort(), [PROMPT, UPDATED_PROMPT].sort())
      await rpc('projects.archive', { project_id: projectId, version: (await project()).version })
    },
    diagnostics() {
      return { projectId, issueId, ruleId, modelRequests, observedPrompts: [...observedPrompts] }
    },
  }
}

export async function createDesktopScenario(options) {
  const status = createStatusAutomation(options)
  if (options.checkpoint === CHECKPOINT) return status
  const existing = await createAgentDispatch(options)
  let active = existing
  return {
    ...existing,
    handleHttp(...args) {
      return active.handleHttp(...args)
    },
    async verify(control) {
      await existing.verify(control)
      active = status
      await status.verify(control)
    },
    diagnostics() {
      return { dispatch: existing.diagnostics(), status: status.diagnostics() }
    },
  }
}
