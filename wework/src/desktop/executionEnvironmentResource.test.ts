import { beforeEach, expect, test, vi } from 'vitest'
import type { DesktopHostEvent } from '@/api/dsh/desktopHost'
import type { ExecutionEnvironmentStatus } from './executionEnvironments'
import { createExecutionEnvironmentResource } from './executionEnvironmentResource'

const mocks = vi.hoisted(() => ({ list: vi.fn(), ensure: vi.fn(), subscribe: vi.fn() }))
vi.mock('@/api/dsh/desktopHost', () => ({ subscribeDesktopHostEvents: mocks.subscribe }))
vi.mock('./executionEnvironments', () => ({
  listExecutionEnvironments: mocks.list,
  ensurePython: mocks.ensure,
}))
const python: ExecutionEnvironmentStatus = {
  id: 'python',
  managed: true,
  autoInstall: true,
  state: 'notInstalled',
  version: null,
  downloadedBytes: 0,
  totalBytes: 0,
  installedBytes: 0,
  path: null,
  error: null,
}
const node: ExecutionEnvironmentStatus = { ...python, id: 'node', state: 'installed' }
function held<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
function emit(status: ExecutionEnvironmentStatus, subscription = 0) {
  const handler = mocks.subscribe.mock.calls[subscription][0] as (event: DesktopHostEvent) => void
  handler({ sequence: 1, type: 'python-runtime-status', payload: { ...status } })
}
const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.list.mockResolvedValue([node, python])
  mocks.subscribe.mockImplementation(() => vi.fn())
})

test('shares one read and native subscription until the last consumer leaves', async () => {
  const resource = createExecutionEnvironmentResource()
  expect(mocks.list).not.toHaveBeenCalled()
  const first = resource.subscribe(vi.fn())
  const second = resource.subscribe(vi.fn())
  await settle()
  expect(mocks.list).toHaveBeenCalledOnce()
  expect(mocks.subscribe).toHaveBeenCalledOnce()
  expect(mocks.ensure).not.toHaveBeenCalled()
  first()
  expect(mocks.subscribe.mock.results[0].value).not.toHaveBeenCalled()
  second()
  expect(mocks.subscribe.mock.results[0].value).toHaveBeenCalledOnce()
})

test('merges Python events into pending list results without losing the Node card', async () => {
  const pending = held<ExecutionEnvironmentStatus[]>()
  mocks.list.mockReturnValue(pending.promise)
  const resource = createExecutionEnvironmentResource()
  const stop = resource.subscribe(vi.fn())
  emit({ ...python, state: 'downloading', phase: 'install' })
  expect(resource.getSnapshot().environments).toEqual([
    { ...python, state: 'downloading', phase: 'install' },
  ])
  pending.resolve([node, python])
  await settle()
  expect(resource.getSnapshot().environments).toEqual([
    node,
    { ...python, state: 'downloading', phase: 'install' },
  ])
  expect(resource.getSnapshot().loading).toBe(false)
  stop()
})

test('an initial read completed during preparation cannot suppress the installation receipt', async () => {
  const pending = held<ExecutionEnvironmentStatus[]>()
  const installation = held<ExecutionEnvironmentStatus>()
  mocks.list.mockReturnValue(pending.promise)
  mocks.ensure.mockReturnValue(installation.promise)
  const resource = createExecutionEnvironmentResource()
  const stop = resource.subscribe(vi.fn())
  const preparation = resource.preparePython()
  pending.resolve([node, python])
  await settle()
  installation.resolve({ ...python, state: 'installed' })
  await preparation
  expect(resource.getSnapshot().environments.find(item => item.id === 'python')?.state).toBe(
    'installed'
  )
  stop()
})

