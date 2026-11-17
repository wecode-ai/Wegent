import React from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DiagnosticsSettings } from './DiagnosticsSettings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const state = vi.hoisted(() => ({
  enabled: false,
  ready: true,
  changing: false,
  error: null as unknown,
  change: vi.fn(async (_value: boolean) => undefined),
  retry: vi.fn(),
}))
vi.mock('@/hooks/useMobileDiagnostics', () => ({ useMobileDiagnostics: () => state }))
vi.mock('react-native', () => ({
  View: 'View',
  Switch: 'NativeSwitch',
  StyleSheet: { create: (v: unknown) => v },
}))
vi.mock('react-native-paper', () => ({ Text: 'Text', useTheme: () => ({ colors: {} }) }))
vi.mock('./errors/ErrorNotice', () => ({ ErrorNotice: 'ErrorNotice' }))

beforeEach(() => {
  state.enabled = false
  state.ready = true
  state.changing = false
  state.error = null
  state.change.mockReset().mockResolvedValue(undefined)
})

describe('native diagnostics switch', () => {
  it('uses the platform Switch with an accessible label and persists the selected value', async () => {
    let view!: ReturnType<typeof create>
    await act(() => {
      view = create(<DiagnosticsSettings />)
    })
    const control = view.root.findByType('NativeSwitch' as never)
    expect(control.props).toMatchObject({
      value: false,
      accessibilityLabel: '诊断日志',
      testID: 'settings-diagnostics-toggle',
      disabled: false,
    })
    await act(() => control.props.onValueChange(true))
    expect(state.change).toHaveBeenCalledExactlyOnceWith(true)
    await act(() => view.unmount())
  })

  it('preserves the switch value and displays a settings failure when persistence fails', async () => {
    const failure = new Error('Storage unavailable')
    state.change.mockRejectedValue(failure)
    let view!: ReturnType<typeof create>
    await act(() => {
      view = create(<DiagnosticsSettings />)
    })
    await act(() => view.root.findByType('NativeSwitch' as never).props.onValueChange(true))
    expect(view.root.findByType('NativeSwitch' as never).props.value).toBe(false)
    expect(view.root.findByType('ErrorNotice' as never).props.error).toBe(failure)
    await act(() => view.unmount())
  })

  it('disables changes during restore or persistence', async () => {
    state.ready = false
    let view!: ReturnType<typeof create>
    await act(() => {
      view = create(<DiagnosticsSettings />)
    })
    expect(view.root.findByType('NativeSwitch' as never).props.disabled).toBe(true)
    state.ready = true
    state.changing = true
    await act(() => view.update(<DiagnosticsSettings />))
    expect(view.root.findByType('NativeSwitch' as never).props.disabled).toBe(true)
    await act(() => view.unmount())
  })
})
