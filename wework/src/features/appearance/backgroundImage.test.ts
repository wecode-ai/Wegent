import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  loadWorkbenchBackgroundImage,
  removeWorkbenchBackground,
  selectWorkbenchBackground,
} from './backgroundImage'

const { invokeDesktopHost } = vi.hoisted(() => ({
  invokeDesktopHost: vi.fn(),
}))
const { readElectronLocalFile } = vi.hoisted(() => ({
  readElectronLocalFile: vi.fn(),
}))
const { isElectronRuntime } = vi.hoisted(() => ({ isElectronRuntime: vi.fn() }))

vi.mock('@/api/dsh/desktopHost', () => ({ invokeDesktopHost }))
vi.mock('@/lib/electron-local-file', () => ({ readElectronLocalFile }))
vi.mock('@/lib/runtime-environment', () => ({ isElectronRuntime }))

const originalCreateObjectUrl = URL.createObjectURL
const originalRevokeObjectUrl = URL.revokeObjectURL

describe('workbench background image service', () => {
  beforeEach(() => {
    invokeDesktopHost.mockReset()
    readElectronLocalFile.mockReset()
    isElectronRuntime.mockReset()
    isElectronRuntime.mockReturnValue(true)
    URL.createObjectURL = vi.fn(() => 'blob:workbench-background')
    URL.revokeObjectURL = vi.fn()
  })

  afterEach(() => {
    URL.createObjectURL = originalCreateObjectUrl
    URL.revokeObjectURL = originalRevokeObjectUrl
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

  test('removes the configured image without touching the desktop host', async () => {
    await removeWorkbenchBackground('light')

    expect(invokeDesktopHost).not.toHaveBeenCalled()
  })

  test('reads the image through the Electron file bridge and serves a Blob URL', async () => {
    readElectronLocalFile.mockResolvedValue(new Uint8Array([1, 2, 3]))

    const image = await loadWorkbenchBackgroundImage('/app-data/background.webp')

    expect(readElectronLocalFile).toHaveBeenCalledWith('/app-data/background.webp')
    expect(image?.url).toBe('blob:workbench-background')
    expect(URL.createObjectURL).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'image/webp' }) as Blob
    )

    image?.release()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:workbench-background')
  })

  test('accepts Windows drive paths and jpeg aliases', async () => {
    readElectronLocalFile.mockResolvedValue(new Uint8Array([4, 5]))

    await expect(loadWorkbenchBackgroundImage('C:\\Users\\me\\背景.JPEG')).resolves.toEqual(
      expect.objectContaining({ url: 'blob:workbench-background' })
    )
    expect(readElectronLocalFile).toHaveBeenCalledWith('C:\\Users\\me\\背景.JPEG')
    expect(URL.createObjectURL).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'image/jpeg' }) as Blob
    )
  })

  test('skips files the picker could not have selected', async () => {
    await expect(loadWorkbenchBackgroundImage('/app-data/background.bmp')).resolves.toBeNull()
    await expect(loadWorkbenchBackgroundImage(null)).resolves.toBeNull()

    expect(readElectronLocalFile).not.toHaveBeenCalled()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  test('does not read browser-local paths outside the Electron runtime', async () => {
    isElectronRuntime.mockReturnValue(false)

    await expect(loadWorkbenchBackgroundImage('/app-data/background.png')).resolves.toBeNull()
    expect(readElectronLocalFile).not.toHaveBeenCalled()
  })
})
