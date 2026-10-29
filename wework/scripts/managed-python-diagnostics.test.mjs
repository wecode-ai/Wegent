import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  assertManagedPythonStartup,
  collectManagedPythonStatus,
  managedPythonPath,
  PYTHON_BOOTSTRAP_TIMEOUT_MS,
  waitForPythonRuntimeEvent,
} from '../e2e/desktop/modules/managed-python.mjs'

const temporaryDirectories = []
const STATUS_SELECTOR = '[data-testid="execution-environment-python-status"]'
const SENSITIVE_DETAIL =
  'https://fixture-user:fixture-password@example.invalid/python?token=fixture-token'

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))
  )
})

async function temporaryLog(contents = '') {
  const directory = await mkdtemp(join(tmpdir(), 'wework-python-log-diagnostics-'))
  temporaryDirectories.push(directory)
  const path = join(directory, 'app.log')
  await writeFile(path, contents)
  return path
}

describe('managed Python installation event waits', () => {
  test.each(['python-runtime-install-failed', 'python-runtime-background-ensure-failed'])(
    'immediately reports %s without copying its error details',
    async event => {
      const logPath = await temporaryLog(
        JSON.stringify({ event, error: 'sensitive-error-detail-must-stay-in-app-log' })
      )

      const failure = await waitForPythonRuntimeEvent(
        logPath,
        'python-runtime-install-completed'
      ).catch(error => error)

      expect(failure).toBeInstanceOf(Error)
      expect(failure.message).toBe(`The real Python installation reported ${event}; see ${logPath}`)
      expect(failure.message).not.toContain('sensitive-error-detail')
    },
    1_500
  )

  test('retains an expected failed-publication event as a successful observation', async () => {
    const contents = JSON.stringify({ event: 'python-runtime-install-failed' })
    const logPath = await temporaryLog(contents)

    await expect(waitForPythonRuntimeEvent(logPath, 'python-runtime-install-failed')).resolves.toBe(
      contents
    )
  })

  test('excludes an earlier failure when the retry supplies a new log offset', async () => {
    const previous = `${JSON.stringify({ event: 'python-runtime-install-failed' })}\n`
    const current = JSON.stringify({ event: 'python-runtime-install-completed' })
    const logPath = await temporaryLog(previous)
    await appendFile(logPath, current)

    await expect(
      waitForPythonRuntimeEvent(logPath, 'python-runtime-install-completed', previous.length)
    ).resolves.toBe(current)
  })

  test('does not conceal a failure from the current attempt behind a completion event', async () => {
    const logPath = await temporaryLog(
      [
        { event: 'python-runtime-background-ensure-failed' },
        { event: 'python-runtime-install-completed' },
      ]
        .map(event => JSON.stringify(event))
        .join('\n')
    )

    await expect(
      waitForPythonRuntimeEvent(logPath, 'python-runtime-install-completed')
    ).rejects.toThrow('reported python-runtime-background-ensure-failed')
  })
})

describe('managed Python startup diagnostics', () => {
  test('reads only the safe status leaf without copying the root-card error or requesting installation', async () => {
    const statusText = '正在后台下载 · Wework 管理'
    const commandForWindow = vi.fn(async (_window, action, selector) => {
      if (action !== 'getText') return undefined
      return selector === STATUS_SELECTOR ? statusText : `Python ${statusText} ${SENSITIVE_DETAIL}`
    })

    const diagnostic = await collectManagedPythonStatus({ commandForWindow })

    expect(diagnostic).toEqual({
      capturedAt: expect.any(String),
      windowLabel: 'main',
      statusText,
    })
    expect(JSON.stringify(diagnostic)).not.toContain(SENSITIVE_DETAIL)
    expect(commandForWindow.mock.calls).toEqual([
      ['main', 'navigate', 'body', { value: '/settings/execution-environments' }],
      ['main', 'waitFor', STATUS_SELECTOR],
      ['main', 'getText', STATUS_SELECTOR],
    ])
  })

  test('records diagnostic capture failure without copying credential-bearing exceptions', async () => {
    const commandForWindow = vi.fn().mockRejectedValue(new Error(SENSITIVE_DETAIL))

    const diagnostic = await collectManagedPythonStatus({ commandForWindow })

    expect(diagnostic).toMatchObject({
      windowLabel: 'main',
      captureError: true,
    })
    expect(JSON.stringify(diagnostic)).not.toContain(SENSITIVE_DETAIL)
    expect(commandForWindow).toHaveBeenCalledOnce()
  })
})

