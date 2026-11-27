import type { PersonalStandInSettings } from '@/api/personalStandIn'
import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { personalStandInFixture as fixture } from './personalStandInSettings.testFixtures'
import { usePersonalStandIn } from './usePersonalStandIn'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

test('keeps a dirty draft when an unrelated services wrapper changes', async () => {
  const { services, personalGet } = fixture()
  const { result, rerender } = renderHook(({ value }) => usePersonalStandIn(value, 7), {
    initialProps: { value: services },
  })
  await waitFor(() => expect(result.current.loading).toBe(false))
  const reload = result.current.reload
  act(() => result.current.updateRole('default', role => ({ ...role, prompt: 'Unsaved' })))
  rerender({ value: { ...services } })
  expect(result.current.draft?.roles[0].prompt).toBe('Unsaved')
  expect(personalGet).toHaveBeenCalledTimes(1)
  expect(result.current.reload).toBe(reload)
})

test('hides old account settings immediately and ignores its late read', async () => {
  const { services, personalGet, settings } = fixture()
  const pending = deferred<PersonalStandInSettings>()
  personalGet.mockReturnValueOnce(pending.promise).mockResolvedValue({ ...settings, userId: 8 })
  const { result, rerender } = renderHook(
    ({ user }) => usePersonalStandIn(services, user, 'device', 'mac'),
    { initialProps: { user: 7 } }
  )
  await waitFor(() => expect(personalGet).toHaveBeenCalledTimes(1))
  rerender({ user: 8 })
  expect(result.current.saved).toBeNull()
  expect(result.current.draft).toBeNull()
  await waitFor(() => expect(result.current.saved?.userId).toBe(8))
  await act(async () => pending.resolve(settings))
  expect(result.current.saved?.userId).toBe(8)
})

test('stops a detached identity read before issuing a profile request', async () => {
  const { services, personalGet } = fixture()
  const pending = deferred<{ deviceId: string }>()
  vi.mocked(services.getLocalRuntimeSidebarIdentity!).mockReturnValue(pending.promise)
  const { unmount } = renderHook(() => usePersonalStandIn(services, 7))
  await waitFor(() => expect(services.getLocalRuntimeSidebarIdentity).toHaveBeenCalledTimes(1))
  unmount()
  await act(async () => pending.resolve({ deviceId: 'mac' }))
  expect(personalGet).not.toHaveBeenCalled()
})

test('replaces the draft on an explicit successful reload', async () => {
  const { services, settings, personalGet } = fixture()
  const { result } = renderHook(() => usePersonalStandIn(services, 7, 'device', 'mac'))
  await waitFor(() => expect(result.current.loading).toBe(false))
  act(() => result.current.updateRole('default', role => ({ ...role, prompt: 'Discard me' })))
  personalGet.mockResolvedValue({ ...settings, version: 2 })
  act(() => result.current.reload())
  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(result.current.saved?.version).toBe(2)
  expect(result.current.draft).toBe(result.current.saved)
})

test('retains drafts through a failed reload and allows a subsequent retry', async () => {
  const { services, settings, personalGet } = fixture()
  const { result } = renderHook(() => usePersonalStandIn(services, 7, 'device', 'mac'))
  await waitFor(() => expect(result.current.loading).toBe(false))
  act(() => result.current.updateRole('default', role => ({ ...role, prompt: 'Keep me' })))
  personalGet.mockRejectedValueOnce(new Error('Device offline'))
  act(() => result.current.reload())
  await waitFor(() => expect(result.current.error).toBeTruthy())
  expect(result.current.draft?.roles[0].prompt).toBe('Keep me')
  expect(result.current.saved).toEqual(settings)
  personalGet.mockResolvedValue({ ...settings, version: 2 })
  act(() => result.current.reload())
  await waitFor(() => expect(result.current.saved?.version).toBe(2))
  expect(result.current.error).toBeNull()
})

test('does not discard an edit made after a reload was requested', async () => {
  const { services, settings, personalGet } = fixture()
  const { result } = renderHook(() => usePersonalStandIn(services, 7, 'device', 'mac'))
  await waitFor(() => expect(result.current.loading).toBe(false))
  const pending = deferred<PersonalStandInSettings>()
  personalGet.mockReturnValueOnce(pending.promise)
  act(() => result.current.reload())
  act(() => result.current.updateRole('default', role => ({ ...role, prompt: 'Newer draft' })))
  await act(async () => pending.resolve({ ...settings, version: 2 }))
  expect(result.current.draft?.roles[0].prompt).toBe('Newer draft')
  expect(result.current.saved?.version).toBe(2)
})

