import { useState } from 'react'
import type { AttachmentRow, TodoEditorProps } from './issueEditorSupport'
import type { useIssueDetailCollections } from './useIssueDetailCollections'
import type { useIssuePendingFiles } from './issuePendingFiles'
interface AttachmentOwner {
  editorPort: TodoEditorProps['port']
  extensions: TodoEditorProps['extensions']
  t: NonNullable<TodoEditorProps['translate']>
  editable: boolean
  editItemId: string | null
  collections: ReturnType<typeof useIssueDetailCollections>
  pendingAttachments: ReturnType<typeof useIssuePendingFiles>
  isCreate: boolean
}
export function useIssueDetailAttachmentActions({
  editorPort,
  extensions,
  t,
  editable,
  editItemId,
  collections,
  pendingAttachments,
  isCreate,
}: AttachmentOwner) {
  const { setFiles: setPendingFiles, fileId: pendingFileId } = pendingAttachments
  const [attachmentBusy, setAttachmentBusy] = useState(false)
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [downloadingAttachmentId, setDownloadingAttachmentId] = useState<string | null>(null)

  async function stageFiles(files: FileList | null) {
    if (!files?.length) return
    setPendingFiles(current => [...current, ...Array.from(files)])
  }

  async function removePendingFile(row: AttachmentRow) {
    setPendingFiles(current => current.filter(file => pendingFileId(file) !== row.id))
  }

  // The scoped editor retains this source across Offscreen hiding. Settle
  // mutations into that source even without observers; another Issue/owner has
  // a different source and cannot receive these results.
  async function addAttachments(files: FileList | null) {
    if (
      !editable ||
      !editItemId ||
      !files?.length ||
      attachmentBusy ||
      editorPort.attachments.canUpload === false
    )
      return
    const itemId = editItemId
    collections.invalidateAttachments()
    setAttachmentBusy(true)
    setAttachmentError(null)
    try {
      const result = await uploadAttachments(itemId, Array.from(files))
      collections.invalidateAttachments()
      collections.setAttachments(current => [...result.attachments.reverse(), ...current])
    } catch (cause) {
      setAttachmentError(
        cause instanceof Error ? cause.message : t('todo.attachment_upload_failed', '附件上传失败')
      )
    } finally {
      setAttachmentBusy(false)
    }
  }

  async function uploadAttachments(itemId: string, files: File[]) {
    const uploaded = await Promise.all(
      files.map(async file => {
        const attachment = await editorPort.attachments.upload(itemId, file)
        return { attachment, markdown: attachment.markdown }
      })
    )
    return {
      attachments: uploaded.map(entry => entry.attachment),
      markdown: uploaded.map(entry => entry.markdown).join('\n'),
    }
  }

  async function pasteAttachments(rawFiles: File[]): Promise<string | null> {
    if (editorPort.attachments.canUpload === false) return null
    const owner = collections.getOwner()
    const files = await normalizedPastedFiles(rawFiles)
    if (!collections.isActive(owner) || !files.length) return null
    if (isCreate) {
      setPendingFiles(current => [...current, ...files])
      return null
    }
    if (!editable || !editItemId || attachmentBusy) return null
    const itemId = editItemId
    collections.invalidateAttachments()
    setAttachmentBusy(true)
    setAttachmentError(null)
    try {
      const result = await uploadAttachments(itemId, files)
      collections.invalidateAttachments()
      collections.setAttachments(current => [...result.attachments.reverse(), ...current])
      return collections.isActive(owner) ? result.markdown || null : null
    } catch (cause) {
      setAttachmentError(
        cause instanceof Error ? cause.message : t('todo.attachment_upload_failed', '附件上传失败')
      )
      return null
    } finally {
      setAttachmentBusy(false)
    }
  }

  async function normalizedPastedFiles(files: File[]): Promise<File[]> {
    if (!extensions?.normalizePastedFiles) return files
    try {
      const normalized = await extensions.normalizePastedFiles(files)
      return collections.isActive() ? normalized : []
    } catch {
      return collections.isActive() ? files : []
    }
  }

  async function openAttachment(attachment: AttachmentRow) {
    if (downloadingAttachmentId) return
    setDownloadingAttachmentId(attachment.id)
    setAttachmentError(null)
    try {
      if (extensions?.openAttachment) {
        await extensions.openAttachment(
          attachment.id,
          attachment.display_name,
          attachment.content_type,
          attachment.size_bytes
        )
      } else {
        await editorPort.attachments.download(attachment.id, attachment.display_name)
      }
    } catch (cause) {
      setAttachmentError(
        cause instanceof Error
          ? cause.message
          : t('todo.attachment_download_failed', '附件下载失败')
      )
    } finally {
      setDownloadingAttachmentId(null)
    }
  }

  async function downloadAttachment(attachment: AttachmentRow) {
    if (downloadingAttachmentId) return
    setDownloadingAttachmentId(attachment.id)
    setAttachmentError(null)
    try {
      await editorPort.attachments.download(attachment.id, attachment.display_name)
    } catch (cause) {
      setAttachmentError(
        cause instanceof Error
          ? cause.message
          : t('todo.attachment_download_failed', '附件下载失败')
      )
    } finally {
      setDownloadingAttachmentId(null)
    }
  }

  async function removeAttachment(attachment: AttachmentRow) {
    if (!editable || !editItemId) return
    collections.invalidateAttachments()
    setAttachmentBusy(true)
    setAttachmentError(null)
    try {
      await editorPort.attachments.remove(attachment.id)
      collections.invalidateAttachments()
      collections.setAttachments(current => current.filter(entry => entry.id !== attachment.id))
    } catch (cause) {
      setAttachmentError(
        cause instanceof Error ? cause.message : t('todo.attachment_delete_failed', '附件删除失败')
      )
    } finally {
      setAttachmentBusy(false)
    }
  }

  return {
    attachmentBusy,
    attachmentError,
    downloadingAttachmentId,
    stageFiles,
    removePendingFile,
    addAttachments,
    pasteAttachments,
    openAttachment,
    downloadAttachment,
    removeAttachment,
  }
}
