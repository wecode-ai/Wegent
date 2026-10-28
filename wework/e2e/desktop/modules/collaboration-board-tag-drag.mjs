import assert from 'node:assert/strict'

import {
  openProjectBoard,
  selectProjectBoardGrouping,
  selectProjectBoardSort,
} from './collaboration-board-personal-view.mjs'
import { reloadMainWindow } from './workspace-flows.mjs'
import { waitForBoardValue } from './collaboration-board-flows.mjs'
import {
  assertLaneOrder,
  verifyBoardFieldDrag,
  waitForIssue,
} from './collaboration-board-field-drag.mjs'

const TAGS = ['drag-A', 'drag-B', 'drag-C']

const column = key => `[data-testid="cloud-todo-column-${key}"]`
const card = (key, id) => `${column(key)} [data-testid="cloud-todo-card-${id}"]`

export async function assertIssueColumns(control, scoped, issueId, tags, timeoutMs) {
  const placements = [...TAGS.map(tag => `tag-${tag}`), 'tag-untagged']
    .map(key => ({
      selector: scoped(card(key, issueId)),
      expected: key === 'tag-untagged' ? tags.length === 0 : tags.includes(key.slice(4)),
    }))
    .sort((left, right) => Number(right.expected) - Number(left.expected))
  await waitForBoardValue(
    async () => {
      const counts = []
      // Read required cards first so a loading board cannot satisfy absence checks.
      for (const { selector } of placements) {
        counts.push(Number(await control.command('getElementCount', selector)))
      }
      return counts
    },
    placements.map(({ expected }) => (expected ? 1 : 0)),
    `Issue ${issueId} has incorrect column membership`,
    timeoutMs
  )
  for (const { selector, expected } of placements) {
    if (expected) {
      await control.command('scrollIntoView', selector)
      await control.command('waitFor', selector, { visible: true, timeoutMs })
    }
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
  await assertIssueColumns(control, scoped, moving.id, TAGS.slice(0, 2), uiTimeoutMs)

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
  await assertIssueColumns(control, scoped, moving.id, TAGS.slice(0, 2), uiTimeoutMs)
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
    await assertIssueColumns(control, scoped, movedIssue.id, move.expected, uiTimeoutMs)
    await reloadMainWindow(control, 'A cross-column tag drag did not reload')
    await openProjectBoard(control, scoped, project)
    await assertIssueColumns(control, scoped, movedIssue.id, move.expected, uiTimeoutMs)
    console.log(
      `[desktop-e2e] PASS board-drag: tag ${sourceKey} -> ${targetKey}, expected tags=${JSON.stringify(move.expected)} persisted and survived reload`
    )
  }
}

export async function verifyMultiTagBoardDrag(control, options) {
  const { scoped, request, project } = options
  const previousWindowSize = JSON.parse(
    await control.command('setMainWindowSize', 'body', {
      value: JSON.stringify({ width: 1024, height: 720 }),
    })
  )
  try {
    const fixtureProject = await request(`/api/v1/workspaces/${project.workspace_id}/projects`, {
      method: 'POST',
      body: JSON.stringify({ name: `多标签拖放回归-${process.pid}` }),
    })
    try {
      await verifyBoardFieldDrag(control, { ...options, project: fixtureProject })
      await verifyTagMoves(control, { ...options, project: fixtureProject })
      console.log('[desktop-e2e] PASS owner board field and tag drag at 1024x720')
    } finally {
      try {
        const latest = await request(`/api/v1/cloud-projects/${fixtureProject.id}`)
        await request(`/api/v1/cloud-projects/${fixtureProject.id}?version=${latest.version}`, {
          method: 'DELETE',
        })
      } finally {
        await reloadMainWindow(control, 'The tag drag fixture cleanup did not reload')
        await openProjectBoard(control, scoped, project)
      }
    }
  } finally {
    await control.command('setMainWindowSize', 'body', {
      value: JSON.stringify(previousWindowSize),
    })
  }
}
