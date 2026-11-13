import assert from 'node:assert/strict'
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
  const capture = (control, name, selector = ACTIVE_WORKBENCH_SELECTOR) =>
    captureScreenshot(control, name, selector)

  return {
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
        scoped('[data-testid="collaboration-first-project-starter"]'),
        {
          text: '开始第一个协作项目',
          timeoutMs: uiTimeoutMs,
        }
      )
      await capture(control, 'collaboration-first-use-01-welcome.png')

      await control.command('click', scoped('[data-testid="collaboration-first-project-create"]'))
      await control.command('click', '[data-testid="collaboration-first-project-create-folder"]')
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
      await verifyCollaborationPersonalHome(control, {
        scoped,
        project: localProject,
        issue: { id: issueId, title: ISSUE_NAME },
        cloudAvailable: false,
      })
      // Native collaboration uses user 0 independently of the signed-in account identity.
      await verifyPersonalHomeStartWork(control, { scoped, project: localProject, viewerId: 0 })
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
