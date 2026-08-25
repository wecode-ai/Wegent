import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import {
  AI_VERIFY_ACTIONS,
  acknowledgeStartedCommand,
  appExitMessage,
  monitorAppProcess,
  parseArgs,
  readSessionForCleanup,
  resolveCommandTimeout,
  resolveOptionalBoolean,
  resolveStartupTimeout,
  startupFailureMessage,
  validateStartOptions,
} from './ai-verify.mjs'

describe('AI_VERIFY_ACTIONS', () => {
  test('preserves the complete legacy command surface', () => {
    expect(AI_VERIFY_ACTIONS).toEqual({
      capture: 'capture',
      'capture-browser': 'captureEmbeddedBrowser',
      'capture-popout': 'capturePopoutWindow',
      'capture-workspace': 'captureWorkspaceWindow',
      snapshot: 'snapshot',
      debug: 'getWorkbenchDebugSnapshot',
      'active-element': 'getActiveElementTestId',
      click: 'click',
      'click-at': 'clickAt',
      'click-then-macrotask': 'clickThenMacrotask',
      'context-menu': 'contextMenu',
      'seed-local-project': 'seedLocalProject',
      'preview-plugin-import': 'previewPluginImport',
      'import-plugin-package': 'importPluginPackage',
      'set-local-proxy-url': 'setLocalProxyUrl',
      'terminal-snapshot': 'readLocalTerminalSnapshot',
      reload: 'reloadApp',
      'close-to-tray': 'closeMainWindowToTray',
      'request-close': 'requestMainWindowClose',
      'dismiss-popout': 'dismissPopoutWindow',
      drag: 'drag',
      'drop-file': 'dropFile',
      'drop-paths': 'dropPaths',
      fill: 'fill',
      'get-attribute': 'getAttribute',
      hover: 'hover',
      metrics: 'getElementMetrics',
      navigate: 'navigate',
      'paste-paths': 'pastePaths',
      'pointer-move': 'pointerMove',
      press: 'press',
      submit: 'submit',
      'scroll-into-view': 'scrollIntoView',
      'select-text': 'selectText',
      'show-popout': 'showPopoutWindow',
      'system-drag-drop': 'completeSystemDragDrop',
      'verify-browser-inspector': 'verifyEmbeddedBrowserDetachedInspector',
      'wait-for': 'waitFor',
      'window-focus-snapshot': 'getWindowFocusSnapshot',
      text: 'getText',
    })
  })
})

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

describe('parseArgs', () => {
  test('preserves explicit empty values', () => {
    expect(parseArgs(['set-local-proxy-url', '--value', ''])).toEqual({
      command: 'set-local-proxy-url',
      options: { value: '' },
    })
  })

  test('still rejects a missing value', () => {
    expect(() => parseArgs(['set-local-proxy-url', '--value'])).toThrow('Missing value for --value')
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
      'the desktop launcher had not started'
    )
    expect(startupFailureMessage({ pid: 42 }, 120000)).toContain(
      'the desktop launcher was still waiting for its renderer'
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

describe('resolveOptionalBoolean', () => {
  test('preserves an omitted option', () => {
    expect(resolveOptionalBoolean(undefined, 'visible')).toBeUndefined()
  })

  test('parses explicit boolean values', () => {
    expect(resolveOptionalBoolean('true', 'visible')).toBe(true)
    expect(resolveOptionalBoolean('false', 'visible')).toBe(false)
  })

  test('rejects ambiguous values', () => {
    expect(() => resolveOptionalBoolean('yes', 'visible')).toThrow(
      '--visible must be "true" or "false"'
    )
  })
})

describe('validateStartOptions', () => {
  test('accepts the Electron start options', () => {
    expect(() =>
      validateStartOptions({
        'codex-home-initialization': 'true',
        timeout: '180000',
      })
    ).not.toThrow()
  })

  test('rejects the removed desktop runtime option', () => {
    expect(() => validateStartOptions({ runtime: 'electron' })).toThrow(
      'Unexpected option for start: --runtime'
    )
  })
})
