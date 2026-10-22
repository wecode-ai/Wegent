import assert from 'node:assert/strict'

/** Exercise comment handoff against real project members, comments and assignment APIs. */
export async function verifyCommentAssignment(control, { request, project, owner, member }) {
  const content = '[data-workspace-tab-content][aria-hidden="false"]'
  const scoped = selector => `${content} ${selector}`
  const issue = await request(`/api/v1/cloud-projects/${project.id}/loop-items`, {
    method: 'POST',
    body: JSON.stringify({ title: '讨论区直接转派回归', notify_assignee: false }),
  })
  await control.command('openWeworkScheme', 'body', {
    value: `wework://boards/${project.id}/issues/${issue.id}`,
  })
  const form = scoped('[data-testid="task-comment-form"]')
  const editor = `${form} [data-testid="cloud-task-activity-composer"]`
  const selector = `${form} [data-testid="task-comment-form-assignee"]`
  const send = `${form} [data-testid="send-message-button"]`
  await control.command('waitFor', selector)
  const body = `[$@${member.user_name}](wework-member://${member.id}) [$@${owner.user_name}](wework-member://${owner.id}) 请接手审核`
  await control.command('fill', editor, { value: body })
  await control.command('waitFor', `${selector}[data-value="${member.id}"]`)
  await control.command('waitFor', send, { text: '发送并转派' })
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
  await control.command('waitFor', send, { text: '转派' })
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
}
