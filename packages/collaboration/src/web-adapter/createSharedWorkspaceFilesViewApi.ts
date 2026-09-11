// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type {
  CollaborationFilesApi,
  CollaborationProjectFile,
  CollaborationTaskAttachment,
} from "../files";
import type {
  SharedWorkspaceAttachmentsApi,
  SharedWorkspaceFilesApi,
  WorkspaceBinaryAccess,
} from "../ports/SharedWorkspaceApi";

export interface SharedWorkspaceFilesViewSource {
  files: SharedWorkspaceFilesApi;
  attachments?: Pick<
    SharedWorkspaceAttachmentsApi,
    "listProjectTaskAttachments" | "read" | "access"
  >;
}

export interface SharedWorkspaceFilesViewHost {
  readAccess?(access: WorkspaceBinaryAccess): Promise<Blob>;
  saveTaskAttachment?(blob: Blob, filename: string): Promise<unknown>;
}

interface ProjectTaskAttachmentTitle {
  loop_item_title?: string;
}

function toTaskAttachment(
  attachment: Awaited<
    ReturnType<SharedWorkspaceAttachmentsApi["listProjectTaskAttachments"]>
  >[number],
): CollaborationTaskAttachment {
  return {
    id: attachment.id,
    loop_item_id: attachment.loop_item_id,
    loop_item_title:
      (attachment as typeof attachment & ProjectTaskAttachmentTitle)
        .loop_item_title ?? "",
    display_name: attachment.display_name,
    content_type: attachment.content_type,
    size_bytes: attachment.size_bytes,
    created_at: attachment.created_at,
  };
}

async function readDownload(
  access: () => Promise<WorkspaceBinaryAccess>,
  read: () => Promise<Blob>,
  host: SharedWorkspaceFilesViewHost,
): Promise<Blob> {
  if (!host.readAccess) return read();
  return host.readAccess(await access());
}

export function createSharedWorkspaceFilesViewApi(
  source: SharedWorkspaceFilesViewSource,
  host: SharedWorkspaceFilesViewHost = {},
): CollaborationFilesApi {
  const { attachments, files } = source;

  return {
    listFiles: (projectId) =>
      files.list(String(projectId)) as Promise<CollaborationProjectFile[]>,
    listDeliveryFiles: async (projectId) =>
      (await files.listDeliveryFiles(String(projectId))).map((file) => ({
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
    listTaskAttachments: attachments
      ? async (projectId) =>
          (await attachments.listProjectTaskAttachments(String(projectId))).map(
            toTaskAttachment,
          )
      : undefined,
    createFolder: (projectId, path) =>
      files.createFolder(String(projectId), path),
    uploadFile: (projectId, file, path) =>
      files.upload(String(projectId), file, path),
    moveFile: files.move,
    deleteFile: (fileId, recursive) => files.remove(fileId, recursive),
    previewFile: files.read,
    downloadFile: (fileId) =>
      readDownload(
        () => files.access(fileId),
        () => files.read(fileId),
        host,
      ),
    previewDeliveryFile: files.readDeliveryFile,
    downloadDeliveryFile: (assetId) =>
      readDownload(
        () => files.accessDeliveryFile(assetId),
        () => files.readDeliveryFile(assetId),
        host,
      ),
    previewTaskAttachment: attachments?.read,
    openTaskAttachment:
      attachments && host.saveTaskAttachment
        ? async (attachmentId, filename) => {
            const blob = await readDownload(
              () => attachments.access(attachmentId),
              () => attachments.read(attachmentId),
              host,
            );
            await host.saveTaskAttachment!(blob, filename);
          }
        : undefined,
  };
}
