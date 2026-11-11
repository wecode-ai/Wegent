import assert from 'node:assert/strict'
import { selectWorkbenchTheme } from '../modules/appearance-theme.mjs'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  completeLocalCollaborationFolderImport,
  enterLocalCollaborationWorkspace,
  enterProjectCollaborationView,
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
    async verify(control) {
      await selectWorkbenchTheme(control, { timeoutMs: uiTimeoutMs })
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await enterProjectCollaborationView(control, ACTIVE_WORKBENCH_SELECTOR, uiTimeoutMs)
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

      await enterLocalCollaborationWorkspace(control, ACTIVE_WORKBENCH_SELECTOR)
      await control.command(
        'waitFor',
        scoped('[data-testid="collaboration-workspace-project-create"]'),
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await capture(control, 'collaboration-first-use-01-welcome.png')

      await control.command(
        'click',
        scoped('[data-testid="collaboration-workspace-project-create"]')
      )
      await control.command(
        'click',
        '[data-testid="collaboration-workspace-project-import-folder"]'
      )
      await capture(control, 'collaboration-first-use-02-workspace.png')
      await completeLocalCollaborationFolderImport(control, PROJECT_NAME)
      await control.command('waitFor', scoped('[data-testid="collaboration-empty-project"]'), {
        timeoutMs: uiTimeoutMs,
      })
      await capture(control, 'collaboration-first-use-04-project.png')

      await control.command('click', scoped('[data-testid="collaboration-empty-project-create"]'))
      await control.command('chooseWhenEnabled', '[data-testid="thread-create-group-select"]', {
        value: '__new__',
        timeoutMs: uiTimeoutMs,
      })
      await control.command('fill', '[data-testid="thread-create-new-group-name"]', {
        value: `${PROJECT_NAME}协作群`,
      })
      await control.command('clickWhenEnabled', '[data-testid="thread-create-group-next"]', {
        timeoutMs: uiTimeoutMs,
      })
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
      await control.command('waitFor', scoped('[data-testid="thread-room"]'), {
        text: ISSUE_NAME,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', scoped('[data-testid="thread-settings"]'))
      await control.command('waitFor', scoped('[data-testid="thread-settings-panel"]'), {
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        await control.command('getValue', scoped('[data-testid="thread-settings-title"]')),
        ISSUE_NAME,
        'The first Issue did not open after creation'
      )
      await control.command('waitFor', scoped('[data-testid="thread-settings-assignee"]'), {
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        await control.command('getValue', scoped('[data-testid="thread-settings-assignee"]')),
        ownerTarget,
        `The first Issue did not retain its human owner ${ownerName}`
      )
      await capture(control, 'collaboration-first-use-06-issue-ready.png')
    },

    diagnostics() {
      return { issueName: ISSUE_NAME }
    },
  }
}
