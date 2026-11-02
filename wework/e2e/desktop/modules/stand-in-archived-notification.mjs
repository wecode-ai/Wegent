import assert from 'node:assert/strict'
import { requestExecutor } from './executor-rpc.mjs'
import { reloadMainWindow } from './workspace-flows.mjs'

export async function verifyArchivedStandInNotification({
  control,
  request,
  projectId,
  issueId,
  taskId,
  userId,
  uiTimeoutMs,
}) {
  const rpc = (method, payload) => requestExecutor(control, method, payload, uiTimeoutMs)
  const inbox = await request('/v1/wework-notifications?category=collaboration')
  const notice = inbox.items.find(row => row.payload.itemId === issueId)
  assert.ok(notice, 'The archived execution must have its original assignment notification')
  const assignments = [
    { projectId, itemId: issueId, humanAssignmentId: notice.payload.humanAssignmentId },
  ]
  assert.equal((await rpc('runtime.tasks.archive', { taskId })).accepted, true)
  const history = await rpc('runtime.stand_in.assignment_tasks', { userId, assignments })
  assert.equal(history.items.length, 1)
  assert.equal(history.items[0].taskId, taskId)
  assert.equal(history.items[0].status, 'archived')
  await control.command('click', '[data-testid="wework-notifications-button"]')
  await reloadMainWindow(control, 'Archived assignment history must survive renderer restart')
  await control.command('waitFor', '[data-testid="wework-notifications-button"]')
  await control.command('click', '[data-testid="wework-notifications-button"]')
  await control.command('waitFor', '[data-testid="wework-notifications-category-collaboration"]')
  await control.command('click', '[data-testid="wework-notifications-category-collaboration"]')
  await control.command('clickWhenEnabled', '[data-testid="wework-notifications-refresh"]')
  await control.command('waitFor', `[data-testid="notification-stand-in-status-${notice.id}"]`, {
    text: '处理完毕，等你检查',
  })
  assert.equal(
    await control.command(
      'getElementCount',
      `[data-testid="notification-stand-in-start-${notice.id}"]`
    ),
    '0'
  )
  assert.equal(
    (await rpc('runtime.tasks.get', { taskId })).code,
    'task_archived',
    'Reading notification history must not restore or rerun the archived execution'
  )
}
