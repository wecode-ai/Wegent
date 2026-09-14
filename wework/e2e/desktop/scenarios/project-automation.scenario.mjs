import assert from 'node:assert/strict'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'

const ACTIVE_WORKBENCH_SELECTOR = '[data-workspace-tab-content][aria-hidden="false"]'
const WORKSPACE_NAME = '协作组验收空间'
const PROJECT_NAME = '协作组验收项目'
const WORKSPACE_GROUP_NAME = '空间交付协作组'
const PROJECT_GROUP_NAME = '项目响应协作组'
const PROJECT_AGENT_NAME = '项目 Codex 负责人'

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

async function createGroup(control, { name, leader }) {
  await control.command('fill', scoped('[data-testid="collaboration-group-name"]'), {
    value: name,
  })
  await control.command('select', scoped('[data-testid="collaboration-group-leader"]'), {
    value: leader,
  })
  await control.command('clickWhenEnabled', scoped('[data-testid="collaboration-group-create"]'), {
    timeoutMs: 10_000,
  })
}

async function createAgentGroup(control, { name, agentId }) {
  await createGroup(control, {
    name,
    leader: `agent:${agentId}`,
  })
}

export function createDesktopScenario({ captureScreenshot, uiTimeoutMs, workbenchReadyTimeoutMs }) {
  let backendUrl = ''
  let authToken = ''
  let workspace = null
  let project = null
  let fixtureArchived = false

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

    async prepareCloud(cloud) {
      backendUrl = cloud.backendUrl
      authToken = cloud.authToken
      await request('/api/admin/setup-complete', { method: 'POST' })
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

        const workspaceName = `${WORKSPACE_NAME}-${process.pid}`
        await control.command('waitFor', scoped('[data-testid="collaboration-workspace-create"]'), {
          visible: true,
          timeoutMs: uiTimeoutMs,
        })
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
          'clickWhenEnabled',
          scoped('[data-testid="collaboration-workspace-create-confirm"]'),
          { timeoutMs: uiTimeoutMs }
        )
        workspace = await waitForApiValue(
          async () => {
            const response = await request('/api/v1/workspaces')
            return response.items?.find(candidate => candidate.name === workspaceName) ?? null
          },
          Boolean,
          'Creating the collaboration Workspace did not persist',
          uiTimeoutMs
        )

        await control.command(
          'waitFor',
          scoped('[data-testid="collaboration-workspace-starter-configure-agents"]'),
          { visible: true, timeoutMs: uiTimeoutMs }
        )
        await control.command(
          'click',
          scoped('[data-testid="collaboration-workspace-starter-configure-agents"]')
        )
        await control.command(
          'waitFor',
          scoped('[data-testid="collaboration-workspace-participants-tab-groups"]'),
          { visible: true, timeoutMs: uiTimeoutMs }
        )
        await control.command(
          'click',
          scoped('[data-testid="collaboration-workspace-participants-tab-groups"]')
        )
        await control.command('click', scoped('[data-testid="collaboration-group-open-create"]'))
        await control.command('waitFor', scoped('[data-testid="collaboration-group-form"]'), {
          timeoutMs: uiTimeoutMs,
        })
        await createGroup(control, {
          name: WORKSPACE_GROUP_NAME,
          leader: `human:${workspace.created_by_user_id}`,
        })
        const workspaceGroup = await waitForApiValue(
          () => request(`/api/v1/workspaces/${workspace.id}/collaboration-groups`),
          response =>
            response.items?.find(candidate => candidate.name === WORKSPACE_GROUP_NAME) ?? null,
          'Creating a Workspace-owned collaboration group did not persist',
          uiTimeoutMs
        )
        assert.equal(workspaceGroup.owner_type, 'workspace')
        assert.equal(workspaceGroup.leader.kind, 'human')
        assert.equal(workspaceGroup.leader.id, String(workspace.created_by_user_id))
        await control.command(
          'waitFor',
          scoped(`[data-testid="collaboration-group-detail-${workspaceGroup.id}"]`),
          { text: WORKSPACE_GROUP_NAME, timeoutMs: uiTimeoutMs }
        )
        await control.command('click', scoped('[data-testid="collaboration-group-detail-back"]'))
        await control.command(
          'waitFor',
          scoped(`[data-testid="collaboration-group-${workspaceGroup.id}"]`),
          { text: WORKSPACE_GROUP_NAME, timeoutMs: uiTimeoutMs }
        )
        await control.command(
          'scrollIntoView',
          scoped(`[data-testid="collaboration-group-${workspaceGroup.id}"]`)
        )
        await capture(control, 'project-automation-01-workspace-collaboration-group.png')

        const projectName = `${PROJECT_NAME}-${process.pid}`
        await control.command(
          'click',
          scoped('[data-testid="collaboration-workspace-nav-projects"]')
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
          'clickWhenEnabled',
          scoped('[data-testid="collaboration-project-create-confirm"]'),
          { timeoutMs: uiTimeoutMs }
        )
        project = await waitForApiValue(
          async () => {
            const response = await request(`/api/v1/workspaces/${workspace.id}/projects`)
            return response.items?.find(candidate => candidate.name === projectName) ?? null
          },
          Boolean,
          'Creating the collaboration Project did not persist',
          uiTimeoutMs
        )

        await control.command(
          'click',
          scoped(`[data-testid="collaboration-workspace-project-${project.id}"]`)
        )
        await control.command('waitFor', scoped('[data-testid="collaboration-tab-manage"]'), {
          timeoutMs: uiTimeoutMs,
        })
        await control.command('click', scoped('[data-testid="collaboration-tab-manage"]'))
        await control.command(
          'click',
          scoped('[data-testid="collaboration-project-settings-participants"]')
        )
        await control.command('waitFor', scoped('[data-testid="project-agent-config"]'), {
          timeoutMs: uiTimeoutMs,
        })
        await control.command('click', scoped('[data-testid="project-agent-add"]'))
        await control.command('click', '[data-testid="project-agent-mode-create"]')
        await control.command('waitFor', '[data-testid="project-agent-standard-create-form"]', {
          timeoutMs: uiTimeoutMs,
        })
        const agentDialogSnapshot = JSON.parse(
          await control.command('snapshot', '[data-testid="project-agent-dialog"]')
        )
        assert.ok(
          !agentDialogSnapshot.testIds.some(testId => testId.includes('execution-environment')),
          'Custom Agent creation must not bind an execution environment'
        )
        await capture(control, 'project-automation-02-agent-create-without-environment.png')
        await control.command('fill', '[data-testid="project-agent-local-name"]', {
          value: PROJECT_AGENT_NAME,
        })
        await control.command('select', '[data-testid="project-agent-local-runtime"]', {
          value: 'codex',
        })
        await control.command('select', '[data-testid="project-agent-local-model"]', {
          value: '0',
        })
        await control.command('fill', '[data-testid="project-agent-local-capability"]', {
          value: '负责 Issue 分解、委派与交付验收',
        })
        await control.command('fill', '[data-testid="project-agent-local-system-prompt"]', {
          value: '按项目约束完成任务并给出可验证证据。',
        })
        await control.command('clickWhenEnabled', '[data-testid="project-agent-local-create"]', {
          timeoutMs: uiTimeoutMs,
        })
        const projectAgent = await waitForApiValue(
          () => request(`/api/v1/cloud-projects/${project.id}/chat-agents`),
          response => response.find(candidate => candidate.name === PROJECT_AGENT_NAME) ?? null,
          'Creating a project-owned Agent did not persist',
          uiTimeoutMs
        )
        await control.command(
          'waitFor',
          scoped(`[data-testid="project-agent-row-${projectAgent.id}"]`),
          { text: PROJECT_AGENT_NAME, timeoutMs: uiTimeoutMs }
        )
        await capture(control, 'project-automation-03-project-agent-created.png')

        await control.command(
          'click',
          scoped('[data-testid="collaboration-participants-tab-groups"]')
        )
        await control.command(
          'waitFor',
          scoped(`[data-testid="collaboration-group-add-${workspaceGroup.id}"]`),
          { timeoutMs: uiTimeoutMs }
        )
        await control.command(
          'click',
          scoped(`[data-testid="collaboration-group-add-${workspaceGroup.id}"]`)
        )
        await waitForApiValue(
          () => request(`/api/v1/cloud-projects/${project.id}/collaboration-groups`),
          response => response.items?.some(candidate => candidate.id === workspaceGroup.id),
          'Adding the Workspace collaboration group to the Project did not persist',
          uiTimeoutMs
        )

        await control.command('click', scoped('[data-testid="collaboration-group-open-create"]'))
        await createAgentGroup(control, {
          name: PROJECT_GROUP_NAME,
          agentId: projectAgent.id,
        })
        const projectGroup = await waitForApiValue(
          () => request(`/api/v1/cloud-projects/${project.id}/collaboration-groups`),
          response =>
            response.items?.find(candidate => candidate.name === PROJECT_GROUP_NAME) ?? null,
          'Creating a Project-owned collaboration group did not persist',
          uiTimeoutMs
        )
        assert.equal(projectGroup.owner_type, 'project')
        assert.equal(projectGroup.leader.kind, 'agent')
        assert.equal(projectGroup.leader.id, String(projectAgent.id))
        await control.command(
          'waitFor',
          scoped(`[data-testid="collaboration-group-detail-${projectGroup.id}"]`),
          { text: PROJECT_GROUP_NAME, timeoutMs: uiTimeoutMs }
        )
        await control.command('click', scoped('[data-testid="collaboration-group-detail-back"]'))
        await control.command(
          'waitFor',
          scoped(`[data-testid="collaboration-group-${projectGroup.id}"]`),
          { text: PROJECT_GROUP_NAME, timeoutMs: uiTimeoutMs }
        )
        await control.command(
          'scrollIntoView',
          scoped(`[data-testid="collaboration-group-${projectGroup.id}"]`)
        )
        await capture(control, 'project-automation-04-project-collaboration-groups.png')

        await control.command(
          'click',
          scoped(`[data-testid="collaboration-group-remove-${workspaceGroup.id}"]`)
        )
        await waitForApiValue(
          () => request(`/api/v1/cloud-projects/${project.id}/collaboration-groups`),
          response => !response.items?.some(candidate => candidate.id === workspaceGroup.id),
          'Removing the Workspace collaboration group from the Project did not persist',
          uiTimeoutMs
        )
        const workspaceGroups = await request(
          `/api/v1/workspaces/${workspace.id}/collaboration-groups`
        )
        assert.ok(
          workspaceGroups.items.some(candidate => candidate.id === workspaceGroup.id),
          'Removing a Workspace collaboration group from a Project deleted the source resource'
        )

        await control.command(
          'click',
          scoped(`[data-testid="collaboration-group-remove-${projectGroup.id}"]`)
        )
        await waitForApiValue(
          () => request(`/api/v1/cloud-projects/${project.id}/collaboration-groups`),
          response => response.items?.length === 0,
          'Deleting the Project-owned collaboration group did not persist',
          uiTimeoutMs
        )
        await control.command(
          'waitFor',
          scoped(`[data-testid="collaboration-group-available-${workspaceGroup.id}"]`),
          { text: WORKSPACE_GROUP_NAME, timeoutMs: uiTimeoutMs }
        )
        await control.command(
          'scrollIntoView',
          scoped(`[data-testid="collaboration-group-available-${workspaceGroup.id}"]`)
        )
        await capture(control, 'project-automation-05-project-groups-removed.png')
      } finally {
        try {
          await archiveFixture()
        } catch (error) {
          console.warn(
            `[collaboration-groups] fixture cleanup deferred after verification failure: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        }
      }
    },

    async cleanup() {
      await archiveFixture()
    },
  }
}
