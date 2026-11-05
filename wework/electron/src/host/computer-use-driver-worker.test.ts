import { afterEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  callTool: vi.fn(),
  listToolsJson: vi.fn(),
  shutdown: vi.fn(),
  destroy: vi.fn(),
}))
vi.mock('@trycua/cua-driver', () => ({ CuaDriver: { create: mocks.create } }))

const originalSend = Object.getOwnPropertyDescriptor(process, 'send')
const originalMessages = process.listeners('message')
const originalDisconnects = process.listeners('disconnect')
afterEach(() => {
  if (originalSend) Object.defineProperty(process, 'send', originalSend)
  else Reflect.deleteProperty(process, 'send')
  for (const listener of process.listeners('message')) {
    if (!originalMessages.includes(listener)) process.removeListener('message', listener)
  }
  for (const listener of process.listeners('disconnect')) {
    if (!originalDisconnects.includes(listener)) process.removeListener('disconnect', listener)
  }
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.resetModules()
})

test('cancels native work without acknowledging abort as a successful action', async () => {
  const send = vi.fn()
  Object.defineProperty(process, 'send', { configurable: true, value: send })
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
  const receive = process
    .listeners('message')
    .find(listener => !originalMessages.includes(listener))!
  receive({ id: 1, method: 'start' })
  await vi.waitFor(() =>
    expect(send).toHaveBeenCalledWith({ id: 1, ok: true, result: undefined }, expect.any(Function))
  )
  receive({ id: 2, method: 'callTool', name: 'invoke_menu', argumentsJson: '{"pid":123}' })
  receive({ id: 2, method: 'abort' })
  expect(signal?.aborted).toBe(true)
  await vi.waitFor(() =>
    expect(send).toHaveBeenCalledWith({ id: 2, ok: false, error: 'aborted' }, expect.any(Function))
  )
  expect(send.mock.calls.filter(([message]) => message.id === 2)).toHaveLength(1)
  receive({ id: 3, method: 'shutdown' })
  await vi.waitFor(() => expect(mocks.destroy).toHaveBeenCalledOnce())
  expect(mocks.shutdown).toHaveBeenCalledOnce()
})

test('terminates native work when the host IPC channel disappears', async () => {
  Object.defineProperty(process, 'send', { configurable: true, value: vi.fn() })
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
  await import('./computer-use-driver-worker.js')
  const disconnected = process
    .listeners('disconnect')
    .find(listener => !originalDisconnects.includes(listener))!
  disconnected()
  expect(exit).toHaveBeenCalledWith(0)
})

test('forwards discovery cancellation to the SDK', async () => {
  const send = vi.fn()
  Object.defineProperty(process, 'send', { configurable: true, value: send })
  let signal: AbortSignal | undefined
  mocks.listToolsJson.mockImplementation((options: { signal: AbortSignal }) => {
    signal = options.signal
    return new Promise((_, reject) => {
      signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
  })
  mocks.create.mockReturnValue({
    listToolsJson: mocks.listToolsJson,
    shutdown: mocks.shutdown,
    uniffiDestroy: mocks.destroy,
  })
  await import('./computer-use-driver-worker.js')
  const receive = process
    .listeners('message')
    .find(listener => !originalMessages.includes(listener))!
  receive({ id: 1, method: 'start' })
  receive({ id: 2, method: 'listTools' })
  receive({ id: 2, method: 'abort' })
  expect(signal?.aborted).toBe(true)
  await vi.waitFor(() =>
    expect(send).toHaveBeenCalledWith({ id: 2, ok: false, error: 'aborted' }, expect.any(Function))
  )
  receive({ id: 3, method: 'shutdown' })
  await vi.waitFor(() => expect(mocks.destroy).toHaveBeenCalledOnce())
})
