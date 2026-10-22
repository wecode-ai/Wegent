import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { APP_PREFERENCES_CHANGED_EVENT, defaultAppPreferences } from '@/desktop/appPreferences'
import { AppPreferencesProvider } from './AppPreferencesProvider'
import { useAppPreferencesState } from './useAppPreferencesState'
import type { DesktopHostEvent } from '@/api/dsh/desktopHost'

const getAppPreferencesMock = vi.hoisted(() => vi.fn())
const hostEvents = vi.hoisted(() => ({ subscribe: vi.fn(), electron: false }))
vi.mock('@/api/dsh/desktopHost', () => ({ subscribeDesktopHostEvents: hostEvents.subscribe }))
vi.mock('@/lib/runtime-environment', () => ({ isElectronRuntime: () => hostEvents.electron }))

vi.mock('@/desktop/appPreferences', async importOriginal => {
  const actual = await importOriginal<typeof import('@/desktop/appPreferences')>()
  return { ...actual, getAppPreferences: getAppPreferencesMock }
})

function PreferenceProbe({ label }: { label: string }) {
  const state = useAppPreferencesState()
  return <div>{`${label}:${state?.loaded}:${state?.preferences.experimentalFeaturesEnabled}`}</div>
}

describe('AppPreferencesProvider', () => {
  beforeEach(() => {
    getAppPreferencesMock.mockReset()
    hostEvents.electron = false
    hostEvents.subscribe.mockReset().mockReturnValue(vi.fn())
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

  test('applies preference changes from another Electron window and unsubscribes', async () => {
    hostEvents.electron = true
    const unsubscribe = vi.fn()
    hostEvents.subscribe.mockReturnValue(unsubscribe)
    const view = render(
      <AppPreferencesProvider>
        <PreferenceProbe label="main" />
      </AppPreferencesProvider>
    )
    await screen.findByText('main:true:true')
    const receive = hostEvents.subscribe.mock.calls[0][0] as (event: DesktopHostEvent) => void
    act(() =>
      receive({
        sequence: 1,
        type: 'preferences.changed',
        payload: { ...defaultAppPreferences, experimentalFeaturesEnabled: false },
      })
    )
    expect(screen.getByText('main:true:false')).toBeInTheDocument()
    view.unmount()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
