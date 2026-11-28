import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (value: unknown) => value },
  View: 'View',
}))
vi.mock('react-native-paper', () => {
  const component = (name: string) => {
    const Component = ({ children, ...props }: { children?: React.ReactNode }) =>
      React.createElement(name, props, children)
    return Component
  }
  return {
    ActivityIndicator: 'ActivityIndicator',
    Button: component('Button'),
    Dialog: Object.assign(component('Dialog'), {
      Title: component('Dialog.Title'),
      Content: component('Dialog.Content'),
      Actions: component('Dialog.Actions'),
    }),
    Portal: component('Portal'),
    Text: component('Text'),
    useTheme: () => ({ colors: {} }),
  }
})

import { TelemetryConsentDialog } from './TelemetryConsentDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('telemetry consent dialog', () => {
  let renderer: ReactTestRenderer

  it('does not collect before the user chooses and stores an explicit acceptance', async () => {
    const choose = vi.fn(async () => undefined)
    await act(() => {
      renderer = create(
        <TelemetryConsentDialog
          snapshot={{
            ready: true,
            available: true,
            asked: false,
            enabled: false,
            saving: false,
            active: false,
            error: null,
          }}
          onChoose={choose}
        />
      )
    })
    expect(choose).not.toHaveBeenCalled()
    const accept = renderer.root.findByProps({ testID: 'telemetry-consent-accept' })
    await act(() => accept.props.onPress())
    expect(choose).toHaveBeenCalledWith(true)
  })
})
