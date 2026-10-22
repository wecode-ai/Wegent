import assert from 'node:assert/strict'

import {
  openProjectBoard,
  selectProjectBoardGrouping,
  selectProjectBoardSort,
} from './collaboration-board-personal-view.mjs'
import { reloadMainWindow } from './workspace-flows.mjs'

const card = (column, id) =>
  `[data-testid="cloud-todo-column-${column}"] [data-testid="cloud-todo-card-${id}"]`

export async function assertLaneOrder(control, scoped, columnKey, ids) {
  const selector = scoped(`[data-testid="cloud-todo-column-${columnKey}"]`)
  for (const id of ids) {
    await control.command('waitFor', scoped(card(columnKey, id)), { visible: true })
  }
  await control.command('waitFor', selector, { stableMs: 300 })
  const testIds = JSON.parse(await control.command('getTestIdOrder', selector))
  assert.deepEqual(
    testIds.filter(testId => ids.some(id => testId === `cloud-todo-card-${id}`)),
    ids.map(id => `cloud-todo-card-${id}`)
  )
}

export async function waitForIssue(request, id, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let issue
  while (Date.now() < deadline) {
    issue = await request(`/api/v1/loop-items/${id}`)
    if (predicate(issue)) return issue
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`The board mutation did not persist: ${JSON.stringify(issue)}`)
}

export async function verifyBoardFieldDrag(control, { scoped, request, project, uiTimeoutMs }) {
  const owner = await request('/api/users/me')
  const fixtures = []
  for (const title of ['较早创建的任务', '较晚创建的任务']) {
    fixtures.push(
      await request(`/api/v1/cloud-projects/${project.id}/loop-items`, {
        method: 'POST',
        body: JSON.stringify({
          title,
          status: 'pending',
          priority: 'low',
          assignee_user_id: owner.id,
        }),
      })
    )
  }
  const [moving, anchor] = fixtures
  const manualOrder = [anchor.id, moving.id]
  await request(`/api/v1/cloud-projects/${project.id}/loop-items/reorder`, {
    method: 'POST',
    body: JSON.stringify({ status: 'pending', parent_id: null, item_ids: manualOrder }),
  })
  await reloadMainWindow(control, 'The board field drag fixtures did not load')
  await openProjectBoard(control, scoped, project)
  await selectProjectBoardGrouping(control, scoped, 'status')
  await selectProjectBoardSort(control, scoped, 'pending')
  await assertLaneOrder(control, scoped, 'pending', manualOrder)
  const beforeStatusOrder = await request(`/api/v1/loop-items/${moving.id}`)
  await control.command('drag', scoped(card('pending', moving.id)), {
    target: scoped(card('pending', anchor.id)),
  })
  await waitForIssue(
    request,
    moving.id,
    issue => issue.version > beforeStatusOrder.version,
    uiTimeoutMs
  )
  const persistedLane = await request(`/api/v1/cloud-projects/${project.id}/loop-items`)
  assert.deepEqual(
    persistedLane.items
      .filter(issue => issue.status === 'pending')
      .sort((left, right) => left.sort_order - right.sort_order)
      .map(issue => issue.id),
    [moving.id, anchor.id],
    'The status column only changed its visual order'
  )
  await reloadMainWindow(control, 'The status reorder did not reload')
  await openProjectBoard(control, scoped, project)
  await assertLaneOrder(control, scoped, 'pending', [moving.id, anchor.id])
  console.log(
    '[desktop-e2e] PASS board-drag: status same-column order persisted and survived reload'
  )

  for (const [group, column, order] of [
    ['priority', 'priority-low', [anchor.id, moving.id]],
    ['assignee', `assignee-${owner.id}`, [moving.id, anchor.id]],
  ]) {
    await selectProjectBoardGrouping(control, scoped, group)
    await selectProjectBoardSort(control, scoped, column, ['priority-desc', 'created-asc'])
    const before = await request(`/api/v1/loop-items/${order[0]}`)
    await control.command('drag', scoped(card(column, order[0])), {
      target: scoped(card(column, order[1])),
    })
    await control.command('waitFor', scoped(card(column, order[0])), { stableMs: 500 })
    const after = await request(`/api/v1/loop-items/${order[0]}`)
    for (const field of [
      'version',
      'sort_order',
      'status',
      'priority',
      'assignee_user_id',
      'tags',
    ]) {
      assert.deepEqual(
        after[field],
        before[field],
        `Sorted same-column ${group} drag changed ${field}`
      )
    }
    await selectProjectBoardSort(control, scoped, column)
    const beforeOrder = await request(`/api/v1/loop-items/${order[0]}`)
    await control.command('drag', scoped(card(column, order[0])), {
      target: scoped(card(column, order[1])),
    })
    const reordered = await waitForIssue(
      request,
      order[0],
      issue => issue.version > beforeOrder.version,
      uiTimeoutMs
    )
    for (const field of ['status', 'priority', 'assignee_user_id', 'tags']) {
      assert.deepEqual(
        reordered[field],
        beforeOrder[field],
        `Manual ${group} reorder changed ${field}`
      )
    }
    const persisted = await request(`/api/v1/cloud-projects/${project.id}/loop-items`)
    assert.deepEqual(
      persisted.items
        .filter(issue => fixtures.some(fixture => fixture.id === issue.id))
        .sort((left, right) => left.sort_order - right.sort_order)
        .map(issue => issue.id),
      order,
      `The ${group} column only changed its visual order`
    )
    await reloadMainWindow(control, 'The same-column field drag did not reload')
    await openProjectBoard(control, scoped, project)
    await assertLaneOrder(control, scoped, column, order)
    console.log(
      `[desktop-e2e] PASS board-drag: ${group} compound sort blocks manual drag; manual order persists without changing fields`
    )
  }

  for (const move of [
    { group: 'status', source: 'pending', target: 'inbox', field: 'status', expected: 'inbox' },
    {
      group: 'priority',
      source: 'priority-low',
      target: 'priority-high',
      field: 'priority',
      expected: 'high',
    },
    {
      group: 'assignee',
      source: `assignee-${owner.id}`,
      target: 'assignee-unassigned',
      field: 'assignee_user_id',
      expected: null,
    },
    {
      group: 'assignee',
      source: 'assignee-unassigned',
      target: `assignee-${owner.id}`,
      field: 'assignee_user_id',
      expected: owner.id,
    },
  ]) {
    await selectProjectBoardGrouping(control, scoped, move.group)
    const before = await request(`/api/v1/loop-items/${moving.id}`)
    await control.command('drag', scoped(card(move.source, moving.id)), {
      target: scoped(`[data-testid="cloud-todo-column-dropzone-${move.target}"]`),
    })
    const after = await waitForIssue(
      request,
      moving.id,
      issue => issue[move.field] === move.expected,
      uiTimeoutMs
    )
    for (const field of ['status', 'priority', 'assignee_user_id', 'tags']) {
      assert.deepEqual(after[field], field === move.field ? move.expected : before[field])
    }
    await reloadMainWindow(control, 'The cross-column field mutation did not reload')
    await openProjectBoard(control, scoped, project)
    await control.command('waitFor', scoped(card(move.target, moving.id)), { visible: true })
    await control.command('waitFor', scoped(card(move.source, moving.id)), { visible: false })
    console.log(
      `[desktop-e2e] PASS board-drag: ${move.group} cross-column ${move.source} -> ${move.target} persisted and survived reload`
    )
  }
}

