import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { experienceStandInFixture } from '../model/fixtures'
import { useAssistantSources } from './useAssistantSources'

const mocks = vi.hoisted(() => ({
  workbench: {} as Record<string, unknown>,
  inbox: {
    items: [],
    sourceErrors: [],
    error: null,
    scope: undefined as string | undefined,
    refresh: vi.fn(),
  },
}))
const translate = (key: string) => key
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: translate }) }))
vi.mock('@/features/workbench/useWorkbench', () => ({ useWorkbench: () => mocks.workbench }))
vi.mock('@/features/todo/useStandInInbox', () => ({
  useStandInInbox: () => mocks.inbox,
}))

function setup() {
  mocks.inbox.scope = undefined
  const api = {
    binding: vi.fn().mockResolvedValue({
      status: 'active',
      target: { userId: 7, deviceId: 'bound-device', backendUrl: '' },
    }),
    personalGet: vi
      .fn()
      .mockResolvedValue(experienceStandInFixture({ executionDeviceId: 'bound-device' })),
    proposal: vi.fn().mockResolvedValue(null),
    lifecycle: vi.fn(),
  }
  const identity = vi.fn().mockResolvedValue({ deviceId: 'local-device' })
  const state = { user: { id: 7 } }
  mocks.workbench = {
    services: { standInApi: api, getLocalRuntimeSidebarIdentity: identity },
    state,
  }
  return { api, identity, state }
}

beforeEach(() => {
  setup()
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('useAssistantSources', () => {
  it('keeps inbox and proposal readiness separate from an already loaded configuration', async () => {
    const { api } = setup()
    let accept!: (value: null) => void
    api.proposal.mockReturnValue(
      new Promise(resolve => {
        accept = resolve
      })
    )
    const view = renderHook(() => useAssistantSources(true))
    await waitFor(() => expect(view.result.current.settings).toBeDefined())
    expect(view.result.current.proposalsReady).toBe(false)
    expect(view.result.current.inboxReady).toBe(false)
    mocks.inbox.scope = '7:bound-device'
    view.rerender()
    expect(view.result.current.inboxReady).toBe(true)
    expect(view.result.current.proposalsReady).toBe(false)
    await act(async () => accept(null))
    await waitFor(() => expect(view.result.current.proposalsReady).toBe(true))
  })

  it('does not read or start the assistant while its view is inactive', () => {
    const { api, identity } = setup()
    renderHook(() => useAssistantSources(false))
    expect(identity).not.toHaveBeenCalled()
    expect(api.binding).not.toHaveBeenCalled()
    expect(api.lifecycle).not.toHaveBeenCalled()
  })

  it('uses the existing bound owner/device and keeps initialization read-only', async () => {
    const { api } = setup()
    const { result } = renderHook(() => useAssistantSources(true))
    await waitFor(() => expect(result.current.settings?.executionDeviceId).toBe('bound-device'))
    expect(api.personalGet).toHaveBeenCalledWith(7, 'bound-device')
    expect(api.binding).toHaveBeenCalledWith('local-device')
    expect(api.lifecycle).not.toHaveBeenCalled()
    await waitFor(() => expect(api.proposal).toHaveBeenCalledWith(7, 'bound-device', undefined))
  })

  it('refuses to read a binding owned by another account', async () => {
    const { api } = setup()
    api.binding.mockResolvedValue({
      status: 'active',
      target: { userId: 8, deviceId: 'other-device', backendUrl: '' },
    })
    const { result } = renderHook(() => useAssistantSources(true))
    await waitFor(() => expect(result.current.error).toBeTruthy())
    expect(api.personalGet).not.toHaveBeenCalled()
    expect(result.current.settings).toBeUndefined()
  })

  it('rejects settings whose returned owner differs from the bound owner', async () => {
    const { api } = setup()
    api.personalGet.mockResolvedValue(experienceStandInFixture({ userId: 8 }))
    const { result } = renderHook(() => useAssistantSources(true))
    await waitFor(() => expect(result.current.error).toBeTruthy())
    expect(result.current.settings).toBeUndefined()
    expect(api.proposal).not.toHaveBeenCalled()
  })

  it('immediately hides the previous account snapshot and discards late reads after an account switch', async () => {
    const { api, state } = setup()
    const view = renderHook(() => useAssistantSources(true))
    await waitFor(() => expect(view.result.current.settings?.userId).toBe(7))
    let completeBinding!: (value: {
      status: string
      target: { userId: number; deviceId: string; backendUrl: string }
    }) => void
    api.binding.mockImplementation(
      () =>
        new Promise(resolve => {
          completeBinding = resolve
        })
    )
    state.user = { id: 8 }
    view.rerender()
    expect(view.result.current.settings).toBeUndefined()
    await waitFor(() => expect(api.binding).toHaveBeenCalledTimes(2))
    view.unmount()
    await act(async () =>
      completeBinding({
        status: 'active',
        target: { userId: 8, deviceId: 'next-device', backendUrl: '' },
      })
    )
    expect(api.personalGet).toHaveBeenCalledTimes(1)
  })
})
