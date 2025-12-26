// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useState, useEffect } from 'react';
import { X, Loader2, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTranslation } from '@/hooks/useTranslation';
import {
  formatFileSize,
  getFileIcon,
  isImageExtension,
  getAttachmentPreviewUrl,
} from '@/apis/attachments';
import { getToken } from '@/apis/user';
import type { Attachment, MultiAttachmentUploadState, TruncationInfo } from '@/types/api';

interface AttachmentUploadPreviewProps {
  /** Current attachments state */
  state: MultiAttachmentUploadState;
  /** Callback to remove an attachment */
  onRemove: (attachmentId: number) => void;
  /** Whether the component is disabled */
  disabled?: boolean;
  /** Truncation info for attachments */
  truncatedAttachments?: Map<number, TruncationInfo>;
}

/**
 * Custom hook to fetch image with authentication and return blob URL
 */
function useAuthenticatedImageInline(attachmentId: number, isImage: boolean) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!isImage) return;

    let isMounted = true;
    const fetchImage = async () => {
      setIsLoading(true);
      setError(false);

      try {
        const token = getToken();
        const response = await fetch(getAttachmentPreviewUrl(attachmentId), {
          headers: {
            ...(token && { Authorization: `Bearer ${token}` }),
          },
        });

        if (!response.ok) {
          throw new Error(`Failed to fetch image: ${response.status}`);
        }

        const blob = await response.blob();
        if (isMounted) {
          const url = URL.createObjectURL(blob);
          setBlobUrl(url);
        }
      } catch (err) {
        console.error('Failed to load image:', err);
        if (isMounted) {
          setError(true);
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    };

    fetchImage();

    return () => {
      isMounted = false;
    };
  }, [attachmentId, isImage]);

  // Clean up blob URL when it changes or component unmounts
  useEffect(() => {
    return () => {
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
      }
    };
  }, [blobUrl]);

  return { blobUrl, isLoading, error };
}

/**
 * Inline attachment preview component
 */
