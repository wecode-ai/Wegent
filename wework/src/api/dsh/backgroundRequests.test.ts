import { executorRequestPriority, scheduleDshRequest } from './backgroundRequests'
import { createTestWebLocks } from '@/test/web-locks'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => (resolve = done))
  return { promise, resolve }
}

test('two stalled background requests leave foreground work independent across clients', async () => {
  const locks = createTestWebLocks()
  const first = deferred()
  const second = deferred()
  const entered = vi.fn()
  const run = (hold: Promise<void>) =>
    scheduleDshRequest(
      'background',
      async () => {
        entered()
        await hold
      },
      undefined,
      locks
    )
  const pending = [run(first.promise), run(second.promise), run(Promise.resolve())]
  await vi.waitFor(() => expect(entered).toHaveBeenCalledTimes(2))
  await expect(
    scheduleDshRequest('foreground', async () => 'uploaded', undefined, locks)
  ).resolves.toBe('uploaded')
  for (const command of [
    'git_add_all',
    'git_commit',
    'git_push',
    'git_checkout',
    'git_checkout_new',
    'git_apply_patch',
    'git_worktree_remove',
    'git_future_action',
  ]) {
    const priority = executorRequestPriority('device.execute_command', { command_key: command })
    expect(priority).toBe('foreground')
    await expect(scheduleDshRequest(priority, async () => command, undefined, locks)).resolves.toBe(
      command
    )
  }
  expect(
    executorRequestPriority('device.execute_command', { command_key: 'git_status_porcelain' })
  ).toBe('background')
  second.resolve()
  await vi.waitFor(() => expect(entered).toHaveBeenCalledTimes(3))
  first.resolve()
  await Promise.all(pending)
})

test('passive MCP App discovery uses background capacity', () => {
  expect(executorRequestPriority('runtime.mcp_apps.request', { callId: 'call' })).toBe('background')
  expect(
    executorRequestPriority('runtime.mcp_apps.request', { callId: 'call', method: 'discover' })
  ).toBe('background')
  expect(
    executorRequestPriority('runtime.mcp_apps.request', { callId: 'call', method: 'initialize' })
  ).toBe('foreground')
  expect(
    executorRequestPriority('runtime.mcp_apps.request', {
      callId: 'call',
      method: 'tools/call',
    })
  ).toBe('foreground')
})

test('queued cancellation never dispatches and failures release capacity', async () => {
  const locks = createTestWebLocks()
  const hold = deferred()
  const pending = [0, 1].map(() =>
    scheduleDshRequest('background', () => hold.promise, undefined, locks)
  )
  const abort = new AbortController()
  const dispatch = vi.fn()
  const cancelled = scheduleDshRequest('background', dispatch, abort.signal, locks)
  const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
  abort.abort()
  await rejected
  expect(dispatch).not.toHaveBeenCalled()
  hold.resolve()
  await Promise.all(pending)
  await expect(
    scheduleDshRequest(
      'background',
      async () => {
        throw new Error('offline')
      },
      undefined,
      locks
    )
  ).rejects.toThrow('offline')
  await expect(
    scheduleDshRequest('background', async () => 'recovered', undefined, locks)
  ).resolves.toBe('recovered')
})
