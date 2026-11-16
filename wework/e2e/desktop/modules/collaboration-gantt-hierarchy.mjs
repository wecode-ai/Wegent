import assert from 'node:assert/strict'
import { requestExecutor } from './executor-rpc.mjs'
import { reloadMainWindow, selectCollaborationProjectView } from './workspace-flows.mjs'
import { showAllCollaborationIssues, waitForBoardValue } from './collaboration-board-flows.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const test = id => `${CONTENT} [data-testid="${id}"]`

/** User stories: plan nested work, schedule by dragging, and archive from a tag board. */
export async function verifyGanttHierarchyAndDetailArchive(control, project, timeoutMs) {
  const rpc = (method, params) => requestExecutor(control, method, params, timeoutMs)
  const click = id => control.command('clickWhenEnabled', test(id), { timeoutMs })
  const wait = (id, visible = true) => control.command('waitFor', test(id), { visible, timeoutMs })
  const assertFocus = id =>
    waitForBoardValue(
      () => control.command('getActiveElementTestId', 'body'),
      id,
      `Keyboard focus must remain on ${id}`,
      timeoutMs
    )
  const today = new Date()
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const create = (title, parent_id, status, scheduled = true) =>
    rpc('todos.create', {
      project_id: project.id,
      todo: {
        title,
        parent_id,
        status,
        tags: ['design'],
        ...(scheduled ? { start_at: date, due_at: date } : {}),
      },
    })
  const parent = await create('甘特父任务与详情归档', null, 'in_progress', false)
  const child = await create('甘特子任务', parent.id, 'inbox')
  const grandchild = await create('甘特孙任务', child.id, 'in_review')
  const undated = await create('从底部拖入甘特图', null, 'inbox', false)
  await reloadMainWindow(control, 'Gantt hierarchy fixtures did not reload')
  await showAllCollaborationIssues(control, CONTENT)
  await wait(`cloud-todo-card-${parent.id}`)
  await selectCollaborationProjectView(control, CONTENT, 'gantt', timeoutMs)
  await wait(`collaboration-gantt-row-${grandchild.id}`)
  assert.equal(
    Number(
      await control.command('getElementCount', test(`collaboration-gantt-issue-${parent.id}`))
    ),
    0,
    'An undated context parent must not gain a fabricated draggable schedule'
  )
  const titleMetrics = async id =>
    JSON.parse(
      await control.command(
        'getElementMetrics',
        `${test(`collaboration-gantt-row-${id}`)} [data-tooltip-trigger]`
      )
    )[0]
  const parentTitle = await titleMetrics(parent.id)
  const childTitle = await titleMetrics(child.id)
  const grandchildTitle = await titleMetrics(grandchild.id)
  assert.ok(
    parentTitle.left < childTitle.left && childTitle.left < grandchildTitle.left,
    'Every generation must be indented under its parent'
  )
  await click(`collaboration-gantt-toggle-${child.id}`)
  await wait(`collaboration-gantt-row-${grandchild.id}`, false)
  await click(`collaboration-gantt-toggle-${parent.id}`)
  await wait(`collaboration-gantt-row-${child.id}`, false)
  await click(`collaboration-gantt-toggle-${parent.id}`)
  await wait(`collaboration-gantt-row-${child.id}`)
  assert.equal(
    Number(
      await control.command('getElementCount', test(`collaboration-gantt-row-${grandchild.id}`))
    ),
    0,
    'Reopening a parent must preserve its child collapse state'
  )
  await click('collaboration-gantt-toggle-task-column')
  await click(`collaboration-gantt-toggle-${child.id}`)
  await wait(`collaboration-gantt-row-${grandchild.id}`)
  const collapsedParentTitle = await titleMetrics(parent.id)
  const collapsedLeafTitle = await titleMetrics(grandchild.id)
  assert.ok(
    Math.abs(collapsedParentTitle.left - collapsedLeafTitle.left) < 1,
    'Collapsed parent and leaf row numbers must align'
  )
  const [headerDate] = JSON.parse(
    await control.command('getElementMetrics', test(`collaboration-gantt-header-day-${date}`))
  )
  const [rowDate] = JSON.parse(
    await control.command(
      'getElementMetrics',
      test(`collaboration-gantt-row-${grandchild.id}-day-${date}`)
    )
  )
  assert.ok(
    Math.abs(headerDate.left - rowDate.left) < 1,
    'Collapsed task columns must keep date headers aligned with row drop targets'
  )
  await click('collaboration-gantt-toggle-task-column')
  await control.command('select', test('collaboration-gantt-status-filter'), { value: 'inbox' })
  await wait(`collaboration-gantt-row-${grandchild.id}`, false)
  await control.command('select', test('collaboration-gantt-status-filter'), { value: 'in_review' })
  await wait(`collaboration-gantt-row-${grandchild.id}`)
  await wait(`collaboration-gantt-row-${child.id}`)
  await wait(`collaboration-gantt-row-${parent.id}`)
  await control.command('select', test('collaboration-gantt-status-filter'), { value: '' })

  const source = test(`collaboration-schedule-undated-${undated.id}`)
  const target = test(`collaboration-gantt-header-day-${date}`)
  await control.command('scrollIntoView', source)
  await control.command('scrollIntoView', target)
  await control.command('dragStart', source, { target })
  try {
    await control.command(
      'waitFor',
      '[data-testid="collaboration-schedule-undated-drag-overlay"]',
      {
        text: undated.title,
        visible: true,
        timeoutMs,
      }
    )
    const [overlay] = JSON.parse(
      await control.command(
        'getElementMetrics',
        '[data-testid="collaboration-schedule-undated-drag-overlay"]'
      )
    )
    const [origin] = JSON.parse(await control.command('getElementMetrics', source))
    assert.ok(
      overlay.bottom < origin.top,
      'The dragged task must remain visible above the clipping list'
    )
  } finally {
    await control.command('dragEnd', source, { target })
  }
  await wait(`collaboration-gantt-issue-${undated.id}`)
  await waitForBoardValue(
    async () => {
      const stored = await rpc('todos.get', { project_id: project.id, task_id: undated.id })
      return [stored.metadata.start_at?.slice(0, 10), stored.metadata.due_at?.slice(0, 10)]
    },
    [date, date],
    'Dragging from the unscheduled list must persist both dates',
    timeoutMs
  )

  // The existing project uses tag columns, so no Completed column is required.
  await selectCollaborationProjectView(control, CONTENT, 'board', timeoutMs)
  await click(`cloud-todo-card-${parent.id}`)
  await control.command('focusMainWindow', 'body')
  await click('cloud-todo-more-properties')
  await control.command('clickWhenEnabled', '[data-testid="cloud-todo-detail-delete"]', {
    timeoutMs,
  })
  await wait('collaboration-issue-archive-dialog')
  const cancelArchive = test('collaboration-issue-archive-cancel')
  const confirmArchive = test('collaboration-issue-archive-confirm')
  await assertFocus('collaboration-issue-archive-cancel')
  await control.command('nativePress', cancelArchive, { key: 'Shift+Tab' })
  await assertFocus('collaboration-issue-archive-confirm')
  await control.command('nativePress', confirmArchive, { key: 'Tab' })
  await assertFocus('collaboration-issue-archive-cancel')
  await click('collaboration-issue-archive-cancel')
  await wait('collaboration-issue-archive-dialog', false)
  await assertFocus('cloud-todo-more-properties')
  assert.ok(
    (await rpc('todos.list', { project_id: project.id })).some(item => item.id === parent.id),
    'Cancelling archive must leave the task tree active'
  )
  await click('cloud-todo-more-properties')
  await control.command('clickWhenEnabled', '[data-testid="cloud-todo-detail-delete"]', {
    timeoutMs,
  })
  await click('collaboration-issue-archive-confirm')
  await wait('collaboration-issue-archive-dialog', false)
  await wait('collaboration-issue-detail', false)
  const active = await rpc('todos.list', { project_id: project.id })
  for (const issue of [parent, child, grandchild]) {
    assert.ok(
      !active.some(item => item.id === issue.id),
      'Archiving an unfinished parent must archive all descendants'
    )
  }
  await click('collaboration-issue-archive-open')
  await wait(`collaboration-archived-issue-${parent.id}`)
  await click(`collaboration-archived-issue-restore-${parent.id}`)
  await wait(`collaboration-archived-issue-${parent.id}`, false)
  await click('collaboration-issue-archive-drawer-close')
  const restored = await rpc('todos.list', { project_id: project.id })
  for (const issue of [parent, child, grandchild]) {
    const record = restored.find(item => item.id === issue.id)
    assert.ok(record)
    assert.equal(record.status, issue.status)
    assert.equal(record.parent_id, issue.parent_id)
  }
  await selectCollaborationProjectView(control, CONTENT, 'gantt', timeoutMs)
  await wait(`collaboration-gantt-row-${grandchild.id}`)
}
