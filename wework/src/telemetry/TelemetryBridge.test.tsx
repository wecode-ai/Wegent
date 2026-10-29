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
  cloudUser: null as { id: number; user_name: string; email: string } | null,
  identityForUsers: [] as Array<{ id: number; user_name: string; email: string } | null>,
  accountLoading: false,
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
  useAuth: () => ({ user: mocks.user, isLoading: mocks.accountLoading }),
}))

vi.mock('@/features/cloud-connection/useCloudConnection', () => ({
  useOptionalCloudConnection: () => ({ user: mocks.cloudUser }),
}))

vi.mock('@extensions/telemetry-policy', () => ({
  telemetryPolicy: {
    identityFor: (user: { id: number; user_name: string; email: string } | null) => {
      mocks.identityForUsers.push(user)
      return mocks.identity
    },
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
    mocks.updateAppPreferences.mockReset()
    mocks.updateAppPreferences.mockResolvedValue(undefined)
    mocks.preferences.loaded = true
    mocks.preferences.preferences.telemetryConsentAsked = true
    mocks.preferences.preferences.telemetryEnabled = true
    mocks.officialRelease = true
    mocks.distribution = 'public'
    mocks.electronRuntime = false
    mocks.cloudUser = null
    mocks.identityForUsers = []
    mocks.accountLoading = false
    mocks.user = null
  })

  it('attaches the account identity only while the client is capturing', async () => {
    mocks.identity = { distinctId: 'jiaqi62', properties: { username: 'jiaqi62' } }
    mocks.cloudUser = { id: 42, user_name: 'jiaqi62', email: 'jiaqi62@example.com' }

    const view = render(<TelemetryBridge />)

    await waitFor(() => expect(mocks.applyTelemetryIdentity).toHaveBeenCalledWith(mocks.identity))

    mocks.clientEnabled = false
    mocks.applyTelemetryIdentity.mockClear()
    view.rerender(<TelemetryBridge />)

    expect(mocks.applyTelemetryIdentity).not.toHaveBeenCalled()
  })

  it('reports the signed-in cloud account instead of the local placeholder user', async () => {
    mocks.user = { id: 0, user_name: 'local', email: 'local@wework.local' }
    mocks.cloudUser = { id: 42, user_name: 'jiaqi62', email: 'jiaqi62@example.com' }

    render(<TelemetryBridge />)

    await waitFor(() =>
      expect(mocks.identityForUsers).toContainEqual(
        expect.objectContaining({ id: 42, user_name: 'jiaqi62' })
      )
    )
    expect(mocks.identityForUsers).not.toContainEqual(
      expect.objectContaining({ user_name: 'local' })
    )
  })

  it('waits for the account to resolve instead of detaching while it loads', async () => {
    mocks.accountLoading = true
    const view = render(<TelemetryBridge />)

    await new Promise(resolvePromise => setTimeout(resolvePromise, 0))
    expect(mocks.identityForUsers).toEqual([])

    mocks.accountLoading = false
    view.rerender(<TelemetryBridge />)

    await waitFor(() => expect(mocks.identityForUsers).toEqual([null]))
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

  it('shows a retryable error when saving the consent choice never settles', async () => {
    vi.useFakeTimers()
    try {
      mocks.preferences.preferences.telemetryConsentAsked = false
      mocks.updateAppPreferences.mockReturnValue(new Promise(() => {}))

      render(<TelemetryBridge />)
      fireEvent.click(screen.getByTestId('telemetry-consent-decline'))

      expect(screen.getByTestId('telemetry-consent-decline')).toBeDisabled()

      await vi.advanceTimersByTimeAsync(10_000)

      await vi.waitFor(() => {
        expect(screen.getByTestId('telemetry-consent-decline')).not.toBeDisabled()
        expect(screen.getByRole('alert')).toBeInTheDocument()
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets a retry start a fresh save after a timed-out attempt never settles', async () => {
    vi.useFakeTimers()
    try {
      mocks.preferences.preferences.telemetryConsentAsked = false
      mocks.updateAppPreferences.mockImplementationOnce(() => new Promise(() => {}))

      render(<TelemetryBridge />)
      fireEvent.click(screen.getByTestId('telemetry-consent-accept'))

      await vi.advanceTimersByTimeAsync(10_000)
      await vi.waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())

      fireEvent.click(screen.getByTestId('telemetry-consent-decline'))
      await vi.waitFor(() => {
        expect(mocks.updateAppPreferences).toHaveBeenLastCalledWith({
          telemetryConsentAsked: true,
          telemetryEnabled: false,
        })
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-asserts the latest choice when a superseded save completes late', async () => {
    vi.useFakeTimers()
    try {
      mocks.preferences.preferences.telemetryConsentAsked = false
      let releaseFirstSave: (() => void) | null = null
      mocks.updateAppPreferences.mockImplementationOnce(
        () =>
          new Promise<void>(resolve => {
            releaseFirstSave = () => resolve()
          })
      )

      render(<TelemetryBridge />)
      fireEvent.click(screen.getByTestId('telemetry-consent-accept'))

      await vi.advanceTimersByTimeAsync(10_000)
      await vi.waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())

      fireEvent.click(screen.getByTestId('telemetry-consent-decline'))
      await vi.waitFor(() => {
        expect(mocks.updateAppPreferences).toHaveBeenLastCalledWith({
          telemetryConsentAsked: true,
          telemetryEnabled: false,
        })
      })
      expect(mocks.updateAppPreferences).toHaveBeenCalledTimes(2)

      // The abandoned accept save completes late; it must re-assert the
      // latest decline choice so the stale value does not win.
      releaseFirstSave?.()
      await vi.waitFor(() => {
        expect(mocks.updateAppPreferences).toHaveBeenCalledTimes(3)
        expect(mocks.updateAppPreferences).toHaveBeenLastCalledWith({
          telemetryConsentAsked: true,
          telemetryEnabled: false,
        })
      })
    } finally {
      vi.useRealTimers()
    }
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
