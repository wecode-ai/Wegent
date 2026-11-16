import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ComputerUseDriverProcess } from './computer-use-driver-process.js'
import type { DriverRequest } from './computer-use-driver-protocol.js'

const { fork } = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock('node:child_process', () => ({ fork }))

const originalHelperPath = Object.getOwnPropertyDescriptor(process, 'helperExecPath')

class DriverChild extends EventEmitter {
  send = vi.fn((message: DriverRequest, callback: (error: Error | null) => void) => {
    if (message.method === 'start' || message.method === 'shutdown') {
      queueMicrotask(() => this.emit('message', { id: message.id, ok: true }))
    }
    callback(null)
    return true
  })
  kill = vi.fn(() => this.emit('exit', 0))
}

describe('ComputerUseDriverProcess', () => {
  let child: DriverChild

  beforeEach(() => {
    Object.defineProperty(process, 'helperExecPath', {
      configurable: true,
      value: process.execPath,
    })
    child = new DriverChild()
    fork.mockReturnValue(child)
  })

  afterEach(() => {
    if (originalHelperPath) Object.defineProperty(process, 'helperExecPath', originalHelperPath)
    else Reflect.deleteProperty(process, 'helperExecPath')
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  test('executes native tools outside the host while preserving its permission identity', async () => {
    const onExit = vi.fn()
    const driver = await ComputerUseDriverProcess.create(onExit)
    expect(fork).toHaveBeenCalledWith(
      expect.stringMatching(/computer-use-driver-worker\.js$/),
      [],
      expect.objectContaining({
        execPath: process.execPath,
        execArgv: [],
        env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1' }),
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      })
    )
    const result = driver.callTool('invoke_menu', '{"pid":123}')
    const request = child.send.mock.lastCall![0]
    expect(request).toMatchObject({
      method: 'callTool',
      name: 'invoke_menu',
      argumentsJson: '{"pid":123}',
    })
    child.emit('message', { id: request.id, ok: true, result: { text: 'Done', images: [] } })
    await expect(result).resolves.toEqual({ text: 'Done', images: [] })
    await driver.shutdown()
    await driver.shutdown()
    expect(child.kill).toHaveBeenCalledOnce()
    expect(onExit).not.toHaveBeenCalled()
  })

  test('passes cancellation to the same in-flight native call', async () => {
    const driver = await ComputerUseDriverProcess.create(vi.fn())
    const controller = new AbortController()
    const result = driver.callTool('click', '{}', { signal: controller.signal })
    const { id } = child.send.mock.lastCall![0]
    controller.abort()
    expect(child.send).toHaveBeenLastCalledWith({ id, method: 'abort' }, expect.any(Function))
    child.emit('message', { id, ok: false, error: 'aborted' })
    await expect(result).rejects.toThrow('aborted')

    const calls = child.send.mock.calls.length
    await expect(driver.callTool('click', '{}', { signal: controller.signal })).rejects.toThrow()
    expect(child.send).toHaveBeenCalledTimes(calls)
    await driver.shutdown()
  })

  test.each(['callTool', 'listTools'] as const)(
    'terminates an unresponsive worker when %s cancellation is not acknowledged',
    async method => {
      vi.useFakeTimers()
      const onExit = vi.fn()
      const driver = await ComputerUseDriverProcess.create(onExit)
      const controller = new AbortController()
      const action =
        method === 'callTool'
          ? driver.callTool('start_session', '{}', { signal: controller.signal })
          : driver.listToolsJson({ signal: controller.signal })
      const rejected = expect(action).rejects.toThrow(
        'cancellation timed out; action outcome is unknown'
      )
      const { id } = child.send.mock.lastCall![0]
      controller.abort()
      expect(child.send).toHaveBeenLastCalledWith({ id, method: 'abort' }, expect.any(Function))
      await vi.advanceTimersByTimeAsync(4_999)
      expect(child.kill).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await rejected
      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
      expect(onExit).toHaveBeenCalledOnce()
      child.emit('message', { id, ok: true, result: 'late result' })
      await expect(driver.listToolsJson()).rejects.toThrow('action outcome is unknown')
      await driver.shutdown()
    }
  )

  test('clears the cancellation deadline when the worker acknowledges it', async () => {
    vi.useFakeTimers()
    const driver = await ComputerUseDriverProcess.create(vi.fn())
    const controller = new AbortController()
    const catalog = driver.listToolsJson({ signal: controller.signal })
    const rejected = expect(catalog).rejects.toThrow('aborted')
    const { id } = child.send.mock.lastCall![0]
    controller.abort()
    child.emit('message', { id, ok: false, error: 'aborted' })
    await rejected
    await vi.advanceTimersByTimeAsync(5_000)
    expect(child.kill).not.toHaveBeenCalled()
    await driver.shutdown()
  })

  test('rejects all pending requests on native crash without replaying actions', async () => {
    const onExit = vi.fn()
    const driver = await ComputerUseDriverProcess.create(onExit)
    const action = driver.callTool('invoke_menu', '{}')
    const catalog = driver.listToolsJson()
    child.emit('exit', 5)
    await expect(action).rejects.toThrow('action outcome is unknown')
    await expect(catalog).rejects.toThrow('exited (5)')
    expect(onExit).toHaveBeenCalledOnce()
    await expect(driver.callTool('invoke_menu', '{}')).rejects.toThrow('exited (5)')
    expect(child.send).toHaveBeenCalledTimes(3)
    await driver.shutdown()
  })

  test('rejects startup when the native module crashes before readiness', async () => {
    child.send.mockImplementation(() => true)
    const startup = ComputerUseDriverProcess.create(vi.fn())
    child.emit('exit', 5)
    await expect(startup).rejects.toThrow('exited (5)')
    expect(child.kill).toHaveBeenCalledOnce()
  })

  test('finishes startup failure cleanup when spawning closes without an exit event', async () => {
    child.send.mockImplementation(() => true)
    child.kill.mockImplementation(() => false)
    const startup = ComputerUseDriverProcess.create(vi.fn())
    const rejected = expect(startup).rejects.toThrow('Unable to spawn native worker')
    child.emit('error', new Error('Unable to spawn native worker'))
    child.emit('close', -2)
    await rejected
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  test('handles fatal worker errors without an unhandled host error event', async () => {
    const onExit = vi.fn()
    const driver = await ComputerUseDriverProcess.create(onExit)
    const result = driver.callTool('invoke_menu', '{}')
    child.emit('error', new Error('Native worker failed'))
    await expect(result).rejects.toThrow('Native worker failed')
    child.emit('exit', 1)
    expect(onExit).toHaveBeenCalledOnce()
    await driver.shutdown()
  })

  test('terminates the worker if cancellation cannot reach it', async () => {
    const driver = await ComputerUseDriverProcess.create(vi.fn())
    const controller = new AbortController()
    const result = driver.callTool('click', '{}', { signal: controller.signal })
    child.send.mockImplementation(() => {
      throw new Error('IPC closed')
    })
    controller.abort()
    await expect(result).rejects.toThrow('IPC closed')
    expect(child.kill).toHaveBeenCalledOnce()
    await driver.shutdown()
  })

  test('kills an unresponsive worker after the shutdown budget', async () => {
    vi.useFakeTimers()
    const driver = await ComputerUseDriverProcess.create(vi.fn())
    child.send.mockImplementation(() => true)
    const stopped = expect(driver.shutdown()).rejects.toThrow('shutdown timed out')
    await vi.advanceTimersByTimeAsync(10_000)
    await stopped
    expect(child.kill).toHaveBeenCalledOnce()
  })

  test('does not finish shutdown before the native process actually exits', async () => {
    const driver = await ComputerUseDriverProcess.create(vi.fn())
    child.kill.mockImplementation(() => true)
    let finished = false
    const stopped = driver.shutdown().then(() => {
      finished = true
    })
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith('SIGKILL'))
    expect(finished).toBe(false)
    child.emit('exit', 0)
    await stopped
    expect(finished).toBe(true)
    await driver.shutdown()
    expect(child.kill).toHaveBeenCalledOnce()
  })

  test('rejects closed-channel sends before an exit notification arrives', async () => {
    const onExit = vi.fn()
    const driver = await ComputerUseDriverProcess.create(onExit)
    child.send.mockImplementation((_message, callback) => {
      queueMicrotask(() => callback(new Error('IPC channel is already closed')))
      return false
    })
    await expect(driver.listToolsJson()).rejects.toThrow('IPC channel is already closed')
    expect(onExit).toHaveBeenCalledOnce()
    expect(child.kill).toHaveBeenCalledOnce()
    const calls = child.send.mock.calls.length
    await expect(driver.callTool('invoke_menu', '{}')).rejects.toThrow('action outcome is unknown')
    await driver.shutdown()
    expect(child.send).toHaveBeenCalledTimes(calls)
  })

  test('rejects pending work when IPC disconnects before process exit', async () => {
    const onExit = vi.fn()
    const driver = await ComputerUseDriverProcess.create(onExit)
    const pending = driver.callTool('invoke_menu', '{}')
    child.emit('disconnect')
    await expect(pending).rejects.toThrow('IPC disconnected')
    child.emit('exit', 1)
    expect(onExit).toHaveBeenCalledOnce()
    await driver.shutdown()
  })
})
