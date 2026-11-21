import { useContext, useLayoutEffect, useRef, useState } from 'react'
import { createPortal, flushSync } from 'react-dom'
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FolderOpen,
  ImageIcon,
  Loader2,
  PanelRightOpen,
  X,
} from 'lucide-react'
import type { AttachmentImageLightboxProps } from '@wegent/collaboration'
import { DialogSurface } from '@wegent/collaboration/controls/DialogSurface'
import type { Attachment } from '@/types/api'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { ActionMenu } from '@/components/common/ActionMenu'
import { fileManagerRevealLabel } from '@/lib/file-manager'
import { LOCAL_WORKSPACE_OPENERS } from '@/lib/local-workspace-openers'
import { openLocalFile, revealLocalFile } from '@/lib/local-terminal'
import { useLocalWorkspaceOpeners } from '@/hooks/useLocalWorkspaceOpeners'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { AttachmentPreviewContext } from '../AttachmentPreviewContext'
import { ImageEditContext, type SavedImageMarkup, type ImageEditActions } from './ImageEditContext'
import { useImagePreviewEditor } from './ImagePreviewEditor'
import type { ImageEdit } from './imageEdit'

const zoomLevels = [25, 50, 100, 150, 200]
const buttonClass =
  'flex min-h-9 shrink-0 items-center gap-2 rounded-full border border-border bg-background px-3 text-sm shadow-sm hover:bg-muted focus-visible:outline focus-visible:outline-2 disabled:opacity-50 max-md:min-h-11'

type DesktopImagePreviewProps = Omit<AttachmentImageLightboxProps<Attachment>, 'attachment'> & {
  attachment: Pick<Attachment, 'mime_type'> & Partial<Pick<Attachment, 'id'>>
  loadFile(): Promise<File>
}

export function DesktopImagePreview(
  props: AttachmentImageLightboxProps<Attachment> & { loadFile(): Promise<File> }
) {
  return createPortal(<ImagePreviewDialog {...props} />, document.body)
}

interface InlineImageEditorProps {
  getEditor?: () => ImageEditActions | null
  onMarkupSaved?: (saved: SavedImageMarkup) => void
}

export function InlineDesktopImagePreview(
  props: Omit<DesktopImagePreviewProps, 'onClose'> & InlineImageEditorProps
) {
  return <ImagePreviewDialog {...props} inline />
}

