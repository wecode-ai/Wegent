import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { runChecked } from '../modules/shared.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  inCollaborationSidebar,
  initializeFirstProjectExecutionEnvironment,
  openProjectAgentCreator,
  selectWhenOptionAvailable,
  waitForTestIdByText,
} from '../modules/workspace-flows.mjs'
import {
  assistantMessage,
  codexRequestKind,
  createSse,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const PANEL = `${CONTENT} [data-testid="ai-chat-modal"]`
const COMPOSER = `${PANEL} [data-testid="chat-message-input"][contenteditable="true"]`
const PREFIX = 'collaboration-project-execution-environment'
const KEY = 'collaboration-worktree-policy'
const PROJECT_ID = `local-code-${createHash('sha256').update(KEY).digest('hex')}`
const MARKER = 'COLLABORATION_WORKTREE_POLICY'
const scoped = selector => `${CONTENT} ${selector}`

async function tasks(control) {
  return JSON.parse(
    await control.command('readLocalProjectRuntimeTasks', 'body', { value: PROJECT_ID })
  )
}

async function waitForTask(control, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let latest = []
  while (Date.now() < deadline) {
    latest = await tasks(control)
    const task = latest.find(predicate)
    if (task) return task
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`Task state did not settle: ${JSON.stringify(latest)}`)
}

async function configurePolicy(control, policy) {
  await control.command('click', scoped('[data-testid="collaboration-tab-manage"]'))
  await control.command(
    'click',
    scoped('[data-testid="collaboration-project-settings-environments"]')
  )
  await control.command('select', scoped(`[data-testid="${PREFIX}-workspace-policy"]`), {
    value: policy,
  })
  await control.command('clickWhenEnabled', scoped(`[data-testid="${PREFIX}-save-configuration"]`))
  await control.command('waitFor', scoped(`[data-testid="${PREFIX}-configuration-status"]`), {
    text: '配置已保存',
  })
  const project = JSON.parse(
    await control.command('readLocalProject', 'body', { value: PROJECT_ID })
  )
  assert.equal(project.metadata.execution_environment.workspace_policy, policy)
  return project.metadata.execution_environment
}

async function createIssue(control, label) {
  await control.command('click', scoped('[data-testid="collaboration-tab-board"]'))
  await control.command('click', scoped('[data-testid="collaboration-issue-create"]'))
  await control.command('fill', scoped('[data-testid="cloud-todo-title"]'), { value: label })
  await control.command('fill', scoped('[data-testid="cloud-todo-detail-description"]'), {
    value: MARKER,
  })
  await control.command('clickWhenEnabled', scoped('[data-testid="cloud-todo-create-confirm"]'))
  await control.command('waitFor', scoped('[data-testid="collaboration-issue-detail"]'), {
    text: label,
  })
}

async function createTask(control, label, timeoutMs, executionMode = 'current_workspace') {
  await createIssue(control, label)
  await control.command('clickWhenEnabled', scoped('[data-testid="cloud-todo-create-task"]'))
  await control.command('waitFor', COMPOSER)
  if (executionMode === 'git_worktree') {
    const modeButton = `${PANEL} [data-testid="execution-mode-button"]`
    await control.command('click', modeButton)
    await control.command(
      'clickWhenEnabled',
      `${PANEL} [data-testid="execution-mode-git-worktree-button"]`
    )
    await control.command('waitFor', modeButton, { text: '新工作树' })
  }
  const before = new Set((await tasks(control)).map(task => task.taskId))
  await control.command('fill', COMPOSER, { value: `${MARKER} ${label}` })
  await control.command('press', COMPOSER, { key: 'Enter' })
  await control.command('waitFor', PANEL, { text: `${MARKER}_DONE`, timeoutMs })
  return waitForTask(control, task => !before.has(task.taskId) && !task.running, timeoutMs)
}

async function addAgent(control, timeoutMs) {
  await control.command('click', scoped('[data-testid="collaboration-tab-manage"]'))
  await control.command(
    'click',
    scoped('[data-testid="collaboration-project-settings-participants"]')
  )
  await control.command('click', scoped('[data-testid="collaboration-participants-tab-agents"]'))
  await openProjectAgentCreator(control, scoped('[data-testid="project-agent-add"]'), timeoutMs)
  await control.command('fill', '[data-testid="cloud-project-chat-agent-display-name"]', {
    value: MARKER,
  })
  await selectWhenOptionAvailable(
    control,
    '[data-testid="cloud-project-chat-agent-model"]',
    'wework-custom-desktop-e2e-responses',
    timeoutMs
  )
  await control.command('clickWhenEnabled', '[data-testid="cloud-project-chat-agent-save"]')
  await control.command('waitFor', '[data-testid="cloud-project-chat-agent-editor"]', {
    visible: false,
  })
  const row = await waitForTestIdByText(
    control,
    scoped('[data-testid="project-agent-list"]'),
    'project-agent-row-',
    MARKER,
    timeoutMs
  )
  return row.slice('project-agent-row-'.length)
}

async function runAgent(control, agentId, label, timeoutMs) {
  await createIssue(control, label)
  const before = new Set((await tasks(control)).map(task => task.taskId))
  await control.command('click', scoped('[data-testid="cloud-todo-detail-assignee"]'))
  await control.command(
    'click',
    `[data-testid="cloud-todo-detail-assignee-option-agent:${agentId}"]`
  )
  await control.command('clickWhenEnabled', scoped('[data-testid="cloud-todo-save"]'))
  await control.command('waitFor', scoped('[data-testid="cloud-task-activity-list"]'), {
    text: `${MARKER}_DONE`,
    timeoutMs,
  })
  const task = await waitForTask(
    control,
    task => !before.has(task.taskId) && !task.running,
    timeoutMs
  )
  await control.command('click', scoped('[data-testid="cloud-todo-detail-close"]'))
  return task
}

async function closeIssue(control) {
  await control.command('click', `${PANEL} [data-testid="ai-chat-modal-close"]`)
  await control.command('click', scoped('[data-testid="cloud-todo-detail-close"]'))
}

export function createDesktopScenario({
  workspacePath,
  captureScreenshot,
  modelResponseTimeoutMs,
}) {
  return {
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      const id = `worktree-policy-${Date.now()}`
      const message = codexRequestKind(body) === 'prewarm' ? 'Ready' : `${MARKER}_DONE`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(
        createSse([responseCreated(id), assistantMessage(message), responseCompleted(id)])
      )
      return true
    },

    async verify(control) {
      // The runner supplies a real Git repository, executor and isolated application.
      await runChecked('git', ['remote', 'add', 'origin', workspacePath], { cwd: workspacePath })
      await control.command('seedLocalProject', 'body', {
        value: JSON.stringify({
          projectKey: KEY,
          name: 'Worktree policy E2E',
          path: workspacePath,
        }),
      })
      await ensureExperimentalFeaturesEnabled(control)
      const readyCount = control.readyCount
      await control.command('reloadApp', 'body')
      await control.awaitReadyAfter(readyCount)
      await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]')
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      const toggle = inCollaborationSidebar(
        '[data-testid="collaboration-workspace-toggle-wework-local-workspace"]'
      )
      await control.command('waitFor', toggle)
      if ((await control.command('getAttribute', toggle, { value: 'aria-expanded' })) !== 'true') {
        await control.command('click', toggle)
      }
      await control.command(
        'click',
        inCollaborationSidebar(`[data-testid="collaboration-workspace-project-${PROJECT_ID}"]`)
      )
      await control.command('setMainWindowSize', 'body', {
        value: JSON.stringify({ width: 1280, height: 800 }),
      })
      await initializeFirstProjectExecutionEnvironment(control, CONTENT, modelResponseTimeoutMs)
      const sharedConfig = await configurePolicy(control, 'project')
      const shared = await createTask(control, 'Shared directory', modelResponseTimeoutMs)
      assert.notEqual(shared.workspaceKind, 'worktree')
      assert.equal(shared.workspacePath, workspacePath)
      await closeIssue(control)
      const isolatedConfig = await configurePolicy(control, 'git_worktree')
      assert.equal(isolatedConfig.fingerprint, sharedConfig.fingerprint)
      assert.deepEqual(isolatedConfig.devices, sharedConfig.devices)
      const isolated = await createTask(
        control,
        'Isolated directory',
        modelResponseTimeoutMs,
        'git_worktree'
      )
      assert.equal(isolated.workspaceKind, 'worktree')
      assert.notEqual(isolated.workspacePath, shared.workspacePath)
      await access(join(isolated.workspacePath, '.git'))
      const taskIds = (await tasks(control)).map(task => task.taskId).sort()
      await control.command('fill', COMPOSER, { value: `${MARKER} follow up` })
      await control.command('press', COMPOSER, { key: 'Enter' })
      const continued = await waitForTask(
        control,
        task =>
          task.taskId === isolated.taskId && !task.running && task.updatedAt > isolated.updatedAt,
        modelResponseTimeoutMs
      )
      assert.equal(continued.workspacePath, isolated.workspacePath)
      assert.deepEqual((await tasks(control)).map(task => task.taskId).sort(), taskIds)
      await captureScreenshot(control, 'worktree-policy-01-isolated-conversation.png', 'body')
      await closeIssue(control)
      const agentId = await addAgent(control, modelResponseTimeoutMs)
      await configurePolicy(control, 'project')
      const sharedAgent = await runAgent(
        control,
        agentId,
        'Shared agent task',
        modelResponseTimeoutMs
      )
      assert.equal(sharedAgent.workspacePath, shared.workspacePath)
      assert.notEqual(sharedAgent.workspaceKind, 'worktree')
      await configurePolicy(control, 'git_worktree')
      const isolatedAgent = await runAgent(
        control,
        agentId,
        'Isolated agent task',
        modelResponseTimeoutMs
      )
      assert.equal(isolatedAgent.workspaceKind, 'worktree')
      assert.notEqual(isolatedAgent.workspacePath, isolated.workspacePath)
      await access(join(isolatedAgent.workspacePath, '.git'))
      const markerPath = join(isolated.workspacePath, 'restore-evidence.txt')
      await writeFile(markerPath, 'Snapshot recovery evidence\n')
      await runChecked('git', ['status', '--porcelain', '--untracked-files=all'], {
        cwd: isolated.workspacePath,
      })
      await control.command('click', '[data-testid="settings-button"]', { visible: true })
      await control.command('click', '[data-testid="settings-menu-button"]', { visible: true })
      await control.command('click', '[data-testid="settings-nav-worktrees"]', { visible: true })
      const remove = `[data-testid="delete-worktree-button-${isolated.taskId}"]`
      await control.command('waitFor', remove, { visible: true })
      await control.command('click', remove, { visible: true })
      await access(markerPath)
      await control.command(
        'click',
        '[data-testid="confirm-recycle-worktree-button-cancel-button"]',
        { visible: true }
      )
      await access(markerPath)
      await control.command('click', remove, { visible: true })
      await control.command('click', '[data-testid="confirm-recycle-worktree-button"]', {
        visible: true,
      })
      const restore = `[data-testid="restore-worktree-button-${isolated.taskId}"]`
      await control.command('waitFor', restore, { visible: true })
      await assert.rejects(access(isolated.workspacePath), { code: 'ENOENT' })
      await captureScreenshot(control, 'worktree-policy-02-restorable.png', 'body')
      await control.command('click', restore, { visible: true })
      await control.command('waitFor', `${remove}:not(:disabled)`, { visible: true })
      await runChecked('git', ['log', '-1', '--stat'], { cwd: isolated.workspacePath })
      assert.equal(await readFile(markerPath, 'utf8'), 'Snapshot recovery evidence\n')
      await captureScreenshot(control, 'worktree-policy-03-restored.png', 'body')
    },
  }
}
