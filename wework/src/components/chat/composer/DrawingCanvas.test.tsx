import { act, render } from '@testing-library/react'
import { createRef } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { DrawingCanvas, type DrawingCanvasHandle } from './DrawingCanvas'

const drawing = vi.hoisted(() => ({
  exportToBlob: vi.fn(),
  getSceneElements: vi.fn(),
  getAppState: vi.fn(() => ({ exportWithDarkMode: true })),
  getFiles: vi.fn(() => ({})),
}))

vi.mock('@excalidraw/excalidraw', async () => {
  const { useEffect } = await import('react')
  return {
    exportToBlob: drawing.exportToBlob,
    Excalidraw: ({ excalidrawAPI }: { excalidrawAPI: (api: typeof drawing) => void }) => {
      useEffect(() => {
        excalidrawAPI(drawing)
      }, [excalidrawAPI])
      return null
    },
  }
})

describe('DrawingCanvas export', () => {
  beforeEach(() => {
    drawing.getSceneElements.mockReset()
    drawing.exportToBlob.mockReset()
    drawing.exportToBlob.mockResolvedValue(new Blob(['png'], { type: 'image/png' }))
  })

  it('exports a bounded white PNG and excludes deleted elements', async () => {
    const element = { id: 'stroke', isDeleted: false }
    drawing.getSceneElements.mockReturnValue([element, { id: 'deleted', isDeleted: true }])
    const ref = createRef<DrawingCanvasHandle>()
    render(<DrawingCanvas ref={ref} onContentChange={vi.fn()} />)
    let file!: File
    await act(async () => {
      file = await ref.current!.exportImage()
    })
    expect(file.name).toMatch(/^drawing-.+\.png$/)
    expect(file.type).toBe('image/png')
    expect(file.size).toBeGreaterThan(0)
    expect(drawing.exportToBlob).toHaveBeenCalledWith(
      expect.objectContaining({
        elements: [element],
        mimeType: 'image/png',
        maxWidthOrHeight: 4096,
        appState: expect.objectContaining({
          exportBackground: true,
          exportWithDarkMode: false,
          viewBackgroundColor: '#ffffff',
        }),
      })
    )
    expect(window.EXCALIDRAW_ASSET_PATH).toBe('/assets/excalidraw/')
  })

  it('rejects empty scenes before invoking the renderer', async () => {
    drawing.getSceneElements.mockReturnValue([{ isDeleted: true }])
    const ref = createRef<DrawingCanvasHandle>()
    render(<DrawingCanvas ref={ref} onContentChange={vi.fn()} />)
    await expect(ref.current!.exportImage()).rejects.toThrow('The drawing is empty')
    expect(drawing.exportToBlob).not.toHaveBeenCalled()
  })
})
