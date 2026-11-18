import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  mobileSocketLogger,
  beginMobileDiagnostic,
  recordMobileDiagnostic,
  recordMobileDiagnosticFailure,
  setDiagnosticRecording,
} from './mobileDiagnostics'

afterEach(() => {
  setDiagnosticRecording(false)
  vi.restoreAllMocks()
})

describe('startup lifecycle timeline', () => {
  it('pairs stages and one terminal outcome with elapsed time and no exception body', () => {
    const output = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
    setDiagnosticRecording(true)
    const diagnostic = beginMobileDiagnostic('phone-start', 'phone')
    diagnostic.step('start-native-runtime')
    clock.mockReturnValue(1250)
    diagnostic.fail(new Error('Authorization: private-token'))
    diagnostic.complete()
    diagnostic.cancel()
    const records = output.mock.calls.map(call => call[1])
    expect(records).toHaveLength(3)
    expect(records[0]).toMatchObject({ operation: 'phone-start', target: 'phone', phase: 'start' })
    expect(records[1]).toMatchObject({ stage: 'start-native-runtime', phase: 'progress' })
    expect(records[2]).toMatchObject({ phase: 'failed', elapsedMs: 250, errorType: 'Error' })
    expect(new Set(records.map(record => record.span)).size).toBe(1)
    expect(JSON.stringify(records)).not.toMatch(/Authorization|private-token/)
  })

  it('records completion counters without finishing a still-pending operation', () => {
    const output = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    setDiagnosticRecording(true)
    const pending = beginMobileDiagnostic('work-list', 'phone')
    pending.step('request-task-list')
    expect(output.mock.calls.map(call => call[1].phase)).toEqual(['start', 'progress'])
    pending.complete({ totalTasks: 3 })
    expect(output.mock.lastCall?.[1]).toMatchObject({ phase: 'complete', totalTasks: 3 })
  })

  it('flushes bounded early lifecycle metadata only after the saved preference opts in', async () => {
    vi.resetModules()
    const fresh = await import('./mobileDiagnostics')
    const output = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    for (let index = 0; index < 150; index++) fresh.beginMobileDiagnostic('app-mount')
    expect(output).not.toHaveBeenCalled()
    fresh.setDiagnosticRecording(true)
    expect(output).toHaveBeenCalledTimes(128)
    fresh.setDiagnosticRecording(false)
  })

  it('discards early lifecycle records when the saved preference is disabled', async () => {
    vi.resetModules()
    const fresh = await import('./mobileDiagnostics')
    const output = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    fresh.beginMobileDiagnostic('app-mount').complete()
    fresh.setDiagnosticRecording(false)
    fresh.beginMobileDiagnostic('work-list', 'phone').complete({ totalTasks: 3 })
    fresh.setDiagnosticRecording(true)
    expect(output).not.toHaveBeenCalled()
    fresh.setDiagnosticRecording(false)
  })
})

describe('opt-in diagnostic generation', () => {
  it('does not evaluate diagnostic details or write output while disabled', () => {
    const output = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const details = vi.fn(() => ({ count: 10 }))
    recordMobileDiagnostic('read', details)
    mobileSocketLogger.error()
    expect(details).not.toHaveBeenCalled()
    expect(output).not.toHaveBeenCalled()
    setDiagnosticRecording(true)
    recordMobileDiagnostic('read', details)
    expect(output).toHaveBeenCalledExactlyOnceWith('read', { count: 10 })
    setDiagnosticRecording(false)
    recordMobileDiagnostic('read', details)
    expect(details).toHaveBeenCalledOnce()
  })

  it('discards raw transport error fields and exception messages', () => {
    const output = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    setDiagnosticRecording(true)
    const logger: Pick<Console, 'info' | 'error'> = mobileSocketLogger
    logger.error('Authorization: secret-token', new Error('url?token=private-secret'))
    recordMobileDiagnosticFailure('Cache write failed', new Error('private-body'))
    expect(JSON.stringify(output.mock.calls)).not.toMatch(/secret|private-body|Authorization/)
    expect(output).toHaveBeenCalledTimes(2)
  })
})
