import { expect, test, vi } from 'vitest'
import type { RuntimeWorktreeSettings } from '@/types/api'
import { createWorktreeSettingsResource } from './worktreeSettingsResource'

function held<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
const settings: RuntimeWorktreeSettings = {
  deviceId: 'device-a',
  worktreeRoot: '',
  resolvedWorktreeRoot: '/worktrees',
  autoCleanupEnabled: true,
  keepCount: 15,
}
function setup() {
  const read = vi.fn().mockResolvedValue(settings)
  const list = vi.fn().mockResolvedValue({ success: true, deviceId: 'device-a', items: [] })
  const write = vi.fn().mockResolvedValue(settings)
  const api = {
    getWorktreeSettings: read,
    listWorktrees: list,
    updateWorktreeSettings: write,
  } as unknown as Parameters<typeof createWorktreeSettingsResource>[0]
  const source = createWorktreeSettingsResource(api, 'device-a')!
  const settingsStop = source.settings.subscribe(vi.fn())
  const listStop = source.items.subscribe(vi.fn())
  const stop = () => {
    settingsStop()
    listStop()
  }
  return { source, read, list, write, stop }
}

test('serializes distinct accepted patches and coalesces repeated submissions', async () => {
  const { source, write, stop } = setup()
  const first = held<RuntimeWorktreeSettings>()
  write
    .mockReturnValueOnce(first.promise)
    .mockResolvedValueOnce({ ...settings, worktreeRoot: '/saved', keepCount: 20 })
  const root = source.updateSettings({ worktreeRoot: '/saved' })
  expect(source.updateSettings({ worktreeRoot: '/saved' })).toBe(root)
  const count = source.updateSettings({ keepCount: 20 })
  await vi.waitFor(() => expect(write).toHaveBeenCalledOnce())
  expect(write).toHaveBeenCalledWith({ deviceId: 'device-a', worktreeRoot: '/saved' })
  first.resolve({ ...settings, worktreeRoot: '/saved' })
  await root
  await count
  expect(write).toHaveBeenLastCalledWith({ deviceId: 'device-a', keepCount: 20 })
  expect(source.settings.getSnapshot().data).toMatchObject({
    worktreeRoot: '/saved',
    keepCount: 20,
  })
  expect(source.hasPendingSettings()).toBe(false)
  stop()
})

test('a failed write does not poison a later queued patch', async () => {
  const { source, write, stop } = setup()
  const first = held<RuntimeWorktreeSettings>()
  write.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ ...settings, keepCount: 20 })
  const failed = expect(source.updateSettings({ worktreeRoot: '/denied' })).rejects.toThrow(
    'denied'
  )
  const next = source.updateSettings({ keepCount: 20 })
  first.reject(new Error('denied'))
  await failed
  await next
  expect(source.settings.getSnapshot().data).toMatchObject({ worktreeRoot: '', keepCount: 20 })
  expect(source.hasPendingSettings()).toBe(false)
  stop()
})

test('the saved receipt supersedes a slower settings read', async () => {
  const { source, read, write, stop } = setup()
  const stale = held<RuntimeWorktreeSettings>()
  read.mockReturnValueOnce(stale.promise)
  const refresh = source.settings.reload()
  write.mockResolvedValue({ ...settings, worktreeRoot: '/saved' })
  await source.updateSettings({ worktreeRoot: '/saved' })
  stale.resolve(settings)
  await refresh
  expect(source.settings.getSnapshot().data?.worktreeRoot).toBe('/saved')
  stop()
})

test('accepted queued writes finish after detach without republishing detached state', async () => {
  const { source, write, stop } = setup()
  const first = held<RuntimeWorktreeSettings>()
  write.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ ...settings, keepCount: 21 })
  const root = source.updateSettings({ worktreeRoot: '/saved' })
  const count = source.updateSettings({ keepCount: 21 })
  await vi.waitFor(() => expect(write).toHaveBeenCalledOnce())
  stop()
  const before = source.settings.getSnapshot()
  first.resolve({ ...settings, worktreeRoot: '/saved' })
  await Promise.all([root, count])
  expect(write).toHaveBeenCalledTimes(2)
  expect(source.settings.getSnapshot()).toBe(before)
  expect(source.hasPendingSettings()).toBe(false)
})

test('an intervening different patch keeps a later repeated value as a distinct user intent', async () => {
  const { source, write, stop } = setup()
  write.mockImplementation(async patch => ({ ...settings, worktreeRoot: patch.worktreeRoot }))
  const first = source.updateSettings({ worktreeRoot: '/a' })
  const second = source.updateSettings({ worktreeRoot: '/b' })
  const third = source.updateSettings({ worktreeRoot: '/a' })
  expect(third).not.toBe(first)
  await Promise.all([first, second, third])
  expect(write.mock.calls.map(call => call[0].worktreeRoot)).toEqual(['/a', '/b', '/a'])
  expect(source.settings.getSnapshot().data?.worktreeRoot).toBe('/a')
  stop()
})
