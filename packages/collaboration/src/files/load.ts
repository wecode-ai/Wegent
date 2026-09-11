import type {
  CollaborationDeliveryFile,
  CollaborationFilesApi,
  CollaborationFilesProjectId,
  CollaborationProjectFile,
  CollaborationTaskAttachment,
} from "./types";

export interface CollaborationFilesLoadHandlers {
  onFiles(files: CollaborationProjectFile[]): void;
  onDeliveryFiles(files: CollaborationDeliveryFile[]): void;
  onTaskAttachments(attachments: CollaborationTaskAttachment[]): void;
  onCoreError(cause: unknown): void;
}

export async function loadCollaborationFiles(
  api: CollaborationFilesApi,
  projectId: CollaborationFilesProjectId,
  handlers: CollaborationFilesLoadHandlers,
): Promise<void> {
  const filesRequest = api
    .listFiles(projectId)
    .then(handlers.onFiles, handlers.onCoreError);
  const deliveryFilesRequest = api
    .listDeliveryFiles(projectId)
    .then(handlers.onDeliveryFiles, handlers.onCoreError);
  const taskAttachmentsRequest = api.listTaskAttachments
    ? api
        .listTaskAttachments(projectId)
        .then(handlers.onTaskAttachments, () => handlers.onTaskAttachments([]))
    : Promise.resolve(handlers.onTaskAttachments([]));

  await Promise.all([
    filesRequest,
    deliveryFilesRequest,
    taskAttachmentsRequest,
  ]);
}
