import assert from 'node:assert/strict'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { createBoardReplyModelRegression } from '../modules/board-reply-model.mjs'
import { verifyIssueConversationDrawers } from '../modules/issue-conversation-drawers.mjs'
import { verifyCollaborationIssueHome } from '../modules/collaboration-issue-home.mjs'
import { verifyCollaborationLocalProjectImport } from '../modules/collaboration-local-project-import.mjs'
const ACTIVE_WORKBENCH_SELECTOR = '[data-workspace-tab-content][aria-hidden="false"]'
const WORKSPACE_NAME = '协作共享核心空间'
const PROJECT_NAME = '协作共享核心验收'
const ISSUE_TITLE = '验证共享协作主流程'
const COMMENT_BODY = 'Wework 真实桌面 E2E 评论'
const HUMAN_ASSIGNMENT_COMMENT = '请处理需求确认'
const HUMAN_WORKFLOW_STEP = '需求确认'
const AGENT_ASSIGNMENT_COMMENT = '请处理实现步骤'
const AGENT_WORKFLOW_STEP = '实现'
const AGENT_NAME = '协作核心 Codex'
const TASK_PROMPT = '检查当前 Issue 并开始执行'

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

function scoped(selector) {
  return `${ACTIVE_WORKBENCH_SELECTOR} ${selector}`
}

async function snapshot(control) {
  return JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
}

async function waitForApiValue(load, predicate, message, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let latest = null
  while (Date.now() < deadline) {
    latest = await load()
    if (predicate(latest)) return latest
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`${message}: ${JSON.stringify(latest)}`)
}

function terminalExecution(execution) {
  return ['completed', 'failed', 'cancelled'].includes(execution.status)
}

