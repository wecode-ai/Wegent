// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  createLocalCollaborationProject,
  configureFirstProjectExecutionEnvironment,
  enterLocalCollaborationWorkspace,
  inCollaborationSidebar,
  reloadMainWindow,
  selectCollaborationDomain,
} from '../modules/workspace-flows.mjs'

import { createCollaborationBoardIssue } from '../modules/collaboration-board-issue.mjs'
import {
  dragBoardCard,
  waitForBoardValue as waitForValue,
} from '../modules/collaboration-board-flows.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const scoped = selector => `${CONTENT} ${selector}`
const laneSelector = lane => scoped(`[data-testid="cloud-todo-column-${lane}"]`)
const sortId = lane => `cloud-board-sort-by-${lane}`
const sortSelector = lane => scoped(`[data-testid="${sortId(lane)}"]`)
const cardSelector = id => scoped(`[data-testid="cloud-todo-card-${id}"]`)
const dropSelector = id => scoped(`[data-testid="cloud-todo-card-drop-${id}"]`)

async function dragCard(control, id, beforeId, timeoutMs, sourceLane, targetLane = sourceLane) {
  const source = sourceLane
    ? `${laneSelector(sourceLane)} [data-testid="cloud-todo-card-${id}"]`
    : cardSelector(id)
  const target = targetLane
    ? `${laneSelector(targetLane)} [data-testid="cloud-todo-card-drop-${beforeId}"]`
    : dropSelector(beforeId)
  await dragBoardCard(control, source, target, timeoutMs)
}

async function dragToLaneTail(control, id, lane, timeoutMs) {
  const source = `${laneSelector(lane)} [data-testid="cloud-todo-card-${id}"]`
  const content = scoped(`[data-testid="cloud-todo-column-dropzone-${lane}-content"]`)
  await control.command('scrollIntoView', source)
  const [from] = JSON.parse(await control.command('getElementMetrics', source))
  const [to] = JSON.parse(await control.command('getElementMetrics', content))
  // Left padding belongs to the column but never intersects a card insertion target.
  await control.command('dragBy', source, {
    value: JSON.stringify({
      x: to.left + 2 - Math.floor(from.left + from.width / 2),
      y: to.bottom - 2 - Math.floor(from.top + from.height / 2),
    }),
  })
  await control.command('waitFor', '[data-testid="project-board-drag-overlay"]', {
    visible: false,
    timeoutMs,
  })
}

