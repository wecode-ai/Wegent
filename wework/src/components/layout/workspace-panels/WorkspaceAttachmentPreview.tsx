import { useTranslation } from '@/hooks/useTranslation'
import { saveBlobToDownloads } from '@/lib/blobDownload'
import type {
  WorkspaceAttachmentPreviewSource,
  WorkspaceTextFileResponse,
} from '@/types/workspace-files'
import { createAsyncResource } from '@wegent/chat-core/async-resource'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { Download } from 'lucide-react'
import { useContext, useMemo, useState, useSyncExternalStore } from 'react'
import { InlineDesktopImagePreview } from '@/components/chat/image-preview/DesktopImagePreview'
import {
  ImageEditContext,
  type SavedImageMarkup,
} from '@/components/chat/image-preview/ImageEditContext'
import { WorkspaceFilePreview } from './WorkspaceFilePreview'
import { workspaceFilePreviewKind } from './workspaceFileTypes'

export function WorkspaceAttachmentPreview({
  source,
}: {
  source: WorkspaceAttachmentPreviewSource
}) {
  const { t } = useTranslation('common')
  const editContext = useContext(ImageEditContext)
  const [revision, setRevision] = useState(0)
  const [failedImage, setFailedImage] = useState<File | null>(null)
  const [savedImage, setSavedImage] = useState<
    (SavedImageMarkup & { source: WorkspaceAttachmentPreviewSource }) | null
  >(null)
  const saved = savedImage?.source === source ? savedImage : null
  const resource = useMemo(
    () =>
      createAsyncResource(
        'attachment-preview:' + revision,
        () =>
          saved
            ? Promise.resolve({
                file: saved.file,
                text: null,
                imageUrl: URL.createObjectURL(saved.file),
                downloadError: undefined,
              })
            : loadAttachmentPreview(source),
        {
          release: result => {
            if (result.imageUrl) URL.revokeObjectURL(result.imageUrl)
          },
        }
      ),
    [source, revision, saved]
  )
  const snapshot = useSyncExternalStore(
    resource.subscribe,
    resource.getSnapshot,
    resource.getSnapshot
  )
  const file = snapshot.data?.file ?? null
  const draftAttachmentId = saved?.attachmentId ?? source.image?.draftAttachmentId
  const editorScope = source.image?.editorScope
  const canEditImage = Boolean(
    editContext && editorScope !== undefined && editContext.scope === editorScope
  )
  const text = snapshot.data?.text ?? null
  const error =
    snapshot.status === 'error'
      ? snapshot.error instanceof Error
        ? snapshot.error.message
        : String(snapshot.error)
      : file && failedImage === file
        ? t('image_preview.load_failed')
        : (snapshot.data?.downloadError ?? null)

  return (
    <section
      data-testid="composer-attachment-preview-panel"
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      {file && snapshot.data?.imageUrl && failedImage !== file ? (
        <InlineDesktopImagePreview
          attachment={{
            mime_type: file.type,
            id: draftAttachmentId,
            image_markup_comments: saved?.comments ?? source.image?.comments ?? [],
          }}
          fromComposer={draftAttachmentId !== undefined}
          filename={file.name}
          localPath={saved ? null : source.image?.localPath}
          editorScope={canEditImage ? editorScope : undefined}
          onMarkupSaved={canEditImage ? result => setSavedImage({ ...result, source }) : undefined}
          url={snapshot.data.imageUrl}
          loading={false}
          loadFile={async () => file}
          onDownload={async () => {
            await saveBlobToDownloads(file, file.name)
          }}
          onError={() => setFailedImage(file)}
        />
      ) : (
        <>
          <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
            <span className="min-w-0 flex-1 truncate text-sm" title={source.filename}>
              {source.filename}
            </span>
            <ControlButton
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
            </ControlButton>
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
        </>
      )}
    </section>
  )
}

async function loadAttachmentPreview(source: WorkspaceAttachmentPreviewSource): Promise<{
  file: File
  text: WorkspaceTextFileResponse | null
  downloadError?: string
  imageUrl?: string
}> {
  const blob = await source.loadFile()
  const file = new File([blob], source.filename, { type: source.contentType || blob.type })
  if (source.image) return { file, text: null, imageUrl: URL.createObjectURL(file) }
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
