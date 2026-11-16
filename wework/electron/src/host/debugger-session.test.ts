import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { acquireDebuggerSession, withDebuggerSession } from './debugger-session.js'
import { captureWebContentsDataUrl } from './web-contents-capture.js'

function target(attached = false) {
  const session = Object.assign(new EventEmitter(), {
    isAttached: () => attached,
    attach: vi.fn(() => {
      attached = true
    }),
    detach: vi.fn(() => {
      attached = false
      session.emit('detach', {}, 'target_closed')
    }),
    sendCommand: vi.fn(async () => ({})),
  })
  return { debugger: session }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

describe('shared debugger sessions', () => {
  it('shares one attachment until every consumer releases it', () => {
    const view = target()
    const capture = acquireDebuggerSession(view)
    const wheel = acquireDebuggerSession({ debugger: view.debugger })
    expect(view.debugger.attach).toHaveBeenCalledExactlyOnceWith('1.3')
    capture.release()
    expect(capture.isActive()).toBe(false)
    expect(wheel.isActive()).toBe(true)
    expect(view.debugger.detach).not.toHaveBeenCalled()
    wheel.release()
    expect(view.debugger.detach).toHaveBeenCalledOnce()
    expect(view.debugger.listenerCount('detach')).toBe(0)
  })

  it('does not detach an external inspector after borrowing its session', async () => {
    const view = target(true)
    await withDebuggerSession(view, async session => session.sendCommand('Runtime.getHeapUsage'))
    expect(view.debugger.attach).not.toHaveBeenCalled()
    expect(view.debugger.detach).not.toHaveBeenCalled()
    expect(view.debugger.listenerCount('detach')).toBe(0)
  })

  it('keeps a pending wheel operation attached when a concurrent screenshot completes', async () => {
    const view = target()
    const screenshot = deferred<string>()
    const wheel = deferred<string>()
    const captureResult = withDebuggerSession(view, () => screenshot.promise)
    const wheelResult = withDebuggerSession(view, () => wheel.promise)
    screenshot.resolve('image')
    await expect(captureResult).resolves.toBe('image')
    expect(view.debugger.detach).not.toHaveBeenCalled()
    wheel.resolve('ack')
    await expect(wheelResult).resolves.toBe('ack')
    expect(view.debugger.detach).toHaveBeenCalledOnce()
  })

  it('keeps an input lease attached after a real screenshot consumer finishes', async () => {
    const view = {
      ...target(),
      capturePage: vi.fn(),
    }
    const screenshot = deferred<{ data: string }>()
    view.debugger.sendCommand.mockImplementationOnce(() => screenshot.promise)
    const capture = captureWebContentsDataUrl(view, { preferDebugger: true })
    const input = acquireDebuggerSession(view)
    screenshot.resolve({ data: 'cG5n' })
    await expect(capture).resolves.toBe('data:image/png;base64,cG5n')
    expect(view.debugger.detach).not.toHaveBeenCalled()
    expect(input.isActive()).toBe(true)
    input.release()
    expect(view.debugger.detach).toHaveBeenCalledOnce()
  })

  it('keeps a real screenshot consumer attached after input completes first', async () => {
    const view = {
      ...target(),
      capturePage: vi.fn(),
    }
    const input = acquireDebuggerSession(view)
    const screenshot = deferred<{ data: string }>()
    view.debugger.sendCommand.mockImplementationOnce(() => screenshot.promise)
    const capture = captureWebContentsDataUrl(view, { preferDebugger: true })
    input.release()
    expect(view.debugger.detach).not.toHaveBeenCalled()
    screenshot.resolve({ data: 'cG5n' })
    await expect(capture).resolves.toBe('data:image/png;base64,cG5n')
    expect(view.debugger.detach).toHaveBeenCalledOnce()
  })

  it('does not release another consumer after a command rejects', async () => {
    const view = target()
    const media = acquireDebuggerSession(view)
    const failure = new Error('Wheel rejected')
    await expect(
      withDebuggerSession(view, async () => {
        throw failure
      })
    ).rejects.toBe(failure)
    expect(media.isActive()).toBe(true)
    expect(view.debugger.detach).not.toHaveBeenCalled()
    media.release()
    expect(view.debugger.detach).toHaveBeenCalledOnce()
  })

  it('releases an owned session when the operation throws synchronously', async () => {
    const view = target()
    const failure = new Error('Invalid command')
    await expect(
      withDebuggerSession(view, () => {
        throw failure
      })
    ).rejects.toBe(failure)
    expect(view.debugger.detach).toHaveBeenCalledOnce()
  })

  it('releases each lease at most once', () => {
    const view = target()
    const first = acquireDebuggerSession(view)
    const second = acquireDebuggerSession(view)
    first.release()
    first.release()
    expect(second.isActive()).toBe(true)
    expect(view.debugger.detach).not.toHaveBeenCalled()
    second.release()
    second.release()
    expect(view.debugger.detach).toHaveBeenCalledOnce()
  })

  it('invalidates old leases when Electron detaches and preserves a replacement inspector', () => {
    const view = target()
    const old = acquireDebuggerSession(view)
    view.debugger.detach()
    expect(old.isActive()).toBe(false)
    view.debugger.attach()
    const replacement = acquireDebuggerSession(view)
    old.release()
    expect(replacement.isActive()).toBe(true)
    replacement.release()
    expect(view.debugger.detach).toHaveBeenCalledTimes(1)
    expect(view.debugger.listenerCount('detach')).toBe(0)
  })

  it('does not let an invalidated lease detach a newly owned generation', () => {
    const view = target()
    const old = acquireDebuggerSession(view)
    view.debugger.detach()
    const replacement = acquireDebuggerSession(view)
    old.release()
    expect(replacement.isActive()).toBe(true)
    expect(view.debugger.detach).toHaveBeenCalledTimes(1)
    replacement.release()
    expect(view.debugger.detach).toHaveBeenCalledTimes(2)
  })

  it('keeps independent web contents isolated', () => {
    const first = target()
    const second = target()
    const firstLease = acquireDebuggerSession(first)
    const secondLease = acquireDebuggerSession(second)
    firstLease.release()
    expect(first.debugger.detach).toHaveBeenCalledOnce()
    expect(secondLease.isActive()).toBe(true)
    expect(second.debugger.detach).not.toHaveBeenCalled()
    secondLease.release()
  })

  it('does not retain a failed attachment', () => {
    const view = target()
    view.debugger.attach.mockImplementationOnce(() => {
      throw new Error('Attach rejected')
    })
    expect(() => acquireDebuggerSession(view)).toThrow('Attach rejected')
    expect(view.debugger.listenerCount('detach')).toBe(0)
    const lease = acquireDebuggerSession(view)
    expect(lease.isActive()).toBe(true)
    lease.release()
    expect(view.debugger.detach).toHaveBeenCalledOnce()
  })
})
