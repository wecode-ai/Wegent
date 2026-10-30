// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict'
import { dragBoardCard, waitForBoardValue } from '../modules/collaboration-board-flows.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { createCollaborationBoardIssue } from '../modules/collaboration-board-issue.mjs'
import {
  configureFirstProjectExecutionEnvironment,
  createLocalCollaborationProject,
  enterLocalCollaborationWorkspace,
  inCollaborationSidebar,
  reloadMainWindow,
  selectCollaborationDomain,
} from '../modules/workspace-flows.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const scoped = selector => `${CONTENT} ${selector}`
const lane = key => scoped(`[data-testid="cloud-todo-column-${key}"]`)
const card = id => `[data-testid="cloud-todo-card-${id}"]`

export function createDesktopScenario({ uiTimeoutMs, workbenchReadyTimeoutMs }) {
  let cloud
  let workspace
  let project
  const request = async (path, method = 'GET', values) => {
    const response = await fetch(`${cloud.backendUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${cloud.authToken}`, 'Content-Type': 'application/json' },
      ...(values === undefined ? {} : { body: JSON.stringify(values) }),
    })
    const body = await response.text()
    assert.equal(response.ok, true, `${method} ${path}: ${response.status} ${body}`)
    return body ? JSON.parse(body) : null
  }
  const wait = (load, expected, message) => waitForBoardValue(load, expected, message, uiTimeoutMs)
  const expectCard = (control, key, id, visible = true) =>
    control.command('waitFor', `${lane(key)} ${card(id)}`, { visible, timeoutMs: uiTimeoutMs })

  async function openCloud(control) {
    await control.command('openWeworkScheme', 'body', { value: `wework://boards/${project.id}` })
    await control.command('waitFor', scoped('[data-testid="board-view-picker"]'), {
      timeoutMs: workbenchReadyTimeoutMs,
    })
  }

  async function createView(control) {
    await control.command('click', scoped('[data-testid="board-view-picker"]'))
    await control.command('click', '[data-testid="board-view-new"]')
    await control.command('fill', '[data-testid="board-view-name"]', {
      value: 'Backlog regression',
    })
    const testIds = JSON.parse(
      await control.command('getTestIdOrder', '[data-testid="board-view-editor"]')
    )
    const laneCount = testIds.filter(id => /^board-view-lane-\d+$/.test(id)).length
    assert.ok(laneCount > 0)
    for (let index = 0; index < laneCount; index += 1) {
      await control.command('click', '[data-testid="board-view-lane-remove-0"]')
    }
    await control.command('click', '[data-testid="board-view-add-lane"]')
    await control.command('select', '[data-testid="board-view-lane-type-0"]', {
      value: 'unmatched',
    })
    await control.command('fill', '[data-testid="board-view-lane-value-0"]', { value: '待规划' })
    for (const [index, tag] of [
      [1, 'design'],
      [2, 'develop'],
    ]) {
      await control.command('click', '[data-testid="board-view-add-lane"]')
      await control.command('click', `[data-testid="board-view-lane-value-${index}"]`)
      await control.command('fill', `[data-testid="board-view-lane-value-${index}-search"]`, {
        value: tag,
      })
      await control.command('click', `[data-testid="board-view-lane-value-${index}-create"]`)
    }
    await control.command('click', '[data-testid="board-view-set-default"]')
    await control.command('click', '[data-testid="board-view-save"]')
    await control.command('waitFor', '[data-testid="board-view-editor"]', {
      visible: false,
      timeoutMs: uiTimeoutMs,
    })
    const ids = JSON.parse(await control.command('getTestIdOrder', CONTENT))
      .filter(
        id =>
          id.startsWith('cloud-todo-column-') &&
          !id.startsWith('cloud-todo-column-add-') &&
          !id.startsWith('cloud-todo-column-dropzone-')
      )
      .map(id => id.slice('cloud-todo-column-'.length))
    assert.equal(ids.length, 3, 'The saved view must show Backlog and two stage lanes')
    return ids
  }

  async function createFromBacklog(control, backlog, title, expectedParentId = null) {
    await control.command('click', scoped('[data-testid="cloud-todo-column-add-' + backlog + '"]'))
    const dialog = scoped('[data-testid="collaboration-issue-create-dialog"]')
    await control.command('waitFor', dialog, { timeoutMs: uiTimeoutMs })
    await control.command('fill', dialog + ' [data-testid="cloud-todo-title"]', {
      value: title,
    })
    await control.command(
      'clickWhenEnabled',
      dialog + ' [data-testid="cloud-todo-create-confirm"]',
      { timeoutMs: uiTimeoutMs }
    )
    await control.command('waitFor', scoped('[data-testid="collaboration-issue-detail"]'), {
      text: title,
      timeoutMs: uiTimeoutMs,
    })
    await control.command('click', scoped('[data-testid="cloud-todo-detail-close"]'))
    await control.command('waitFor', lane(backlog), {
      text: title,
      timeoutMs: uiTimeoutMs,
    })
    const snapshot = await request('/api/v1/cloud-projects/' + project.id + '/board-snapshot')
    const created = snapshot.items.find(issue => issue.title === title)
    assert.ok(created)
    assert.deepEqual(created.tags, ['bug'])
    await expectCard(control, backlog, created.id)
    assert.equal(created.parent_id, expectedParentId)
    return created
  }

  const move = async (control, id, from, to) => {
    await dragBoardCard(
      control,
      `${lane(from)} ${card(id)}`,
      scoped(`[data-testid="cloud-todo-column-dropzone-${to}"]`),
      uiTimeoutMs
    )
    await expectCard(control, to, id)
    await expectCard(control, from, id, false)
  }

  async function verifyLocal(control) {
    const name = `Local Backlog ${process.pid}`
    await selectCollaborationDomain(control, CONTENT, 'local')
    await createLocalCollaborationProject(control, CONTENT, name)
    await configureFirstProjectExecutionEnvironment(control, CONTENT, uiTimeoutMs)
    await control.command('click', scoped('[data-testid="collaboration-tab-board"]'))
    const id = await createCollaborationBoardIssue(
      control,
      'Local unplanned Issue',
      'inbox',
      uiTimeoutMs
    )
    const [backlog, design, develop] = await createView(control)
    await expectCard(control, backlog, id)
    await move(control, id, backlog, design)
    await move(control, id, design, develop)
    await move(control, id, develop, backlog)
    await reloadMainWindow(control, 'Local Backlog did not reopen')
    await enterLocalCollaborationWorkspace(control, CONTENT)
    await control.command(
      'markElementWithText',
      inCollaborationSidebar('[data-testid^="collaboration-workspace-project-"]'),
      { text: name, value: 'local-backlog-project', timeoutMs: uiTimeoutMs }
    )
    await control.command('click', '[data-e2e-anchor-id="local-backlog-project"]')
    await expectCard(control, backlog, id)
  }

  return {
    requiresCloudEnvironment: true,
    async prepareCloud(environment) {
      cloud = environment
      await request('/api/admin/setup-complete', 'POST')
      workspace = await request('/api/v1/workspaces', 'POST', { name: `Backlog ${process.pid}` })
      project = await request('/api/v1/cloud-projects', 'POST', {
        workspace_id: workspace.id,
        name: `Backlog ${process.pid}`,
        task_provider: 'local',
        visibility: 'private',
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
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await selectCollaborationDomain(control, CONTENT, 'cloud')
      await openCloud(control)
      const [backlog, design, develop] = await createView(control)
      const saved = await request(`/api/v1/cloud-projects/${project.id}`)
      const view = saved.board_views.views[0]
      assert.equal(view.columns[0].type, 'unmatched')
      assert.equal(view.columns[0].value, '待规划')
      assert.equal(saved.board_views.default_view_id, view.id)
      // A real newly created Issue automatically belongs to Backlog.
      const id = await createCollaborationBoardIssue(
        control,
        'New unplanned Issue',
        'inbox',
        uiTimeoutMs
      )
      await expectCard(control, backlog, id)
      await move(control, id, backlog, design)
      await wait(
        async () => (await request(`/api/v1/loop-items/${id}`)).tags,
        ['design'],
        'Entering a stage must persist its tag'
      )
      // Multiple stage tags disappear on return, while a business tag and status survive.
      const before = await request(`/api/v1/loop-items/${id}`)
      await request(`/api/v1/loop-items/${id}`, 'PATCH', {
        version: before.version,
        tags: ['design', 'develop', 'bug'],
        status: 'completed',
      })
      await reloadMainWindow(control, 'Multi-tag fixture did not reload')
      await openCloud(control)
      await expectCard(control, design, id)
      await expectCard(control, develop, id)
      await expectCard(control, backlog, id, false)
      await move(control, id, design, backlog)
      await expectCard(control, develop, id, false)
      await wait(
        async () => {
          const current = await request(`/api/v1/loop-items/${id}`)
          return { tags: current.tags, status: current.status }
        },
        { tags: ['bug'], status: 'completed' },
        'Backlog must preserve business tags and status'
      )
      await reloadMainWindow(control, 'Backlog view and membership did not persist')
      await openCloud(control)
      await expectCard(control, backlog, id)
      // Filtering applies to Backlog too; lane creation supplies the required business tag.
      await control.command('click', scoped('[data-testid="board-view-picker"]'))
      await control.command('click', '[data-testid="board-view-edit"]')
      await control.command('click', '[data-testid="board-view-filter-tag-bug"]')
      await control.command('click', '[data-testid="board-view-save"]')
      await control.command('waitFor', '[data-testid="board-view-editor"]', {
        visible: false,
        timeoutMs: uiTimeoutMs,
      })
      await createFromBacklog(control, backlog, 'Filtered Backlog creation')
      const issuePath = '/api/v1/cloud-projects/' + project.id + '/loop-items'
      const parent = await request(issuePath, 'POST', { title: 'Backlog parent', tags: ['bug'] })
      await request(issuePath, 'POST', {
        title: 'Existing Backlog child',
        parent_id: parent.id,
        tags: ['bug'],
      })
      await reloadMainWindow(control, 'Backlog child fixtures did not reload')
      await openCloud(control)
      await control.command(
        'click',
        scoped('[data-testid="collaboration-issue-children-' + parent.id + '"]')
      )
      await control.command('waitFor', lane(backlog), {
        text: 'Existing Backlog child',
        timeoutMs: uiTimeoutMs,
      })
      await createFromBacklog(control, backlog, 'Child Backlog creation', parent.id)
      await verifyLocal(control)
    },
    async cleanup() {
      try {
        if (project) {
          const current = await request(`/api/v1/cloud-projects/${project.id}`)
          await request(`/api/v1/cloud-projects/${project.id}?version=${current.version}`, 'DELETE')
        }
      } finally {
        if (workspace) {
          const current = await request(`/api/v1/workspaces/${workspace.id}`)
          await request(`/api/v1/workspaces/${workspace.id}?version=${current.version}`, 'DELETE')
        }
      }
    },
  }
}
