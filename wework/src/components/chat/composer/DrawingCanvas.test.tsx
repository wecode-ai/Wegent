import '@/i18n'
import { render } from '@testing-library/react'
import { createRef } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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

  it('rejects empty scenes before invoking the renderer', async () => {
    drawing.getSceneElements.mockReturnValue([{ isDeleted: true }])
    const ref = createRef<DrawingCanvasHandle>()
    render(<DrawingCanvas ref={ref} onContentChange={vi.fn()} />)
    await expect(ref.current!.exportImage()).rejects.toThrow('The drawing is empty')
    expect(drawing.exportToBlob).not.toHaveBeenCalled()
  })
})
