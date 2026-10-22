import assert from 'node:assert/strict'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { reloadMainWindow, selectCollaborationDomain } from '../modules/workspace-flows.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const scoped = selector => `${CONTENT} ${selector}`
const AGENT_NAME = 'Cloud Issue mention agent'

export function createDesktopScenario({ captureScreenshot, uiTimeoutMs, workbenchReadyTimeoutMs }) {
  let cloud
  let workspace
  let project
  let agent
  const issues = []

  async function request(path, method = 'GET', values) {
    const response = await fetch(`${cloud.backendUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${cloud.authToken}`,
        'Content-Type': 'application/json',
      },
      ...(values === undefined ? {} : { body: JSON.stringify(values) }),
    })
    const text = await response.text()
    assert.equal(response.ok, true, `${method} ${path}: ${response.status} ${text}`)
    return text ? JSON.parse(text) : null
  }

  async function openBoard(control) {
    await control.command('openWeworkScheme', 'body', { value: `wework://boards/${project.id}` })
    await control.command('waitFor', scoped('[data-testid="collaboration-tab-board"]'), {
      timeoutMs: workbenchReadyTimeoutMs,
    })
    await control.command('click', scoped('[data-testid="collaboration-tab-board"]'))
    for (const issue of issues) {
      await control.command('waitFor', scoped(`[data-testid="cloud-todo-card-${issue.id}"]`), {
        timeoutMs: uiTimeoutMs,
      })
    }
  }

  return {
    requiresCloudEnvironment: true,

    async prepareCloud(environment) {
      cloud = environment
      await request('/api/admin/setup-complete', 'POST')
      workspace = await request('/api/v1/workspaces', 'POST', {
        name: `Cloud Issue mentions ${process.pid}`,
      })
      project = await request(`/api/v1/workspaces/${workspace.id}/projects`, 'POST', {
        projectKey: 'MENTION',
        name: 'Cloud Issue mentions',
        taskProvider: 'local',
        visibility: 'private',
      })
      agent = await request(`/api/v1/cloud-projects/${project.id}/chat-agents`, 'POST', {
        name: AGENT_NAME,
        runtime: 'codex',
        systemPrompt: 'Help review the project Issues.',
        executionMode: 'manual_approval',
        workspaceBinding: { type: 'standalone' },
        workspacePolicy: 'project',
        plugins: [],
      })
      for (const title of ['First review Issue', 'Second review Issue']) {
        issues.push(
          await request(`/api/v1/cloud-projects/${project.id}/loop-items`, 'POST', {
            title,
            status: 'in_review',
            priority: 'high',
          })
        )
      }
    },

    async verify(control) {
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await selectCollaborationDomain(control, CONTENT, 'cloud')
      await openBoard(control)
      const initial = JSON.parse(await control.command('snapshot', CONTENT))
      assert.equal(initial.testIds.includes('cloud-todo-workspace'), false)
      assert.equal(initial.testIds.includes('cloud-project-chat-view'), false)

      // Both moves must reach the real atomic update and survive a new board snapshot.
      const drop = scoped('[data-testid="cloud-todo-column-dropzone-pending"]')
      for (const issue of issues) {
        const card = scoped(`[data-testid="cloud-todo-card-${issue.id}"]`)
        await control.command('scrollIntoView', card)
        await control.command('scrollIntoView', drop)
        await control.command('dragStart', card, { target: drop })
        await control.command('dragEnd', card, { target: drop })
        await control.command(
          'waitFor',
          scoped(
            `[data-testid="cloud-todo-column-pending"] [data-testid="cloud-todo-card-${issue.id}"]`
          ),
          { timeoutMs: uiTimeoutMs }
        )
        const saved = await request(`/api/v1/loop-items/${issue.id}`)
        assert.equal(saved.status, 'pending')
        assert.ok(saved.version > issue.version)
      }
      await reloadMainWindow(control, 'The cloud Issue moves did not reopen')
      await openBoard(control)
      for (const issue of issues) {
        await control.command(
          'waitFor',
          scoped(
            `[data-testid="cloud-todo-column-pending"] [data-testid="cloud-todo-card-${issue.id}"]`
          ),
          { timeoutMs: uiTimeoutMs }
        )
      }

      await control.command('click', scoped(`[data-testid="cloud-todo-card-${issues[0].id}"]`))
      const detail = scoped('[data-testid="collaboration-issue-detail"]')
      await control.command('waitFor', detail, { text: issues[0].title, timeoutMs: uiTimeoutMs })
      await control.command('waitFor', scoped('[data-testid="cloud-task-activity-list"]'), {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', scoped('[data-testid="cloud-task-activity-composer"]'), {
        timeoutMs: uiTimeoutMs,
      })
      const composer = scoped('[data-testid="cloud-task-activity-composer"]')
      await control.command('fill', composer, { value: '@' })
      const mention = `[data-testid="collaboration-issue-mention-agent-${agent.id}"]`
      await control.command('waitFor', mention, { text: AGENT_NAME, timeoutMs: uiTimeoutMs })
      await control.command('click', mention)
      assert.ok((await control.command('getText', composer)).includes(AGENT_NAME))
      const selected = JSON.parse(await control.command('snapshot', CONTENT))
      for (const obsolete of [
        `cloud-todo-card-progress-popup-${issues[0].id}`,
        `cloud-todo-card-open-task-${issues[0].id}`,
        `task-discussion-${issues[0].id}`,
      ]) {
        assert.equal(selected.testIds.includes(obsolete), false)
      }
      await captureScreenshot(control, 'cloud-space-mention-persisted.png', CONTENT)
    },

    diagnostics() {
      return { workspaceId: workspace?.id, projectId: project?.id, agentId: agent?.id }
    },
  }
}
