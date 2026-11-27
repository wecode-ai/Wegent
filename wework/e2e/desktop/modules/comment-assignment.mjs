import assert from 'node:assert/strict'
import { issueCommentFormSelector } from './issue-comment-selectors.mjs'
import { setAssignmentNotification } from './issue-save-notification-flows.mjs'

/** Exercise comment handoff against real project members, comments and assignment APIs. */
export async function verifyCommentAssignment(
  control,
  { request, memberRequest, project, owner, member }
) {
  const content = '[data-workspace-tab-content][aria-hidden="false"]'
  const scoped = selector => `${content} ${selector}`
  const issue = await request(`/api/v1/cloud-projects/${project.id}/loop-items`, {
    method: 'POST',
    body: JSON.stringify({ title: '讨论区直接转派回归', notify_assignee: false }),
  })
  await control.command('openWeworkScheme', 'body', {
    value: `wework://boards/${project.id}/issues/${issue.id}`,
  })
  const activity = scoped(`[data-testid="cloud-task-activity-${issue.id}"]`)
  await control.command('waitFor', activity)
  const form = scoped(issueCommentFormSelector(issue.id))
  const editor = `${form} [data-testid="cloud-task-activity-composer"]`
  const selector = `${form} [data-testid="task-comment-form-assignee"]`
  const send = `${form} [data-testid="send-message-button"]`
  await control.command('waitFor', selector)
  const body = `[$@${member.user_name}](wework-member://${member.id}) [$@${owner.user_name}](wework-member://${owner.id}) 请接手审核`
  await control.command('fill', editor, { value: body })
  const suggestion = `${form} [data-testid="task-comment-form-assignee-suggestion"]`
  await control.command('waitFor', `${selector}[data-value=""]`)
  await control.command('waitFor', suggestion, { text: member.user_name })
  await control.command(
    'click',
    `${editor} [data-composer-skill-reference*="wework-member://${owner.id}"]`
  )
  await control.command('waitFor', suggestion, { text: owner.user_name })
  await control.command(
    'click',
    `${editor} [data-composer-skill-reference*="wework-member://${member.id}"]`
  )
  await control.command('waitFor', suggestion, { text: member.user_name })
  await control.command('click', '[data-testid="task-comment-form-assignee-dismiss"]')
  await control.command('waitFor', suggestion, { visible: false })
  await control.command(
    'click',
    `${editor} [data-composer-skill-reference*="wework-member://${member.id}"]`
  )
  await control.command('waitFor', suggestion, { text: member.user_name })
  await control.command('waitFor', send, { text: '发送' })
  await control.command('clickWhenEnabled', send)
  await control.command('waitFor', scoped('[data-testid="cloud-task-activity-list"]'), {
    text: '请接手审核',
  })
  const mentioned = await request(`/api/v1/loop-items/${issue.id}`)
  assert.equal(mentioned.assignee_user_id, issue.assignee_user_id)
  await control.command('waitFor', `${selector}[data-value=""]`)
  await control.command('clickWhenEnabled', '[data-testid="task-comment-form-assignee-confirm"]')
  await control.command('waitFor', `${selector}[data-value="${member.id}"]`)
  const accepted = await request(`/api/v1/loop-items/${issue.id}`)
  assert.equal(
    accepted.assignee_user_id,
    issue.assignee_user_id,
    'Accepting a suggestion only fills the selector'
  )
  await control.command('clickWhenEnabled', send)
  await control.command('waitFor', scoped('[data-testid="cloud-task-assignment-event-1"]'), {
    text: member.user_name,
  })
  const transferred = await request(`/api/v1/loop-items/${issue.id}`)
  assert.equal(String(transferred.assignee_user_id), String(member.id))
  const comments = await request(
    `/api/v1/cloud-projects/${project.id}/loop-items/${issue.id}/activity-comments`
  )
  assert.equal(comments.filter(comment => comment.body.includes('请接手审核')).length, 1)

  // An empty comment can transfer ownership without creating another discussion.
  await control.command('click', selector)
  await control.command('click', `[data-testid="task-comment-form-assignee-option-${owner.id}"]`)
  await control.command('clickWhenEnabled', send)
  await control.command('waitFor', scoped('[data-testid="cloud-task-assignment-event-2"]'), {
    text: owner.user_name,
  })
  const restored = await request(`/api/v1/loop-items/${issue.id}`)
  assert.equal(String(restored.assignee_user_id), String(owner.id))
  const after = await request(
    `/api/v1/cloud-projects/${project.id}/loop-items/${issue.id}/activity-comments`
  )
  assert.equal(after.length, comments.length)

  const handoff = await verifyAssigneeShortcuts(control, {
    request,
    memberRequest,
    project,
    issue: restored,
    owner,
    member,
    selector,
    editor,
    send,
    scoped,
  })
  await request(`/api/v1/loop-items/${issue.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ version: handoff.version, security_level: 'related' }),
  })
  // Story: sending a child assignment retains the original discussion and never reassigns the parent.
  const childBody = '把这条不含提及的评论分派成子事项'
  await control.command('select', `${form} [data-testid="task-comment-form-assignment-mode"]`, {
    value: 'child',
  })
  await control.command('fill', editor, { value: childBody })
  await control.command('click', selector)
  await control.command('click', `[data-testid="task-comment-form-assignee-option-${member.id}"]`)
  await control.command('clickWhenEnabled', send)
  await control.command('waitFor', scoped('[data-testid="cloud-task-activity-list"]'), {
    text: childBody,
  })
  await control.command('waitFor', `${selector}[data-value=""]`)
  const children = await request(`/api/v1/cloud-projects/${project.id}/loop-items`)
  const createdChild = children.items.find(
    item => item.parent_id === issue.id && item.title === childBody
  )
  assert.ok(createdChild, 'The comment must create a real child Issue')
  assert.equal(createdChild.security_level, 'related')
  assert.equal((await memberRequest(`/api/v1/loop-items/${createdChild.id}`)).can_view_detail, true)
  assert.equal(String(createdChild.assignee_user_id), String(member.id))
  assert.equal(
    String((await request(`/api/v1/loop-items/${issue.id}`)).assignee_user_id),
    String(owner.id),
    'Child assignment must not reassign its parent'
  )
  const parentComments = await request(
    `/api/v1/cloud-projects/${project.id}/loop-items/${issue.id}/activity-comments`
  )
  assert.equal(
    parentComments.filter(comment => comment.body.includes(childBody)).length,
    1,
    'The original parent comment must be saved exactly once'
  )

  // Story: an existing visible comment without @mentions can also seed a child and records a source reply.
  const original = parentComments.find(comment => comment.body.includes(childBody))
  await control.command(
    'click',
    scoped(`[data-testid="issue-comment-create-child-${original.id}"]`)
  )
  await control.command('click', `[data-testid="issue-comment-child-assignee-${original.id}"]`)
  await control.command(
    'click',
    `[data-testid="issue-comment-child-assignee-${original.id}-option-${owner.id}"]`
  )
  await control.command(
    'clickWhenEnabled',
    `[data-testid="issue-comment-child-confirm-${original.id}"]`
  )
  await control.command(
    'waitFor',
    `[data-testid="issue-comment-create-child-${original.id}"][aria-expanded="false"]`
  )
  const laterChildren = await request(`/api/v1/cloud-projects/${project.id}/loop-items`)
  const copied = laterChildren.items.find(
    item => item.parent_id === issue.id && item.title === childBody && item.id !== createdChild.id
  )
  assert.ok(copied)
  assert.equal(copied.security_level, 'related')
  await memberRequest(`/api/v1/loop-items/${copied.id}`, 404)
  assert.equal(String(copied.assignee_user_id), String(owner.id))
  const retryInput = {
    title: 'Child request recovery',
    parent_id: issue.id,
    request_id: 'comment-child-recovery-' + issue.id,
    notify_assignee: false,
  }
  const [firstAttempt, concurrent] = await Promise.all(
    [0, 1].map(() =>
      request(`/api/v1/cloud-projects/${project.id}/loop-items`, {
        method: 'POST',
        body: JSON.stringify(retryInput),
      })
    )
  )
  assert.equal(concurrent.id, firstAttempt.id, 'Concurrent child creation retries must be atomic')
  const recovered = await request(`/api/v1/cloud-projects/${project.id}/loop-items`, {
    method: 'POST',
    body: JSON.stringify(retryInput),
  })
  assert.equal(
    recovered.id,
    firstAttempt.id,
    'Retrying a committed child request must reuse its persisted Issue'
  )
  const childComments = await request(
    `/api/v1/cloud-projects/${project.id}/loop-items/${issue.id}/activity-comments`
  )
  assert.ok(
    childComments.some(comment =>
      comment.body.includes(`wework-issue://${project.id}/${copied.id}`)
    ),
    'Creating from an existing comment must leave a linked discussion record'
  )
}

