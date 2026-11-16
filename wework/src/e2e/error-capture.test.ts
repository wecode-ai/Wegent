import { afterEach, expect, test, vi } from 'vitest'
import { installE2EErrorCapture, reportE2EError } from './error-capture'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

test('captures handled exceptions, window errors and unhandled rejections independently of telemetry', () => {
  vi.stubEnv('VITE_WEWORK_E2E', 'true')
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const target = new EventTarget()
  const stop = installE2EErrorCapture(target as unknown as Window)
  const error = new Error('injected renderer failure')
  target.dispatchEvent(new ErrorEvent('error', { error }))
  const rejection = new Event('unhandledrejection')
  Object.defineProperty(rejection, 'reason', { value: error })
  target.dispatchEvent(rejection)
  reportE2EError('captured-exception', error)
  const reports = log.mock.calls.map(([, json]) => JSON.parse(json))
  expect(reports.map(report => report.type)).toEqual([
    'uncaught-exception',
    'unhandled-rejection',
    'captured-exception',
  ])
  expect(reports.every(report => report.stack.includes('injected renderer failure'))).toBe(true)
  stop()
  target.dispatchEvent(new ErrorEvent('error', { error }))
  expect(log).toHaveBeenCalledTimes(3)
})

test('ordinary product sessions do not emit E2E errors', () => {
  vi.stubEnv('VITE_WEWORK_E2E', 'false')
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  reportE2EError('captured-exception', new Error('ordinary error'))
  expect(log).not.toHaveBeenCalled()
})
