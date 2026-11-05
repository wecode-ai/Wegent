import { EventEmitter } from 'node:events'
import { describe, expect, test, vi } from 'vitest'
import { VerificationDevtools } from './verification-devtools.js'

function fixture() {
  let attached = false
  const session = Object.assign(new EventEmitter(), {
    attach: vi.fn(() => {
      attached = true
    }),
    detach: vi.fn(() => {
      attached = false
      session.emit('detach', {}, 'closed')
    }),
    isAttached: () => attached,
    sendCommand: vi.fn(async () => ({ result: 42 })),
  })
  const target = {
    id: 1,
    debugger: session,
    isDestroyed: () => false,
    getURL: () => 'file:///app/index.html',
    getTitle: () => 'App',
    getType: () => 'window',
  }
  const devtools = new VerificationDevtools(() => [target] as never)
  return { session, devtools }
}

describe('VerificationDevtools', () => {
  test('forwards arbitrary domains and flat child sessions, preserving one connection', async () => {
    const { session, devtools } = fixture()
    await expect(
      devtools.dispatch({
        action: 'command',
        target: 1,
        method: 'HeapProfiler.takeHeapSnapshot',
        params: {},
        sessionId: 'worker',
      })
    ).resolves.toEqual({ result: 42 })
    await devtools.dispatch({ action: 'command', target: 1, method: 'DOM.getDocument' })
    expect(session.sendCommand).toHaveBeenCalledWith('HeapProfiler.takeHeapSnapshot', {}, 'worker')
    expect(session.attach).toHaveBeenCalledTimes(1)
    expect(session.detach).not.toHaveBeenCalled()
    devtools.close()
    expect(session.detach).toHaveBeenCalledTimes(1)
    expect(session.listenerCount('message')).toBe(0)
  })

  test('paginates non-destructively, reports loss and retains detach evidence', async () => {
    const { session, devtools } = fixture()
    await devtools.dispatch({ action: 'events', target: 1 })
    for (let index = 0; index < 20_001; index += 1)
      session.emit('message', {}, 'Runtime.consoleAPICalled', { index }, 'worker')
    const page = await devtools.dispatch({ action: 'events', target: 1, limit: 1 })
    expect(page).toMatchObject({
      lost: 1,
      next: 2,
      latest: 20_001,
      events: [{ sequence: 2, sessionId: 'worker' }],
    })
    expect(await devtools.dispatch({ action: 'events', target: 1, limit: 1 })).toEqual(page)
    session.detach()
    expect(await devtools.dispatch({ action: 'events', target: 1, after: 20_001 })).toMatchObject({
      attached: false,
      events: [{ method: 'Inspector.detached' }],
    })
    await expect(
      devtools.dispatch({ action: 'command', target: 1, method: 'Runtime.enable' })
    ).rejects.toThrow('detached')
    await devtools.dispatch({ action: 'detach', target: 1 })
    await devtools.dispatch({ action: 'command', target: 1, method: 'Runtime.enable' })
    expect(session.attach).toHaveBeenCalledTimes(2)
    devtools.close()
  })

  test('rejects invalid targets and parameters without protocol execution', async () => {
    const { session, devtools } = fixture()
    await expect(
      devtools.dispatch({ action: 'command', target: 999, method: 'Runtime.enable' })
    ).rejects.toThrow('Unknown DevTools target')
    await expect(devtools.dispatch({ action: 'events', target: 1, limit: 0 })).rejects.toThrow(
      'limit'
    )
    await expect(
      devtools.dispatch({ action: 'command', target: 1, method: 'Runtime.enable', params: [] })
    ).rejects.toThrow('params')
    expect(session.sendCommand).not.toHaveBeenCalled()
    devtools.close()
  })
})
