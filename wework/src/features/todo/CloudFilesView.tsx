import { useCallback, useMemo, type ReactNode } from 'react'
import {
  CollaborationFilesView,
  type CollaborationFilePreviewProps,
  type CollaborationFilesApi,
  type CollaborationFilesTranslateOptions,
} from '@wegent/collaboration'
import type { CloudProject } from '@/api/deliveries'
import { WorkspaceFilePreview } from '@/components/layout/workspace-panels/WorkspaceFilePreview'
import { Tooltip } from '@/components/ui/tooltip'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import { track } from '@/telemetry/client'
import type { WorkspaceTextFileResponse } from '@/types/workspace-files'
import { readFileFromAccessUrl, saveBlobToDownloads } from './cloudFileTransfer'

type DeliveryApi = NonNullable<WorkbenchServices['deliveryApi']>

function WeworkFilePreview({
  file,
  binaryFile,
  loading,
  error,
  onRetry,
}: CollaborationFilePreviewProps) {
  return (
    <WorkspaceFilePreview
      file={file as WorkspaceTextFileResponse | null}
      binaryFile={binaryFile}
      loading={loading}
      error={error}
      onRetry={onRetry}
      onAddCodeComment={() => undefined}
    />
  )
}

const telemetry = {
  completed(action: 'upload' | 'create' | 'preview' | 'download' | 'open' | 'delete' | 'move') {
    track('feature_action_completed', { action, domain: 'project_space_file' })
  },
  failed() {
    track('operation_failed', { operation: 'project_space_file_action' })
  },
}

export function CloudFilesView({ api, project }: { api: DeliveryApi; project: CloudProject }) {
  const { t } = useTranslation('common')
  const filesApi = useMemo<CollaborationFilesApi>(
    () => ({
      async listFiles(projectId) {
        return (await api.listCloudFiles(projectId)).items
      },
      async listDeliveryFiles(projectId) {
        return (await api.listProjectDeliveryFiles(projectId)).items
      },
      async listTaskAttachments(projectId) {
        return (await api.listProjectTaskAttachments(projectId)).items
      },
      createFolder: (projectId, path) => api.createCloudFolder(projectId, path),
      uploadFile: (projectId, file, path) => api.uploadCloudFile(projectId, file, path),
      moveFile: (fileId, path, version) => api.moveCloudFile(fileId, path, version),
      deleteFile: (fileId, recursive) => api.deleteCloudFile(fileId, recursive),
      previewFile: fileId => api.readCloudFile(fileId),
      async downloadFile(fileId) {
        const access = await api.accessCloudFile(fileId)
        return readFileFromAccessUrl(access.url)
      },
      previewDeliveryFile: assetId => api.readDeliveryFile(assetId),
      async downloadDeliveryFile(assetId) {
        const access = await api.accessDeliveryFile(assetId)
        return readFileFromAccessUrl(access.url)
      },
      previewTaskAttachment: attachmentId => api.readLoopItemAttachment(attachmentId),
      openTaskAttachment: (attachmentId, filename) =>
        api.downloadLoopItemAttachment(attachmentId, filename),
    }),
    [api]
  )
  const translate = useCallback(
    (key: string, fallback?: string, options?: CollaborationFilesTranslateOptions) =>
      fallback === undefined ? t(key) : t(key, fallback, options),
    [t]
  )
  const renderTooltip = useCallback(
    (label: string, child: ReactNode, align: 'start' | 'center' | 'end' = 'center') => (
      <Tooltip label={label} align={align}>
        {child}
      </Tooltip>
    ),
    []
  )

  return (
    <CollaborationFilesView
      api={filesApi}
      project={project}
      PreviewComponent={WeworkFilePreview}
      saveDownload={saveBlobToDownloads}
      telemetry={telemetry}
      t={translate}
      renderTooltip={renderTooltip}
    />
  )
}
