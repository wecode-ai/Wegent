import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Download, X } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'

type PreviewKind = 'text' | 'image' | 'pdf' | 'unsupported'

const TEXT_FILE_EXTENSION =
  /\.(?:c|cc|cpp|css|csv|go|h|hpp|html?|ini|java|js|jsx|json|log|md|py|rb|rs|sh|sql|toml|ts|tsx|txt|xml|ya?ml)$/i

function previewKind(filename: string, contentType: string | null): PreviewKind {
  const normalizedType = contentType?.toLowerCase() ?? ''
  if (normalizedType.startsWith('image/')) return 'image'
  if (normalizedType === 'application/pdf' || /\.pdf$/i.test(filename)) return 'pdf'
  if (
    normalizedType.startsWith('text/') ||
    normalizedType.includes('json') ||
    normalizedType.includes('javascript') ||
    normalizedType.includes('xml') ||
    TEXT_FILE_EXTENSION.test(filename)
  ) {
    return 'text'
  }
  return 'unsupported'
}

export function CloudFilePreviewDialog({
  filename,
  contentType,
  loadFile,
  onDownload,
  onClose,
}: {
  filename: string
  contentType: string | null
  loadFile: () => Promise<Blob>
  onDownload: () => Promise<void>
  onClose: () => void
}) {
  const { t } = useTranslation('common')
  const [loading, setLoading] = useState(true)
  const [downloading, setDownloading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const kind = previewKind(filename, contentType)

  useEffect(() => {
    let active = true
    let url: string | null = null
    void loadFile()
      .then(async blob => {
        if (!active) return
        if (kind === 'text') {
          const content = await blob.text()
          if (active) setText(content)
        } else if (kind === 'image' || kind === 'pdf') {
          url = URL.createObjectURL(blob)
          setObjectUrl(url)
        }
      })
      .catch(cause => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [kind, loadFile])

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
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
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
          <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">
            {filename}
          </h2>
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
          {loading ? (
            <div className="flex h-full items-center justify-center text-sm text-text-muted">
              {t('todo.file_preview_loading', '正在加载预览…')}
            </div>
          ) : error ? (
            <div className="flex h-full items-center justify-center px-6 text-sm text-destructive">
              {error}
            </div>
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
