// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { ReactNode } from 'react'
import { Database, FileDown, Loader2, MessageSquareText } from 'lucide-react'
import AttachmentPreview from '../input/AttachmentPreview'
import ImageGallery from './ImageGallery'
import type { SubtaskContextBrief, Attachment } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import {
  getExternalKnowledgeSourceLabel,
  useExternalKnowledgeSources,
} from '@/features/knowledge/externalKnowledgeSourceRegistry'
import {
  formatCompactKnowledgeScope,
  formatKnowledgeScopeSummary,
} from '@/features/knowledge/knowledgeContextPresentation'
import {
  formatFileSize,
  isAudioExtension,
  isImageExtension,
  isVideoExtension,
} from '@/apis/attachments'
import { useAttachmentImage } from '@/hooks/useAttachmentImage'
import { remoteWorkspaceApis } from '@/apis/remoteWorkspace'
import { getToken } from '@/apis/user'
import { useToast } from '@/hooks/use-toast'

/**
 * Base preview component for context items (attachments, knowledge bases, etc.)
 * Provides consistent styling and layout structure
 */
interface ContextPreviewBaseProps {
  /** Icon element to display (should be text-2xl size) */
  icon: ReactNode
  /** Primary text (filename, KB name, etc.) */
  title: string
  /** Secondary text (file size, document count, etc.) */
  subtitle?: string
  /** Optional source/provider label shown below the scope summary */
  sourceLabel?: string
  /** Optional className for customization */
  className?: string
}

function ContextPreviewBase({
  icon,
  title,
  subtitle,
  sourceLabel,
  className = '',
}: ContextPreviewBaseProps) {
  return (
    <div
      className={`flex items-center gap-3 p-3 bg-muted rounded-lg border border-border mb-2 max-w-full ${className}`}
    >
      <div className="text-2xl flex-shrink-0">{icon}</div>
      <div className="flex-1 min-w-0 overflow-hidden">
        <div className="font-medium text-sm truncate" title={title}>
          {title}
        </div>
        {subtitle && <div className="text-xs text-text-muted">{subtitle}</div>}
        {sourceLabel && <div className="text-xs text-text-muted">{sourceLabel}</div>}
      </div>
    </div>
  )
}

interface ContextBadgeListProps {
  /** List of contexts to display */
  contexts?: SubtaskContextBrief[]
  /** Share token for public access (no login required) */
  shareToken?: string
  /** Render image attachments as generated media instead of compact input badges */
  displayGeneratedMedia?: boolean
}

interface MessageContextGroup {
  key: string
  context: SubtaskContextBrief
  folderCount: number
  documentCount: number
}

export function groupMessageContexts(contexts: SubtaskContextBrief[]): MessageContextGroup[] {
  const groups: MessageContextGroup[] = []
  const groupIndexes = new Map<string, number>()

  for (const context of contexts) {
    const isExternalKnowledge =
      context.context_type === 'external_knowledge' &&
      context.external_provider &&
      context.external_mode
    const key = isExternalKnowledge
      ? `external:${context.external_provider}:${context.external_mode}:${context.external_scope ?? ''}:${context.external_id ?? 'all'}`
      : `${context.context_type}:${context.id}`
    const existingIndex = groupIndexes.get(key)
    const isWholeKnowledgeBase =
      isExternalKnowledge &&
      (!context.external_target_type || context.external_target_type === 'knowledge_base')
    const folderCount = isExternalKnowledge && context.external_target_type === 'folder' ? 1 : 0
    const documentCount = isExternalKnowledge && context.external_target_type === 'document' ? 1 : 0

    if (existingIndex === undefined) {
      groupIndexes.set(key, groups.length)
      groups.push({ key, context, folderCount, documentCount })
    } else {
      const existing = groups[existingIndex]
      const existingIsWholeKnowledgeBase =
        !existing.context.external_target_type ||
        existing.context.external_target_type === 'knowledge_base'
      if (existingIsWholeKnowledgeBase) continue
      if (isWholeKnowledgeBase) {
        groups[existingIndex] = { key, context, folderCount: 0, documentCount: 0 }
        continue
      }
      existing.folderCount += folderCount
      existing.documentCount += documentCount
    }
  }

  return groups
}

/**
 * ContextBadgeList - Display a list of context badges (attachments, knowledge bases, etc.)
 *
 * This component replaces the old attachment-only display with a unified context system.
 * It renders different badges based on context_type:
 * - attachment: Uses AttachmentPreview component (reuse existing logic)
 * - knowledge_base: Displays KB name with document count
 * - external_knowledge: Displays external KB name with provider metadata
 */
