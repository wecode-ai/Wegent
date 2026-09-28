import { useCallback, useContext } from 'react'
import type { Attachment } from '@/types/api'
import { readElectronLocalFile } from '@/lib/electron-local-file'
import { readWorkspaceFileBytes } from '@/lib/workspace-file-bytes'
import { useAttachmentDownload } from '../AttachmentDownloadContext'
import { useWorkspaceFileReader } from '../WorkspaceFileReaderContext'
import { AttachmentPreviewContext } from '../AttachmentPreviewContext'

export function useComposerAttachmentPreview() {
  const fetchAttachmentBlob = useAttachmentDownload()
  const readWorkspaceFileChunk = useWorkspaceFileReader()
  const openPreview = useContext(AttachmentPreviewContext)
  return useCallback(
    (attachment: Attachment) => {
      if (!openPreview) throw new Error('Attachment preview panel is unavailable')
      openPreview({
        filename: attachment.filename,
        contentType: attachment.mime_type,
        loadFile: async () => {
          if (attachment.workspace_file) {
            if (!readWorkspaceFileChunk) throw new Error('Workspace file reader is unavailable')
            return new Blob(
              [await readWorkspaceFileBytes(attachment.workspace_file, readWorkspaceFileChunk)],
              { type: attachment.mime_type }
            )
          }
          if (attachment.local_path) {
            return new Blob([await readElectronLocalFile(attachment.local_path)], {
              type: attachment.mime_type,
            })
          }
          return fetchAttachmentBlob(attachment.id)
        },
      })
    },
    [fetchAttachmentBlob, readWorkspaceFileChunk, openPreview]
  )
}
