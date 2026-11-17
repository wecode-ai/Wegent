// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict'

import { waitForBoardValue } from '../modules/collaboration-board-flows.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { TransportFaultProxy } from '../modules/transport-fault-proxy.mjs'
import { selectCollaborationDomain } from '../modules/workspace-flows.mjs'
import { selectCollaborationProjectView } from '../modules/collaboration-project-navigation.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const scoped = selector => `${CONTENT} ${selector}`
const lane = id => scoped(`[data-testid="cloud-todo-column-${id}"]`)
const sync = state =>
  scoped(`[data-testid="project-snapshot-sync-state"][data-sync-state="${state}"]`)
const view = (name, columns) => ({
  schema_version: 1,
  default_view_id: 'stages',
  views: [{ id: 'stages', name, columns }],
})
const backlog = { id: 'backlog', type: 'unmatched', value: 'Backlog' }
const design = { id: 'design', type: 'tag', value: 'design' }
const develop = { id: 'develop', type: 'tag', value: 'develop' }
const review = { id: 'review', type: 'tag', value: 'review' }
const pending = { id: 'todo', type: 'status', value: 'pending' }

// Every response comes from the real backend; the proxy only interrupts transport.
export function createDesktopScenario({ uiTimeoutMs, workbenchReadyTimeoutMs }) {
  const appEnvironment = { WEWORK_E2E_BACKGROUND_WINDOW: '0' }
  let cloud
  let proxy
  let workspace
  let project
  let issue
  const projectPath = () => `/api/v1/cloud-projects/${project.id}`
  const request = async (path, method = 'GET', values) => {
    const response = await fetch(`${cloud.backendUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${cloud.authToken}`, 'Content-Type': 'application/json' },
      ...(values === undefined ? {} : { body: JSON.stringify(values) }),
    })
    const text = await response.text()
    assert.equal(response.ok, true, `${method} ${path}: ${response.status} ${text}`)
    return text ? JSON.parse(text) : null
  }
  const patch = async values => {
    const current = await request(projectPath())
    return request(projectPath(), 'PATCH', { version: current.version, ...values })
  }
  const metadataReads = () =>
    proxy.requests.filter(entry => entry.method === 'GET' && entry.path === projectPath()).length
  const wait = (load, expected, message) => waitForBoardValue(load, expected, message, uiTimeoutMs)
  const expectColumns = async (control, ids) => {
    await wait(
      async () =>
        JSON.parse(await control.command('getTestIdOrder', CONTENT))
          .filter(id => /^cloud-todo-column-(?!add-|dropzone-)/.test(id))
          .map(id => id.slice('cloud-todo-column-'.length)),
      ids,
      'The active board must use the authoritative project column order'
    )
  }
  const waitFresh = control => control.command('waitFor', sync('fresh'), { timeoutMs: uiTimeoutMs })
  const selectTaskTab = async control => {
    await control.command('click', '[data-testid="workspace-tab-select-fixed-task"]')
    await control.command(
      'waitFor',
      '[data-testid="workspace-tab-select-fixed-task"][aria-selected="true"]'
    )
  }
  const selectBoardTab = async control => {
    await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
    await control.command(
      'waitFor',
      '[data-testid="workspace-tab-select-fixed-board"][aria-selected="true"]'
    )
  }

  return {
    requiresCloudEnvironment: true,
    appEnvironment,
    async prepareCloud(environment) {
      cloud = environment
      proxy = await new TransportFaultProxy(cloud.backendUrl).start()
      appEnvironment.WEWORK_E2E_CLOUD_BACKEND_URL = proxy.url
      await request('/api/admin/setup-complete', 'POST')
      workspace = await request('/api/v1/workspaces', 'POST', {
        name: `Project revalidation ${process.pid}`,
      })
      project = await request('/api/v1/cloud-projects', 'POST', {
        workspace_id: workspace.id,
        name: `Project revalidation ${process.pid}`,
        task_provider: 'local',
        visibility: 'private',
      })
      project = await patch({
        tags: ['design', 'develop', 'review'],
        board_views: view('Stages v1', [backlog, design, develop]),
      })
      issue = await request(`${projectPath()}/loop-items`, 'POST', {
        title: 'Keep this Issue visible during revalidation',
        status: 'pending',
        tags: ['design'],
      })
    },
    async verify(control) {
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('setMainWindowSize', 'body', {
        value: JSON.stringify({ width: 1440, height: 1000 }),
      })
      await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await selectBoardTab(control)
      await selectCollaborationDomain(control, CONTENT, 'cloud')
      await control.command('openWeworkScheme', 'body', { value: `wework://boards/${project.id}` })
      await selectCollaborationProjectView(control, CONTENT, 'board')
      await waitFresh(control)
      await expectColumns(control, ['backlog', 'design', 'develop'])
      await control.command(
        'waitFor',
        `${lane('design')} [data-testid="cloud-todo-card-${issue.id}"]`
      )

      // Saving the current view must consume the mutation response without remounting.
      await control.command('click', scoped('[data-testid="board-view-picker"]'))
      await control.command('click', '[data-testid="board-view-edit"]')
      await control.command('fill', '[data-testid="board-view-name"]', {
        value: 'Saved immediately',
      })
      await control.command('click', '[data-testid="board-view-lane-remove-2"]')
      await control.command('clickWhenEnabled', '[data-testid="board-view-save"]')
      await control.command('waitFor', '[data-testid="board-view-editor"]', { visible: false })
      await control.command('waitFor', scoped('[data-testid="board-view-picker"]'), {
        text: 'Saved immediately',
      })
      await expectColumns(control, ['backlog', 'design'])
      const saved = await request(projectPath())
      assert.ok(saved.version > project.version)
      assert.deepEqual(
        saved.board_views.views[0].columns.map(column => column.id),
        ['backlog', 'design']
      )

      // The mounted collaboration tab must revalidate after another page changes metadata.
      await selectTaskTab(control)
      const beforeTabRead = metadataReads()
      const tabUpdate = await patch({
        name: 'Revalidated without closing the tab',
        tags: ['design', 'review'],
        board_views: view('Stages v2', [review, design]),
      })
      await selectBoardTab(control)
      await wait(
        () => metadataReads() > beforeTabRead,
        true,
        'Returning to the board must read project metadata'
      )
      await waitFresh(control)
      await expectColumns(control, ['review', 'design'])
      await control.command('waitFor', scoped('[data-testid="board-view-picker"]'), {
        text: 'Stages v2',
      })

      // Native hidden-to-visible recovery must also refresh the retained renderer.
      await control.command('closeMainWindowToTray', 'body')
      const beforeFocusRead = metadataReads()
      const focusUpdate = await patch({ board_views: view('Stages v3', [design, review, pending]) })
      assert.ok(focusUpdate.version > tabUpdate.version)
      await control.command('focusMainWindow', 'body')
      await wait(
        () => metadataReads() > beforeFocusRead,
        true,
        'Restoring the window must read project metadata'
      )
      await waitFresh(control)
      await expectColumns(control, ['design', 'review', 'todo'])

      // Failed revalidation retains the last successful board but disables structural edits.
      await selectTaskTab(control)
      const recoveryUpdate = await patch({ board_views: view('Stages v4', [review]) })
      const beforeFailure = proxy.requests.length
      proxy.rule = entry =>
        entry.method === 'GET' && entry.path === projectPath() ? 'drop-response' : null
      await selectBoardTab(control)
      await control.command('waitFor', sync('stale'), { timeoutMs: uiTimeoutMs })
      assert.ok(
        proxy.requests
          .slice(beforeFailure)
          .some(entry => entry.path === projectPath() && entry.dropped),
        'A real project response must have been interrupted'
      )
      await expectColumns(control, ['design', 'review', 'todo'])
      await control.command(
        'waitFor',
        `${lane('design')} [data-testid="cloud-todo-card-${issue.id}"]`
      )
      await control.command('click', scoped('[data-testid="board-view-picker"]'))
      await control.command('waitFor', '[data-testid="board-view-new"]:disabled')
      await control.command('waitFor', '[data-testid="board-view-edit"]:disabled')
      await control.command('press', scoped('[data-testid="board-view-picker"]'), { key: 'Escape' })
      await control.command(
        'waitFor',
        scoped('[data-testid="collaboration-issue-create"]:disabled')
      )

      proxy.rule = () => null
      await control.command('clickWhenEnabled', scoped('[data-testid="project-snapshot-retry"]'))
      await waitFresh(control)
      await expectColumns(control, ['review'])
      await control.command('waitFor', scoped('[data-testid="board-view-picker"]'), {
        text: 'Stages v4',
      })
      assert.equal((await request(projectPath())).version, recoveryUpdate.version)
    },
    async cleanup() {
      try {
        try {
          if (project) {
            const current = await request(projectPath())
            await request(`${projectPath()}?version=${current.version}`, 'DELETE')
          }
        } finally {
          if (workspace) {
            const current = await request(`/api/v1/workspaces/${workspace.id}`)
            await request(`/api/v1/workspaces/${workspace.id}?version=${current.version}`, 'DELETE')
          }
        }
      } finally {
        await proxy?.stop()
      }
    },
  }
}