export function createDesktopScenario({ uiTimeoutMs, workbenchReadyTimeoutMs }) {
  let cloud
  let workspace
  let project
  const issues = []
  const request = async (path, method = 'GET', values) => {
    const response = await fetch(`${cloud.backendUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${cloud.authToken}`,
        'Content-Type': 'application/json',
      },
      ...(values === undefined ? {} : { body: JSON.stringify(values) }),
    })
    const text = await response.text()
    assert.equal(response.ok, true, `${method} ${path}: ${response.status} ${text}`)
    return text ? JSON.parse(text) : null
  }
  const issuePath = () => `/api/v1/cloud-projects/${project.id}/loop-items`
  const snapshot = () => request(`/api/v1/cloud-projects/${project.id}/board-snapshot`)
  const serverOrder = async lane =>
    (await snapshot()).items
      .filter(item => item.status === lane)
      .sort((a, b) => a.sort_order - b.sort_order)
      .map(item => item.id)
  const serverState = async () =>
    (await snapshot()).items
      .map(({ id, version, status, sort_order }) => ({ id, version, status, sort_order }))
      .sort((a, b) => a.id.localeCompare(b.id))

  async function createIssue(title, priority, status = 'pending') {
    // Separate real database timestamps, which have second precision.
    if (issues.length) await new Promise(resolve => setTimeout(resolve, 1_100))
    const issue = await request(issuePath(), 'POST', { title, priority, status })
    if (issues.length) {
      assert.ok(Date.parse(issue.created_at) > Date.parse(issues.at(-1).created_at))
    }
    issues.push(issue)
    return issue
  }

  async function expectOrder(control, lane, ids) {
    await control.command('waitFor', laneSelector(lane), { timeoutMs: uiTimeoutMs })
    await waitForValue(
      async () =>
        JSON.parse(await control.command('getTestIdOrder', laneSelector(lane)))
          .filter(id => id.startsWith('cloud-todo-card-drop-'))
          .map(id => id.slice('cloud-todo-card-drop-'.length)),
      ids,
      `Unexpected visible order in ${lane}`,
      uiTimeoutMs
    )
  }

  async function expectRules(control, lane, rules) {
    await control.command('waitFor', sortSelector(lane), { timeoutMs: uiTimeoutMs })
    await waitForValue(
      () => control.command('getAttribute', sortSelector(lane), { value: 'data-sort-rules' }),
      rules,
      `Unexpected sort rules in ${lane}`,
      uiTimeoutMs
    )
  }

  async function editRules(control, lane, actions) {
    await control.command('scrollIntoView', sortSelector(lane))
    await control.command('click', sortSelector(lane))
    for (const action of actions) {
      await control.command('click', `[data-testid="${sortId(lane)}-${action}"]`)
    }
    await control.command('click', sortSelector(lane))
  }

  async function openBoard(control) {
    await control.command('openWeworkScheme', 'body', { value: `wework://boards/${project.id}` })
    await control.command('waitFor', scoped('[data-testid="collaboration-tab-board"]'), {
      timeoutMs: workbenchReadyTimeoutMs,
    })
    await control.command('click', scoped('[data-testid="collaboration-tab-board"]'))
    await control.command('waitFor', scoped('[data-testid="board-view-picker"]'), {
      timeoutMs: uiTimeoutMs,
    })
  }

  async function verifySavedMixedView(control, issue) {
    const before = (await snapshot()).items.find(item => item.id === issue.id)
    await request(`/api/v1/loop-items/${issue.id}`, 'PATCH', {
      version: before.version,
      status: 'completed',
      tags: ['shared'],
    })
    await reloadMainWindow(control, 'Saved view fixtures did not reload')
    await openBoard(control)
    await control.command('click', scoped('[data-testid="board-view-picker"]'))
    await control.command('click', '[data-testid="board-view-new"]')
    await control.command('fill', '[data-testid="board-view-name"]', { value: 'Mixed regression' })
    for (let index = 0; index < 4; index += 1) {
      await control.command('click', '[data-testid="board-view-lane-remove-0"]')
    }
    for (const [index, tag] of [
      [1, 'alpha'],
      [2, 'beta'],
    ]) {
      await control.command('click', '[data-testid="board-view-add-lane"]')
      await control.command('click', `[data-testid="board-view-lane-value-${index}"]`)
      await control.command('fill', `[data-testid="board-view-lane-value-${index}-search"]`, {
        value: tag,
      })
      await control.command('click', `[data-testid="board-view-lane-value-${index}-create"]`)
    }
    await control.command('click', '[data-testid="board-view-add-lane"]')
    await control.command('select', '[data-testid="board-view-lane-type-3"]', { value: 'status' })
    await control.command('select', '[data-testid="board-view-lane-value-3"]', { value: 'pending' })
    await control.command('click', '[data-testid="board-view-set-default"]')
    await control.command('click', '[data-testid="board-view-save"]')
    await control.command('waitFor', '[data-testid="board-view-editor"]', {
      visible: false,
      timeoutMs: uiTimeoutMs,
    })
    const current = await request(`/api/v1/cloud-projects/${project.id}`)
    const view = current.board_views.views.find(view => view.name === 'Mixed regression')
    assert.ok(view, 'The mixed view must be saved in project metadata')
    assert.equal(current.board_views.default_view_id, view.id)
    await control.command('click', scoped('[data-testid="board-view-picker"]'))
    await control.command('click', '[data-testid="board-view-edit"]')
    await control.command('waitFor', '[data-testid="board-view-editor"]', {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('click', '[data-testid="board-view-cancel"]')
    const [done, alpha, beta, pending] = view.columns.map(column => column.id)
    await control.command('waitFor', scoped('p[role="status"]'), {
      visible: false,
      timeoutMs: uiTimeoutMs,
    })
    const move = async (source, target) =>
      dragBoardCard(
        control,
        `${laneSelector(source)} [data-testid="cloud-todo-card-${issue.id}"]`,
        scoped(`[data-testid="cloud-todo-column-dropzone-${target}-content"]`),
        uiTimeoutMs
      )
    const assertItem = async (status, tags) =>
      waitForValue(
        async () => {
          const saved = (await snapshot()).items.find(item => item.id === issue.id)
          return { status: saved.status, tags: saved.tags }
        },
        { status, tags },
        'Mixed drag changed unrelated fields',
        uiTimeoutMs
      )
    await move(done, alpha)
    await assertItem('completed', ['shared', 'alpha'])
    for (const column of [done, alpha])
      await control.command(
        'waitFor',
        `${laneSelector(column)} [data-testid="cloud-todo-card-${issue.id}"]`,
        { timeoutMs: uiTimeoutMs }
      )
    await control.command('waitFor', scoped('[data-testid="board-drop-feedback"]'), {
      timeoutMs: uiTimeoutMs,
    })
    await move(alpha, beta)
    await assertItem('completed', ['shared', 'beta'])
    await control.command(
      'waitFor',
      `${laneSelector(alpha)} [data-testid="cloud-todo-card-${issue.id}"]`,
      { visible: false, timeoutMs: uiTimeoutMs }
    )
    await move(beta, pending)
    await assertItem('pending', ['shared', 'beta'])
    await move(pending, done)
    await assertItem('completed', ['shared', 'beta'])
    await reloadMainWindow(control, 'The saved mixed view did not survive reload')
    await openBoard(control)
    await control.command('waitFor', scoped('[data-testid="board-view-picker"]'), {
      text: 'Mixed regression',
    })
    for (const column of [done, beta])
      await control.command(
        'waitFor',
        `${laneSelector(column)} [data-testid="cloud-todo-card-${issue.id}"]`,
        { timeoutMs: uiTimeoutMs }
      )
    await control.command('click', scoped('[data-testid="board-view-picker"]'))
    await control.command('click', '[data-testid="board-view-edit"]')
    await control.command('click', '[data-testid="board-view-delete"]')
    await control.command('click', '[data-testid="board-view-delete"]')
    await control.command('waitFor', '[data-testid="board-view-editor"]', {
      visible: false,
      timeoutMs: uiTimeoutMs,
    })
    assert.deepEqual((await request(`/api/v1/cloud-projects/${project.id}`)).board_views.views, [])
    assert.equal(
      (await request(`/api/v1/cloud-projects/${project.id}`)).board_views.default_view_id,
      'default'
    )
    await assertItem('completed', ['shared', 'beta'])
  }

  async function verifyLocalBoard(control) {
    const name = `Local board sorting ${process.pid}`
    await selectCollaborationDomain(control, CONTENT, 'local')
    await createLocalCollaborationProject(control, CONTENT, name)
    await configureFirstProjectExecutionEnvironment(control, CONTENT, uiTimeoutMs)
    await control.command('click', scoped('[data-testid="collaboration-tab-board"]'))
    const first = await createCollaborationBoardIssue(
      control,
      'Older local card',
      'pending',
      uiTimeoutMs
    )
    await new Promise(resolve => setTimeout(resolve, 1_100))
    const completed = await createCollaborationBoardIssue(
      control,
      'Completed local card',
      'completed',
      uiTimeoutMs
    )
    await new Promise(resolve => setTimeout(resolve, 1_100))
    const last = await createCollaborationBoardIssue(
      control,
      'Newer local card',
      'pending',
      uiTimeoutMs
    )
    const reopen = async () => {
      await reloadMainWindow(control, 'Local board did not reopen')
      await enterLocalCollaborationWorkspace(control, CONTENT)
      await control.command(
        'markElementWithText',
        inCollaborationSidebar('[data-testid^="collaboration-workspace-project-"]'),
        { text: name, value: 'local-sorting-project', timeoutMs: uiTimeoutMs }
      )
      await control.command('click', '[data-e2e-anchor-id="local-sorting-project"]')
      await control.command('waitFor', scoped('[data-testid="collaboration-tab-board"]'), {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', scoped('[data-testid="collaboration-tab-board"]'))
    }
    await expectRules(control, 'pending', 'priority-desc')
    await editRules(control, 'pending', ['manual'])
    await dragCard(control, last, first, uiTimeoutMs, 'pending')
    await expectOrder(control, 'pending', [last, first])
    await editRules(control, 'pending', ['add', 'add', 'rule-1-mode', 'rule-1-mode-created-asc'])
    await expectOrder(control, 'pending', [first, last])
    await reopen()
    await expectRules(control, 'pending', 'priority-desc,created-asc')
    await expectOrder(control, 'pending', [first, last])
    await editRules(control, 'pending', ['manual'])
    await expectOrder(control, 'pending', [last, first])
    await dragCard(control, completed, first, uiTimeoutMs, 'completed', 'pending')
    await expectOrder(control, 'pending', [last, completed, first])
    await reopen()
    await expectRules(control, 'pending', 'manual')
    await expectOrder(control, 'pending', [last, completed, first])
    await dragToLaneTail(control, last, 'pending', uiTimeoutMs)
    await expectOrder(control, 'pending', [completed, first, last])
    await reopen()
    await expectOrder(control, 'pending', [completed, first, last])
    await dragCard(control, last, completed, uiTimeoutMs, 'pending')
    await expectOrder(control, 'pending', [last, completed, first])
    for (const [groupBy, lane] of [
      ['priority', 'priority-none'],
      ['assignee', 'assignee-unassigned'],
      ['tag', 'tag-untagged'],
    ]) {
      await control.command('click', scoped('[data-testid="cloud-board-group-by"]'))
      await control.command('click', `[data-testid="cloud-board-group-option-${groupBy}"]`)
      await expectRules(control, lane, 'priority-desc')
      await editRules(control, lane, ['manual'])
      await expectOrder(control, lane, [last, completed, first])
      await dragCard(control, first, last, uiTimeoutMs, lane)
      await expectOrder(control, lane, [first, last, completed])
      await reopen()
      await expectRules(control, lane, 'manual')
      await expectOrder(control, lane, [first, last, completed])
      // Restore the same fixture order for the next grouping through a real drag.
      await dragCard(control, first, completed, uiTimeoutMs, lane)
      await dragCard(control, completed, first, uiTimeoutMs, lane)
      await expectOrder(control, lane, [last, completed, first])
    }
  }

  return {
    requiresCloudEnvironment: true,

    async prepareCloud(environment) {
      cloud = environment
      await request('/api/admin/setup-complete', 'POST')
      workspace = await request('/api/v1/workspaces', 'POST', {
        name: `Desktop board sorting ${process.pid}`,
      })
      project = await request('/api/v1/cloud-projects', 'POST', {
        workspace_id: workspace.id,
        name: `Independent lane sorting ${process.pid}`,
        task_provider: 'local',
        visibility: 'private',
      })
      const low = await createIssue('Low priority', 'low')
      const high = await createIssue('Older high priority', 'high')
      const urgent = await createIssue('Urgent priority', 'urgent')
      const newerHigh = await createIssue('Newer high priority', 'high')
      const completedHigh = await createIssue('Completed high priority', 'high', 'completed')
      const completedUrgent = await createIssue('Completed urgent priority', 'urgent', 'completed')
      for (const [status, item_ids] of [
        ['pending', [low.id, newerHigh.id, high.id, urgent.id]],
        ['completed', [completedHigh.id, completedUrgent.id]],
      ]) {
        await request(`${issuePath()}/reorder`, 'POST', { parent_id: null, status, item_ids })
      }
    },

    async verify(control) {
      const [low, high, urgent, newerHigh, completedHigh, completedUrgent] = issues
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('setMainWindowSize', 'body', {
        value: JSON.stringify({ width: 1440, height: 1000 }),
      })
      await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await selectCollaborationDomain(control, CONTENT, 'cloud')
      await openBoard(control)
      for (const lane of ['inbox', 'pending', 'in_progress', 'in_review', 'completed']) {
        await expectRules(control, lane, 'priority-desc')
      }
      await expectOrder(control, 'pending', [urgent.id, newerHigh.id, high.id, low.id])
      await expectOrder(control, 'completed', [completedUrgent.id, completedHigh.id])

      await editRules(control, 'pending', ['add', 'rule-1-mode', 'rule-1-mode-created-asc'])
      await editRules(control, 'completed', ['rule-0-mode', 'rule-0-mode-created-asc'])
      await expectRules(control, 'pending', 'priority-desc,created-asc')
      await expectRules(control, 'completed', 'created-asc')
      await expectOrder(control, 'pending', [urgent.id, high.id, newerHigh.id, low.id])
      await expectOrder(control, 'completed', [completedHigh.id, completedUrgent.id])

      await reloadMainWindow(control, 'The sorting scenario window did not reopen')
      await openBoard(control)
      await expectRules(control, 'pending', 'priority-desc,created-asc')
      await expectRules(control, 'completed', 'created-asc')
      await expectOrder(control, 'pending', [urgent.id, high.id, newerHigh.id, low.id])
      await expectOrder(control, 'completed', [completedHigh.id, completedUrgent.id])

      await editRules(control, 'pending', ['rule-1-up'])
      await expectOrder(control, 'pending', [low.id, high.id, urgent.id, newerHigh.id])
      await editRules(control, 'pending', ['rule-0-down'])
      await expectOrder(control, 'pending', [urgent.id, high.id, newerHigh.id, low.id])

      const updatedAsc = [newerHigh.id, low.id, urgent.id, high.id]
      for (const id of updatedAsc) {
        await new Promise(resolve => setTimeout(resolve, 1_100))
        const current = await request(`/api/v1/loop-items/${id}`)
        await request(`/api/v1/loop-items/${id}`, 'PATCH', {
          version: current.version,
          description: `Updated ${id}`,
        })
      }
      await reloadMainWindow(control, 'Updated-time sorting fixtures did not reload')
      await openBoard(control)
      await editRules(control, 'pending', ['rule-1-remove'])
      const createdAsc = [low.id, high.id, urgent.id, newerHigh.id]
      for (const [mode, expected] of [
        ['priority-asc', [low.id, newerHigh.id, high.id, urgent.id]],
        ['priority-desc', [urgent.id, newerHigh.id, high.id, low.id]],
        ['created-asc', createdAsc],
        ['created-desc', [...createdAsc].reverse()],
        ['updated-asc', updatedAsc],
        ['updated-desc', [...updatedAsc].reverse()],
      ]) {
        await editRules(control, 'pending', ['rule-0-mode', `rule-0-mode-${mode}`])
        await expectRules(control, 'pending', mode)
        await expectOrder(control, 'pending', expected)
      }
      await editRules(control, 'pending', [
        'rule-0-mode',
        'rule-0-mode-priority-desc',
        'add',
        'rule-1-mode',
        'rule-1-mode-created-asc',
      ])

      // A real, activated drag in an automatic lane must leave server order untouched.
      const beforeAutomaticDrag = await serverState()
      await dragCard(control, low.id, urgent.id, uiTimeoutMs)
      await expectOrder(control, 'pending', [urgent.id, high.id, newerHigh.id, low.id])
      assert.deepEqual(await serverState(), beforeAutomaticDrag)

      await editRules(control, 'pending', ['manual'])
      await expectOrder(control, 'pending', [low.id, newerHigh.id, high.id, urgent.id])
      await dragCard(control, urgent.id, low.id, uiTimeoutMs)
      const manualOrder = [urgent.id, low.id, newerHigh.id, high.id]
      await expectOrder(control, 'pending', manualOrder)
      await waitForValue(
        () => serverOrder('pending'),
        manualOrder,
        'Manual drag was not saved',
        uiTimeoutMs
      )

      // Automatic destinations append on the server and display by their own rules.
      await dragCard(control, urgent.id, completedHigh.id, uiTimeoutMs)
      await expectOrder(control, 'completed', [urgent.id, completedHigh.id, completedUrgent.id])
      await waitForValue(
        () => serverOrder('completed'),
        [completedHigh.id, completedUrgent.id, urgent.id],
        'Cross-lane drag into an automatic lane did not append',
        uiTimeoutMs
      )
      await expectOrder(control, 'pending', [low.id, newerHigh.id, high.id])

      // Manual destinations honor the card insertion target, including cross-lane moves.
      await dragCard(control, completedHigh.id, low.id, uiTimeoutMs)
      const finalPending = [completedHigh.id, low.id, newerHigh.id, high.id]
      await expectOrder(control, 'pending', finalPending)
      await waitForValue(
        () => serverOrder('pending'),
        finalPending,
        'Cross-lane insertion was not saved',
        uiTimeoutMs
      )
      await expectOrder(control, 'completed', [urgent.id, completedUrgent.id])
      await reloadMainWindow(control, 'The manual lane order did not survive reopening')
      await openBoard(control)
      await expectRules(control, 'pending', 'manual')
      await expectRules(control, 'completed', 'created-asc')
      await expectOrder(control, 'pending', finalPending)
      await expectOrder(control, 'completed', [urgent.id, completedUrgent.id])

      // Every non-status lane spans pending/completed Issues and uses the same save path.
      for (const groupBy of ['priority', 'assignee', 'tag']) {
        assert.ok(project.current_user_id, 'The project must identify the current user')
        const currentItems = (await snapshot()).items
        for (const item of currentItems) {
          const outside = item.id === low.id
          await request(`/api/v1/loop-items/${item.id}`, 'PATCH', {
            version: item.version,
            priority: outside ? 'low' : 'high',
            assignee_user_id: outside ? project.current_user_id : null,
            tags: outside ? ['other'] : ['backend', 'shared'],
          })
        }
        const tail = [newerHigh.id, completedHigh.id, urgent.id]
        const original = [high.id, completedUrgent.id, ...tail]
        await request(`${issuePath()}/reorder`, 'POST', {
          parent_id: null,
          status: null,
          item_ids: [...original, low.id],
        })
        await reloadMainWindow(control, 'The non-status sorting fixtures did not reload')
        await openBoard(control)
        await control.command('click', scoped('[data-testid="cloud-board-group-by"]'))
        await control.command('click', `[data-testid="cloud-board-group-option-${groupBy}"]`)
        const lane =
          groupBy === 'priority'
            ? 'priority-high'
            : groupBy === 'assignee'
              ? 'assignee-unassigned'
              : 'tag-shared'
        const outsideLane =
          groupBy === 'priority'
            ? 'priority-low'
            : groupBy === 'assignee'
              ? `assignee-${project.current_user_id}`
              : 'tag-other'
        await expectRules(control, lane, 'priority-desc')
        await expectOrder(control, lane, original)
        const before = await serverState()
        await dragCard(control, completedUrgent.id, high.id, uiTimeoutMs, lane)
        await expectOrder(control, lane, original)
        assert.deepEqual(await serverState(), before)
        await editRules(control, lane, ['manual'])
        await dragCard(control, completedUrgent.id, high.id, uiTimeoutMs, lane)
        const reordered = [completedUrgent.id, high.id, ...tail]
        await expectOrder(control, lane, reordered)
        const savedOrder = async () =>
          (await snapshot()).items.sort((a, b) => a.sort_order - b.sort_order).map(item => item.id)
        await waitForValue(
          savedOrder,
          [...reordered, low.id],
          'Non-status manual order was not saved',
          uiTimeoutMs
        )
        await reloadMainWindow(control, 'The non-status manual order did not survive reopening')
        await openBoard(control)
        await expectRules(control, lane, 'manual')
        await expectOrder(control, lane, reordered)
        await dragCard(control, low.id, high.id, uiTimeoutMs, outsideLane, lane)
        const final = [completedUrgent.id, low.id, high.id, ...tail]
        await expectOrder(control, lane, final)
        await waitForValue(
          savedOrder,
          final,
          'Non-status cross-lane insertion was not saved',
          uiTimeoutMs
        )
        await reloadMainWindow(control, 'The non-status cross-lane order did not survive reopening')
        await openBoard(control)
        await expectOrder(control, lane, final)
        const saved = (await snapshot()).items.find(item => item.id === completedUrgent.id)
        assert.equal(saved.status, 'completed')
        assert.deepEqual(saved.tags, ['backend', 'shared'])
        assert.equal(saved.assignee_user_id, null)
      }
      await verifySavedMixedView(control, completedUrgent)
      await verifyLocalBoard(control)
    },

    async cleanup() {
      try {
        if (project) {
          const current = await request(`/api/v1/cloud-projects/${project.id}`)
          await request(`/api/v1/cloud-projects/${project.id}?version=${current.version}`, 'DELETE')
          project = null
        }
      } finally {
        if (workspace) {
          const current = await request(`/api/v1/workspaces/${workspace.id}`)
          await request(`/api/v1/workspaces/${workspace.id}?version=${current.version}`, 'DELETE')
          workspace = null
        }
      }
    },
  }
}
