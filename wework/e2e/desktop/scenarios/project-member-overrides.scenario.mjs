import assert from 'node:assert/strict'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  expandCollaborationWorkspace,
  inCollaborationSidebar,
  selectCollaborationDomain,
} from '../modules/workspace-flows.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const PROJECT_NAME = '项目角色覆盖验收'
const CAPABILITY = '负责项目权限验收'
const scoped = selector => `${CONTENT} ${selector}`
const patch = values => ({ method: 'PATCH', body: JSON.stringify(values) })
const post = values => ({ method: 'POST', body: JSON.stringify(values) })

async function requestJson(baseUrl, token, pathname, options = {}, expectedStatus) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
  })
  const text = await response.text()
  const message = `${options.method ?? 'GET'} ${pathname}: HTTP ${response.status}: ${text}`
  if (expectedStatus !== undefined) assert.equal(response.status, expectedStatus, message)
  else assert.equal(response.ok, true, message)
  return text ? JSON.parse(text) : null
}

async function waitForValue(read, predicate, message, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let latest = null
  while (Date.now() < deadline) {
    latest = await read()
    if (predicate(latest)) return latest
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`${message}: ${JSON.stringify(latest)}`)
}

export function createDesktopScenario({ captureScreenshot, uiTimeoutMs, workbenchReadyTimeoutMs }) {
  let backendUrl = ''
  let ownerToken = ''
  let owner = null
  let member = null
  let administrator = null
  let guest = null
  let workspace = null
  let project = null
  let sibling = null
  let issue = null
  let manager = null
  let restartDesktopApp = null
  const archivedProjectIds = new Set()
  let workspaceArchived = false
  const verifiedCases = []

  const request = (user, pathname, options, status) =>
    requestJson(backendUrl, user.token, pathname, options, status)
  const ownerRequest = (pathname, options, status) =>
    requestJson(backendUrl, ownerToken, pathname, options, status)
  const projectPath = () => `/api/v1/cloud-projects/${project.id}`
  const memberPath = user => `${projectPath()}/members/${user.id}`
  const memberControl = (part, user = member) =>
    scoped(`[data-testid="cloud-project-member-${part}-${user.id}"]`)

  async function createUser(name) {
    const password = `${name}-password`
    const user = await ownerRequest(
      '/api/admin/users',
      post({ user_name: name, password, role: 'user', auth_source: 'password' })
    )
    const login = await ownerRequest('/api/auth/login', post({ user_name: name, password }))
    return { ...user, token: login.access_token }
  }

  async function roster() {
    const rows = await ownerRequest(`${projectPath()}/members`)
    assert.equal(new Set(rows.map(row => row.user_id)).size, rows.length)
    return rows
  }

  async function assertRole(user, effectiveRole, directRole, inheritedRole = 'Developer') {
    const rows = await roster()
    const row = rows.find(candidate => candidate.user_id === user.id)
    assert.ok(row, 'The effective project member disappeared')
    assert.equal(row.role, effectiveRole)
    assert.equal(row.direct_role, directRole)
    assert.equal(row.inherited_role, inheritedRole)
    assert.equal(row.can_be_assignee, effectiveRole !== 'Viewer')
    const sources = [
      ...(inheritedRole
        ? [{ type: 'workspace', role: inheritedRole, workspace_id: workspace.id }]
        : []),
      ...(directRole ? [{ type: 'direct', role: directRole }] : []),
    ]
    assert.deepEqual(row.permission_sources, sources)
    const detail = await request(user, projectPath())
    const list = await request(user, '/api/v1/cloud-projects')
    assert.equal(detail.current_user_id, user.id)
    assert.equal(detail.access_role, effectiveRole)
    assert.deepEqual(detail.permission_sources, sources)
    assert.equal(
      list.items.find(candidate => candidate.id === project.id)?.access_role,
      effectiveRole
    )
    if (inheritedRole) {
      const spaceProjects = await request(user, `/api/v1/workspaces/${workspace.id}/projects`)
      assert.equal(
        spaceProjects.items.find(candidate => candidate.id === project.id)?.access_role,
        effectiveRole
      )
    }
    return row
  }

  async function waitForRole(role, directRole) {
    await waitForValue(
      roster,
      rows =>
        rows.some(
          row => row.user_id === member.id && row.role === role && row.direct_role === directRole
        ),
      `The project role was not persisted as ${role}`,
      uiTimeoutMs
    )
    return assertRole(member, role, directRole)
  }

  async function openProject(control) {
    await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
      timeoutMs: workbenchReadyTimeoutMs,
    })
    await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
    await selectCollaborationDomain(control, CONTENT, 'cloud')
    await expandCollaborationWorkspace(
      control,
      inCollaborationSidebar(`[data-testid="collaboration-workspace-toggle-${workspace.id}"]`)
    )
    const projectSelector = inCollaborationSidebar(
      `[data-testid="collaboration-workspace-project-${project.id}"]`
    )
    await control.command('waitFor', projectSelector, { visible: true })
    await control.command('click', projectSelector)
    await control.command('waitFor', scoped('[data-testid="cloud-project-header-title"]'), {
      text: PROJECT_NAME,
    })
  }

  async function openMembers(control) {
    await openProject(control)
    await control.command('click', scoped('[data-testid="collaboration-tab-manage"]'))
    await control.command('click', scoped('[data-testid="collaboration-project-settings-members"]'))
    await control.command('waitFor', memberControl('role'))
  }

  async function assertUiRole(control, role, direct) {
    await waitForValue(
      () => control.command('getValue', memberControl('role')),
      value => value === role,
      `The member role control did not display ${role}`,
      uiTimeoutMs
    )
    assert.equal(
      Number(await control.command('getElementCount', memberControl('remove'))),
      direct ? 1 : 0
    )
    await control.command('waitFor', memberControl('effective-role'), {
      text: { Maintainer: '管理员', Developer: '成员', Viewer: '只读成员' }[role],
    })
    await control.command('waitFor', memberControl('source'), { text: '继承自' })
    for (const user of [owner, administrator]) {
      for (const action of ['role', 'remove']) {
        assert.equal(
          Number(await control.command('getElementCount', memberControl(action, user))),
          0,
          'A pure inherited space administrator must retain the protected administration floor'
        )
      }
    }
  }

  async function reload(control) {
    const readyCount = control.readyCount
    await control.command('reloadMainWindow', 'body')
    let timeout
    try {
      await Promise.race([
        control.awaitReadyAfter(readyCount),
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('The permission checkpoint did not reconnect')),
            workbenchReadyTimeoutMs
          )
        }),
      ])
    } finally {
      clearTimeout(timeout)
    }
  }

  async function switchAccount(control, user) {
    assert.ok(restartDesktopApp, 'The runner did not attach its real Electron restart hook')
    await restartDesktopApp({ appEnvironmentOverrides: { WEWORK_E2E_CLOUD_TOKEN: user.token } })
    await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
      timeoutMs: workbenchReadyTimeoutMs,
    })
  }

  async function assertCannotManage(user) {
    await request(user, memberPath(user), patch({ role: 'Maintainer' }), 403)
    await request(
      user,
      `${projectPath()}/members`,
      post({ user_id: guest.id, role: 'Developer' }),
      403
    )
    await request(user, memberPath(owner), { method: 'DELETE' }, 403)
  }

  async function verifyScopeIsolation() {
    const spaceMembers = await ownerRequest(`/api/v1/workspaces/${workspace.id}/members`)
    assert.equal(spaceMembers.items.find(row => row.user_id === member.id)?.role, 'Developer')
    assert.equal(
      (await request(member, `/api/v1/cloud-projects/${sibling.id}`)).access_role,
      'Developer'
    )
    await request(
      member,
      `/api/v1/workspaces/${workspace.id}/members/${administrator.id}`,
      patch({ role: 'Viewer' }),
      403
    )
    await request(
      member,
      `/api/v1/cloud-projects/${sibling.id}/members/${member.id}`,
      patch({ role: 'Maintainer' }),
      403
    )
    await request(
      member,
      `${projectPath()}/members`,
      post({ user_id: guest.id, role: 'Maintainer' })
    )
    await assertRole(guest, 'Maintainer', 'Maintainer', null)
    await request(guest, `/api/v1/workspaces/${workspace.id}`, {}, 404)
    await request(guest, `/api/v1/cloud-projects/${sibling.id}`, {}, 404)
    const spaces = await request(guest, '/api/v1/workspaces')
    assert.ok(!spaces.items.some(space => space.id === workspace.id))
    const projects = await request(guest, '/api/v1/cloud-projects')
    assert.ok(!projects.items.some(candidate => candidate.id === sibling.id))
    await ownerRequest(memberPath(guest), { method: 'DELETE' }, 204)
    await request(guest, projectPath(), {}, 404)
    verifiedCases.push(
      'project-administration-does-not-grant-space-or-sibling-administration',
      'direct-guests-stay-project-scoped'
    )
  }

  async function verifyAdministrationFloor() {
    for (const user of [owner, administrator]) {
      await ownerRequest(memberPath(user), patch({ role: 'Viewer' }))
      await assertRole(user, 'Maintainer', 'Viewer', 'Maintainer')
      await request(user, memberPath(user), { method: 'DELETE' }, 204)
      await assertRole(user, 'Maintainer', null, 'Maintainer')
    }
    verifiedCases.push('space-owner-and-administrator-retain-project-administration')
  }

  async function assertViewerDenials() {
    const issuePath = `/api/v1/loop-items/${issue.id}`
    const current = await request(member, issuePath)
    const commentsBefore = await ownerRequest(`${issuePath}/comments`)
    const assignmentsBefore = await ownerRequest(`${issuePath}/assignments`)
    await request(
      member,
      issuePath,
      patch({ version: current.version, title: 'Forbidden Viewer edit' }),
      403
    )
    await request(member, `${issuePath}/comments`, post({ body: 'Forbidden Viewer comment' }), 403)
    await request(
      member,
      `${issuePath}/assignments`,
      post({ target_type: 'human', target_id: String(owner.id), notify_target: false }),
      403
    )
    await request(
      member,
      `${projectPath()}/loop-items`,
      post({ title: 'Forbidden Viewer creation' }),
      403
    )
    await request(
      member,
      `${projectPath()}/executions/batch`,
      post({
        loop_item_id: issue.id,
        dispatch_id: 'permission-denied-dispatch',
        round_id: 'permission-denied-round',
        manager_runtime_task_id: 'permission-denied-task',
        manager_agent_id: manager.id,
        items: [
          {
            assignment_id: 'permission-denied-assignment',
            title: 'Forbidden execution',
            instructions: 'Must not execute',
            assignee_type: 'human',
            assignee_id: String(owner.id),
          },
        ],
      }),
      403
    )
    assert.equal((await ownerRequest(issuePath)).title, issue.title)
    assert.deepEqual(await ownerRequest(`${issuePath}/comments`), commentsBefore)
    assert.deepEqual(await ownerRequest(`${issuePath}/assignments`), assignmentsBefore)
    await assertCannotManage(member)
    verifiedCases.push('viewer-cannot-edit-comment-assign-create-or-execute-even-as-issue-creator')
  }

  async function cleanup() {
    for (const candidate of [project, sibling].filter(Boolean)) {
      if (archivedProjectIds.has(candidate.id)) continue
      const latest = await ownerRequest(`/api/v1/cloud-projects/${candidate.id}`)
      await ownerRequest(
        `/api/v1/cloud-projects/${candidate.id}?version=${latest.version}`,
        { method: 'DELETE' },
        204
      )
      archivedProjectIds.add(candidate.id)
    }
    if (workspace && !workspaceArchived) {
      const latest = await ownerRequest(`/api/v1/workspaces/${workspace.id}`)
      await ownerRequest(
        `/api/v1/workspaces/${workspace.id}?version=${latest.version}`,
        { method: 'DELETE' },
        204
      )
      workspaceArchived = true
    }
  }

  return {
    requiresCloudEnvironment: true,

    async prepareCloud(cloud) {
      backendUrl = cloud.backendUrl
      ownerToken = cloud.authToken
      owner = { ...(await ownerRequest('/api/users/me')), token: ownerToken }
      await ownerRequest('/api/admin/setup-complete', { method: 'POST' })
      member = await createUser(`project-member-${process.pid}`)
      administrator = await createUser(`space-administrator-${process.pid}`)
      guest = await createUser(`project-guest-${process.pid}`)
      workspace = await ownerRequest(
        '/api/v1/workspaces',
        post({ name: `角色覆盖空间-${process.pid}` })
      )
      for (const [user, role] of [
        [member, 'Developer'],
        [administrator, 'Maintainer'],
      ]) {
        await ownerRequest(
          `/api/v1/workspaces/${workspace.id}/members`,
          post({ user_id: user.id, role })
        )
      }
      project = await ownerRequest(
        `/api/v1/workspaces/${workspace.id}/projects`,
        post({ name: PROJECT_NAME, visibility: 'private', task_provider: 'local' })
      )
      sibling = await ownerRequest(
        `/api/v1/workspaces/${workspace.id}/projects`,
        post({ name: '隔离的相邻项目', visibility: 'private', task_provider: 'local' })
      )
      assert.equal(
        (await roster()).find(row => row.user_id === owner.id)?.direct_role,
        'Maintainer',
        'Project creation must grant Maintainer rather than project ownership'
      )
      await ownerRequest(memberPath(owner), { method: 'DELETE' }, 204)
      issue = await request(
        member,
        `${projectPath()}/loop-items`,
        post({ title: '成员创建的权限验收任务' })
      )
      manager = await ownerRequest(
        `${projectPath()}/chat-agents`,
        post({
          name: '权限验收管理员',
          runtime: 'codex',
          systemPrompt: 'Verify permission enforcement.',
        })
      )
      await assertRole(member, 'Developer', null)
    },

    setRestartDesktopApp(restart) {
      restartDesktopApp = restart
    },

    async verify(control) {
      try {
        await ensureExperimentalFeaturesEnabled(control)
        await openMembers(control)
        await assertUiRole(control, 'Developer', false)
        await assertCannotManage(member)
        await control.command('fill', memberControl('capability'), { value: CAPABILITY })
        await control.command('nativePress', memberControl('capability'), { key: 'Tab' })
        await waitForValue(
          roster,
          rows =>
            rows.find(row => row.user_id === member.id)?.capability_description === CAPABILITY,
          'The inherited member capability was not saved on blur',
          uiTimeoutMs
        )
        await assertRole(member, 'Developer', null)
        verifiedCases.push('capability-only-update-keeps-inherited-membership')

        await control.command('select', memberControl('role'), { value: 'Maintainer' })
        await waitForRole('Maintainer', 'Maintainer')
        await verifyScopeIsolation()
        await verifyAdministrationFloor()
        await reload(control)
        await openMembers(control)
        await assertUiRole(control, 'Maintainer', true)
        assert.equal(await control.command('getValue', memberControl('capability')), CAPABILITY)
        await captureScreenshot(control, 'project-member-overrides-promoted.png', CONTENT)
        verifiedCases.push('ui-promotion-persists-with-responsibilities-after-refresh')

        await switchAccount(control, member)
        await openMembers(control)
        await control.command('select', memberControl('role'), { value: 'Viewer' })
        await waitForRole('Viewer', 'Viewer')
        await control.command('waitFor', scoped('[data-testid="collaboration-tab-manage"]'), {
          visible: false,
        })
        await control.command('waitFor', scoped('[data-testid="cloud-project-members-panel"]'), {
          visible: false,
        })
        await control.command(
          'waitFor',
          scoped('[data-testid="collaboration-tab-board"][aria-current="page"]')
        )
        await assertViewerDenials()
        await captureScreenshot(control, 'project-member-overrides-self-demoted.png', CONTENT)
        verifiedCases.push('self-demotion-immediately-exits-management-and-revokes-write-access')

        await switchAccount(control, owner)
        await openMembers(control)
        await assertUiRole(control, 'Viewer', true)
        await ownerRequest(memberPath(member), { method: 'DELETE' }, 204)
        await assertRole(member, 'Developer', null)
        await reload(control)
        await openMembers(control)
        await assertUiRole(control, 'Developer', false)
        assert.equal(await control.command('getValue', memberControl('capability')), '')
        const comment = await request(
          member,
          `/api/v1/loop-items/${issue.id}/comments`,
          post({ body: '恢复空间角色后可评论' }),
          201
        )
        assert.equal(comment.body, '恢复空间角色后可评论')
        await assertCannotManage(member)
        verifiedCases.push(
          'removing-project-override-restores-space-role-and-clears-responsibilities'
        )
        await captureScreenshot(control, 'project-member-overrides-restored.png', CONTENT)
      } finally {
        await cleanup()
      }
    },

    diagnostics() {
      return {
        projectMemberOverrides: {
          workspaceId: workspace?.id,
          projectId: project?.id,
          memberId: member?.id,
          verifiedCases,
        },
      }
    },

    cleanup,
  }
}
