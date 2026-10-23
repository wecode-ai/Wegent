import { openProjectStandIn } from '../modules/stand-in-flows.mjs'
import assert from 'node:assert/strict'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  expandCollaborationWorkspace,
  selectCollaborationDomain,
} from '../modules/workspace-flows.mjs'
import {
  assistantMessage,
  createSse,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const COMPLETE = 'PERSONAL_STAND_IN_COMPLETE'
const scoped = id => `${CONTENT} [data-testid="${id}"]`

export function createDesktopScenario({ uiTimeoutMs, modelResponseTimeoutMs }) {
  let cloud
  let environment
  let ownerToken
  let user
  let workspace
  let project
  let manualIssue
  let currentDevice
  const completed = []
  let savedSettings
  let assignmentDiagnostics

  async function request(path, body, token = cloud.authToken, method = body ? 'POST' : 'GET') {
    const response = await fetch(`${cloud.backendUrl}/api${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(uiTimeoutMs),
    })
    const text = await response.text()
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${text}`)
    return text ? JSON.parse(text) : null
  }

  async function assertCompleted(control, issue) {
    const deadline = Date.now() + modelResponseTimeoutMs
    let bindings
    while (Date.now() < deadline) {
      bindings = await request(`/v1/loop-items/${issue.id}/tasks`)
      assert.ok(bindings.length <= 1, 'One Issue must not create duplicate personal tasks')
      if (bindings[0]) {
        assert.equal(bindings[0].device_id, currentDevice)
        const result = await requestExecutor(
          control,
          'runtime.tasks.get',
          {
            taskId: bindings[0].task_id,
          },
          uiTimeoutMs
        )
        assert.notEqual(result.task?.status, 'failed', JSON.stringify(result))
        if (result.task?.status === 'done') {
          completed.push(issue.id)
          return bindings[0]
        }
      }
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    assignmentDiagnostics = await request(`/v1/loop-items/${issue.id}/assignments`)
    assert.fail(
      `Personal task did not complete: ${JSON.stringify({ bindings, assignments: assignmentDiagnostics, enabledAfter: savedSettings?.enabledAfter })}`
    )
  }

  return {
    requiresCloudEnvironment: true,
    async prepareCloud(value) {
      cloud = value
      await request('/admin/setup-complete', {})
      user = await request('/users/me')
      const userName = `stand-in-project-owner-${process.pid}`
      const password = 'stand-in-personal-task-e2e'
      await request('/admin/users', {
        user_name: userName,
        password,
        role: 'admin',
        auth_source: 'password',
      })
      ownerToken = (await request('/auth/login', { user_name: userName, password })).access_token
      workspace = await request(
        '/v1/workspaces',
        { name: `Personal stand-in ${process.pid}` },
        ownerToken
      )
      project = await request(
        `/v1/workspaces/${workspace.id}/projects`,
        {
          name: `No environment setup ${process.pid}`,
        },
        ownerToken
      )
      await request(
        `/v1/workspaces/${workspace.id}/members`,
        { user_id: user.id, role: 'Developer' },
        ownerToken
      )
      manualIssue = await request(`/v1/cloud-projects/${project.id}/loop-items`, {
        title: 'Manual personal task without project preparation',
      })
    },
    setCloudEnvironment(value) {
      environment = value
    },
    async handleHttp(req, response, url) {
      if (req.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      await readRequestBody(req)
      const id = `personal-stand-in-${Date.now()}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(
        createSse([responseCreated(id), assistantMessage(COMPLETE), responseCompleted(id)])
      )
      return true
    },
    async verify(control) {
      const desktop = await environment.waitForConnectedAppDevice()
      currentDevice = desktop.app_device_id ?? desktop.device_id
      // A real ordinary member, with no project device binding or initialized environment.
      await request(`/admin/users/${user.id}/role`, { role: 'user' }, ownerToken, 'PUT')
      assert.equal((await request('/users/me')).role, 'user')
      assert.equal((await request(`/v1/cloud-projects/${project.id}`)).access_role, 'Developer')
      assert.deepEqual(
        (await request(`/v1/cloud-projects/${project.id}/execution-environments`)).items,
        []
      )
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await selectCollaborationDomain(control, CONTENT, 'cloud')
      await expandCollaborationWorkspace(
        control,
        scoped(`collaboration-workspace-toggle-${workspace.id}`)
      )
      await control.command('click', scoped(`collaboration-workspace-project-${project.id}`))
      await control.command('clickWhenEnabled', scoped('collaboration-tab-board'))
      await control.command('clickWhenEnabled', scoped(`cloud-todo-card-${manualIssue.id}`))
      await control.command('clickWhenEnabled', scoped('cloud-todo-personal-task-start'))
      const composer = `${scoped('work-item-new-task-chat-panel')} [data-testid="chat-message-input"]`
      await control.command('waitFor', composer)
      await control.command('press', composer, { key: 'Enter' })
      await control.command(
        'waitFor',
        `${scoped('ai-chat-modal')} [data-testid="message-assistant"]`,
        {
          text: COMPLETE,
          timeoutMs: modelResponseTimeoutMs,
        }
      )
      await assertCompleted(control, manualIssue)
      await control.command('click', scoped('ai-chat-modal-close'))
      await control.command('click', scoped('cloud-todo-detail-close'))
      await openProjectStandIn(control, scoped('stand-in-open'), { connect: true })
      await control.command('clickWhenEnabled', '[data-testid="stand-in-auto"]')
      await control.command('fill', '[data-testid="stand-in-prompt"]', {
        value: 'Handle my assignments locally',
      })
      await control.command('clickWhenEnabled', '[data-testid="stand-in-save"]')
      await control.command('waitFor', '[data-testid="stand-in-settings"]', { visible: false })
      const params = { projectId: String(project.id), userId: user.id, projectStore: 'cloud' }
      const settings = await requestExecutor(control, 'runtime.stand_in.get', params, uiTimeoutMs)
      savedSettings = settings
      assert.equal(settings.enabled, true)
      const issue = await request(`/v1/cloud-projects/${project.id}/loop-items`, {
        title: 'Stand-in personal task without project preparation',
        assignee_user_id: user.id,
      })
      await assertCompleted(control, issue)
      assert.deepEqual(
        (await request(`/v1/cloud-projects/${project.id}/execution-environments`)).items,
        []
      )
      await requestExecutor(
        control,
        'runtime.stand_in.save',
        {
          ...params,
          settings: { ...settings, enabled: false },
        },
        uiTimeoutMs
      )
    },
    diagnostics() {
      return { projectId: project?.id, completed, savedSettings, assignmentDiagnostics }
    },
  }
}
