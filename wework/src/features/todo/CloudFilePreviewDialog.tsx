import { useTranslation } from '@/hooks/useTranslation'
import {
  IssueActivityMarkdown,
  createCollaborationTranslator,
  useAttachmentPreview,
} from '@wegent/collaboration'
import { DialogSurface } from '@wegent/collaboration/controls/DialogSurface'
import { createBodyFlagRef } from '@wegent/collaboration/dom-events'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { Download, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'

const markFilePreviewOpen = createBodyFlagRef('data-wework-file-preview-open')

export function CloudFilePreviewDialog({
  filename,
  contentType,
  sizeLabel,
  loadFile,
  onDownload,
  onClose,
}: {
  filename: string
  contentType: string | null
  sizeLabel?: string | null
  loadFile: () => Promise<Blob>
  onDownload: () => Promise<void>
  onClose: () => void
}) {
  const { t, i18n } = useTranslation('common')
  const translate = createCollaborationTranslator(i18n.language.startsWith('zh') ? 'zh-CN' : 'en')
  const [downloadState, setDownloadState] = useState<{
    source: typeof loadFile
    pending: boolean
    error?: string
  } | null>(null)
  const downloading = downloadState?.source === loadFile && downloadState.pending
  const downloadError = downloadState?.source === loadFile ? downloadState.error : undefined
  const { preview, failed, errorMessage, loading, markLoaded, markFailed, retry } =
    useAttachmentPreview(loadFile, filename, contentType)
  const kind = preview?.kind
  const text = preview?.text ?? ''
  const objectUrl = preview?.url
  const dialogRef = useRef<HTMLElement>(null)

  async function download() {
    const source = loadFile
    setDownloadState({ source, pending: true })
    const finish = (error?: string) =>
      setDownloadState(current =>
        current?.source === source ? { source, pending: false, error } : current
      )
    try {
      await onDownload()
      finish()
    } catch (cause) {
      finish(cause instanceof Error ? cause.message : t('todo.file_preview_failed', '预览失败'))
    }
  }

  return createPortal(
    <div
      ref={markFilePreviewOpen}
      data-wework-file-preview
      className="fixed inset-0 z-system flex items-center justify-center bg-black/35 p-6 backdrop-blur-sm"
      onMouseDown={event => event.currentTarget === event.target && onClose()}
    >
      <DialogSurface
        onClose={onClose}
        initialFocus={'[data-testid="cloud-file-preview-close"]'}
        render={
          <section
            ref={dialogRef}
            tabIndex={-1}
            aria-label={filename}
            data-testid="cloud-file-preview-dialog"
            className="flex h-[calc(100vh-72px)] w-[min(960px,calc(100vw-48px))] flex-col overflow-hidden rounded-2xl bg-background shadow-2xl"
          />
        }
      >
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-medium text-text-primary">{filename}</h2>
            {sizeLabel ? (
              <span data-testid="cloud-file-preview-size" className="text-xs text-text-secondary">
                {sizeLabel}
              </span>
            ) : null}
          </div>
          <ControlButton
            variant="outline"
            size="sm"
            type="button"
            data-testid="cloud-file-preview-download"
            disabled={downloading}
            onClick={() => void download()}
            className="flex h-11 items-center gap-1.5 rounded-lg border border-border px-3 text-sm text-text-primary hover:bg-muted disabled:opacity-50 md:h-8"
          >
            <Download className="h-3.5 w-3.5" />
            {downloading ? t('todo.file_downloading', '下载中…') : t('todo.download_file', '下载')}
          </ControlButton>
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid="cloud-file-preview-close"
            onClick={onClose}
            className="flex h-11 w-11 items-center justify-center rounded-lg text-text-secondary hover:bg-muted md:h-8 md:w-8"
            aria-label={t('common.close', '关闭')}
          >
            <X className="h-4 w-4" />
          </ControlButton>
        </header>
        {downloadError ? (
          <p
            role="alert"
            data-testid="cloud-file-preview-download-error"
            className="px-4 py-2 text-sm text-destructive"
          >
            {downloadError}
          </p>
        ) : null}
        <div className="min-h-0 flex-1 overflow-auto bg-muted/20">
          {loading && !preview && !failed ? (
            <div className="flex h-full items-center justify-center text-sm text-text-secondary">
              {t('todo.file_preview_loading', '正在加载预览…')}
            </div>
          ) : failed ? (
            <div className="flex h-full items-center justify-center px-6 text-sm text-destructive">
              {errorMessage ?? t('todo.file_preview_failed', '预览失败')}
              <ControlButton
                variant="unstyled"
                type="button"
                data-testid="cloud-file-preview-retry"
                className="ml-2 min-h-11 min-w-11 underline md:min-h-0 md:min-w-0"
                onClick={retry}
              >
                {translate('attachment.retry')}
              </ControlButton>
            </div>
          ) : kind === 'markdown' ? (
            <article data-testid="cloud-file-preview-markdown" className="min-h-full p-5">
              <IssueActivityMarkdown content={text} variant="document" translate={translate} />
            </article>
          ) : kind === 'text' ? (
            <pre
              data-testid="cloud-file-preview-text"
              className="min-h-full whitespace-pre-wrap break-words p-5 font-mono text-code text-text-primary"
            >
              {text}
            </pre>
          ) : kind === 'image' && objectUrl ? (
            <div className="flex min-h-full items-center justify-center p-5">
              <img
                data-testid="cloud-file-preview-image"
                src={objectUrl}
                alt={filename}
                onLoad={markLoaded}
                onError={markFailed}
                className="max-h-full max-w-full object-contain"
              />
            </div>
          ) : kind === 'pdf' && objectUrl ? (
            <iframe
              data-testid="cloud-file-preview-pdf"
              src={objectUrl}
              title={filename}
              className="h-full w-full border-0"
            />
          ) : (
            <div
              data-testid="cloud-file-preview-unsupported"
              className="flex h-full flex-col items-center justify-center gap-3 px-6 text-sm text-text-secondary"
            >
              <span>{t('todo.file_preview_unsupported', '此文件格式暂不支持预览')}</span>
              <ControlButton
                variant="primary"
                size="sm"
                type="button"
                data-testid="cloud-file-preview-unsupported-download"
                disabled={downloading}
                onClick={() => void download()}
                className="h-11 rounded-lg bg-text-primary px-3 text-sm text-background disabled:opacity-50 md:h-8"
              >
                {t('todo.download_file', '下载')}
              </ControlButton>
            </div>
          )}
        </div>
      </DialogSurface>
    </div>,
    document.body
  )
}
