import { render } from '@testing-library/react'
import { describe, expect, test } from 'vitest'

import { cloudDesktopExtension } from './cloud-desktop'

describe('cloud desktop fallback extension', () => {
  test('keeps cloud desktop capabilities unavailable without an internal overlay', async () => {
    const DeviceAction = cloudDesktopExtension.DeviceAction
    const deviceActionView = render(
      <DeviceAction deviceId="device-1" disabled={false} onOpened={() => undefined} />
    )
    const WorkspaceAction = cloudDesktopExtension.WorkspaceAction
    const workspaceActionView = render(
      <WorkspaceAction
        contextKey="project-1"
        deviceId="device-1"
        disabled={false}
        onBusyChange={() => undefined}
        onErrorChange={() => undefined}
        onOpened={() => undefined}
      />
    )

    expect(cloudDesktopExtension.available).toBe(false)
    expect(deviceActionView.container).toBeEmptyDOMElement()
    expect(workspaceActionView.container).toBeEmptyDOMElement()
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
