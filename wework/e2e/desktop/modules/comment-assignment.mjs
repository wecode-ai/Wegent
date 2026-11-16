import assert from 'node:assert/strict'

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
  const form = `${activity} [data-testid="task-comment-form"]`
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

  await request(`/api/v1/loop-items/${issue.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ version: restored.version, security_level: 'related' }),
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
    `[data-testid="issue-comment-create-child-${original.id}"][data-state="closed"]`
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
