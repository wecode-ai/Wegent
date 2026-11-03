import assert from 'node:assert/strict'

/** Verify the comment picker uses the same persisted targets as Issue properties. */
export async function verifyCommentAssignmentTargets(
  control,
  { request, project, issue: originalIssue, owner, agent, scoped, capture }
) {
  const group = await request(`/api/v1/cloud-projects/${project.id}/collaboration-groups`, {
    method: 'POST',
    body: JSON.stringify({
      name: `评论转派小组-${process.pid}`,
      leader: { kind: 'human', id: String(owner.id) },
      members: [{ kind: 'human', id: String(owner.id) }],
    }),
  })
  const issue = await request(`/api/v1/cloud-projects/${project.id}/loop-items`, {
    method: 'POST',
    body: JSON.stringify({ title: '评论区多类型负责人回归', notify_assignee: false }),
  })
  await control.command('openWeworkScheme', 'body', {
    value: `wework://boards/${project.id}/issues/${issue.id}`,
  })
  const form = scoped(
    `[data-testid="cloud-task-activity-${issue.id}"] [data-testid="task-comment-form"]`
  )
  const picker = `${form} [data-testid="task-comment-form-assignee"]`
  const send = `${form} [data-testid="send-message-button"]`
  await control.command('waitFor', picker)
  for (const target of [
    { value: `agent:${agent.id}`, name: agent.name, field: 'assignee_agent_id', id: agent.id },
    { value: `group:${group.id}`, name: group.name, field: 'assignee_group_id', id: group.id },
    { value: String(owner.id), name: owner.user_name, field: 'assignee_user_id', id: owner.id },
  ]) {
    const before = await request(`/api/v1/loop-items/${issue.id}`)
    await control.command('click', picker)
    if (target.field === 'assignee_agent_id') {
      await capture(control, 'collaboration-comment-assignment-targets.png')
    }
    await control.command(
      'click',
      `[data-testid="task-comment-form-assignee-option-${target.value}"]`
    )
    await control.command('waitFor', picker, { text: target.name })
    const selected = await request(`/api/v1/loop-items/${issue.id}`)
    for (const field of [
      'assignee_user_id',
      'assignee_agent_id',
      'assignee_team_id',
      'assignee_group_id',
    ]) {
      assert.equal(
        selected[field] ?? null,
        before[field] ?? null,
        'Selecting a target must not transfer ownership'
      )
    }
    await control.command('clickWhenEnabled', send)
    // The reset follows the persisted assignment, rather than only the click.
    await control.command('waitFor', `${picker}[data-value=""]`)
    const saved = await request(`/api/v1/loop-items/${issue.id}`)
    assert.equal(String(saved[target.field]), String(target.id))
    for (const field of [
      'assignee_user_id',
      'assignee_agent_id',
      'assignee_team_id',
      'assignee_group_id',
    ]) {
      if (field !== target.field) assert.equal(saved[field] ?? null, null)
    }
  }
  const comments = await request(
    `/api/v1/cloud-projects/${project.id}/loop-items/${issue.id}/activity-comments`
  )
  assert.equal(comments.length, 0, 'Assignment-only actions must not create comments')
  await control.command('openWeworkScheme', 'body', {
    value: `wework://boards/${project.id}/issues/${originalIssue.id}`,
  })
  await control.command(
    'waitFor',
    scoped(`[data-testid="cloud-task-activity-${originalIssue.id}"]`)
  )
  const latest = await request(`/api/v1/loop-items/${issue.id}`)
  await request(`/api/v1/loop-items/${issue.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ version: latest.version, status: 'completed' }),
  })
  await request(`/api/v1/loop-items/${issue.id}`, { method: 'DELETE' })
  await request(`/api/v1/cloud-projects/${project.id}/collaboration-groups/${group.id}`, {
    method: 'DELETE',
  })
}
