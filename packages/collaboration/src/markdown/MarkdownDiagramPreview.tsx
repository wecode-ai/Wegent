import { useCollaborationPortalTheme, useDocumentTheme } from '../theme'
import { useMarkdownServices } from './MarkdownServices'
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { DiagramImageActions } from './DiagramImageActions'
import { useEscapeKey } from './useEscapeKey'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'
import { useDiagramViewport } from './useDiagramViewport'
import { useDiagramDiagnostics } from './useDiagramDiagnostics'
import { useDiagramArtifact } from './useDiagramArtifact'
import { diagramKind, DIAGRAM_PREVIEW_HEIGHT_REM } from './diagramLayout'
import { DiagramCanvas } from './DiagramCanvas'
import type { DiagramArtifact } from './diagramArtifact'

interface MarkdownDiagramPreviewProps {
  code: string
  language: string
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

export function MarkdownDiagramPreview({ code, language }: MarkdownDiagramPreviewProps) {
  const portalTheme = useCollaborationPortalTheme()
  const documentTheme = useDocumentTheme()
  const { translate: t, theme, plantumlServerUrl } = useMarkdownServices()
  const resolvedTheme = theme === 'system' ? (portalTheme['data-theme'] ?? documentTheme) : theme
  const containerRef = useRef<HTMLElement>(null)
  const renderViewer = useDiagramViewport(containerRef)
  const fullscreenDialogRef = useRef<HTMLDivElement>(null)
  const fullscreenExitButtonRef = useRef<HTMLButtonElement>(null)
  const fullscreenTriggerRef = useRef<HTMLButtonElement>(null)
  const restoreFullscreenFocusRef = useRef(false)
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
  const openFullscreen = () => {
    restoreFullscreenFocusRef.current = true
    setFullscreen(true)
  }

  useEscapeKey(closeFullscreen, fullscreen, fullscreenDialogRef)

  useEffect(() => {
    if (fullscreen) {
      const frameId = window.requestAnimationFrame(() => {
        fullscreenExitButtonRef.current?.focus()
      })
      return () => window.cancelAnimationFrame(frameId)
    }
    if (!restoreFullscreenFocusRef.current) return

    restoreFullscreenFocusRef.current = false
    const frameId = window.requestAnimationFrame(() => fullscreenTriggerRef.current?.focus())
    return () => window.cancelAnimationFrame(frameId)
  }, [fullscreen])

  const handleFullscreenKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return

    const focusableElements = Array.from(
      fullscreenDialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? []
    )
    if (focusableElements.length === 0) {
      event.preventDefault()
      fullscreenDialogRef.current?.focus()
      return
    }

    const firstElement = focusableElements[0]
    const lastElement = focusableElements[focusableElements.length - 1]
    if (event.shiftKey && document.activeElement === firstElement) {
      event.preventDefault()
      lastElement.focus()
    } else if (!event.shiftKey && document.activeElement === lastElement) {
      event.preventDefault()
      firstElement.focus()
    }
  }

  const preview = (
    <section
      data-testid="assistant-diagram-preview"
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
        <DiagramCanvas artifact={artifact} onReady={onReady} onError={onError} />
      )}
      {renderViewer && !ready && (
        <div
          data-search-excluded
          className="absolute inset-0 overflow-auto bg-background p-4"
          role={failed ? 'alert' : 'status'}
        >
          <p className="text-sm text-text-secondary">
            {failed
              ? t('workbench.diagram_render_failed', '图表渲染失败，源码如下')
              : t('workbench.diagram_loading', '正在渲染图表…')}
          </p>
          {failed && (
            <>
              <button
                type="button"
                data-testid="diagram-retry-button"
                onClick={() => {
                  setImageResult(null)
                  result.retry()
                }}
                className="mt-2 min-h-11 rounded-md border border-border px-3 text-sm md:min-h-7"
              >
                {t('workbench.diagram_retry', '重试')}
              </button>
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
          fullscreenButtonRef={fullscreen ? fullscreenExitButtonRef : fullscreenTriggerRef}
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
            <div
              {...portalTheme}
              ref={fullscreenDialogRef}
              data-testid="assistant-diagram-fullscreen"
              role="dialog"
              aria-modal="true"
              aria-label={t('workbench.diagram_full_screen', '全屏查看')}
              tabIndex={-1}
              onKeyDown={handleFullscreenKeyDown}
              className={`${portalTheme.className} fixed inset-0 z-modal h-dvh w-dvw bg-background`}
            >
              {preview}
            </div>,
            document.body
          )
        : null}
    </>
  )
}
