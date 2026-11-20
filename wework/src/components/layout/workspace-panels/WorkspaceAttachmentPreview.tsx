import { useMemo, useState, useSyncExternalStore } from 'react'
import { createAsyncResource } from '@wegent/chat-core/async-resource'
import { Download } from 'lucide-react'
import type {
  WorkspaceAttachmentPreviewSource,
  WorkspaceTextFileResponse,
} from '@/types/workspace-files'
import { useTranslation } from '@/hooks/useTranslation'
import { saveBlobToDownloads } from '@/lib/blobDownload'
import { WorkspaceFilePreview } from './WorkspaceFilePreview'
import { workspaceFilePreviewKind } from './workspaceFileTypes'

export function WorkspaceAttachmentPreview({
  source,
}: {
  source: WorkspaceAttachmentPreviewSource
}) {
  const { t } = useTranslation('common')
  const [revision, setRevision] = useState(0)
  const resource = useMemo(
    () =>
      createAsyncResource('attachment-preview:' + revision, () => loadAttachmentPreview(source)),
    [source, revision]
  )
  const snapshot = useSyncExternalStore(
    resource.subscribe,
    resource.getSnapshot,
    resource.getSnapshot
  )
  const file = snapshot.data?.file ?? null
  const text = snapshot.data?.text ?? null
  const error =
    snapshot.status === 'error'
      ? snapshot.error instanceof Error
        ? snapshot.error.message
        : String(snapshot.error)
      : (snapshot.data?.downloadError ?? null)

  return (
    <section
      data-testid="composer-attachment-preview-panel"
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="min-w-0 flex-1 truncate text-sm" title={source.filename}>
          {source.filename}
        </span>
        <button
          type="button"
          data-testid="composer-attachment-preview-download"
          disabled={!file}
          aria-label={t('todo.download_file')}
          className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted disabled:opacity-50"
          onClick={() => {
            if (file)
              void saveBlobToDownloads(file, file.name).catch(cause => {
                resource.update(previous =>
                  previous ? { ...previous, downloadError: String(cause) } : previous
                )
              })
          }}
        >
          <Download className="h-4 w-4" />
        </button>
      </header>
      <WorkspaceFilePreview
        file={text}
        binaryFile={
          file && !text ? { file, name: file.name, path: file.name, size: file.size } : null
        }
        loading={!file && !error}
        error={error}
        onRetry={() => setRevision(value => value + 1)}
      />
    </section>
  )
}

async function loadAttachmentPreview(source: WorkspaceAttachmentPreviewSource): Promise<{
  file: File
  text: WorkspaceTextFileResponse | null
  downloadError?: string
}> {
  const blob = await source.loadFile()
  const file = new File([blob], source.filename, { type: source.contentType || blob.type })
  // Attachments use a read-only table viewer; workspace CSV/TSV files remain editable text.
  const content =
    !/\.(csv|tsv)$/i.test(file.name) && workspaceFilePreviewKind(file.name, file.type) === 'text'
      ? await file.text()
      : null
  return {
    file,
    text:
      content !== null
        ? {
            path: file.name,
            name: file.name,
            content,
            editable: false,
            revision: '',
            truncated: false,
            size: file.size,
          }
        : null,
  }
}
