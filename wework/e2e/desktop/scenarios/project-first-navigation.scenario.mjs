import assert from 'node:assert/strict'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { inCollaborationSidebar } from '../modules/workspace-flows.mjs'

const active = '[data-workspace-tab-content][aria-hidden="false"]'
const projectName = `项目入口验收-${process.pid}`
const sidebar = testId => inCollaborationSidebar(`[data-testid="${testId}"]`)

// User stories: start a project without choosing a space, find it directly,
// and find each project once under its space without changing its identity.
export function createDesktopScenario({ captureScreenshot, uiTimeoutMs, workbenchReadyTimeoutMs }) {
  let projectTestId
  return {
    async verify(control) {
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      for (const location of ['local', 'cloud']) {
        await control.command('waitFor', sidebar(`collaboration-project-group-${location}`), {
          visible: true,
          timeoutMs: uiTimeoutMs,
        })
      }
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            sidebar('collaboration-workspaces-section-toggle')
          )
        ),
        0
      )
      await control.command(
        'waitFor',
        sidebar('collaboration-workspace-tree-wework-local-workspace'),
        { visible: true, timeoutMs: uiTimeoutMs }
      )
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            sidebar('collaboration-workspace-tree-wework-local-workspace')
          )
        ),
        1
      )
      await captureScreenshot(control, 'project-first-01-default.png', active)

      await control.command('clickWhenEnabled', sidebar('collaboration-project-create-local'), {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="collaboration-project-name-input"]', {
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        Number(await control.command('getElementCount', '.collaboration-workspace-picker')),
        0
      )
      await control.command('fill', '[data-testid="collaboration-project-name-input"]', {
        value: projectName,
      })
      await control.command(
        'clickWhenEnabled',
        '[data-testid="collaboration-project-create-confirm"]',
        { timeoutMs: uiTimeoutMs }
      )
      await control.command('waitFor', sidebar('collaboration-project-group-local'), {
        text: projectName,
        timeoutMs: uiTimeoutMs,
      })
      const snapshot = JSON.parse(
        await control.command('snapshot', sidebar('collaboration-project-group-local'))
      )
      for (const testId of snapshot.testIds.filter(id =>
        id.startsWith('collaboration-workspace-project-')
      )) {
        if ((await control.command('getText', sidebar(testId))).includes(projectName)) {
          projectTestId = testId
          break
        }
      }
      assert.ok(projectTestId, 'The created project must be directly accessible in Local projects')
      assert.equal(
        Number(await control.command('getElementCount', sidebar(projectTestId))),
        1,
        'A project must appear exactly once in the sidebar'
      )
      await control.command('click', sidebar(projectTestId))
      await control.command('waitFor', sidebar(projectTestId), { timeoutMs: uiTimeoutMs })
      assert.equal(
        await control.command('getAttribute', sidebar(projectTestId), { value: 'aria-current' }),
        'page'
      )

      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            sidebar('collaboration-workspace-toggle-wework-local-workspace')
          )
        ),
        0
      )
      assert.equal(
        (await control.command('getText', sidebar('collaboration-project-group-local'))).includes(
          '本地空间'
        ),
        false
      )
      await captureScreenshot(control, 'project-first-02-created.png', active)
      await control.command('click', sidebar('collaboration-primary-home'))
      await control.command('click', sidebar(projectTestId))
      await control.command('waitFor', `${sidebar(projectTestId)}[aria-current="page"]`, {
        visible: true,
        timeoutMs: uiTimeoutMs,
      })
    },
    diagnostics() {
      return { projectName, projectTestId }
    },
  }
}
