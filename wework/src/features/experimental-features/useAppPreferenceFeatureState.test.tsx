import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { defaultAppPreferences, APP_PREFERENCES_CHANGED_EVENT } from '@/desktop/appPreferences'
import { useAppPreferenceFeatureState } from './useAppPreferenceFeatureState'
import { AppPreferencesContext } from '@/features/app-preferences/appPreferencesContext'
import { createAppPreferencesStore } from '@/features/app-preferences/appPreferencesStore'
import type { ReactNode } from 'react'

const read = vi.hoisted(() => vi.fn())
vi.mock('@/lib/runtime-environment', () => ({ isElectronRuntime: () => false }))
vi.mock('@/desktop/appPreferences', async importOriginal => ({
  ...(await importOriginal<typeof import('@/desktop/appPreferences')>()),
  getAppPreferences: read,
}))
beforeEach(() => {
  read
    .mockReset()
    .mockResolvedValue({ ...defaultAppPreferences, experimentalFeaturesEnabled: true })
})

test('standalone consumers load and subscribe without requiring an app provider', async () => {
  const { result, rerender } = renderHook(
    ({ preference }) => useAppPreferenceFeatureState(preference),
    {
      initialProps: {
        preference: 'experimentalFeaturesEnabled' as
          | 'experimentalFeaturesEnabled'
          | 'collaborationExperienceEnabled',
      },
    }
  )
  await waitFor(() => expect(result.current).toEqual({ enabled: true, loaded: true }))
  rerender({ preference: 'collaborationExperienceEnabled' })
  expect(result.current).toEqual({ enabled: false, loaded: true })
  act(() =>
    window.dispatchEvent(
      new CustomEvent(APP_PREFERENCES_CHANGED_EVENT, {
        detail: { ...defaultAppPreferences, collaborationExperienceEnabled: true },
      })
    )
  )
  expect(result.current).toEqual({ enabled: true, loaded: true })
  expect(read).toHaveBeenCalledTimes(1)
})

test('provider consumers do not start another preference read', () => {
  const state = {
    preferences: { ...defaultAppPreferences, experimentalFeaturesEnabled: true },
    loaded: true,
  }
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AppPreferencesContext.Provider value={state}>{children}</AppPreferencesContext.Provider>
  )
  expect(
    renderHook(() => useAppPreferenceFeatureState('experimentalFeaturesEnabled'), { wrapper })
      .result.current
  ).toEqual({ enabled: true, loaded: true })
  expect(read).not.toHaveBeenCalled()
})

test('a failed preference read leaves startup available and a retry preserves newer changes', async () => {
  const updated = { ...defaultAppPreferences, collaborationExperienceEnabled: true }
  let completeRetry!: (preferences: typeof defaultAppPreferences) => void
  read
    .mockRejectedValueOnce(new Error('Preferences unavailable'))
    .mockImplementationOnce(() => new Promise(resolve => (completeRetry = resolve)))
  const store = createAppPreferencesStore()
  const unsubscribe = store.subscribe(() => {})
  try {
    await waitFor(() =>
      expect(store.getSnapshot()).toMatchObject({ loaded: true, loadStatus: 'error' })
    )
    store.getSnapshot().retry?.()
    expect(store.getSnapshot()).toMatchObject({ loaded: true, loadStatus: 'loading' })
    window.dispatchEvent(new CustomEvent(APP_PREFERENCES_CHANGED_EVENT, { detail: updated }))
    completeRetry(defaultAppPreferences)
    await Promise.resolve()
    expect(store.getSnapshot()).toMatchObject({
      loaded: true,
      loadStatus: 'ready',
      preferences: updated,
    })
  } finally {
    unsubscribe()
  }
})
