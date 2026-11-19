import { useCallback, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { DialogSurface } from '../controls/DialogSurface'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'
import { useCollaborationPortalTheme, useDocumentTheme } from '../theme'
import { Button as ControlButton } from './Button'
import { DiagramCanvas } from './DiagramCanvas'
import { DiagramImageActions } from './DiagramImageActions'
import { useMarkdownServices } from './MarkdownServices'
import type { DiagramArtifact } from './diagramArtifact'
import { DIAGRAM_PREVIEW_HEIGHT_REM, diagramKind } from './diagramLayout'
import { useDiagramArtifact } from './useDiagramArtifact'
import { useDiagramDiagnostics } from './useDiagramDiagnostics'
import { useDiagramViewport } from './useDiagramViewport'

interface MarkdownDiagramPreviewProps {
  code: string
  language: string
  sourceLine?: number
}

export function MarkdownDiagramPreview({
  code,
  language,
  sourceLine,
}: MarkdownDiagramPreviewProps) {
  const portalTheme = useCollaborationPortalTheme()
  const documentTheme = useDocumentTheme()
  const { translate: t, theme, plantumlServerUrl } = useMarkdownServices()
  const resolvedTheme = theme === 'system' ? (portalTheme['data-theme'] ?? documentTheme) : theme
  const containerRef = useRef<HTMLElement>(null)
  const renderViewer = useDiagramViewport(containerRef)
  const fullscreenTriggerRef = useRef<HTMLButtonElement>(null)

  const [fullscreen, setFullscreen] = useState(false)
  const diagramType = diagramKind(language) ?? 'mermaid'
  const result = useDiagramArtifact(
    { code, kind: diagramType, theme: resolvedTheme, plantumlServerUrl },
    renderViewer
  )
  const artifact = result.status === 'ready' ? result.artifact : undefined
  const [imageResult, setImageResult] = useState<{
    artifact: DiagramArtifact
    failed: boolean
  } | null>(null)
  const onReady = useCallback(() => {
    if (artifact) setImageResult({ artifact, failed: false })
  }, [artifact])
  const onError = useCallback(() => {
    if (artifact) setImageResult({ artifact, failed: true })
  }, [artifact])
  const failed =
    result.status === 'error' ||
    (imageResult?.artifact === artifact && imageResult?.failed === true)
  const ready = Boolean(artifact && imageResult?.artifact === artifact && !failed)
  useDiagramDiagnostics(containerRef, {
    code,
    language: diagramType,
    theme: resolvedTheme,
    renderViewer,
    fullscreen,
    status: !renderViewer ? 'idle' : failed ? 'error' : ready ? 'ready' : 'loading',
  })

  const closeFullscreen = () => setFullscreen(false)
  const fullscreenExitButtonRef = useRef<HTMLButtonElement>(null)
  const fullscreenDialogRef = useRef<HTMLDivElement>(null)
  const openFullscreen = () => {
    setFullscreen(true)
  }

  const preview = (
    <section
      data-testid="assistant-diagram-preview"
      data-source-line={sourceLine}
      data-language={diagramType}
      data-diagram-status={!renderViewer ? 'idle' : failed ? 'error' : ready ? 'ready' : 'loading'}
      data-scroll-anchor
      ref={containerRef}
      className={cn(
        'relative max-w-full overflow-hidden bg-background',
        fullscreen ? 'h-full w-full' : 'mb-3 mt-2 rounded-lg border border-border'
      )}
      style={fullscreen ? undefined : { height: `${DIAGRAM_PREVIEW_HEIGHT_REM}rem` }}
    >
      <span hidden data-diagram-search-source>
        {code}
      </span>
      {artifact && !failed && (
        <DiagramCanvas
          artifact={artifact}
          fullscreen={fullscreen}
          onReady={onReady}
          onError={onError}
        />
      )}
      {renderViewer && !ready && (
        <div
          data-search-excluded
          className="absolute inset-0 overflow-auto bg-background p-4"
          role={failed ? 'alert' : 'status'}
        >
          <p className="text-sm text-text-secondary">
            {failed
              ? diagramType === 'plantuml' && !plantumlServerUrl
                ? t(
                    'workbench.plantuml_unconfigured',
                    'PlantUML 预览需要配置渲染服务，当前可查看源码'
                  )
                : t('workbench.diagram_render_failed', '图表渲染失败，源码如下')
              : t('workbench.diagram_loading', '正在渲染图表…')}
          </p>
          {failed && (
            <>
              <ControlButton
                variant="outline"
                size="sm"
                type="button"
                data-testid="diagram-retry-button"
                onClick={() => {
                  setImageResult(null)
                  result.retry()
                }}
                className="mt-2 min-h-11 rounded-md border border-border px-3 text-sm md:min-h-7"
              >
                {t('workbench.diagram_retry', '重试')}
              </ControlButton>
              <pre className="mt-3 whitespace-pre-wrap text-code">{code}</pre>
            </>
          )}
        </div>
      )}
      {renderViewer && (
        <DiagramImageActions
          getArtifact={artifact && ready ? () => artifact : undefined}
          filename={`${diagramType}-diagram.png`}
          theme={resolvedTheme}
          fullscreen={fullscreen}
          fullscreenButtonRef={fullscreen ? undefined : fullscreenTriggerRef}
          onToggleFullscreen={fullscreen ? closeFullscreen : openFullscreen}
        />
      )}
    </section>
  )

  return (
    <>
      {fullscreen ? (
        <div
          aria-hidden="true"
          className="mb-3 mt-2 max-w-full"
          style={{ height: `${DIAGRAM_PREVIEW_HEIGHT_REM}rem` }}
        />
      ) : (
        preview
      )}
      {fullscreen && typeof document !== 'undefined'
        ? createPortal(
            <DialogSurface
              initialFocus={() => fullscreenExitButtonRef.current}
              finalFocus={() => fullscreenTriggerRef.current}
              onClose={() => {
                if (fullscreen) closeFullscreen()
              }}
              render={
                <div
                  {...portalTheme}
                  ref={fullscreenDialogRef}
                  data-testid="assistant-diagram-fullscreen"
                  aria-label={t('workbench.diagram_full_screen', '全屏查看')}
                  tabIndex={-1}
                  className={`${portalTheme.className} fixed inset-0 z-modal h-dvh w-dvw bg-background`}
                />
              }
            >
              {preview}
            </DialogSurface>,
            document.body
          )
        : null}
    </>
  )
}
