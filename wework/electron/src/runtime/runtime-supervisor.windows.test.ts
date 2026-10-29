import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { terminateProcessTree } from './runtime-supervisor.js'

vi.mock('node:child_process', { spy: true })

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

function processFixture(pid: number) {
  return Object.assign(new EventEmitter(), {
    pid,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
    kill: vi.fn(() => true),
  })
}

function exit(child: ReturnType<typeof processFixture>, code: number) {
  child.exitCode = code
  child.emit('exit', code, null)
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
})

afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Windows runtime tree shutdown', () => {
  function setup() {
    const child = processFixture(1234)
    const killer = processFixture(5678)
    vi.mocked(spawn).mockReturnValueOnce(killer as unknown as ReturnType<typeof spawn>)
    return { child, killer, target: child as unknown as ChildProcessWithoutNullStreams }
  }

  test('waits for taskkill tree completion after the runtime leader exits', async () => {
    const { child, killer, target } = setup()
    const finished = vi.fn()
    const stopped = terminateProcessTree(target, 1000).then(finished)
    exit(child, 0)
    await Promise.resolve()
    expect(finished).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledWith('taskkill', ['/pid', '1234', '/t', '/f'], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    exit(killer, 0)
    await stopped
    expect(finished).toHaveBeenCalledOnce()
  })

  test('waits for runtime exit after taskkill has succeeded', async () => {
    const { child, killer, target } = setup()
    const finished = vi.fn()
    const stopped = terminateProcessTree(target, 1000).then(finished)
    exit(killer, 0)
    await Promise.resolve()
    expect(finished).not.toHaveBeenCalled()
    exit(child, 0)
    await stopped
  })

  test('propagates taskkill nonzero status even if the leader already exited', async () => {
    const { child, killer, target } = setup()
    const stopped = expect(terminateProcessTree(target, 1000)).rejects.toThrow('Access is denied')
    exit(child, 0)
    killer.stderr.emit('data', 'Access is denied')
    exit(killer, 1)
    await stopped
  })

  test('treats taskkill 128 as an already stopped tree', async () => {
    const { child, killer, target } = setup()
    const finished = vi.fn()
    const stopped = terminateProcessTree(target, 1000).then(finished)
    exit(child, 0)
    exit(killer, 128)
    await stopped
    expect(finished).toHaveBeenCalledOnce()
  })

  test('treats taskkill 255 as an already exited runtime tree', async () => {
    const { child, killer, target } = setup()
    const finished = vi.fn()
    const stopped = terminateProcessTree(target, 1000).then(finished)
    exit(child, 0)
    exit(killer, 255)
    await stopped
    expect(finished).toHaveBeenCalledOnce()
  })

  test('waits for the runtime to exit after taskkill 255', async () => {
    const { child, killer, target } = setup()
    const finished = vi.fn()
    const stopped = terminateProcessTree(target, 1000).then(finished)
    exit(killer, 255)
    await Promise.resolve()
    expect(finished).not.toHaveBeenCalled()
    exit(child, 0)
    await stopped
    expect(finished).toHaveBeenCalledOnce()
  })

  test('propagates taskkill executable errors instead of reporting a stopped runtime', async () => {
    const { killer, target } = setup()
    const stopped = expect(terminateProcessTree(target, 1000)).rejects.toMatchObject({
      code: 'ENOENT',
    })
    killer.emit('error', Object.assign(new Error('taskkill missing'), { code: 'ENOENT' }))
    await stopped
    expect(killer.kill).toHaveBeenCalledOnce()
  })

  test('rejects a hung taskkill within the shutdown deadline', async () => {
    vi.useFakeTimers()
    const { child, killer, target } = setup()
    const stopped = expect(terminateProcessTree(target, 100)).rejects.toThrow(
      'Windows process tree 1234'
    )
    exit(child, 0)
    await vi.advanceTimersByTimeAsync(100)
    await stopped
    expect(killer.kill).toHaveBeenCalledOnce()
  })

  test('rejects when taskkill succeeds but the target never reports exit', async () => {
    vi.useFakeTimers()
    const { killer, target } = setup()
    const stopped = expect(terminateProcessTree(target, 100)).rejects.toThrow(
      'Windows process tree 1234'
    )
    exit(killer, 0)
    await vi.advanceTimersByTimeAsync(100)
    await stopped
  })
})
