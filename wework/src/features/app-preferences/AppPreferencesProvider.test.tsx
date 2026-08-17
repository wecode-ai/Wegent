import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { APP_PREFERENCES_CHANGED_EVENT, defaultAppPreferences } from '@/tauri/appPreferences'
import { AppPreferencesProvider } from './AppPreferencesProvider'
import { useAppPreferencesState } from './useAppPreferencesState'

const getAppPreferencesMock = vi.hoisted(() => vi.fn())

vi.mock('@/tauri/appPreferences', async importOriginal => {
  const actual = await importOriginal<typeof import('@/tauri/appPreferences')>()
  return { ...actual, getAppPreferences: getAppPreferencesMock }
})

function PreferenceProbe({ label }: { label: string }) {
  const state = useAppPreferencesState()
  return <div>{`${label}:${state?.loaded}:${state?.preferences.experimentalFeaturesEnabled}`}</div>
}

describe('AppPreferencesProvider', () => {
  beforeEach(() => {
    getAppPreferencesMock.mockReset()
    getAppPreferencesMock.mockResolvedValue({
      ...defaultAppPreferences,
      experimentalFeaturesEnabled: true,
    })
  })

  test('loads one preference snapshot shared by every consumer', async () => {
    render(
      <AppPreferencesProvider>
        <PreferenceProbe label="first" />
        <PreferenceProbe label="second" />
      </AppPreferencesProvider>
    )

    expect(await screen.findByText('first:true:true')).toBeInTheDocument()
    expect(screen.getByText('second:true:true')).toBeInTheDocument()
    expect(getAppPreferencesMock).toHaveBeenCalledTimes(1)
  })

  test('updates the shared snapshot when preferences change', async () => {
    render(
      <AppPreferencesProvider>
        <PreferenceProbe label="first" />
      </AppPreferencesProvider>
    )

    await screen.findByText('first:true:true')
    act(() => {
      window.dispatchEvent(
        new CustomEvent(APP_PREFERENCES_CHANGED_EVENT, {
          detail: { ...defaultAppPreferences, experimentalFeaturesEnabled: false },
        })
      )
    })

    await waitFor(() => expect(screen.getByText('first:true:false')).toBeInTheDocument())
  })
})