function AttachmentPreviewInline({
  attachment,
  disabled,
  onRemove,
  truncationInfo,
}: {
  attachment: Attachment;
  disabled?: boolean;
  onRemove: () => void;
  truncationInfo?: TruncationInfo;
}) {
  const { t } = useTranslation('common');
  const isImage = isImageExtension(attachment.file_extension);
  const {
    blobUrl: imageUrl,
    isLoading: imageLoading,
    error: imageError,
  } = useAuthenticatedImageInline(attachment.id, isImage);

  const isTruncated = truncationInfo?.is_truncated || attachment.truncation_info?.is_truncated;
  const truncInfo = truncationInfo || attachment.truncation_info;

  // Truncation indicator component
  const TruncationIndicator = () =>
    isTruncated ? (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="ml-1 text-amber-500 flex-shrink-0">
            <AlertTriangle className="h-3 w-3" />
          </span>
        </TooltipTrigger>
        <TooltipContent>
          <p className="text-xs">
            {t('attachment.truncation.notice', {
              original: truncInfo?.original_length?.toLocaleString(),
              truncated: truncInfo?.truncated_length?.toLocaleString(),
            })}
          </p>
        </TooltipContent>
      </Tooltip>
    ) : null;

  // For images, show thumbnail preview
  if (isImage && !imageError) {
    // Show loading state
    if (imageLoading) {
      return (
        <div
          className={`relative flex items-center gap-2 px-2 py-1.5 rounded-lg border bg-muted border-border`}
        >
          <div className="relative h-10 w-10 rounded overflow-hidden border border-border flex items-center justify-center bg-muted">
            <Loader2 className="h-4 w-4 animate-spin text-text-muted" />
          </div>
          <div className="flex flex-col min-w-0 max-w-[120px]">
            <span className="text-xs font-medium truncate" title={attachment.filename}>
              {attachment.filename}
            </span>
            <span className="text-xs text-text-muted">{formatFileSize(attachment.file_size)}</span>
          </div>
          {!disabled && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onRemove}
              className="h-5 w-5 ml-1 text-text-muted hover:text-text-primary"
            >
              <X className="h-3 w-3" />
            </Button>
          )}
        </div>
      );
    }

    // Show image once loaded
    if (imageUrl) {
      return (
        <div
          className={`relative flex items-center gap-2 px-2 py-1.5 rounded-lg border ${
            attachment.status === 'ready'
              ? 'bg-muted border-border'
              : attachment.status === 'failed'
                ? 'bg-red-50 border-red-200 dark:bg-red-900/20 dark:border-red-800'
                : 'bg-muted border-border'
          }`}
        >
          <div className="relative h-10 w-10 rounded overflow-hidden border border-border">
            <img src={imageUrl} alt={attachment.filename} className="h-full w-full object-cover" />
          </div>
          <div className="flex flex-col min-w-0 max-w-[120px]">
            <span className="text-xs font-medium truncate" title={attachment.filename}>
              {attachment.filename}
            </span>
            <span className="text-xs text-text-muted">{formatFileSize(attachment.file_size)}</span>
          </div>
          {attachment.status === 'parsing' && (
            <Loader2 className="h-3 w-3 animate-spin text-primary ml-1" />
          )}
          <TruncationIndicator />
          {!disabled && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onRemove}
              className="h-5 w-5 ml-1 text-text-muted hover:text-text-primary"
            >
              <X className="h-3 w-3" />
            </Button>
          )}
        </div>
      );
    }
  }

  // For non-images or image load errors, show file icon
  return (
    <div
      className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border ${
        attachment.status === 'ready'
          ? 'bg-muted border-border'
          : attachment.status === 'failed'
            ? 'bg-red-50 border-red-200 dark:bg-red-900/20 dark:border-red-800'
            : 'bg-muted border-border'
      }`}
    >
      <span className="text-base">{getFileIcon(attachment.file_extension)}</span>
      <div className="flex flex-col min-w-0 max-w-[150px]">
        <span className="text-xs font-medium truncate" title={attachment.filename}>
          {attachment.filename}
        </span>
        <span className="text-xs text-text-muted">
          {formatFileSize(attachment.file_size)}
          {attachment.text_length &&
            ` · ${attachment.text_length.toLocaleString()} ${t('attachment.characters')}`}
        </span>
      </div>
      {attachment.status === 'parsing' && (
        <Loader2 className="h-3 w-3 animate-spin text-primary ml-1" />
      )}
      <TruncationIndicator />
      {!disabled && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onRemove}
          className="h-5 w-5 ml-1 text-text-muted hover:text-text-primary"
        >
          <X className="h-3 w-3" />
        </Button>
      )}
    </div>
  );
}

/**
 * Attachment upload preview component
 * Only responsible for displaying attachment previews and upload progress
 */
export default function AttachmentUploadPreview({
  state,
  onRemove,
  disabled = false,
  truncatedAttachments,
}: AttachmentUploadPreviewProps) {
  const hasAttachments = state.attachments.length > 0;
  const isUploading = state.uploadingFiles.size > 0;
  const hasErrors = state.errors.size > 0;

  // Don't render anything if no content to show
  if (!hasAttachments && !isUploading && !hasErrors) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Uploading files */}
      {isUploading &&
        Array.from(state.uploadingFiles.entries()).map(([fileId, { file, progress }]) => (
          <div key={fileId} className="flex items-center gap-2 px-3 py-1.5 bg-muted rounded-lg">
            <Loader2 className="h-4 w-4 animate-spin text-primary flex-shrink-0" />
            <div className="flex flex-col min-w-[100px] flex-1">
              <span className="text-xs text-text-muted truncate">{file.name}</span>
              <Progress value={progress} className="h-1 mt-1" />
            </div>
          </div>
        ))}

      {/* Attachment previews in a horizontal scrollable container */}
      {hasAttachments && (
        <div className="flex items-center gap-2 overflow-x-auto max-w-full">
          {state.attachments.map(attachment => (
            <div key={attachment.id} className="flex-shrink-0">
              <AttachmentPreviewInline
                attachment={attachment}
                disabled={disabled}
                onRemove={() => onRemove(attachment.id)}
                truncationInfo={truncatedAttachments?.get(attachment.id)}
              />
            </div>
          ))}
        </div>
      )}

      {/* Error messages */}
      {hasErrors && (
        <div className="flex flex-col gap-1">
          {Array.from(state.errors.entries()).map(([fileId, error]) => (
            <span key={fileId} className="text-xs text-red-500 truncate" title={error}>
              {error}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
