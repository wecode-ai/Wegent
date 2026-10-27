import assert from 'node:assert/strict'

import {
  openProjectBoard,
  selectProjectBoardGrouping,
  selectProjectBoardSort,
} from './collaboration-board-personal-view.mjs'
import { reloadMainWindow } from './workspace-flows.mjs'
import { waitForVisibleBoardCard } from './collaboration-board-flows.mjs'
import {
  assertLaneOrder,
  verifyBoardFieldDrag,
  waitForIssue,
} from './collaboration-board-field-drag.mjs'

const TAGS = ['drag-A', 'drag-B', 'drag-C']

const column = key => `[data-testid="cloud-todo-column-${key}"]`
const card = (key, id) => `${column(key)} [data-testid="cloud-todo-card-${id}"]`

export async function assertIssueColumns(control, scoped, issueId, tags) {
  for (const [key, present] of [
    ...TAGS.map(tag => [`tag-${tag}`, tags.includes(tag)]),
    ['tag-untagged', tags.length === 0],
  ]) {
    const selector = scoped(card(key, issueId))
    if (present) await waitForVisibleBoardCard(control, selector)
    else await control.command('waitFor', selector, { visible: false })
  }
}

async function verifyTagMoves(control, { scoped, request, project, uiTimeoutMs }) {
  const fixtures = []
  for (const [title, tags] of [
    ['移动的多标签任务', TAGS.slice(0, 2)],
    ['同列拖动锚点 A', [TAGS[0]]],
    ['同列拖动多标签锚点 B', TAGS.slice(0, 2)],
    ['跨列拖动锚点 C', [TAGS[2]]],
    ['移到无标签列清空全部标签', TAGS.slice(0, 2)],
    ['移到已存在的自身标签卡', TAGS.slice(0, 2)],
  ]) {
    fixtures.push(
      await request(`/api/v1/cloud-projects/${project.id}/loop-items`, {
        method: 'POST',
        body: JSON.stringify({ title: `${title}-${process.pid}`, tags }),
      })
    )
  }
  const [moving, , sameColumnAnchor, targetAnchor] = fixtures
  await request(`/api/v1/cloud-projects/${project.id}/loop-items/reorder`, {
    method: 'POST',
    body: JSON.stringify({
      parent_id: null,
      status: null,
      item_ids: [
        sameColumnAnchor.id,
        moving.id,
        ...fixtures
          .filter(issue => ![moving, sameColumnAnchor].includes(issue))
          .map(issue => issue.id),
      ],
    }),
  })
  await reloadMainWindow(control, 'The multi-tag board fixture did not load')
  await openProjectBoard(control, scoped, project)
  await selectProjectBoardGrouping(control, scoped, 'tag')
  await assertIssueColumns(control, scoped, moving.id, TAGS.slice(0, 2))

  const sameColumn = `tag-${TAGS[1]}`
  await selectProjectBoardSort(control, scoped, sameColumn, ['priority-desc', 'created-asc'])
  const beforeSameColumn = await request(`/api/v1/loop-items/${moving.id}`)
  await control.command('drag', scoped(card(`tag-${TAGS[1]}`, moving.id)), {
    target: scoped(card(`tag-${TAGS[1]}`, sameColumnAnchor.id)),
  })
  await control.command('waitFor', scoped(card(`tag-${TAGS[1]}`, moving.id)), { stableMs: 500 })
  const afterSameColumn = await request(`/api/v1/loop-items/${moving.id}`)
  assert.deepEqual(afterSameColumn.tags, beforeSameColumn.tags)
  assert.equal(
    afterSameColumn.version,
    beforeSameColumn.version,
    'A compound-sorted same-column tag drag mutated the Issue'
  )
  assert.equal(afterSameColumn.sort_order, beforeSameColumn.sort_order)
  await selectProjectBoardSort(control, scoped, sameColumn)
  await assertLaneOrder(control, scoped, sameColumn, [sameColumnAnchor.id, moving.id])
  await control.command('drag', scoped(card(sameColumn, moving.id)), {
    target: scoped(card(sameColumn, sameColumnAnchor.id)),
  })
  const reordered = await waitForIssue(
    request,
    moving.id,
    issue => issue.version > beforeSameColumn.version,
    uiTimeoutMs
  )
  for (const field of ['tags', 'status', 'priority', 'assignee_user_id']) {
    assert.deepEqual(
      reordered[field],
      beforeSameColumn[field],
      `A manual tag reorder changed ${field}`
    )
  }
  assert.ok(
    reordered.sort_order < (await request(`/api/v1/loop-items/${sameColumnAnchor.id}`)).sort_order,
    'The manual tag reorder did not move the Issue before its anchor'
  )
  await reloadMainWindow(control, 'The same-column tag drag did not reload')
  await openProjectBoard(control, scoped, project)
  await assertLaneOrder(control, scoped, sameColumn, [moving.id, sameColumnAnchor.id])
  await assertIssueColumns(control, scoped, moving.id, TAGS.slice(0, 2))
  console.log(
    '[desktop-e2e] PASS board-drag: multi-tag compound sort blocks manual drag; manual order persists without changing tags'
  )

  const moves = [
    { source: TAGS[0], target: TAGS[2], anchor: targetAnchor, expected: [TAGS[1], TAGS[2]] },
    { source: TAGS[2], target: TAGS[1], anchor: sameColumnAnchor, expected: [TAGS[1]] },
    { source: TAGS[1], target: null, expected: [] },
    { source: null, target: TAGS[0], anchor: fixtures[1], expected: [TAGS[0]] },
    {
      issue: fixtures[5],
      source: TAGS[0],
      target: TAGS[1],
      anchor: fixtures[5],
      expected: [TAGS[1]],
    },
    { issue: fixtures[4], source: TAGS[0], target: null, expected: [] },
  ]
  for (const move of moves) {
    const movedIssue = move.issue ?? moving
    const sourceKey = move.source ? `tag-${move.source}` : 'tag-untagged'
    const targetKey = move.target ? `tag-${move.target}` : 'tag-untagged'
    const before = await request(`/api/v1/loop-items/${movedIssue.id}`)
    await control.command('drag', scoped(card(sourceKey, movedIssue.id)), {
      target: move.anchor
        ? scoped(card(targetKey, move.anchor.id))
        : scoped(`[data-testid="cloud-todo-column-dropzone-${targetKey}"]`),
    })
    const after = await waitForIssue(
      request,
      movedIssue.id,
      issue => JSON.stringify(issue.tags) === JSON.stringify(move.expected),
      uiTimeoutMs
    )
    assert.ok(after.version > before.version, 'The cross-column drag did not execute a mutation')
    assert.equal(after.status, before.status)
    assert.equal(after.priority, before.priority)
    assert.equal(after.assignee_user_id, before.assignee_user_id)
    await assertIssueColumns(control, scoped, movedIssue.id, move.expected)
    await reloadMainWindow(control, 'A cross-column tag drag did not reload')
    await openProjectBoard(control, scoped, project)
    await assertIssueColumns(control, scoped, movedIssue.id, move.expected)
    console.log(
      `[desktop-e2e] PASS board-drag: tag ${sourceKey} -> ${targetKey}, expected tags=${JSON.stringify(move.expected)} persisted and survived reload`
    )
  }
}

export async function verifyMultiTagBoardDrag(control, options) {
  const { scoped, request, project } = options
  const fixtureProject = await request(`/api/v1/workspaces/${project.workspace_id}/projects`, {
    method: 'POST',
    body: JSON.stringify({ name: `多标签拖放回归-${process.pid}` }),
  })
  try {
    await verifyBoardFieldDrag(control, { ...options, project: fixtureProject })
    await verifyTagMoves(control, { ...options, project: fixtureProject })
  } finally {
    const latest = await request(`/api/v1/cloud-projects/${fixtureProject.id}`)
    await request(`/api/v1/cloud-projects/${fixtureProject.id}?version=${latest.version}`, {
      method: 'DELETE',
    })
    await reloadMainWindow(control, 'The tag drag fixture cleanup did not reload')
    await openProjectBoard(control, scoped, project)
  }
}
