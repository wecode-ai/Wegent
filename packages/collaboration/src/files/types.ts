import type { ComponentType, ReactNode } from 'react'

export type CollaborationFilesProjectId = string | number

export interface CollaborationFilesProject {
  id: CollaborationFilesProjectId
  project_store: 'local' | 'backend'
}

export interface CollaborationProjectFile {
  id: string
  cloud_project_id: CollaborationFilesProjectId
  path: string
  name: string
  kind: 'file' | 'folder'
  content_type: string | null
  size_bytes: number
  sha256?: string | null
  description: string
  created_by_user_id?: number
  updated_by_user_id?: number
  version: number
  created_at: string
  updated_at: string
}

export interface CollaborationDeliveryFile {
  asset_id: string
  delivery_id: string
  loop_item_id: string
  loop_item_title: string
  relative_path: string
  display_name: string
  content_type: string | null
  size_bytes: number
  delivered_at: string
  loop_item_path: Array<{
    id: string
    title: string
  }>
}

export interface CollaborationTaskAttachment {
  id: string
  loop_item_id: string
  loop_item_title: string
  display_name: string
  content_type: string | null
  size_bytes: number
  created_at: string
}

export interface CollaborationFilesApi {
  listFiles(projectId: CollaborationFilesProjectId): Promise<CollaborationProjectFile[]>
  listDeliveryFiles(projectId: CollaborationFilesProjectId): Promise<CollaborationDeliveryFile[]>
  listTaskAttachments?(
    projectId: CollaborationFilesProjectId
  ): Promise<CollaborationTaskAttachment[]>
  createFolder(
    projectId: CollaborationFilesProjectId,
    path: string
  ): Promise<CollaborationProjectFile>
  uploadFile(
    projectId: CollaborationFilesProjectId,
    file: File,
    path: string
  ): Promise<CollaborationProjectFile>
  moveFile(fileId: string, path: string, version: number): Promise<CollaborationProjectFile>
  deleteFile(fileId: string, recursive: boolean): Promise<void>
  previewFile(fileId: string): Promise<Blob>
  downloadFile(fileId: string): Promise<Blob>
  previewDeliveryFile(assetId: string): Promise<Blob>
  downloadDeliveryFile(assetId: string): Promise<Blob>
  previewTaskAttachment?(attachmentId: string): Promise<Blob>
  openTaskAttachment?(attachmentId: string, filename: string): Promise<void>
}

export interface CollaborationTextPreviewFile {
  path: string
  name: string
  content: string
  editable: false
  revision: string
  truncated: false
  size: number
}

export interface CollaborationBinaryPreviewFile {
  path: string
  name: string
  size: number
  file: File
}

export interface CollaborationFilePreviewProps {
  file: CollaborationTextPreviewFile | null
  binaryFile: CollaborationBinaryPreviewFile | null
  loading: boolean
  error: string | null
  onRetry(): void
}

export type CollaborationFilePreviewComponent = ComponentType<CollaborationFilePreviewProps>

export interface CollaborationFilesTranslateOptions {
  [key: string]: string | number
}

export type CollaborationFilesTranslate = (
  key: string,
  fallback?: string,
  options?: CollaborationFilesTranslateOptions
) => string

export type CollaborationFileAction =
  | 'upload'
  | 'create'
  | 'preview'
  | 'download'
  | 'open'
  | 'delete'
  | 'move'

export interface CollaborationFilesTelemetry {
  completed(action: CollaborationFileAction): void
  failed(): void
}

export interface CollaborationFilesViewProps {
  api: CollaborationFilesApi
  project: CollaborationFilesProject
  PreviewComponent: CollaborationFilePreviewComponent
  saveDownload(blob: Blob, filename: string): Promise<unknown>
  telemetry?: CollaborationFilesTelemetry
  t?: CollaborationFilesTranslate
  renderTooltip?: (label: string, child: ReactNode, align?: 'start' | 'center' | 'end') => ReactNode
}
