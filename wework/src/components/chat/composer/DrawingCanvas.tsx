import { Excalidraw, exportToBlob } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import '@excalidraw/excalidraw/index.css'
import { forwardRef, useImperativeHandle, useRef } from 'react'
import { useOptionalAppearance } from '@/features/appearance'
import { useTranslation } from '@/hooks/useTranslation'
import './drawing-canvas.css'

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH: string
  }
}

// Fonts ship with the app so drawing and PNG export work without a CDN connection.
window.EXCALIDRAW_ASSET_PATH = `${import.meta.env.BASE_URL}assets/excalidraw/`

export interface DrawingCanvasHandle {
  exportImage: () => Promise<File>
}

export const DrawingCanvas = forwardRef<
  DrawingCanvasHandle,
  { onContentChange: (hasContent: boolean) => void }
>(function DrawingCanvas({ onContentChange }, ref) {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const { i18n } = useTranslation('common')
  const theme = useOptionalAppearance()?.resolvedMode ?? 'light'

  useImperativeHandle(ref, () => ({
    exportImage: async () => {
      const api = apiRef.current
      const elements = api?.getSceneElements().filter(element => !element.isDeleted) ?? []
      if (!api || !elements.length) throw new Error('The drawing is empty')
      const blob = await exportToBlob({
        elements,
        files: api.getFiles(),
        appState: {
          ...api.getAppState(),
          exportBackground: true,
          exportWithDarkMode: false,
          viewBackgroundColor: '#ffffff',
        },
        mimeType: 'image/png',
        exportPadding: 24,
        maxWidthOrHeight: 4096,
      })
      return new File([blob], `drawing-${crypto.randomUUID()}.png`, { type: 'image/png' })
    },
  }))

  return (
    <div className="drawing-canvas h-full w-full" data-testid="drawing-canvas">
      <Excalidraw
        excalidrawAPI={api => {
          apiRef.current = api
        }}
        initialData={{
          appState: {
            activeTool: { type: 'freedraw', customType: null, locked: false, lastActiveTool: null },
            viewBackgroundColor: '#ffffff',
            currentItemStrokeColor: '#1e1e1e',
          },
        }}
        langCode={i18n.language.startsWith('zh') ? 'zh-CN' : 'en'}
        theme={theme}
        autoFocus
        handleKeyboardGlobally={false}
        onChange={elements => onContentChange(elements.some(element => !element.isDeleted))}
        UIOptions={{
          canvasActions: {
            export: false,
            loadScene: false,
            saveToActiveFile: false,
            saveAsImage: false,
            toggleTheme: false,
            changeViewBackgroundColor: false,
          },
        }}
      />
    </div>
  )
})