export function createDesktopScenario({
  captureScreenshot,
  uiTimeoutMs,
  workbenchReadyTimeoutMs,
  executorHome,
}) {
  const boardReplyModel = createBoardReplyModelRegression({ executorHome, uiTimeoutMs })
  let backendUrl = ''
  let authToken = ''
  let owner = null
  let workspace = null
  let project = null
  let issue = null
  let agent = null
  let fixtureArchived = false

  const request = (pathname, options) => requestJson(backendUrl, authToken, pathname, options)
  const capture = (control, name) => captureScreenshot(control, name, ACTIVE_WORKBENCH_SELECTOR)

  async function archiveFixture() {
    if (fixtureArchived) return
    try {
      if (project) {
        const executions = await request(
          `/api/v1/cloud-projects/${project.id}/executions?include_terminal=true`
        )
        for (const execution of executions.items.filter(
          candidate => !terminalExecution(candidate)
        )) {
          await request(`/api/v1/cloud-projects/${project.id}/executions/${execution.id}/stop`, {
            method: 'POST',
          })
        }
        await waitForApiValue(
          () => request(`/api/v1/cloud-projects/${project.id}/executions?include_terminal=true`),
          response => response.items.every(terminalExecution),
          'Project executions remained active during fixture cleanup',
          Math.max(uiTimeoutMs, 30_000)
        )
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
    handleHttp: boardReplyModel.handleHttp,

    async prepareCloud(cloud) {
      backendUrl = cloud.backendUrl
      authToken = cloud.authToken
      owner = await request('/api/users/me')
      await request('/api/admin/setup-complete', { method: 'POST' })
    },

    async verify(control) {
      assert.ok(owner?.id, 'The collaboration owner fixture is missing')

      try {
        await ensureExperimentalFeaturesEnabled(control)
        await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
          timeoutMs: workbenchReadyTimeoutMs,
        })
        await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
        await control.command('waitFor', scoped('[data-testid="wework-collaboration-platform"]'), {
          timeoutMs: uiTimeoutMs,
        })
        assert.equal(
          await control.command(
            'getAttribute',
            '[data-testid="workspace-tab-select-fixed-board"]',
            { value: 'aria-selected' }
          ),
          'true',
          'Opening Collaboration did not activate the fixed Collaboration tab'
        )

        const platformSnapshot = await snapshot(control)
        assert.ok(
          platformSnapshot.testIds.includes('wework-collaboration-platform') &&
            platformSnapshot.testIds.includes('collaboration-platform-root'),
          'The fixed Collaboration tab did not render the shared native Collaboration module'
        )
        await control.command('waitFor', scoped('[data-testid="collaboration-workspace-create"]'), {
          timeoutMs: uiTimeoutMs,
        })
        await capture(control, 'collaboration-shared-core-01-all-workspaces.png')

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
          {
            value: workspaceName,
          }
        )
        await control.command(
          'fill',
          scoped('[data-testid="collaboration-workspace-description-input"]'),
          { value: 'Created through the real native Wework Collaboration UI.' }
        )
        await control.command(
          'click',
          scoped('[data-testid="collaboration-workspace-create-confirm"]')
        )
        workspace = await waitForApiValue(
          async () => {
            const response = await request('/api/v1/workspaces')
            return response.items?.find(candidate => candidate.name === workspaceName) ?? null
          },
          value => Boolean(value),
          'Creating a Workspace through the native Collaboration UI did not persist',
          uiTimeoutMs
        )
        assert.equal(workspace.name, workspaceName)
        await control.command(
          'waitFor',
          scoped('[data-testid="collaboration-workspace-project-create"]'),
          { timeoutMs: uiTimeoutMs }
        )
        await capture(control, 'collaboration-shared-core-02-workspace-created.png')

        const projectName = `${PROJECT_NAME}-${process.pid}`
        await control.command(
          'click',
          scoped('[data-testid="collaboration-workspace-project-create"]')
        )
        await control.command(
          'waitFor',
          scoped('[data-testid="collaboration-project-name-input"]'),
          { timeoutMs: uiTimeoutMs }
        )
        await control.command('fill', scoped('[data-testid="collaboration-project-name-input"]'), {
          value: projectName,
        })
        await control.command(
          'fill',
          scoped('[data-testid="collaboration-project-description-input"]'),
          { value: 'Created through Workspace → Project in the native Wework module.' }
        )
        await control.command(
          'click',
          scoped('[data-testid="collaboration-project-create-confirm"]')
        )
        project = await waitForApiValue(
          async () => {
            const response = await request(`/api/v1/workspaces/${workspace.id}/projects`)
            return response.items?.find(candidate => candidate.name === projectName) ?? null
          },
          value => Boolean(value),
          'Creating a Project through the native Collaboration UI did not persist',
          uiTimeoutMs
        )
        assert.equal(project.name, projectName)
        const persistedWorkspace = await request(`/api/v1/workspaces/${workspace.id}`)
        assert.equal(persistedWorkspace.project_count, 1)
        const persistedProjects = await request(`/api/v1/workspaces/${workspace.id}/projects`)
        assert.ok(persistedProjects.items.some(candidate => candidate.id === project.id))
        await control.command('waitFor', scoped('[data-testid="collaboration-root"]'), {
          timeoutMs: uiTimeoutMs,
        })
        await control.command('waitFor', scoped('[data-testid="collaboration-empty-project"]'), {
          timeoutMs: uiTimeoutMs,
        })
        await capture(control, 'collaboration-shared-core-03-project-created.png')

        await control.command('click', scoped('[data-testid="collaboration-issue-create"]'))
        await control.command('waitFor', scoped('[data-testid="cloud-todo-title"]'), {
          timeoutMs: uiTimeoutMs,
        })
        await control.command('fill', scoped('[data-testid="cloud-todo-title"]'), {
          value: ISSUE_TITLE,
        })
        await control.command('fill', scoped('[data-testid="cloud-todo-detail-description"]'), {
          value: '验证共享界面、评论、分配与 Wework 本地 Task 创建桥。',
        })
        await control.command('click', scoped('[data-testid="cloud-todo-create-confirm"]'))
        issue = await waitForApiValue(
          async () => {
            const response = await request(`/api/v1/cloud-projects/${project.id}/loop-items`)
            return response.items?.find(candidate => candidate.title === ISSUE_TITLE) ?? null
          },
          value => Boolean(value),
          'Creating an Issue through the native Collaboration UI did not persist',
          uiTimeoutMs
        )
        assert.equal(issue.title, ISSUE_TITLE)
        await control.command('waitFor', scoped('[data-testid="collaboration-issue-detail"]'), {
          timeoutMs: uiTimeoutMs,
        })
        await capture(control, 'collaboration-shared-core-04-issue-created.png')

        agent = await request(`/api/v1/cloud-projects/${project.id}/chat-agents`, {
          method: 'POST',
          body: JSON.stringify({
            name: AGENT_NAME,
            runtime: 'codex',
            systemPrompt: 'Complete the assigned project work.',
            capabilityDescription: 'Desktop E2E project implementation agent',
            visibility: 'creator_admin',
            executionEnvironment: 'local',
            executionMode: 'manual_approval',
            workspaceBinding: { type: 'standalone' },
            maxConcurrentExecutions: 1,
            workspacePolicy: 'project',
            plugins: [],
          }),
        })

        await control.command('waitFor', scoped('[data-testid="cloud-todo-detail"]'), {
          timeoutMs: uiTimeoutMs,
        })
        await verifyCollaborationIssueHome(control, {
          request,
          project,
          issue,
          owner,
          agent,
          scoped,
        })
        await capture(control, 'collaboration-shared-core-05-shared-issue-detail.png')
        const activitySelector = scoped(`[data-testid="cloud-task-activity-${issue.id}"]`)
        const activityListSelector = scoped('[data-testid="cloud-task-activity-list"]')
        const activityComposerSelector = scoped('[data-testid="cloud-task-activity-composer"]')
        await control.command('waitFor', activitySelector, { timeoutMs: uiTimeoutMs })
        assert.equal(
          await control.command('getValue', scoped('[data-testid="cloud-todo-detail-title"]')),
          ISSUE_TITLE,
          'The shared Wework Issue detail did not load the selected real backend Issue'
        )

        await control.command('fill', activityComposerSelector, {
          value: COMMENT_BODY,
        })
        await control.command('press', activityComposerSelector, { key: 'Enter' })
        await control.command('waitFor', activityListSelector, {
          text: COMMENT_BODY,
          timeoutMs: uiTimeoutMs,
        })
        const replyComposerSelector = scoped('[data-testid^="cloud-task-activity-card-composer-"]')
        await control.command('waitFor', replyComposerSelector, { timeoutMs: uiTimeoutMs })
        await control.command('fill', replyComposerSelector, {
          value: '在动态卡片内回复',
        })
        await control.command('press', replyComposerSelector, { key: 'Enter' })
        await control.command('waitFor', scoped('[data-testid^="cloud-task-activity-replies-"]'), {
          text: '在动态卡片内回复',
          timeoutMs: uiTimeoutMs,
        })

        await request(`/api/v1/loop-items/${issue.id}/assignments`, {
          method: 'POST',
          body: JSON.stringify({
            target_type: 'human',
            target_id: String(owner.id),
            workflow_step: HUMAN_WORKFLOW_STEP,
            comment_body: HUMAN_ASSIGNMENT_COMMENT,
            notify_target: false,
          }),
        })
        await request(`/api/v1/loop-items/${issue.id}/assignments`, {
          method: 'POST',
          body: JSON.stringify({
            target_type: 'agent',
            target_id: agent.id,
            workflow_step: AGENT_WORKFLOW_STEP,
            comment_body: AGENT_ASSIGNMENT_COMMENT,
            notify_target: false,
          }),
        })
        const assignments = await request(`/api/v1/loop-items/${issue.id}/assignments`)
        assert.ok(
          assignments.items.some(
            assignment =>
              assignment.target_type === 'human' &&
              assignment.target_id === String(owner.id) &&
              assignment.workflow_step === HUMAN_WORKFLOW_STEP
          ),
          'The real backend did not persist the human workflow-step assignment'
        )
        assert.ok(
          assignments.items.some(
            assignment =>
              assignment.target_type === 'agent' &&
              assignment.target_id === agent.id &&
              assignment.workflow_step === AGENT_WORKFLOW_STEP
          ),
          'The real backend did not persist the Agent workflow-step assignment'
        )
        await capture(control, 'collaboration-shared-core-06-issue-activity.png')
        await control.command('click', scoped('[data-testid="cloud-todo-detail-close"]'))
        await control.command('waitFor', scoped('[data-testid="collaboration-issue-detail"]'), {
          visible: false,
          timeoutMs: uiTimeoutMs,
        })
        await control.command('click', scoped(`[data-testid="cloud-todo-card-${issue.id}"]`))
        await control.command('waitFor', activitySelector, { timeoutMs: uiTimeoutMs })
        await boardReplyModel.verify(control, issue, scoped, {
          backendUrl,
          authToken,
          projectId: project.id,
        })
        await verifyIssueConversationDrawers(control, scoped, uiTimeoutMs)
        await capture(control, 'collaboration-shared-core-06-cloud-model-reply.png')
        const previousBindings = await request(`/api/v1/loop-items/${issue.id}/tasks`)
        const previousTaskIds = new Set(
          previousBindings.map(binding => binding.taskId ?? binding.task_id)
        )

        await control.command('click', scoped('[data-testid="cloud-todo-create-task"]'))
        await control.command('waitFor', scoped('[data-testid="ai-chat-modal"]'), {
          timeoutMs: uiTimeoutMs,
        })
        await control.command('waitFor', scoped('[data-testid="work-item-new-task-chat-panel"]'), {
          timeoutMs: uiTimeoutMs,
        })
        await control.command(
          'waitFor',
          scoped(
            '[data-testid="work-item-new-task-chat-panel"] [data-testid="chat-message-input"]'
          ),
          {
            timeoutMs: uiTimeoutMs,
          }
        )
        const bridgeSnapshot = await snapshot(control)
        assert.ok(
          bridgeSnapshot.text.includes(project.name) &&
            bridgeSnapshot.text.includes(issue.id) &&
            bridgeSnapshot.text.includes(ISSUE_TITLE),
          'The Wework local Task bridge did not retain the Project and Issue context'
        )
        await capture(control, 'collaboration-shared-core-07-local-task-bridge.png')

        const taskComposer = scoped(
          '[data-testid="work-item-new-task-chat-panel"] [data-testid="chat-message-input"]'
        )
        await control.command('fill', taskComposer, { value: TASK_PROMPT })
        await control.command('press', taskComposer, { key: 'Enter' })
        const taskBindings = await waitForApiValue(
          async () =>
            (await request(`/api/v1/loop-items/${issue.id}/tasks`)).filter(
              binding => !previousTaskIds.has(binding.taskId ?? binding.task_id)
            ),
          value => Array.isArray(value) && value.length > 0,
          'Starting work did not bind the new Wework local Task to the Issue',
          uiTimeoutMs
        )
        const binding = taskBindings[0]
        assert.ok(binding.deviceId ?? binding.device_id, 'The Task binding has no device identity')
        assert.ok(
          binding.taskId ?? binding.task_id,
          'The Task binding has no runtime task identity'
        )
        const updatedIssue = await waitForApiValue(
          () => request(`/api/v1/loop-items/${issue.id}`),
          value => ['in_progress', 'in_review'].includes(value?.status),
          'Starting the Wework local Task did not project its runtime status to the Issue',
          uiTimeoutMs
        )
        assert.notEqual(updatedIssue.status, 'inbox')
        await capture(control, 'collaboration-shared-core-08-local-task-bound.png')
        await verifyCollaborationLocalProjectImport(control, {
          cloudProjectId: project.id,
          cloudWorkspaceId: workspace.id,
          executorHome,
          scoped,
          workbenchReadyTimeoutMs,
        })
      } finally {
        await archiveFixture()
      }
    },

    async cleanup() {
      await archiveFixture()
    },

    diagnostics() {
      return {
        agentId: agent?.id ?? null,
        fixtureArchived,
        issueId: issue?.id ?? null,
        projectId: project?.id ?? null,
        workspaceId: workspace?.id ?? null,
      }
    },
  }
}
