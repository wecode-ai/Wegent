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
  const current = `${ACTIVITY} [data-testid="${latest}"] ${RECEIPTS}`
  await control.command('waitFor', current, { text: status })
  assert.equal(
    await control.command('getElementCount', `${ACTIVITY} ${RECEIPTS}`),
    '1',
    'Current receipts must belong to exactly the latest assignment activity'
  )
  // Issue status updates invalidate version-scoped receipts while they reload.
  // Read both surfaces in one DOM turn instead of comparing different versions.
  const deadline = Date.now() + DEFAULT_STEP_TIMEOUT_MS
  let texts = []
  while (Date.now() < deadline) {
    texts = (await control.command('getText', `${header}, ${current}`)).split('\n')
    if (texts.length === 2 && texts.every(text => text.includes(status))) break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.equal(texts.length, 2, 'Both receipt surfaces must finish loading in the same snapshot')
  assert.ok(
    texts.every(text => text.includes(status)),
    'Both receipts must show the saved status'
  )
  assert.equal(
    texts[0],
    texts[1],
    'The assignment control and activity must display the same reception timestamps'
  )
}
