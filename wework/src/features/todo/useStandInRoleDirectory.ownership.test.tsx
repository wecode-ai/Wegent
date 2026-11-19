import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import {
  newStandInRole,
  publishPersonalStandIn,
  type PersonalStandInSettings,
} from '@/api/personalStandIn'
import type { StandInExecutorApi } from '@/api/standIn'
import { standInProfile as profile } from './personalStandInSettings.testFixtures'
import { useStandInRoleDirectory } from './useStandInRoleDirectory'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}
function source() {
  const read = vi.fn<StandInExecutorApi['personalGet']>(async (_user, device) =>
    profile(device, [])
  )
  return { read, api: { personalGet: read } as unknown as StandInExecutorApi }
}
const namedRole = (device: string, id = 'review') => ({
  ...newStandInRole(device, id),
  name: `${device} ${id}`,
})

test('performs no reads for an inactive directory and refreshes when reactivated', async () => {
  const { api, read } = source()
  const { result, rerender } = renderHook(
    ({ active }) => useStandInRoleDirectory(api, 7, 'mac', active),
    { initialProps: { active: false } }
  )
  expect(result.current).toBeUndefined()
  expect(read).not.toHaveBeenCalled()
  act(() => publishPersonalStandIn(profile('mac', [])))
  expect(read).not.toHaveBeenCalled()
  rerender({ active: true })
  await waitFor(() => expect(result.current?.roles).toEqual([]))
  rerender({ active: false })
  const role = namedRole('mac')
  read.mockResolvedValue(profile('mac', [role]))
  act(() => publishPersonalStandIn(profile('mac', [role])))
  expect(read).toHaveBeenCalledTimes(1)
  rerender({ active: true })
  await waitFor(() => expect(result.current?.roles).toEqual([{ role, deviceId: 'mac' }]))
  expect(read).toHaveBeenCalledTimes(2)
})

test('keeps same-owner results visible while explicitly reopening the workspace', async () => {
  const { api, read } = source()
  const role = namedRole('mac')
  read.mockResolvedValue(profile('mac', [role]))
  const { result, rerender } = renderHook(
    ({ entry }) => useStandInRoleDirectory(api, 7, 'mac', true, undefined, entry),
    { initialProps: { entry: 0 } }
  )
  await waitFor(() => expect(result.current?.roles).toHaveLength(1))
  const pending = deferred<PersonalStandInSettings>()
  read.mockReturnValueOnce(pending.promise)
  rerender({ entry: 1 })
  expect(result.current?.roles).toHaveLength(1)
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
  await act(async () => pending.resolve(profile('mac', [])))
  expect(result.current?.roles).toEqual([])
})

test('deduplicates devices and ignores order-only inventory changes', async () => {
  const { api, read } = source()
  const { result, rerender } = renderHook(
    ({ devices }) => useStandInRoleDirectory(api, 7, 'mac', true, 'mac', 0, devices),
    { initialProps: { devices: ['remote', 'mac', 'remote'] } }
  )
  await waitFor(() => expect(result.current?.roles).toEqual([]))
  expect(read).toHaveBeenCalledTimes(2)
  rerender({ devices: ['mac', 'remote'] })
  expect(read).toHaveBeenCalledTimes(2)
})

test('keeps cached roles during an inventory refresh and discovers newly added devices', async () => {
  const { api, read } = source()
  const macRole = namedRole('mac')
  read.mockResolvedValue(profile('mac', [macRole]))
  const { result, rerender } = renderHook(
    ({ devices }) => useStandInRoleDirectory(api, 7, 'mac', true, undefined, 0, devices),
    { initialProps: { devices: [] as string[] } }
  )
  await waitFor(() => expect(result.current?.roles).toHaveLength(1))
  const mac = deferred<PersonalStandInSettings>(),
    remote = deferred<PersonalStandInSettings>()
  read.mockImplementation((_user, device) => (device === 'mac' ? mac.promise : remote.promise))
  rerender({ devices: ['remote'] })
  expect(result.current?.roles[0].role).toEqual(macRole)
  const remoteRole = namedRole('remote')
  await act(async () => {
    mac.resolve(profile('mac', [macRole]))
    remote.resolve(profile('remote', [remoteRole]))
  })
  expect(result.current?.roles).toEqual(
    expect.arrayContaining([
      { role: macRole, deviceId: 'mac' },
      { role: remoteRole, deviceId: 'remote' },
    ])
  )
})

