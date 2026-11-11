import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { saveTelemetryConsent, setSessionTelemetryConsent } from './sessionConsent'
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
  officialRelease: true,
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

vi.mock('./config', () => ({
  getTelemetryConfig: () => ({
    contextFields: [],
    identity: 'anonymous',
  }),
  isOfficialReleaseBuild: () => mocks.officialRelease,
}))

vi.mock('@/desktop/appPreferences', () => ({
  updateAppPreferences: mocks.updateAppPreferences,
}))

describe('TelemetryBridge', () => {
  beforeEach(() => {
    setSessionTelemetryConsent(undefined)
    mocks.installTelemetry.mockClear()
    mocks.setTelemetryEnabled.mockClear()
    mocks.track.mockClear()
    mocks.updateAppPreferences.mockReset()
    mocks.updateAppPreferences.mockResolvedValue(undefined)
    mocks.preferences.loaded = true
    mocks.preferences.preferences.telemetryConsentAsked = true
    mocks.preferences.preferences.telemetryEnabled = true
    mocks.officialRelease = true
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

  it('applies declining without enabling telemetry', async () => {
    mocks.preferences.preferences.telemetryConsentAsked = false

    render(<TelemetryBridge />)
    fireEvent.click(screen.getByTestId('telemetry-consent-decline'))

    await waitFor(() => {
      expect(mocks.updateAppPreferences).toHaveBeenCalledWith({
        telemetryConsentAsked: true,
        telemetryEnabled: false,
      })
    })
    expect(mocks.installTelemetry).toHaveBeenCalledWith(false)
    expect(mocks.installTelemetry).not.toHaveBeenCalledWith(true)
  })

  it('closes the prompt and keeps telemetry disabled when declining cannot be saved', async () => {
    mocks.preferences.preferences.telemetryConsentAsked = false
    mocks.updateAppPreferences.mockRejectedValue(new Error('EACCES'))
    render(<TelemetryBridge />)
    fireEvent.click(screen.getByTestId('telemetry-consent-decline'))
    await waitFor(() =>
      expect(screen.queryByTestId('telemetry-consent-overlay')).not.toBeInTheDocument()
    )
    expect(mocks.setTelemetryEnabled).toHaveBeenCalledWith(false)
    expect(mocks.installTelemetry).not.toHaveBeenCalledWith(true)
  })

  it('does not block the workbench while consent persistence never settles', async () => {
    mocks.preferences.preferences.telemetryConsentAsked = false
    mocks.updateAppPreferences.mockReturnValue(new Promise(() => {}))
    render(<TelemetryBridge />)
    fireEvent.click(screen.getByTestId('telemetry-consent-accept'))
    await waitFor(() =>
      expect(screen.queryByTestId('telemetry-consent-overlay')).not.toBeInTheDocument()
    )
    expect(mocks.installTelemetry).toHaveBeenCalledWith(false)
    expect(mocks.installTelemetry).not.toHaveBeenCalledWith(true)
  })

  it('honors a refusal from another window after a local opt-in succeeds', async () => {
    mocks.preferences.preferences.telemetryConsentAsked = false
    mocks.preferences.preferences.telemetryEnabled = false
    mocks.updateAppPreferences.mockImplementation(async patch => {
      Object.assign(mocks.preferences.preferences, patch)
      return mocks.preferences.preferences
    })
    const view = render(<TelemetryBridge />)
    fireEvent.click(screen.getByTestId('telemetry-consent-accept'))
    await waitFor(() => expect(mocks.setTelemetryEnabled).toHaveBeenLastCalledWith(true))

    mocks.preferences.preferences.telemetryEnabled = false
    view.rerender(<TelemetryBridge />)
    await waitFor(() => expect(mocks.setTelemetryEnabled).toHaveBeenLastCalledWith(false))
  })

  it('honors a saved refusal when a local opt-in could not be persisted', async () => {
    mocks.preferences.preferences.telemetryConsentAsked = false
    mocks.preferences.preferences.telemetryEnabled = false
    mocks.updateAppPreferences.mockRejectedValue(new Error('EACCES'))
    const view = render(<TelemetryBridge />)
    fireEvent.click(screen.getByTestId('telemetry-consent-accept'))
    await waitFor(() =>
      expect(screen.queryByTestId('telemetry-consent-overlay')).not.toBeInTheDocument()
    )

    mocks.preferences.preferences.telemetryConsentAsked = true
    view.rerender(<TelemetryBridge />)
    await waitFor(() => expect(mocks.setTelemetryEnabled).toHaveBeenLastCalledWith(false))
    expect(mocks.installTelemetry).not.toHaveBeenCalledWith(true)
  })

  it('accepts another window enabling collection after a saved local refusal', async () => {
    mocks.updateAppPreferences.mockImplementation(async patch => {
      Object.assign(mocks.preferences.preferences, patch)
      return mocks.preferences.preferences
    })
    const view = render(<TelemetryBridge />)
    await act(async () => {
      await saveTelemetryConsent(false)
    })
    await waitFor(() => expect(mocks.setTelemetryEnabled).toHaveBeenLastCalledWith(false))

    mocks.preferences.preferences.telemetryEnabled = true
    view.rerender(<TelemetryBridge />)
    await waitFor(() => expect(mocks.setTelemetryEnabled).toHaveBeenLastCalledWith(true))
  })

  it('allows a later settings choice while an earlier save is still pending', async () => {
    mocks.preferences.preferences.telemetryConsentAsked = false
    mocks.updateAppPreferences.mockImplementationOnce(() => new Promise(() => {}))
    render(<TelemetryBridge />)
    fireEvent.click(screen.getByTestId('telemetry-consent-accept'))
    await act(async () => {
      await saveTelemetryConsent(false)
    })
    expect(mocks.updateAppPreferences).toHaveBeenLastCalledWith({
      telemetryConsentAsked: true,
      telemetryEnabled: false,
    })
    expect(mocks.setTelemetryEnabled).toHaveBeenLastCalledWith(false)
  })

  it('reasserts the latest explicit choice after an older save finishes late', async () => {
    mocks.preferences.preferences.telemetryConsentAsked = false
    let finishFirst: ((value: unknown) => void) | undefined
    mocks.updateAppPreferences.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishFirst = resolve
        })
    )
    render(<TelemetryBridge />)
    fireEvent.click(screen.getByTestId('telemetry-consent-accept'))
    await act(async () => {
      await saveTelemetryConsent(false)
    })
    expect(mocks.updateAppPreferences).toHaveBeenCalledTimes(2)
    await act(async () => {
      finishFirst?.(undefined)
    })
    await waitFor(() => expect(mocks.updateAppPreferences).toHaveBeenCalledTimes(3))
    expect(mocks.updateAppPreferences).toHaveBeenLastCalledWith({
      telemetryConsentAsked: true,
      telemetryEnabled: false,
    })
    expect(mocks.setTelemetryEnabled).toHaveBeenLastCalledWith(false)
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

  it('honors a saved refusal on every build', async () => {
    mocks.preferences.preferences.telemetryEnabled = false
    render(<TelemetryBridge />)
    await waitFor(() => expect(mocks.installTelemetry).toHaveBeenCalledWith(false))
    expect(mocks.track).not.toHaveBeenCalled()
  })
})
