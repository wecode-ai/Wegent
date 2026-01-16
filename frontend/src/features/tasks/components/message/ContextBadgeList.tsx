// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { ReactNode } from 'react'
import { Database, Table2 } from 'lucide-react'
import AttachmentPreview from '../input/AttachmentPreview'
import type { SubtaskContextBrief, Attachment } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import { formatDocumentCount } from '@/lib/i18n-helpers'

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
  /** Optional className for customization */
  className?: string
}

function ContextPreviewBase({ icon, title, subtitle, className = '' }: ContextPreviewBaseProps) {
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
      </div>
    </div>
  )
}

interface ContextBadgeListProps {
  /** List of contexts to display */
  contexts?: SubtaskContextBrief[]
  /** Optional callback when user wants to re-select a context */
  onContextReselect?: (context: SubtaskContextBrief) => void
}

/**
 * ContextBadgeList - Display a list of context badges (attachments, knowledge bases, etc.)
 *
 * This component replaces the old attachment-only display with a unified context system.
 * It renders different badges based on context_type:
 * - attachment: Uses AttachmentPreview component (reuse existing logic)
 * - knowledge_base: Displays KB name with document count
 * - table: Displays table name with clickable link to view/reselect
 */
export function ContextBadgeList({ contexts, onContextReselect }: ContextBadgeListProps) {
  if (!contexts || contexts.length === 0) {
    return null
  }

  return (
    <div className="flex flex-wrap gap-2 mb-3">
      {contexts.map(context => (
        <ContextBadgeItem
          key={`${context.context_type}-${context.id}`}
          context={context}
          onReselect={onContextReselect}
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
  onReselect,
}: {
  context: SubtaskContextBrief
  onReselect?: (context: SubtaskContextBrief) => void
}) {
  switch (context.context_type) {
    case 'attachment':
      return <AttachmentContextBadge context={context} />
    case 'knowledge_base':
      return <KnowledgeBaseBadge context={context} />
    case 'table':
      return <TableBadge context={context} _onReselect={onReselect} />
    default:
      return null
  }
}

/**
 * Attachment badge - reuses existing AttachmentPreview component
 *
 * Converts SubtaskContextBrief to Attachment format for AttachmentPreview
 */
function AttachmentContextBadge({ context }: { context: SubtaskContextBrief }) {
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

  return <AttachmentPreview attachment={attachment} compact={false} showDownload={true} />
}
/**
 * Knowledge base badge - displays KB name and document count
 *
 * Uses ContextPreviewBase for consistent styling with attachments
 * Display-only component, no click interaction
 */
function KnowledgeBaseBadge({ context }: { context: SubtaskContextBrief }) {
  const { t } = useTranslation('knowledge')

  const subtitle =
    context.document_count !== undefined &&
    context.document_count !== null &&
    context.document_count > 0
      ? formatDocumentCount(context.document_count, t)
      : undefined

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

/**
 * Table badge - displays table name and source URL
 *
 * Uses ContextPreviewBase for consistent styling with other context types
 * Click to open table URL in new window
 */
function TableBadge({
  context,
  _onReselect,
}: {
  context: SubtaskContextBrief
  _onReselect?: (context: SubtaskContextBrief) => void
}) {
  const { t } = useTranslation('knowledge')
  let subtitle: string | undefined

  // Extract hostname from source_config URL if available
  if (context.source_config?.url) {
    try {
      const url = new URL(context.source_config.url)
      subtitle = url.hostname
    } catch {
      // If URL parsing fails, use the full URL
      subtitle = context.source_config.url
    }
  }

  // Handle click - open table URL in new window
  const handleClick = (e: React.MouseEvent) => {
    if (context.source_config?.url) {
      e.preventDefault()
      window.open(context.source_config.url, '_blank', 'noopener,noreferrer')
    }
  }

  const isClickable = !!context.source_config?.url
  const title = context.source_config?.url
    ? t('knowledge:table.openLink') || 'Click to view table'
    : undefined

  return (
    <div
      onClick={isClickable ? handleClick : undefined}
      className={isClickable ? 'cursor-pointer' : undefined}
      role={isClickable ? 'button' : undefined}
      tabIndex={isClickable ? 0 : undefined}
      title={title}
    >
      <ContextPreviewBase
        icon={<Table2 className="text-blue-500" />}
        title={context.name}
        subtitle={subtitle}
        className={isClickable ? 'hover:shadow-md hover:border-blue-500/50 transition-all' : ''}
      />
    </div>
  )
}

export default ContextBadgeList
