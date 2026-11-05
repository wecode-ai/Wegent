import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ComputerUseDriverProcess } from './computer-use-driver-process.js'
import type { DriverRequest } from './computer-use-driver-protocol.js'

const { fork } = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock('electron', () => ({ utilityProcess: { fork } }))

class DriverChild extends EventEmitter {
  postMessage = vi.fn((message: DriverRequest) => {
    if (message.method === 'start' || message.method === 'shutdown') {
      queueMicrotask(() => this.emit('message', { id: message.id, ok: true }))
    }
  })
  kill = vi.fn(() => this.emit('exit', 0))
}

describe('ComputerUseDriverProcess', () => {
  let child: DriverChild

  beforeEach(() => {
    child = new DriverChild()
    fork.mockReturnValue(child)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  test('executes native tools outside the host while preserving its permission identity', async () => {
    const onExit = vi.fn()
    const driver = await ComputerUseDriverProcess.create(onExit)
    expect(fork).toHaveBeenCalledWith(
      expect.stringMatching(/computer-use-driver-worker\.js$/),
      [],
      expect.objectContaining({ disclaim: false })
    )
    const result = driver.callTool('invoke_menu', '{"pid":123}')
    const request = child.postMessage.mock.lastCall![0]
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
    const { id } = child.postMessage.mock.lastCall![0]
    controller.abort()
    expect(child.postMessage).toHaveBeenLastCalledWith({ id, method: 'abort' })
    child.emit('message', { id, ok: false, error: 'aborted' })
    await expect(result).rejects.toThrow('aborted')

    const calls = child.postMessage.mock.calls.length
    await expect(driver.callTool('click', '{}', { signal: controller.signal })).rejects.toThrow()
    expect(child.postMessage).toHaveBeenCalledTimes(calls)
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
    expect(child.postMessage).toHaveBeenCalledTimes(3)
    await driver.shutdown()
  })

  test('rejects startup when the native module crashes before readiness', async () => {
    child.postMessage.mockImplementation(() => {})
    const startup = ComputerUseDriverProcess.create(vi.fn())
    child.emit('exit', 5)
    await expect(startup).rejects.toThrow('exited (5)')
    expect(child.kill).toHaveBeenCalledOnce()
  })

  test('handles fatal worker errors without an unhandled host error event', async () => {
    const onExit = vi.fn()
    const driver = await ComputerUseDriverProcess.create(onExit)
    const result = driver.callTool('invoke_menu', '{}')
    child.emit('error', 'FatalError', 'native runtime', 'diagnostic report')
    await expect(result).rejects.toThrow('FatalError at native runtime')
    child.emit('exit', 1)
    expect(onExit).toHaveBeenCalledOnce()
    await driver.shutdown()
  })

  test('terminates the worker if cancellation cannot reach it', async () => {
    const driver = await ComputerUseDriverProcess.create(vi.fn())
    const controller = new AbortController()
    const result = driver.callTool('click', '{}', { signal: controller.signal })
    child.postMessage.mockImplementation(() => {
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
    child.postMessage.mockImplementation(() => {})
    const stopped = expect(driver.shutdown()).rejects.toThrow('shutdown timed out')
    await vi.advanceTimersByTimeAsync(10_000)
    await stopped
    expect(child.kill).toHaveBeenCalledOnce()
  })
})
