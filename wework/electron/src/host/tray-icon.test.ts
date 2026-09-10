import { describe, expect, test, vi } from 'vitest'
import type { NativeImage } from 'electron'
import { convertToTemplateBitmap, createTrayIcon, type NativeImageFactory } from './tray-icon.js'

function image(overrides: Partial<NativeImage> = {}): NativeImage {
  return {
    getSize: vi.fn(() => ({ width: 36, height: 36 })),
    isEmpty: vi.fn(() => false),
    resize: vi.fn(),
    setTemplateImage: vi.fn(),
    toBitmap: vi.fn(),
    toPNG: vi.fn(() => Buffer.from('png')),
    ...overrides,
  } as unknown as NativeImage
}

describe('tray icon', () => {
  test('converts white pixels to transparency and colored pixels to a template mask', () => {
    const bitmap = Buffer.from([255, 255, 255, 255, 0, 120, 240, 255, 30, 20, 10, 128])

    expect([...convertToTemplateBitmap(bitmap)]).toEqual([0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 0, 123])
  })

  test('creates an 18-point Retina template icon on macOS', () => {
    const bitmap = Buffer.alloc(36 * 36 * 4, 255)
    const resized = image({ toBitmap: vi.fn(() => bitmap) })
    const source = image({ resize: vi.fn(() => resized) })
    const baseIcon = image({ toBitmap: vi.fn(() => bitmap) })
    const template = image()
    const images: NativeImageFactory = {
      createFromPath: vi.fn(() => source),
      createFromBitmap: vi.fn().mockReturnValueOnce(baseIcon).mockReturnValueOnce(template),
    }

    expect(createTrayIcon(images, '/icons/128x128.png', null, 'darwin')).toBe(template)
    expect(source.resize).toHaveBeenCalledWith({
      width: 36,
      height: 36,
      quality: 'best',
    })
    expect(resized.toBitmap).toHaveBeenCalledWith({ scaleFactor: 1 })
    expect(images.createFromBitmap).toHaveBeenNthCalledWith(1, expect.any(Buffer), {
      width: 36,
      height: 36,
      scaleFactor: 1,
    })
    expect(images.createFromBitmap).toHaveBeenNthCalledWith(2, bitmap, {
      width: 36,
      height: 36,
      scaleFactor: 2,
    })
    expect(template.setTemplateImage).toHaveBeenCalledWith(true)
  })

  test('renders two usage lines directly into the macOS template bitmap', () => {
    const bitmap = Buffer.alloc(36 * 36 * 4, 255)
    const resized = image({ toBitmap: vi.fn(() => bitmap) })
    const source = image({ resize: vi.fn(() => resized) })
    const baseIcon = image({ toBitmap: vi.fn(() => bitmap) })
    const template = image()
    const images: NativeImageFactory = {
      createFromPath: vi.fn(() => source),
      createFromBitmap: vi.fn().mockReturnValueOnce(baseIcon).mockReturnValueOnce(template),
    }

    expect(createTrayIcon(images, '/icons/128x128.png', 'Codex  79%\nAIGC 845.21', 'darwin')).toBe(
      template
    )
    const [renderedBitmap, options] = vi.mocked(images.createFromBitmap).mock.calls[1]
    expect(options.height).toBe(36)
    expect(options.scaleFactor).toBe(2)
    expect(options.width).toBeGreaterThan(36)
    expect(
      renderedBitmap.some(
        (value, offset) =>
          offset % 4 === 3 && Math.floor(offset / 4) % options.width >= 36 && value > 0
      )
    ).toBe(true)
    expect(template.setTemplateImage).toHaveBeenCalledWith(true)
  })

  test('renders running task level beside the macOS icon', () => {
    const bitmap = Buffer.alloc(36 * 36 * 4, 255)
    const resized = image({ toBitmap: vi.fn(() => bitmap) })
    const source = image({ resize: vi.fn(() => resized) })
    const template = image()
    const images: NativeImageFactory = {
      createFromPath: vi.fn(() => source),
      createFromBitmap: vi
        .fn()
        .mockReturnValueOnce(image({ toBitmap: vi.fn(() => bitmap) }))
        .mockReturnValueOnce(template),
    }

    createTrayIcon(images, '/icons/128x128.png', null, 'darwin', {
      runningCount: 2,
      showRunningStatus: true,
    })

    const [renderedBitmap, options] = vi.mocked(images.createFromBitmap).mock.calls[1]
    const meterX = 42
    const alphaAt = (x: number, y: number) => renderedBitmap[(y * options.width + x) * 4 + 3]
    expect(alphaAt(meterX, 2)).toBe(120)
    expect(alphaAt(meterX + 1, 18)).toBe(235)
  })

  test('fills the running task meter at four or more tasks', () => {
    const bitmap = Buffer.alloc(36 * 36 * 4, 255)
    const resized = image({ toBitmap: vi.fn(() => bitmap) })
    const source = image({ resize: vi.fn(() => resized) })
    const template = image()
    const images: NativeImageFactory = {
      createFromPath: vi.fn(() => source),
      createFromBitmap: vi
        .fn()
        .mockReturnValueOnce(image({ toBitmap: vi.fn(() => bitmap) }))
        .mockReturnValueOnce(template),
    }

    createTrayIcon(images, '/icons/128x128.png', null, 'darwin', {
      runningCount: 8,
      showRunningStatus: true,
    })

    const [renderedBitmap, options] = vi.mocked(images.createFromBitmap).mock.calls[1]
    const alphaAt = (x: number, y: number) => renderedBitmap[(y * options.width + x) * 4 + 3]
    expect(alphaAt(41, 3)).toBe(120)
    expect(alphaAt(42, 3)).toBe(235)
  })

  test('keeps the application icon unchanged outside macOS', () => {
    const source = image()
    const images: NativeImageFactory = {
      createFromPath: vi.fn(() => source),
      createFromBitmap: vi.fn(),
    }

    expect(
      createTrayIcon(images, '/icons/128x128.png', null, 'win32', {
        runningCount: 0,
        showRunningStatus: false,
      })
    ).toBe(source)
    expect(source.resize).not.toHaveBeenCalled()
    expect(images.createFromBitmap).not.toHaveBeenCalled()
  })
})
