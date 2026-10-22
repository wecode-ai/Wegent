import assert from 'node:assert/strict'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  openDirectProjectCreation,
  openProjectAgentCreator,
  inProjectCreateDialog,
  selectCollaborationDomain,
  waitForTestIdByText,
} from '../modules/workspace-flows.mjs'
import { TransportFaultProxy } from '../modules/transport-fault-proxy.mjs'
import {
  assertSavedCloudRouting,
  readBasicCloudDefault,
  verifyCloudSaveDuringNativeFaults,
  verifyLocalBasicDefaultSave,
} from '../modules/agent-catalog-regressions.mjs'

const ACTIVE_WORKBENCH_SELECTOR = '[data-workspace-tab-content][aria-hidden="false"]'
const WORKSPACE_NAME = '协作组验收空间'
const PROJECT_NAME = '协作组验收项目'
const WORKSPACE_GROUP_NAME = '空间交付协作组'
const PROJECT_GROUP_NAME = '项目响应协作组'
const DELETABLE_GROUP_NAME = '待删除协作小组'
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

async function createGroup(control, { name, leader, autoSelectedLeader = false }) {
  const separatorIndex = leader.indexOf(':')
  const leaderKind = leader.slice(0, separatorIndex)
  const leaderId = leader.slice(separatorIndex + 1)
  await control.command('fill', scoped('[data-testid="collaboration-group-name"]'), {
    value: name,
  })
  if (autoSelectedLeader) {
    // Workspace groups automatically include the authenticated creator as leader.
    await control.command(
      'waitFor',
      scoped(`[data-testid="collaboration-group-leader-${leaderKind}-${leaderId}"]`),
      { visible: true }
    )
  } else {
    await control.command('click', scoped('[data-testid="collaboration-group-create-add-members"]'))
    await control.command(
      'click',
      scoped(`[data-testid="collaboration-group-create-member-${leaderKind}-${leaderId}"]`)
    )
    await control.command('click', scoped('[data-testid="collaboration-group-create-add-members"]'))
    await control.command('click', scoped('[data-testid="collaboration-group-leader"]'))
    await control.command(
      'click',
      scoped(`[data-testid="collaboration-group-leader-${leaderKind}-${leaderId}"]`)
    )
  }
  await control.command('clickWhenEnabled', scoped('[data-testid="collaboration-group-create"]'), {
    timeoutMs: 10_000,
  })
}

