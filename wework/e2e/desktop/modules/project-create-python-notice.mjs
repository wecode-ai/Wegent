import assert from 'node:assert/strict'
import {
  assertProjectCreateActionHit,
  waitForProjectCreateViewport,
} from './project-create-dialog-regression.mjs'
import { ensureExperimentalFeaturesEnabled } from './preferences-automation-flows.mjs'
import {
  openDirectProjectCreation,
  revealCollaborationSidebarElement,
  selectCollaborationDomain,
} from './workspace-flows.mjs'

const ACTIVE = '[data-workspace-tab-content][aria-hidden="false"]'
const DIALOG = '[data-testid="collaboration-project-create-dialog"]'
const NOTICE = '[data-testid="plugin-python-runtime-notice"]'

export function createProjectPythonNoticeRegression({ captureScreenshot }) {
  let cloud
  let workspace

  async function assertActionHit(control, selector) {
    try {
      await assertProjectCreateActionHit(control, selector)
    } catch (error) {
      await captureScreenshot(control, 'project-create-python-notice-hit-failure.png', 'body')
      throw error
    }
  }

  async function request(path, options = {}) {
    const response = await fetch(`${cloud.backendUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${cloud.authToken}`,
        'Content-Type': 'application/json',
      },
    })
    assert.ok(response.ok, `Python notice project fixture ${path}: HTTP ${response.status}`)
    return response.status === 204 ? null : response.json()
  }

  return {
    async prepare(environment) {
      cloud = environment
      workspace = await request('/api/v1/workspaces', {
        method: 'POST',
        body: JSON.stringify({ name: `Python notice project ${process.pid}` }),
      })
    },
    async verify(control) {
      // A detached fixed workspace can remain the active control client after
      // restart. Resize that exact window so the narrow-layout assertion measures
      // the renderer that owns the project creation flow.
      await control.command('focusWindow', 'body')
      await control.command('waitFor', 'body', { visible: true })
      const previousSize = await control.command('setMainWindowSize', 'body', {
        value: JSON.stringify({ width: 1024, height: 768 }),
      })
      try {
        await waitForProjectCreateViewport(control)
        await ensureExperimentalFeaturesEnabled(control)
        await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
        await selectCollaborationDomain(control, ACTIVE, 'cloud')
        const home = `${ACTIVE} [data-testid="collaboration-workspace-home-${workspace.id}"]`
        await revealCollaborationSidebarElement(control, home)
        await control.command('click', home)
        await openDirectProjectCreation(control, ACTIVE)
        await control.command('waitFor', NOTICE, { text: '准备失败' })
        const noticeZ = Number(
          await control.command('getComputedStyleValue', NOTICE, { value: 'z-index' })
        )
        const modalZ = Number(
          await control.command('getComputedStyleValue', '.collaboration-dialog-backdrop', {
            value: 'z-index',
          })
        )
        assert.ok(
          noticeZ < modalZ,
          `Python failure notice ${noticeZ} covers project modal ${modalZ}`
        )
        await assertActionHit(
          control,
          `${DIALOG} [data-testid="collaboration-project-create-close"]`
        )
        await control.command(
          'fill',
          `${DIALOG} [data-testid="collaboration-project-name-input"]`,
          {
            value: 'Project remains usable during Python failure',
          }
        )
        await assertActionHit(
          control,
          `${DIALOG} [data-testid="collaboration-project-create-confirm"]`
        )
        await control.command(
          'click',
          `${DIALOG} [data-testid="collaboration-project-create-close"]`
        )
        const discard = `${DIALOG} [data-testid="collaboration-project-create-discard"]`
        const discardAction = `${discard} [data-testid="collaboration-project-create-discard-confirm"]`
        await control.command('waitFor', discard, { visible: true })
        await assertActionHit(control, discardAction)
        await control.command('click', discardAction)
        await control.command('waitFor', DIALOG, { visible: false })
        await control.command('waitFor', NOTICE, { text: '准备失败' })
        await control.command('navigate', 'body', { value: '/settings/execution-environments' })
        await control.command('waitFor', '[data-testid="execution-environment-python"]', {
          text: '安装失败',
        })
      } finally {
        await control.command('setMainWindowSize', 'body', { value: previousSize })
      }
    },
    async cleanup() {
      if (!workspace) return
      const latest = await request(`/api/v1/workspaces/${workspace.id}`)
      if (latest.status !== 'archived') {
        await request(`/api/v1/workspaces/${workspace.id}?version=${latest.version}`, {
          method: 'DELETE',
        })
      }
      workspace = null
    },
  }
}
