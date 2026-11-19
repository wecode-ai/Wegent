import assert from 'node:assert/strict'
import { TransportFaultProxy } from '../modules/transport-fault-proxy.mjs'
import {
  handlePersonalHomeModel,
  openCollaborationIssueCreation,
  verifyCollaborationPersonalHome,
  verifyPersonalHomeStartWork,
} from '../modules/collaboration-personal-home.mjs'
import { selectWorkbenchTheme } from '../modules/appearance-theme.mjs'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  completeLocalCollaborationFolderImport,
  inCollaborationSidebar,
} from '../modules/workspace-flows.mjs'

const ACTIVE_WORKBENCH_SELECTOR = '[data-workspace-tab-content][aria-hidden="false"]'
const PROJECT_NAME = `首次协作验收-${process.pid}`
const ISSUE_NAME = `整理首用闭环-${process.pid}`

function scoped(selector) {
  return `${ACTIVE_WORKBENCH_SELECTOR} ${selector}`
}

function sidebarScoped(selector) {
  return inCollaborationSidebar(selector)
}

export function createDesktopScenario({ captureScreenshot, uiTimeoutMs, workbenchReadyTimeoutMs }) {
  const appEnvironment = {}
  let proxy
  let cloudUnavailable = false
  const capture = (control, name, selector = ACTIVE_WORKBENCH_SELECTOR) =>
    captureScreenshot(control, name, selector)

  return {
    appEnvironment,
    async prepareCloud({ backendUrl }) {
      proxy = await new TransportFaultProxy(backendUrl).start()
      appEnvironment.WEWORK_E2E_CLOUD_BACKEND_URL = proxy.url
      appEnvironment.WEWORK_BACKEND_URL = `${proxy.url}/api`
      proxy.rule = entry =>
        cloudUnavailable && entry.path === '/api/v1/cloud-work-items/my-work' ? 'disconnect' : null
    },
    async cleanup() {
      await proxy?.stop()
    },
    handleHttp: handlePersonalHomeModel,
    async verify(control) {
      await selectWorkbenchTheme(control, { timeoutMs: uiTimeoutMs })
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await control.command('waitFor', scoped('[data-testid="collaboration-platform-root"]'), {
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            sidebarScoped('[data-testid="collaboration-primary-agents"]')
          )
        ),
        1,
        'First use did not expose the standalone Agent destination'
      )

      await openCollaborationIssueCreation(control, scoped)
      await control.command(
        'waitFor',
        scoped('[data-testid="collaboration-first-issue-starter"]'),
        {
          text: '从第一件事开始',
          timeoutMs: uiTimeoutMs,
        }
      )
      await capture(control, 'collaboration-first-use-01-welcome.png')

      await control.command('waitFor', scoped('[data-testid="collaboration-first-issue-create"]'))
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            scoped('[data-testid="collaboration-first-project-create"]')
          )
        ),
        0,
        'The first-use home must start with an Issue rather than require project creation'
      )
      await control.command('click', scoped('[data-testid="collaboration-first-issue-create"]'))
      await control.command('waitFor', '[data-testid="independent-issue-dialog"]', {
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        await control.command('getValue', '[data-testid="independent-issue-project"]'),
        '',
        'The first Issue must not require a project selection'
      )
      await control.command('click', '[data-testid="independent-issue-close"]')
      await control.command('waitFor', scoped('[data-testid="collaboration-first-issue-create"]'))
      await control.command(
        'click',
        sidebarScoped('[data-testid="collaboration-workspace-home-wework-local-workspace"]')
      )

      const projectMenuTrigger = scoped(
        '[data-testid="collaboration-workspace-project-create"][aria-haspopup="menu"]'
      )
      await control.command('waitFor', projectMenuTrigger, { timeoutMs: uiTimeoutMs })
      await control.command('click', projectMenuTrigger)
      await control.command(
        'clickWhenEnabled',
        '[data-testid="collaboration-workspace-project-import-folder"]',
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await capture(control, 'collaboration-first-use-02-workspace.png')
      await completeLocalCollaborationFolderImport(control, PROJECT_NAME)
      await control.command('waitFor', scoped('[data-testid="collaboration-empty-project"]'), {
        timeoutMs: uiTimeoutMs,
      })
      await capture(control, 'collaboration-first-use-04-project.png')

      await control.command('click', scoped('[data-testid="collaboration-empty-project-create"]'))
      await control.command('waitFor', scoped('[data-testid="cloud-todo-title"]'), {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('fill', scoped('[data-testid="cloud-todo-title"]'), {
        value: ISSUE_NAME,
      })
      await control.command('click', scoped('[data-testid="cloud-todo-create-assignee"]'))
      const ownerSelector = '[data-testid^="cloud-todo-create-assignee-option-user:"]'
      await control.command('waitFor', ownerSelector, { timeoutMs: uiTimeoutMs })
      const ownerName = await control.command('getText', ownerSelector)
      const ownerTarget = (
        await control.command('getAttribute', ownerSelector, { value: 'data-testid' })
      ).replace('cloud-todo-create-assignee-option-', '')
      await control.command('click', ownerSelector)
      await capture(control, 'collaboration-first-use-05-issue.png')
      await control.command(
        'clickWhenEnabled',
        scoped('[data-testid="cloud-todo-create-confirm"]'),
        { timeoutMs: uiTimeoutMs }
      )
      await control.command('waitFor', scoped('[data-testid="collaboration-issue-detail"]'), {
        text: ISSUE_NAME,
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        await control.command('getValue', scoped('[data-testid="cloud-todo-detail-title"]')),
        ISSUE_NAME,
        'The first Issue did not open after creation'
      )
      await control.command('waitFor', scoped('[data-testid="cloud-todo-detail-assignee"]'), {
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        await control.command('getValue', scoped('[data-testid="cloud-todo-detail-assignee"]')),
        ownerTarget,
        `The first Issue did not retain its human owner ${ownerName}`
      )
      await capture(control, 'collaboration-first-use-06-issue-ready.png')
      await control.command('click', scoped('[data-testid="cloud-todo-detail-close"]'))
      const projectTestId = await control.command(
        'getAttribute',
        sidebarScoped('[data-testid^="collaboration-workspace-project-"]'),
        { value: 'data-testid' }
      )
      const projectId = projectTestId.replace('collaboration-workspace-project-', '')
      const issueTestId = await control.command(
        'getAttribute',
        scoped('button[data-testid^="cloud-todo-card-"]'),
        { value: 'data-testid' }
      )
      const issueId = issueTestId.replace('cloud-todo-card-', '')
      const localProject = { id: projectId, name: PROJECT_NAME }
      cloudUnavailable = true
      await verifyCollaborationPersonalHome(control, {
        scoped,
        project: localProject,
        issue: { id: issueId, title: ISSUE_NAME },
        cloudAvailable: false,
      })
      await verifyPersonalHomeStartWork(control, {
        scoped,
        project: localProject,
        // Local project work is owned by the native participant, independently
        // of the authenticated Backend account and selectable cloud members.
        viewerId: 0,
      })
      await capture(control, 'collaboration-first-use-07-home-workflow.png')
      await control.command('click', scoped(`[data-testid="personal-home-issue-${issueId}"]`))
      await control.command('waitFor', scoped('[data-testid="personal-home-open-in-project"]'))
      await control.command('click', scoped('[data-testid="personal-home-open-in-project"]'))
      await control.command('waitFor', scoped('[data-testid="cloud-todo-detail-title"]'))
      assert.equal(
        await control.command('getValue', scoped('[data-testid="cloud-todo-detail-title"]')),
        ISSUE_NAME
      )
      assert.equal(
        Number(await control.command('getElementCount', scoped('[data-testid="personal-home"]'))),
        0,
        'A local project without a parent workspace must open its actual Issue detail'
      )
      await capture(control, 'collaboration-first-use-08-open-local-project.png')
    },

    diagnostics() {
      return { issueName: ISSUE_NAME }
    },
  }
}
