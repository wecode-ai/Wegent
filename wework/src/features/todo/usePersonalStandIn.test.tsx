import { newStandInRole, type PersonalStandInSettings } from '@/api/personalStandIn'
import type { StandInExecutorApi } from '@/api/standIn'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
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
  it('retries failed local identity discovery before loading any profile', async () => {
    const { personalGet, services } = fixture()
    vi.mocked(services.getLocalRuntimeSidebarIdentity!)
      .mockRejectedValueOnce(new Error('Identity unavailable'))
      .mockResolvedValue({ deviceId: 'mac' })
    const { result } = renderHook(() => usePersonalStandIn(services, 7))
    await waitFor(() => expect(result.current.error).toBeTruthy())
    expect(personalGet).not.toHaveBeenCalled()
    act(() => result.current.reload())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBeNull()
    expect(personalGet).toHaveBeenCalledExactlyOnceWith(7, 'mac')
  })

  it('reuses the instance identity without waiting for another runtime discovery', async () => {
    const { personalGet, services } = fixture()
    vi.mocked(services.getLocalRuntimeSidebarIdentity!).mockImplementation(
      () => new Promise(() => {})
    )
    const { result } = renderHook(() => usePersonalStandIn(services, 7, 'selected-device', 'mac'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(personalGet).toHaveBeenCalledExactlyOnceWith(7, 'selected-device')
    expect(services.getLocalRuntimeSidebarIdentity).not.toHaveBeenCalled()
    expect(result.current.currentDeviceId).toBe('mac')
  })

  it('saves to the Executor that was selected for loading, even with stale stored fields', async () => {
    const { settings, personalGet, personalSave, services } = fixture()
    const { result } = renderHook(() => usePersonalStandIn(services, 7, 'selected-device'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(personalGet).toHaveBeenCalledWith(7, 'selected-device')
    await act(async () => {
      await result.current.save()
    })
    expect(personalSave).toHaveBeenCalledExactlyOnceWith(7, settings, 'selected-device')
  })

  it('preserves the draft and reports the Executor rejection', async () => {
    const { personalSave, services } = fixture()
    personalSave.mockRejectedValueOnce(new Error('version conflict'))
    const { result } = renderHook(() => usePersonalStandIn(services, 7))
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => result.current.updateRole('default', role => ({ ...role, prompt: 'Review changes' })))
    await act(async () => {
      expect(await result.current.save()).toBeNull()
    })
    expect(result.current.error).toBe('助理设置已在其他位置更新，请刷新后重新修改。')
    expect(result.current.draft?.roles[0].prompt).toBe('Review changes')
  })
})
