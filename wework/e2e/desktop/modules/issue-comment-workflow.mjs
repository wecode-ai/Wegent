import assert from 'node:assert/strict'
import { issueCommentFormSelector } from './issue-comment-selectors.mjs'
import { waitForBoardValue } from './collaboration-board-flows.mjs'
import { reloadMainWindow } from './workspace-flows.mjs'

export async function verifyComposerLayout(control, form, send, sendMenu) {
  const selectors = [
    form,
    `${form} [data-testid="task-comment-attach"]`,
    `${form} [data-testid="task-comment-form-assignee"]`,
    send,
    sendMenu,
  ]
  // A drawer can still be moving; compare every rectangle from the same frame.
  const metrics = JSON.parse(
    await control.command('getElementMetrics', selectors.join(', '), { value: 'includeText' })
  )
  const ids = [
    'task-comment-form',
    'task-comment-attach',
    'task-comment-form-assignee',
    'send-message-button',
    'task-comment-form-send-actions',
  ]
  const [frame, ...controls] = ids.map(id => {
    const matches = metrics.filter(rect => rect.testId === id)
    assert.equal(matches.length, 1, `Expected one composer control: ${id}`)
    return matches[0]
  })
  assert.ok(
    Math.max(...controls.map(rect => rect.top)) < Math.min(...controls.map(rect => rect.bottom)),
    'Composer tools, staged changes and send actions must share one row'
  )
  for (const rect of controls) {
    assert.ok(
      rect.left >= frame.left &&
        rect.right <= frame.right &&
        rect.top >= frame.top &&
        rect.bottom <= frame.bottom,
      `Every composer action must stay inside the input frame: ${JSON.stringify({ frame, control: rect })}`
    )
  }
  assert.equal(
    await control.command('getComputedStyleValue', send, { value: 'opacity' }),
    '1',
    'Disabled send text must not fade against a fixed dark background'
  )
}

/** Choosing the send mode must leave the Issue and discussion unchanged until submission. */
export async function verifyIssueSendModes(control, { scope, load, capture, name }) {
  const form = `${scope} [data-testid="task-comment-form"]`
  const group = `${form} [data-composer-send-group]`
  const primary = `${group} [data-composer-primary-action]`
  const menu = `${group} [data-testid="task-comment-form-send-actions"]`
  const editor = `${form} [contenteditable="true"]`
  const fill = async value => {
    await control.command('waitFor', editor, { visible: true, timeoutMs: 5000 })
    await control.command('fill', editor, { value })
  }
  const choose = async id => {
    await control.command('clickWhenEnabled', menu, { timeoutMs: 5000 })
    await control.command('clickWhenEnabled', `[data-testid="${id}"]`, { timeoutMs: 5000 })
  }
  const initial = await load()
  await fill('Comment without closing')
  await control.command('clickWhenEnabled', menu, { timeoutMs: 5000 })
  await control.command('waitFor', '[data-testid="task-comment-form-close"]', {
    visible: true,
    timeoutMs: 5000,
  })
  await capture(control, `${name}-comment-menu.png`)
  await control.command('clickWhenEnabled', '[data-testid="task-comment-form-close"]', {
    timeoutMs: 5000,
  })
  await control.command(
    'waitFor',
    `${group}[data-selected="true"] [data-composer-primary-action] svg.lucide-circle-check`,
    { timeoutMs: 5000 }
  )
  assert.deepEqual(await load(), initial, 'Selecting comment and close must not submit')
  await capture(control, `${name}-comment-and-close.png`)
  await choose('task-comment-form-send-option')
  await control.command(
    'waitFor',
    `${group}:not([data-selected]) [data-composer-primary-action] svg.lucide-arrow-up`,
    { timeoutMs: 5000 }
  )
  assert.deepEqual(await load(), initial, 'Selecting comment must not submit')
  const primaryLabel = await control.command('getAttribute', primary, { value: 'aria-label' })
  const [buttonBounds] = JSON.parse(await control.command('getElementMetrics', primary))
  const [menuBounds] = JSON.parse(await control.command('getElementMetrics', menu))
  assert.ok(
    Math.abs(menuBounds.left - buttonBounds.right) <= 1 && menuBounds.top === buttonBounds.top,
    'The dropdown must touch the right edge of the send button'
  )
  await capture(control, `${name}-comment.png`)
  await control.command('clickWhenEnabled', primary, { timeoutMs: 5000 })
  await waitForBoardValue(
    load,
    { status: initial.status, comments: initial.comments + 1 },
    'Comment must be persisted without closing the Issue',
    8000
  )
  await fill('Comment and close the Issue')
  await choose('task-comment-form-close')
  assert.notEqual(
    await control.command('getAttribute', primary, { value: 'aria-label' }),
    primaryLabel
  )
  assert.deepEqual(await load(), { status: initial.status, comments: initial.comments + 1 })
  await control.command('clickWhenEnabled', primary, { timeoutMs: 5000 })
  await waitForBoardValue(
    load,
    { status: 'completed', comments: initial.comments + 2 },
    'Comment and close must persist one comment and complete the Issue',
    8000
  )
}

