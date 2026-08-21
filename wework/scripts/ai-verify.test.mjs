import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import {
  appExitMessage,
  monitorAppProcess,
  readSessionForCleanup,
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
      'Wework failed to start: spawn bash ENOENT before its WebView connected to AI verification'
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

describe('readSessionForCleanup', () => {
  test('waits for the controller to publish its launcher pid', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-ai-verify-cleanup-'))
    const sessionPath = join(directory, 'session.json')
    await writeFile(sessionPath, '{')
    const update = setTimeout(
      () =>
        void writeFile(
          sessionPath,
          JSON.stringify({ directory: '/isolated/session', launcherPid: 42 })
        ),
      10
    )

    try {
      await expect(readSessionForCleanup(sessionPath, 200)).resolves.toEqual({
        directory: '/isolated/session',
        launcherPid: 42,
      })
    } finally {
      clearTimeout(update)
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('derives the session directory when parsing never succeeds', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-ai-verify-cleanup-'))
    const sessionPath = join(directory, 'session.json')
    try {
      await expect(readSessionForCleanup(sessionPath, 1)).resolves.toEqual({ directory })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('monitorAppProcess', () => {
  test('captures a fast spawn error and rejects pending commands', async () => {
    const app = new EventEmitter()
    let appExit
    let rejectPending
    const pendingResult = new Promise((_, reject) => {
      rejectPending = reject
    })
    const pendingExpectation = expect(pendingResult).rejects.toThrow(
      'Wework failed to start: spawn bash ENOENT'
    )

    monitorAppProcess(app, new Map([['command', { reject: rejectPending }]]), exit => {
      appExit = exit
    })
    app.emit('error', new Error('spawn bash ENOENT'))

    await pendingExpectation
    expect(appExitMessage(appExit)).toBe('Wework failed to start: spawn bash ENOENT')
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
