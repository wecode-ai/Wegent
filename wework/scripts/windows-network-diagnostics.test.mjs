import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { observeWindowsSocketExhaustion } from '../e2e/desktop/modules/windows-network-diagnostics.mjs'

describe('Windows socket exhaustion evidence', () => {
  it('captures immediately across split chunks and only once across both streams', () => {
    const stdout = new EventEmitter()
    const stderr = new EventEmitter()
    const capture = vi.fn()
    const stop = observeWindowsSocketExhaustion([stdout, stderr], capture)
    stdout.emit('data', Buffer.from('ordinary startup output'))
    expect(capture).not.toHaveBeenCalled()
    stderr.emit('data', Buffer.from('net::ERR_NO_BUF'))
    expect(capture).not.toHaveBeenCalled()
    stderr.emit('data', Buffer.from('FER_SPACE'))
    expect(capture).toHaveBeenCalledTimes(1)
    stdout.emit('data', Buffer.from('startup failed net::ERR_NO_BUFFER_SPACE'))
    expect(capture).toHaveBeenCalledTimes(1)
    stop()
    expect(stdout.listenerCount('data')).toBe(0)
    expect(stderr.listenerCount('data')).toBe(0)
  })

  it('removes observers on process exit without capturing later output', () => {
    const stdout = new EventEmitter()
    const capture = vi.fn()
    const stop = observeWindowsSocketExhaustion([stdout, null], capture)
    stop()
    stdout.emit('data', Buffer.from('net::ERR_NO_BUFFER_SPACE'))
    expect(capture).not.toHaveBeenCalled()
  })
})
