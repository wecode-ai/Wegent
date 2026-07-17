import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { defaultAppPreferences } from '@/tauri/appPreferences'
import { DesktopAppSwitcher } from './DesktopAppSwitcher'

const getAppPreferencesMock = vi.hoisted(() => vi.fn())

vi.mock('@/tauri/appPreferences', async importOriginal => {
  const actual = await importOriginal<typeof import('@/tauri/appPreferences')>()
  return { ...actual, getAppPreferences: getAppPreferencesMock }
})

describe('DesktopAppSwitcher', () => {
  beforeEach(() => {
    getAppPreferencesMock.mockReset()
    getAppPreferencesMock.mockResolvedValue(defaultAppPreferences)
  })

  test('hides TODO while experimental features are disabled', async () => {
    render(<DesktopAppSwitcher activeApp="wework" onNavigate={vi.fn()} />)

    await waitFor(() => expect(getAppPreferencesMock).toHaveBeenCalled())
    expect(screen.queryByTestId('chrome-tab-todo')).not.toBeInTheDocument()
  })

  test('shows TODO while experimental features are enabled', async () => {
    getAppPreferencesMock.mockResolvedValue({
      ...defaultAppPreferences,
      experimentalFeaturesEnabled: true,
    })
    render(<DesktopAppSwitcher activeApp="wework" onNavigate={vi.fn()} />)

    expect(await screen.findByTestId('chrome-tab-todo')).toBeInTheDocument()
  })

  test('keeps the TODO tab visible when the TODO app is already active', async () => {
    render(<DesktopAppSwitcher activeApp="todo" onNavigate={vi.fn()} />)

    expect(screen.getByTestId('chrome-tab-todo')).toBeInTheDocument()
  })
})
