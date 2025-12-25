// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Hook for managing multiple file attachments state and upload.
 */

import { useState, useCallback } from 'react';
import {
  uploadAttachment,
  deleteAttachment,
  isSupportedExtension,
  isValidFileSize,
  MAX_FILE_SIZE,
  SUPPORTED_EXTENSIONS,
} from '@/apis/attachments';
import type { MultiAttachmentUploadState } from '@/types/api';
import { toast } from '@/hooks/use-toast';

interface UseMultiAttachmentReturn {
  /** Current attachment state */
  state: MultiAttachmentUploadState;
  /** Handle file selection and upload */
  handleFileSelect: (files: File | File[]) => Promise<void>;
  /** Remove specific attachment */
  handleRemove: (attachmentId: number) => Promise<void>;
  /** Reset state */
  reset: () => void;
  /** Check if ready to send (no upload in progress, all attachments ready) */
  isReadyToSend: boolean;
  /** Check if any upload is in progress */
  isUploading: boolean;
}

export function useMultiAttachment(): UseMultiAttachmentReturn {
  const [state, setState] = useState<MultiAttachmentUploadState>({
    attachments: [],
    uploadingFiles: new Map(),
    errors: new Map(),
  });

  const handleFileSelect = useCallback(
    async (files: File | File[]) => {
      const fileList = Array.isArray(files) ? files : [files];

      for (const file of fileList) {
        const fileId = `${file.name}-${file.size}-${Date.now()}`;

        // Check if a file with the same name already exists
        const existingAttachment = state.attachments.find(att => att.filename === file.name);
        if (existingAttachment) {
          // File with same name already exists, show toast and skip upload
          toast({
            title: '文件已存在',
            description: `文件 "${file.name}" 已存在，请先删除后再上传`,
            variant: 'destructive',
          });
          continue;
        }

        // Validate file type
        if (!isSupportedExtension(file.name)) {
          setState(prev => {
            const newErrors = new Map(prev.errors);
            newErrors.set(
              fileId,
              `Unsupported file type. Supported types: ${SUPPORTED_EXTENSIONS.join(', ')}`
            );
            return { ...prev, errors: newErrors };
          });
          continue;
        }

        // Validate file size
        if (!isValidFileSize(file.size)) {
          setState(prev => {
            const newErrors = new Map(prev.errors);
            newErrors.set(fileId, `File size exceeds ${MAX_FILE_SIZE / (1024 * 1024)} MB limit`);
            return { ...prev, errors: newErrors };
          });
          continue;
        }

        // Start upload
        setState(prev => {
          const newUploadingFiles = new Map(prev.uploadingFiles);
          newUploadingFiles.set(fileId, { file, progress: 0 });
          const newErrors = new Map(prev.errors);
          newErrors.delete(fileId);
          return {
            ...prev,
            uploadingFiles: newUploadingFiles,
            errors: newErrors,
          };
        });

        try {
          const attachment = await uploadAttachment(file, progress => {
            setState(prev => {
              const newUploadingFiles = new Map(prev.uploadingFiles);
              const existing = newUploadingFiles.get(fileId);
              if (existing) {
                newUploadingFiles.set(fileId, { ...existing, progress });
              }
              return { ...prev, uploadingFiles: newUploadingFiles };
            });
          });

          // Check if parsing succeeded
          if (attachment.status === 'failed') {
            setState(prev => {
              const newUploadingFiles = new Map(prev.uploadingFiles);
              newUploadingFiles.delete(fileId);
              const newErrors = new Map(prev.errors);
              newErrors.set(fileId, attachment.error_message || 'File parsing failed');
              return {
                ...prev,
                uploadingFiles: newUploadingFiles,
                errors: newErrors,
              };
            });
            // Try to delete the failed attachment
            try {
              await deleteAttachment(attachment.id);
            } catch {
              // Ignore delete errors
            }
            continue;
          }

          // Add to attachments list
          setState(prev => {
            const newUploadingFiles = new Map(prev.uploadingFiles);
            newUploadingFiles.delete(fileId);
            return {
              ...prev,
              attachments: [
                ...prev.attachments,
                {
                  id: attachment.id,
                  filename: attachment.filename,
                  file_size: attachment.file_size,
                  mime_type: attachment.mime_type,
                  status: attachment.status,
                  text_length: attachment.text_length,
                  error_message: attachment.error_message,
                  subtask_id: null,
                  file_extension: file.name.substring(file.name.lastIndexOf('.')),
                  created_at: new Date().toISOString(),
                },
              ],
              uploadingFiles: newUploadingFiles,
            };
          });
        } catch (err) {
          setState(prev => {
            const newUploadingFiles = new Map(prev.uploadingFiles);
            newUploadingFiles.delete(fileId);
            const newErrors = new Map(prev.errors);
            newErrors.set(fileId, (err as Error).message || 'Upload failed');
            return {
              ...prev,
              uploadingFiles: newUploadingFiles,
              errors: newErrors,
            };
          });
        }
      }
    },
    [state.attachments]
  );

  const handleRemove = useCallback(
    async (attachmentId: number) => {
      const attachment = state.attachments.find(a => a.id === attachmentId);

      // Remove from state immediately for better UX
      setState(prev => ({
        ...prev,
        attachments: prev.attachments.filter(a => a.id !== attachmentId),
      }));

      // Try to delete from server if it exists and is not linked to a subtask
      if (attachment && !attachment.subtask_id) {
        try {
          await deleteAttachment(attachmentId);
        } catch {
          // Ignore delete errors - attachment might already be linked
        }
      }
    },
    [state.attachments]
  );

  const reset = useCallback(() => {
    setState({
      attachments: [],
      uploadingFiles: new Map(),
      errors: new Map(),
    });
  }, []);

  const isUploading = state.uploadingFiles.size > 0;
  const isReadyToSend =
    !isUploading &&
    state.attachments.every(att => att.status === 'ready') &&
    state.errors.size === 0;

  return {
    state,
    handleFileSelect,
    handleRemove,
    reset,
    isReadyToSend,
    isUploading,
  };
}