/** The same mode control stages and creates a child of the Issue open in the drawer. */
export async function verifyIssueChildMode(control, { scope, issueId, children, capture, name }) {
  const form = `${scope} [data-testid="task-comment-form"]`
  const mode = `${form} [data-testid="task-comment-form-assignment-mode"]`
  const title = 'Child created from Issue discussion'
  const matching = async () =>
    (await children()).filter(item => item.title === title).map(item => String(item.parent_id))
  assert.deepEqual(await matching(), [])
  await control.command('waitFor', `${mode}[data-assignment-mode="current"] svg.lucide-list-todo`, {
    timeoutMs: 5000,
  })
  await control.command('clickWhenEnabled', mode, { timeoutMs: 5000 })
  await control.command('clickWhenEnabled', '[data-testid="task-comment-form-create-child"]', {
    timeoutMs: 5000,
  })
  await control.command('waitFor', `${mode}[data-assignment-mode="child"] svg.lucide-git-branch`, {
    timeoutMs: 5000,
  })
  await control.command('fill', `${form} [contenteditable="true"]`, { value: title })
  assert.deepEqual(await matching(), [], 'Selecting child mode must not create an Issue')
  await capture(control, `${name}-child-mode.png`)
  await control.command('clickWhenEnabled', `${form} [data-composer-primary-action]`, {
    timeoutMs: 5000,
  })
  await waitForBoardValue(
    matching,
    [String(issueId)],
    'Exactly one child must be linked to the open Issue',
    8000
  )
  await control.command('clickWhenEnabled', mode, { timeoutMs: 5000 })
  await control.command('clickElementWithText', '[role="option"]', {
    text: '分派当前事项',
    visible: true,
    timeoutMs: 5000,
  })
  await control.command('waitFor', `${mode}[data-assignment-mode="current"]`, { timeoutMs: 5000 })
  return (await children()).find(item => item.title === title)
}

