import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { describeDshExecutor } from '@/api/dsh/executorTransport'
import { ensureLocalExecutorAvailable, resetLocalExecutorStateForTests } from './localExecutor'

vi.mock('@/api/dsh/executorTransport', async importOriginal => ({
  ...(await importOriginal<typeof import('@/api/dsh/executorTransport')>()),
  describeDshExecutor: vi.fn(),
}))

const describeExecutor = vi.mocked(describeDshExecutor)
const description = {
  protocol_version: 1,
  device_id: 'local-device',
  runtime_instance_id: 'local-runtime',
  capabilities: [],
  renderer_methods: [],
  transports: [],
}

beforeEach(() => {
  resetLocalExecutorStateForTests()
  describeExecutor.mockReset()
})

afterEach(() => resetLocalExecutorStateForTests())

test('shares concurrent fresh identity reads but revalidates after they settle', async () => {
  describeExecutor.mockResolvedValue(description)
  await ensureLocalExecutorAvailable()
  describeExecutor.mockClear()
  let finish!: (value: typeof description) => void
  describeExecutor.mockReturnValue(new Promise(resolve => (finish = resolve)))

  const first = ensureLocalExecutorAvailable({ refresh: true })
  const second = ensureLocalExecutorAvailable({ refresh: true })
  await Promise.resolve()
  const requests = describeExecutor.mock.calls.length
  finish({ ...description, runtime_instance_id: 'replacement-runtime' })
  const results = await Promise.allSettled([first, second])

  expect(requests).toBe(1)
  expect(results).toEqual([
    {
      status: 'fulfilled',
      value: expect.objectContaining({ runtimeInstanceId: 'replacement-runtime' }),
    },
    {
      status: 'fulfilled',
      value: expect.objectContaining({ runtimeInstanceId: 'replacement-runtime' }),
    },
  ])
  describeExecutor.mockResolvedValue({ ...description, runtime_instance_id: 'next-runtime' })
  await expect(ensureLocalExecutorAvailable({ refresh: true })).resolves.toMatchObject({
    runtimeInstanceId: 'next-runtime',
  })
  expect(describeExecutor).toHaveBeenCalledTimes(2)
})

test('shares a failed fresh read and performs a new read on recovery', async () => {
  let fail!: (error: Error) => void
  describeExecutor.mockReturnValue(new Promise((_, reject) => (fail = reject)))
  const first = ensureLocalExecutorAvailable({ refresh: true })
  const second = ensureLocalExecutorAvailable({ refresh: true })
  await Promise.resolve()
  const requests = describeExecutor.mock.calls.length
  const results = Promise.allSettled([first, second])
  fail(new Error('Executor unavailable'))
  expect(await results).toEqual([
    { status: 'rejected', reason: new Error('Executor unavailable') },
    { status: 'rejected', reason: new Error('Executor unavailable') },
  ])
  expect(requests).toBe(1)

  describeExecutor.mockResolvedValue(description)
  await expect(ensureLocalExecutorAvailable({ refresh: true })).resolves.toMatchObject({
    deviceId: 'local-device',
  })
  expect(describeExecutor).toHaveBeenCalledTimes(2)
})

test('does not reuse an already dispatched description for a later fresh identity check', async () => {
  describeExecutor.mockResolvedValue(description)
  await ensureLocalExecutorAvailable()
  describeExecutor.mockClear()
  let finish!: (value: typeof description) => void
  describeExecutor
    .mockReturnValueOnce(new Promise(resolve => (finish = resolve)))
    .mockResolvedValueOnce({ ...description, runtime_instance_id: 'replacement-runtime' })
  const earlier = ensureLocalExecutorAvailable({ refresh: true })
  await Promise.resolve()

  const later = ensureLocalExecutorAvailable({ refresh: true })
  await expect(later).resolves.toMatchObject({ runtimeInstanceId: 'replacement-runtime' })
  expect(describeExecutor).toHaveBeenCalledTimes(2)
  const rejected = expect(earlier).rejects.toMatchObject({ code: 'protocol_mismatch' })
  finish(description)
  await rejected
})
