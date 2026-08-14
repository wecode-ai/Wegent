import FileViewer from '@file-viewer/react'
import engineeringRenderers from '@file-viewer/preset-engineering'
import { useMemo, useRef } from 'react'
import { DiagramImageActions } from './DiagramImageActions'
import { getRuntimeConfig } from '@/config/runtime'
import { useOptionalAppearance } from '@/features/appearance'

interface MarkdownDiagramPreviewProps {
  code: string
  language: string
}

export function MarkdownDiagramPreview({ code, language }: MarkdownDiagramPreviewProps) {
  const appearance = useOptionalAppearance()
  const theme: 'dark' | 'light' | 'system' = appearance?.resolvedMode ?? 'system'
  const containerRef = useRef<HTMLElement>(null)
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

  return (
    <section
      data-testid="assistant-diagram-preview"
      data-language={diagramType}
      data-scroll-anchor
      ref={containerRef}
      className="wework-diagram-preview relative mb-3 mt-2 h-96 max-w-full overflow-hidden rounded-lg border border-border bg-background"
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
      />
    </section>
  )
}
