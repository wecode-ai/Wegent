import { render } from '@testing-library/react'
import { describe, expect, test } from 'vitest'

import { cloudDesktopExtension } from './cloud-desktop'

describe('cloud desktop fallback extension', () => {
  test('keeps cloud desktop capabilities unavailable without an internal overlay', async () => {
    const DeviceAction = cloudDesktopExtension.DeviceAction
    const view = render(
      <DeviceAction deviceId="device-1" disabled={false} onOpened={() => undefined} />
    )

    expect(cloudDesktopExtension.available).toBe(false)
    expect(view.container).toBeEmptyDOMElement()
    expect(cloudDesktopExtension.isInternalPageUrl('tauri://localhost/extension-page.html')).toBe(
      false
    )
    await expect(
      cloudDesktopExtension.open({
        connection: { isConnected: false, token: null },
        deviceId: 'device-1',
        isCurrent: () => true,
      })
    ).rejects.toThrow('Cloud desktop extension is unavailable')
  })
})
