import assert from 'node:assert/strict'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'

const ACTIVE_WORKBENCH_SELECTOR = '[data-workspace-tab-content][aria-hidden="false"]'
const PROJECT_NAME = '协作共享核心验收'
const PROJECT_KEY = 'CSCORE'
const ISSUE_FIXTURES = [
  { title: '整理协作需求', status: 'inbox', priority: 'high' },
  { title: '实现共享界面', status: 'pending', priority: 'urgent' },
  { title: '验收默认看板', status: 'in_review', priority: 'medium' },
  { title: '保留原有交互', status: 'completed', priority: 'low' },
]

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

async function snapshot(control) {
  return JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
}

export function createDesktopScenario({ captureScreenshot, uiTimeoutMs, workbenchReadyTimeoutMs }) {
  let backendUrl = ''
  let authToken = ''
  let owner = null
  let project = null
  let issues = []
  let fixtureArchived = false

  const request = (pathname, options) => requestJson(backendUrl, authToken, pathname, options)
  const capture = (control, name) => captureScreenshot(control, name, ACTIVE_WORKBENCH_SELECTOR)

  async function archiveFixture() {
    if (!project || fixtureArchived) return
    const latest = await request(`/api/v1/cloud-projects/${project.id}`)
    await request(`/api/v1/cloud-projects/${project.id}?version=${latest.version}`, {
      method: 'DELETE',
    })
    fixtureArchived = true
  }

  return {
    requiresCloudEnvironment: true,

    async prepareCloud(cloud) {
      backendUrl = cloud.backendUrl
      authToken = cloud.authToken
      owner = await request('/api/users/me')
      project = await request('/api/v1/cloud-projects', {
        method: 'POST',
        body: JSON.stringify({
          project_key: PROJECT_KEY,
          name: PROJECT_NAME,
          description: 'Wework collaboration shared-core desktop E2E fixture',
          task_provider: 'local',
          provider_config: {},
          visibility: 'private',
        }),
      })
      issues = []
      for (const fixture of ISSUE_FIXTURES) {
        issues.push(
          await request(`/api/v1/cloud-projects/${project.id}/loop-items`, {
            method: 'POST',
            body: JSON.stringify({
              ...fixture,
              assignee_user_id: owner.id,
            }),
          })
        )
      }
    },

    async verify(control) {
      assert.ok(owner?.id, 'The collaboration shared-core owner fixture is missing')
      assert.ok(project?.id, 'The collaboration shared-core project fixture is missing')
      assert.equal(
        issues.length,
        ISSUE_FIXTURES.length,
        'The collaboration shared-core Issue fixtures are incomplete'
      )

      try {
        const projects = await request('/api/v1/cloud-projects')
        assert.ok(
          projects.items.some(item => item.id === project.id),
          'The real backend did not persist the collaboration project fixture'
        )
        const myWork = await request('/api/v1/cloud-work-items/my-work')
        const myWorkIds = new Set(myWork.items.map(item => item.id))
        for (const issue of issues) {
          assert.ok(
            myWorkIds.has(issue.id),
            `The real My Work endpoint did not return fixture Issue ${issue.id}`
          )
        }

        await ensureExperimentalFeaturesEnabled(control)
        await control.command('waitFor', '[data-testid="workspace-tab-add"]', {
          timeoutMs: workbenchReadyTimeoutMs,
        })
        await control.command('click', '[data-testid="workspace-tab-add"]')
        await control.command('waitFor', '[data-testid="workspace-tab-add-menu"]', {
          timeoutMs: uiTimeoutMs,
        })
        await control.command('click', '[data-testid="workspace-tab-add-board"]')
        await control.command('waitFor', scoped('[data-testid="cloud-todo-workspace"]'), {
          timeoutMs: uiTimeoutMs,
        })
        await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
          timeoutMs: uiTimeoutMs,
        })
        assert.equal(
          await control.command(
            'getAttribute',
            '[data-testid="workspace-tab-select-fixed-board"]',
            { value: 'aria-selected' }
          ),
          'true',
          'Opening Collaboration did not activate the fixed Collaboration tab'
        )

        await control.command('waitFor', scoped('[data-testid="cloud-projects-home-create"]'), {
          timeoutMs: uiTimeoutMs,
        })
        await control.command(
          'waitFor',
          scoped(`[data-testid="cloud-projects-home-todo-${issues[0].id}"]`),
          {
            text: issues[0].title,
            timeoutMs: uiTimeoutMs,
          }
        )
        const homeSnapshot = await snapshot(control)
        for (const testId of [
          'cloud-projects-home-create',
          'cloud-projects-home-my-work',
          'cloud-projects-home-manage',
          `cloud-sidebar-project-${project.id}`,
        ]) {
          assert.ok(
            homeSnapshot.testIds.includes(testId),
            `The project home is missing its required control: ${testId}`
          )
        }
        assert.ok(
          homeSnapshot.text.includes(PROJECT_NAME),
          'The project home did not render the real backend project'
        )
        await capture(control, 'collaboration-shared-core-01-project-home.png')

        await control.command('click', scoped('[data-testid="cloud-projects-home-my-work"]'))
        await control.command('waitFor', scoped('[data-testid="cloud-my-work-view"]'), {
          timeoutMs: uiTimeoutMs,
        })
        await control.command('waitFor', scoped('[data-testid="my-work-groups"]'), {
          timeoutMs: uiTimeoutMs,
        })
        assert.equal(
          await control.command('getAttribute', scoped('[data-testid="my-work-view-tab-group"]'), {
            value: 'aria-selected',
          }),
          'true',
          'My Work did not open in its default grouped board view'
        )
        const [inboxIssue, pendingIssue, reviewIssue, completedIssue] = issues
        for (const testId of [
          `my-work-group-action-${inboxIssue.id}`,
          `my-work-group-action-${pendingIssue.id}`,
          `my-work-group-review-${reviewIssue.id}`,
          `my-work-group-done-${completedIssue.id}`,
        ]) {
          await control.command('waitFor', scoped(`[data-testid="${testId}"]`), {
            timeoutMs: uiTimeoutMs,
          })
        }
        await capture(control, 'collaboration-shared-core-02-my-work-default-board.png')

        await control.command(
          'click',
          scoped(`[data-testid="cloud-sidebar-project-${project.id}"]`)
        )
        await control.command('waitFor', scoped('[data-testid="cloud-project-header-title"]'), {
          text: PROJECT_NAME,
          timeoutMs: uiTimeoutMs,
        })
        await control.command('waitFor', scoped('[data-testid="cloud-board-toolbar"]'), {
          timeoutMs: uiTimeoutMs,
        })
        await control.command('waitFor', scoped('[data-testid="cloud-board-scroll"]'), {
          timeoutMs: uiTimeoutMs,
        })
        for (const testId of [
          'cloud-project-header',
          'cloud-project-board-view',
          'cloud-project-files-view',
          'cloud-project-automation-view',
          'cloud-project-manage-view',
          'cloud-todo-column-inbox',
          'cloud-todo-column-pending',
          'cloud-todo-column-in_review',
          'cloud-todo-column-completed',
          ...issues.map(issue => `cloud-todo-card-${issue.id}`),
        ]) {
          await control.command('waitFor', scoped(`[data-testid="${testId}"]`), {
            timeoutMs: uiTimeoutMs,
          })
        }
        assert.equal(
          await control.command(
            'getAttribute',
            scoped('[data-testid="cloud-project-board-view"]'),
            { value: 'aria-current' }
          ),
          'page',
          'Entering a project did not preserve the original board as the default project view'
        )
        await capture(control, 'collaboration-shared-core-03-project-board.png')
      } finally {
        await archiveFixture()
      }
    },

    diagnostics() {
      return {
        fixtureArchived,
        issueIds: issues.map(issue => issue.id),
        projectId: project?.id ?? null,
      }
    },
  }
}
