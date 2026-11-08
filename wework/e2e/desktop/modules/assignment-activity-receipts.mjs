import assert from 'node:assert/strict'
import { DEFAULT_STEP_TIMEOUT_MS } from './shared.mjs'

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
  // Issue status updates invalidate version-scoped receipts while they reload.
  // Observe presence, ownership, count and timestamps in the same DOM turn.
  const loaded = `${CONTENT}:has([data-testid="${latest}"] ${RECEIPTS})`
  const selector = `${loaded} [data-testid="issue-assignment-receipts"], ${loaded} [data-testid="cloud-task-activity-list"] ${RECEIPTS}`
  const deadline = Date.now() + DEFAULT_STEP_TIMEOUT_MS
  let receipts = []
  while (Date.now() < deadline) {
    receipts = JSON.parse(
      await control.command('getElementMetrics', selector, { value: 'includeText' })
    )
    const loadedHeader = receipts.some(
      receipt => receipt.testId === 'issue-assignment-receipts' && receipt.text.includes(status)
    )
    const loadedActivity = receipts.some(
      receipt =>
        receipt.testId === 'issue-assignment-activity-receipts' && receipt.text.includes(status)
    )
    if (loadedHeader && loadedActivity) break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.equal(
    receipts.filter(receipt => receipt.testId === 'issue-assignment-activity-receipts').length,
    1,
    'Current receipts must belong to exactly the latest assignment activity'
  )
  assert.equal(receipts.length, 2, 'Both receipt surfaces must finish loading in the same snapshot')
  assert.ok(
    receipts.every(receipt => receipt.text.includes(status)),
    'Both receipts must show the saved status'
  )
  assert.equal(
    receipts[0].text,
    receipts[1].text,
    'The assignment control and activity must display the same reception timestamps'
  )
}
