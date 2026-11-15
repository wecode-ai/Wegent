import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Download, X } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import {
  IssueActivityMarkdown,
  createCollaborationTranslator,
  useAttachmentPreview,
} from '@wegent/collaboration'

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
  const [downloading, setDownloading] = useState(false)
  const { preview, failed, loading, markLoaded, markFailed, retry } = useAttachmentPreview(
    loadFile,
    filename,
    contentType
  )
  const kind = preview?.kind
  const text = preview?.text ?? ''
  const objectUrl = preview?.url
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  async function download() {
    setDownloading(true)
    setError(null)
    try {
      await onDownload()
    } catch {
      markFailed()
    } finally {
      setDownloading(false)
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-system flex items-center justify-center bg-black/35 p-6 backdrop-blur-sm"
      onMouseDown={event => event.currentTarget === event.target && onClose()}
    >
      <section
        role="dialog"
        aria-label={filename}
        data-testid="cloud-file-preview-dialog"
        className="flex h-[calc(100vh-72px)] w-[min(960px,calc(100vw-48px))] flex-col overflow-hidden rounded-2xl bg-background shadow-2xl"
      >
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-medium text-text-primary">{filename}</h2>
            {sizeLabel ? (
              <span data-testid="cloud-file-preview-size" className="text-xs text-text-muted">
                {sizeLabel}
              </span>
            ) : null}
          </div>
          <button
            type="button"
            data-testid="cloud-file-preview-download"
            disabled={downloading}
            onClick={() => void download()}
            className="flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-sm text-text-primary hover:bg-muted disabled:opacity-50"
          >
            <Download className="h-3.5 w-3.5" />
            {downloading ? t('todo.file_downloading', '下载中…') : t('todo.download_file', '下载')}
          </button>
          <button
            type="button"
            data-testid="cloud-file-preview-close"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted hover:bg-muted"
            aria-label={t('common.close', '关闭')}
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto bg-muted/20">
          {loading && !preview && !failed ? (
            <div className="flex h-full items-center justify-center text-sm text-text-muted">
              {t('todo.file_preview_loading', '正在加载预览…')}
            </div>
          ) : failed ? (
            <div className="flex h-full items-center justify-center px-6 text-sm text-destructive">
              {t('todo.file_preview_failed', '预览失败')}
              <button
                type="button"
                data-testid="cloud-file-preview-retry"
                className="ml-2 underline"
                onClick={retry}
              >
                {translate('attachment.retry')}
              </button>
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
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-sm text-text-muted">
              <span>{t('todo.file_preview_unsupported', '此文件格式暂不支持预览')}</span>
              <button
                type="button"
                disabled={downloading}
                onClick={() => void download()}
                className="h-8 rounded-lg bg-text-primary px-3 text-sm text-background disabled:opacity-50"
              >
                {t('todo.download_file', '下载')}
              </button>
            </div>
          )}
        </div>
      </section>
    </div>,
    document.body
  )
}
