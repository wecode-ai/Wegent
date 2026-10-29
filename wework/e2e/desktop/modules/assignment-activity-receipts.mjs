import assert from 'node:assert/strict'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const ACTIVITY = `${CONTENT} [data-testid="cloud-task-activity-list"]`
const RECEIPTS = '[data-testid="issue-assignment-activity-receipts"]'

export async function verifyAssignmentActivityReceipts(control, status) {
  if (status === null) {
    assert.equal(
      await control.command('getElementCount', `${ACTIVITY} ${RECEIPTS}`),
      '0',
      'Unassignment must not retain the previous recipient receipt'
    )
    return
  }
  const header = `${CONTENT} [data-testid="issue-assignment-receipts"]`
  await control.command('waitFor', header, { text: status })
  await control.command('waitFor', `${ACTIVITY} [data-testid^="cloud-task-assignment-event-"]`)
  const order = JSON.parse(await control.command('getTestIdOrder', ACTIVITY))
  const latest = order.filter(id => /^cloud-task-assignment-event-\d+$/.test(id)).at(-1)
  assert.ok(latest, 'The Issue must expose its saved assignment activity')
  const current = `${ACTIVITY} [data-testid="${latest}"] ${RECEIPTS}`
  await control.command('waitFor', current, { text: status })
  assert.equal(
    await control.command('getElementCount', `${ACTIVITY} ${RECEIPTS}`),
    '1',
    'Current receipts must belong to exactly the latest assignment activity'
  )
  assert.equal(
    await control.command('getText', current),
    await control.command('getText', header),
    'The assignment control and activity must display the same reception timestamps'
  )
}
