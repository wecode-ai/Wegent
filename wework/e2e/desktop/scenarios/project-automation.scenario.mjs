import assert from 'node:assert/strict'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'

const ACTIVE_WORKBENCH_SELECTOR = '[data-workspace-tab-content][aria-hidden="false"]'
const LOCAL_WORKSPACE_ID = 'wework-local-workspace'
const WORKSPACE_NAME = '自动化策略验收空间'
const PROJECT_NAME = '自动化策略验收项目'
const POLICY_NAME = '每日检查待处理 Issue'
const POLICY_PROMPT =
  '检查项目内待处理的 Issue，拆分为可独立验证的工作，并把执行证据写回对应 Issue。'

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

async function snapshot(control, selector = ACTIVE_WORKBENCH_SELECTOR) {
  return JSON.parse(await control.command('snapshot', selector))
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

export function createDesktopScenario({ captureScreenshot, uiTimeoutMs, workbenchReadyTimeoutMs }) {
  let backendUrl = ''
  let authToken = ''
  let workspace = null
  let project = null
  let policy = null
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
        await control.command('waitFor', scoped('[data-testid="wework-collaboration-platform"]'), {
          timeoutMs: uiTimeoutMs,
        })
        await control.command('waitFor', scoped('[data-testid="collaboration-platform-root"]'), {
          timeoutMs: uiTimeoutMs,
        })

        const platformSnapshot = await snapshot(control)
        assert.ok(
          platformSnapshot.testIds.includes('wework-collaboration-platform') &&
            platformSnapshot.testIds.includes('collaboration-platform-root'),
          'The Collaboration tab did not render the native shared module'
        )
        assert.equal(
          Number(await control.command('getElementCount', scoped('iframe'))),
          0,
          'Wework Collaboration must not render the shared module through an iframe'
        )
        await control.command(
          'waitFor',
          scoped(`[data-testid="collaboration-workspace-${LOCAL_WORKSPACE_ID}"]`),
          {
            text: '本地空间',
            timeoutMs: uiTimeoutMs,
          }
        )
        await capture(control, 'project-automation-01-shared-platform.png')

        const workspaceName = `${WORKSPACE_NAME}-${process.pid}`
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
          'fill',
          scoped('[data-testid="collaboration-workspace-description-input"]'),
          { value: '验证 Wework 原生共享协作模块中的云端自动化策略。' }
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
          value => Boolean(value),
          'Creating the cloud Workspace through the shared module did not persist',
          uiTimeoutMs
        )
        await control.command(
          'waitFor',
          scoped('[data-testid="collaboration-workspace-project-create"]'),
          { timeoutMs: uiTimeoutMs }
        )

        const projectName = `${PROJECT_NAME}-${process.pid}`
        await control.command(
          'click',
          scoped('[data-testid="collaboration-workspace-project-create"]')
        )
        await control.command(
          'waitFor',
          scoped('[data-testid="collaboration-project-create-dialog"]'),
          { timeoutMs: uiTimeoutMs }
        )
        await control.command('waitFor', scoped('[data-testid="cloud-project-location-cloud"]'), {
          text: '云端',
          timeoutMs: uiTimeoutMs,
        })
        assert.equal(
          await control.command(
            'getAttribute',
            scoped('[data-testid="cloud-project-location-cloud"]'),
            { value: 'aria-pressed' }
          ),
          '',
          'A cloud Workspace must show an immutable cloud location summary, not a location toggle'
        )
        assert.equal(
          Number(
            await control.command(
              'getElementCount',
              scoped('[data-testid="cloud-project-location-local"]')
            )
          ),
          0,
          'A cloud Workspace must not offer local project storage'
        )
        await control.command('fill', scoped('[data-testid="collaboration-project-name-input"]'), {
          value: projectName,
        })
        await control.command(
          'fill',
          scoped('[data-testid="collaboration-project-description-input"]'),
          { value: '自动化策略属于项目设置，不是独立画布。' }
        )
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
          value => Boolean(value),
          'Creating the cloud Project through the shared module did not persist',
          uiTimeoutMs
        )
        await control.command('waitFor', scoped('[data-testid="collaboration-root"]'), {
          timeoutMs: uiTimeoutMs,
        })

        const projectSnapshot = await snapshot(control)
        assert.ok(
          projectSnapshot.testIds.includes('collaboration-tab-board') &&
            projectSnapshot.testIds.includes('collaboration-tab-table') &&
            projectSnapshot.testIds.includes('collaboration-tab-manage'),
          'The shared Project did not expose Board, Issue table, and Project settings'
        )
        assert.equal(
          projectSnapshot.testIds.includes('collaboration-tab-automation'),
          false,
          'Automation must not be a top-level Project tab'
        )
        await control.command('click', scoped('[data-testid="collaboration-tab-manage"]'))
        await control.command(
          'waitFor',
          scoped('[data-testid="collaboration-project-settings-dispatch"]'),
          { timeoutMs: uiTimeoutMs }
        )
        await control.command(
          'click',
          scoped('[data-testid="collaboration-project-settings-dispatch"]')
        )
        await control.command('waitFor', scoped('[data-testid="project-automation-policy"]'), {
          timeoutMs: uiTimeoutMs,
        })
        await capture(control, 'project-automation-02-policy-welcome.png')

        await control.command('click', scoped('[data-testid="automation-welcome-create-policy"]'))
        await control.command('waitFor', scoped('[data-testid="automation-policy-name"]'), {
          timeoutMs: uiTimeoutMs,
        })
        await control.command('click', scoped('[data-testid="automation-trigger-schedule"]'))
        await control.command('fill', scoped('[data-testid="automation-policy-name"]'), {
          value: POLICY_NAME,
        })
        await control.command('fill', scoped('[data-testid="automation-coordinator-prompt"]'), {
          value: POLICY_PROMPT,
        })
        await control.command('click', scoped('[data-testid="automation-approval-automatic"]'))
        await control.command(
          'clickWhenEnabled',
          scoped('[data-testid="automation-save-policy"]'),
          { timeoutMs: uiTimeoutMs }
        )
        policy = await waitForApiValue(
          () => request(`/api/v1/cloud-projects/${project.id}/automations`),
          rules => rules.find(rule => rule.name === POLICY_NAME) ?? null,
          'Saving the automation policy through Project settings did not persist',
          uiTimeoutMs
        )
        assert.equal(policy.triggerType, 'schedule')
        assert.equal(policy.assignmentMode, 'ai_managed')
        assert.equal(policy.managerType, 'custom')
        assert.ok(
          policy.prompt.includes(POLICY_PROMPT),
          'The executable automation prompt lost the coordinator policy'
        )
        assert.equal(
          policy.eventConfig.runtime_workflow_definition.coordinator_prompt,
          POLICY_PROMPT,
          'The canonical workflow definition did not preserve the natural-language policy'
        )
        await control.command('waitFor', scoped('[data-testid="automation-save-policy"]'), {
          text: '已保存',
          timeoutMs: uiTimeoutMs,
        })
        await capture(control, 'project-automation-03-policy-saved.png')

        await control.command('click', scoped('[data-testid="collaboration-tab-board"]'))
        await control.command('waitFor', scoped('[data-testid="collaboration-empty-project"]'), {
          timeoutMs: uiTimeoutMs,
        })
        await control.command('click', scoped('[data-testid="collaboration-tab-manage"]'))
        await control.command(
          'click',
          scoped('[data-testid="collaboration-project-settings-dispatch"]')
        )
        await control.command('waitFor', scoped('[data-testid="automation-policy-name"]'), {
          timeoutMs: uiTimeoutMs,
        })
        assert.equal(
          await control.command('getValue', scoped('[data-testid="automation-policy-name"]')),
          POLICY_NAME,
          'Re-entering Project settings did not restore the persisted policy'
        )
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
        policyId: policy?.id ?? null,
        projectId: project?.id ?? null,
        workspaceId: workspace?.id ?? null,
      }
    },
  }
}
