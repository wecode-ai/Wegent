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
      createFromDataURL: vi.fn(),
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

  test('renders two usage lines into the macOS template image', () => {
    const bitmap = Buffer.alloc(36 * 36 * 4, 255)
    const resized = image({ toBitmap: vi.fn(() => bitmap) })
    const source = image({ resize: vi.fn(() => resized) })
    const baseIcon = image()
    const rendered = image({
      getSize: vi.fn(() => ({ width: 167, height: 36 })),
      toBitmap: vi.fn(() => Buffer.alloc(167 * 36 * 4)),
    })
    const template = image()
    const createFromDataURL = vi.fn(() => rendered)
    const images: NativeImageFactory = {
      createFromPath: vi.fn(() => source),
      createFromBitmap: vi.fn().mockReturnValueOnce(baseIcon).mockReturnValueOnce(template),
      createFromDataURL,
    }

    expect(createTrayIcon(images, '/icons/128x128.png', 'Codex  79%\nAIGC 845.21', 'darwin')).toBe(
      template
    )
    const svg = Buffer.from(
      createFromDataURL.mock.calls[0][0].replace('data:image/svg+xml;base64,', ''),
      'base64'
    ).toString()
    expect(svg).toContain('font-size="18"')
    expect(svg).toContain('>Codex  79%</text>')
    expect(svg).toContain('>AIGC 845.21</text>')
    expect(images.createFromBitmap).toHaveBeenLastCalledWith(expect.any(Buffer), {
      width: 167,
      height: 36,
      scaleFactor: 2,
    })
    expect(template.setTemplateImage).toHaveBeenCalledWith(true)
  })

  test('renders running task level beside the macOS icon', () => {
    const bitmap = Buffer.alloc(36 * 36 * 4, 255)
    const resized = image({ toBitmap: vi.fn(() => bitmap) })
    const source = image({ resize: vi.fn(() => resized) })
    const baseIcon = image()
    const rendered = image({
      getSize: vi.fn(() => ({ width: 46, height: 36 })),
      toBitmap: vi.fn(() => Buffer.alloc(46 * 36 * 4)),
    })
    const template = image()
    const createFromDataURL = vi.fn(() => rendered)
    const images: NativeImageFactory = {
      createFromPath: vi.fn(() => source),
      createFromBitmap: vi.fn().mockReturnValueOnce(baseIcon).mockReturnValueOnce(template),
      createFromDataURL,
    }

    createTrayIcon(images, '/icons/128x128.png', null, 'darwin', {
      runningCount: 2,
      showRunningStatus: true,
    })

    const svg = Buffer.from(
      createFromDataURL.mock.calls[0][0].replace('data:image/svg+xml;base64,', ''),
      'base64'
    ).toString()
    expect(svg).toContain('<rect x="42" y="18" width="4" height="15"')
    expect(svg).toContain('M41 2h6v32h-6z')
    expect(svg.indexOf('<image')).toBeLessThan(svg.indexOf('M41 2h6v32h-6z'))
  })

  test('fills the running task meter at four or more tasks', () => {
    const bitmap = Buffer.alloc(36 * 36 * 4, 255)
    const resized = image({ toBitmap: vi.fn(() => bitmap) })
    const source = image({ resize: vi.fn(() => resized) })
    const baseIcon = image()
    const rendered = image({
      getSize: vi.fn(() => ({ width: 50, height: 36 })),
      toBitmap: vi.fn(() => Buffer.alloc(50 * 36 * 4)),
    })
    const template = image()
    const createFromDataURL = vi.fn(() => rendered)
    const images: NativeImageFactory = {
      createFromPath: vi.fn(() => source),
      createFromBitmap: vi.fn().mockReturnValueOnce(baseIcon).mockReturnValueOnce(template),
      createFromDataURL,
    }

    createTrayIcon(images, '/icons/128x128.png', null, 'darwin', {
      runningCount: 8,
      showRunningStatus: true,
    })

    const svg = Buffer.from(
      createFromDataURL.mock.calls[0][0].replace('data:image/svg+xml;base64,', ''),
      'base64'
    ).toString()
    expect(svg).toContain('<rect x="42" y="3" width="4" height="30"')
  })

  test('keeps the application icon unchanged outside macOS', () => {
    const source = image()
    const images: NativeImageFactory = {
      createFromPath: vi.fn(() => source),
      createFromBitmap: vi.fn(),
      createFromDataURL: vi.fn(),
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
