import assert from 'node:assert/strict'
import { verifyIssueTranscriptTransfer } from '../modules/issue-transcript-transfer.mjs'
import { TransportFaultProxy } from '../modules/transport-fault-proxy.mjs'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { waitForSnapshot } from '../modules/conversation-layout.mjs'
import {
  reloadMainWindow,
  selectCollaborationProjectView,
  selectCollaborationDomain,
  waitForWorkbenchDebugState,
} from '../modules/workspace-flows.mjs'
import { createSingleRootLocalProject, selectE2EModel } from '../modules/shared.mjs'
import {
  assistantMessage,
  createSse,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const TITLE = `Issue AI assistance ${process.pid}`
const OTHER_APP_ID = `issue-other-app-${process.pid}`
const COMPLETION = 'ISSUE_APP_RECORD_COMPLETE'
const scoped = selector => `${CONTENT} ${selector}`

export function createDesktopScenario({
  workbenchReadyTimeoutMs,
  modelResponseTimeoutMs,
  workspacePath,
  captureScreenshot,
  codexSqliteHome,
}) {
  let cloud
  let proxy
  let environment
  let workspace
  let currentApp
  let localProjectCreated = false
  const fixtures = []
  const modelRequests = []
  const appEnvironment = {}
  const request = async (path, values, method = values ? 'POST' : 'GET') => {
    const response = await fetch(`${cloud.backendUrl}${path}`, {
      method,
      ...(values ? { body: JSON.stringify(values) } : {}),
      headers: { Authorization: `Bearer ${cloud.authToken}`, 'Content-Type': 'application/json' },
    })
    const body = await response.json()
    assert.equal(response.ok, true, `${path}: ${JSON.stringify(body)}`)
    return body
  }
  async function addWorkspaceEnvironment(device) {
    await request(`/api/v1/workspaces/${workspace.id}/execution-environments`, {
      device_id: device.id,
    })
  }
  async function prepareIssue(device, label, owner) {
    let project = await request('/api/v1/cloud-projects', {
      name: label,
      workspace_id: workspace.id,
    })
    await request(`/api/v1/cloud-projects/${project.id}/execution-environments`, {
      device_id: device.id,
    })
    project = await request(`/api/v1/cloud-projects/${project.id}`)
    project = await request(
      `/api/v1/cloud-projects/${project.id}/execution-environment/initialize`,
      { device_id: device.id, version: project.version }
    )
    assert.equal(project.execution_environment.devices[device.execution_target_id].status, 'ready')
    const issue = await request(`/api/v1/cloud-projects/${project.id}/loop-items`, { title: label })
    const assigned = await request(`/api/v1/loop-items/${issue.id}/assignments`, {
      target_type: 'human',
      target_id: String(owner.id),
      notify_target: false,
    })
    const started = await request(
      `/api/v1/loop-items/${issue.id}`,
      { version: assigned.issue.version, status: 'in_progress' },
      'PATCH'
    )
    assert.equal(started.status, 'in_progress')
    assert.equal(started.human_task_binding.assignmentId, assigned.assignment.id)
    const fixture = { project, issue, device }
    fixtures.push(fixture)
    return fixture
  }
  async function runAssistance(control, fixture) {
    const { project, issue, device } = fixture
    await control.command(
      'click',
      scoped(`[data-testid="collaboration-workspace-project-${project.id}"]`)
    )
    await control.command('waitFor', scoped('[data-testid="cloud-project-header-title"]'), {
      text: project.name,
    })
    // Await the real catalog before sending; elapsed startup time cannot hide this regression.
    await control.command('click', scoped('[data-testid="collaboration-tab-manage"]'))
    await control.command(
      'click',
      scoped('[data-testid="collaboration-project-settings-environments"]')
    )
    await control.command(
      'waitFor',
      scoped(`[data-testid="collaboration-project-execution-environment-${device.id}"]`)
    )
    await selectCollaborationProjectView(control, CONTENT, 'board')
    await control.command('clickWhenEnabled', scoped(`[data-testid="cloud-todo-card-${issue.id}"]`))
    await control.command(
      'clickWhenEnabled',
      scoped('[data-testid="cloud-todo-personal-task-start"]')
    )
    const panel = scoped('[data-testid="work-item-new-task-chat-panel"]')
    const composer = `${panel} [data-testid="chat-message-input"]`
    await control.command('waitFor', composer)
    await control.command('press', composer, { key: 'Enter' })
    await control.command(
      'waitFor',
      scoped('[data-testid="ai-chat-modal"] [data-testid="message-assistant"]'),
      {
        text: COMPLETION,
        timeoutMs: modelResponseTimeoutMs,
      }
    )
    assert.doesNotMatch(
      await control.command('getText', scoped('[data-testid="ai-chat-modal"]')),
      /executor-not-found:|ambiguous-executor-identity:/
    )
    const bindings = await request(`/api/v1/loop-items/${issue.id}/tasks`)
    assert.equal(bindings.length, 1, 'AI assistance must create exactly one bound task')
    const boundDeviceId = bindings[0].device_id ?? bindings[0].deviceId
    assert.ok(boundDeviceId, 'The task binding must expose its device identity')
    assert.equal(
      boundDeviceId,
      currentApp.app_device_id ?? currentApp.device_id,
      'Human AI assistance must run on the current computer, regardless of the project environment'
    )
    assert.equal(
      (await request(`/api/v1/loop-items/${issue.id}`)).status,
      'in_progress',
      'AI assistance must not submit or accept the human Issue'
    )
    await control.command('click', scoped('[data-testid="ai-chat-modal-close"]'))
    await control.command('click', scoped('[data-testid="cloud-todo-detail-close"]'))
    return bindings[0]
  }
  async function runLocalTask(control) {
    await control.command('click', '[data-testid="workspace-tab-select-fixed-task"]')
    if (!localProjectCreated) {
      await createSingleRootLocalProject(control, workspacePath, 'duplicate-app-local-task')
      localProjectCreated = true
    } else {
      await control.command('markElementWithText', '[data-testid^="project-row-"]', {
        text: 'duplicate-app-local-task',
        value: 'duplicate-app-project',
      })
      const project = '[data-e2e-anchor-id="duplicate-app-project"]'
      await control.command('hover', project)
      await control.command('click', `${project} [data-testid="project-new-conversation-button"]`)
    }
    const pane = '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
    const composer = `${pane} [data-testid="chat-message-input"][contenteditable="true"]`
    await control.command('waitFor', composer)
    await control.command('click', `${pane} [data-testid="execution-mode-button"]`)
    await control.command(
      'clickWhenEnabled',
      '[data-testid="execution-mode-current-workspace-button"]'
    )
    await selectE2EModel(control)
    await control.command('fill', composer, { value: 'LOCAL_DUPLICATE_APP_IDENTITY' })
    await control.command('press', composer, { key: 'Enter' })
    const result = await waitForSnapshot(
      control,
      snapshot =>
        /executor-not-found:|ambiguous-executor-identity:/.test(snapshot.text) ||
        snapshot.text.includes(COMPLETION),
      'The local task did not complete after refreshing App registrations',
      modelResponseTimeoutMs,
      pane
    )
    await captureScreenshot(
      control,
      `duplicate-app-local-task-${fixtures.length ? 'conflict' : 'registered'}.png`,
      pane
    )
    assert.doesNotMatch(result.text, /executor-not-found:|ambiguous-executor-identity:/)
    assert.ok(result.testIds.includes('message-assistant'))
  }
  async function waitForCurrentRegistration(control) {
    await reloadMainWindow(control, 'The registered runtime did not reload the workbench')
    await waitForWorkbenchDebugState(
      control,
      snapshot =>
        snapshot.workbench?.cloudWorkStatus?.checks?.devices === 'available' &&
        snapshot.workbench?.devices?.some(
          device =>
            device.device_type === 'local' &&
            device.runtime_instance_id === currentApp.runtime_instance_id
        ),
      'The registered local runtime did not refresh the real cloud device catalog',
      workbenchReadyTimeoutMs
    )
  }
  async function openIssueWorkspace(control) {
    await ensureExperimentalFeaturesEnabled(control)
    await reloadMainWindow(
      control,
      'The workbench did not reload after enabling experimental features'
    )
    await control.command('clickWhenEnabled', '[data-testid="workspace-tab-select-fixed-board"]', {
      timeoutMs: workbenchReadyTimeoutMs,
    })
    await selectCollaborationDomain(control, CONTENT, 'cloud')
    await control.command(
      'waitFor',
      scoped(
        `[data-testid="collaboration-workspace-tree-${workspace.id}"] .collaboration-workspace-identity`
      ),
      { timeoutMs: workbenchReadyTimeoutMs }
    )
    await control.command(
      'click',
      scoped(
        `[data-testid="collaboration-workspace-tree-${workspace.id}"] .collaboration-workspace-identity`
      )
    )
  }
  return {
    requiresCloudEnvironment: true,
    appEnvironment,
    async prepareCloud(value) {
      cloud = value
      proxy = await new TransportFaultProxy(cloud.backendUrl).start()
      appEnvironment.WEWORK_E2E_CLOUD_BACKEND_URL = proxy.url
      await request('/api/admin/setup-complete', {})
      workspace = await request('/api/v1/workspaces', { name: TITLE })
    },
    setCloudEnvironment(value) {
      environment = value
    },
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      modelRequests.push(body)
      const id = `issue-app-record-${modelRequests.length}`
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(
        createSse([responseCreated(id), assistantMessage(COMPLETION), responseCompleted(id)])
      )
      return true
    },
    async verify(control) {
      const localApp = await environment.waitForConnectedAppDevice()
      currentApp = localApp
      console.log('[executor-identity] Registered local Executor; refreshing the cloud catalog')
      await waitForCurrentRegistration(control)
      await runLocalTask(control)
      // Large-history transport needs one unambiguous device; identity conflicts are tested below.
      const owner = await request('/api/users/me')
      await addWorkspaceEnvironment(localApp)
      const history = await prepareIssue(localApp, `${TITLE} large history`, owner)
      await openIssueWorkspace(control)
      const binding = await runAssistance(control, history)
      await verifyIssueTranscriptTransfer({
        control,
        request,
        fixture: history,
        binding,
        codexSqliteHome,
        timeoutMs: workbenchReadyTimeoutMs,
        scope: scoped,
        proxy,
      })
      console.log(
        '[executor-identity] Local task completed; registering a conflicting installation'
      )
      await environment.startDuplicateAppDeviceIdentity()
      await environment.startGeneratedRemoteDevice({
        deviceId: OTHER_APP_ID,
        deviceName: 'Other Wework installation',
        deviceType: 'app',
      })
      const otherApp = await environment.waitForDeviceType(OTHER_APP_ID, 'app')
      assert.notEqual(otherApp.runtime_instance_id, localApp.runtime_instance_id)
      assert.match(otherApp.execution_target_id, /^app-record-\d+$/)
      await addWorkspaceEnvironment(otherApp)
      const local = await prepareIssue(localApp, `${TITLE} local`, owner)
      const other = await prepareIssue(otherApp, `${TITLE} other`, owner)
      console.log(
        '[executor-identity] Independent App registrations ready; sending another local task'
      )
      await waitForCurrentRegistration(control)
      await runLocalTask(control)
      console.log(
        '[executor-identity] Local task completed with duplicate addresses; checking Issue assistance'
      )
      await openIssueWorkspace(control)
      await runAssistance(control, local)
      await runAssistance(control, other)
    },
    diagnostics() {
      return {
        currentApp: currentApp && {
          deviceId: currentApp.device_id,
          runtimeInstanceId: currentApp.runtime_instance_id,
          executionTarget: currentApp.execution_target_id,
        },
        fixtures: fixtures.map(({ issue, device }) => ({
          issueId: issue.id,
          executionTarget: device.execution_target_id,
        })),
        modelRequestCount: modelRequests.length,
        transportRequests: proxy?.requests,
      }
    },
    async cleanup() {
      await proxy?.stop()
    },
  }
}
