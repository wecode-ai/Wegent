// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useEffect } from 'react'
import { X, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import ContextBadge from '../chat/ContextBadge'
import {
  formatFileSize,
  getFileIcon,
  isImageExtension,
  getAttachmentPreviewUrl,
} from '@/apis/attachments'
import { getToken } from '@/apis/user'
import { useTranslation } from '@/hooks/useTranslation'
import type { Attachment, MultiAttachmentUploadState } from '@/types/api'
import type { ContextItem } from '@/types/context'

interface InputBadgeDisplayProps {
  /** Selected knowledge base contexts */
  contexts: ContextItem[]
  /** Current attachments state */
  attachmentState: MultiAttachmentUploadState
  /** Callback to remove a context */
  onRemoveContext: (contextId: number | string) => void
  /** Callback to remove an attachment */
  onRemoveAttachment: (attachmentId: number) => void
  /** Whether the component is disabled */
  disabled?: boolean
}

/**
 * Custom hook to fetch image with authentication and return blob URL
 */
function useAuthenticatedImageInline(attachmentId: number, isImage: boolean) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!isImage) return

    let isMounted = true
    const fetchImage = async () => {
      setIsLoading(true)
      setError(false)

      try {
        const token = getToken()
        const response = await fetch(getAttachmentPreviewUrl(attachmentId), {
          headers: {
            ...(token && { Authorization: `Bearer ${token}` }),
          },
        })

        if (!response.ok) {
          throw new Error(`Failed to fetch image: ${response.status}`)
        }

        const blob = await response.blob()
        if (isMounted) {
          const url = URL.createObjectURL(blob)
          setBlobUrl(url)
        }
      } catch (err) {
        console.error('Failed to load image:', err)
        if (isMounted) {
          setError(true)
        }
      } finally {
        if (isMounted) {
          setIsLoading(false)
        }
      }
    }

    fetchImage()

    return () => {
      isMounted = false
    }
  }, [attachmentId, isImage])

  // Clean up blob URL when it changes or component unmounts
  useEffect(() => {
    return () => {
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl)
      }
    }
  }, [blobUrl])

  return { blobUrl, isLoading, error }
}
/**
 * Inline attachment preview component
 */
function AttachmentPreviewInline({
  attachment,
  disabled,
  onRemove,
  t,
}: {
  attachment: Attachment
  disabled?: boolean
  onRemove: () => void
  t: (key: string) => string
}) {
  const isImage = isImageExtension(attachment.file_extension)
  const {
    blobUrl: imageUrl,
    isLoading: imageLoading,
    error: imageError,
  } = useAuthenticatedImageInline(attachment.id, isImage)

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
      )
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
      )
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
            ` · ${attachment.text_length.toLocaleString()} ${t('tasks:attachment.characters')}`}
        </span>
      </div>
      {attachment.status === 'parsing' && (
        <Loader2 className="h-3 w-3 animate-spin text-primary ml-1" />
      )}
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
  )
}

/**
 * Unified badge display component that shows both knowledge base badges and attachment badges
 * in a single horizontal scrollable row
 */
export default function InputBadgeDisplay({
  contexts,
  attachmentState,
  onRemoveContext,
  onRemoveAttachment,
  disabled = false,
}: InputBadgeDisplayProps) {
  const { t } = useTranslation()
  const hasContexts = contexts.length > 0
  const hasAttachments = attachmentState.attachments.length > 0
  const isUploading = attachmentState.uploadingFiles.size > 0
  const hasErrors = attachmentState.errors.size > 0

  // Only render if there are items to display
  if (!hasContexts && !hasAttachments && !isUploading && !hasErrors) {
    return null
  }

  return (
    <div className="flex flex-col gap-2 px-3 pt-2 pb-1">
      {/* Uploading files progress indicators */}
      {isUploading &&
        Array.from(attachmentState.uploadingFiles.entries()).map(([fileId, { file, progress }]) => (
          <div key={fileId} className="flex items-center gap-2 px-3 py-1.5 bg-muted rounded-lg">
            <Loader2 className="h-4 w-4 animate-spin text-primary flex-shrink-0" />
            <div className="flex flex-col min-w-[100px] flex-1">
              <span className="text-xs text-text-muted truncate">{file.name}</span>
              <Progress value={progress} className="h-1 mt-1" />
            </div>
          </div>
        ))}

      {/* Unified badge display area - knowledge bases first, then attachments */}
      {(hasContexts || hasAttachments) && (
        <div className="flex items-center gap-2 overflow-x-auto max-w-full badge-scroll">
          {/* Knowledge base badges */}
          {contexts.map(context => (
            <div key={`context-${context.type}-${context.id}`} className="flex-shrink-0">
              <ContextBadge
                context={context}
                onRemove={() => onRemoveContext(context.id)}
                disableUrlClick={true}
              />
            </div>
          ))}

          {/* Attachment badges */}
          {attachmentState.attachments.map(attachment => (
            <div key={`attachment-${attachment.id}`} className="flex-shrink-0">
              <AttachmentPreviewInline
                attachment={attachment}
                disabled={disabled}
                onRemove={() => onRemoveAttachment(attachment.id)}
                t={t}
              />
            </div>
          ))}
        </div>
      )}

      {/* Error messages */}
      {hasErrors && (
        <div className="flex flex-col gap-1">
          {Array.from(attachmentState.errors.entries()).map(([fileId, error]) => (
            <span key={fileId} className="text-xs text-red-500 truncate" title={error}>
              {error}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
