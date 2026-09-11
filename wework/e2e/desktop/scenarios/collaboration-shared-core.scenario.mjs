import assert from 'node:assert/strict'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'

const ACTIVE_WORKBENCH_SELECTOR = '[data-workspace-tab-content][aria-hidden="false"]'
const WORKSPACE_NAME = '协作共享核心空间'
const PROJECT_NAME = '协作共享核心验收'
const PROJECT_KEY = 'CSCORE'
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

export function createDesktopScenario({ captureScreenshot, uiTimeoutMs, workbenchReadyTimeoutMs }) {
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
    fixtureArchived = true
  }

  return {
    requiresCloudEnvironment: true,

    async prepareCloud(cloud) {
      backendUrl = cloud.backendUrl
      authToken = cloud.authToken
      owner = await request('/api/users/me')
      workspace = await request('/api/v1/workspaces', {
        method: 'POST',
        body: JSON.stringify({
          name: `${WORKSPACE_NAME}-${process.pid}`,
          description: 'Wework shared CollaborationPlatformApp desktop E2E fixture',
        }),
      })
      project = await request(`/api/v1/workspaces/${workspace.id}/projects`, {
        method: 'POST',
        body: JSON.stringify({
          project_key: `${PROJECT_KEY}${String(process.pid).slice(-3)}`,
          name: `${PROJECT_NAME}-${process.pid}`,
          description: 'Workspace → Project → Issue shared UI verification',
          task_provider: 'local',
          provider_config: {},
          visibility: 'private',
        }),
      })
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
      issue = await request(`/api/v1/cloud-projects/${project.id}/loop-items`, {
        method: 'POST',
        body: JSON.stringify({
          title: ISSUE_TITLE,
          description: '验证共享界面、评论、分配与 Wework 本地 Task 创建桥。',
          status: 'inbox',
          priority: 'high',
        }),
      })
    },

    async verify(control) {
      assert.ok(owner?.id, 'The collaboration owner fixture is missing')
      assert.ok(workspace?.id, 'The collaboration Workspace fixture is missing')
      assert.ok(project?.id, 'The collaboration Project fixture is missing')
      assert.ok(issue?.id, 'The collaboration Issue fixture is missing')
      assert.ok(agent?.id, 'The collaboration Agent fixture is missing')

      try {
        const persistedWorkspace = await request(`/api/v1/workspaces/${workspace.id}`)
        assert.equal(persistedWorkspace.project_count, 1)
        const persistedProjects = await request(`/api/v1/workspaces/${workspace.id}/projects`)
        assert.ok(persistedProjects.items.some(candidate => candidate.id === project.id))

        await ensureExperimentalFeaturesEnabled(control)
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
        assert.equal(
          await control.command(
            'getAttribute',
            '[data-testid="workspace-tab-select-fixed-board"]',
            { value: 'aria-selected' }
          ),
          'true',
          'Opening Collaboration did not activate the fixed Collaboration tab'
        )

        await control.command(
          'waitFor',
          scoped(`[data-testid="collaboration-workspace-${workspace.id}"]`),
          {
            text: workspace.name,
            timeoutMs: uiTimeoutMs,
          }
        )
        const platformSnapshot = await snapshot(control)
        for (const testId of [
          'wework-collaboration-platform',
          'collaboration-platform-root',
          'collaboration-platform-sidebar',
          'collaboration-nav-all-spaces',
          'collaboration-nav-resources',
        ]) {
          assert.ok(
            platformSnapshot.testIds.includes(testId),
            `The shared CollaborationPlatformApp is missing ${testId}`
          )
        }
        await capture(control, 'collaboration-shared-core-01-all-workspaces.png')

        await control.command(
          'click',
          scoped(`[data-testid="collaboration-workspace-${workspace.id}"]`)
        )
        await control.command('waitFor', scoped('[data-testid="collaboration-workspace-back"]'), {
          timeoutMs: uiTimeoutMs,
        })
        await control.command(
          'waitFor',
          scoped(`[data-testid="collaboration-project-card-${project.id}"]`),
          {
            text: project.name,
            timeoutMs: uiTimeoutMs,
          }
        )
        await capture(control, 'collaboration-shared-core-02-workspace-home.png')

        await control.command(
          'click',
          scoped(`[data-testid="collaboration-project-card-${project.id}"]`)
        )
        await control.command('waitFor', scoped('[data-testid="cloud-todo-workspace"]'), {
          timeoutMs: uiTimeoutMs,
        })
        await control.command('waitFor', scoped(`[data-testid="cloud-todo-card-${issue.id}"]`), {
          text: ISSUE_TITLE,
          timeoutMs: uiTimeoutMs,
        })
        await capture(control, 'collaboration-shared-core-03-project-board.png')

        await control.command('click', scoped(`[data-testid="cloud-todo-card-${issue.id}"]`))
        await control.command('waitFor', scoped('[data-testid="cloud-todo-detail"]'), {
          timeoutMs: uiTimeoutMs,
        })
        const activitySelector = scoped(`[data-testid="cloud-task-activity-${issue.id}"]`)
        const activityListSelector = scoped('[data-testid="cloud-task-activity-list"]')
        const activityComposerSelector = scoped('[data-testid="cloud-task-activity-composer"]')
        await control.command('waitFor', activitySelector, { timeoutMs: uiTimeoutMs })
        assert.equal(
          await control.command('getValue', scoped('[data-testid="cloud-todo-detail-title"]')),
          ISSUE_TITLE,
          'The mature Wework Issue detail did not load the selected real backend Issue'
        )

        await control.command('fill', activityComposerSelector, {
          value: COMMENT_BODY,
        })
        await control.command('press', activityComposerSelector, { key: 'Enter' })
        await control.command('waitFor', activityListSelector, {
          text: COMMENT_BODY,
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
        await capture(control, 'collaboration-shared-core-04-issue-activity.png')

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
        await capture(control, 'collaboration-shared-core-05-local-task-bridge.png')

        const taskComposer = scoped(
          '[data-testid="work-item-new-task-chat-panel"] [data-testid="chat-message-input"]'
        )
        await control.command('fill', taskComposer, { value: TASK_PROMPT })
        await control.command('press', taskComposer, { key: 'Enter' })
        const taskBindings = await waitForApiValue(
          () => request(`/api/v1/loop-items/${issue.id}/tasks`),
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
        await capture(control, 'collaboration-shared-core-06-local-task-bound.png')
      } finally {
        await archiveFixture()
      }
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
