// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { ReactNode } from 'react'
import { Database, Table2 } from 'lucide-react'
import { LongTextTooltip, TruncatedText } from '@/components/common/long-text'
import AttachmentPreview from '../input/AttachmentPreview'
import type { SubtaskContextBrief, Attachment } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import { formatDocumentCount } from '@/lib/i18n-helpers'

interface ExternalKnowledgeContextGroup {
  key: string
  sourceName: string
  providerLabel?: string | null
  targetCount: number
  targetNames: string[]
  isWholeSource: boolean
}

/**
 * Base preview component for context items (attachments, knowledge bases, etc.)
 * Provides consistent styling and layout structure
 */
interface ContextPreviewBaseProps {
  /** Icon element to display (should be text-2xl size) */
  icon: ReactNode
  /** Primary text (filename, KB name, etc.) */
  title: string
  fullTitle?: string
  /** Secondary text (file size, document count, etc.) */
  subtitle?: string
  fullSubtitle?: string
  /** Optional className for customization */
  className?: string
}

function ContextPreviewBase({
  icon,
  title,
  fullTitle,
  subtitle,
  fullSubtitle,
  className = '',
}: ContextPreviewBaseProps) {
  const titleText = fullTitle ?? title
  return (
    <LongTextTooltip content={titleText}>
      <div
        className={`mb-2 flex max-w-[min(320px,100%)] items-center gap-3 rounded-lg border border-border bg-muted p-3 ${className}`}
        aria-label={titleText}
      >
        <div className="text-2xl flex-shrink-0">{icon}</div>
        <div className="flex-1 min-w-0 overflow-hidden">
          <TruncatedText
            text={title}
            tooltipText={titleText}
            focusable={false}
            className="text-sm font-medium"
          />
          {subtitle && (
            <TruncatedText
              text={subtitle}
              tooltipText={fullSubtitle ?? subtitle}
              focusable={false}
              className="text-xs text-text-muted"
            />
          )}
        </div>
      </div>
    </LongTextTooltip>
  )
}

interface ContextBadgeListProps {
  /** List of contexts to display */
  contexts?: SubtaskContextBrief[]
  /** Optional callback when user wants to re-select a context */
  onContextReselect?: (context: SubtaskContextBrief) => void
  /** Share token for public access (no login required) */
  shareToken?: string
}

/**
 * ContextBadgeList - Display a list of context badges (attachments, knowledge bases, etc.)
 *
 * This component replaces the old attachment-only display with a unified context system.
 * It renders different badges based on context_type:
 * - attachment: Uses AttachmentPreview component (reuse existing logic)
 * - knowledge_base: Displays KB name with document count
 * - table: Displays table name with clickable link to view/reselect
 * - external_knowledge: Displays external KB name with provider metadata
 */
export function ContextBadgeList({
  contexts,
  onContextReselect,
  shareToken,
}: ContextBadgeListProps) {
  if (!contexts || contexts.length === 0) {
    return null
  }

  const displayItems = buildContextDisplayItems(contexts)

  return (
    <div className="flex flex-wrap gap-2 mb-3">
      {displayItems.map(item =>
        item.kind === 'external_group' ? (
          <ExternalKnowledgeGroupBadge key={item.group.key} group={item.group} />
        ) : (
          <ContextBadgeItem
            key={`${item.context.context_type}-${item.context.id}`}
            context={item.context}
            onReselect={onContextReselect}
            shareToken={shareToken}
          />
        )
      )}
    </div>
  )
}

type ContextDisplayItem =
  | { kind: 'context'; context: SubtaskContextBrief }
  | { kind: 'external_group'; group: ExternalKnowledgeContextGroup }

function buildContextDisplayItems(contexts: SubtaskContextBrief[]): ContextDisplayItem[] {
  const items: ContextDisplayItem[] = []
  const externalGroups = new Map<string, ExternalKnowledgeContextGroup>()

  for (const context of contexts) {
    if (context.context_type !== 'external_knowledge') {
      items.push({ kind: 'context', context })
      continue
    }

    const key = buildExternalContextGroupKey(context)
    const targetName = getExternalTargetName(context)
    const existing = externalGroups.get(key)
    if (existing) {
      if (targetName) existing.targetNames.push(targetName)
      existing.targetCount += isWholeExternalContext(context) ? 0 : 1
      existing.isWholeSource = existing.isWholeSource || isWholeExternalContext(context)
      continue
    }

    externalGroups.set(key, {
      key,
      sourceName: getExternalSourceName(context),
      providerLabel: context.external_provider_label ?? context.external_provider?.toUpperCase(),
      targetCount: isWholeExternalContext(context) ? 0 : 1,
      targetNames: targetName ? [targetName] : [],
      isWholeSource: isWholeExternalContext(context),
    })
  }

  for (const group of externalGroups.values()) {
    items.push({ kind: 'external_group', group })
  }

  return items
}

function buildExternalContextGroupKey(context: SubtaskContextBrief): string {
  const ref = context.external_ref
  const provider = ref?.provider ?? context.external_provider ?? 'external'
  const mode = ref?.mode ?? context.external_mode ?? 'explicit'
  const id = ref?.id ?? context.external_id ?? 'all'
  return `external:${provider}:${mode}:${id}`
}

function getExternalSourceName(context: SubtaskContextBrief): string {
  return (
    context.external_source_name ??
    context.external_ref?.name ??
    context.external_id ??
    context.name
  )
}

function getExternalTargetName(context: SubtaskContextBrief): string | undefined {
  return context.external_target_name ?? context.external_ref?.target_name ?? context.name
}

function isWholeExternalContext(context: SubtaskContextBrief): boolean {
  const targetType = context.external_ref?.target_type ?? context.external_target_type
  return !targetType || targetType === 'knowledge_base'
}

/**
 * Single context badge item - routes to appropriate renderer based on type
 */
function ContextBadgeItem({
  context,
  onReselect,
  shareToken,
}: {
  context: SubtaskContextBrief
  onReselect?: (context: SubtaskContextBrief) => void
  shareToken?: string
}) {
  switch (context.context_type) {
    case 'attachment':
      return <AttachmentContextBadge context={context} shareToken={shareToken} />
    case 'knowledge_base':
      return <KnowledgeBaseBadge context={context} />
    case 'external_knowledge':
      return <ExternalKnowledgeBadge context={context} />
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
function AttachmentContextBadge({
  context,
  shareToken,
}: {
  context: SubtaskContextBrief
  shareToken?: string
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

  return (
    <AttachmentPreview
      attachment={attachment}
      compact={false}
      showDownload={true}
      shareToken={shareToken}
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

function ExternalKnowledgeGroupBadge({ group }: { group: ExternalKnowledgeContextGroup }) {
  const { t } = useTranslation('knowledge')
  const selectionLabel = group.isWholeSource
    ? t('picker.allDocuments')
    : t('picker.selectedDocuments', { count: group.targetCount })
  const subtitle = [group.providerLabel, selectionLabel].filter(Boolean).join(' · ')
  const details = group.targetNames
    .map(targetName => `${group.sourceName} / ${targetName}`)
    .join('\n')

  return (
    <ContextPreviewBase
      icon={<Database className="text-primary" />}
      title={group.sourceName}
      fullTitle={details || group.sourceName}
      subtitle={subtitle}
      fullSubtitle={subtitle}
    />
  )
}

function ExternalKnowledgeBadge({ context }: { context: SubtaskContextBrief }) {
  const item = buildContextDisplayItems([context])[0]
  if (item?.kind !== 'external_group') return null
  return <ExternalKnowledgeGroupBadge group={item.group} />
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
      aria-label={title}
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
