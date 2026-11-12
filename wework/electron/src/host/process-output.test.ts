import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { mainProcessLog } from './main-process-log.js'

import { installProcessOutputErrorHandlers } from './process-output.js'

afterEach(() => vi.restoreAllMocks())

describe('installProcessOutputErrorHandlers', () => {
  test('ignores broken stdout and stderr pipes', () => {
    const stdout = new EventEmitter()
    const stderr = new EventEmitter()
    installProcessOutputErrorHandlers(stdout, stderr)
    const brokenPipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })

    expect(() => stdout.emit('error', brokenPipe)).not.toThrow()
    expect(() => stderr.emit('error', brokenPipe)).not.toThrow()
  })

  test('records unexpected stream errors without terminating the application or reusing the stream', () => {
    const record = vi.spyOn(mainProcessLog, 'write').mockResolvedValue(undefined)
    const stdout = new EventEmitter()
    const stderr = new EventEmitter()
    installProcessOutputErrorHandlers(stdout, stderr)
    const failure = Object.assign(new Error('stream failed'), { code: 'EIO' })

    expect(() => stdout.emit('error', failure)).not.toThrow()
    expect(() => stderr.emit('error', failure)).not.toThrow()
    expect(record.mock.calls).toEqual([
      ['stderr', '[process-output] stdout unavailable (EIO)'],
      ['stderr', '[process-output] stderr unavailable (EIO)'],
    ])
  })
})