async function verifyShortcutSection(control, testId) {
  const redeliver = `[data-testid="${testId}-redeliver"]`
  const previous = `[data-testid="${testId}-return"]`
  const divider = `[data-testid^="${testId}-section-divider-"]`
  const ordinary = `[data-testid="${testId}-option-empty"]`
  await control.command('waitFor', `[data-testid="${testId}-menu"]`, {
    text: '快捷操作',
    visible: true,
  })
  const metrics = JSON.parse(
    await control.command(
      'getElementMetrics',
      [redeliver, previous, divider, ordinary].join(', '),
      {
        value: 'includeText',
      }
    )
  )
  assert.equal(metrics.length, 4, 'The quick actions must form a separate section')
  const [redeliverRow, previousRow, dividerRow, ordinaryRow] = metrics
  assert.equal(redeliverRow.testId, `${testId}-redeliver`)
  assert.equal(previousRow.testId, `${testId}-return`)
  assert.ok(dividerRow.testId.startsWith(`${testId}-section-divider-`))
  assert.equal(ordinaryRow.testId, `${testId}-option-empty`)
  assert.ok(
    [redeliverRow, previousRow, dividerRow, ordinaryRow].every(rect => rect.height > 0) &&
      redeliverRow.bottom < previousRow.top &&
      previousRow.bottom < dividerRow.top &&
      dividerRow.bottom < ordinaryRow.top,
    `Shortcut rows and regular assignees must not overlap: ${JSON.stringify(metrics)}`
  )
}

