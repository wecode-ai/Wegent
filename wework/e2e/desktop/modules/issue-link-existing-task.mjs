import assert from 'node:assert/strict'
import { verifyProjectFieldFocus } from './project-create-focus-indicator.mjs'
import { inCollaborationSidebar } from './workspace-flows.mjs'

/** Reuse the checkpoint's completed real runtime session; no new model turn is needed. */
export async function verifyLinkExistingTask({
  control,
  request,
  createIssue,
  owner,
  projectId,
  taskId,
  originalIssueId,
  uiTimeoutMs,
}) {
  const originalBindings = await request(`/api/v1/loop-items/${originalIssueId}/tasks`)
  const original = originalBindings.find(binding => binding.task_id === taskId)
  assert.ok(original, 'The checkpoint must supply the existing task binding')
  await control.command('click', '[data-testid="cloud-todo-detail-close"]')
  const issue = await createIssue(
    control,
    projectId,
    request,
    owner,
    uiTimeoutMs,
    `Link existing task ${process.pid}`
  )
  const before = await request(`/api/v1/loop-items/${issue.id}`)
  // The board and personal home must expose the same shared action.
  await control.command('waitFor', '[data-testid="issue-link-existing-task"]', { visible: true })
  await control.command('click', '[data-testid="cloud-todo-detail-close"]')
  await control.command(
    'click',
    inCollaborationSidebar('[data-testid="collaboration-primary-home"]')
  )
  await control.command('click', '[data-testid="personal-home-scope-participating"]')
  const homeIssue = `[data-testid="personal-home-issue-${issue.id}"]`
  await control.command('waitFor', homeIssue, { visible: true })
  await control.command('click', homeIssue)
  await control.command('waitFor', '[data-testid="issue-link-existing-task"]', { visible: true })
  await control.command('click', '[data-testid="issue-link-existing-task"]')
  await control.command('fill', '[data-testid="issue-existing-task-search"]', { value: taskId })
  const candidate = `[data-testid="issue-existing-task-picker"] button[data-testid$="-${taskId}"]`
  await control.command('waitFor', candidate, { visible: true })
  await verifyProjectFieldFocus(control, 'issue-existing-task-search', {
    includeParent: true,
    nextButtonPattern: /^issue-existing-task-.+-.+$/,
  })
  assert.equal(
    await control.command('getActiveElementTestId', 'body'),
    await control.command('getAttribute', candidate, { value: 'data-testid' })
  )
  await control.command('pointerClick', candidate)
  await control.command('waitFor', '[data-testid="cloud-todo-execution-task-count"]', { text: '1' })
  const bindings = await request(`/api/v1/loop-items/${issue.id}/tasks`)
  assert.equal(bindings.length, 1)
  assert.equal(bindings[0].task_id, taskId)
  assert.equal((await request(`/api/v1/loop-items/${issue.id}`)).status, before.status)
  await control.command('click', '[data-testid="issue-link-existing-task"]')
  await control.command('fill', '[data-testid="issue-existing-task-search"]', { value: taskId })
  assert.equal(
    Number(await control.command('getElementCount', candidate)),
    0,
    'An existing binding must not be offered twice'
  )
  await control.command('press', '[data-testid="issue-existing-task-search"]', { key: 'Escape' })
  await control.command('openWeworkScheme', 'body', {
    value: `wework://boards/${projectId}/issues/${issue.id}`,
  })
  await control.command('waitFor', '[data-testid="cloud-todo-execution-task-count"]', { text: '1' })
  await control.command('waitFor', '[data-testid="issue-link-existing-task"]', { visible: true })
  assert.equal(
    (await request(`/api/v1/loop-items/${issue.id}/tasks`)).length,
    1,
    'The saved binding survives navigation between home and board'
  )
  // Restore the borrowed task so later privacy checks keep their own prerequisites.
  await request(`/api/v1/loop-items/${originalIssueId}/tasks`, {
    method: 'POST',
    body: JSON.stringify({ deviceId: original.device_id, taskId, taskTitle: original.task_title }),
  })
  const restored = await request(`/api/v1/loop-items/${originalIssueId}/tasks`)
  assert.ok(
    restored.some(binding => binding.task_id === taskId),
    'Restore the original binding after testing the move'
  )
}
