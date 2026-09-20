import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TelemetryBridge } from './TelemetryBridge'

const mocks = vi.hoisted(() => ({
  applyTelemetryIdentity: vi.fn(),
  clientEnabled: true,
  identity: null as { distinctId: string; properties: Record<string, string> } | null,
  installTelemetry: vi.fn().mockResolvedValue(undefined),
  preferences: {
    loaded: true,
    preferences: { telemetryConsentAsked: true, telemetryEnabled: true },
  },
  setTelemetryEnabled: vi.fn().mockResolvedValue(undefined),
  track: vi.fn(),
  updateAppPreferences: vi.fn().mockResolvedValue(undefined),
  officialRelease: true,
  distribution: 'public' as 'public' | 'internal',
  electronRuntime: false,
  user: null as { id: number; user_name: string; email: string } | null,
}))

vi.mock('@/features/app-preferences/useAppPreferencesState', () => ({
  useAppPreferencesState: () => mocks.preferences,
}))

vi.mock('@/lib/runtime-environment', () => ({
  getDesktopWindowLabel: () => 'main',
  isElectronRuntime: () => mocks.electronRuntime,
}))

vi.mock('./client', () => ({
  applyTelemetryIdentity: mocks.applyTelemetryIdentity,
  installTelemetry: mocks.installTelemetry,
  isTelemetryEnabled: () => mocks.preferences.preferences.telemetryEnabled,
  setTelemetryEnabled: mocks.setTelemetryEnabled,
  track: mocks.track,
  useTelemetryEnabled: () => mocks.clientEnabled,
}))

vi.mock('@/features/auth/useAuth', () => ({
  useAuth: () => ({ user: mocks.user }),
}))

vi.mock('@extensions/telemetry-policy', () => ({
  telemetryPolicy: {
    identityFor: () => mocks.identity,
    personProfiles: 'never',
    sendClientIp: false,
  },
}))

vi.mock('./config', () => ({
  getTelemetryConfig: () => ({ distribution: mocks.distribution }),
  isOfficialReleaseBuild: () => mocks.officialRelease,
}))

vi.mock('@/desktop/appPreferences', () => ({
  updateAppPreferences: mocks.updateAppPreferences,
}))

describe('TelemetryBridge', () => {
  beforeEach(() => {
    mocks.applyTelemetryIdentity.mockClear()
    mocks.clientEnabled = true
    mocks.identity = null
    mocks.installTelemetry.mockClear()
    mocks.setTelemetryEnabled.mockClear()
    mocks.track.mockClear()
    mocks.updateAppPreferences.mockClear()
    mocks.preferences.loaded = true
    mocks.preferences.preferences.telemetryConsentAsked = true
    mocks.preferences.preferences.telemetryEnabled = true
    mocks.officialRelease = true
    mocks.distribution = 'public'
    mocks.electronRuntime = false
    mocks.user = null
  })

  it('attaches the account identity only while the client is capturing', async () => {
    mocks.identity = { distinctId: 'jiaqi62', properties: { username: 'jiaqi62' } }
    mocks.user = { id: 42, user_name: 'jiaqi62', email: 'jiaqi62@example.com' }

    const view = render(<TelemetryBridge />)

    await waitFor(() => expect(mocks.applyTelemetryIdentity).toHaveBeenCalledWith(mocks.identity))

    mocks.clientEnabled = false
    mocks.applyTelemetryIdentity.mockClear()
    view.rerender(<TelemetryBridge />)

    expect(mocks.applyTelemetryIdentity).not.toHaveBeenCalled()
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

  it('waits for explicit consent before initializing telemetry', async () => {
    mocks.preferences.preferences.telemetryConsentAsked = false

    render(<TelemetryBridge />)

    expect(screen.getByTestId('telemetry-consent-overlay')).toBeInTheDocument()
    expect(mocks.installTelemetry).not.toHaveBeenCalled()
    expect(mocks.setTelemetryEnabled).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('telemetry-consent-accept'))

    await waitFor(() => {
      expect(mocks.updateAppPreferences).toHaveBeenCalledWith({
        telemetryConsentAsked: true,
        telemetryEnabled: true,
      })
    })
  })

  it('persists declining without initializing telemetry', async () => {
    mocks.preferences.preferences.telemetryConsentAsked = false

    render(<TelemetryBridge />)
    fireEvent.click(screen.getByTestId('telemetry-consent-decline'))

    await waitFor(() => {
      expect(mocks.updateAppPreferences).toHaveBeenCalledWith({
        telemetryConsentAsked: true,
        telemetryEnabled: false,
      })
    })
    expect(mocks.installTelemetry).not.toHaveBeenCalled()
  })

  it('enables telemetry by default without prompting in development builds', async () => {
    mocks.officialRelease = false
    mocks.electronRuntime = true
    mocks.preferences.preferences.telemetryConsentAsked = false
    mocks.preferences.preferences.telemetryEnabled = false

    render(<TelemetryBridge />)

    expect(screen.queryByTestId('telemetry-consent-overlay')).not.toBeInTheDocument()
    await waitFor(() => {
      expect(mocks.installTelemetry).toHaveBeenCalledWith(true)
      expect(mocks.updateAppPreferences).toHaveBeenCalledWith({
        telemetryConsentAsked: true,
        telemetryEnabled: true,
      })
    })
  })

  it('disables the public telemetry client and hides consent in internal builds', async () => {
    mocks.distribution = 'internal'
    mocks.preferences.preferences.telemetryConsentAsked = false

    render(<TelemetryBridge />)

    await waitFor(() => expect(mocks.installTelemetry).toHaveBeenCalledWith(false))
    expect(mocks.setTelemetryEnabled).not.toHaveBeenCalled()
    expect(mocks.updateAppPreferences).not.toHaveBeenCalled()
    expect(screen.queryByTestId('telemetry-consent-overlay')).not.toBeInTheDocument()
  })
})
