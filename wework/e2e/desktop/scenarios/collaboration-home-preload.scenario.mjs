import assert from 'node:assert/strict'
import { TransportFaultProxy } from '../modules/transport-fault-proxy.mjs'
import { waitForBoardValue } from '../modules/collaboration-board-flows.mjs'
import {
  inCollaborationSidebar,
  revealCollaborationSidebarElement,
} from '../modules/workspace-flows.mjs'

// Delay only delivery of an actual Backend snapshot. No API payload is mocked.
export function createDesktopScenario({ uiTimeoutMs }) {
  const appEnvironment = {}
  let cloud, proxy, project, blockedProject, issue, assignee
  const snapshotPath = () => `/api/v1/cloud-projects/${project.id}/board-snapshot`
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(`${cloud.backendUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${cloud.authToken}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${await response.clone().text()}`)
    return response.json()
  }
  const wait = (load, expected, message) => waitForBoardValue(load, expected, message, uiTimeoutMs)
  return {
    requiresCloudEnvironment: true,
    appEnvironment,
    async prepareCloud(environment) {
      cloud = environment
      await request('/api/admin/setup-complete', 'POST')
      proxy = await new TransportFaultProxy(cloud.backendUrl).start()
      appEnvironment.WEWORK_E2E_CLOUD_BACKEND_URL = proxy.url
      const workspace = await request('/api/v1/workspaces', 'POST', {
        name: `Preload race ${process.pid}`,
      })
      project = await request('/api/v1/cloud-projects', 'POST', {
        workspace_id: workspace.id,
        name: `Preload race ${process.pid}`,
        task_provider: 'local',
        visibility: 'private',
      })
      blockedProject = await request('/api/v1/cloud-projects', 'POST', {
        workspace_id: workspace.id,
        name: `Slow preload ${process.pid}`,
        task_provider: 'local',
        visibility: 'private',
      })
      assignee = await request('/api/admin/users', 'POST', {
        user_name: `preload-assignee-${process.pid}`,
        password: 'preload-e2e-only',
        role: 'user',
        auth_source: 'password',
      })
      for (const path of [
        `/api/v1/workspaces/${workspace.id}/members`,
        `/api/v1/cloud-projects/${project.id}/members`,
      ]) {
        await request(path, 'POST', { user_id: assignee.id, role: 'Developer' })
      }
      issue = await request(`/api/v1/cloud-projects/${project.id}/loop-items`, 'POST', {
        title: `Preload assignment ${process.pid}`,
        status: 'pending',
        priority: 'none',
      })
    },
    async verify(control) {
      let armed = true
      proxy.rule = entry => {
        if (armed && entry.method === 'GET' && entry.path === '/api/v1/cloud-work-items/my-work') {
          armed = false
          return 'hold-response'
        }
        return null
      }
      // Hold the batched personal-work page while the sidebar independently opens A.
      // Releasing that old page must not replace the project's newer assignment.
      await control.command('clickWhenEnabled', '[data-testid="workspace-tab-select-fixed-board"]')
      await control.command(
        'clickWhenEnabled',
        inCollaborationSidebar('[data-testid="collaboration-primary-home"]')
      )
      await control.command('waitFor', '[data-testid="personal-home"]', {
        timeoutMs: uiTimeoutMs,
      })
      await wait(
        () => proxy.requests.some(entry => entry.committedResponseHeld),
        true,
        'Home preload did not reach the real Backend'
      )
      const held = proxy.requests.find(entry => entry.committedResponseHeld)
      assert.equal(held.status, 200)
      const projectEntry = inCollaborationSidebar(
        `[data-testid="collaboration-workspace-project-${project.id}"]`
      )
      await revealCollaborationSidebarElement(control, projectEntry)
      await control.command('clickWhenEnabled', projectEntry)
      // Selecting a cloud project transitions from the personal-work host to
      // the project host. Assert the observable late-response contract across
      // that real navigation rather than assuming both hosts share an instance.
      await control.command('waitFor', `[data-testid="cloud-todo-card-${issue.id}"]`, {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', `[data-testid="cloud-todo-card-${issue.id}"]`)
      await control.command('waitFor', '[data-testid="cloud-todo-detail-assignee"]', {
        timeoutMs: uiTimeoutMs,
      })
      const refreshStart = proxy.requests.length
      await control.command('click', '[data-testid="cloud-todo-detail-assignee"]')
      await control.command(
        'clickWhenEnabled',
        `[data-testid="cloud-todo-detail-assignee-option-user:${assignee.id}"]`
      )
      await wait(
        async () => (await request(`/api/v1/loop-items/${issue.id}`)).assignee_user_id,
        assignee.id,
        'New assignee was not persisted'
      )
      await wait(
        () =>
          proxy.requests
            .slice(refreshStart)
            .some(entry => entry.path === snapshotPath() && entry.delivered),
        true,
        'Assignment refresh did not finish before home preload'
      )
      assert.equal(held.released, undefined)
      await held.release()
      await control.command(
        'waitFor',
        `[data-testid="cloud-todo-detail-assignee"][data-value="user:${assignee.id}"]`,
        {
          stableMs: 1000,
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command('waitFor', `[data-testid="cloud-todo-card-assignee-${issue.id}"]`, {
        text: assignee.user_name,
        stableMs: 1000,
        timeoutMs: uiTimeoutMs,
      })
      assert.equal((await request(`/api/v1/loop-items/${issue.id}`)).assignee_user_id, assignee.id)
    },
    diagnostics: () => ({ projectId: project?.id, requests: proxy?.requests }),
    async cleanup() {
      await proxy?.stop()
    },
  }
}
