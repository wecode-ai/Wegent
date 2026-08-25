import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { defaultBrowserDeviceToolbarState } from '@/lib/browser-device-toolbar'
import { BrowserDeviceToolbar } from './BrowserDeviceToolbar'

describe('BrowserDeviceToolbar', () => {
  test('discards a focused dimension draft when an external resize changes the value', async () => {
    const props = {
      zoomPercent: 100,
      onPresetChange: vi.fn(),
      onDimensionsChange: vi.fn(),
      onRotate: vi.fn(),
      onZoomPercentChange: vi.fn(),
      onClose: vi.fn(),
    }
    const state = defaultBrowserDeviceToolbarState()
    const view = render(<BrowserDeviceToolbar {...props} state={state} />)
    const widthInput = screen.getByTestId('workspace-browser-device-width-input')

    fireEvent.focus(widthInput)
    fireEvent.change(widthInput, { target: { value: '800' } })
    expect(widthInput).toHaveValue(800)

    view.rerender(<BrowserDeviceToolbar {...props} state={{ ...state, width: 240 }} />)

    await waitFor(() => {
      expect(widthInput).toHaveValue(240)
    })
  })
})
