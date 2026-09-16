import assert from 'node:assert/strict'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'

const ACTIVE_WORKBENCH_SELECTOR = '[data-workspace-tab-content][aria-hidden="false"]'
const MEMBER_NAME = `collaboration-authority-${process.pid}`
const MEMBER_PASSWORD = 'WegentE2E-Authority-2026!'
const WORKSPACE_NAME = `协作权责验收空间-${process.pid}`
const PROJECT_NAME = `协作权责验收项目-${process.pid}`
const ISSUE_TITLE = '验证执行者任务权限'

async function requestResponse(baseUrl, token, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  })
  const text = await response.text()
  return {
    body: text ? JSON.parse(text) : null,
    ok: response.ok,
    status: response.status,
    text,
  }
}

async function requestJson(baseUrl, token, pathname, options = {}) {
  const response = await requestResponse(baseUrl, token, pathname, options)
  assert.equal(
    response.ok,
    true,
    `${options.method ?? 'GET'} ${pathname} failed with HTTP ${response.status}: ${response.text}`
  )
  return response.body
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
  let ownerToken = ''
  let owner = null
  let member = null
  let memberToken = ''
  let workspace = null
  let project = null
  let issue = null
  let fixtureArchived = false

  const ownerRequest = (pathname, options) => requestJson(backendUrl, ownerToken, pathname, options)
  const memberRequest = (pathname, options) =>
    requestJson(backendUrl, memberToken, pathname, options)
  const capture = (control, name) => captureScreenshot(control, name, ACTIVE_WORKBENCH_SELECTOR)

  async function archiveFixture() {
    if (fixtureArchived) return
    try {
      if (project) {
        const latestProject = await ownerRequest(`/api/v1/cloud-projects/${project.id}`)
        if (latestProject.status !== 'archived') {
          await ownerRequest(
            `/api/v1/cloud-projects/${project.id}?version=${latestProject.version}`,
            { method: 'DELETE' }
          )
        }
      }
      if (workspace) {
        const latestWorkspace = await ownerRequest(`/api/v1/workspaces/${workspace.id}`)
        if (latestWorkspace.status !== 'archived') {
          await ownerRequest(
            `/api/v1/workspaces/${workspace.id}?version=${latestWorkspace.version}`,
            { method: 'DELETE' }
          )
        }
      }
    } finally {
      fixtureArchived = true
    }
  }

  async function openCollaboration(control) {
    await ensureExperimentalFeaturesEnabled(control)
    await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
      timeoutMs: workbenchReadyTimeoutMs,
    })
    await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
    await control.command('waitFor', scoped('[data-testid="wework-collaboration-platform"]'), {
      timeoutMs: uiTimeoutMs,
    })
  }

  return {
    requiresCloudEnvironment: true,

    async prepareCloud(cloud) {
      backendUrl = cloud.backendUrl
      ownerToken = cloud.authToken
      owner = await ownerRequest('/api/users/me')
      await ownerRequest('/api/admin/setup-complete', { method: 'POST' })
      member = await ownerRequest('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          user_name: MEMBER_NAME,
          password: MEMBER_PASSWORD,
          role: 'user',
          auth_source: 'password',
        }),
      })
      const login = await requestJson(backendUrl, null, '/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          user_name: MEMBER_NAME,
          password: MEMBER_PASSWORD,
        }),
      })
      memberToken = login.access_token
      workspace = await ownerRequest('/api/v1/workspaces', {
        method: 'POST',
        body: JSON.stringify({
          name: WORKSPACE_NAME,
          description: '验证协作空间与项目的成员权责边界。',
        }),
      })
      await ownerRequest(`/api/v1/workspaces/${workspace.id}/members`, {
        method: 'POST',
        body: JSON.stringify({
          user_id: member.id,
          role: 'Reporter',
        }),
      })
      project = await ownerRequest(`/api/v1/workspaces/${workspace.id}/projects`, {
        method: 'POST',
        body: JSON.stringify({
          projectKey: 'AUTH',
          name: PROJECT_NAME,
          description: '验证观察者、执行者和所有者的协作责任。',
          taskProvider: 'local',
          providerConfig: {},
          visibility: 'private',
        }),
      })
      await ownerRequest(`/api/v1/cloud-projects/${project.id}/members`, {
        method: 'POST',
        body: JSON.stringify({
          user_id: member.id,
          role: 'Reporter',
          capability_description: '验证项目角色与任务动作权限',
        }),
      })
      issue = await ownerRequest(`/api/v1/cloud-projects/${project.id}/loop-items`, {
        method: 'POST',
        body: JSON.stringify({ title: ISSUE_TITLE }),
      })
      issue = await ownerRequest(`/api/v1/loop-items/${issue.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          version: issue.version,
          assignee_user_id: null,
        }),
      })
      assert.equal(issue.assignee_user_id, null)
    },

    async verify(control) {
      assert.ok(owner?.id, 'The collaboration owner fixture is missing')
      assert.ok(member?.id, 'The collaboration member fixture is missing')
      assert.ok(workspace?.id, 'The collaboration Workspace fixture is missing')
      assert.ok(project?.id, 'The collaboration Project fixture is missing')
      assert.ok(issue?.id, 'The collaboration Issue fixture is missing')

      try {
        await openCollaboration(control)
        const workspaceSelector = scoped(`[data-testid="collaboration-workspace-${workspace.id}"]`)
        await control.command('waitFor', workspaceSelector, {
          text: WORKSPACE_NAME,
          timeoutMs: uiTimeoutMs,
          visible: true,
        })
        await control.command('click', workspaceSelector)

        const workspaceActions = scoped('[data-testid="collaboration-workspace-actions"]')
        await control.command('click', workspaceActions)
        await control.command(
          'click',
          scoped('[data-testid="collaboration-workspace-nav-settings"]')
        )
        await control.command('waitFor', scoped('[data-testid="workspace-settings-shell"]'), {
          timeoutMs: uiTimeoutMs,
        })
        const workspaceParticipantsSelector = scoped(
          '[data-testid="collaboration-workspace-nav-participants"]'
        )
        await control.command('waitFor', workspaceParticipantsSelector, {
          timeoutMs: uiTimeoutMs,
        })
        await control.command('click', workspaceParticipantsSelector)
        const workspaceMembersTabSelector = scoped(
          '[data-testid="collaboration-workspace-participants-tab-members"]'
        )
        await control.command('waitFor', workspaceMembersTabSelector, {
          timeoutMs: uiTimeoutMs,
        })
        await control.command('click', workspaceMembersTabSelector)
        const workspaceRoleSelector = scoped(
          `[data-testid="collaboration-workspace-member-role-${member.id}"]`
        )
        await control.command('waitFor', workspaceRoleSelector, { timeoutMs: uiTimeoutMs })
        assert.equal(await control.command('getValue', workspaceRoleSelector), 'Reporter')
        assert.equal(
          Number(
            await control.command(
              'getElementCount',
              scoped(`[data-testid="collaboration-workspace-member-transfer-owner-${member.id}"]`)
            )
          ),
          1,
          'The Workspace owner did not receive the ownership-transfer action'
        )
        assert.ok(
          (await snapshot(control)).text.includes('空间观察者'),
          'The Workspace Reporter role did not use the observer label'
        )
        await capture(control, 'collaboration-authority-01-workspace-observer.png')

        await control.command(
          'click',
          scoped('[data-testid="collaboration-workspace-nav-projects"]')
        )
        const projectSelector = scoped(
          `[data-testid="collaboration-workspace-project-${project.id}"]`
        )
        await control.command('waitFor', projectSelector, {
          text: PROJECT_NAME,
          timeoutMs: uiTimeoutMs,
          visible: true,
        })
        await control.command('click', projectSelector)
        await control.command('waitFor', scoped('[data-testid="collaboration-root"]'), {
          timeoutMs: uiTimeoutMs,
        })
        await control.command('click', scoped('[data-testid="collaboration-tab-manage"]'))
        await control.command(
          'click',
          scoped('[data-testid="collaboration-project-settings-members"]')
        )
        await control.command('click', scoped('[data-testid="cloud-project-members-toggle"]'))
        const projectRoleSelector = scoped(`[data-testid="cloud-project-member-role-${member.id}"]`)
        await control.command('waitFor', projectRoleSelector, { timeoutMs: uiTimeoutMs })
        assert.equal(await control.command('getValue', projectRoleSelector), 'Reporter')
        assert.equal(
          Number(
            await control.command(
              'getElementCount',
              scoped(`[data-testid="cloud-project-member-transfer-owner-${member.id}"]`)
            )
          ),
          1,
          'The Project owner did not receive the ownership-transfer action'
        )
        assert.ok(
          (await snapshot(control)).text.includes('观察者'),
          'The Project Reporter role did not use the observer label'
        )
        await capture(control, 'collaboration-authority-02-project-observer.png')

        const reporterIssue = await memberRequest(`/api/v1/loop-items/${issue.id}`)
        assert.deepEqual(reporterIssue.permissions, {
          edit_content: false,
          comment: true,
          claim: false,
          handoff: false,
          assign: false,
          execute: false,
          submit_review: false,
          complete: false,
          reopen: false,
        })
        const reporterEdit = await requestResponse(
          backendUrl,
          memberToken,
          `/api/v1/loop-items/${issue.id}`,
          {
            method: 'PATCH',
            body: JSON.stringify({
              version: reporterIssue.version,
              title: '观察者不应修改任务',
            }),
          }
        )
        assert.equal(reporterEdit.status, 403, 'Reporter unexpectedly edited an Issue')

        await control.command('select', projectRoleSelector, { value: 'Developer' })
        await waitForApiValue(
          async () => {
            const members = await ownerRequest(`/api/v1/cloud-projects/${project.id}/members`)
            return members.find(candidate => candidate.user_id === member.id)?.role ?? null
          },
          value => value === 'Developer',
          'Changing the Project role through the Wework UI did not persist',
          uiTimeoutMs
        )
        assert.ok(
          (await snapshot(control)).text.includes('执行者'),
          'The Project Developer role did not use the executor label'
        )
        await capture(control, 'collaboration-authority-03-project-executor.png')

        let developerIssue = await memberRequest(`/api/v1/loop-items/${issue.id}`)
        assert.equal(developerIssue.permissions.edit_content, true)
        assert.equal(developerIssue.permissions.execute, true)
        assert.equal(developerIssue.permissions.claim, true)
        assert.equal(developerIssue.permissions.complete, false)
        developerIssue = await memberRequest(`/api/v1/loop-items/${issue.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            version: developerIssue.version,
            assignee_user_id: member.id,
          }),
        })
        assert.equal(developerIssue.assignee_user_id, member.id)
        developerIssue = await memberRequest(`/api/v1/loop-items/${issue.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            version: developerIssue.version,
            status: 'in_review',
          }),
        })
        assert.equal(developerIssue.status, 'in_review')
        const developerComplete = await requestResponse(
          backendUrl,
          memberToken,
          `/api/v1/loop-items/${issue.id}`,
          {
            method: 'PATCH',
            body: JSON.stringify({
              version: developerIssue.version,
              status: 'completed',
            }),
          }
        )
        assert.equal(
          developerComplete.status,
          403,
          'Developer unexpectedly completed an Issue awaiting acceptance'
        )

        const readyCountBeforeReload = control.readyCount
        await control.command('reloadMainWindow', 'body')
        await Promise.race([
          control.awaitReadyAfter(readyCountBeforeReload),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error('The reloaded Wework window did not reconnect')),
              uiTimeoutMs
            )
          ),
        ])
        await openCollaboration(control)
        await control.command('waitFor', scoped('[data-testid="cloud-project-header-title"]'), {
          text: PROJECT_NAME,
          timeoutMs: uiTimeoutMs,
        })
        await control.command('click', scoped('[data-testid="collaboration-tab-board"]'))
        const issueCard = scoped(`[data-testid="collaboration-issue-${issue.id}"]`)
        await control.command('waitFor', issueCard, {
          text: ISSUE_TITLE,
          timeoutMs: uiTimeoutMs,
          visible: true,
        })
        await control.command('click', `${issueCard} button`)
        await control.command('waitFor', scoped('[data-testid="collaboration-issue-detail"]'), {
          timeoutMs: uiTimeoutMs,
        })
        assert.equal(
          await control.command('getValue', scoped('[data-testid="cloud-todo-detail-status"]')),
          'in_review'
        )
        await capture(control, 'collaboration-authority-04-review-boundary.png')

        const transferredProject = await ownerRequest(
          `/api/v1/cloud-projects/${project.id}/transfer-ownership`,
          {
            method: 'POST',
            body: JSON.stringify({ user_id: member.id }),
          }
        )
        assert.equal(transferredProject.created_by_user_id, member.id)
        const restoredProject = await memberRequest(
          `/api/v1/cloud-projects/${project.id}/transfer-ownership`,
          {
            method: 'POST',
            body: JSON.stringify({ user_id: owner.id }),
          }
        )
        assert.equal(restoredProject.created_by_user_id, owner.id)

        const transferredWorkspace = await ownerRequest(
          `/api/v1/workspaces/${workspace.id}/transfer-ownership`,
          {
            method: 'POST',
            body: JSON.stringify({ user_id: member.id }),
          }
        )
        assert.equal(transferredWorkspace.created_by_user_id, member.id)
        const restoredWorkspace = await memberRequest(
          `/api/v1/workspaces/${workspace.id}/transfer-ownership`,
          {
            method: 'POST',
            body: JSON.stringify({ user_id: owner.id }),
          }
        )
        assert.equal(restoredWorkspace.created_by_user_id, owner.id)
      } finally {
        await archiveFixture()
      }
    },

    async cleanup() {
      await archiveFixture()
    },

    diagnostics() {
      return {
        fixtureArchived,
        issueId: issue?.id ?? null,
        memberId: member?.id ?? null,
        projectId: project?.id ?? null,
        workspaceId: workspace?.id ?? null,
      }
    },
  }
}
