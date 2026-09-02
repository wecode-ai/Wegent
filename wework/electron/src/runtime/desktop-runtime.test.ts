import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { HostCapabilityRouter } from '../host/capability-router.js'
import { HostPipeServer } from '../host/host-pipe.js'
import { DesktopRuntime, type CoreDshHandle } from './desktop-runtime.js'
import type { DshRuntimeOptions } from './dsh-runtime.js'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

class FakeCoreDsh implements CoreDshHandle {
  startCalls = 0
  stopCalls = 0
  stopHang: Deferred<void> | null = null

  async start(): Promise<void> {
    this.startCalls += 1
  }

  async stop(): Promise<void> {
    this.stopCalls += 1
    if (this.stopHang) await this.stopHang.promise
  }

  url(): string {
    return 'http://127.0.0.1:1/'
  }

  pid(): number | null {
    return 1
  }
}

const prepareState = vi.hoisted(() => ({
  prepareCalls: 0,
  resolveLaunch: null as ((value: unknown) => void) | null,
}))

vi.mock('./core-dsh-runtime.js', () => ({
  prepareCoreDshLaunch: vi.fn(() => {
    prepareState.prepareCalls += 1
    return new Promise(resolve => {
      prepareState.resolveLaunch = resolve
    })
  }),
}))

const created: FakeCoreDsh[] = []
const hostPipe = new HostPipeServer(new HostCapabilityRouter())

function createCoreDsh(options: DshRuntimeOptions): CoreDshHandle {
  void options
  const fake = new FakeCoreDsh()
  created.push(fake)
  return fake
}

function createRuntime(environment: NodeJS.ProcessEnv): DesktopRuntime {
  return new DesktopRuntime({
    environment,
    dataDirectory: '/tmp/wework-desktop-runtime-test/data',
    logDirectory: '/tmp/wework-desktop-runtime-test/logs',
    hostPipe,
    createCoreDsh,
  })
}

const EXTERNAL_DSH = { WEWORK_CORE_DSH_URL: 'http://127.0.0.1:1' }

