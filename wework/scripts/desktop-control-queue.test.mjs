import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { WindowCommandQueue } from './desktop-control-queue.mjs'

function response() {
  return Object.assign(new EventEmitter(), { writeHead: vi.fn(), end: vi.fn() })
}

afterEach(() => vi.useRealTimers())

describe('WindowCommandQueue', () => {
  test('keeps queued commands isolated between main and detached windows', () => {
    const queue = new WindowCommandQueue()
    queue.register('main-1', 'main')
    queue.register('detached-1', 'workspace-task')
    const main = { id: 'main-command', windowLabel: 'main' }
    const detached = { id: 'detached-command', windowLabel: 'workspace-task' }
    queue.enqueue(main)
    queue.enqueue(detached)
    const detachedResponse = response()
    queue.poll('detached-1', detachedResponse, false)
    expect(detachedResponse.end).toHaveBeenCalledWith(JSON.stringify(detached))
    expect(queue.length).toBe(1)
    const emptyResponse = response()
    queue.poll('detached-1', emptyResponse, false)
    expect(emptyResponse.writeHead).toHaveBeenCalledWith(204, expect.anything())
    const mainResponse = response()
    queue.poll('main-1', mainResponse, false)
    expect(mainResponse.end).toHaveBeenCalledWith(JSON.stringify(main))
    expect(queue.length).toBe(0)
  })

  test('holds a real HTTP poll until a command arrives', async () => {
    const queue = new WindowCommandQueue()
    queue.register('main-1', 'main')
    let arrived
    const requestArrived = new Promise(resolve => {
      arrived = resolve
    })
    const server = createServer((_request, response) => {
      queue.poll('main-1', response, true)
      arrived()
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      let settled = false
      const poll = fetch(`http://127.0.0.1:${server.address().port}/commands`).then(value => {
        settled = true
        return value
      })
      await requestArrived
      expect(settled).toBe(false)
      const command = { id: 'inspect', windowLabel: 'main', action: 'snapshot' }
      queue.enqueue(command)
      const result = await poll
      expect(result.status).toBe(200)
      expect(await result.json()).toEqual(command)
      expect(queue.length).toBe(0)
    } finally {
      queue.close()
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    }
  })

  test('returns an empty response only after the idle timeout', () => {
    vi.useFakeTimers()
    const queue = new WindowCommandQueue()
    queue.register('main-1', 'main')
    const idle = response()
    queue.poll('main-1', idle, true)
    vi.advanceTimersByTime(24_999)
    expect(idle.end).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(idle.writeHead).toHaveBeenCalledWith(204, expect.anything())
    expect(idle.end).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  test('retires a replaced client and delivers only to the current window owner', () => {
    vi.useFakeTimers()
    const queue = new WindowCommandQueue()
    queue.register('main-1', 'main')
    const previous = response()
    queue.poll('main-1', previous, true)
    queue.register('main-2', 'main')
    expect(previous.writeHead).toHaveBeenCalledWith(410, expect.anything())
    const stale = response()
    queue.poll('main-1', stale, true)
    expect(stale.writeHead).toHaveBeenCalledWith(410, expect.anything())
    const current = response()
    queue.poll('main-2', current, true)
    const command = { id: 'next', windowLabel: 'main' }
    queue.enqueue(command)
    expect(current.end).toHaveBeenCalledWith(JSON.stringify(command))
    expect(previous.end).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  test('cleans up disconnected polls without losing the next command', () => {
    vi.useFakeTimers()
    const queue = new WindowCommandQueue()
    queue.register('main-1', 'main')
    const disconnected = response()
    queue.poll('main-1', disconnected, true)
    disconnected.emit('close')
    expect(vi.getTimerCount()).toBe(0)
    queue.enqueue({ id: 'next', windowLabel: 'main' })
    expect(queue.length).toBe(1)
    expect(disconnected.end).not.toHaveBeenCalled()
    queue.remove('next')
    expect(queue.length).toBe(0)
  })

  test('closes pending polls and rejects unregistered clients', () => {
    vi.useFakeTimers()
    const queue = new WindowCommandQueue()
    const unknown = response()
    queue.poll('unknown', unknown, true)
    expect(unknown.writeHead).toHaveBeenCalledWith(410, expect.anything())
    queue.register('main-1', 'main')
    const pending = response()
    queue.poll('main-1', pending, true)
    queue.close()
    expect(pending.writeHead).toHaveBeenCalledWith(410, expect.anything())
    expect(vi.getTimerCount()).toBe(0)
  })
})
