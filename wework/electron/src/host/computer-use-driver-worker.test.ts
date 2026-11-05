import { EventEmitter } from 'node:events'
import { afterEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  callTool: vi.fn(),
  shutdown: vi.fn(),
  destroy: vi.fn(),
}))
vi.mock('@trycua/cua-driver', () => ({ CuaDriver: { create: mocks.create } }))

const originalPort = Object.getOwnPropertyDescriptor(process, 'parentPort')
afterEach(() => {
  if (originalPort) Object.defineProperty(process, 'parentPort', originalPort)
  else Reflect.deleteProperty(process, 'parentPort')
  vi.resetModules()
})

test('cancels native work without acknowledging abort as a successful action', async () => {
  const port = Object.assign(new EventEmitter(), { postMessage: vi.fn() })
  Object.defineProperty(process, 'parentPort', { configurable: true, value: port })
  let signal: AbortSignal | undefined
  mocks.callTool.mockImplementation(
    (_name: string, _arguments: string, options: { signal: AbortSignal }) => {
      signal = options.signal
      return new Promise((_, reject) => {
        signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    }
  )
  mocks.create.mockReturnValue({
    callTool: mocks.callTool,
    shutdown: mocks.shutdown,
    uniffiDestroy: mocks.destroy,
  })
  await import('./computer-use-driver-worker.js')
  port.emit('message', { data: { id: 1, method: 'start' } })
  await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledWith({ id: 1, ok: true }))
  port.emit('message', {
    data: { id: 2, method: 'callTool', name: 'invoke_menu', argumentsJson: '{"pid":123}' },
  })
  port.emit('message', { data: { id: 2, method: 'abort' } })
  expect(signal?.aborted).toBe(true)
  await vi.waitFor(() =>
    expect(port.postMessage).toHaveBeenCalledWith({ id: 2, ok: false, error: 'aborted' })
  )
  expect(port.postMessage.mock.calls.filter(([message]) => message.id === 2)).toHaveLength(1)
  port.emit('message', { data: { id: 3, method: 'shutdown' } })
  await vi.waitFor(() => expect(mocks.destroy).toHaveBeenCalledOnce())
  expect(mocks.shutdown).toHaveBeenCalledOnce()
})
