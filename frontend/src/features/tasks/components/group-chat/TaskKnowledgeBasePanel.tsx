// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
import { Database, Plus, Trash2, AlertCircle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { taskKnowledgeBaseApi } from '@/apis/task-knowledge-base'
import type { BoundKnowledgeBaseDetail } from '@/types/task-knowledge-base'
import { cn } from '@/lib/utils'
import { toast } from '@/hooks/use-toast'
import { formatDocumentCount } from '@/lib/i18n-helpers'
import BindKnowledgeBaseDialog from './BindKnowledgeBaseDialog'

interface TaskKnowledgeBasePanelProps {
  taskId: number
  onClose?: () => void
}

export default function TaskKnowledgeBasePanel({ taskId, onClose }: TaskKnowledgeBasePanelProps) {
  const { t } = useTranslation('chat')
  const [knowledgeBases, setKnowledgeBases] = useState<BoundKnowledgeBaseDetail[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [maxLimit, setMaxLimit] = useState(10)
  const [removingKb, setRemovingKb] = useState<string | null>(null)
  const [bindDialogOpen, setBindDialogOpen] = useState(false)

  const fetchKnowledgeBases = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await taskKnowledgeBaseApi.getBoundKnowledgeBases(taskId)
      setKnowledgeBases(response.items)
      setMaxLimit(response.max_limit)
    } catch (err) {
      console.error('Failed to fetch bound knowledge bases:', err)
      setError(t('groupChat.knowledge.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [taskId, t])

  useEffect(() => {
    fetchKnowledgeBases()
  }, [fetchKnowledgeBases])

  const handleRemove = async (kb: BoundKnowledgeBaseDetail) => {
    const kbKey = `${kb.name}:${kb.namespace}`
    setRemovingKb(kbKey)
    try {
      await taskKnowledgeBaseApi.unbindKnowledgeBase(taskId, kb.name, kb.namespace)
      setKnowledgeBases(prev =>
        prev.filter(item => !(item.name === kb.name && item.namespace === kb.namespace))
      )
      toast({
        description: t('groupChat.knowledge.removeSuccess', { name: kb.display_name }),
      })
    } catch (err) {
      console.error('Failed to unbind knowledge base:', err)
      toast({
        variant: 'destructive',
        description: t('groupChat.knowledge.removeFailed'),
      })
    } finally {
      setRemovingKb(null)
    }
  }

  const handleBindSuccess = (newKb: BoundKnowledgeBaseDetail) => {
    setKnowledgeBases(prev => [...prev, newKb])
    setBindDialogOpen(false)
  }

  const formatBoundTime = (boundAt: string) => {
    try {
      const date = new Date(boundAt)
      return date.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    } catch {
      return boundAt
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin text-text-muted" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <AlertCircle className="h-8 w-8 text-red-500 mb-2" />
        <p className="text-sm text-red-500">{error}</p>
        <Button variant="ghost" size="sm" className="mt-2" onClick={fetchKnowledgeBases}>
          {t('common:actions.retry')}
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div>
          <h3 className="text-sm font-medium text-text-primary">
            {t('groupChat.knowledge.title')}
          </h3>
          <p className="text-xs text-text-muted mt-0.5">
            {t('groupChat.knowledge.limit', {
              count: knowledgeBases.length,
              max: maxLimit,
            })}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setBindDialogOpen(true)}
          disabled={knowledgeBases.length >= maxLimit}
          className="gap-1"
        >
          <Plus className="h-4 w-4" />
          {t('groupChat.knowledge.add')}
        </Button>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {knowledgeBases.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <Database className="h-12 w-12 text-text-muted/50 mb-3" />
            <p className="text-sm text-text-muted">{t('groupChat.knowledge.empty')}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {knowledgeBases.map(kb => {
              const kbKey = `${kb.name}:${kb.namespace}`
              const isRemoving = removingKb === kbKey
              return (
                <div
                  key={kbKey}
                  className={cn(
                    'flex items-center justify-between p-3 rounded-lg',
                    'bg-muted hover:bg-muted/80 transition-colors',
                    isRemoving && 'opacity-50'
                  )}
                >
                  <div className="flex items-center gap-3">
                    {/* Icon */}
                    <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                      <Database className="h-4 w-4 text-primary" />
                    </div>

                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm truncate">{kb.display_name}</span>
                        <span className="text-xs text-text-muted bg-surface px-1.5 py-0.5 rounded">
                          {formatDocumentCount(kb.document_count || 0, t)}
                        </span>
                      </div>
                      {kb.description && (
                        <p className="text-xs text-text-muted mt-0.5 truncate max-w-[200px]">
                          {kb.description}
                        </p>
                      )}
                      <p className="text-xs text-text-muted/70 mt-0.5">
                        {t('groupChat.knowledge.boundBy', {
                          name: kb.bound_by,
                          time: formatBoundTime(kb.bound_at),
                        })}
                      </p>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-text-muted hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950"
                    onClick={() => handleRemove(kb)}
                    disabled={isRemoving}
                  >
                    {isRemoving ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Done button */}
      {onClose && (
        <div className="px-4 pb-4">
          <Button variant="outline" onClick={onClose} className="w-full">
            {t('common:actions.done')}
          </Button>
        </div>
      )}

      {/* Bind Dialog */}
      <BindKnowledgeBaseDialog
        open={bindDialogOpen}
        onOpenChange={setBindDialogOpen}
        taskId={taskId}
        boundKnowledgeBases={knowledgeBases}
        onSuccess={handleBindSuccess}
      />
    </div>
  )
}
