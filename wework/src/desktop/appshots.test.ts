// @vitest-environment node

import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { DesktopHostEvent } from '@/api/dsh/desktopHost'

const mocks = vi.hoisted(() => ({
  invokeDesktopHost: vi.fn(),
  unsubscribe: vi.fn(),
  handler: null as ((event: DesktopHostEvent) => void) | null,
  options: null as { replay?: (event: DesktopHostEvent) => boolean } | null,
}))

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: mocks.invokeDesktopHost,
  subscribeDesktopHostEvents: (
    handler: (event: DesktopHostEvent) => void,
    options: { replay?: (event: DesktopHostEvent) => boolean }
  ) => {
    mocks.handler = handler
    mocks.options = options
    return mocks.unsubscribe
  },
}))

describe('appshots', () => {
  beforeEach(() => {
    mocks.invokeDesktopHost.mockReset()
    mocks.unsubscribe.mockReset()
    mocks.handler = null
    mocks.options = null
  })

  test('reads native Appshots status from the Electron host', async () => {
    const status = {
      supported: true,
      shortcut: 'CommandOrControl+Shift+2',
      shortcutRegistered: true,
      screenCapturePermissionGranted: true,
      accessibilityPermissionGranted: true,
    }
    mocks.invokeDesktopHost.mockResolvedValue(status)
    const { getAppshotsStatus } = await import('./appshots')

    await expect(getAppshotsStatus()).resolves.toEqual(status)
    expect(mocks.invokeDesktopHost).toHaveBeenCalledWith('appshots.getStatus')
  })

  test('opens the requested permission pane and can trigger a capture', async () => {
    mocks.invokeDesktopHost.mockResolvedValue(undefined)
    const { captureAppshot, openAppshotsPermissionSettings } = await import('./appshots')

    await openAppshotsPermissionSettings('accessibility')
    await captureAppshot()

    expect(mocks.invokeDesktopHost).toHaveBeenNthCalledWith(1, 'appshots.openPermissionSettings', {
      permission: 'accessibility',
    })
    expect(mocks.invokeDesktopHost).toHaveBeenNthCalledWith(2, 'appshots.capture')
  })

  test('converts a captured event into grouped image and text attachments', async () => {
    const onAttachments = vi.fn()
    const { subscribeToAppshots } = await import('./appshots')
    const dispose = await subscribeToAppshots(onAttachments)
    const event: DesktopHostEvent = {
      sequence: 12,
      type: 'wework-appshot-captured',
      payload: {
        id: 'capture-1',
        filename: 'appshot.png',
        mimeType: 'image/png',
        fileSize: 128,
        path: '/draft/appshots/capture-1/appshot.png',
        textAttachment: {
          filename: 'appshot-context.txt',
          fileSize: 24,
          path: '/draft/appshots/capture-1/appshot-context.txt',
          textLength: 24,
          textPreview: 'Safari — Example',
        },
      },
    }

    mocks.handler?.(event)
    mocks.handler?.(event)

    expect(mocks.options?.replay?.(event)).toBe(true)
    expect(onAttachments).toHaveBeenCalledTimes(1)
    expect(onAttachments).toHaveBeenCalledWith([
      expect.objectContaining({
        filename: 'appshot.png',
        mime_type: 'image/png',
        local_path: event.payload.path,
        local_preview_url: event.payload.path,
        ui_group_id: 'appshot-capture-1',
        ui_group_role: 'primary',
        ui_kind: 'appshot',
      }),
      expect.objectContaining({
        filename: 'appshot-context.txt',
        mime_type: 'text/plain',
        local_path: '/draft/appshots/capture-1/appshot-context.txt',
        text_length: 24,
        ui_group_id: 'appshot-capture-1',
        ui_group_role: 'companion',
        ui_kind: 'appshot',
      }),
    ])
    expect(dispose).toBe(mocks.unsubscribe)
  })
})
