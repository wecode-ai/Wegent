import assert from 'node:assert/strict'
import test from 'node:test'
import {
  dotsSilentIntakeEvents,
  revealDotsFollowupHistory,
} from '../e2e/desktop/scenarios/dots-closed-loops.scenario.mjs'

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

test('closes silent intake cleanly when the coordinator batch is invalidated mid-turn', () => {
  const events = dotsSilentIntakeEvents({
    input: [
      {
        type: 'function_call_output',
        call_id: 'dots-intake',
        output: [
          { type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
          { type: 'input_text', text: 'Coordinator batch or tool is no longer available' },
        ],
      },
    ],
  })
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'response.output_item.done')
  assert.equal(events[0].item.type, 'message')
  assert.match(events[0].item.content[0].text, /no longer available/i)
})

test('ignores batch events when read_intake returns a valid snapshot and rejects malformed output', () => {
  const events = dotsSilentIntakeEvents({
    tools: [{ type: 'function', name: 'mcp__wework_stand_in__ignore_events' }],
    input: [
      {
        type: 'function_call_output',
        call_id: 'dots-intake',
        output: JSON.stringify({ snapshot: { events: [{ id: 'evt-1' }] } }),
      },
    ],
  })
  assert.ok(events.some(event => event.item?.name === 'mcp__wework_stand_in__ignore_events'))
  assert.throws(() =>
    dotsSilentIntakeEvents({
      input: [{ type: 'function_call_output', call_id: 'dots-intake', output: 'unexpected error' }],
    })
  )
})
