import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyAssignmentActivityReceipts } from '../e2e/desktop/modules/assignment-activity-receipts.mjs'

function controlFor(texts) {
  return {
    async command(action, selector) {
      if (action === 'waitFor') return ''
      if (action === 'getTestIdOrder') return JSON.stringify(['cloud-task-assignment-event-2'])
      if (action === 'getElementCount') return '1'
      assert.equal(action, 'getText')
      assert.ok(selector.includes('issue-assignment-receipts'))
      assert.ok(selector.includes('issue-assignment-activity-receipts'))
      return texts.shift()
    },
  }
}

test('compares one loaded receipt snapshot across an intervening Issue version refresh', async () => {
  const received = '本人已读 · 05:42 PM分身已接收 · 05:42 PM'
  const snapshots = [received, `${received}\n${received}`]
  await verifyAssignmentActivityReceipts(controlFor(snapshots), '分身已接收')
  assert.equal(snapshots.length, 0)
})

test('still rejects different reception timestamps in one loaded snapshot', async () => {
  await assert.rejects(
    verifyAssignmentActivityReceipts(
      controlFor(['分身已接收 · 05:42 PM\n分身已接收 · 05:43 PM']),
      '分身已接收'
    ),
    /must display the same reception timestamps/
  )
})
