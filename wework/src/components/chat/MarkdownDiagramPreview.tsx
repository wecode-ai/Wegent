import FileViewer from '@file-viewer/react'
import engineeringRenderers from '@file-viewer/preset-engineering'
import { useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { DiagramImageActions } from './DiagramImageActions'
import { getRuntimeConfig } from '@/config/runtime'
import { useOptionalAppearance } from '@/features/appearance'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'

interface MarkdownDiagramPreviewProps {
  code: string
  language: string
}

export function MarkdownDiagramPreview({ code, language }: MarkdownDiagramPreviewProps) {
  const { t } = useTranslation()
  const appearance = useOptionalAppearance()
  const theme: 'dark' | 'light' | 'system' = appearance?.resolvedMode ?? 'system'
  const containerRef = useRef<HTMLElement>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const normalizedLanguage = language.toLowerCase()
  const diagramType =
    normalizedLanguage === 'mmd' || normalizedLanguage === 'mermaid' ? 'mermaid' : 'plantuml'
  const file = useMemo(
    () =>
      new File([code], `diagram.${diagramType}`, {
        type: 'text/plain',
      }),
    [code, diagramType]
  )
  const options = useMemo(
    () => ({
      preset: [engineeringRenderers],
      drawing: { plantumlServerUrl: getRuntimeConfig().plantumlServerUrl },
      theme,
    }),
    [theme]
  )

  useEscapeKey(() => setFullscreen(false), fullscreen)

  const preview = (
    <section
      data-testid="assistant-diagram-preview"
      data-language={diagramType}
      data-scroll-anchor
      ref={containerRef}
      className={cn(
        'wework-diagram-preview relative max-w-full overflow-hidden bg-background',
        fullscreen ? 'h-full w-full' : 'mb-3 mt-2 h-96 rounded-lg border border-border'
      )}
    >
      <FileViewer
        file={file}
        filename={file.name}
        type={diagramType}
        size={file.size}
        className="h-full w-full"
        options={options}
      />
      <DiagramImageActions
        containerRef={containerRef}
        filename={`${diagramType}-diagram.png`}
        theme={theme}
        fullscreen={fullscreen}
        onToggleFullscreen={() => setFullscreen(current => !current)}
      />
    </section>
  )

  return (
    <>
      {fullscreen ? <div aria-hidden="true" className="mb-3 mt-2 h-96 max-w-full" /> : preview}
      {fullscreen && typeof document !== 'undefined'
        ? createPortal(
            <div
              data-testid="assistant-diagram-fullscreen"
              role="dialog"
              aria-modal="true"
              aria-label={t('workbench.diagram_full_screen', '全屏查看')}
              className="fixed inset-0 z-modal h-dvh w-dvw bg-background"
            >
              {preview}
            </div>,
            document.body
          )
        : null}
    </>
  )
}
