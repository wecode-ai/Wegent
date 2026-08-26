import { describe, expect, test, vi } from 'vitest'
import { getAppshotsStatus, openAppshotsPermissionSettings, subscribeToAppshots } from './appshots'

describe('appshots', () => {
  test('reports Electron appshots as unsupported', async () => {
    await expect(getAppshotsStatus()).resolves.toEqual({
      supported: false,
      shortcut: 'CommandOrControl+Shift+2',
      shortcutRegistered: false,
      screenCapturePermissionGranted: false,
      accessibilityPermissionGranted: false,
    })
  })

  test('rejects permission settings while Electron appshots are unavailable', async () => {
    await expect(openAppshotsPermissionSettings('screenCapture')).rejects.toThrow(
      'Appshots are not supported by the Electron desktop host'
    )
  })

  test('returns a no-op appshot subscription', async () => {
    const onAttachments = vi.fn()
    const dispose = await subscribeToAppshots(onAttachments)

    dispose()

    expect(onAttachments).not.toHaveBeenCalled()
  })
})