test('retains a newer draft through save completion and keeps the conflict token intact', async () => {
  const { services, personalSave, settings } = fixture()
  const pending = deferred<PersonalStandInSettings>()
  personalSave.mockReturnValueOnce(pending.promise)
  const { result } = renderHook(() => usePersonalStandIn(services, 7, 'device', 'mac'))
  await waitFor(() => expect(result.current.loading).toBe(false))
  act(() => result.current.updateRole('default', role => ({ ...role, prompt: 'Submitted' })))
  let saved!: Promise<PersonalStandInSettings | null>
  act(() => {
    saved = result.current.save()
  })
  act(() => result.current.updateRole('default', role => ({ ...role, prompt: 'Newer' })))
  const receipt = { ...settings, version: 2 }
  await act(async () => {
    pending.resolve(receipt)
    await saved
  })
  expect(result.current.saved).toEqual(receipt)
  expect(result.current.draft?.roles[0].prompt).toBe('Newer')
  expect(result.current.draft?.version).toBe(1)
  expect(result.current.saving).toBe(false)
})

test('publishes the canonical receipt when the saved draft has not changed', async () => {
  const { services, personalSave, settings } = fixture()
  const receipt = {
    ...settings,
    version: 2,
    roles: settings.roles.map(role => ({ ...role, prompt: 'Canonical' })),
  }
  personalSave.mockResolvedValue(receipt)
  const { result } = renderHook(() => usePersonalStandIn(services, 7, 'device', 'mac'))
  await waitFor(() => expect(result.current.loading).toBe(false))
  await act(async () => {
    expect(await result.current.save()).toEqual(receipt)
  })
  expect(result.current.draft).toBe(result.current.saved)
  expect(result.current.draft?.roles[0].prompt).toBe('Canonical')
})

test('creates a role alongside changes committed to the profile after opening the editor', async () => {
  const { services, personalGet, personalSave, settings } = fixture()
  const { result } = renderHook(() => usePersonalStandIn(services, 7, 'old-device', 'mac'))
  await waitFor(() => expect(result.current.loading).toBe(false))
  const added = { ...settings.roles[0], id: 'new-role', name: 'Reviewer' }
  const latest = {
    ...settings,
    version: 2,
    roles: [{ ...settings.roles[0], prompt: 'Updated on another surface' }],
  }
  personalGet.mockResolvedValueOnce(latest)
  const change = { kind: 'create', roleId: added.id } as const
  await act(() => result.current.save({ ...settings, roles: [...settings.roles, added] }, change))

  expect(personalSave).toHaveBeenCalledExactlyOnceWith(
    7,
    { ...latest, roles: [...latest.roles, added] },
    'old-device',
    undefined,
    change
  )
})

test('accepts only one save when called twice before React rerenders', async () => {
  const { services, personalSave, settings } = fixture()
  const pending = deferred<PersonalStandInSettings>()
  personalSave.mockReturnValueOnce(pending.promise)
  const { result } = renderHook(() => usePersonalStandIn(services, 7, 'device', 'mac'))
  await waitFor(() => expect(result.current.loading).toBe(false))
  let first!: Promise<PersonalStandInSettings | null>,
    second!: Promise<PersonalStandInSettings | null>
  act(() => {
    first = result.current.save()
    second = result.current.save()
  })
  expect(personalSave).toHaveBeenCalledTimes(1)
  await act(async () => {
    expect(await second).toBeNull()
    pending.resolve(settings)
    await first
  })
})

test.each(['success', 'failure'] as const)(
  'isolates an accepted old-device save after switching devices: %s',
  async outcome => {
    const { services, personalSave, personalGet, settings } = fixture()
    const pending = deferred<PersonalStandInSettings>()
    personalSave.mockReturnValueOnce(pending.promise)
    const { result } = renderHook(() => usePersonalStandIn(services, 7, 'first', 'mac'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    let saved!: Promise<PersonalStandInSettings | null>
    act(() => {
      saved = result.current.save()
    })
    const next = { ...settings, executionDeviceId: 'second' }
    personalGet.mockResolvedValue(next)
    act(() => result.current.setDeviceId('second'))
    expect(result.current.saved).toBeNull()
    expect(result.current.saving).toBe(false)
    await waitFor(() => expect(result.current.saved).toEqual(next))
    await act(async () => {
      if (outcome === 'success') pending.resolve({ ...settings, version: 9 })
      else pending.reject(new Error('version conflict'))
      expect(await saved).toBeNull()
    })
    expect(personalSave).toHaveBeenCalledWith(7, settings, 'first')
    expect(result.current.saved).toEqual(next)
    expect(result.current.error).toBeNull()
  }
)

test('keeps a loaded selection ready when selecting that same device again', async () => {
  const { services, personalGet } = fixture()
  const { result } = renderHook(() => usePersonalStandIn(services, 7, 'device', 'mac'))
  await waitFor(() => expect(result.current.loading).toBe(false))
  act(() => result.current.setDeviceId('device'))
  expect(result.current.loading).toBe(false)
  expect(personalGet).toHaveBeenCalledTimes(1)
})
