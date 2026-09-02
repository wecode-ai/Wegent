import { renderHook } from '@testing-library/react'
import { AppPreferencesContext } from '@/features/app-preferences/appPreferencesContext'
import { defaultAppPreferences } from '@/desktop/appPreferences'
import { WEWORK_DSH_SLOTS } from './dshUiSlots'
import {
  GIT_CONTRIBUTION_ID,
  useChangeRequestStatusEnabled,
  useGitPluginInstalled,
} from './gitPlugin'

describe('Git DSH plugin state', () => {
  const installedEntries = [{ id: GIT_CONTRIBUTION_ID }]
  const missingEntries: never[] = []

  test('reports whether the Git contribution is installed', () => {
    const runtime = window.__WEWORK_DSH_UI__
    window.__WEWORK_DSH_UI__ = {
      ...runtime!,
      getEntries: slot =>
        slot === WEWORK_DSH_SLOTS.git
          ? installedEntries
          : (runtime?.getEntries(slot) ?? missingEntries),
    }
    expect(renderHook(() => useGitPluginInstalled()).result.current).toBe(true)

    window.__WEWORK_DSH_UI__ = {
      ...window.__WEWORK_DSH_UI__!,
      getEntries: slot =>
        slot === WEWORK_DSH_SLOTS.git
          ? missingEntries
          : (runtime?.getEntries(slot) ?? missingEntries),
    }
    expect(renderHook(() => useGitPluginInstalled()).result.current).toBe(false)
  })

  test('keeps the PR status preference inside the Git plugin boundary', () => {
    const runtime = window.__WEWORK_DSH_UI__
    window.__WEWORK_DSH_UI__ = {
      ...runtime!,
      getEntries: slot =>
        slot === WEWORK_DSH_SLOTS.git
          ? installedEntries
          : (runtime?.getEntries(slot) ?? missingEntries),
    }
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <AppPreferencesContext.Provider
        value={{
          loaded: true,
          preferences: { ...defaultAppPreferences, changeRequestStatusEnabled: false },
        }}
      >
        {children}
      </AppPreferencesContext.Provider>
    )
    expect(renderHook(() => useChangeRequestStatusEnabled(), { wrapper }).result.current).toBe(
      false
    )
  })
})
