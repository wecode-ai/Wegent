import assert from 'node:assert/strict'

export async function verifyExecutionActivityOrder(control, scope, phase, timeoutMs) {
  const list = scope('[data-testid="cloud-task-activity-list"]')
  const expectedStatus = phase === 'running' ? '进行中' : '待确认'
  await control.command('waitFor', `${list} [data-testid^="cloud-task-status-event-"]`, {
    text: expectedStatus,
    timeoutMs,
  })
  await control.command('waitFor', `${list} [data-testid^="cloud-task-activity-card-"]`, {
    timeoutMs,
  })
  const order = JSON.parse(await control.command('getTestIdOrder', list))
  const statusIds = order.filter(id => id.startsWith('cloud-task-status-event-'))
  const cardId = order.find(id => id.startsWith('cloud-task-activity-card-'))
  assert.ok(statusIds.length >= 2, `Missing ${phase} Issue status history: ${order}`)
  const lastStatus = statusIds.at(-1)
  assert.ok(
    (await control.command('getText', scope(`[data-testid="${lastStatus}"]`))).includes(
      expectedStatus
    ),
    `The last status event does not describe the ${phase} execution`
  )
  assert.ok(
    order.indexOf(lastStatus) < order.indexOf(cardId),
    `The ${phase} execution activity appeared before its status transition: ${order}`
  )
}
