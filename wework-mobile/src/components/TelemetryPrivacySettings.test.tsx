import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const telemetry = vi.hoisted(() => ({
  snapshot: {
    ready: true,
    available: true,
    asked: true,
    enabled: false,
    saving: false,
    active: false,
    error: null as unknown,
  },
  choose: vi.fn(async () => undefined),
  retry: vi.fn(async () => undefined),
}))

vi.mock('@/telemetry/useMobileTelemetry', () => ({
  useMobileTelemetryState: () => telemetry.snapshot,
}))
vi.mock('@/telemetry/mobileTelemetry', () => ({
  mobileTelemetry: { choose: telemetry.choose, retry: telemetry.retry },
}))
vi.mock('react-native', () => ({
  StyleSheet: { create: (value: unknown) => value },
  Switch: 'Switch',
  View: 'View',
}))
vi.mock('react-native-paper', () => ({
  Text: 'Text',
  useTheme: () => ({ colors: { onSurfaceVariant: '#555' } }),
}))
vi.mock('./errors/ErrorNotice', () => ({ ErrorNotice: 'ErrorNotice' }))

import { TelemetryPrivacySettings } from './TelemetryPrivacySettings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('telemetry privacy setting', () => {
  let renderer: ReactTestRenderer | undefined

  beforeEach(() => {
    telemetry.choose.mockReset()
    telemetry.choose.mockResolvedValue(undefined)
    telemetry.retry.mockClear()
    telemetry.snapshot.error = null
  })

  it('writes the explicit user choice through the telemetry controller', async () => {
    await act(() => {
      renderer = create(<TelemetryPrivacySettings />)
    })
    const toggle = renderer!.root.findByProps({ testID: 'settings-telemetry-toggle' })
    await act(() => toggle.props.onValueChange(true))
    expect(telemetry.choose).toHaveBeenCalledWith(true)
  })

  it('retries the failed preference choice instead of only clearing the error', async () => {
    telemetry.choose.mockRejectedValueOnce(new Error('storage unavailable'))
    await act(() => {
      renderer = create(<TelemetryPrivacySettings />)
    })
    const toggle = renderer!.root.findByProps({ testID: 'settings-telemetry-toggle' })
    await act(() => toggle.props.onValueChange(true))
    const notice = renderer!.root.findByType('ErrorNotice' as never)
    await act(() => notice.props.onRetry())
    expect(telemetry.choose).toHaveBeenNthCalledWith(1, true)
    expect(telemetry.choose).toHaveBeenNthCalledWith(2, true)
  })

  it('shows a storage error with retry instead of silently hiding telemetry', async () => {
    telemetry.snapshot.error = new Error('storage unavailable')
    await act(() => {
      renderer = create(<TelemetryPrivacySettings />)
    })
    expect(renderer!.root.findByType('ErrorNotice' as never)).toBeTruthy()
  })
})
