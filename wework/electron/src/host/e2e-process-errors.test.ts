import { spawn } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import { afterEach, expect, test, vi } from 'vitest'
import { e2eErrorLog } from './e2e-error-log.js'
import {
  installE2EProcessErrors,
  observeE2EChildProcess,
  observeE2EWorker,
} from './e2e-process-errors.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

test('captures real spawn failures without consuming error events or child streams', async () => {
  const record = vi.spyOn(e2eErrorLog, 'record').mockImplementation(() => undefined)
  const child = spawn('/nonexistent/wework-e2e-command', [], { stdio: 'pipe' })
  const count = child.listenerCount('error')
  observeE2EChildProcess(child)
  expect(child.listenerCount('error')).toBe(count)
  expect(child.stdout.listenerCount('data')).toBe(0)
  child.on('error', () => undefined)
  await new Promise(resolve => child.once('close', resolve))
  expect(record).toHaveBeenCalledWith(
    'process',
    'spawn-failed',
    'error',
    expect.objectContaining({
      message: expect.stringContaining('ENOENT'),
    })
  )
})

test('captures real worker exceptions without changing the worker error policy', async () => {
  const record = vi.spyOn(e2eErrorLog, 'record').mockImplementation(() => undefined)
  const worker = new Worker('throw new Error("injected worker failure")', { eval: true })
  const count = worker.listenerCount('error')
  observeE2EWorker(worker)
  expect(worker.listenerCount('error')).toBe(count)
  worker.on('error', () => undefined)
  await new Promise(resolve => worker.once('exit', resolve))
  expect(record).toHaveBeenCalledWith(
    'worker',
    'uncaught-exception',
    'error',
    expect.objectContaining({
      message: 'injected worker failure',
      stack: expect.stringContaining('injected worker failure'),
    })
  )
})

test('native discovery automatically observes newly created processes and workers', async () => {
  vi.stubEnv('VITE_WEWORK_E2E', 'true')
  const record = vi.spyOn(e2eErrorLog, 'record').mockImplementation(() => undefined)
  const stop = installE2EProcessErrors()
  try {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
    await new Promise(resolve => child.once('close', resolve))
    const worker = new Worker('throw new Error("discovered worker error")', { eval: true })
    worker.on('error', () => undefined)
    await new Promise(resolve => worker.once('exit', resolve))
    expect(record).toHaveBeenCalledWith('process', 'spawned', 'info', { childPid: child.pid })
    expect(record).toHaveBeenCalledWith(
      'worker',
      'uncaught-exception',
      'error',
      expect.objectContaining({
        message: 'discovered worker error',
      })
    )
  } finally {
    stop()
  }
})
