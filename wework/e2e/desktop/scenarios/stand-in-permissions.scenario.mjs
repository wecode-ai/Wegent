import assert from 'node:assert/strict'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { expandCollaborationWorkspace, reloadMainWindow } from '../modules/workspace-flows.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'

export function createDesktopScenario({ uiTimeoutMs, workbenchReadyTimeoutMs }) {
  let cloud
  let cloudEnvironment
  let user
  let ownerToken
  let workspace
  let project
  const rolesVerified = []

  async function request(token, path, method = 'GET', body, expectedStatus = 200) {
    const response = await fetch(`${cloud.backendUrl}/api${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(uiTimeoutMs),
    })
    assert.equal(
      response.status,
      expectedStatus,
      `${method} ${path}: ${await response.clone().text()}`
    )
    return response.status === 204 ? null : response.json()
  }

  const settingsParams = () => ({
    projectId: String(project.id),
    userId: user.id,
    projectStore: 'cloud',
  })
  const rpc = (control, method, params) => requestExecutor(control, method, params, uiTimeoutMs)
  const setRole = role =>
    request(ownerToken, `/v1/workspaces/${workspace.id}/members/${user.id}`, 'PATCH', { role })

  async function assertRole(role) {
    const list = await request(cloud.authToken, '/v1/cloud-projects')
    const listed = list.items.find(row => row.id === project.id)
    assert.ok(listed, 'Inherited membership must make the project visible')
    const detail = await request(cloud.authToken, `/v1/cloud-projects/${project.id}`)
    for (const result of [listed, detail]) {
      assert.equal(result.access_role, role)
      assert.equal(result.workspace_access_role, role)
      assert.deepEqual(result.permission_sources, [
        { type: 'workspace', workspace_id: workspace.id, role },
      ])
    }
    rolesVerified.push(role)
    return detail
  }

  async function openProject(control) {
    await control.command('clickWhenEnabled', '[data-testid="workspace-tab-select-fixed-board"]', {
      timeoutMs: workbenchReadyTimeoutMs,
    })
    await expandCollaborationWorkspace(
      control,
      `${CONTENT} [data-testid="collaboration-workspace-toggle-${workspace.id}"]`
    )
    await control.command(
      'click',
      `${CONTENT} [data-testid="collaboration-workspace-project-${project.id}"]`
    )
    await control.command('waitFor', `${CONTENT} [data-testid="collaboration-tab-board"]`)
    await control.command('click', `${CONTENT} [data-testid="collaboration-tab-board"]`)
    await control.command('waitFor', `${CONTENT} [data-testid="stand-in-open"]`)
  }

  return {
    requiresCloudEnvironment: true,
    async prepareCloud(environment) {
      cloud = environment
      await request(cloud.authToken, '/admin/setup-complete', 'POST', {})
      user = await request(cloud.authToken, '/users/me')
      const userName = `stand-in-owner-${process.pid}`
      const password = 'stand-in-permissions-e2e'
      await request(
        cloud.authToken,
        '/admin/users',
        'POST',
        {
          user_name: userName,
          password,
          role: 'user',
          auth_source: 'password',
        },
        201
      )
      const login = await request(cloud.authToken, '/auth/login', 'POST', {
        user_name: userName,
        password,
      })
      ownerToken = login.access_token
      workspace = await request(
        ownerToken,
        '/v1/workspaces',
        'POST',
        {
          name: `替身继承权限 ${process.pid}`,
        },
        201
      )
      project = await request(
        ownerToken,
        `/v1/workspaces/${workspace.id}/projects`,
        'POST',
        {
          name: `替身继承权限项目 ${process.pid}`,
        },
        201
      )
      await request(
        ownerToken,
        `/v1/workspaces/${workspace.id}/members`,
        'POST',
        {
          user_id: user.id,
          role: 'Maintainer',
        },
        201
      )
    },
    setCloudEnvironment(environment) {
      cloudEnvironment = environment
    },
    async verify(control) {
      const desktop = await cloudEnvironment.waitForConnectedAppDevice()
      await request(
        cloud.authToken,
        `/v1/workspaces/${workspace.id}/execution-environments`,
        'POST',
        {
          device_id: desktop.id,
        },
        201
      )
      await request(
        cloud.authToken,
        `/v1/cloud-projects/${project.id}/execution-environments`,
        'POST',
        {
          device_id: desktop.id,
        },
        201
      )
      await ensureExperimentalFeaturesEnabled(control)
      for (const role of ['Maintainer', 'Developer']) {
        await setRole(role)
        await assertRole(role)
        await reloadMainWindow(control, 'Inherited Stand-in permissions did not refresh')
        await openProject(control)
        await control.command('click', `${CONTENT} [data-testid="stand-in-open"]`)
        await control.command('clickWhenEnabled', '[data-testid="stand-in-auto"]')
        await control.command('waitFor', '[data-testid="stand-in-prompt"]')
        await control.command('fill', '[data-testid="stand-in-prompt"]', {
          value: `以 ${role} 继承权限处理新分配给我的任务`,
        })
        await control.command('clickWhenEnabled', '[data-testid="stand-in-save"]')
        await control.command('waitFor', '[data-testid="stand-in-settings"]', { visible: false })
        const saved = await rpc(control, 'runtime.stand_in.get', settingsParams())
        assert.equal(saved.enabled, true)
        assert.ok(saved.prompt.includes(role))
        await rpc(control, 'runtime.stand_in.save', {
          ...settingsParams(),
          settings: { ...saved, enabled: false },
        })
      }

      const executionProbe = await request(
        cloud.authToken,
        `/v1/cloud-projects/${project.id}/loop-items`,
        'POST',
        { title: 'Personal task execute permission', assignee_user_id: user.id },
        201
      )
      await setRole('Viewer')
      await assertRole('Viewer')
      const disabled = await rpc(control, 'runtime.stand_in.get', settingsParams())
      const saved = await rpc(control, 'runtime.stand_in.save', {
        ...settingsParams(),
        settings: { ...disabled, enabled: true },
      })
      assert.equal(saved.enabled, true, 'Personal configuration saves do not execute an Issue')
      await assert.rejects(
        rpc(control, 'runtime.stand_in.run', {
          ...settingsParams(),
          issueId: executionProbe.id,
        }),
        /403/
      )
      await rpc(control, 'runtime.stand_in.save', {
        ...settingsParams(),
        settings: { ...saved, enabled: false },
      })
      await reloadMainWindow(control, 'Viewer permissions did not refresh')
      await openProject(control)
      await control.command('click', `${CONTENT} [data-testid="stand-in-open"]`)
      await control.command('waitFor', '[data-testid="stand-in-auto"]:not([disabled])')
      await control.command('click', `${CONTENT} [data-testid="stand-in-open"]`)

      // Restricted projects stop ordinary inheritance, and restoring it restores access.
      await setRole('Developer')
      let latest = await request(ownerToken, `/v1/cloud-projects/${project.id}`)
      await request(ownerToken, `/v1/cloud-projects/${project.id}`, 'PATCH', {
        version: latest.version,
        membership_mode: 'restricted',
      })
      await request(cloud.authToken, `/v1/cloud-projects/${project.id}`, 'GET', undefined, 404)
      latest = await request(ownerToken, `/v1/cloud-projects/${project.id}`)
      await request(ownerToken, `/v1/cloud-projects/${project.id}`, 'PATCH', {
        version: latest.version,
        membership_mode: 'inherit',
      })
      await assertRole('Developer')
    },
    diagnostics() {
      return { projectId: project?.id, rolesVerified }
    },
  }
}