export function createDesktopScenario({ captureScreenshot, uiTimeoutMs, workbenchReadyTimeoutMs }) {
  let backendUrl = ''
  let authToken = ''
  let cloudEnvironment
  let workspace = null
  let project = null
  let fixtureArchived = false
  let proxy
  const appEnvironment = {}

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
    appEnvironment,

    async prepareCloud(cloud) {
      backendUrl = cloud.backendUrl
      authToken = cloud.authToken
      await request('/api/admin/setup-complete', { method: 'POST' })
      proxy = await new TransportFaultProxy(backendUrl).start()
      appEnvironment.WEWORK_E2E_CLOUD_BACKEND_URL = proxy.url
    },

    setCloudEnvironment(value) {
      cloudEnvironment = value
    },

    async verify(control) {
      try {
        await ensureExperimentalFeaturesEnabled(control)
        await control.command('waitFor', '[data-testid="workbench-harness-selector"]', {
          visible: true,
        })
        assert.equal(
          Number(
            await control.command('getElementCount', '[data-testid="workbench-team-selector"]')
          ),
          0,
          'The task composer exposed the hidden cloud Agent selector'
        )
        assert.equal(
          Number(
            await control.command('getElementCount', '[data-testid="workbench-harness-selector"]')
          ),
          1,
          'The task composer did not keep exactly one local runtime selector'
        )
        await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
          timeoutMs: workbenchReadyTimeoutMs,
        })
        await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
        await control.command('waitFor', scoped('[data-testid="collaboration-platform-root"]'), {
          timeoutMs: uiTimeoutMs,
        })
        await selectCollaborationDomain(control, ACTIVE_WORKBENCH_SELECTOR, 'cloud')

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
          autoSelectedLeader: true,
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
        await openDirectProjectCreation(control, ACTIVE_WORKBENCH_SELECTOR)
        await control.command('waitFor', inProjectCreateDialog(), { timeoutMs: uiTimeoutMs })
        await control.command(
          'fill',
          inProjectCreateDialog('[data-testid="collaboration-project-name-input"]'),
          {
            value: projectName,
          }
        )
        await control.command(
          'clickWhenEnabled',
          inProjectCreateDialog('[data-testid="collaboration-project-create-confirm"]'),
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

        await control.command('waitFor', inProjectCreateDialog(), {
          visible: false,
          timeoutMs: uiTimeoutMs,
        })
        await control.command(
          'clickWhenEnabled',
          scoped(`[data-testid="collaboration-workspace-project-${project.id}"]`),
          { timeoutMs: uiTimeoutMs }
        )
        await control.command('waitFor', scoped('[data-testid="collaboration-tab-manage"]'), {
          timeoutMs: uiTimeoutMs,
        })
        await control.command('click', scoped('[data-testid="collaboration-tab-manage"]'))
        await control.command(
          'waitFor',
          scoped('[data-testid="project-settings-shell-group-ai-team"]'),
          { timeoutMs: uiTimeoutMs }
        )
        assert.equal(
          Number(
            await control.command(
              'getElementCount',
              scoped('[data-testid="project-settings-shell-group-ai-team"] + nav button')
            )
          ),
          3,
          'AI team navigation must expose agents, members, and collaboration teams'
        )

        await control.command(
          'click',
          scoped('[data-testid="collaboration-project-settings-groups"]')
        )
        await control.command(
          'waitFor',
          scoped('[data-testid="collaboration-project-settings-groups"][aria-current="page"]'),
          { timeoutMs: uiTimeoutMs }
        )
        assert.equal(
          Number(
            await control.command(
              'getElementCount',
              scoped('[data-testid="collaboration-project-groups-page"] [role="tablist"]')
            )
          ),
          0,
          'Project collaboration teams must open directly without nested participant tabs'
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

        await control.command(
          'click',
          scoped('[data-testid="collaboration-project-settings-agents"]')
        )
        await control.command(
          'waitFor',
          scoped('[data-testid="collaboration-project-settings-agents"][aria-current="page"]'),
          { timeoutMs: uiTimeoutMs }
        )
        await openProjectAgentCreator(
          control,
          scoped('[data-testid="project-agent-add"]'),
          uiTimeoutMs,
          'wework-agent-resource-creator'
        )
        const agentDialogSnapshot = JSON.parse(
          await control.command('snapshot', '[data-testid="wework-agent-resource-creator"]')
        )
        assert.ok(
          agentDialogSnapshot.testIds.includes('wework-agent-resource-creator-tab-basic'),
          'Agent creation must open the basic information tab'
        )
        await capture(control, 'project-automation-02-agent-create-basic-tab.png')
        await control.command('fill', '[data-testid="wework-agent-display-name"]', {
          value: PROJECT_AGENT_NAME,
        })
        const modelCatalog = await request(
          '/api/models/unified?include_config=true&scope=all&model_category_type=llm&client_origin=wework'
        )
        const selectableModels = (modelCatalog.data ?? []).filter(
          model =>
            model.type === 'public' && model.isActive !== false && !model.compatibilityDisabled
        )
        assert.ok(
          selectableModels.length > 0,
          'No executable model is available for Agent creation'
        )
        const defaultModel = await readBasicCloudDefault(
          control,
          'wework-agent',
          'wework-agent-resource-creator',
          uiTimeoutMs
        )
        await control.command('fill', '[data-testid="wework-agent-system-prompt"]', {
          value: '负责 Issue 分解、委派与交付验收。按项目约束完成任务并给出可验证证据。',
        })
        await control.command(
          'click',
          '[data-testid="wework-agent-resource-creator-advanced-toggle"]'
        )
        await control.command('click', '[data-testid="wework-agent-capability-mode-manual"]')
        await control.command('fill', '[data-testid="wework-agent-mcp"]', { value: '{}' })
        await control.command('clickWhenEnabled', '[data-testid="wework-agent-resource-create"]', {
          timeoutMs: uiTimeoutMs,
        })
        const projectAgent = await waitForApiValue(
          () => request(`/api/v1/cloud-projects/${project.id}/chat-agents`),
          response => response.find(candidate => candidate.name === PROJECT_AGENT_NAME) ?? null,
          'Creating a project-owned Agent did not persist',
          uiTimeoutMs
        )
        assert.ok(projectAgent.wegentTeamId, 'The project Agent must retain its Team binding')
        await assertSavedCloudRouting(request, projectAgent, defaultModel, { mode: 'project_pool' })
        assert.equal(projectAgent.canUse, true, 'A newly created Agent must be usable')
        const membersPath = `/api/share/Team/${projectAgent.wegentTeamId}/members`
        const members = await request(membersPath)
        const workspaceGrant = members.members.find(
          member => member.entity_type === 'workspace' && member.entity_id === String(workspace.id)
        )
        assert.ok(workspaceGrant, 'Agent creation must persist its space authorization')
        await control.command('waitFor', '[data-testid="wework-agent-resource-creator"]', {
          visible: false,
          timeoutMs: uiTimeoutMs,
        })
        await control.command(
          'clickWhenEnabled',
          scoped(`[data-testid="project-agent-archive-${projectAgent.id}"]`)
        )
        await control.command(
          'waitFor',
          scoped(`[data-testid="project-agent-reactivate-${projectAgent.id}"]`)
        )
        await request(`${membersPath}/${workspaceGrant.id}`, {
          method: 'PUT',
          body: JSON.stringify({ role: 'Reporter' }),
        })
        const unavailable = await request(
          `/api/v1/cloud-projects/${project.id}/chat-agents?include_archived=true`
        )
        assert.equal(unavailable.find(agent => agent.id === projectAgent.id)?.canUse, false)
        await control.command(
          'clickWhenEnabled',
          scoped(`[data-testid="project-agent-reactivate-${projectAgent.id}"]`)
        )
        await waitForApiValue(
          () => request(`/api/v1/cloud-projects/${project.id}/chat-agents`),
          agents => agents.find(agent => agent.id === projectAgent.id && agent.canUse),
          'Explicit Agent reauthorization did not restore project use',
          uiTimeoutMs
        )
        const restoredMembers = await request(membersPath)
        const restoredGrants = restoredMembers.members.filter(
          member => member.entity_type === 'workspace' && member.entity_id === String(workspace.id)
        )
        assert.equal(restoredGrants.length, 1, 'Reauthorization must update the existing grant')
        assert.equal(restoredGrants[0].id, workspaceGrant.id)
        assert.equal(restoredGrants[0].role, 'Developer')
        const localDevice = await waitForApiValue(
          () => request('/api/devices/online'),
          devices => devices.items.find(device => device.device_type === 'app') ?? null,
          'The real desktop executor must be registered',
          workbenchReadyTimeoutMs
        )
        const compiled = await request('/api/runtime-work/materialize', {
          method: 'POST',
          body: JSON.stringify({
            schemaVersion: 3,
            wegentTeamId: projectAgent.wegentTeamId,
            deviceId: localDevice.device_id,
            workspacePath: `/tmp/wework-project-agent-${process.pid}`,
            runtime: 'claude_code',
            message: 'Compile the assigned Agent without overriding its model',
            modelSelection: null,
          }),
        })
        assert.equal(
          compiled.payload.runtime,
          'codex',
          'The workbench default replaced the Team Shell'
        )
        assert.equal(compiled.payload.executionRequest.team_id, projectAgent.wegentTeamId)
        assert.equal(compiled.payload.executionRequest.bot[0].shell_type, 'Codex')
        assert.equal(compiled.payload.schemaVersion, 2)
        assert.equal(
          'modelConfig' in compiled.payload,
          false,
          'HTTP serialization added a forbidden modelConfig field to the Executor payload'
        )
        assert.ok(
          compiled.payload.executionRequest.model_config.model_id,
          'The assigned Team model was lost during local task materialization'
        )
        await control.command('waitFor', scoped('[data-testid^="project-agent-row-"]'), {
          text: PROJECT_AGENT_NAME,
          timeoutMs: uiTimeoutMs,
        })
        await control.command(
          'click',
          scoped('[data-testid="collaboration-project-settings-groups"]')
        )
        await control.command(
          'waitFor',
          scoped('[data-testid="collaboration-project-settings-groups"][aria-current="page"]'),
          { timeoutMs: uiTimeoutMs }
        )
        await control.command('click', scoped('[data-testid="collaboration-group-open-create"]'))
        await control.command('waitFor', scoped('[data-testid="collaboration-group-form"]'), {
          timeoutMs: uiTimeoutMs,
        })
        await control.command('fill', scoped('[data-testid="collaboration-group-name"]'), {
          value: PROJECT_GROUP_NAME,
        })
        await control.command(
          'click',
          scoped('[data-testid="collaboration-group-create-add-members"]')
        )
        const projectAgentMemberTestId = await waitForTestIdByText(
          control,
          ACTIVE_WORKBENCH_SELECTOR,
          'collaboration-group-create-member-agent-',
          PROJECT_AGENT_NAME,
          uiTimeoutMs
        )
        await control.command('click', `[data-testid="${projectAgentMemberTestId}"]`)
        await control.command('waitFor', scoped('.collaboration-group-selected-people'), {
          text: PROJECT_AGENT_NAME,
          timeoutMs: uiTimeoutMs,
        })
        await capture(control, 'project-automation-03-project-agent-created.png')
        await control.command(
          'clickWhenEnabled',
          scoped('[data-testid="collaboration-group-create"]'),
          { timeoutMs: uiTimeoutMs }
        )
        const projectGroup = await waitForApiValue(
          () => request(`/api/v1/cloud-projects/${project.id}/collaboration-groups`),
          response =>
            response.items?.find(candidate => candidate.name === PROJECT_GROUP_NAME) ?? null,
          'Creating a Project-owned collaboration group did not persist',
          uiTimeoutMs
        )
        assert.equal(projectGroup.owner_type, 'project')
        assert.equal(projectGroup.leader.kind, 'agent')
        assert.equal(projectGroup.leader.id, String(projectAgent.wegentTeamId))
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

        await control.command('click', scoped('[data-testid="collaboration-group-open-create"]'))
        await control.command('waitFor', scoped('[data-testid="collaboration-group-form"]'), {
          timeoutMs: uiTimeoutMs,
        })
        await createGroup(control, {
          name: DELETABLE_GROUP_NAME,
          leader: `human:${workspace.created_by_user_id}`,
        })
        const deletableGroup = await waitForApiValue(
          () => request(`/api/v1/cloud-projects/${project.id}/collaboration-groups`),
          response =>
            response.items?.find(candidate => candidate.name === DELETABLE_GROUP_NAME) ?? null,
          'Creating the deletable collaboration group did not persist',
          uiTimeoutMs
        )
        await control.command(
          'waitFor',
          scoped(`[data-testid="collaboration-group-detail-${deletableGroup.id}"]`),
          { text: DELETABLE_GROUP_NAME, timeoutMs: uiTimeoutMs }
        )
        await control.command('click', scoped('[data-testid="collaboration-group-detail-delete"]'))
        await capture(control, 'project-automation-06-group-delete-confirmation.png')
        await control.command(
          'clickWhenEnabled',
          scoped('[data-testid="collaboration-group-detail-delete-confirm"]'),
          { timeoutMs: uiTimeoutMs }
        )
        await waitForApiValue(
          () => request(`/api/v1/cloud-projects/${project.id}/collaboration-groups`),
          response => !response.items?.some(candidate => candidate.id === deletableGroup.id),
          'Deleting the collaboration group from its detail view did not persist',
          uiTimeoutMs
        )
        await control.command(
          'waitFor',
          scoped(`[data-testid="collaboration-group-${deletableGroup.id}"]`),
          { visible: false, timeoutMs: uiTimeoutMs }
        )
        await capture(control, 'project-automation-07-group-deleted.png')
        // A separate App reads the authorized HTTP catalog instead of local IPC.
        const catalogDeviceId = `catalog-recovery-app-${process.pid}`
        await cloudEnvironment.startGeneratedRemoteDevice({
          deviceId: catalogDeviceId,
          deviceName: 'Catalog recovery App',
          deviceType: 'app',
        })
        const catalogDevice = await cloudEnvironment.waitForDeviceType(catalogDeviceId, 'app')
        assert.notEqual(catalogDevice.id, localDevice.id)
        for (const resourcePath of [
          `/api/v1/workspaces/${workspace.id}`,
          `/api/v1/cloud-projects/${project.id}`,
        ]) {
          await request(`${resourcePath}/execution-environments`, {
            method: 'POST',
            body: JSON.stringify({ device_id: catalogDevice.id }),
          })
        }
        await verifyCloudSaveDuringNativeFaults(control, {
          projectId: project.id,
          device: catalogDevice,
          request,
          proxy,
          waitForApiValue,
          timeoutMs: uiTimeoutMs,
        })
        await verifyLocalBasicDefaultSave(control, uiTimeoutMs, proxy)
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
      try {
        await archiveFixture()
      } finally {
        await proxy?.stop()
      }
    },
    diagnostics: () => ({ catalogRequests: proxy?.requests }),
  }
}