/** Reuse the member handoff fixture for the property and composer shortcuts. */
async function verifyAssigneeShortcuts(
  control,
  { request, memberRequest, project, issue, owner, member, selector, editor, send, scoped }
) {
  const issuePath = `/api/v1/loop-items/${issue.id}`
  const commentPath = `/api/v1/cloud-projects/${project.id}/loop-items/${issue.id}/activity-comments`
  const top = scoped('[data-testid="cloud-todo-detail-assignee"]')
  const topAction = action => `[data-testid="cloud-todo-detail-assignee-${action}"]`
  const bottomAction = action => `[data-testid="task-comment-form-assignee-${action}"]`
  const activeAssignment = async user => {
    const { items } = await request(`${issuePath}/assignments`)
    const direct = items.filter(row => row.target_type === 'human' && !row.workflow_step)
    assert.equal(direct.length, 1, 'Only one direct human assignment may remain active')
    assert.equal(String(direct[0].target_id), String(user.id))
    return direct[0]
  }
  let current = issue
  let receipt = await activeAssignment(owner)
  async function waitForHandoff(user, { redeliver = false, status = current.status } = {}) {
    const event = scoped(
      `[data-testid="cloud-task-assignment-event-${current.assignment_history.length}"]`
    )
    await control.command('waitFor', event, { text: user.user_name })
    const next = await request(issuePath)
    assert.equal(next.id, issue.id, 'A new delivery must reuse the same Issue')
    assert.equal(next.status, status)
    assert.equal(String(next.assignee_user_id), String(user.id))
    assert.equal(next.assignment_history.length, current.assignment_history.length + 1)
    assert.equal(next.assignment_history.at(-1).action, 'reassign')
    assert.equal(next.assignment_history.at(-1).redeliver === true, redeliver)
    assert.ok((await control.command('getText', event)).includes(redeliver ? '重新投递' : '转派'))
    const assignment = await activeAssignment(user)
    assert.notEqual(assignment.id, receipt.id, 'A new handoff must have a fresh assignment ID')
    assert.equal(assignment.receipt_tracking, true)
    const recipientRequest = user.id === owner.id ? request : memberRequest
    const notifications = await recipientRequest('/api/v1/wework-notifications')
    assert.equal(
      notifications.items.filter(
        notification =>
          notification.kind === 'issue_dispatch_assignment' &&
          notification.payload?.assignmentId === assignment.id
      ).length,
      1,
      'The recipient must receive exactly one notification for the new delivery'
    )
    current = next
    receipt = assignment
  }

  // Top shortcut immediately creates a fresh delivery to the current owner.
  const existingComments = (await request(commentPath)).map(comment => comment.id)
  await control.command('click', top)
  await setAssignmentNotification(control, false)
  await control.command('waitFor', topAction('redeliver'), { text: owner.user_name })
  await verifyShortcutSection(control, 'cloud-todo-detail-assignee')
  await control.command('click', topAction('redeliver'))
  await waitForHandoff(owner, { redeliver: true })
  assert.deepEqual(
    (await request(commentPath)).map(comment => comment.id),
    existingComments
  )

  // The previous distinct assignee is still the reviewer after redelivery to the owner.
  await control.command('click', top)
  await setAssignmentNotification(control, false)
  await control.command('waitFor', topAction('return'), { text: member.user_name })
  await control.command('click', topAction('return'))
  await waitForHandoff(member)

  // The composer stages its operation until Send, and saves the comment before delivery.
  const reviewBody = '复审说明：请检查修复结果'
  await control.command('fill', editor, { value: reviewBody })
  await control.command('click', selector)
  await control.command('waitFor', bottomAction('redeliver'), { text: member.user_name })
  await verifyShortcutSection(control, 'task-comment-form-assignee')
  await control.command('click', bottomAction('redeliver'))
  await control.command('waitFor', `${selector}[data-value="redeliver:user:${member.id}"]`)
  await control.command('waitFor', `${send}[aria-label="发送并重新投递"]`)
  const move = scoped(
    `${issueCommentFormSelector(issue.id)} [data-testid="task-comment-form-move"]`
  )
  const movedStatus = current.status === 'in_progress' ? 'completed' : 'in_progress'
  await control.command('click', move)
  await control.command('clickElementWithText', '[role="option"]', {
    text: movedStatus === 'completed' ? '已完成' : '进行中',
    visible: true,
  })
  assert.equal(
    (await request(issuePath)).assignment_history.length,
    current.assignment_history.length
  )
  assert.equal((await request(issuePath)).status, current.status)
  assert.equal((await activeAssignment(member)).id, receipt.id)
  assert.ok(!(await request(commentPath)).some(comment => comment.body.includes(reviewBody)))
  const statusEventId = `cloud-task-status-event-${current.status_history.length}`
  const assignmentEventId = `cloud-task-assignment-event-${current.assignment_history.length}`
  await control.command('clickWhenEnabled', send)
  await waitForHandoff(member, { redeliver: true, status: movedStatus })
  await control.command('waitFor', scoped(`[data-testid="${statusEventId}"]`))
  const timelineOrder = JSON.parse(
    await control.command('getTestIdOrder', scoped('[data-testid="cloud-task-activity-list"]'))
  )
  assert.ok(
    timelineOrder.indexOf(statusEventId) >= 0 &&
      timelineOrder.indexOf(statusEventId) < timelineOrder.indexOf(assignmentEventId),
    'The status move must be persisted before redelivery wakes the recipient'
  )
  const reviews = (await request(commentPath)).filter(comment => comment.body.includes(reviewBody))
  assert.equal(reviews.length, 1, 'Redelivery must save the new review exactly once')
  assert.ok(
    Date.parse(reviews[0].created_at) <= Date.parse(receipt.created_at),
    'The review comment must be saved before the new assignment'
  )
  await control.command('waitFor', scoped('[data-testid="cloud-task-activity-list"]'), {
    text: reviewBody,
  })
  await control.command('waitFor', `${selector}[data-value=""]`)

  // Returning from the composer without text must work without creating an empty comment.
  const commentCount = (await request(commentPath)).length
  await control.command('click', selector)
  await control.command('waitFor', bottomAction('return'), { text: owner.user_name })
  await control.command('click', bottomAction('return'))
  await control.command('waitFor', `${selector}[data-value="return:user:${owner.id}"]`)
  assert.equal((await activeAssignment(member)).id, receipt.id)
  await control.command('clickWhenEnabled', send)
  await waitForHandoff(owner)
  assert.equal((await request(commentPath)).length, commentCount)
  await control.command('waitFor', `${selector}[data-value=""]`)
  return current
}
