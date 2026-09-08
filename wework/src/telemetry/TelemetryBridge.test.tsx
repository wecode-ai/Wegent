import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TelemetryBridge } from './TelemetryBridge'

const mocks = vi.hoisted(() => ({
  installTelemetry: vi.fn().mockResolvedValue(undefined),
  preferences: {
    loaded: true,
    preferences: { telemetryConsentAsked: true, telemetryEnabled: true },
  },
  setTelemetryEnabled: vi.fn().mockResolvedValue(undefined),
  track: vi.fn(),
  updateAppPreferences: vi.fn().mockResolvedValue(undefined),
  electronRuntime: false,
}))

vi.mock('@/features/app-preferences/useAppPreferencesState', () => ({
  useAppPreferencesState: () => mocks.preferences,
}))

vi.mock('@/lib/runtime-environment', () => ({
  getDesktopWindowLabel: () => 'main',
  isElectronRuntime: () => mocks.electronRuntime,
}))

vi.mock('./client', () => ({
  installTelemetry: mocks.installTelemetry,
  isTelemetryEnabled: () => mocks.preferences.preferences.telemetryEnabled,
  setTelemetryEnabled: mocks.setTelemetryEnabled,
  track: mocks.track,
}))

vi.mock('@/desktop/appPreferences', () => ({
  updateAppPreferences: mocks.updateAppPreferences,
}))

describe('TelemetryBridge', () => {
  beforeEach(() => {
    mocks.installTelemetry.mockClear()
    mocks.setTelemetryEnabled.mockClear()
    mocks.track.mockClear()
    mocks.updateAppPreferences.mockClear()
    mocks.preferences.loaded = true
    mocks.preferences.preferences.telemetryConsentAsked = true
    mocks.preferences.preferences.telemetryEnabled = true
    mocks.electronRuntime = false
  })

  it('initializes once and starts telemetry again after it is re-enabled', async () => {
    const view = render(<TelemetryBridge />)

    await waitFor(() => {
      expect(mocks.installTelemetry).toHaveBeenCalledWith(true)
      expect(mocks.track).toHaveBeenCalledWith('app_started', { surface: 'main' })
    })

    mocks.preferences.preferences.telemetryEnabled = false
    view.rerender(<TelemetryBridge />)
    await waitFor(() => expect(mocks.setTelemetryEnabled).toHaveBeenLastCalledWith(false))

    mocks.preferences.preferences.telemetryEnabled = true
    view.rerender(<TelemetryBridge />)
    await waitFor(() => {
      expect(mocks.setTelemetryEnabled).toHaveBeenLastCalledWith(true)
    })

    expect(mocks.installTelemetry).toHaveBeenCalledTimes(1)
    expect(mocks.track).toHaveBeenCalledTimes(1)
  })

  it('enables telemetry by default without prompting', async () => {
    mocks.preferences.preferences.telemetryConsentAsked = false
    mocks.preferences.preferences.telemetryEnabled = false
    mocks.electronRuntime = true

    render(<TelemetryBridge />)

    expect(screen.queryByTestId('telemetry-consent-overlay')).not.toBeInTheDocument()
    await waitFor(() => {
      expect(mocks.installTelemetry).toHaveBeenCalledWith(true)
      expect(mocks.setTelemetryEnabled).toHaveBeenLastCalledWith(true)
      expect(mocks.updateAppPreferences).toHaveBeenCalledWith({
        telemetryConsentAsked: true,
        telemetryEnabled: true,
      })
    })
  })

  it('persists an explicit opt-out', async () => {
    mocks.preferences.preferences.telemetryConsentAsked = true
    mocks.preferences.preferences.telemetryEnabled = false

    render(<TelemetryBridge />)

    await waitFor(() => expect(mocks.setTelemetryEnabled).toHaveBeenLastCalledWith(false))
    expect(mocks.updateAppPreferences).not.toHaveBeenCalled()
    expect(mocks.track).not.toHaveBeenCalled()
  })
})
