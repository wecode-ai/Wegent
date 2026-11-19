import { afterEach, expect, test, vi } from 'vitest'
import { installE2EErrorCapture, reportE2EError } from './error-capture'
import {
  acquireConversationDiagnosticCapture,
  recordConversationDiagnostic,
  resetConversationDiagnosticsForTest,
} from '@wegent/collaboration/conversation/conversationDiagnostics'

afterEach(() => {
  resetConversationDiagnosticsForTest()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

test('resize failures retain the bounded sanitized conversation evidence from long operations', () => {
  vi.stubEnv('VITE_WEWORK_E2E', 'true')
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const release = acquireConversationDiagnosticCapture()
  const target = new EventTarget()
  const stop = installE2EErrorCapture(target as unknown as Window)
  vi.spyOn(performance, 'now').mockReturnValue(60_000)
  recordConversationDiagnostic('scroll-write', {
    writeSource: 1,
    scrollTop: 123,
    content: 'private transcript',
  })
  target.dispatchEvent(new ErrorEvent('error', { message: 'ResizeObserver loop completed' }))
  const report = JSON.parse(String(log.mock.calls[0][1]))
  expect(report.type).toBe('uncaught-exception')
  expect(report.diagnostics.conversation.events).toHaveLength(1)
  expect(report.diagnostics.conversation.events[0].details).toEqual({
    writeSource: 1,
    scrollTop: 123,
  })
  expect(JSON.stringify(report)).not.toContain('private transcript')
  stop()
  release()
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
