import assert from 'node:assert/strict'
import { signInDesktopCloud } from './desktop-cloud-login.mjs'
import { openProjectBoard } from './collaboration-board-personal-view.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const scoped = selector => `${CONTENT} ${selector}`

/** The public reply and caller-owned runtime preview have separate read boundaries. */
export async function verifyGroupThreadBoardPrivacy({
  control,
  cloud,
  request,
  owner,
  member,
  memberToken,
  group,
  issue,
  binding,
  project,
  publicReply,
  uiTimeoutMs,
  captureScreenshot,
}) {
  const card = scoped(`[data-testid="cloud-todo-card-${issue.id}"]`)
  const summary = scoped(`[data-testid="cloud-todo-card-task-summary-${issue.id}-${binding.id}"]`)
  const result = scoped(`[data-testid="cloud-todo-card-final-response-${issue.id}"]`)
  const openGroupBoard = async () => {
    await control.command('openWeworkScheme', 'body', {
      value: `wework://groups/backend/${encodeURIComponent(group.id)}`,
    })
    await control.command('waitFor', scoped('[data-testid="group-room"]'), { visible: true })
    await control.command('click', scoped('[data-testid="group-tab-board"]'))
    await control.command('waitFor', card, { visible: true })
  }
  const openAggregateBoard = async () => {
    await control.command('click', scoped('[data-testid="collaboration-view-projects"]'))
    await openProjectBoard(control, scoped, project)
    await control.command('waitFor', card, { visible: true })
  }
  const assertPrivatePreview = async visible => {
    if (visible) {
      await control.command('waitFor', summary)
      await control.command('waitFor', result, { text: publicReply, timeoutMs: uiTimeoutMs })
    } else {
      assert.equal(Number(await control.command('getElementCount', summary)), 0)
      assert.equal(Number(await control.command('getElementCount', result)), 0)
      assert.equal((await control.command('getText', card)).includes(publicReply), false)
    }
  }
  const ownerSnapshot = await request(`/api/v1/cloud-projects/${group.id}/board-snapshot`)
  assert.ok(ownerSnapshot.task_bindings.some(row => row.id === binding.id))
  await openGroupBoard()
  await assertPrivatePreview(true)
  await captureScreenshot(control, 'cloud-private-preview-owner-group.png', CONTENT)

  const link = await request(`/api/v1/loop-items/${issue.id}/project-link`)
  await request(`/api/v1/loop-items/${issue.id}/project-link`, {
    method: 'PUT',
    body: { version: link.thread_version, project_id: String(project.id) },
  })
  const ownerProject = await request(`/api/v1/cloud-projects/${project.id}/board-snapshot`)
  assert.ok(
    ownerProject.task_bindings.some(row => row.id === binding.id),
    'The executor must retain their own preview on the project aggregation board'
  )
  await openAggregateBoard()
  await assertPrivatePreview(true)
  await captureScreenshot(control, 'cloud-private-preview-owner-project.png', CONTENT)

  await request(`/api/v1/chat-groups/${group.id}/members`, {
    method: 'POST',
    body: { user_id: member.id, role: 'Developer' },
  })
  await request(`/api/v1/cloud-projects/${project.id}/members`, {
    method: 'POST',
    status: 201,
    body: { user_id: member.id, role: 'Developer' },
  })
  for (const container of [group, project]) {
    const snapshot = await request(`/api/v1/cloud-projects/${container.id}/board-snapshot`, {
      token: memberToken,
    })
    assert.ok(snapshot.items.some(row => row.id === issue.id))
    assert.ok(!snapshot.task_bindings.some(row => row.loop_item_id === issue.id))
  }
  assert.deepEqual(
    await request(`/api/v1/loop-items/${issue.id}/tasks`, { token: memberToken }),
    []
  )
  try {
    await signInDesktopCloud(control, cloud, {
      token: memberToken,
      user: member,
      timeoutMs: uiTimeoutMs,
    })
    await openGroupBoard()
    await assertPrivatePreview(false)
    await captureScreenshot(control, 'cloud-private-preview-member-group.png', CONTENT)
    await openAggregateBoard()
    await assertPrivatePreview(false)
    await captureScreenshot(control, 'cloud-private-preview-member-project.png', CONTENT)
    await control.command('click', card)
    await control.command('waitFor', scoped('[data-testid="thread-room"]'))
    await control.command('waitFor', scoped('[data-testid="group-message-list"]'), {
      text: publicReply,
    })
    await captureScreenshot(control, 'cloud-public-reply-readable-by-member.png', CONTENT)
  } finally {
    await signInDesktopCloud(control, cloud, { user: owner, timeoutMs: uiTimeoutMs })
  }
  await openGroupBoard()
  await assertPrivatePreview(true)
}
