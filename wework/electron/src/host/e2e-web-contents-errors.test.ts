import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { afterEach, expect, test, vi } from 'vitest'
import { e2eErrorLog } from './e2e-error-log.js'
import { installE2EWebContentsErrors } from './e2e-web-contents-errors.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

test('each window reports console errors, load failures and crashes with its identity', () => {
  vi.stubEnv('VITE_WEWORK_E2E', 'true')
  const record = vi.spyOn(e2eErrorLog, 'record').mockImplementation(() => undefined)
  const contents = Object.assign(new EventEmitter(), { id: 8 })
  installE2EWebContentsErrors(contents as unknown as WebContents)
  contents.emit(
    'console-message',
    {},
    3,
    'injected console failure',
    22,
    'https://app.test/main.js?token=secret'
  )
  contents.emit('did-fail-load', {}, -2, 'injected load failure', 'https://app.test', true)
  contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
  contents.emit('console-message', {}, 1, 'ordinary output', 1, '')
  expect(record.mock.calls.map(call => call[1])).toEqual([
    'created',
    'renderer-error',
    'load-failed',
    'process-gone',
  ])
  expect(record.mock.calls.every(call => call[3].webContentsId === 8)).toBe(true)
  expect(JSON.stringify(record.mock.calls)).not.toContain('token=secret')
})

test('normal renderer exits are recorded without becoming unexpected errors', () => {
  vi.stubEnv('VITE_WEWORK_E2E', 'true')
  const record = vi.spyOn(e2eErrorLog, 'record').mockImplementation(() => undefined)
  const contents = Object.assign(new EventEmitter(), { id: 9 })
  installE2EWebContentsErrors(contents as unknown as WebContents)
  contents.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 })
  expect(record).toHaveBeenLastCalledWith('renderer', 'process-gone', 'info', {
    webContentsId: 9,
    reason: 'clean-exit',
    exitCode: 0,
  })
})

test('explicit renderer diagnostics survive at info level and malformed diagnostics fail collection', () => {
  vi.stubEnv('VITE_WEWORK_E2E', 'true')
  const record = vi.spyOn(e2eErrorLog, 'record').mockImplementation(() => undefined)
  const contents = Object.assign(new EventEmitter(), { id: 10 })
  installE2EWebContentsErrors(contents as unknown as WebContents)
  const diagnostic = {
    type: 'conversation-scope',
    details: { taskId: 'task-1', changedFields: ['runtime'] },
  }
  contents.emit(
    'console-message',
    {},
    1,
    '[wework-e2e-diagnostic] ' + JSON.stringify(diagnostic),
    1,
    ''
  )
  expect(record).toHaveBeenLastCalledWith('renderer', 'diagnostic', 'info', {
    webContentsId: 10,
    diagnostic,
  })
  expect(() =>
    contents.emit('console-message', {}, 1, '[wework-e2e-diagnostic] {', 1, '')
  ).not.toThrow()
  expect(record).toHaveBeenLastCalledWith('renderer', 'diagnostic-protocol-failed', 'error', {
    webContentsId: 10,
  })
  contents.emit('console-message', {}, 2, '[wework-e2e-diagnostic] warning', 1, '')
  expect(record).toHaveBeenLastCalledWith(
    'renderer',
    'renderer-warning',
    'warning',
    expect.objectContaining({ webContentsId: 10 })
  )
  contents.emit('console-message', {}, 3, '[wework-e2e-diagnostic] error', 1, '')
  expect(record).toHaveBeenLastCalledWith(
    'renderer',
    'renderer-error',
    'error',
    expect.objectContaining({ webContentsId: 10 })
  )
})
