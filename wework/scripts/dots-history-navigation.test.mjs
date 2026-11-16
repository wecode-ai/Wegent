import assert from 'node:assert/strict'
import test from 'node:test'
import { revealDotsFollowupHistory } from '../e2e/desktop/scenarios/dots-closed-loops.scenario.mjs'

test('reveals the original delivered plan through the real request marker and distinct result message', async () => {
  const calls = []
  const scope = await revealDotsFollowupHistory({
    async command(action, selector, options) {
      calls.push({ action, selector, options })
      if (action === 'getAttribute')
        return options.value === 'data-turn-index' ? '11' : 'native-original-result-message'
    },
  })
  assert.deepEqual(
    calls.map(call => call.action),
    [
      'waitFor',
      'getAttribute',
      'clickWhenEnabled',
      'scrollIntoViewAsUser',
      'waitFor',
      'scrollIntoViewAsUser',
      'getAttribute',
    ]
  )
  assert.equal(calls[1].options.text, 'DOTS_REVENUE_REQUEST_2')
  assert.ok(calls[2].selector.endsWith('[data-turn-index="11"]'))
  assert.equal(calls[3].options.text, 'DOTS_REVENUE_REQUEST_2')
  assert.equal(calls[4].options.text, 'DOTS_REVENUE_RESULT_2')
  assert.equal(calls[5].options.text, 'DOTS_REVENUE_RESULT_2')
  assert.ok(scope.endsWith('[data-message-id="native-original-result-message"]'))
  assert.ok(calls.every(call => !call.options?.timeoutMs))
})

test('rejects missing native turn indexes rather than guessing an index or sending a new message', async () => {
  const calls = []
  await assert.rejects(
    revealDotsFollowupHistory({
      async command(action) {
        calls.push(action)
        return null
      },
    })
  )
  assert.deepEqual(calls, ['waitFor', 'getAttribute'])
})
