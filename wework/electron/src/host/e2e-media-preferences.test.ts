import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { acquireDebuggerSession } from './debugger-session.js'
import { setReducedMotion } from './e2e-media-preferences.js'

function target(attached = false) {
  const events = new EventEmitter()
  const debuggerSession = {
    isAttached: () => attached,
    attach: vi.fn<(protocolVersion?: string) => void>(() => {
      attached = true
    }),
    detach: vi.fn(() => {
      attached = false
      events.emit('detach', {}, 'target closed')
    }),
    sendCommand: vi.fn<(method: string, params?: Record<string, unknown>) => Promise<unknown>>(
      async () => ({})
    ),
    on: events.on.bind(events),
    off: events.off.bind(events),
  }
  return {
    isDestroyed: vi.fn(() => false),
    debugger: debuggerSession,
    detachExternally: () => {
      attached = false
      events.emit('detach', {}, 'target closed')
    },
  }
}

function deferred() {
  let resolve!: (value: object) => void
  let reject!: (error: Error) => void
  const promise = new Promise<object>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('desktop reduced-motion verification', () => {
  it('keeps the media session attached until the system preference is restored', async () => {
    const view = target()
    await setReducedMotion(view, 'no-preference')
    expect(view.debugger.isAttached()).toBe(true)
    await setReducedMotion(view, 'reduce')
    expect(view.debugger.sendCommand).toHaveBeenLastCalledWith('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    })
    await setReducedMotion(view, 'system')
    expect(view.debugger.sendCommand).toHaveBeenLastCalledWith('Emulation.setEmulatedMedia', {
      features: [],
    })
    expect(view.debugger.isAttached()).toBe(false)
  })

  it('preserves a debugger session owned by another inspector', async () => {
    const view = target(true)
    await setReducedMotion(view, 'no-preference')
    await setReducedMotion(view, 'system')
    expect(view.debugger.detach).not.toHaveBeenCalled()
  })

  it('cleans up its debugger session after a failed media override', async () => {
    const view = target()
    view.debugger.sendCommand.mockRejectedValueOnce(new Error('Target closed'))
    await expect(setReducedMotion(view, 'reduce')).rejects.toThrow('Target closed')
    expect(view.debugger.isAttached()).toBe(false)
  })

  it('rejects unsupported media values before attaching a debugger', async () => {
    const view = target()
    await expect(setReducedMotion(view, 'invalid')).rejects.toThrow('Invalid reduced-motion')
    expect(view.debugger.attach).not.toHaveBeenCalled()
  })

  it('does not attach to restore system defaults when no session exists', async () => {
    const view = target()
    await setReducedMotion(view, 'system')
    expect(view.debugger.attach).not.toHaveBeenCalled()
    expect(view.debugger.sendCommand).not.toHaveBeenCalled()
  })

  it('rejects an unavailable target before acquiring a session', async () => {
    const view = target()
    view.isDestroyed.mockReturnValue(true)
    await expect(setReducedMotion(view, 'reduce')).rejects.toThrow('target is unavailable')
    expect(view.debugger.attach).not.toHaveBeenCalled()
  })

  it('clears defaults without releasing another active debugger consumer', async () => {
    const view = target()
    const other = acquireDebuggerSession(view)
    await setReducedMotion(view, 'reduce')
    await setReducedMotion(view, 'system')
    expect(view.debugger.attach).toHaveBeenCalledOnce()
    expect(view.debugger.detach).not.toHaveBeenCalled()
    expect(other.isActive()).toBe(true)
    other.release()
    expect(view.debugger.detach).toHaveBeenCalledOnce()
  })

  it('releases only its own lease after a failed media override', async () => {
    const view = target()
    const other = acquireDebuggerSession(view)
    view.debugger.sendCommand.mockRejectedValueOnce(new Error('media failed'))
    await expect(setReducedMotion(view, 'reduce')).rejects.toThrow('media failed')
    expect(view.debugger.detach).not.toHaveBeenCalled()
    other.release()
    expect(view.debugger.detach).toHaveBeenCalledOnce()
  })

  it('shares a retained lease across wrappers of the same debugger', async () => {
    const view = target()
    await setReducedMotion(view, 'reduce')
    await setReducedMotion({ ...view }, 'system')
    expect(view.debugger.attach).toHaveBeenCalledOnce()
    expect(view.debugger.detach).toHaveBeenCalledOnce()
  })

  it('serializes updates until the previous media command completes', async () => {
    const view = target()
    const pending = deferred()
    const started = deferred()
    view.debugger.sendCommand.mockImplementationOnce(() => {
      started.resolve({})
      return pending.promise
    })
    const reduce = setReducedMotion(view, 'reduce')
    const restore = setReducedMotion(view, 'system')
    await started.promise
    expect(view.debugger.sendCommand).toHaveBeenCalledTimes(1)
    expect(view.debugger.detach).not.toHaveBeenCalled()
    pending.resolve({})
    await Promise.all([reduce, restore])
    expect(view.debugger.sendCommand.mock.calls.map(call => call[1])).toEqual([
      { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] },
      { features: [] },
    ])
    expect(view.debugger.detach).toHaveBeenCalledOnce()
  })

  it('runs queued updates after a failure without reusing the released lease', async () => {
    const view = target()
    const pending = deferred()
    const started = deferred()
    view.debugger.sendCommand.mockImplementationOnce(() => {
      started.resolve({})
      return pending.promise
    })
    const failed = expect(setReducedMotion(view, 'reduce')).rejects.toThrow('media failed')
    const next = setReducedMotion(view, 'no-preference')
    await started.promise
    pending.reject(new Error('media failed'))
    await failed
    await next
    expect(view.debugger.attach).toHaveBeenCalledTimes(2)
    expect(view.debugger.sendCommand).toHaveBeenLastCalledWith('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
    })
    await setReducedMotion(view, 'system')
    expect(view.debugger.detach).toHaveBeenCalledTimes(2)
  })

  it('releases its lease when restoring system defaults fails', async () => {
    const view = target()
    await setReducedMotion(view, 'reduce')
    view.debugger.sendCommand.mockRejectedValueOnce(new Error('clear failed'))
    await expect(setReducedMotion(view, 'system')).rejects.toThrow('clear failed')
    expect(view.debugger.isAttached()).toBe(false)
    await setReducedMotion(view, 'system')
    expect(view.debugger.attach).toHaveBeenCalledOnce()
  })

  it('does not detach a new external session after its retained generation ends', async () => {
    const view = target()
    await setReducedMotion(view, 'reduce')
    view.detachExternally()
    view.debugger.attach('1.3')
    await setReducedMotion(view, 'system')
    expect(view.debugger.sendCommand).toHaveBeenLastCalledWith('Emulation.setEmulatedMedia', {
      features: [],
    })
    expect(view.debugger.isAttached()).toBe(true)
    expect(view.debugger.detach).not.toHaveBeenCalled()
  })

  it('acquires a new retained session after an external detach', async () => {
    const view = target()
    await setReducedMotion(view, 'reduce')
    view.detachExternally()
    await setReducedMotion(view, 'no-preference')
    expect(view.debugger.attach).toHaveBeenCalledTimes(2)
    await setReducedMotion(view, 'system')
    expect(view.debugger.detach).toHaveBeenCalledOnce()
  })
})
