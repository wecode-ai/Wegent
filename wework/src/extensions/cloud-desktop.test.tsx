import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'

import { cloudDesktopExtension } from './cloud-desktop'

const navigateToMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/navigation', () => ({
  navigateTo: navigateToMock,
}))

describe('cloud desktop extension', () => {
  test('opens the generic VNC desktop route without embedding a session token', () => {
    const onOpened = vi.fn()
    const DeviceAction = cloudDesktopExtension.DeviceAction

    render(<DeviceAction deviceId="device-1" disabled={false} onOpened={onOpened} />)
    fireEvent.click(screen.getByTestId('connection-vnc-desktop-button-device-1'))

    expect(cloudDesktopExtension.available).toBe(true)
    expect(navigateToMock).toHaveBeenCalledWith('/device-desktop?deviceId=device-1')
    expect(onOpened).toHaveBeenCalledOnce()
  })

  test('recognizes only the internal device desktop page', () => {
    expect(cloudDesktopExtension.isInternalPageUrl('/device-desktop?deviceId=device-1')).toBe(true)
    expect(
      cloudDesktopExtension.isInternalPageUrl('internal-app://localhost/extension-page.html')
    ).toBe(false)
  })
})
