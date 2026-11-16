import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyComposerLayout } from '../e2e/desktop/modules/issue-comment-workflow.mjs'

const form = '[data-testid="task-comment-form"]'
const send = `${form} [data-testid="send-message-button"]`
const menu = `${form} [data-testid="task-comment-form-send-actions"]`
const ids = [
  'task-comment-form',
  'task-comment-attach',
  'task-comment-form-assignee',
  'send-message-button',
  'task-comment-form-send-actions',
]

function movingDrawer(change = () => {}, opacity = '1') {
  let offset = 500
  return {
    async command(action, selector) {
      if (action === 'getComputedStyleValue') return opacity
      assert.equal(action, 'getElementMetrics')
      const controls = ids.map((testId, index) => ({
        testId,
        left: offset + (index ? 13 + index * 60 : 0),
        right: offset + (index ? 41 + index * 60 : 498),
        top: index ? 678 : 617,
        bottom: index ? 706 : 719,
      }))
      change(controls)
      offset -= 100
      return JSON.stringify(controls.filter(rect => selector.includes(`"${rect.testId}"`)))
    },
  }
}

test('compares one frame while the issue drawer is sliding into view', async () => {
  await verifyComposerLayout(movingDrawer(), form, send, menu)
})

test('still rejects an action outside the input frame', async () => {
  await assert.rejects(
    verifyComposerLayout(
      movingDrawer(controls => {
        controls[4].right = controls[0].right + 1
      }),
      form,
      send,
      menu
    ),
    /Every composer action must stay inside the input frame/
  )
})

test('still rejects a toolbar that wraps onto another row', async () => {
  await assert.rejects(
    verifyComposerLayout(
      movingDrawer(controls => {
        controls[4].top = controls[1].bottom
      }),
      form,
      send,
      menu
    ),
    /must share one row/
  )
})

test('still rejects faded disabled send text', async () => {
  await assert.rejects(
    verifyComposerLayout(movingDrawer(undefined, '0.4'), form, send, menu),
    /Disabled send text must not fade/
  )
})