function ImagePreviewDialog({
  inline = false,
  getEditor,
  onMarkupSaved,
  attachment,
  fromComposer,
  url,
  filename,
  localPath,
  loading,
  loadFile,
  onClose,
  onDownload,
  onError,
  onPrevious,
  onNext,
}: Omit<DesktopImagePreviewProps, 'onClose'> &
  InlineImageEditorProps & {
    inline?: boolean
    onClose?: () => void
  }) {
  const { t } = useTranslation('common')
  const openPanel = useContext(AttachmentPreviewContext)
  const submissionContext = useContext(ImageEditContext)
  const resolveEditor = () => (inline ? (getEditor?.() ?? null) : submissionContext)
  const editSubmission = resolveEditor()
  const composerAttachmentId = fromComposer ? attachment.id : undefined
  const [zoom, setZoom] = useState<number | null>(null)
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null)
  const [fitZoom, setFitZoom] = useState(100)
  const viewport = useRef<HTMLDivElement>(null)
  const imageElement = useRef<HTMLImageElement>(null)
  const [menuContainer, setMenuContainer] = useState<HTMLDivElement | null>(null)
  const [openWith, setOpenWith] = useState(false)
  const { data: openers } = useLocalWorkspaceOpeners(Boolean(localPath && openWith))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const request = useRef<AbortController | null>(null)
  useLayoutEffect(
    () => () => {
      request.current?.abort()
      request.current = null
    },
    []
  )

  useLayoutEffect(() => {
    const element = viewport.current
    if (!element || !imageSize || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      const { width, height } = entry.contentRect
      setFitZoom(Math.min(100, (100 * width) / imageSize.width, (100 * height) / imageSize.height))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [imageSize])

  const scale = (zoom ?? fitZoom) / 100
  useLayoutEffect(() => {
    const element = viewport.current
    if (!element || !url || !imageSize) return
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return
      event.preventDefault()
      event.stopPropagation()
      const image = imageElement.current
      if (!image) return
      const zoomPercent = scale * 100
      const next = Math.min(
        400,
        Math.max(10, Math.round(zoomPercent * Math.exp(-event.deltaY * 0.01)))
      )
      if (next === zoomPercent) return

      const before = image.getBoundingClientRect()
      if (!before.width || !before.height) return
      const x = Math.min(1, Math.max(0, (event.clientX - before.left) / before.width))
      const y = Math.min(1, Math.max(0, (event.clientY - before.top) / before.height))
      flushSync(() => setZoom(next))
      const after = image.getBoundingClientRect()
      element.scrollLeft += after.left + x * after.width - event.clientX
      element.scrollTop += after.top + y * after.height - event.clientY
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [imageSize, scale, url])

  async function runEdit(edit: ImageEdit, resetEditor: () => void) {
    const editSubmission = resolveEditor()
    if (!editSubmission || request.current) return
    const submission = new AbortController()
    request.current = submission
    setBusy(true)
    setError(null)
    const saving = composerAttachmentId !== undefined && edit.kind === 'markup'
    const errorMessage = t(saving ? 'image_preview.save_failed' : 'image_preview.edit_failed')
    try {
      const result = saving
        ? await editSubmission.saveMarkup?.(composerAttachmentId, loadFile, edit, submission.signal)
        : await editSubmission.submit(
            {
              name: filename,
              mimeType: attachment.mime_type,
              loadFile,
              draftAttachmentId: composerAttachmentId,
            },
            edit
          )
      if (request.current !== submission) return
      if (result) {
        if (inline) {
          if (typeof result !== 'boolean') onMarkupSaved?.(result)
          resetEditor()
        } else onClose?.()
      } else setError(errorMessage)
    } catch {
      if (request.current === submission) setError(errorMessage)
    } finally {
      if (request.current === submission) {
        request.current = null
        setBusy(false)
      }
    }
  }

  const editor = useImagePreviewEditor(
    (edit, reset) => void runEdit(edit, reset),
    busy,
    inline ? null : menuContainer,
    imageSize,
    inline,
    composerAttachmentId !== undefined
  )
  function runAction(action: () => Promise<unknown>) {
    setError(null)
    void action().catch(() => setError(t('image_preview.action_failed')))
  }

  const surface = (
    <div
      role={inline ? 'region' : undefined}
      aria-label={filename}
      tabIndex={-1}
      data-testid={inline ? 'attachment-image-side-viewer' : 'attachment-image-lightbox'}
      className={cn(
        'flex min-h-0 min-w-0 flex-col overflow-hidden text-foreground',
        inline
          ? 'relative flex-1 bg-background'
          : 'fixed inset-0 z-modal bg-background/85 backdrop-blur-[2px]'
      )}
      // A portal opened by a composer attachment still bubbles to the composer in React.
      onSubmit={event => event.stopPropagation()}
      onKeyDown={event => {
        if (inline && event.key === 'Escape' && editor.mode && !busy) {
          event.stopPropagation()
          editor.cancel()
          return
        }
        if ((event.target as HTMLElement).closest('select, textarea') || editor.mode || busy) return
        if (event.key === 'ArrowLeft') onPrevious?.()
        if (event.key === 'ArrowRight') onNext?.()
      }}
    />
  )

  return (
    <DialogSurface
      active={!inline}
      initialFocus='[data-testid="attachment-image-lightbox-close"]'
      onClose={() => {
        if (editor.mode && !busy) editor.cancel()
        else onClose?.()
      }}
      render={surface}
    >
      <header
        className={cn(
          'relative z-20 flex h-11 shrink-0 items-center justify-between gap-2 px-2',
          !inline && 'pl-24 [-webkit-app-region:drag] max-md:pl-2'
        )}
      >
        <span
          className="flex min-w-0 items-center gap-2 rounded-full border border-border bg-background px-3 py-2 text-sm font-medium shadow-sm"
          title={filename}
        >
          <ImageIcon className="size-4 shrink-0" />
          <span className="truncate">{inline ? filename : t('image_preview.image')}</span>
        </span>
        <div className="flex shrink-0 items-center gap-1.5 [-webkit-app-region:no-drag]">
          <label className={buttonClass}>
            <select
              data-testid="attachment-image-zoom-value"
              aria-label={t('image_preview.zoom')}
              className="appearance-none bg-transparent outline-none"
              value={zoom ?? ''}
              onChange={event => setZoom(event.target.value ? Number(event.target.value) : null)}
            >
              <option value="">
                {Math.round(fitZoom)}% · {t('image_preview.fit')}
              </option>
              {zoomLevels.map(level => (
                <option key={level} value={level}>
                  {level}%
                </option>
              ))}
              {zoom !== null && !zoomLevels.includes(zoom) && <option value={zoom}>{zoom}%</option>}
            </select>
            <ChevronDown className="size-3.5 pointer-events-none" />
          </label>
          {localPath && (
            <div className="flex items-center rounded-full border border-border bg-background shadow-sm">
              <button
                type="button"
                className="flex min-h-9 items-center gap-1.5 rounded-s-full px-3 text-sm hover:bg-muted max-md:min-h-11"
                data-testid="attachment-image-open"
                onClick={() => runAction(() => openLocalFile(localPath))}
              >
                <ExternalLink className="size-4" />
                {t('image_preview.open')}
              </button>
              <ActionMenu
                ariaLabel={t('image_preview.open_with')}
                testId="attachment-image-open-with"
                triggerClassName="grid min-h-9 w-8 place-items-center rounded-e-full border-s border-border hover:bg-muted max-md:min-h-11"
                icon={ChevronDown}
                placement="bottom-end"
                portalContainer={inline ? null : menuContainer}
                onOpenChange={setOpenWith}
                items={[
                  ...LOCAL_WORKSPACE_OPENERS.filter(
                    opener =>
                      opener.category === 'general' &&
                      openers?.some(item => item.id === opener.id && item.available)
                  ).map(opener => ({
                    testId: `attachment-image-open-with-${opener.id}`,
                    label: opener.label,
                    onSelect: () =>
                      runAction(() =>
                        invokeDesktopHost('workspace.openFile', {
                          path: localPath,
                          opener: opener.id,
                        })
                      ),
                  })),
                  {
                    testId: 'attachment-image-reveal',
                    label: fileManagerRevealLabel(t),
                    icon: FolderOpen,
                    onSelect: () => runAction(() => revealLocalFile(localPath)),
                  },
                ]}
              />
            </div>
          )}
          <button
            type="button"
            className={buttonClass}
            data-testid={
              inline ? 'composer-attachment-preview-download' : 'attachment-image-download'
            }
            aria-label={t('image_preview.download')}
            disabled={!url}
            onClick={() => runAction(onDownload)}
          >
            <Download className="size-4" />
          </button>
          {!inline && openPanel && (
            <button
              type="button"
              className={buttonClass}
              data-testid="attachment-image-open-in-panel"
              aria-label={t('image_preview.open_panel')}
              disabled={!url || busy}
              onClick={() => {
                openPanel({
                  filename,
                  contentType: attachment.mime_type,
                  loadFile,
                  image: {
                    localPath,
                    draftAttachmentId: composerAttachmentId,
                    getEditor: () => {
                      const current = editSubmission?.current
                        ? editSubmission.current()
                        : editSubmission
                      return current?.scope === editSubmission?.scope ? current : null
                    },
                  },
                })
                onClose?.()
              }}
            >
              <PanelRightOpen className="size-4" />
              <span className="max-md:hidden">{t('image_preview.open_panel')}</span>
            </button>
          )}
          {!inline && (
            <button
              type="button"
              className={buttonClass}
              data-testid="attachment-image-lightbox-close"
              aria-label={t('image_preview.close')}
              onClick={onClose}
            >
              <X className="size-4" />
            </button>
          )}
        </div>
      </header>
      <div
        ref={viewport}
        className={cn('flex min-h-0 flex-1 overflow-auto pb-10', inline ? 'px-2' : 'px-10')}
        onClick={event => {
          if (!inline && event.target === event.currentTarget) onClose?.()
        }}
      >
        {url ? (
          <div className="relative m-auto w-fit shrink-0">
            <img
              ref={imageElement}
              data-testid="attachment-image-lightbox-image"
              src={url}
              alt={filename}
              data-context-image-filename={filename}
              data-context-image-local-path={localPath ?? undefined}
              className="block max-w-none select-none object-contain shadow-lg"
              style={
                imageSize
                  ? { width: imageSize.width * scale, height: imageSize.height * scale }
                  : undefined
              }
              draggable={false}
              onLoad={event => {
                const { naturalWidth, naturalHeight } = event.currentTarget
                if (naturalWidth > 0 && naturalHeight > 0) {
                  setImageSize({ width: naturalWidth, height: naturalHeight })
                }
              }}
              onError={onError}
            />
            {editSubmission && editor.surface}
          </div>
        ) : (
          <div
            className="m-auto flex items-center gap-2 text-sm text-muted-foreground"
            role="status"
          >
            {loading ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <ImageIcon className="size-4" />
            )}
            {t(loading ? 'image_preview.loading' : 'image_preview.load_failed')}
          </div>
        )}
      </div>
      {onPrevious && onNext && !editor.mode && !busy && (
        <>
          <button
            type="button"
            className={`${buttonClass} absolute left-2 top-1/2`}
            data-testid="attachment-image-previous"
            aria-label={t('image_preview.previous')}
            onClick={onPrevious}
          >
            <ChevronLeft className="size-4" />
          </button>
          <button
            type="button"
            className={`${buttonClass} absolute right-2 top-1/2`}
            data-testid="attachment-image-next"
            aria-label={t('image_preview.next')}
            onClick={onNext}
          >
            <ChevronRight className="size-4" />
          </button>
        </>
      )}
      <div ref={setMenuContainer} />
      {url && editSubmission && editor.toolbar}
      {(error || busy) && (
        <div
          className="absolute inset-x-2 bottom-20 z-20 mx-auto w-fit rounded-lg bg-popover px-3 py-2 text-sm shadow-md"
          role={error ? 'alert' : 'status'}
        >
          {error ??
            t(
              composerAttachmentId !== undefined && editor.mode === 'markup'
                ? 'image_preview.saving'
                : 'image_preview.sending'
            )}
        </div>
      )}
    </DialogSurface>
  )
}
