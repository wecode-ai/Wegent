// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import { X, Database, Table2, MessageSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import type { ContextItem, QueueMessageContext } from '@/types/context'
import { formatDocumentCount } from '@/lib/i18n-helpers'

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
      default:
        return 'border-primary bg-primary/10 text-primary'
    }
  }

  // Handle badge click - open table URL in new window (only if not disabled)
  const handleBadgeClick = (e: React.MouseEvent) => {
    if (!disableUrlClick && context.type === 'table' && context.source_config?.url) {
      e.stopPropagation()
      window.open(context.source_config.url, '_blank', 'noopener,noreferrer')
    }
  }

  const isClickable = !disableUrlClick && context.type === 'table' && context.source_config?.url

  // Get remove button color based on context type
  const getRemoveButtonColor = () => {
    switch (context.type) {
      case 'table':
        return 'text-blue-600 hover:text-blue-600 hover:bg-blue-500/20'
      case 'queue_message':
        return 'text-orange-600 hover:text-orange-600 hover:bg-orange-500/20'
      default:
        return 'text-primary hover:text-primary hover:bg-primary/20'
    }
  }

  return (
    <div
      className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border ${getBadgeColor()} ${
        isClickable ? 'cursor-pointer hover:shadow-md transition-shadow' : ''
      }`}
      onClick={handleBadgeClick}
      role={isClickable ? 'button' : undefined}
      tabIndex={isClickable ? 0 : undefined}
      title={isClickable ? t('knowledge:document.document.openLink') : undefined}
    >
      <Icon className="h-4 w-4 flex-shrink-0" />
      <div className="flex flex-col min-w-0 max-w-[200px]">
        <span className="text-xs font-medium truncate" title={context.name}>
          {context.name}
        </span>
        {context.type === 'knowledge_base' && context.document_count !== undefined && (
          <span className="text-xs opacity-70">
            {formatDocumentCount(context.document_count, t)}
          </span>
        )}
        {context.type === 'table' && context.source_config?.url && (
          <span className="text-xs opacity-70 truncate" title={context.source_config.url}>
            {new URL(context.source_config.url).hostname}
          </span>
        )}
        {context.type === 'queue_message' && (
          <span className="text-xs opacity-70 truncate">
            {t('inbox:message.from', { name: (context as QueueMessageContext).senderName })} ·{' '}
            {(context as QueueMessageContext).messageCount} {t('inbox:message.messages_count')}
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
        className={`h-5 w-5 ml-1 hover:bg-opacity-20 ${getRemoveButtonColor()}`}
        aria-label={`Remove ${context.name}`}
      >
        <X className="h-3 w-3" />
      </Button>
    </div>
  )
}
