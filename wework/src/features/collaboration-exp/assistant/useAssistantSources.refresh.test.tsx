import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { experienceStandInFixture } from '../model/fixtures'
import { useAssistantSources } from './useAssistantSources'

const mocks = vi.hoisted(() => ({ workbench: {} as Record<string, unknown> }))
vi.mock('@/features/workbench/useWorkbench', () => ({ useWorkbench: () => mocks.workbench }))
vi.mock('@/features/todo/useStandInInbox', () => ({
  useStandInInbox: () => ({ items: [], sourceErrors: [], error: null, refresh: vi.fn() }),
}))

function fixture() {
  const settings = experienceStandInFixture({ executionDeviceId: 'bound-device' })
  const api = {
    binding: vi.fn().mockResolvedValue({
      status: 'active',
      target: { userId: 7, deviceId: 'bound-device', backendUrl: '' },
    }),
    personalGet: vi.fn().mockResolvedValue(settings),
    proposal: vi.fn().mockResolvedValue(null),
  }
  const identity = vi.fn().mockResolvedValue({ deviceId: 'local-device' })
  const state = { user: { id: 7 } }
  mocks.workbench = {
    services: { standInApi: api, getLocalRuntimeSidebarIdentity: identity },
    state,
  }
  return { api, identity, state, settings }
}

beforeEach(fixture)
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('assistant source refresh ownership', () => {
  it('keeps verified settings and a visible error when network refresh fails despite successful proposal reads', async () => {
    const { api, settings } = fixture()
    const view = renderHook(() => useAssistantSources(true))
    await waitFor(() => expect(view.result.current.proposalsReady).toBe(true))
    let completeProposal!: (value: null) => void
    api.proposal.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          completeProposal = resolve
        })
    )
    api.personalGet.mockRejectedValueOnce(new Error('Network unavailable'))
    act(() => view.result.current.refresh())
    await waitFor(() => expect(api.personalGet).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(api.proposal.mock.calls.length).toBeGreaterThan(1))
    await waitFor(() => expect(view.result.current.error).toBeTruthy())
    await act(async () => completeProposal(null))
    expect(view.result.current.error).toBeTruthy()
    expect(view.result.current.settings).toBe(settings)
    expect(view.result.current.loading).toBe(false)
    act(() => view.result.current.refresh())
    await waitFor(() => expect(api.personalGet).toHaveBeenCalledTimes(3))
    await waitFor(() => expect(view.result.current.error).toBeNull())
    expect(view.result.current.settings).toBe(settings)
  })

  it.each([{ status: 401 }, { code: 'permission_denied' }, { code: 'wrong_device' }])(
    'invalidates previously verified settings after access or identity failure: %j',
    async error => {
      const { api } = fixture()
      const view = renderHook(() => useAssistantSources(true, false))
      await waitFor(() => expect(view.result.current.settings).toBeDefined())
      api.personalGet.mockRejectedValueOnce(error)
      act(() => view.result.current.refresh())
      await waitFor(() => expect(view.result.current.error).toBeTruthy())
      expect(view.result.current.settings).toBeUndefined()
      api.personalGet.mockRejectedValueOnce(new Error('Network unavailable'))
      act(() => view.result.current.refresh())
      await waitFor(() => expect(api.personalGet).toHaveBeenCalledTimes(3))
      expect(view.result.current.settings).toBeUndefined()
    }
  )

  it('invalidates a previous binding before a changed device read fails', async () => {
    const { api } = fixture()
    const view = renderHook(() => useAssistantSources(true, false))
    await waitFor(() => expect(view.result.current.settings).toBeDefined())
    api.binding.mockResolvedValueOnce({
      status: 'active',
      target: { userId: 7, deviceId: 'different-device', backendUrl: '' },
    })
    api.personalGet.mockRejectedValueOnce(new Error('Network unavailable'))
    act(() => view.result.current.refresh())
    await waitFor(() => expect(view.result.current.error).toBeTruthy())
    expect(view.result.current.settings).toBeUndefined()
  })

  it('invalidates confirmed local identity loss', async () => {
    const { identity } = fixture()
    const view = renderHook(() => useAssistantSources(true, false))
    await waitFor(() => expect(view.result.current.settings).toBeDefined())
    identity.mockResolvedValueOnce(undefined as unknown as { deviceId: string })
    act(() => view.result.current.refresh())
    await waitFor(() => expect(view.result.current.error).toBeTruthy())
    expect(view.result.current.settings).toBeUndefined()
  })

  it('invalidates a removed binding even when local settings cannot refresh', async () => {
    const { api } = fixture()
    const view = renderHook(() => useAssistantSources(true, false))
    await waitFor(() => expect(view.result.current.settings).toBeDefined())
    api.binding.mockResolvedValueOnce({ status: 'unbound', target: null })
    api.personalGet.mockRejectedValueOnce(new Error('Network unavailable'))
    act(() => view.result.current.refresh())
    await waitFor(() => expect(view.result.current.error).toBeTruthy())
    expect(view.result.current.settings).toBeUndefined()
  })

  it('rejects settings for a different device even when the account matches', async () => {
    const { api } = fixture()
    api.personalGet.mockResolvedValueOnce(experienceStandInFixture({ executionDeviceId: 'other' }))
    const view = renderHook(() => useAssistantSources(true, false))
    await waitFor(() => expect(view.result.current.error).toBeTruthy())
    expect(view.result.current.settings).toBeUndefined()
  })
})
