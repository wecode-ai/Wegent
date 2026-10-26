import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { newStandInRole, type PersonalStandInSettings } from '@/api/personalStandIn'
import type { StandInExecutorApi } from '@/api/standIn'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { usePersonalStandIn } from './usePersonalStandIn'

function fixture() {
  const settings: PersonalStandInSettings = {
    userId: 7,
    executionDeviceId: 'old-device',
    version: 1,
    roles: [newStandInRole('old-device', 'default')],
  }
  const personalGet = vi.fn(async () => settings)
  const personalSave = vi.fn<StandInExecutorApi['personalSave']>(async (_user, value) => value)
  const services = {
    getLocalRuntimeSidebarIdentity: vi.fn(async () => ({ deviceId: 'mac' })),
    standInApi: { personalGet, personalSave },
  } as unknown as WorkbenchServices
  return { settings, personalGet, personalSave, services }
}

describe('personal stand-in Executor routing', () => {
  it('saves to the Executor that was selected for loading, even with stale stored fields', async () => {
    const { settings, personalGet, personalSave, services } = fixture()
    const { result } = renderHook(() => usePersonalStandIn(services, 7, 'selected-device', false))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(personalGet).toHaveBeenCalledWith(7, 'selected-device')
    await act(async () => {
      await result.current.save()
    })
    expect(personalSave).toHaveBeenCalledExactlyOnceWith(7, settings, 'selected-device')
  })

  it('uses the newly selected Executor for subsequent saves', async () => {
    const { settings, personalGet, personalSave, services } = fixture()
    const { result } = renderHook(() => usePersonalStandIn(services, 7, undefined, false))
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => result.current.setDeviceId('remote-device'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(personalGet).toHaveBeenLastCalledWith(7, 'remote-device')
    await act(async () => {
      await result.current.save()
    })
    expect(personalSave).toHaveBeenCalledExactlyOnceWith(7, settings, 'remote-device')
  })

  it('preserves the draft and reports the Executor rejection', async () => {
    const { personalSave, services } = fixture()
    personalSave.mockRejectedValueOnce(new Error('version conflict'))
    const { result } = renderHook(() => usePersonalStandIn(services, 7, undefined, false))
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => result.current.updateRole('default', role => ({ ...role, prompt: 'Review changes' })))
    await act(async () => {
      expect(await result.current.save()).toBeNull()
    })
    expect(result.current.error).toContain('version conflict')
    expect(result.current.draft?.roles[0].prompt).toBe('Review changes')
  })
})