/** Real comment, assignment, tag movement and lifecycle persistence in one detail page. */
export async function verifyIssueCommentWorkflow(
  control,
  { request, project, member, uiTimeoutMs }
) {
  const savedProject = await request(`/api/v1/cloud-projects/${project.id}`)
  const view = {
    id: 'comment-workflow',
    name: '讨论闭环看板',
    columns: [
      { id: 'develop', type: 'tag', value: '开发中' },
      { id: 'review', type: 'tag', value: '待验收' },
      { id: 'done', type: 'status', value: 'completed' },
    ],
  }
  await request(`/api/v1/cloud-projects/${project.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      version: savedProject.version,
      board_views: { schema_version: 1, default_view_id: view.id, views: [view] },
    }),
  })
  const issue = await request(`/api/v1/cloud-projects/${project.id}/loop-items`, {
    method: 'POST',
    body: JSON.stringify({
      title: '详情页评论与泳道变更统一提交',
      status: 'in_progress',
      tags: ['开发中', '紧急'],
      notify_assignee: false,
    }),
  })
  const content = '[data-workspace-tab-content][aria-hidden="false"]'
  const form = `${content} ${issueCommentFormSelector(issue.id)}`
  const send = `${form} [data-testid="send-message-button"]`
  const sendMenu = `${form} [data-testid="task-comment-form-send-actions"]`
  const close = '[data-testid="task-comment-form-close"]'
  const get = () => request(`/api/v1/loop-items/${issue.id}`)
  const wait = (load, expected, message) => waitForBoardValue(load, expected, message, uiTimeoutMs)
  const commentPath = `/api/v1/cloud-projects/${project.id}/loop-items/${issue.id}/activity-comments`
  try {
    await reloadMainWindow(control, 'The desktop must load the comment workflow view')
    await control.command('openWeworkScheme', 'body', {
      value: `wework://boards/${project.id}/issues/${issue.id}`,
    })
    await control.command('waitFor', sendMenu)
    await verifyComposerLayout(control, form, send, sendMenu)
    await control.command('fill', `${form} [data-testid="cloud-task-activity-composer"]`, {
      value: '确认修复，交接验收并移动泳道',
    })
    await control.command('click', `${form} [data-testid="task-comment-form-assignee"]`)
    await control.command('click', `[data-testid="task-comment-form-assignee-option-${member.id}"]`)
    await control.command('click', `${form} [data-testid="task-comment-form-move"]`)
    const option = `task-comment-form-move-option-${JSON.stringify(['develop', 'review'])}`
    await control.command('click', `[data-testid=${JSON.stringify(option)}]`)
    const before = await get()
    assert.equal(
      before.assignee_user_id,
      issue.assignee_user_id,
      'Selection must not assign before submission'
    )
    assert.deepEqual(before.tags, issue.tags, 'Selection must not move before submission')
    assert.equal((await request(commentPath)).length, 0, 'Selection must not post a comment')
    await control.command('waitFor', send, { text: '发送并更新' })
    await verifyComposerLayout(control, form, send, sendMenu)
    await control.command('clickWhenEnabled', send)
    await wait(
      async () => {
        const current = await get()
        return [String(current.assignee_user_id), current.tags]
      },
      [String(member.id), ['紧急', '待验收']],
      'Submission must assign and move, preserving unrelated tags'
    )
    await control.command(
      'waitFor',
      `${form} [data-testid="task-comment-form-move"][data-value=""]`
    )
    const comments = await request(commentPath)
    assert.equal(
      comments.filter(comment => comment.body.includes('确认修复，交接验收并移动泳道')).length,
      1
    )
    const editor = `${form} [data-testid="cloud-task-activity-composer"][contenteditable="true"]`
    await control.command('waitFor', editor, { visible: true, timeoutMs: 5000 })
    await control.command('fill', editor, { value: '验收通过，关闭事项' })
    await control.command('clickWhenEnabled', sendMenu)
    await control.command('clickWhenEnabled', close)
    assert.equal((await get()).status, 'in_progress', 'Selecting a mode must leave the Issue open')
    assert.equal((await request(commentPath)).length, comments.length)
    await control.command('clickWhenEnabled', send)
    await wait(
      async () => [(await get()).status, (await request(commentPath)).length],
      ['completed', comments.length + 1],
      'Submitting comment and close must persist both changes'
    )
    await control.command(
      'waitFor',
      `${content} [data-testid="cloud-todo-state-summary"][data-status="completed"]`
    )
    await control.command('select', `${content} [data-testid="cloud-todo-detail-status"]`, {
      value: 'in_progress',
    })
    await wait(
      async () => (await get()).status,
      'in_progress',
      'Reopen must restore the previous workflow state'
    )
    assert.equal(
      (await request(commentPath)).length,
      comments.length + 1,
      'Changing the status back must leave the discussion unchanged'
    )
  } finally {
    const current = await request(`/api/v1/cloud-projects/${project.id}`)
    await request(`/api/v1/cloud-projects/${project.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        version: current.version,
        board_views: savedProject.board_views ?? { schema_version: 1, views: [] },
      }),
    })
  }
}
