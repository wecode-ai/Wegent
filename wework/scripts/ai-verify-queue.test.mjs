import { describe, expect, test } from 'vitest'
import { removeQueuedCommand, requestedControlPort } from './ai-verify-queue.mjs'

describe('AI verification command queue', () => {
  test('removes a timed-out command without disturbing later commands', () => {
    const queue = [{ id: 'expired' }, { id: 'next' }]

    removeQueuedCommand(queue, 'expired')

    expect(queue).toEqual([{ id: 'next' }])
  })

  test('reuses an existing controller port only when present', () => {
    expect(requestedControlPort({})).toBe(0)
    expect(requestedControlPort({ controlUrl: 'http://127.0.0.1:43123' })).toBe(43123)
  })
})
