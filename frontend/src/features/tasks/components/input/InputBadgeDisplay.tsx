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
import { getExternalKnowledgeScopeKey } from '@/features/knowledge/externalKnowledgeSelection'
import { formatCompactKnowledgeScope } from '@/features/knowledge/knowledgeContextPresentation'
import { groupDingTalkContexts } from '@/features/knowledge/dingTalkContextGrouping'
import type { Attachment, MultiAttachmentUploadState } from '@/types/api'
import type { ContextItem, DingTalkDocContext } from '@/types/context'

interface InputBadgeDisplayProps {
  /** Selected knowledge base contexts */
  contexts: ContextItem[]
  /** Current attachments state */
  attachmentState: MultiAttachmentUploadState
  /** Callback to atomically remove one aggregated context group */
  onRemoveContexts: (contextIds: (number | string)[]) => void
  /** Callback to remove an attachment */
  onRemoveAttachment: (attachmentId: number) => void
  /** Whether the component is disabled */
  disabled?: boolean
  /** Optional semantic labels keyed by attachment ID */
  attachmentLabels?: Record<number, string>
  /** Hide ready attachment cards when another component owns their preview */
  hideAttachments?: boolean
}

interface InputContextGroup {
  key: string
  context: ContextItem
  contextIds: (number | string)[]
  displayName?: string
  displaySubtitle?: string
}

type Translate = (key: string, params?: Record<string, unknown>) => string

export function groupInputContexts(contexts: ContextItem[], t: Translate): InputContextGroup[] {
  const groups: InputContextGroup[] = []
  const groupIndexes = new Map<string, number>()
  const dingtalkGroups = groupDingTalkContexts(
    contexts.filter((context): context is DingTalkDocContext => context.type === 'dingtalk_doc'),
    t
  )
  const dingtalkGroupByContextId = new Map(
    dingtalkGroups.flatMap(group => group.contexts.map(context => [context.id, group] as const))
  )

  contexts.forEach(context => {
    let key = `context:${context.type}:${context.id}`
    let displayName: string | undefined

    if (context.type === 'dingtalk_doc') {
      const dingtalkGroup = dingtalkGroupByContextId.get(context.id)
      key = dingtalkGroup?.key ?? key
      displayName = dingtalkGroup?.displayName
    } else if (
      context.type === 'external_knowledge' &&
      context.ref.target_type === 'document' &&
      context.ref.id
    ) {
      key = `external:${getExternalKnowledgeScopeKey(context.ref)}`
      displayName = context.ref.name ?? context.name
    }

    const existingIndex = groupIndexes.get(key)
    if (existingIndex === undefined) {
      groupIndexes.set(key, groups.length)
      groups.push({ key, context, contextIds: [context.id], displayName })
      return
    }

    groups[existingIndex].contextIds.push(context.id)
  })

  return groups.map(group => {
    if (group.context.type === 'dingtalk_doc') {
      const selected = contexts.filter(
        (context): context is DingTalkDocContext =>
          context.type === 'dingtalk_doc' && group.contextIds.includes(context.id)
      )
      const folderCount = selected.filter(context => context.node_type === 'folder').length
      const documentCount = selected.length - folderCount
      return {
        ...group,
        displaySubtitle: formatCompactKnowledgeScope(folderCount, documentCount, t),
      }
    }
    if (
      group.context.type === 'external_knowledge' &&
      group.context.ref.target_type === 'document'
    ) {
      return {
        ...group,
        displaySubtitle: t('knowledge:picker.scopeDocumentsCompact', {
          count: group.contextIds.length,
        }),
      }
    }
    return group
  })
}

/**
 * Custom hook to fetch image with authentication and return blob URL
 */
export function useAuthenticatedImageInline(attachmentId: number, isImage: boolean) {
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
  label,
}: {
  attachment: Attachment
  disabled?: boolean
  onRemove: () => void
  t: (key: string) => string
  label?: string
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
        <div className="relative h-14 w-14 overflow-hidden rounded-lg border border-border bg-muted">
          <div className="flex h-full w-full items-center justify-center">
            <Loader2 className="h-4 w-4 animate-spin text-text-muted" />
          </div>
          {!disabled && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onRemove}
              className="absolute right-0 top-0 h-5 w-5 rounded-bl-md rounded-tr-lg bg-black/50 text-white hover:bg-black/70 hover:text-white"
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
          className={`relative h-14 w-14 overflow-hidden rounded-lg border ${
            attachment.status === 'ready'
              ? 'bg-muted border-border'
              : attachment.status === 'failed'
                ? 'bg-red-50 border-red-200 dark:bg-red-900/20 dark:border-red-800'
                : 'bg-muted border-border'
          }`}
        >
          <img src={imageUrl} alt={attachment.filename} className="h-full w-full object-cover" />
          {label && (
            <span className="absolute bottom-0 left-0 right-0 truncate bg-black/55 px-1 py-0.5 text-center text-[10px] text-white">
              {label}
            </span>
          )}
          {attachment.status === 'parsing' && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/25">
              <Loader2 className="h-4 w-4 animate-spin text-white" />
            </div>
          )}
          {!disabled && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onRemove}
              className="absolute right-0 top-0 h-5 w-5 rounded-bl-md rounded-tr-lg bg-black/50 text-white hover:bg-black/70 hover:text-white"
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
        {label && <span className="text-xs font-medium text-primary">{label}</span>}
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
  onRemoveContexts,
  onRemoveAttachment,
  disabled = false,
  attachmentLabels,
  hideAttachments = false,
}: InputBadgeDisplayProps) {
  const { t } = useTranslation()
  const hasContexts = contexts.length > 0
  const hasAttachments = !hideAttachments && attachmentState.attachments.length > 0
  const isUploading = attachmentState.uploadingFiles.size > 0
  const hasErrors = attachmentState.errors.size > 0
  const contextGroups = groupInputContexts(contexts, t)

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
          {contextGroups.map(group => (
            <div key={group.key} className="flex-shrink-0">
              <ContextBadge
                context={group.context}
                displayName={group.displayName}
                displaySubtitle={group.displaySubtitle}
                onRemove={() => onRemoveContexts(group.contextIds)}
                disableUrlClick={true}
              />
            </div>
          ))}

          {/* Attachment badges */}
          {!hideAttachments &&
            attachmentState.attachments.map(attachment => (
              <div key={`attachment-${attachment.id}`} className="flex-shrink-0">
                <AttachmentPreviewInline
                  attachment={attachment}
                  disabled={disabled}
                  onRemove={() => onRemoveAttachment(attachment.id)}
                  t={t}
                  label={attachmentLabels?.[attachment.id]}
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
