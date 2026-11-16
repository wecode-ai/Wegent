import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import type { StandInSourceError } from '@/api/standIn'
import type { useAssistantSources } from './useAssistantSources'
import { experienceStandInFixture } from '../model/fixtures'
import { useExperienceTeamState } from './useExperienceTeamState'

const mocks = vi.hoisted(() => ({
  source: {} as ReturnType<typeof useAssistantSources>,
  refreshWorkLists: vi.fn(),
}))
vi.mock('./useAssistantSources', () => ({ useAssistantSources: () => mocks.source }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbench: () => ({
    runtimeTaskReminders: { items: [] },
    state: { runtimeWork: {}, runtimeWorkLoad: { phase: 'ready' } },
    refreshWorkLists: mocks.refreshWorkLists,
  }),
}))

beforeEach(() => {
  mocks.refreshWorkLists.mockReset().mockResolvedValue(undefined)
  mocks.source = {
    scope: 'account-7',
    userId: 7,
    ownerId: 7,
    deviceId: 'device-1',
    settings: experienceStandInFixture(),
    proposals: [],
    proposalsReady: true,
    inboxReady: true,
    inbox: { items: [], sourceErrors: [], error: null, refresh: vi.fn() },
    error: null,
    loading: false,
    refresh: vi.fn(),
  } as unknown as ReturnType<typeof useAssistantSources>
})
afterEach(cleanup)

describe('team refresh recovery', () => {
  it('exposes a localized partial inbox failure to the existing retry UI and clears it on recovery', async () => {
    const error = { code: 'permission_denied', message: 'Private raw diagnostic' }
    mocks.source.inbox.sourceErrors = [{ error } as StandInSourceError]
    const view = renderHook(() => useExperienceTeamState(true, []))
    expect(view.result.current.ready).toBe(false)
    expect(view.result.current.error).toBe(getStandInErrorMessage(error))
    expect(view.result.current.error).not.toContain(error.message)
    act(() => view.result.current.refresh())
    expect(mocks.source.refresh).toHaveBeenCalledOnce()
    expect(mocks.source.inbox.refresh).toHaveBeenCalledOnce()
    expect(mocks.refreshWorkLists).toHaveBeenCalledOnce()
    mocks.source.inbox.sourceErrors = []
    view.rerender()
    await waitFor(() => expect(view.result.current.error).toBeNull())
    expect(view.result.current.ready).toBe(true)
  })

  it('ignores an older failure after a newer refresh has started and succeeded', async () => {
    let rejectOld!: (reason: Error) => void
    mocks.refreshWorkLists.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectOld = reject
        })
    )
    const view = renderHook(() => useExperienceTeamState(true, []))
    act(() => view.result.current.refresh())
    await act(async () => view.result.current.refresh())
    await act(async () => rejectOld(new Error('Outdated failure')))
    expect(view.result.current.error).toBeNull()
  })

  it('exposes the newest failure and clears it when retry succeeds', async () => {
    mocks.refreshWorkLists.mockRejectedValueOnce(new Error('Current failure'))
    const view = renderHook(() => useExperienceTeamState(true, []))
    await act(async () => view.result.current.refresh())
    expect(view.result.current.error).toBeTruthy()
    await act(async () => view.result.current.refresh())
    expect(view.result.current.error).toBeNull()
  })

  it('rejects late failures from a prior account and an inactive page', async () => {
    let rejectOld!: (reason: Error) => void
    mocks.refreshWorkLists.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectOld = reject
        })
    )
    const view = renderHook(({ active }) => useExperienceTeamState(active, []), {
      initialProps: { active: true },
    })
    act(() => view.result.current.refresh())
    mocks.source = { ...mocks.source, scope: 'account-8', userId: 8 }
    view.rerender({ active: false })
    await act(async () => rejectOld(new Error('Old account failure')))
    expect(view.result.current.error).toBeNull()
    act(() => view.result.current.refresh())
    expect(mocks.refreshWorkLists).toHaveBeenCalledOnce()
  })
})
