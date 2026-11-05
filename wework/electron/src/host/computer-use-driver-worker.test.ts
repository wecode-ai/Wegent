import { afterEach, beforeEach, expect, test, vi } from 'vitest'

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
const catalog = JSON.stringify({
  tools: [
    { name: 'verify_state', annotations: { readOnlyHint: true } },
    { name: 'invoke_menu', annotations: { readOnlyHint: false } },
  ],
})
beforeEach(() => {
  mocks.listToolsJson.mockResolvedValue(catalog)
})
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

test('cancels read-only native work without acknowledging abort as a successful action', async () => {
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
    listToolsJson: mocks.listToolsJson,
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
  receive({ id: 2, method: 'callTool', name: 'verify_state', argumentsJson: '{"pid":123}' })
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

test('ignores unrelated and malformed IPC without entering the native dispatcher', async () => {
  const send = vi.fn()
  Object.defineProperty(process, 'send', { configurable: true, value: send })
  mocks.callTool.mockResolvedValue({ text: 'Observed' })
  mocks.create.mockReturnValue({
    callTool: mocks.callTool,
    listToolsJson: mocks.listToolsJson,
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
  for (const message of [
    null,
    [],
    { event: 'unrelated-node-message' },
    { method: 'callTool', name: 'invoke_menu', argumentsJson: '{}' },
    { id: 2, method: 'callTool', name: 'invoke_menu' },
    { id: 2, method: 'unrecognized-method' },
  ])
    receive(message)
  expect(mocks.callTool).not.toHaveBeenCalled()
  expect(send).toHaveBeenCalledOnce()
  receive({ id: 3, method: 'callTool', name: 'verify_state', argumentsJson: '{}' })
  await vi.waitFor(() =>
    expect(send).toHaveBeenCalledWith(
      { id: 3, ok: true, result: { text: 'Observed' } },
      expect.any(Function)
    )
  )
  expect(mocks.callTool).toHaveBeenCalledOnce()
  receive({ id: 4, method: 'shutdown' })
  await vi.waitFor(() => expect(mocks.destroy).toHaveBeenCalledOnce())
})

test('forwards discovery cancellation to the SDK', async () => {
  const send = vi.fn()
  Object.defineProperty(process, 'send', { configurable: true, value: send })
  let signal: AbortSignal | undefined
  mocks.listToolsJson
    .mockResolvedValueOnce(catalog)
    .mockImplementation((options: { signal: AbortSignal }) => {
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
  await vi.waitFor(() =>
    expect(send).toHaveBeenCalledWith({ id: 1, ok: true, result: undefined }, expect.any(Function))
  )
  receive({ id: 2, method: 'listTools' })
  receive({ id: 2, method: 'abort' })
  expect(signal?.aborted).toBe(true)
  await vi.waitFor(() =>
    expect(send).toHaveBeenCalledWith({ id: 2, ok: false, error: 'aborted' }, expect.any(Function))
  )
  receive({ id: 3, method: 'shutdown' })
  await vi.waitFor(() => expect(mocks.destroy).toHaveBeenCalledOnce())
})

test.each(['invoke_menu', 'unknown_write_tool'])(
  'keeps cancelled %s pending until native input work and cleanup finish',
  async name => {
    const send = vi.fn()
    Object.defineProperty(process, 'send', { configurable: true, value: send })
    let signal!: AbortSignal
    let finish!: () => void
    mocks.callTool.mockImplementation((_name, _arguments, options) => {
      signal = options.signal
      return new Promise(resolve => {
        finish = () => resolve({ text: 'native cleanup complete' })
      })
    })
    mocks.create.mockReturnValue({
      callTool: mocks.callTool,
      listToolsJson: mocks.listToolsJson,
      shutdown: mocks.shutdown,
      uniffiDestroy: mocks.destroy,
    })
    await import('./computer-use-driver-worker.js')
    const receive = process
      .listeners('message')
      .find(listener => !originalMessages.includes(listener))!
    receive({ id: 1, method: 'start' })
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        { id: 1, ok: true, result: undefined },
        expect.any(Function)
      )
    )
    receive({ id: 2, method: 'callTool', name, argumentsJson: '{}' })
    receive({ id: 2, method: 'abort' })
    expect(signal.aborted).toBe(false)
    expect(send.mock.calls.filter(([message]) => message.id === 2)).toHaveLength(0)
    finish()
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        { id: 2, ok: true, result: { text: 'native cleanup complete' } },
        expect.any(Function)
      )
    )
    expect(mocks.callTool).toHaveBeenCalledOnce()
    receive({ id: 3, method: 'shutdown' })
    await vi.waitFor(() => expect(mocks.destroy).toHaveBeenCalledOnce())
  }
)
