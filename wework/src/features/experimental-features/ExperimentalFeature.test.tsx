import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { APP_PREFERENCES_CHANGED_EVENT, defaultAppPreferences } from '@/tauri/appPreferences'
import { ExperimentalFeature } from './ExperimentalFeature'

const getAppPreferencesMock = vi.hoisted(() => vi.fn())

vi.mock('@/tauri/appPreferences', async importOriginal => {
  const actual = await importOriginal<typeof import('@/tauri/appPreferences')>()
  return { ...actual, getAppPreferences: getAppPreferencesMock }
})

describe('ExperimentalFeature', () => {
  beforeEach(() => {
    getAppPreferencesMock.mockReset()
    getAppPreferencesMock.mockResolvedValue(defaultAppPreferences)
  })

  test('hides experimental features by default', async () => {
    render(
      <ExperimentalFeature>
        <div>Experimental feature</div>
      </ExperimentalFeature>
    )

    await waitFor(() => expect(getAppPreferencesMock).toHaveBeenCalled())
    expect(screen.queryByText('Experimental feature')).not.toBeInTheDocument()
  })

  test('shows experimental features when enabled and reacts to preference changes', async () => {
    getAppPreferencesMock.mockResolvedValue({
      ...defaultAppPreferences,
      experimentalFeaturesEnabled: true,
    })
    render(
      <ExperimentalFeature>
        <div>Experimental feature</div>
      </ExperimentalFeature>
    )

    expect(await screen.findByText('Experimental feature')).toBeInTheDocument()

    window.dispatchEvent(
      new CustomEvent(APP_PREFERENCES_CHANGED_EVENT, {
        detail: { ...defaultAppPreferences, experimentalFeaturesEnabled: false },
      })
    )
    await waitFor(() => expect(screen.queryByText('Experimental feature')).not.toBeInTheDocument())
  })
})
