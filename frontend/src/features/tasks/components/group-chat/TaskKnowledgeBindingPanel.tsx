// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, Database, Loader2, Plus, Trash2 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { getExternalKnowledgeSource } from '@/features/knowledge/externalKnowledgeSourceRegistry'
import { useTranslation } from '@/hooks/useTranslation'
import { useToast } from '@/hooks/use-toast'
import { formatDocumentCount } from '@/lib/i18n-helpers'
import { cn } from '@/lib/utils'
import { taskKnowledgeBaseApi } from '@/apis/task-knowledge-base'
import type { ExternalKnowledgeRef } from '@/types/context'
import type { BoundKnowledgeBaseDetail } from '@/types/task-knowledge-base'
import BindKnowledgeBaseDialog from './BindKnowledgeBaseDialog'

type TaskKnowledgeBindingItem =
  | {
      kind: 'internal'
      key: string
      displayName: string
      documentCount: number
      description?: string
      boundBy?: string
      boundAt?: string
      raw: BoundKnowledgeBaseDetail
    }
  | {
      kind: 'external'
      key: string
      displayName: string
      providerLabel: string
      targetName?: string
      detailText: string
      raw: ExternalKnowledgeRef
    }

interface TaskKnowledgeBindingPanelProps {
  taskId: number
  onClose?: () => void
}

function externalRefKey(ref: ExternalKnowledgeRef) {
  const targetType = ref.target_type ?? 'knowledge_base'
  const targetId = ref.node_id ?? ref.document_id ?? 'source'
  return `external:${ref.provider}:${ref.mode}:${ref.id ?? 'all'}:${targetType}:${targetId}`
}

function providerBadgeLabel(provider: string) {
  const source = getExternalKnowledgeSource(provider)
  return source?.shortLabel ?? provider.toUpperCase()
}

function externalDisplayName(ref: ExternalKnowledgeRef) {
  return ref.name ?? ref.id ?? ref.provider
}

function externalTargetName(ref: ExternalKnowledgeRef) {
  if (ref.target_name) return ref.target_name
  if (ref.target_type && ref.target_type !== 'knowledge_base') {
    return ref.node_id ?? ref.document_id ?? undefined
  }
  return undefined
}

function formatBoundTime(boundAt?: string) {
  if (!boundAt) return ''
  try {
    return new Date(boundAt).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  } catch {
    return boundAt
  }
}

