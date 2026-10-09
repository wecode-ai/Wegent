import { trackPluginEvent } from './businessEvents'
import { act, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { beginOperation } from './operationBus'
import { TelemetryAgent } from './TelemetryAgent'

const mocks = vi.hoisted(() => ({
  auth: {
    isLoading: false,
    user: { email: 'zhongyang@example.invalid', id: 7, user_name: 'zhongyang' },
  },
  distribution: 'public' as 'internal' | 'public',
  flushInternalSinks: vi.fn(),
  hostEventHandler: null as
    | ((event: { type: string; payload: Record<string, unknown> }) => void)
    | null,
  publish: vi.fn(),
  telemetryEnabled: true,
}))

vi.mock('@/features/dsh-runtime/useDshSlotEntries', () => ({
  useDshSlotEntries: () => [{ path: '/plugins', telemetryFeature: 'plugins' }],
}))

vi.mock('@/api/dsh/desktopHost', () => ({
  subscribeDesktopHostEvents: (
    handler: (event: { type: string; payload: Record<string, unknown> }) => void
  ) => {
    mocks.hostEventHandler = handler
    return () => {
      mocks.hostEventHandler = null
    }
  },
}))

vi.mock('@/lib/runtime-environment', () => ({
  isElectronRuntime: () => true,
}))

vi.mock('./config', () => ({
  getTelemetryConfig: () => ({ distribution: mocks.distribution }),
}))

vi.mock('./client', () => ({
  trackEvent: vi.fn(),
  useTelemetryEnabled: () => mocks.telemetryEnabled,
}))

vi.mock('./dispatcher', () => ({
  createTelemetryDispatcher: () => ({
    flushInternalSinks: mocks.flushInternalSinks,
    publish: mocks.publish,
  }),
}))

vi.mock('@/features/auth/useAuth', () => ({
  useAuth: () => mocks.auth,
}))

vi.mock('@/features/dsh-runtime/dshExtensions', () => ({
  getDshTelemetrySinks: () => [],
  subscribeDshTelemetrySinks: () => () => {},
}))

describe('TelemetryAgent', () => {
  beforeEach(() => {
    mocks.auth.isLoading = false
    mocks.auth.user = { email: 'zhongyang@example.invalid', id: 7, user_name: 'zhongyang' }
    mocks.distribution = 'public'
    mocks.flushInternalSinks.mockReset()
    mocks.hostEventHandler = null
    mocks.publish.mockReset()
    mocks.telemetryEnabled = true
    window.history.replaceState({}, '', '/sites?app_type=smart_app')
  })

  afterEach(() => {
    window.history.replaceState({}, '', '/')
  })

  test('automatically publishes each Smart App route transition once', async () => {
    render(<TelemetryAgent />)

    await waitFor(() =>
      expect(mocks.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'smart_app_marketplace_opened' })
      )
    )

    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(mocks.publish).toHaveBeenCalledTimes(1)

    await act(async () => {
      window.history.pushState({}, '', '/sites?app_type=smart_app&view=owned')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })

    await waitFor(() =>
      expect(mocks.publish).toHaveBeenLastCalledWith(
        expect.objectContaining({ name: 'smart_app_owned_opened' })
      )
    )
  })

  test('waits for authentication before adding internal context', async () => {
    mocks.distribution = 'internal'
    mocks.auth.isLoading = true
    const view = render(<TelemetryAgent />)

    expect(mocks.publish).not.toHaveBeenCalled()

    mocks.auth.isLoading = false
    view.rerender(<TelemetryAgent />)

    await waitFor(() =>
      expect(mocks.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          context: {
            user: { email: 'zhongyang@example.invalid', id: 7, userName: 'zhongyang' },
          },
          name: 'smart_app_marketplace_opened',
        })
      )
    )
  })

  test('publishes the current route after public telemetry is enabled', async () => {
    mocks.telemetryEnabled = false
    const view = render(<TelemetryAgent />)

    expect(mocks.publish).not.toHaveBeenCalled()
    expect(mocks.hostEventHandler).not.toBeNull()

    act(() => {
      mocks.hostEventHandler?.({
        type: 'startup.attempted',
        payload: { startup_id: '13c4ae86-1066-46f5-a3db-4c92e806564a' },
      })
    })
    expect(mocks.publish).not.toHaveBeenCalled()

    mocks.telemetryEnabled = true
    view.rerender(<TelemetryAgent />)

    await waitFor(() => expect(mocks.publish).toHaveBeenCalledTimes(2))
    expect(mocks.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'app_startup_attempted',
        properties: { startup_id: '13c4ae86-1066-46f5-a3db-4c92e806564a' },
      })
    )
  })

  test('dispatches plugin observations and operation results to internal sinks', async () => {
    mocks.distribution = 'internal'
    window.history.replaceState({}, '', '/plugins')
    render(<TelemetryAgent />)
    await waitFor(() =>
      expect(mocks.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'plugin_center_opened' })
      )
    )
    beginOperation('plugin.share').succeed()
    trackPluginEvent('plugin_installed', {
      source: 'local',
      plugin_distribution: 'personal',
      plugin_id: 'personal/my-plugin',
    })
    expect(mocks.publish).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'plugin_share_succeeded', properties: { domain: 'plugin' } })
    )
    expect(mocks.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({
        name: 'plugin_installed',
        context: { user: { id: 7, userName: 'zhongyang', email: 'zhongyang@example.invalid' } },
      })
    )
  })

  test('turns operation results into generated events', async () => {
    render(<TelemetryAgent />)
    await waitFor(() => expect(mocks.publish).toHaveBeenCalledTimes(1))

    beginOperation('smart_app.install').fail('install')

    await waitFor(() =>
      expect(mocks.publish).toHaveBeenLastCalledWith(
        expect.objectContaining({
          name: 'smart_app_install_failed',
          properties: { domain: 'smart_app', failure_stage: 'install' },
        })
      )
    )
  })

  test('turns desktop startup lifecycle events into correlated analytics events', async () => {
    render(<TelemetryAgent />)
    await waitFor(() => expect(mocks.hostEventHandler).not.toBeNull())

    act(() => {
      mocks.hostEventHandler?.({
        type: 'startup.attempted',
        payload: { startup_id: '13c4ae86-1066-46f5-a3db-4c92e806564a' },
      })
      mocks.hostEventHandler?.({
        type: 'startup.succeeded',
        payload: {
          startup_id: '13c4ae86-1066-46f5-a3db-4c92e806564a',
          duration_ms: 1532,
        },
      })
    })

    expect(mocks.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'app_startup_attempted',
        properties: { startup_id: '13c4ae86-1066-46f5-a3db-4c92e806564a' },
      })
    )
    expect(mocks.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'app_startup_succeeded',
        properties: {
          duration_ms: 1532,
          startup_id: '13c4ae86-1066-46f5-a3db-4c92e806564a',
        },
      })
    )
  })

  test('forwards plugin identity from operation results', async () => {
    render(<TelemetryAgent />)
    await waitFor(() => expect(mocks.publish).toHaveBeenCalledTimes(1))

    beginOperation('plugin.authorize', {
      properties: {
        plugin_distribution: 'official',
        plugin_id: 'openai-curated-remote/gmail',
      },
    }).succeed()

    await waitFor(() =>
      expect(mocks.publish).toHaveBeenLastCalledWith(
        expect.objectContaining({
          name: 'plugin_authorize_succeeded',
          properties: {
            domain: 'plugin',
            plugin_distribution: 'official',
            plugin_id: 'openai-curated-remote/gmail',
          },
        })
      )
    )
  })
})
