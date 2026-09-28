import { useMemo } from 'react'
import { type AttachmentImageServices } from '@wegent/collaboration'
import type { Attachment } from '@/types/api'
import { readElectronLocalFile } from '@/lib/electron-local-file'
import { isElectronRuntime } from '@/lib/runtime-environment'
import { readWorkspaceFileBytes } from '@/lib/workspace-file-bytes'
import { useAttachmentDownload } from './AttachmentDownloadContext'
import { acquireCachedImagePreview } from './imagePreviewCache'
import { useWorkspaceFileReader } from './WorkspaceFileReaderContext'
import {
  localPathFromMarkdownImageSrc,
  resolveDirectMarkdownImageSrc,
} from './assistantMarkdownLinks'

const failedAttachmentPreviewUrls = new Set<string>()
const resolvedLocalAttachmentPreviewUrls = new Map<string, string>()

function attachmentPreviewIdentity(attachment: Attachment): string {
  const workspaceFile = attachment.workspace_file
  return `${attachment.id}:${attachment.local_preview_url ?? attachment.local_path ?? ''}:${
    workspaceFile
      ? `${workspaceFile.device_id}:${workspaceFile.workspace_path}:${workspaceFile.path}`
      : ''
  }`
}

function workspaceImageCacheKey(attachment: Attachment): string {
  const reference = attachment.workspace_file
  if (!reference) return ''
  return [
    'workspace',
    reference.device_id,
    reference.workspace_path,
    reference.path,
    attachment.mime_type,
    attachment.file_size,
  ].join(':')
}

async function loadElectronLocalImage(
  path: string,
  mimeType: string
): Promise<{ url: string; release: () => void }> {
  const objectUrl = URL.createObjectURL(
    new Blob([await readElectronLocalFile(path)], { type: mimeType })
  )
  return {
    url: objectUrl,
    release: () => URL.revokeObjectURL(objectUrl),
  }
}

async function loadAttachmentImageUrl(
  attachment: Attachment,
  fetchAttachmentBlob: (attachmentId: number) => Promise<Blob>,
  readWorkspaceFileChunk: ReturnType<typeof useWorkspaceFileReader>
): Promise<{ url: string; release: (() => void) | null }> {
  const workspaceFile = attachment.workspace_file
  if (workspaceFile) {
    if (!readWorkspaceFileChunk) {
      throw new Error('Workspace file reader is unavailable')
    }
    return acquireCachedImagePreview(workspaceImageCacheKey(attachment), async () => {
      const bytes = await readWorkspaceFileBytes(workspaceFile, readWorkspaceFileChunk)
      return new Blob([bytes], {
        type: attachment.mime_type || 'application/octet-stream',
      })
    })
  }

  const localPreviewUrl = attachment.local_preview_url ?? attachment.local_path
  if (localPreviewUrl) {
    const cachedLocalPreviewUrl = resolvedLocalAttachmentPreviewUrls.get(localPreviewUrl)
    if (cachedLocalPreviewUrl) {
      return { url: cachedLocalPreviewUrl, release: null }
    }

    if (failedAttachmentPreviewUrls.has(localPreviewUrl)) {
      throw new Error('Local attachment preview already failed')
    }

    const localPath = getDownloadableLocalPath(localPreviewUrl)
    if (localPath && isElectronRuntime()) {
      return loadElectronLocalImage(localPath, attachment.mime_type || 'application/octet-stream')
    }
    const resolvedLocalPreviewUrl = resolveDirectMarkdownImageSrc(localPreviewUrl)
    if (!resolvedLocalPreviewUrl) {
      throw new Error('Failed to resolve local attachment preview')
    }
    resolvedLocalAttachmentPreviewUrls.set(localPreviewUrl, resolvedLocalPreviewUrl)
    return { url: resolvedLocalPreviewUrl, release: null }
  }

  const blob = await fetchAttachmentBlob(attachment.id)
  if (!blob.type.startsWith('image/')) {
    throw new Error(`Attachment preview is not an image: ${blob.type || 'unknown'}`)
  }

  const objectUrl = URL.createObjectURL(blob)
  return {
    url: objectUrl,
    release: () => URL.revokeObjectURL(objectUrl),
  }
}

function rememberFailedAttachmentPreview(attachment: Attachment) {
  const localPreviewUrl = attachment.local_preview_url ?? attachment.local_path
  if (localPreviewUrl) {
    failedAttachmentPreviewUrls.add(localPreviewUrl)
  }
}

function triggerDownload(url: string, filename: string) {
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
}

async function downloadImage(url: string, filename: string) {
  try {
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Failed to download image: ${response.status}`)
    }

    const blob = await response.blob()
    const objectUrl = URL.createObjectURL(blob)
    triggerDownload(objectUrl, filename)
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
  } catch {
    triggerDownload(url, filename)
  }
}

function getDownloadableLocalPath(value?: string): string | null {
  if (!value) return null
  if (/^(asset|blob|data|https?):/i.test(value)) return null

  const localPath = localPathFromMarkdownImageSrc(value)
  if (localPath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(localPath)) {
    return localPath
  }

  return null
}

async function downloadAttachmentImage(attachment: Attachment, imageUrl: string, filename: string) {
  const sourcePath = getDownloadableLocalPath(attachment.local_preview_url ?? attachment.local_path)
  if (sourcePath && isElectronRuntime()) {
    const objectUrl = URL.createObjectURL(
      new Blob([await readElectronLocalFile(sourcePath)], {
        type: attachment.mime_type || 'application/octet-stream',
      })
    )
    triggerDownload(objectUrl, filename)
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
    return
  }

  await downloadImage(imageUrl, filename)
}

export function useAttachmentImageServices() {
  const fetchAttachmentBlob = useAttachmentDownload()
  const readWorkspaceFileChunk = useWorkspaceFileReader()
  const services = useMemo<AttachmentImageServices<Attachment>>(
    () => ({
      identity: attachmentPreviewIdentity,
      load: attachment =>
        loadAttachmentImageUrl(attachment, fetchAttachmentBlob, readWorkspaceFileChunk),
      download: downloadAttachmentImage,
      localPath: attachment =>
        getDownloadableLocalPath(attachment.local_preview_url ?? attachment.local_path),
      onError: rememberFailedAttachmentPreview,
      loadImmediately: isElectronRuntime(),
    }),
    [fetchAttachmentBlob, readWorkspaceFileChunk]
  )
  return services
}
