import { createAsyncResource } from '@wegent/chat-core/async-resource'
import type { CollaborationFilesApi, CollaborationFilesProjectId } from './types'

export function createCollaborationFilesResources(
  api: CollaborationFilesApi,
  projectId: CollaborationFilesProjectId
) {
  const files = createAsyncResource('shared-files:' + projectId, () => api.listFiles(projectId))
  const deliveryFiles = createAsyncResource('delivery-files:' + projectId, () =>
    api.listDeliveryFiles(projectId)
  )
  const taskAttachments = createAsyncResource('task-attachments:' + projectId, async () => {
    if (!api.listTaskAttachments) return []
    try {
      return await api.listTaskAttachments(projectId)
    } catch {
      return []
    }
  })
  return {
    files,
    deliveryFiles,
    taskAttachments,
    refresh: () => Promise.all([files.reload(), deliveryFiles.reload(), taskAttachments.reload()]),
  }
}