test('retains known same-owner roles if all refresh requests fail and recovers on reopening', async () => {
  const { api, read } = source()
  const role = namedRole('mac')
  read.mockResolvedValue(profile('mac', [role]))
  const { result, rerender } = renderHook(
    ({ entry }) => useStandInRoleDirectory(api, 7, 'mac', true, undefined, entry),
    { initialProps: { entry: 0 } }
  )
  await waitFor(() => expect(result.current?.roles).toHaveLength(1))
  read.mockRejectedValueOnce(new Error('Device offline'))
  rerender({ entry: 1 })
  await waitFor(() => expect(result.current?.error).toBeTruthy())
  expect(result.current?.roles).toEqual([{ role, deviceId: 'mac' }])
  read.mockResolvedValue(profile('mac', []))
  rerender({ entry: 2 })
  await waitFor(() => expect(result.current?.roles).toEqual([]))
  expect(result.current?.error).toBeUndefined()
})

test('hides previous API data immediately and ignores its late refresh even for identical account fields', async () => {
  const old = source(),
    current = source()
  const role = namedRole('mac')
  old.read.mockResolvedValue(profile('mac', [role]))
  const { result, rerender } = renderHook(
    ({ api, entry }) => useStandInRoleDirectory(api, 7, 'mac', true, undefined, entry),
    { initialProps: { api: old.api, entry: 0 } }
  )
  await waitFor(() => expect(result.current?.roles).toHaveLength(1))
  const pending = deferred<PersonalStandInSettings>()
  old.read.mockReturnValueOnce(pending.promise)
  rerender({ api: old.api, entry: 1 })
  const next = deferred<PersonalStandInSettings>()
  current.read.mockReturnValue(next.promise)
  rerender({ api: current.api, entry: 1 })
  expect(result.current).toBeUndefined()
  await act(async () => next.resolve(profile('mac', [])))
  await act(async () => pending.resolve(profile('mac', [role])))
  expect(result.current?.roles).toEqual([])
})

test('never follows moved roles from a response that finishes after the directory closes', async () => {
  const { api, read } = source()
  const pending = deferred<PersonalStandInSettings>()
  read.mockReturnValueOnce(pending.promise)
  const { rerender } = renderHook(({ active }) => useStandInRoleDirectory(api, 7, 'mac', active), {
    initialProps: { active: true },
  })
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1))
  rerender({ active: false })
  await act(async () => pending.resolve(profile('mac', [namedRole('remote')])))
  expect(read).toHaveBeenCalledTimes(1)
})

test('ignores other account notifications and detaches native notifications on unmount', async () => {
  const { api, read } = source()
  const { result, unmount } = renderHook(() => useStandInRoleDirectory(api, 7, 'mac', true))
  await waitFor(() => expect(result.current?.roles).toEqual([]))
  act(() => publishPersonalStandIn({ ...profile('mac', []), userId: 8 }))
  expect(read).toHaveBeenCalledTimes(1)
  act(() => publishPersonalStandIn(profile('mac', [])))
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
  unmount()
  act(() => publishPersonalStandIn(profile('mac', [])))
  expect(read).toHaveBeenCalledTimes(2)
})

test('requests each discovered target once even when many forwarding records point to it', async () => {
  const { api, read } = source()
  const roles = ['one', 'two', 'three'].map(id => namedRole('remote', id))
  read.mockImplementation(async (_user, device) => profile(device, roles))
  const { result } = renderHook(() => useStandInRoleDirectory(api, 7, 'mac', true))
  await waitFor(() => expect(result.current?.roles).toHaveLength(3))
  await waitFor(() =>
    expect(read.mock.calls.filter(([, device]) => device === 'remote')).toHaveLength(1)
  )
  expect(read).toHaveBeenCalledTimes(2)
})

test('bounds discovery concurrency at four without blocking progress from ready devices', async () => {
  const { api, read } = source()
  const pending = new Map(
    Array.from({ length: 6 }, (_, i) => [String(i), deferred<PersonalStandInSettings>()])
  )
  read.mockImplementation((_user, device) => pending.get(device)!.promise)
  const { result } = renderHook(() =>
    useStandInRoleDirectory(api, 7, '0', true, undefined, 0, ['1', '2', '3', '4', '5'])
  )
  await waitFor(() => expect(read).toHaveBeenCalledTimes(4))
  await act(async () => pending.get('1')!.resolve(profile('1', [namedRole('1')])))
  expect(result.current?.roles).toHaveLength(1)
  expect(read).toHaveBeenCalledTimes(4)
  await act(async () => {
    for (const device of ['0', '2', '3']) pending.get(device)!.resolve(profile(device, []))
  })
  await waitFor(() => expect(read).toHaveBeenCalledTimes(6))
  await act(async () => {
    for (const device of ['4', '5']) pending.get(device)!.resolve(profile(device, []))
  })
  expect(result.current?.roles).toHaveLength(1)
})
