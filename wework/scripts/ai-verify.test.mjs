import { describe, expect, test, vi } from 'vitest'
import {
  resolveCommandTimeout,
  resolveStartupTimeout,
  startupFailureMessage,
  takeWritableCommandPoll,
} from './ai-verify.mjs'

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

describe('resolveStartupTimeout', () => {
  test('accepts finite positive timeout values', () => {
    expect(resolveStartupTimeout('120000')).toBe(120000)
    expect(resolveStartupTimeout(undefined)).toBe(120000)
  })

  test.each(['0', '-1', 'Infinity', 'not-a-number'])('rejects invalid timeout %s', timeout => {
    expect(() => resolveStartupTimeout(timeout)).toThrow(
      '--timeout must be a finite positive number'
    )
  })
})

describe('startupFailureMessage', () => {
  test('reports an exited launcher without waiting for the timeout', () => {
    expect(
      startupFailureMessage(
        {
          appExited: true,
          appExitCode: 1,
          appExitSignal: null,
        },
        120000
      )
    ).toBe('Wework exited with code 1 before its WebView connected to AI verification')
  })

  test('reports launcher spawn errors', () => {
    expect(
      startupFailureMessage(
        {
          appExited: true,
          appExitError: 'spawn bash ENOENT',
        },
        120000
      )
    ).toBe(
      'Wework failed to start before its WebView connected to AI verification: spawn bash ENOENT'
    )
  })

  test('distinguishes launcher preparation from WebView connection', () => {
    expect(startupFailureMessage({ pid: null }, 120000)).toContain(
      'the Tauri launcher had not started'
    )
    expect(startupFailureMessage({ pid: 42 }, 120000)).toContain(
      'the Tauri launcher was still waiting for its WebView'
    )
  })
})

describe('resolveCommandTimeout', () => {
  test('uses finite positive timeout values', () => {
    expect(resolveCommandTimeout('120000')).toBe(120000)
  })

  test.each([undefined, '0', '-1', 'Infinity', 'not-a-number'])(
    'uses the command default for %s',
    timeout => {
      expect(resolveCommandTimeout(timeout)).toBe(30000)
    }
  )
})
