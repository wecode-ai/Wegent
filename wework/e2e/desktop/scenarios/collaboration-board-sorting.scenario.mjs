// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { reloadMainWindow, selectCollaborationDomain } from '../modules/workspace-flows.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const scoped = selector => `${CONTENT} ${selector}`
const laneSelector = lane => scoped(`[data-testid="cloud-todo-column-${lane}"]`)
const sortId = lane => `cloud-board-sort-by-${lane}`
const sortSelector = lane => scoped(`[data-testid="${sortId(lane)}"]`)
const cardSelector = id => scoped(`[data-testid="cloud-todo-card-${id}"]`)
const dropSelector = id => scoped(`[data-testid="cloud-todo-card-drop-${id}"]`)

async function waitForValue(load, expected, message, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let actual
  while (Date.now() < deadline) {
    actual = await load()
    if (JSON.stringify(actual) === JSON.stringify(expected)) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.deepEqual(actual, expected, message)
}

async function dragCard(control, id, beforeId, timeoutMs) {
  const source = cardSelector(id)
  const target = dropSelector(beforeId)
  await control.command('scrollIntoView', source)
  await control.command('scrollIntoView', target)
  await control.command('dragStart', source, { target })
  try {
    await control.command('waitFor', '[data-testid="project-board-drag-overlay"]', {
      timeoutMs,
    })
  } finally {
    await control.command('dragEnd', source, { target })
  }
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
    await control.command('waitFor', sortSelector('pending'), { timeoutMs: uiTimeoutMs })
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
