import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import {
  AppUpdateContext,
  type AppUpdateContextValue,
} from '@/features/app-update/app-update-context'
import { AboutSettingsPage } from './AboutSettingsPage'

function renderPage(overrides: Partial<AppUpdateContextValue> = {}) {
  const value: AppUpdateContextValue = {
    updateChannel: 'stable',
    availableUpdate: null,
    status: 'idle',
    downloadProgress: null,
    message: null,
    error: null,
    checkNow: vi.fn().mockResolvedValue(null),
    installUpdate: vi.fn().mockResolvedValue(undefined),
    setUpdateChannel: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }

  render(
    <AppUpdateContext.Provider value={value}>
      <AboutSettingsPage />
    </AppUpdateContext.Provider>
  )
  return value
}

describe('AboutSettingsPage', () => {
  test('lets the user opt into Beta and stable updates', () => {
    const value = renderPage()

    fireEvent.click(screen.getByTestId('about-beta-update-switch'))

    expect(value.setUpdateChannel).toHaveBeenCalledWith('beta')
  })

  test('lets a Beta user return to stable-only updates', () => {
    const value = renderPage({ updateChannel: 'beta' })
    const channelSwitch = screen.getByTestId('about-beta-update-switch')

    expect(channelSwitch).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(channelSwitch)

    expect(value.setUpdateChannel).toHaveBeenCalledWith('stable')
  })
})