describe('development-instance Python startup readiness', () => {
  async function fixture(contents, status, diagnosticStatus = '已安装 · Wework 管理 · 3.12.12') {
    const logPath = await temporaryLog(contents)
    const userDataDirectory = join(dirname(logPath), 'child-user-data')
    const diagnosticPath = join(dirname(logPath), 'startup-failure.json')
    const commandForWindow = vi.fn(async (_window, action, selector) => {
      if (action !== 'getText') return undefined
      if (selector === STATUS_SELECTOR) return diagnosticStatus
      return (
        status ?? `Python 已安装 · Wework 管理 · 3.12.12 ${managedPythonPath(userDataDirectory)}`
      )
    })
    return {
      control: { commandForWindow },
      options: {
        userDataDirectory,
        windowLabel: 'plugin-development-child',
        logPath,
        diagnosticPath,
      },
      commandForWindow,
    }
  }

  test.each(['python-runtime-install-failed', 'python-runtime-background-ensure-failed'])(
    'fails immediately on the child stdout %s event and records only read-only status',
    async event => {
      const { control, options, commandForWindow } = await fixture(
        `2026-10-28T15:31:32.360Z [stdout] [python-runtime] {\n  event: '${event}',\n  error: 'sensitive-network-detail'\n}\n`,
        `Python 安装失败 · Wework 管理 ${SENSITIVE_DETAIL}`,
        '安装失败 · Wework 管理'
      )
      await expect(assertManagedPythonStartup(control, options)).rejects.toThrow(
        `The real Python installation reported ${event}; see ${options.logPath}`
      )
      const diagnostic = JSON.parse(await readFile(options.diagnosticPath, 'utf8'))
      expect(diagnostic).toEqual({
        capturedAt: expect.any(String),
        windowLabel: options.windowLabel,
        statusText: '安装失败 · Wework 管理',
      })
      expect(JSON.stringify(diagnostic)).not.toContain('sensitive-network-detail')
      expect(JSON.stringify(diagnostic)).not.toContain(SENSITIVE_DETAIL)
      expect(commandForWindow.mock.calls).toEqual([
        [options.windowLabel, 'navigate', 'body', { value: '/settings/execution-environments' }],
        [options.windowLabel, 'waitFor', STATUS_SELECTOR],
        [options.windowLabel, 'getText', STATUS_SELECTOR],
      ])
    },
    1_500
  )

  test('a real appended completion retains settings and child-path checks within one deadline', async () => {
    let now = 0
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const { control, options, commandForWindow } = await fixture('')
    commandForWindow.mockImplementation(async (_window, action) => {
      if (action === 'navigate') now = 30_000
      if (action === 'getText') return `Python ${managedPythonPath(options.userDataDirectory)}`
    })
    const completion = expect(assertManagedPythonStartup(control, options)).resolves.toBeUndefined()
    now = 25_000
    await appendFile(
      options.logPath,
      "2026-10-28T15:31:32.360Z [stdout] [python-runtime] { event: 'python-runtime-install-completed' }\n"
    )
    await completion
    expect(commandForWindow.mock.calls).toEqual([
      [options.windowLabel, 'navigate', 'body', { value: '/settings/execution-environments' }],
      [
        options.windowLabel,
        'waitFor',
        '[data-testid="execution-environment-python"]',
        {
          text: '已安装 · Wework 管理 · 3.12.12',
          timeoutMs: PYTHON_BOOTSTRAP_TIMEOUT_MS - 30_000,
        },
      ],
      [options.windowLabel, 'getText', '[data-testid="execution-environment-python"]'],
    ])
    await expect(readFile(options.diagnosticPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('an exhausted shared deadline fails before starting another settings wait', async () => {
    let now = 0
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const { control, options, commandForWindow } = await fixture(
      "[stdout] [python-runtime] { event: 'python-runtime-install-completed' }"
    )
    commandForWindow.mockImplementation(async (_window, action) => {
      if (action === 'navigate') now = PYTHON_BOOTSTRAP_TIMEOUT_MS
      if (action === 'getText') return 'Python 安装状态已采集'
    })
    await expect(assertManagedPythonStartup(control, options)).rejects.toThrow(
      'The managed Python readiness deadline expired before checking settings'
    )
    expect(
      commandForWindow.mock.calls.some(
        ([, action, , options]) => action === 'waitFor' && options?.text
      )
    ).toBe(false)
    expect(JSON.parse(await readFile(options.diagnosticPath, 'utf8'))).toMatchObject({
      windowLabel: options.windowLabel,
      statusText: 'Python 安装状态已采集',
    })
  })

  test('a completion event cannot conceal settings that advertise a different instance Python', async () => {
    const { control, options } = await fixture(
      "[stdout] [python-runtime] { event: 'python-runtime-install-completed' }",
      'Python 已安装 · Wework 管理 · 3.12.12 /another-instance/python3'
    )
    await expect(assertManagedPythonStartup(control, options)).rejects.toThrow(
      'The runtime UI advertised another instance Python'
    )
  })

  test('preserves the original startup error when diagnostic navigation also fails', async () => {
    const { control, options, commandForWindow } = await fixture(
      "[stdout] [python-runtime] { event: 'python-runtime-install-completed' }"
    )
    const original = new Error('Original settings navigation failed')
    commandForWindow
      .mockRejectedValueOnce(original)
      .mockRejectedValueOnce(new Error(SENSITIVE_DETAIL))

    await expect(assertManagedPythonStartup(control, options)).rejects.toBe(original)
    const diagnostic = JSON.parse(await readFile(options.diagnosticPath, 'utf8'))
    expect(diagnostic).toEqual({
      capturedAt: expect.any(String),
      windowLabel: options.windowLabel,
      captureError: true,
    })
    expect(JSON.stringify(diagnostic)).not.toContain(SENSITIVE_DETAIL)
  })
})