async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('DesktopRuntime lifecycle generation', () => {
  beforeEach(() => {
    created.length = 0
    prepareState.prepareCalls = 0
    prepareState.resolveLaunch = null
  })

  afterEach(async () => {
    prepareState.resolveLaunch = null
  })

  test('M3-A: a restart continuation cannot publish a runtime after shutdown', async () => {
    const runtime = createRuntime(EXTERNAL_DSH)
    await runtime.start()
    expect(created).toHaveLength(1)
    expect(runtime.state().ready).toBe(true)

    const previous = created[0]
    previous.stopHang = deferred()
    const restart = runtime.restartCoreDsh()
    await flush()

    await runtime.stop()
    expect(runtime.state().ready).toBe(false)

    previous.stopHang.resolve()
    await restart

    expect(created).toHaveLength(1)
    expect(created[0]).toBe(previous)
    expect(runtime.state().coreDshUrl).toBeNull()
  })

  test('M3-B: concurrent restarts stop the old runtime once and create exactly one replacement', async () => {
    const runtime = createRuntime(EXTERNAL_DSH)
    await runtime.start()
    expect(created).toHaveLength(1)

    const previous = created[0]
    previous.stopHang = deferred()
    const first = runtime.restartCoreDsh()
    const second = runtime.restartCoreDsh()
    expect(second).toBe(first)

    previous.stopHang.resolve()
    await Promise.all([first, second])

    expect(previous.stopCalls).toBe(1)
    expect(created).toHaveLength(2)
    expect(created[1].startCalls).toBe(1)
    expect(runtime.state().ready).toBe(true)
    expect(runtime.state().coreDshUrl).not.toBeNull()
  })

  test('M3-E: an old-generation restart flight cannot absorb or clear a new-generation restart', async () => {
    const runtime = createRuntime(EXTERNAL_DSH)
    await runtime.start()
    const a = created[0]
    a.stopHang = deferred()
    const oldRestart = runtime.restartCoreDsh()
    await flush()

    await runtime.stop()
    await runtime.start()
    const b = created[1]
    b.stopHang = deferred()
    const newRestart = runtime.restartCoreDsh()
    expect(newRestart).not.toBe(oldRestart)

    a.stopHang.resolve()
    await oldRestart

    const inflight = runtime.restartCoreDsh()
    expect(inflight).toBe(newRestart)

    b.stopHang.resolve()
    await Promise.all([newRestart, inflight])

    expect(a.stopCalls).toBe(1)
    expect(b.stopCalls).toBe(1)
    expect(created).toHaveLength(3)
    expect(created[2].startCalls).toBe(1)
    expect(runtime.state().ready).toBe(true)
    expect(runtime.state().coreDshUrl).not.toBeNull()
  })

  test('M3-C: startup preparation continuation cannot publish a runtime after shutdown', async () => {
    const runtime = createRuntime({ WEWORK_HARNESS_RUNTIME_ROOT: '/tmp/wework-harness-root' })
    const start = runtime.start()
    await vi.waitFor(() => expect(prepareState.prepareCalls).toBe(1))

    await runtime.stop()
    prepareState.resolveLaunch?.({
      command: 'node',
      entry: 'entry.js',
      args: [],
      cwd: '/tmp/wework-harness-root',
      dshHome: '/tmp/wework-harness-root/home',
      environment: {},
      profile: 'test',
      version: '0.0.0',
      sourceFingerprint: 'test',
    })
    await start

    expect(created).toHaveLength(0)
    expect(runtime.state().coreDshUrl).toBeNull()
    expect(runtime.state().ready).toBe(false)
  })

  test('negative: normal start reaches ready and stop tears everything down', async () => {
    const runtime = createRuntime(EXTERNAL_DSH)
    await runtime.start()

    expect(runtime.state().ready).toBe(true)
    expect(runtime.state().coreDshUrl).not.toBeNull()
    expect(created).toHaveLength(1)
    expect(created[0].startCalls).toBe(1)

    await runtime.stop()

    expect(runtime.state().ready).toBe(false)
    expect(runtime.state().coreDshUrl).toBeNull()
    expect(created[0].stopCalls).toBe(1)
  })

  test('negative: a normal single restart replaces the core runtime', async () => {
    const runtime = createRuntime(EXTERNAL_DSH)
    await runtime.start()

    await runtime.restartCoreDsh()

    expect(created).toHaveLength(2)
    expect(created[0].stopCalls).toBe(1)
    expect(created[1].startCalls).toBe(1)
    expect(runtime.state().ready).toBe(true)
  })

  test('negative: a stale restart failure does not clear a newer runtime', async () => {
    const runtime = createRuntime(EXTERNAL_DSH)
    await runtime.start()

    const previous = created[0]
    previous.stopHang = deferred()
    const restart = runtime.restartCoreDsh()
    await flush()

    await runtime.stop()
    await runtime.start()
    expect(created).toHaveLength(2)

    previous.stopHang.resolve()
    await restart

    expect(created).toHaveLength(2)
    expect(runtime.state().ready).toBe(true)
  })

  test('negative: workbench open is rejected outside the started lifecycle', async () => {
    const runtime = createRuntime(EXTERNAL_DSH)
    await expect(
      runtime.openWorkbenchRuntime({
        tabId: 'tab-1',
        url: 'http://127.0.0.1:1/',
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
      })
    ).rejects.toThrow('Core desktop runtime is not ready')

    await runtime.start()
    await runtime.stop()
    await expect(
      runtime.openWorkbenchRuntime({
        tabId: 'tab-2',
        url: 'http://127.0.0.1:1/',
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
      })
    ).rejects.toThrow('Core desktop runtime is not ready')
  })
})
