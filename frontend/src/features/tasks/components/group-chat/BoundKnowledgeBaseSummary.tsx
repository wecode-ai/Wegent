// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
import { Database, ChevronDown, ChevronUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useTranslation } from '@/hooks/useTranslation'
import { taskKnowledgeBaseApi } from '@/apis/task-knowledge-base'
import type { BoundKnowledgeBaseDetail } from '@/types/task-knowledge-base'
import { cn } from '@/lib/utils'
import { formatDocumentCount } from '@/lib/i18n-helpers'

interface BoundKnowledgeBaseSummaryProps {
  taskId: number
  /** Callback when user clicks to manage knowledge bases */
  onManageClick?: () => void
  /** Custom class name */
  className?: string
}

/**
 * A compact summary component that displays bound knowledge bases for a group chat.
 * Shows a badge with the count of bound knowledge bases, and a popover with details.
 */
export default function BoundKnowledgeBaseSummary({
  taskId,
  onManageClick,
  className,
}: BoundKnowledgeBaseSummaryProps) {
  const { t } = useTranslation('chat')
  const [knowledgeBases, setKnowledgeBases] = useState<BoundKnowledgeBaseDetail[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(false)

  const fetchKnowledgeBases = useCallback(async () => {
    setLoading(true)
    try {
      const response = await taskKnowledgeBaseApi.getBoundKnowledgeBases(taskId)
      setKnowledgeBases(response.items)
    } catch (error) {
      console.error('Failed to fetch bound knowledge bases:', error)
      setKnowledgeBases([])
    } finally {
      setLoading(false)
    }
  }, [taskId])

  useEffect(() => {
    fetchKnowledgeBases()
  }, [fetchKnowledgeBases])

  // Don't render if no knowledge bases are bound
  if (!loading && knowledgeBases.length === 0) {
    return null
  }

  // Show loading state briefly
  if (loading) {
    return null
  }

  const totalDocuments = knowledgeBases.reduce((sum, kb) => sum + (kb.document_count || 0), 0)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            'h-7 px-2 gap-1.5 text-xs font-normal',
            'text-text-muted hover:text-text-primary',
            'hover:bg-muted/50',
            className
          )}
        >
          <Database className="h-3.5 w-3.5 text-primary" />
          <span>{knowledgeBases.length}</span>
          {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start" sideOffset={4}>
        <div className="p-3 border-b border-border">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium text-text-primary">
              {t('groupChat.knowledge.title')}
            </h4>
            <span className="text-xs text-text-muted">
              {t('groupChat.knowledge.limit', {
                count: knowledgeBases.length,
                max: 10,
              })}
            </span>
          </div>
          <p className="text-xs text-text-muted mt-1">
            {t('knowledgeSummary.totalDocuments', { count: totalDocuments })}
          </p>
        </div>
        <div className="max-h-48 overflow-y-auto">
          {knowledgeBases.map(kb => (
            <div
              key={`${kb.name}:${kb.namespace}`}
              className="px-3 py-2 hover:bg-muted/50 transition-colors"
            >
              <div className="flex items-start gap-2">
                <Database className="h-4 w-4 text-primary flex-shrink-0 mt-0.5" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-text-primary truncate">
                      {kb.display_name}
                    </span>
                    <span className="text-xs text-text-muted bg-surface px-1.5 py-0.5 rounded flex-shrink-0">
                      {formatDocumentCount(kb.document_count || 0, t)}
                    </span>
                  </div>
                  {kb.description && (
                    <p className="text-xs text-text-muted truncate mt-0.5">{kb.description}</p>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
        {onManageClick && (
          <div className="p-2 border-t border-border">
            <Button
              variant="ghost"
              size="sm"
              className="w-full text-xs"
              onClick={() => {
                setOpen(false)
                onManageClick()
              }}
            >
              {t('knowledgeSummary.manage')}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
