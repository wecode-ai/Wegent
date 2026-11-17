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
    await control.command('clickWhenEnabled', sendMenu)
    await control.command('clickWhenEnabled', close)
    await wait(
      async () => (await get()).status,
      'completed',
      'Close must persist the completed state'
    )
    await control.command(
      'waitFor',
      `${content} [data-testid="cloud-todo-state-summary"][data-status="completed"]`
    )
    await control.command('clickWhenEnabled', sendMenu)
    await control.command('clickWhenEnabled', close)
    await wait(
      async () => (await get()).status,
      'in_progress',
      'Reopen must restore the previous workflow state'
    )
    assert.equal(
      (await request(commentPath)).length,
      comments.length,
      'Empty close and reopen must not add comments'
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
