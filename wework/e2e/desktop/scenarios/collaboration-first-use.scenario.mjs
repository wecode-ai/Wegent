import assert from 'node:assert/strict'

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
    async verify(control) {
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

      await control.command('click', sidebarScoped('[data-testid="collaboration-primary-home"]'))
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
      await capture(control, 'collaboration-first-use-06-issue-ready.png')
    },

    diagnostics() {
      return { issueName: ISSUE_NAME }
    },
  }
}