export async function createReadOnlyBoardIssues(request, project, owner, reader) {
  const issues = []
  for (const [index, assignee] of [reader, owner].entries()) {
    issues.push(
      await request(`/api/v1/cloud-projects/${project.id}/loop-items`, {
        method: 'POST',
        body: JSON.stringify({
          title: `Viewer 禁止拖动 ${index}`,
          status: index === 0 ? 'inbox' : 'pending',
          priority: index === 0 ? 'low' : 'high',
          assignee_user_id: assignee.id,
          tags: [index === 0 ? 'viewer-A' : 'viewer-B'],
        }),
      })
    )
  }
  return issues
}

export async function verifyReadOnlyBoardDrag(
  control,
  { scoped, request, project, issues, reader, owner }
) {
  const [moving, anchor] = issues
  for (const [group, source, target] of [
    ['status', 'inbox', 'pending'],
    ['priority', 'priority-low', 'priority-high'],
    ['assignee', `assignee-${reader.id}`, `assignee-${owner.id}`],
    ['tag', 'tag-viewer-A', 'tag-viewer-B'],
  ]) {
    await selectProjectBoardGrouping(control, scoped, group)
    const sourceCard = scoped(card(source, moving.id))
    await control.command('waitFor', sourceCard, { visible: true })
    assert.equal(
      await control.command('getAttribute', sourceCard, { value: 'aria-roledescription' }),
      '',
      `A Viewer received an enabled drag handle in ${group} grouping`
    )
    const before = await request(`/api/v1/loop-items/${moving.id}`)
    await control.command('drag', sourceCard, { target: scoped(card(target, anchor.id)) })
    await control.command('waitFor', sourceCard, { visible: true, stableMs: 500 })
    const after = await request(`/api/v1/loop-items/${moving.id}`)
    for (const field of [
      'version',
      'sort_order',
      'status',
      'priority',
      'assignee_user_id',
      'tags',
    ]) {
      assert.deepEqual(after[field], before[field], `A Viewer drag changed ${field} in ${group}`)
    }
    await control.command('waitFor', scoped(card(target, moving.id)), { visible: false })
    await reloadMainWindow(control, 'The Viewer board drag attempt did not reload')
    await openProjectBoard(control, scoped, project)
    await control.command('waitFor', sourceCard, { visible: true })
    await control.command('waitFor', scoped(card(target, moving.id)), { visible: false })
    console.log(
      `[desktop-e2e] PASS board-drag: Viewer cannot drag in ${group} grouping; backend and reload unchanged`
    )
  }
}
