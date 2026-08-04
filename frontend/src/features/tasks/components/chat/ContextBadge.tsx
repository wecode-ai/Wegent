// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import { X, Database, Table2, MessageSquare, FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { LongTextTooltip, TruncatedText } from '@/components/common/long-text'
import { useTranslation } from '@/hooks/useTranslation'
import type {
  ContextItem,
  DingTalkDocContext,
  ExternalKnowledgeContext,
  KnowledgeBaseContext,
  QueueMessageContext,
} from '@/types/context'
import { formatDocumentCount } from '@/lib/i18n-helpers'

function formatKnowledgeScopeLabel(
  context: KnowledgeBaseContext,
  t: (key: string, options?: Record<string, unknown>) => string
) {
  const documentCount = context.document_ids?.length ?? 0
  const folderCount = context.folder_ids?.length ?? 0

  if (folderCount > 0 && documentCount > 0) {
    return t('picker.selectedScope', { folderCount, documentCount })
  }
  if (folderCount > 0) {
    return t('picker.selectedFolders', { count: folderCount })
  }
  return t('picker.selectedDocuments', { count: documentCount })
}

function formatKnowledgeFullLabel(context: KnowledgeBaseContext) {
  const scopedNames = [...(context.folder_names ?? []), ...(context.document_names ?? [])]
  if (scopedNames.length === 0) return context.name
  return scopedNames.map(name => `${context.name} / ${name}`).join('\n')
}

function formatExternalKnowledgeFullLabel(context: ExternalKnowledgeContext) {
  const targetName = context.ref.target_name
  if (!targetName) return context.ref.name || context.name
  return `${context.ref.name || context.name} / ${targetName}`
}

interface ContextBadgeProps {
  context: ContextItem
  onRemove: () => void
  /** Disable URL opening on click (for input area badges) */
  disableUrlClick?: boolean
}

/**
 * Get icon component based on context type
 */
const getContextIcon = (type: ContextItem['type']) => {
  switch (type) {
    case 'knowledge_base':
      return Database
    case 'table':
      return Table2
    case 'queue_message':
      return MessageSquare
    case 'dingtalk_doc':
      return FileText
    case 'external_knowledge':
      return Database
    // Future context types will be added here
    // case 'person': return User;
    // case 'bot': return Bot;
    // case 'team': return Users;
    default:
      return Database
  }
}

export default function ContextBadge({
  context,
  onRemove,
  disableUrlClick = false,
}: ContextBadgeProps) {
  const { t } = useTranslation('knowledge')
  const Icon = getContextIcon(context.type)

  // Get badge color based on context type
  const getBadgeColor = () => {
    switch (context.type) {
      case 'knowledge_base':
        return 'border-primary bg-primary/10 text-primary'
      case 'table':
        return 'border-blue-500 bg-blue-500/10 text-blue-600'
      case 'queue_message':
        return 'border-orange-500 bg-orange-500/10 text-orange-600'
      case 'dingtalk_doc':
        return 'border-orange-400 bg-orange-400/10 text-orange-600'
      case 'external_knowledge':
        return 'border-cyan-500 bg-cyan-500/10 text-cyan-700'
      default:
        return 'border-primary bg-primary/10 text-primary'
    }
  }

  // Handle badge click - open URL in new window for clickable types (only if not disabled)
  const handleBadgeClick = (e: React.MouseEvent) => {
    if (!disableUrlClick && context.type === 'table' && context.source_config?.url) {
      e.stopPropagation()
      window.open(context.source_config.url, '_blank', 'noopener,noreferrer')
    }
    if (
      !disableUrlClick &&
      context.type === 'dingtalk_doc' &&
      (context as DingTalkDocContext).doc_url
    ) {
      e.stopPropagation()
      window.open((context as DingTalkDocContext).doc_url, '_blank', 'noopener,noreferrer')
    }
  }

  const isClickable =
    (!disableUrlClick && context.type === 'table' && context.source_config?.url) ||
    (!disableUrlClick &&
      context.type === 'dingtalk_doc' &&
      !!(context as DingTalkDocContext).doc_url)
  const fullLabel =
    context.type === 'knowledge_base'
      ? formatKnowledgeFullLabel(context)
      : context.type === 'external_knowledge'
        ? formatExternalKnowledgeFullLabel(context as ExternalKnowledgeContext)
        : context.name

  // Get remove button color based on context type
  const getRemoveButtonColor = () => {
    switch (context.type) {
      case 'table':
        return 'text-blue-600 hover:text-blue-600 hover:bg-blue-500/20'
      case 'queue_message':
        return 'text-orange-600 hover:text-orange-600 hover:bg-orange-500/20'
      case 'dingtalk_doc':
        return 'text-orange-600 hover:text-orange-600 hover:bg-orange-400/20'
      case 'external_knowledge':
        return 'text-cyan-700 hover:text-cyan-700 hover:bg-cyan-500/20'
      default:
        return 'text-primary hover:text-primary hover:bg-primary/20'
    }
  }

  return (
    <LongTextTooltip content={fullLabel}>
      <div
        className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border ${getBadgeColor()} ${
          isClickable ? 'cursor-pointer hover:shadow-md transition-shadow' : ''
        }`}
        onClick={handleBadgeClick}
        role={isClickable ? 'button' : undefined}
        tabIndex={isClickable ? 0 : undefined}
        aria-label={fullLabel}
      >
        <Icon className="h-4 w-4 flex-shrink-0" />
        <div className="flex flex-col min-w-0 max-w-[200px]">
          <TruncatedText
            text={context.name}
            tooltipText={fullLabel}
            focusable={false}
            className="text-xs font-medium"
          />
          {context.type === 'knowledge_base' && context.scope_restricted ? (
            <span className="text-xs opacity-70">{formatKnowledgeScopeLabel(context, t)}</span>
          ) : context.type === 'knowledge_base' && context.document_count !== undefined ? (
            <span className="text-xs opacity-70">
              {formatDocumentCount(context.document_count, t)}
            </span>
          ) : null}
          {context.type === 'table' && context.source_config?.url && (
            <TruncatedText
              text={new URL(context.source_config.url).hostname}
              tooltipText={context.source_config.url}
              focusable={false}
              className="text-xs opacity-70"
            />
          )}
          {context.type === 'queue_message' && (
            <span className="text-xs opacity-70 truncate">
              {t('inbox:message.from', { name: (context as QueueMessageContext).senderName })} ·{' '}
              {(context as QueueMessageContext).messageCount} {t('inbox:message.messages_count')}
            </span>
          )}
          {context.type === 'dingtalk_doc' && (
            <span className="text-xs opacity-70 truncate">
              {t('chat:dingtalkDocs.docBadgeHint')}
            </span>
          )}
          {context.type === 'external_knowledge' && (
            <span className="text-xs opacity-70 truncate">
              {(context as ExternalKnowledgeContext).ref.provider}
            </span>
          )}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={e => {
            e.stopPropagation()
            onRemove()
          }}
          className={`h-5 w-5 shrink-0 ml-1 hover:bg-opacity-20 ${getRemoveButtonColor()}`}
          aria-label={`Remove ${context.name}`}
        >
          <X className="h-3 w-3" />
        </Button>
      </div>
    </LongTextTooltip>
  )
}
