import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import {
  acknowledgeStartedCommand,
  appExitMessage,
  monitorAppProcess,
  readSessionForCleanup,
  resolveCommandTimeout,
  resolveStartupTimeout,
  startupFailureMessage,
  visibleWorkbenchProbe,
} from './ai-verify.mjs'

describe('acknowledgeStartedCommand', () => {
  test('accepts the start acknowledgement for a pending command', () => {
    expect(
      acknowledgeStartedCommand(new Map([['command-1', {}]]), {
        id: 'command-1',
        clientId: 'client-1',
      })
    ).toEqual({ status: 200, value: { ok: true } })
  })

  test('rejects acknowledgements for commands that are no longer pending', () => {
    expect(
      acknowledgeStartedCommand(new Map(), {
        id: 'missing-command',
        clientId: 'client-1',
      })
    ).toEqual({
      status: 404,
      value: { error: 'Unknown command missing-command' },
    })
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

  test('reports a connected WebView whose workbench is still loading', () => {
    expect(startupFailureMessage({ ready: true, pid: 42 }, 120000)).toContain(
      'WebView was connected but its main workbench was not fully visible'
    )
  })
})

describe('visibleWorkbenchProbe', () => {
  const visibleProbe = {
    location: 'tauri://localhost/',
    windowLabel: 'main',
    shellVisible: true,
    contentVisible: true,
    loadingVisible: false,
    startupVisible: false,
    startupError: false,
  }

  test('requires both the control client and a fully visible main workbench', () => {
    expect(visibleWorkbenchProbe({ ready: false, probes: [visibleProbe] })).toBeNull()
    expect(visibleWorkbenchProbe({ ready: true, probes: [visibleProbe] })).toEqual(visibleProbe)
  })

  test.each([
    ['loading placeholder', { loadingVisible: true }],
    ['startup screen', { startupVisible: true }],
    ['startup error', { startupError: true }],
    ['hidden shell', { shellVisible: false }],
    ['hidden content', { contentVisible: false }],
    ['auxiliary window', { windowLabel: 'workspace-task-1' }],
  ])('rejects a %s', (_name, override) => {
    expect(
      visibleWorkbenchProbe({
        ready: true,
        probes: [{ ...visibleProbe, ...override }],
      })
    ).toBeNull()
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
