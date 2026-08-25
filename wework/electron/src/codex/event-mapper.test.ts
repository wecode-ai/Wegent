import { describe, expect, test } from 'vitest'
import { mapCodexEvent } from './event-mapper.js'

describe('mapCodexEvent', () => {
  test.each([
    ['item/agentMessage/delta', 'assistant/chunk'],
    ['item/reasoning/textDelta', 'assistant/reasoning-chunk'],
    ['item/started', 'codex/item-started'],
    ['item/completed', 'codex/item-completed'],
    ['item/commandExecution/requestApproval', 'codex/approval-requested'],
    ['turn/completed', 'turn/end'],
  ])('maps %s to %s', (method, expected) => {
    expect(mapCodexEvent('runtime:event', { method }).type).toBe(expected)
  })

  test('preserves unknown events as inspectable raw records', () => {
    expect(mapCodexEvent('custom', { value: 1 })).toMatchObject({
      type: 'codex/raw',
      data: { event: 'custom', value: 1 },
    })
  })
})
