// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  CollaborationFilesView,
  type CollaborationFilePreviewProps,
  type CollaborationFilesApi,
  type CollaborationProjectFile,
} from '../files'
import type { SharedWorkspaceFilesApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationProject } from '../types'

function BrowserFilePreview({
  file,
  binaryFile,
  loading,
  error,
  onRetry,
}: CollaborationFilePreviewProps) {
  if (loading) return <p>Loading…</p>
  if (error) {
    return (
      <div role="alert">
        <p>{error}</p>
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      </div>
    )
  }
  if (file) return <pre className="collaboration-web-file-preview">{file.content}</pre>
  if (binaryFile) {
    return (
      <p>
        {binaryFile.name} · {binaryFile.size} B
      </p>
    )
  }
  return null
}

async function saveBrowserDownload(blob: Blob, filename: string): Promise<void> {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

export function CollaborationFilesAdapter({
  api,
  project,
}: {
  api: SharedWorkspaceFilesApi
  project: CollaborationProject
}) {
  const filesApi: CollaborationFilesApi = {
    listFiles: projectId => api.list(String(projectId)) as Promise<CollaborationProjectFile[]>,
    listDeliveryFiles: async projectId =>
      (await api.listDeliveryFiles(String(projectId))).map(file => ({
        asset_id: file.assetId,
        delivery_id: file.deliveryId,
        loop_item_id: file.issueId,
        loop_item_title: file.issueTitle,
        relative_path: file.relativePath,
        display_name: file.displayName,
        content_type: file.contentType,
        size_bytes: file.sizeBytes,
        delivered_at: file.deliveredAt,
        loop_item_path: file.issuePath,
      })),
    createFolder: (projectId, path) => api.createFolder(String(projectId), path),
    uploadFile: (projectId, file, path) => api.upload(String(projectId), file, path),
    moveFile: api.move,
    deleteFile: api.remove,
    previewFile: api.read,
    downloadFile: api.read,
    previewDeliveryFile: api.readDeliveryFile,
    downloadDeliveryFile: api.readDeliveryFile,
  }

  return (
    <CollaborationFilesView
      api={filesApi}
      project={project}
      PreviewComponent={BrowserFilePreview}
      saveDownload={saveBrowserDownload}
    />
  )
}
