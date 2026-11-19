import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, expect, test, vi } from 'vitest'
import { e2eErrorLog, recordE2ERendererError } from './e2e-error-log.js'
import { MainProcessLog } from './main-process-log.js'
import { HostPipeServer } from './host-pipe.js'
import { HostCapabilityRouter } from './capability-router.js'
import { RuntimeSupervisor } from '../runtime/runtime-supervisor.js'

afterEach(() => vi.restoreAllMocks())

test('main console and uncaught exceptions reach the journal through installed hooks', () => {
  const methods = ['debug', 'info', 'log', 'warn', 'error'] as const
  const originals = methods.map(method => console[method])
  const listeners = new Set(process.listeners('uncaughtExceptionMonitor'))
  const record = vi.spyOn(e2eErrorLog, 'record').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  try {
    new MainProcessLog().install()
    console.error('injected main error')
    const monitor = process
      .listeners('uncaughtExceptionMonitor')
      .find(listener => !listeners.has(listener))!
    monitor(new Error('injected uncaught exception'), 'uncaughtException')
    expect(record).toHaveBeenCalledWith('main', 'console', 'error', {
      message: 'injected main error',
    })
    expect(record).toHaveBeenCalledWith(
      'main',
      'uncaught-exception',
      'error',
      expect.objectContaining({
        message: 'injected uncaught exception',
      })
    )
  } finally {
    methods.forEach((method, index) => {
      console[method] = originals[index]
    })
    process
      .listeners('uncaughtExceptionMonitor')
      .filter(listener => !listeners.has(listener))
      .forEach(listener => process.off('uncaughtExceptionMonitor', listener))
  }
})

test('renderer reports retain structured codes and complete stacks without suppressing malformed reports', () => {
  const record = vi.spyOn(e2eErrorLog, 'record').mockImplementation(() => undefined)
  recordE2ERendererError(
    '[wework-e2e-error] ' +
      JSON.stringify({
        type: 'executor:operation',
        message: 'failed',
        code: 'injected_failure',
        stack: 'x'.repeat(9000),
      }),
    { webContentsId: 8 },
    3
  )
  expect(record).toHaveBeenCalledWith('renderer', 'executor:operation', 'error', {
    webContentsId: 8,
    message: 'failed',
    code: 'injected_failure',
    stack: 'x'.repeat(9000),
  })
  recordE2ERendererError('[wework-e2e-error] broken', {}, 3)
  expect(record).toHaveBeenLastCalledWith('renderer', 'renderer-error', 'error', {
    message: '[wework-e2e-error] broken',
  })
})

test('host protocol failures are recorded even without a console error', async () => {
  const record = vi.spyOn(e2eErrorLog, 'record').mockImplementation(() => undefined)
  const server = new HostPipeServer(new HostCapabilityRouter())
  const input = new PassThrough()
  const output = new PassThrough()
  server.attachStreams(input, output)
  const failed = once(server, 'protocolError')
  input.write('broken JSON\n')
  await failed
  expect(record).toHaveBeenCalledWith(
    'host-pipe',
    'protocol-failed',
    'error',
    expect.objectContaining({
      message: 'Desktop host frame is not valid JSON',
    })
  )
  server.stop()
  input.destroy()
  output.destroy()
})

test('real runtime process output and unexpected termination reach the same journal', async () => {
  const record = vi.spyOn(e2eErrorLog, 'record').mockImplementation(() => undefined)
  const supervisor = new RuntimeSupervisor({
    name: 'injected-runtime',
    command: process.execPath,
    args: [
      '-e',
      'process.stdout.write("output"); process.stderr.write("failure"); process.exit(23)',
    ],
    maxCrashes: 0,
  })
  try {
    const child = await supervisor.start()
    await once(child, 'close')
    expect(record).toHaveBeenCalledWith(
      'runtime',
      'stdout',
      'info',
      expect.objectContaining({ message: 'output' })
    )
    expect(record).toHaveBeenCalledWith(
      'runtime',
      'stderr',
      'error',
      expect.objectContaining({ message: 'failure' })
    )
    expect(record).toHaveBeenCalledWith(
      'runtime',
      'process-exit',
      'error',
      expect.objectContaining({ code: 23, expected: false })
    )
  } finally {
    await supervisor.stop()
  }
})
