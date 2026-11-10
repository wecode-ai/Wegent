import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import {
  newStandInRole,
  publishPersonalStandIn,
  type PersonalStandInSettings,
} from '@/api/personalStandIn'
import type { StandInExecutorApi } from '@/api/standIn'
import { useStandInRoleDirectory } from './useStandInRoleDirectory'

const profile = (
  device: string,
  roles: PersonalStandInSettings['roles']
): PersonalStandInSettings => ({
  userId: 7,
  executionDeviceId: device,
  version: 1,
  roles,
})

it('keeps local roles available while the primary device is still loading', async () => {
  let release!: (value: PersonalStandInSettings) => void
  const pending = new Promise<PersonalStandInSettings>(resolve => {
    release = resolve
  })
  const role = { ...newStandInRole('mac', 'review'), name: 'Local review' }
  const api = {
    personalGet: vi.fn(async (_user, device) =>
      device === 'cloud' ? pending : profile('mac', [role])
    ),
  } as unknown as StandInExecutorApi
  const { result } = renderHook(() => useStandInRoleDirectory(api, 7, 'cloud', true, 'mac'))
  await waitFor(() => expect(result.current?.roles[0].role.name).toBe('Local review'))
  await act(async () => release(profile('cloud', [])))
  expect(result.current?.roles).toHaveLength(1)
})

it('follows role moves and retains separately configured roles with the same legacy id', async () => {
  const migrationSource = JSON.stringify(['mac', 7, 'review'])
  const original = { ...newStandInRole('remote', 'review'), name: 'Old', migrationSource }
  const moved = { ...original, name: 'Current', previousExecutionDevices: ['mac'] }
  const profiles = new Map([
    [
      'mac',
      profile('mac', [original, { ...newStandInRole('mac', 'default'), name: 'Mac default' }]),
    ],
    [
      'remote',
      profile('remote', [
        moved,
        { ...newStandInRole('remote', 'default'), name: 'Remote default' },
      ]),
    ],
  ])
  const api = {
    personalGet: vi.fn(async (_user, device: string) => profiles.get(device)),
  } as unknown as StandInExecutorApi
  const { result } = renderHook(() => useStandInRoleDirectory(api, 7, 'mac', true))
  await waitFor(() =>
    expect(result.current?.roles.map(entry => entry.role.name)).toContain('Current')
  )
  expect(result.current?.roles).toHaveLength(3)
  expect(result.current?.roles.filter(entry => entry.role.id === 'review')).toHaveLength(1)
})

it('hides the previous account immediately and ignores its late reads', async () => {
  let release!: (value: PersonalStandInSettings) => void
  const pending = new Promise<PersonalStandInSettings>(resolve => {
    release = resolve
  })
  const api = {
    personalGet: vi.fn(async (user: number) =>
      user === 7 ? pending : { ...profile('mac', []), userId: user }
    ),
  } as unknown as StandInExecutorApi
  const { result, rerender } = renderHook(
    ({ user }) => useStandInRoleDirectory(api, user, 'mac', true),
    { initialProps: { user: 7 } }
  )
  rerender({ user: 8 })
  await waitFor(() => expect(result.current?.roles).toEqual([]))
  await act(async () =>
    release(profile('mac', [{ ...newStandInRole('mac', 'private'), name: 'Private' }]))
  )
  expect(result.current?.roles).toEqual([])
})

it('removes the final moved role after deletion instead of restoring its source forwarding record', async () => {
  const role = {
    ...newStandInRole('remote', 'review'),
    name: 'Review',
    migrationSource: JSON.stringify(['mac', 7, 'review']),
  }
  const source = profile('mac', [role])
  let target = profile('remote', [role])
  const api = {
    personalGet: vi.fn(async (_user, device) => (device === 'mac' ? source : target)),
  } as unknown as StandInExecutorApi
  const { result } = renderHook(() => useStandInRoleDirectory(api, 7, 'mac', true))
  await waitFor(() => expect(result.current?.roles).toHaveLength(1))
  await act(async () => {
    target = profile('remote', [])
    publishPersonalStandIn(target)
  })
  await waitFor(() => expect(result.current?.roles).toEqual([]))
})

it('ignores a late forwarding record when its target already confirmed deletion', async () => {
  let release!: (value: PersonalStandInSettings) => void
  const pending = new Promise<PersonalStandInSettings>(resolve => {
    release = resolve
  })
  const api = {
    personalGet: vi.fn(async (_user, device) =>
      device === 'remote' ? profile('remote', []) : pending
    ),
  } as unknown as StandInExecutorApi
  const { result } = renderHook(() => useStandInRoleDirectory(api, 7, 'remote', true, 'mac'))
  await waitFor(() => expect(result.current?.roles).toEqual([]))
  await act(async () =>
    release(profile('mac', [{ ...newStandInRole('remote', 'review'), name: 'Deleted role' }]))
  )
  expect(result.current?.roles).toEqual([])
})
