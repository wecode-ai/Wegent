import assert from 'node:assert/strict'
import { expandCollaborationWorkspace } from './workspace-flows.mjs'

export function createProjectOnlyNavigationRegression({ uiTimeoutMs }) {
  let backendUrl = ''
  let readerToken = ''
  let creatorToken = ''
  let workspace = null
  const projects = []
  const archivedProjectIds = new Set()
  let workspaceArchived = false

  async function request(token, pathname, options = {}, expectedStatus) {
    const response = await fetch(`${backendUrl}${pathname}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    })
    if (expectedStatus !== undefined) {
      assert.equal(response.status, expectedStatus, `${pathname} returned the wrong status`)
      return null
    }
    assert.ok(response.ok, `${pathname} failed with HTTP ${response.status}`)
    return response.status === 204 ? null : response.json()
  }

  return {
    async prepare(cloud, reader) {
      backendUrl = cloud.backendUrl
      readerToken = cloud.authToken
      const userName = `project-only-owner-${process.pid}`
      const password = 'project-only-navigation-e2e'
      await request(readerToken, '/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          user_name: userName,
          password,
          role: 'user',
          auth_source: 'password',
        }),
      })
      const login = await request(readerToken, '/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ user_name: userName, password }),
      })
      creatorToken = login.access_token
      workspace = await request(creatorToken, '/api/v1/workspaces', {
        method: 'POST',
        body: JSON.stringify({ name: `Project-only parent ${process.pid}` }),
      })
      for (const [name, visibility] of [
        ['Public reader', 'public'],
        ['Direct guest', 'private'],
        ['Hidden sibling', 'private'],
      ]) {
        projects.push(
          await request(creatorToken, `/api/v1/workspaces/${workspace.id}/projects`, {
            method: 'POST',
            body: JSON.stringify({ name: `${name} ${process.pid}`, visibility }),
          })
        )
      }
      await request(creatorToken, `/api/v1/cloud-projects/${projects[1].id}/members`, {
        method: 'POST',
        body: JSON.stringify({ user_id: reader.id, role: 'Developer' }),
      })
    },

    async verify(control, scoped) {
      const spaces = await request(readerToken, '/api/v1/workspaces')
      assert.ok(!spaces.items.some(item => item.id === workspace.id))
      const accessible = await request(readerToken, '/api/v1/cloud-projects')
      for (const [index, role] of ['Viewer', 'Developer'].entries()) {
        const project = accessible.items.find(item => item.id === projects[index].id)
        assert.ok(project, 'The project-only grant must appear in the authorized project list')
        assert.equal(project.access_role, role)
        assert.equal(project.workspace_context.id, workspace.id)
        assert.equal(project.workspace_access_role, null)
        assert.deepEqual(project.permission_sources, [
          index === 0 ? { type: 'public', role: 'Viewer' } : { type: 'direct', role },
        ])
        const environments = await request(
          readerToken,
          `/api/v1/cloud-projects/${project.id}/execution-environments`
        )
        assert.deepEqual(environments.items, [])
      }
      assert.ok(!accessible.items.some(item => item.id === projects[2].id))
      for (const suffix of ['', '/members', '/agents', '/execution-environments']) {
        await request(readerToken, `/api/v1/workspaces/${workspace.id}${suffix}`, {}, 404)
      }
      await request(readerToken, `/api/v1/cloud-projects/${projects[2].id}`, {}, 404)
      await request(
        readerToken,
        `/api/v1/cloud-projects/${projects[2].id}/execution-environments`,
        {},
        404
      )
      await request(
        readerToken,
        `/api/v1/cloud-projects/${projects[0].id}/loop-items`,
        { method: 'POST', body: JSON.stringify({ title: 'Public Viewer cannot create an Issue' }) },
        403
      )
      const tree = scoped(`[data-testid="collaboration-workspace-tree-${workspace.id}"]`)
      const assertParent = async () => {
        await control.command('waitFor', tree, { visible: true, timeoutMs: uiTimeoutMs })
        assert.equal(
          Number(
            await control.command(
              'getElementCount',
              `${tree} button.collaboration-workspace-identity`
            )
          ),
          0,
          'A project grant must not make the parent workspace openable'
        )
        assert.equal(
          Number(
            await control.command('getElementCount', `${tree} .collaboration-workspace-actions`)
          ),
          0,
          'A project grant must not expose parent workspace settings'
        )
        assert.equal(
          Number(
            await control.command(
              'getElementCount',
              scoped(`[data-testid="collaboration-workspace-project-${projects[2].id}"]`)
            )
          ),
          0,
          'The private sibling must remain hidden'
        )
      }
      await assertParent()
      for (const project of projects.slice(0, 2)) {
        await control.command(
          'clickWhenEnabled',
          scoped('[data-testid="collaboration-workspace-home-wework-local-workspace"]'),
          { timeoutMs: uiTimeoutMs }
        )
        await control.command(
          'waitFor',
          scoped('[data-testid="collaboration-workspace-nav-projects"][aria-current="page"]'),
          { timeoutMs: uiTimeoutMs }
        )
        await assertParent()
        await control.command(
          'click',
          scoped('[data-testid="collaboration-workspace-nav-projects"]')
        )
        await assertParent()
        await expandCollaborationWorkspace(
          control,
          scoped(`[data-testid="collaboration-workspace-toggle-${workspace.id}"]`),
          uiTimeoutMs
        )
        const projectSelector = scoped(
          `[data-testid="collaboration-workspace-project-${project.id}"]`
        )
        await control.command('waitFor', projectSelector, { visible: true, timeoutMs: uiTimeoutMs })
        await control.command('click', projectSelector)
        await control.command('waitFor', scoped('[data-testid="cloud-project-header"]'), {
          text: project.name,
          timeoutMs: uiTimeoutMs,
        })
        await assertParent()
      }
      await control.command('click', scoped('[data-testid="collaboration-primary-home"]'))
    },

    async cleanup() {
      for (const project of projects) {
        if (archivedProjectIds.has(project.id)) continue
        const latest = await request(creatorToken, `/api/v1/cloud-projects/${project.id}`)
        if (latest.status !== 'archived') {
          await request(
            creatorToken,
            `/api/v1/cloud-projects/${project.id}?version=${latest.version}`,
            { method: 'DELETE' },
            204
          )
        }
        archivedProjectIds.add(project.id)
      }
      if (workspace && !workspaceArchived) {
        const latest = await request(creatorToken, `/api/v1/workspaces/${workspace.id}`)
        if (latest.status !== 'archived') {
          await request(
            creatorToken,
            `/api/v1/workspaces/${workspace.id}?version=${latest.version}`,
            { method: 'DELETE' },
            204
          )
        }
        workspaceArchived = true
      }
    },
  }
}
