// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict'
import { showAllCollaborationIssues, waitForBoardValue } from './collaboration-board-flows.mjs'
import { reloadMainWindow } from './workspace-flows.mjs'

const FLAG = 'collab.baseBoardStatusGrouping.v1'
const STAGES = ['需求提出', '共同评审', '开发准备', '开发实现', '质量验收', '发布上线']

/** Keep legacy grouping scenarios as explicit rollback coverage. */
async function beginLegacyBoardGrouping(control) {
  const previous = await control.command('getLocalStorageItem', 'body', { value: FLAG })
  await control.command('setLocalStorageItem', 'body', {
    value: JSON.stringify({ key: FLAG, value: 'false' }),
  })
  assert.equal(
    await control.command('getLocalStorageItem', 'body', { value: FLAG }),
    'false',
    'The legacy board grouping flag must be set before opening the fixture project'
  )
  return async () => {
    if (previous) {
      await control.command('setLocalStorageItem', 'body', {
        value: JSON.stringify({ key: FLAG, value: previous }),
      })
    } else {
      await control.command('removeLocalStorageItem', 'body', { value: FLAG })
    }
    assert.equal(
      await control.command('getLocalStorageItem', 'body', { value: FLAG }),
      previous,
      'The board grouping flag must be restored after the rollback scenario'
    )
  }
}

/** Restore renderer state before the shared runner shuts down the application. */
export function withLegacyBoardGrouping(verify) {
  return async control => {
    const restore = await beginLegacyBoardGrouping(control)
    try {
      await verify(control)
    } finally {
      await restore()
    }
  }
}

export async function verifyBaseBoardStatusGrouping({
  control,
  request,
  project,
  scoped,
  openBoard,
  uiTimeoutMs,
}) {
  const path = `/api/v1/cloud-projects/${project.id}`
  const original = await request(path)
  const previousFlag = await control.command('getLocalStorageItem', 'body', { value: FLAG })
  const views = {
    schema_version: 1,
    default_view_id: 'workflow-v1',
    views: [
      {
        id: 'workflow-v1',
        name: '协作流程',
        columns: [
          { id: 'workflow-inbox', type: 'status', value: 'inbox' },
          ...STAGES.map((value, index) => ({ id: `workflow-${index}`, type: 'tag', value })),
        ],
      },
    ],
  }
  let issue
  try {
    await control.command('removeLocalStorageItem', 'body', { value: FLAG })
    const seeded = await request(path, 'PATCH', {
      version: original.version,
      board_config: { ...original.board_config, group_by: 'tag' },
      board_views: views,
      tags: [...new Set([...original.tags, ...STAGES])],
    })
    issue = await request(`${path}/loop-items`, 'POST', {
      title: 'Status and quality-stage projections',
      status: 'in_progress',
      tags: ['质量验收'],
    })
    await reloadMainWindow(control, 'The legacy board configuration fixture did not reload')
    await openBoard(control)
    await showAllCollaborationIssues(control, scoped('').trim())
    const columnKeys = async () =>
      JSON.parse(
        await control.command(
          'getElementMetrics',
          scoped('[data-testid="collaboration-board"] section[data-testid^="cloud-todo-column-"]'),
          { value: JSON.stringify({ attributeNames: ['data-testid'] }) }
        )
      ).map(({ attributes }) => attributes['data-testid'].slice('cloud-todo-column-'.length))
    const expectColumns = keys =>
      waitForBoardValue(columnKeys, keys, 'Unexpected base or workflow column order', uiTimeoutMs)
    await expectColumns(views.views[0].columns.map(column => column.id))
    await control.command(
      'waitFor',
      scoped(
        `[data-testid="cloud-todo-column-workflow-4"] [data-testid="cloud-todo-card-${issue.id}"]`
      )
    )
    await waitForBoardValue(
      async () => (await request(path)).board_config.group_by,
      'status',
      'The legacy project configuration was not migrated',
      uiTimeoutMs
    )
    const migrated = await request(path)
    assert.deepEqual(migrated.board_config, { ...seeded.board_config, group_by: 'status' })
    assert.deepEqual(migrated.board_views, seeded.board_views)
    assert.deepEqual(migrated.tags, seeded.tags)
    const beforeIssue = await request(`/api/v1/loop-items/${issue.id}`)
    for (let index = 0; index < 2; index += 1) {
      await control.command('click', scoped('[data-testid="board-view-picker"]'))
      assert.match(
        await control.command('getText', '[data-testid="board-view-workflow-v1"]'),
        /默认|Default/,
        'The workflow view must retain its default badge'
      )
      await control.command('click', '[data-testid="board-view-default"]')
      await expectColumns(seeded.board_config.statuses.map(status => status.id))
      await control.command(
        'waitFor',
        scoped(
          `[data-testid="cloud-todo-column-in_progress"] [data-testid="cloud-todo-card-${issue.id}"]`
        )
      )
      await control.command('click', scoped('[data-testid="board-view-picker"]'))
      await control.command('click', '[data-testid="board-view-workflow-v1"]')
      await expectColumns(views.views[0].columns.map(column => column.id))
      await control.command(
        'waitFor',
        scoped(
          `[data-testid="cloud-todo-column-workflow-4"] [data-testid="cloud-todo-card-${issue.id}"]`
        )
      )
    }
    const after = await request(path)
    assert.equal(
      after.version,
      migrated.version,
      'View selection advanced the shared project version'
    )
    assert.deepEqual(after.board_config, migrated.board_config)
    assert.deepEqual(after.board_views, migrated.board_views)
    assert.deepEqual(after.tags, migrated.tags)
    assert.deepEqual(await request(`/api/v1/loop-items/${issue.id}`), beforeIssue)
  } finally {
    if (issue) {
      const latestIssue = await request(`/api/v1/loop-items/${issue.id}`)
      await request(`/api/v1/loop-items/${issue.id}?version=${latestIssue.version}`, 'DELETE')
    }
    const latest = await request(path)
    await request(path, 'PATCH', {
      version: latest.version,
      board_config: original.board_config,
      board_views: original.board_views ?? { schema_version: 1, views: [] },
      tags: original.tags,
    })
    if (previousFlag) {
      await control.command('setLocalStorageItem', 'body', {
        value: JSON.stringify({ key: FLAG, value: previousFlag }),
      })
    } else {
      await control.command('removeLocalStorageItem', 'body', { value: FLAG })
    }
    await reloadMainWindow(control, 'The base-board fixture cleanup did not reload')
    await openBoard(control)
    await showAllCollaborationIssues(control, scoped('').trim())
  }
}
