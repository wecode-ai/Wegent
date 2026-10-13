import type { Debugger } from 'electron'
import { expect, test, vi } from 'vitest'
import { readE2ERendererHeapUsage } from './e2e-renderer-heap.js'

function deferred() {
  let resolve!: (value?: unknown) => void
  const promise = new Promise<unknown>(done => {
    resolve = done
  })
  return { promise, resolve }
}

function fixture(attached = false) {
  const view = {
    isAttached: vi.fn(() => attached),
    attach: vi.fn(() => {
      attached = true
    }),
    detach: vi.fn(() => {
      attached = false
    }),
    sendCommand: vi.fn<(method: string) => Promise<unknown>>(),
  }
  const entries: { phase: string; elapsedMs: number }[] = []
  const report = (entry: { phase: string; elapsedMs: number }) => {
    entries.push(entry)
  }
  return { view, debugger: view as unknown as Debugger, entries, report }
}

test('distinguishes held garbage collection from held heap retrieval in the original CDP order', async () => {
  const f = fixture()
  const gc = deferred()
  const heap = deferred()
  const usage = { usedSize: 123, totalSize: 456 }
  f.view.sendCommand.mockImplementation(method =>
    method === 'HeapProfiler.collectGarbage' ? gc.promise : heap.promise
  )
  const pending = readE2ERendererHeapUsage(f.debugger, f.report)
  expect(f.entries.map(entry => entry.phase)).toEqual([
    'entered',
    'attach-started',
    'attach-completed',
    'collect-garbage-started',
  ])
  expect(f.view.sendCommand.mock.calls).toEqual([['HeapProfiler.collectGarbage']])
  expect(f.view.detach).not.toHaveBeenCalled()
  gc.resolve()
  await vi.waitFor(() => expect(f.entries.at(-1)?.phase).toBe('heap-usage-started'))
  expect(f.view.sendCommand.mock.calls).toEqual([
    ['HeapProfiler.collectGarbage'],
    ['Runtime.getHeapUsage'],
  ])
  expect(f.view.detach).not.toHaveBeenCalled()
  heap.resolve(usage)
  await expect(pending).resolves.toBe(usage)
  expect(f.entries.map(entry => entry.phase)).toEqual([
    'entered',
    'attach-started',
    'attach-completed',
    'collect-garbage-started',
    'collect-garbage-completed',
    'heap-usage-started',
    'heap-usage-completed',
    'detach-started',
    'detach-completed',
  ])
  expect(f.view.attach).toHaveBeenCalledExactlyOnceWith('1.3')
  expect(f.view.detach).toHaveBeenCalledTimes(1)
  expect(f.entries.every(entry => Number.isInteger(entry.elapsedMs) && entry.elapsedMs >= 0)).toBe(
    true
  )
})

test('retains a debugger attached by another owner', async () => {
  const f = fixture(true)
  const usage = { usedSize: 10 }
  f.view.sendCommand.mockResolvedValue(usage)
  await expect(readE2ERendererHeapUsage(f.debugger, f.report)).resolves.toBe(usage)
  expect(f.view.attach).not.toHaveBeenCalled()
  expect(f.view.detach).not.toHaveBeenCalled()
  expect(f.entries.map(entry => entry.phase)).not.toContain('detach-started')
})

test.each(['HeapProfiler.collectGarbage', 'Runtime.getHeapUsage'])(
  'preserves the exact %s failure and cleans up without recording its message',
  async failedMethod => {
    const f = fixture()
    const secret = 'https://private.invalid/session?token=secret'
    const error = new Error(secret)
    f.view.sendCommand.mockImplementation(async method => {
      if (method === failedMethod) throw error
      return {}
    })
    await expect(readE2ERendererHeapUsage(f.debugger, f.report)).rejects.toBe(error)
    expect(f.view.detach).toHaveBeenCalledTimes(1)
    expect(f.entries.map(entry => entry.phase)).toContain('operation-failed')
    expect(JSON.stringify(f.entries)).not.toContain(secret)
    expect(f.entries.at(-1)?.phase).toBe('detach-completed')
  }
)

test('reporting failures cannot replace a CDP failure', async () => {
  const f = fixture()
  const error = new Error('original CDP error')
  f.view.sendCommand.mockRejectedValue(error)
  await expect(
    readE2ERendererHeapUsage(f.debugger, () => {
      throw new Error('diagnostic error')
    })
  ).rejects.toBe(error)
  expect(f.view.detach).toHaveBeenCalledTimes(1)
})