export default function TaskKnowledgeBindingPanel({
  taskId,
  onClose,
}: TaskKnowledgeBindingPanelProps) {
  const { t } = useTranslation('chat')
  const { toast } = useToast()
  const [internalKnowledgeBases, setInternalKnowledgeBases] = useState<BoundKnowledgeBaseDetail[]>(
    []
  )
  const [externalRefs, setExternalRefs] = useState<ExternalKnowledgeRef[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [externalError, setExternalError] = useState<string | null>(null)
  const [maxInternalLimit, setMaxInternalLimit] = useState(10)
  const [removingKey, setRemovingKey] = useState<string | null>(null)
  const [bindDialogOpen, setBindDialogOpen] = useState(false)

  const bindings = useMemo<TaskKnowledgeBindingItem[]>(() => {
    const internalItems: TaskKnowledgeBindingItem[] = internalKnowledgeBases.map(kb => ({
      kind: 'internal',
      key: `internal:${kb.id}:${kb.name}:${kb.namespace}`,
      displayName: kb.display_name,
      documentCount: kb.document_count || 0,
      description: kb.description,
      boundBy: kb.bound_by,
      boundAt: kb.bound_at,
      raw: kb,
    }))

    const externalItems: TaskKnowledgeBindingItem[] = externalRefs.map(ref => ({
      kind: 'external',
      key: externalRefKey(ref),
      displayName: externalDisplayName(ref),
      providerLabel: providerBadgeLabel(ref.provider),
      targetName: externalTargetName(ref),
      detailText: t('knowledgeBinding.externalKnowledge'),
      raw: ref,
    }))

    return [...internalItems, ...externalItems]
  }, [externalRefs, internalKnowledgeBases, t])

  const fetchBindings = useCallback(async () => {
    setLoading(true)
    setError(null)
    setExternalError(null)
    try {
      const internalResponse = await taskKnowledgeBaseApi.getBoundKnowledgeBases(taskId)
      setInternalKnowledgeBases(internalResponse.items)
      setMaxInternalLimit(internalResponse.max_limit)
    } catch (err) {
      console.error('Failed to fetch internal task knowledge bindings:', err)
      setError(t('knowledgeBinding.loadFailed'))
    } finally {
      setLoading(false)
    }

    try {
      const externalResponse = await taskKnowledgeBaseApi.getBoundExternalKnowledgeRefs(taskId)
      setExternalRefs(externalResponse.items)
    } catch (err) {
      console.warn('Failed to fetch external task knowledge bindings:', err)
      setExternalRefs([])
      setExternalError(t('knowledgeBinding.externalLoadFailed'))
    }
  }, [taskId, t])

  useEffect(() => {
    fetchBindings()
  }, [fetchBindings])

  const handleRemove = async (item: TaskKnowledgeBindingItem) => {
    setRemovingKey(item.key)
    try {
      if (item.kind === 'internal') {
        const kb = item.raw
        await taskKnowledgeBaseApi.unbindKnowledgeBase(taskId, kb.name, kb.namespace)
        setInternalKnowledgeBases(prev =>
          prev.filter(current => !(current.name === kb.name && current.namespace === kb.namespace))
        )
      } else {
        const response = await taskKnowledgeBaseApi.removeExternalKnowledgeRef(taskId, item.raw)
        setExternalRefs(response.items)
      }
      toast({
        description: t('knowledgeBinding.removeSuccess', { name: item.displayName }),
      })
    } catch (err) {
      console.error('Failed to remove task knowledge binding:', err)
      toast({
        variant: 'destructive',
        description: t('knowledgeBinding.removeFailed'),
      })
    } finally {
      setRemovingKey(null)
    }
  }

  const handleBindSuccess = (newKb: BoundKnowledgeBaseDetail) => {
    setInternalKnowledgeBases(prev => [...prev, newKb])
    setBindDialogOpen(false)
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
        <AlertCircle className="mb-2 h-8 w-8 text-red-500" />
        <p className="text-sm text-red-500">{error}</p>
        <Button variant="ghost" size="sm" className="mt-2" onClick={fetchBindings}>
          {t('common:actions.retry')}
        </Button>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <h3 className="text-sm font-medium text-text-primary">{t('knowledgeBinding.title')}</h3>
          <p className="mt-0.5 text-xs text-text-muted">
            {t('knowledgeBinding.count', { count: bindings.length })}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setBindDialogOpen(true)}
          disabled={internalKnowledgeBases.length >= maxInternalLimit}
          className="gap-1"
          data-testid="task-knowledge-binding-add-internal-button"
        >
          <Plus className="h-4 w-4" />
          {t('groupChat.knowledge.add')}
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {externalError ? (
          <div className="mb-3 flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-200">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{externalError}</span>
          </div>
        ) : null}

        {bindings.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <Database className="mb-3 h-12 w-12 text-text-muted/50" />
            <p className="text-sm text-text-muted">{t('knowledgeBinding.empty')}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {bindings.map(item => {
              const isRemoving = removingKey === item.key
              return (
                <div
                  key={item.key}
                  className={cn(
                    'flex items-center justify-between rounded-lg bg-muted p-3 transition-colors hover:bg-muted/80',
                    isRemoving && 'opacity-50'
                  )}
                  data-testid={`task-knowledge-binding-${item.key}`}
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10">
                      <Database className="h-4 w-4 text-primary" />
                    </div>

                    <div className="min-w-0">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium text-text-primary">
                          {item.displayName}
                        </span>
                        {item.kind === 'external' ? (
                          <Badge variant="secondary" size="sm">
                            {item.providerLabel}
                          </Badge>
                        ) : (
                          <span className="rounded bg-surface px-1.5 py-0.5 text-xs text-text-muted">
                            {formatDocumentCount(item.documentCount, t)}
                          </span>
                        )}
                      </div>

                      {item.kind === 'internal' ? (
                        <>
                          {item.description && (
                            <p className="mt-0.5 max-w-[240px] truncate text-xs text-text-muted">
                              {item.description}
                            </p>
                          )}
                          {item.boundBy || item.boundAt ? (
                            <p className="mt-0.5 text-xs text-text-muted/70">
                              {t('groupChat.knowledge.boundBy', {
                                name: item.boundBy,
                                time: formatBoundTime(item.boundAt),
                              })}
                            </p>
                          ) : null}
                        </>
                      ) : (
                        <p className="mt-0.5 max-w-[240px] truncate text-xs text-text-muted">
                          {item.targetName ?? item.detailText}
                        </p>
                      )}
                    </div>
                  </div>

                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0 text-text-muted hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950"
                    onClick={() => handleRemove(item)}
                    disabled={isRemoving}
                    aria-label={t('knowledgeBinding.remove', { name: item.displayName })}
                    data-testid={`task-knowledge-binding-remove-${item.key}`}
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

      {onClose && (
        <div className="px-4 pb-4">
          <Button variant="outline" onClick={onClose} className="w-full">
            {t('common:actions.done')}
          </Button>
        </div>
      )}

      <BindKnowledgeBaseDialog
        open={bindDialogOpen}
        onOpenChange={setBindDialogOpen}
        taskId={taskId}
        boundKnowledgeBases={internalKnowledgeBases}
        onSuccess={handleBindSuccess}
      />
    </div>
  )
}
