import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyAssignmentActivityReceipts } from '../e2e/desktop/modules/assignment-activity-receipts.mjs'

function controlFor(snapshots) {
  return {
    async command(action, selector, options) {
      if (action === 'waitFor') return ''
      if (action === 'getTestIdOrder') return JSON.stringify(['cloud-task-assignment-event-2'])
      assert.equal(action, 'getElementMetrics')
      assert.ok(selector.includes('issue-assignment-receipts'))
      assert.ok(selector.includes('issue-assignment-activity-receipts'))
      assert.ok(selector.includes(':has([data-testid="cloud-task-assignment-event-2"]'))
      assert.equal(options.value, 'includeText')
      return JSON.stringify(snapshots.shift())
    },
  }
}

const receipt = (text, activity = false) => ({
  testId: activity ? 'issue-assignment-activity-receipts' : 'issue-assignment-receipts',
  text,
})

test('compares one loaded receipt snapshot across an intervening Issue version refresh', async () => {
  const received = '本人已读 · 05:42 PM分身已接收 · 05:42 PM'
  const snapshots = [[], [receipt(received)], [receipt(received), receipt(received, true)]]
  await verifyAssignmentActivityReceipts(controlFor(snapshots), '分身已接收')
  assert.equal(snapshots.length, 0)
})

test('still rejects different reception timestamps in one loaded snapshot', async () => {
  await assert.rejects(
    verifyAssignmentActivityReceipts(
      controlFor([[receipt('分身已接收 · 05:42 PM'), receipt('分身已接收 · 05:43 PM', true)]]),
      '分身已接收'
    ),
    /must display the same reception timestamps/
  )
})

test('still rejects an empty duplicate activity receipt in the same loaded snapshot', async () => {
  const received = '分身已接收 · 05:42 PM'
  await assert.rejects(
    verifyAssignmentActivityReceipts(
      controlFor([[receipt(received), receipt(received, true), receipt('', true)]]),
      '分身已接收'
    ),
    /exactly the latest assignment activity/
  )
})