test('newer host events outrank both a retry receipt and a retry failure', async () => {
  const installation = held<ExecutionEnvironmentStatus>()
  mocks.ensure.mockReturnValue(installation.promise)
  const resource = createExecutionEnvironmentResource()
  const stop = resource.subscribe(vi.fn())
  await settle()
  const preparation = resource.preparePython()
  emit({ ...python, state: 'error', error: 'new failure' })
  installation.resolve({ ...python, state: 'installed' })
  await preparation
  expect(resource.getSnapshot().environments.find(item => item.id === 'python')?.error).toBe(
    'new failure'
  )
  const retry = held<ExecutionEnvironmentStatus>()
  mocks.ensure.mockReturnValue(retry.promise)
  const retried = resource.preparePython()
  emit({ ...python, state: 'downloading', phase: 'verify' })
  retry.reject(new Error('old transport failure'))
  await expect(retried).rejects.toThrow('old transport failure')
  expect(resource.getSnapshot().environments.find(item => item.id === 'python')?.state).toBe(
    'downloading'
  )
  stop()
})

test('deduplicates accepted preparations across consumer remounts and ignores old receipts', async () => {
  const installation = held<ExecutionEnvironmentStatus>()
  mocks.ensure.mockReturnValue(installation.promise)
  const resource = createExecutionEnvironmentResource()
  const stop = resource.subscribe(vi.fn())
  await settle()
  const first = resource.preparePython()
  const same = resource.preparePython()
  expect(first).toBe(same)
  stop()
  const again = resource.subscribe(vi.fn())
  await settle()
  const remounted = resource.preparePython()
  expect(remounted).toBe(first)
  expect(mocks.ensure).toHaveBeenCalledOnce()
  emit({ ...python, state: 'error', error: 'current failure' }, 1)
  installation.resolve({ ...python, state: 'installed' })
  await first
  expect(resource.getSnapshot().preparingPython).toBe(false)
  expect(resource.getSnapshot().environments.find(item => item.id === 'python')?.error).toBe(
    'current failure'
  )
  again()
})

test('retains good data on refresh failure and can explicitly recover', async () => {
  const resource = createExecutionEnvironmentResource()
  const stop = resource.subscribe(vi.fn())
  await settle()
  mocks.list.mockRejectedValueOnce(new Error('offline'))
  await resource.reload()
  expect(resource.getSnapshot().environments).toEqual([node, python])
  expect(resource.getSnapshot().error).toEqual(new Error('offline'))
  await resource.reload()
  expect(resource.getSnapshot().error).toBeUndefined()
  stop()
})

test('a failed preparation is observable and a later retry can succeed', async () => {
  const resource = createExecutionEnvironmentResource()
  const stop = resource.subscribe(vi.fn())
  await settle()
  mocks.ensure
    .mockRejectedValueOnce(new Error('download failed'))
    .mockResolvedValueOnce({ ...python, state: 'installed' })
  await expect(resource.preparePython()).rejects.toThrow('download failed')
  expect(resource.getSnapshot().environments.find(item => item.id === 'python')?.state).toBe(
    'error'
  )
  expect(resource.getSnapshot().preparingPython).toBe(false)
  await resource.preparePython()
  expect(resource.getSnapshot().environments.find(item => item.id === 'python')?.state).toBe(
    'installed'
  )
  stop()
})

test('opening settings refreshes an already visible notice but shares its pending read', async () => {
  const resource = createExecutionEnvironmentResource()
  const notice = resource.subscribe(vi.fn())
  const settings = resource.subscribeSettings(vi.fn())
  await settle()
  expect(mocks.list).toHaveBeenCalledOnce()
  settings()
  const reopened = resource.subscribeSettings(vi.fn())
  await settle()
  expect(mocks.list).toHaveBeenCalledTimes(2)
  notice()
  reopened()
})

test('old reads, events and page refresh requests cannot affect a new connection', async () => {
  const oldRead = held<ExecutionEnvironmentStatus[]>()
  mocks.list.mockReturnValueOnce(oldRead.promise)
  const resource = createExecutionEnvironmentResource()
  const first = resource.subscribe(vi.fn())
  const oldScope = resource.getSnapshot().scope
  first()
  const second = resource.subscribe(vi.fn())
  await settle()
  emit({ ...python, state: 'downloading', phase: 'install' }, 1)
  emit({ ...python, state: 'error', error: 'detached' })
  oldRead.resolve([{ ...python, state: 'error', error: 'old read' }])
  await settle()
  await resource.reload(oldScope)
  expect(mocks.list).toHaveBeenCalledTimes(2)
  expect(resource.getSnapshot().environments.find(item => item.id === 'python')?.state).toBe(
    'downloading'
  )
  second()
})
