import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  collectManagedPythonStatus,
  waitForPythonRuntimeEvent,
} from '../e2e/desktop/modules/managed-python.mjs'

const temporaryDirectories = []

afterEach(async () => {
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
  test('reads the real settings status and progress without requesting installation', async () => {
    const statusText = 'Python 正在后台下载 · Wework 管理 3 B / 18.3 MB'
    const commandForWindow = vi.fn(async (_window, action) =>
      action === 'getText' ? statusText : undefined
    )

    const diagnostic = await collectManagedPythonStatus({ commandForWindow })

    expect(diagnostic).toEqual({
      capturedAt: expect.any(String),
      windowLabel: 'main',
      statusText,
    })
    expect(commandForWindow.mock.calls).toEqual([
      ['main', 'navigate', 'body', { value: '/settings/execution-environments' }],
      ['main', 'waitFor', '[data-testid="execution-environment-python"]'],
      ['main', 'getText', '[data-testid="execution-environment-python"]'],
    ])
  })

  test('retains a diagnostic collection error when the settings page is unavailable', async () => {
    const commandForWindow = vi.fn().mockRejectedValue(new Error('Desktop control disconnected'))

    const diagnostic = await collectManagedPythonStatus({ commandForWindow })

    expect(diagnostic).toMatchObject({
      windowLabel: 'main',
      captureError: 'Desktop control disconnected',
    })
    expect(commandForWindow).toHaveBeenCalledOnce()
  })
})