export function ContextBadgeList({
  contexts,
  shareToken,
  displayGeneratedMedia = false,
}: ContextBadgeListProps) {
  if (!contexts || contexts.length === 0) {
    return null
  }

  return (
    <div className="flex flex-wrap items-start gap-2 mb-3">
      {groupMessageContexts(contexts).map(group => (
        <ContextBadgeItem
          key={group.key}
          context={group.context}
          folderCount={group.folderCount}
          documentCount={group.documentCount}
          shareToken={shareToken}
          displayGeneratedMedia={displayGeneratedMedia}
        />
      ))}
    </div>
  )
}

/**
 * Single context badge item - routes to appropriate renderer based on type
 */
function ContextBadgeItem({
  context,
  folderCount,
  documentCount,
  shareToken,
  displayGeneratedMedia,
}: {
  context: SubtaskContextBrief
  folderCount: number
  documentCount: number
  shareToken?: string
  displayGeneratedMedia: boolean
}) {
  switch (context.context_type) {
    case 'attachment':
      return (
        <AttachmentContextBadge
          context={context}
          shareToken={shareToken}
          displayGeneratedMedia={displayGeneratedMedia}
        />
      )
    case 'knowledge_base':
      return <KnowledgeBaseBadge context={context} />
    case 'external_knowledge':
      return (
        <ExternalKnowledgeBadge
          context={context}
          folderCount={folderCount}
          documentCount={documentCount}
        />
      )
    case 'remote_workspace_artifact':
      return <RemoteWorkspaceArtifactBadge context={context} />
    case 'conversation':
      return <ConversationReferenceBadge context={context} />
    default:
      return null
  }
}

function RemoteWorkspaceArtifactBadge({ context }: { context: SubtaskContextBrief }) {
  const { t } = useTranslation('tasks')
  const { toast } = useToast()
  const [isDownloading, setIsDownloading] = React.useState(false)
  const canDownload = context.status === 'ready' && !!context.remote_task_id
  const subtitle = [
    t('remote_workspace.artifact.device_file'),
    context.file_size === null || context.file_size === undefined
      ? undefined
      : formatFileSize(context.file_size),
  ]
    .filter(Boolean)
    .join(' · ')

  const handleDownload = async () => {
    if (!canDownload || !context.remote_task_id || isDownloading) return
    setIsDownloading(true)
    try {
      const token = getToken()
      const response = await fetch(
        remoteWorkspaceApis.getArtifactFileUrl(context.remote_task_id, context.id, 'attachment'),
        {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        }
      )
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const url = URL.createObjectURL(await response.blob())
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = context.name
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
    } catch (error) {
      console.error('Failed to download remote workspace artifact:', error)
      toast({
        variant: 'destructive',
        title: t('remote_workspace.artifact.download_failed'),
        description: t('remote_workspace.artifact.unavailable'),
      })
    } finally {
      setIsDownloading(false)
    }
  }

  return (
    <button
      type="button"
      className="flex max-w-full items-center gap-3 rounded-lg border border-border bg-muted p-3 text-left transition-colors hover:bg-muted/70 disabled:cursor-not-allowed disabled:opacity-60"
      disabled={!canDownload || isDownloading}
      onClick={handleDownload}
      title={canDownload ? t('remote_workspace.artifact.download') : undefined}
      data-testid={`remote-workspace-artifact-download-${context.id}`}
    >
      <span className="text-2xl text-primary">
        {isDownloading ? <Loader2 className="animate-spin" /> : <FileDown />}
      </span>
      <span className="min-w-0 flex-1 overflow-hidden">
        <span className="block truncate text-sm font-medium" title={context.name}>
          {context.name}
        </span>
        <span className="block text-xs text-text-muted">{subtitle}</span>
      </span>
    </button>
  )
}

/**
 * Attachment badge - reuses existing AttachmentPreview component
 *
 * Converts SubtaskContextBrief to Attachment format for AttachmentPreview
 */
