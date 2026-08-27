import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  backgroundImageUrl,
  removeWorkbenchBackground,
  selectWorkbenchBackground,
} from './backgroundImage'

const { invokeDesktopHost } = vi.hoisted(() => ({
  invokeDesktopHost: vi.fn(),
}))

vi.mock('@/api/dsh/desktopHost', () => ({ invokeDesktopHost }))

describe('workbench background image service', () => {
  beforeEach(() => {
    invokeDesktopHost.mockReset()
  })

  test('returns the selected Electron desktop file', async () => {
    invokeDesktopHost.mockResolvedValue({
      canceled: false,
      filePaths: ['/tmp/source.png'],
    })

    await expect(selectWorkbenchBackground('dark')).resolves.toBe('/tmp/source.png')
    expect(invokeDesktopHost).toHaveBeenCalledWith('dialog.open', {
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
    })
  })

  test('does not import when the picker is cancelled', async () => {
    invokeDesktopHost.mockResolvedValue({ canceled: true, filePaths: [] })

    await expect(selectWorkbenchBackground('light')).resolves.toBeNull()
  })

  test('removes the configured image and converts its display URL', async () => {
    await removeWorkbenchBackground('light')

    expect(invokeDesktopHost).not.toHaveBeenCalled()
    expect(backgroundImageUrl('/app-data/background.webp')).toBe('file:///app-data/background.webp')
  })
})
