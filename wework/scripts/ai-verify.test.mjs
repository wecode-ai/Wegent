import { describe, expect, test, vi } from 'vitest'
import { takeWritableCommandPoll } from './ai-verify.mjs'

function commandPoll(response) {
  return {
    response,
    timer: setTimeout(() => {}, 60_000),
    closed: false,
  }
}

describe('takeWritableCommandPoll', () => {
  test('skips disconnected responses and returns the next writable poll', () => {
    const disconnected = commandPoll({ destroyed: true, writableEnded: false })
    const closed = commandPoll({ destroyed: false, writableEnded: false })
    closed.closed = true
    const ended = commandPoll({ destroyed: false, writableEnded: true })
    const writable = commandPoll({ destroyed: false, writableEnded: false })
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')

    expect(takeWritableCommandPoll([disconnected, closed, ended, writable])).toBe(writable)
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(4)

    clearTimeoutSpy.mockRestore()
  })

  test('returns undefined when every pending response is stale', () => {
    const stalePolls = [
      commandPoll({ destroyed: true, writableEnded: false }),
      commandPoll({ destroyed: false, writableEnded: true }),
    ]

    expect(takeWritableCommandPoll(stalePolls)).toBeUndefined()
    expect(stalePolls).toHaveLength(0)
  })
})
