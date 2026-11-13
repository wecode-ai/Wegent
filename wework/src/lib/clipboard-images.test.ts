import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { isElectronRuntime } from '@/lib/runtime-environment'
import { beforeEach, expect, test, vi } from 'vitest'
import { normalizeClipboardImageFiles } from './clipboard-images'

vi.mock('@/api/dsh/desktopHost', () => ({ invokeDesktopHost: vi.fn() }))
vi.mock('@/lib/runtime-environment', () => ({ isElectronRuntime: vi.fn() }))

beforeEach(() => {
  vi.mocked(isElectronRuntime).mockReturnValue(true)
  vi.mocked(invokeDesktopHost).mockReset().mockResolvedValue(null)
})

test('keeps Chromium-renderable images without reading the native clipboard', async () => {
  const image = new File(['image'], 'clipboard.png', { type: 'image/png' })

  await expect(normalizeClipboardImageFiles([image])).resolves.toEqual([image])

  expect(invokeDesktopHost).not.toHaveBeenCalled()
})

test('converts the exact pasted TIFF bytes into a PNG file', async () => {
  const screenshot = new File(['tiff bytes'], '2026-11-06_17-46-02.tiff', {
    type: 'image/tiff',
    lastModified: 1_791_280_418_000,
  })
  vi.mocked(invokeDesktopHost).mockResolvedValue('data:image/png;base64,AQID')

  const [normalized] = await normalizeClipboardImageFiles([screenshot])

  expect(invokeDesktopHost).toHaveBeenCalledExactlyOnceWith('clipboard.convertImageToPng', {
    dataBase64: 'dGlmZiBieXRlcw==',
    fileName: '2026-11-06_17-46-02.tiff',
    mimeType: 'image/tiff',
  })
  expect(normalized).toMatchObject({
    name: '2026-11-06_17-46-02.png',
    type: 'image/png',
    size: 3,
    lastModified: screenshot.lastModified,
  })
})

test('keeps the original file when conversion does not produce a PNG', async () => {
  const screenshot = new File(['tiff'], 'screenshot.tiff', { type: 'image/tiff' })

  await expect(normalizeClipboardImageFiles([screenshot])).resolves.toEqual([screenshot])

  expect(invokeDesktopHost).toHaveBeenCalledExactlyOnceWith('clipboard.convertImageToPng', {
    dataBase64: 'dGlmZg==',
    fileName: 'screenshot.tiff',
    mimeType: 'image/tiff',
  })
})

test('converts each unsupported pasted image from its own bytes', async () => {
  const files = [
    new File(['first'], 'first.tiff', { type: 'image/tiff' }),
    new File(['second'], 'second.heic', { type: 'image/heic' }),
  ]
  vi.mocked(invokeDesktopHost).mockResolvedValue('data:image/png;base64,AQID')

  const normalized = await normalizeClipboardImageFiles(files)

  expect(normalized.map(file => file.name)).toEqual(['first.png', 'second.png'])
  expect(vi.mocked(invokeDesktopHost).mock.calls).toEqual([
    [
      'clipboard.convertImageToPng',
      {
        dataBase64: 'Zmlyc3Q=',
        fileName: 'first.tiff',
        mimeType: 'image/tiff',
      },
    ],
    [
      'clipboard.convertImageToPng',
      {
        dataBase64: 'c2Vjb25k',
        fileName: 'second.heic',
        mimeType: 'image/heic',
      },
    ],
  ])
})

test('does not invoke the desktop converter outside Electron', async () => {
  const screenshot = new File(['tiff'], 'screenshot.tiff', { type: 'image/tiff' })
  vi.mocked(isElectronRuntime).mockReturnValue(false)

  await expect(normalizeClipboardImageFiles([screenshot])).resolves.toEqual([screenshot])

  expect(invokeDesktopHost).not.toHaveBeenCalled()
})
