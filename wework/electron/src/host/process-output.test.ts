import { EventEmitter } from 'node:events'
import { describe, expect, test } from 'vitest'

import { installProcessOutputErrorHandlers } from './process-output.js'

describe('installProcessOutputErrorHandlers', () => {
  test('ignores broken stdout and stderr pipes', () => {
    const stdout = new EventEmitter()
    const stderr = new EventEmitter()
    installProcessOutputErrorHandlers(stdout, stderr)
    const brokenPipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })

    expect(() => stdout.emit('error', brokenPipe)).not.toThrow()
    expect(() => stderr.emit('error', brokenPipe)).not.toThrow()
  })

  test('preserves unexpected output stream errors', () => {
    const stdout = new EventEmitter()
    const stderr = new EventEmitter()
    installProcessOutputErrorHandlers(stdout, stderr)
    const failure = Object.assign(new Error('stream failed'), { code: 'EIO' })

    expect(() => stdout.emit('error', failure)).toThrow(failure)
    expect(() => stderr.emit('error', failure)).toThrow(failure)
  })
})