function AttachmentContextBadge({
  context,
  shareToken,
  displayGeneratedMedia,
}: {
  context: SubtaskContextBrief
  shareToken?: string
  displayGeneratedMedia: boolean
}) {
  // Map context status to Attachment status
  // SubtaskContextBrief uses lowercase status values (pending, ready, failed)
  // Attachment uses specific status types (uploading, parsing, ready, failed)
  const mapStatus = (status: string): Attachment['status'] => {
    switch (status) {
      case 'ready':
        return 'ready'
      case 'failed':
        return 'failed'
      case 'parsing':
        return 'parsing'
      case 'uploading':
        return 'uploading'
      case 'pending':
        // Map 'pending' to 'uploading' as they're semantically similar
        return 'uploading'
      default:
        return 'ready'
    }
  }

  // Convert SubtaskContextBrief to Attachment format for AttachmentPreview
  const attachment: Attachment = {
    id: context.id,
    filename: context.name,
    file_extension: context.file_extension || '',
    file_size: context.file_size || 0,
    mime_type: context.mime_type || '',
    status: mapStatus(context.status),
    created_at: '',
  }

  if (displayGeneratedMedia && isImageExtension(attachment.file_extension)) {
    return <GeneratedImageContextBadge attachment={attachment} shareToken={shareToken} />
  }

  return (
    <AttachmentPreview
      attachment={attachment}
      compact={
        isImageExtension(attachment.file_extension) ||
        isVideoExtension(attachment.file_extension) ||
        isAudioExtension(attachment.file_extension)
      }
      showDownload={true}
      shareToken={shareToken}
    />
  )
}

function GeneratedImageContextBadge({
  attachment,
  shareToken,
}: {
  attachment: Attachment
  shareToken?: string
}) {
  const { blobUrl, isLoading, error } = useAttachmentImage(attachment.id, true, shareToken)
  const [imageSize, setImageSize] = React.useState<string>()

  React.useEffect(() => {
    if (!blobUrl) return

    const image = new window.Image()
    image.onload = () => setImageSize(`${image.naturalWidth}x${image.naturalHeight}`)
    image.src = blobUrl
  }, [blobUrl])

  if (isLoading || (!blobUrl && !error)) {
    return (
      <div
        className="flex h-[220px] w-[220px] items-center justify-center rounded-lg bg-muted"
        data-testid="generated-context-image-loading"
      >
        <Loader2 className="h-6 w-6 animate-spin text-text-muted" />
      </div>
    )
  }

  if (error || !blobUrl) {
    return <AttachmentPreview attachment={attachment} compact={false} showDownload={true} />
  }

  return (
    <ImageGallery
      images={[{ url: blobUrl, attachmentId: attachment.id }]}
      imageSize={imageSize}
      className="mb-2"
    />
  )
}
/**
 * Knowledge base badge - displays KB name and document count
 *
 * Uses ContextPreviewBase for consistent styling with attachments
 * Display-only component, no click interaction
 */
function KnowledgeBaseBadge({ context }: { context: SubtaskContextBrief }) {
  const { t } = useTranslation('knowledge')
  const subtitle = formatKnowledgeScopeSummary(
    {
      documentCount: context.document_count,
      documentIds: context.document_ids,
      folderIds: context.folder_ids,
      scopeRestricted: context.scope_restricted,
    },
    t
  )

  return (
    <div>
      <ContextPreviewBase
        icon={<Database className="text-primary" />}
        title={context.name}
        subtitle={subtitle}
      />
    </div>
  )
}

function ExternalKnowledgeBadge({
  context,
  folderCount,
  documentCount,
}: {
  context: SubtaskContextBrief
  folderCount: number
  documentCount: number
}) {
  const { t } = useTranslation('knowledge')
  const externalSources = useExternalKnowledgeSources()
  const externalSource = externalSources.find(
    source => source.providerId === context.external_provider
  )
  const scopeLabel =
    folderCount > 0 || documentCount > 0
      ? formatCompactKnowledgeScope(folderCount, documentCount, t)
      : undefined
  const sourceLabel = context.external_provider
    ? getExternalKnowledgeSourceLabel(context.external_provider, externalSource)
    : undefined

  return (
    <div>
      <ContextPreviewBase
        icon={<Database className="text-primary" />}
        title={context.name}
        subtitle={scopeLabel}
        sourceLabel={sourceLabel}
      />
    </div>
  )
}

function ConversationReferenceBadge({ context }: { context: SubtaskContextBrief }) {
  const { t } = useTranslation('chat')
  return (
    <div data-testid={`conversation-reference-${context.task_id ?? context.id}`}>
      <ContextPreviewBase
        icon={<MessageSquareText className="text-text-secondary" />}
        title={context.name}
        subtitle={t('chat:mention.referencedTask')}
      />
    </div>
  )
}
export default ContextBadgeList
