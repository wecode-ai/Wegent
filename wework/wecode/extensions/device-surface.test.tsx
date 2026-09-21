import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'

import { deviceSurfaceExtension } from './device-surface'

const navigateToMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/navigation', () => ({
  navigateTo: navigateToMock,
}))

describe('cloud desktop extension', () => {
  test('opens the generic VNC desktop route without embedding a session token', () => {
    const onOpened = vi.fn()
    const DeviceAction = deviceSurfaceExtension.DeviceAction

    render(<DeviceAction deviceId="device-1" disabled={false} onOpened={onOpened} />)
    fireEvent.click(screen.getByTestId('connection-vnc-desktop-button-device-1'))

    expect(deviceSurfaceExtension.available).toBe(true)
    expect(navigateToMock).toHaveBeenCalledWith('/device-desktop?deviceId=device-1')
    expect(onOpened).toHaveBeenCalledOnce()
  })

  test('recognizes only the internal device desktop page', () => {
    expect(deviceSurfaceExtension.isInternalPageUrl('/device-desktop?deviceId=device-1')).toBe(true)
    expect(
      deviceSurfaceExtension.isInternalPageUrl('internal-app://localhost/extension-page.html')
    ).toBe(false)
  })

  test('owns the desktop menu metadata and localizes its label', () => {
    expect(deviceSurfaceExtension.workspaceMenuItem('zh-CN')).toMatchObject({
      id: 'desktop',
      label: '桌面',
      testId: 'workspace-add-desktop-option',
      telemetryPanel: 'desktop',
    })
    expect(deviceSurfaceExtension.workspaceMenuItem('en')).toMatchObject({
      label: 'Desktop',
    })
  })
})
