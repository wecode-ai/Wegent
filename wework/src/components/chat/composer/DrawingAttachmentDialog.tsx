import { Check, Loader2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { useDialogKeyboard } from '@/hooks/useDialogKeyboard'
import { useTranslation } from '@/hooks/useTranslation'
import type { DrawingCanvasHandle } from './DrawingCanvas'

interface DrawingAttachmentDialogProps {
  disabled?: boolean
  onClose: () => void
  onAttach: (file: File) => void | Promise<void>
}

export function DrawingAttachmentDialog({
  disabled = false,
  onClose,
  onAttach,
}: DrawingAttachmentDialogProps) {
  const { t } = useTranslation('common')
  const [canvasModule, setCanvasModule] = useState<typeof import('./DrawingCanvas') | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hasContent, setHasContent] = useState(false)
  const [exporting, setExporting] = useState(false)
  const busyRef = useRef(false)
  const canvasRef = useRef<DrawingCanvasHandle>(null)
  const dialogRef = useDialogKeyboard<HTMLDivElement>(() => {
    if (!busyRef.current) onClose()
  })

  useEffect(() => {
    let active = true
    void import('./DrawingCanvas').then(
      module => {
        if (active) setCanvasModule(module)
      },
      () => {
        if (active) setError(t('workbench.drawing.load_error'))
      }
    )
    return () => {
      active = false
    }
  }, [t])

  const attachDrawing = async () => {
    if (!canvasRef.current || !hasContent || disabled || busyRef.current) return
    busyRef.current = true
    setExporting(true)
    setError(null)
    try {
      const file = await canvasRef.current.exportImage()
      await onAttach(file)
      onClose()
    } catch {
      setError(t('workbench.drawing.export_error'))
    } finally {
      busyRef.current = false
      setExporting(false)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/20 p-4 max-md:p-0">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="drawing-attachment-title"
        aria-busy={exporting}
        tabIndex={-1}
        data-testid="drawing-attachment-dialog"
        className="flex h-[min(800px,90dvh)] w-[min(1100px,92vw)] flex-col overflow-hidden rounded-[20px] border border-border bg-background text-text-primary shadow-lg max-md:h-dvh max-md:w-full max-md:rounded-none"
      >
        <div className="flex shrink-0 items-center justify-between px-4 py-2">
          <h2 id="drawing-attachment-title" className="text-base font-medium">
            {t('workbench.drawing.title')}
          </h2>
          <Tooltip label={t('workbench.drawing.cancel')}>
            <Button
              variant="ghost"
              size="icon"
              data-testid="drawing-cancel-button"
              aria-label={t('workbench.drawing.cancel')}
              disabled={exporting}
              onClick={onClose}
              className="h-8 w-8 max-md:h-11 max-md:w-11"
            >
              <X aria-hidden="true" />
            </Button>
          </Tooltip>
        </div>
        <div
          className="relative min-h-0 flex-1"
          data-testid="drawing-canvas-container"
          inert={exporting}
        >
          {canvasModule ? (
            <canvasModule.DrawingCanvas ref={canvasRef} onContentChange={setHasContent} />
          ) : !error ? (
            <div
              role="status"
              data-testid="drawing-loading"
              className="flex h-full items-center justify-center gap-2 text-sm text-text-secondary"
            >
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
              {t('workbench.drawing.loading')}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center justify-end gap-3 px-4 py-3">
          {error ? (
            <p
              role="alert"
              data-testid="drawing-error"
              className="mr-auto text-sm text-destructive"
            >
              {error}
            </p>
          ) : null}
          <Button
            data-testid="drawing-confirm-button"
            onClick={() => void attachDrawing()}
            disabled={!hasContent || disabled || exporting}
            className="max-md:min-h-11"
          >
            {exporting ? (
              <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
            ) : (
              <Check aria-hidden="true" />
            )}
            {t('workbench.drawing.attach')}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  )
}
