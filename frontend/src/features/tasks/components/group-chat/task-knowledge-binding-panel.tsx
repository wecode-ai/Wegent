// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, Database, Loader2, Plus, Trash2 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { LongTextTooltip, TruncatedText } from '@/components/common/long-text'
import { loadKBExtensions } from '@/features/knowledge/document/extension-loader'
import { getExternalKnowledgeSource } from '@/features/knowledge/externalKnowledgeSourceRegistry'
import { groupExternalRefs } from '@/features/tasks/utils/knowledge-selection-groups'
import { useTranslation } from '@/hooks/useTranslation'
import { useToast } from '@/hooks/use-toast'
import { formatDocumentCount } from '@/lib/i18n-helpers'
import { cn } from '@/lib/utils'
import { taskKnowledgeBaseApi } from '@/apis/task-knowledge-base'
import type { ExternalKnowledgeRef } from '@/types/context'
import type { ContextWarning } from '@/types/api'
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
      fullLabel: string
      raw: ExternalKnowledgeRef[]
    }

interface TaskKnowledgeBindingPanelProps {
  taskId: number
  onClose?: () => void
}

function providerBadgeLabel(provider: string) {
  const source = getExternalKnowledgeSource(provider)
  return source?.shortLabel ?? provider.toUpperCase()
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

function contextWarningMessage(warning: ContextWarning, t: ReturnType<typeof useTranslation>['t']) {
  if (warning.reason === 'unsupported_binding') {
    return t('knowledgeBinding.warningUnsupportedBinding')
  }
  return warning.message || warning.reason
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
  const [contextWarnings, setContextWarnings] = useState<ContextWarning[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [externalError, setExternalError] = useState<string | null>(null)
  const [maxInternalLimit, setMaxInternalLimit] = useState(10)
  const [removingKey, setRemovingKey] = useState<string | null>(null)
  const [bindDialogOpen, setBindDialogOpen] = useState(false)

  useEffect(() => {
    loadKBExtensions().catch((err: unknown) => {
      console.warn('Failed to load KB extensions for task knowledge binding panel', err)
    })
  }, [])

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

    const externalItems: TaskKnowledgeBindingItem[] = groupExternalRefs(externalRefs).map(group => {
      const rawRefs = group.refs
        .filter(
          (context): context is import('@/types/context').ExternalKnowledgeContext =>
            context.type === 'external_knowledge'
        )
        .map(context => context.ref)
      const firstRef = rawRefs[0]
      const fullLabel =
        group.selectionMode === 'all' || group.selectedTargetNames.length === 0
          ? group.sourceName
          : group.selectedTargetNames
              .map(targetName => `${group.sourceName} / ${targetName}`)
              .join('\n')
      return {
        kind: 'external',
        key: group.key,
        displayName: group.sourceName,
        providerLabel: providerBadgeLabel(group.provider ?? ''),
        targetName:
          group.selectionMode === 'all'
            ? t('knowledgeBinding.externalKnowledge')
            : t('knowledgeBinding.selectedExternalTargets', {
                count: group.selectedTargetCount,
              }),
        detailText: firstRef ? (externalTargetName(firstRef) ?? '') : '',
        fullLabel,
        raw: rawRefs,
      }
    })

    return [...internalItems, ...externalItems]
  }, [externalRefs, internalKnowledgeBases, t])

  const fetchBindings = useCallback(async () => {
    setLoading(true)
    setError(null)
    setExternalError(null)

    const [internalResult, externalResult] = await Promise.allSettled([
      taskKnowledgeBaseApi.getBoundKnowledgeBases(taskId),
      taskKnowledgeBaseApi.getBoundExternalKnowledgeRefs(taskId),
    ])

    try {
      if (internalResult.status !== 'fulfilled') {
        throw internalResult.reason
      }
      const internalResponse = internalResult.value
      setInternalKnowledgeBases(internalResponse.items)
      setMaxInternalLimit(internalResponse.max_limit)
    } catch (err) {
      console.error('Failed to fetch internal task knowledge bindings:', err)
      setError(t('knowledgeBinding.loadFailed'))
    }

    try {
      if (externalResult.status !== 'fulfilled') {
        throw externalResult.reason
      }
      const externalResponse = externalResult.value
      setExternalRefs(externalResponse.items)
      setContextWarnings(externalResponse.context_warnings ?? [])
    } catch (err) {
      console.warn('Failed to fetch external task knowledge bindings:', err)
      setExternalRefs([])
      setContextWarnings([])
      setExternalError(t('knowledgeBinding.externalLoadFailed'))
    } finally {
      setLoading(false)
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
        await taskKnowledgeBaseApi.unbindKnowledgeBase(taskId, kb.name, kb.namespace, kb.id)
        setInternalKnowledgeBases(prev =>
          prev.filter(current =>
            current.id != null && kb.id != null
              ? current.id !== kb.id
              : !(current.name === kb.name && current.namespace === kb.namespace)
          )
        )
      } else {
        let nextRefs = externalRefs
        for (const ref of item.raw) {
          const response = await taskKnowledgeBaseApi.removeExternalKnowledgeRef(taskId, ref)
          nextRefs = response.items
        }
        setExternalRefs(nextRefs)
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

  const handleExternalBindSuccess = (refs: ExternalKnowledgeRef[]) => {
    setExternalRefs(refs)
    fetchBindings()
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
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
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
          className="gap-1"
          data-testid="task-knowledge-binding-add-button"
        >
          <Plus className="h-4 w-4" />
          {t('groupChat.knowledge.add')}
        </Button>
      </div>

      <div
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
        data-testid="task-knowledge-binding-list"
      >
        {externalError ? (
          <div className="mb-3 flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-200">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{externalError}</span>
          </div>
        ) : null}

        {contextWarnings.length > 0 ? (
          <div
            className="mb-3 space-y-1 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-200"
            data-testid="task-knowledge-binding-context-warnings"
          >
            {contextWarnings.map((warning, index) => (
              <div
                key={`${warning.type}:${warning.id ?? index}:${warning.reason}`}
                className="flex items-start gap-2"
              >
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  {warning.name ? `${warning.name}: ` : ''}
                  {contextWarningMessage(warning, t)}
                </span>
              </div>
            ))}
          </div>
        ) : null}

        {bindings.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <Database className="mb-3 h-12 w-12 text-text-muted/50" />
            <p className="text-sm text-text-muted">{t('knowledgeBinding.empty')}</p>
          </div>
        ) : (
          <div className="space-y-4">
            {[
              {
                key: 'internal',
                title: t('knowledgeBinding.internalKnowledge'),
                items: bindings.filter(item => item.kind === 'internal'),
              },
              {
                key: 'external',
                title: t('knowledgeBinding.externalKnowledgeSection'),
                items: bindings.filter(item => item.kind === 'external'),
              },
            ]
              .filter(section => section.items.length > 0)
              .map(section => (
                <section
                  key={section.key}
                  data-testid={`task-knowledge-binding-${section.key}-section`}
                >
                  <h4 className="mb-2 text-xs font-medium text-text-muted">{section.title}</h4>
                  <div className="space-y-2">
                    {section.items.map(item => {
                      const isRemoving = removingKey === item.key
                      const fullLabel = item.kind === 'external' ? item.fullLabel : item.displayName
                      return (
                        <LongTextTooltip key={item.key} content={fullLabel}>
                          <div
                            className={cn(
                              'flex items-center justify-between rounded-lg bg-muted p-3 transition-colors hover:bg-muted/80',
                              isRemoving && 'opacity-50'
                            )}
                            data-testid={`task-knowledge-binding-${item.key}`}
                            aria-label={fullLabel}
                          >
                            <div className="flex min-w-0 flex-1 items-center gap-3">
                              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10">
                                <Database className="h-4 w-4 text-primary" />
                              </div>

                              <div className="min-w-0 flex-1">
                                <div className="flex min-w-0 items-center gap-2">
                                  <TruncatedText
                                    text={item.displayName}
                                    tooltipText={fullLabel}
                                    focusable={false}
                                    className="text-sm font-medium text-text-primary"
                                  />
                                  {item.kind === 'external' ? (
                                    <Badge variant="secondary" size="sm" className="shrink-0">
                                      {item.providerLabel}
                                    </Badge>
                                  ) : (
                                    <span className="shrink-0 rounded bg-surface px-1.5 py-0.5 text-xs text-text-muted">
                                      {formatDocumentCount(item.documentCount, t)}
                                    </span>
                                  )}
                                </div>

                                {item.kind === 'internal' ? (
                                  <>
                                    {item.description && (
                                      <TruncatedText
                                        text={item.description}
                                        focusable={false}
                                        className="mt-0.5 max-w-[240px] text-xs text-text-muted"
                                      />
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
                                  <TruncatedText
                                    text={item.targetName ?? item.detailText}
                                    tooltipText={item.fullLabel}
                                    focusable={false}
                                    className="mt-0.5 max-w-[240px] text-xs text-text-muted"
                                  />
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
                        </LongTextTooltip>
                      )
                    })}
                  </div>
                </section>
              ))}
          </div>
        )}
      </div>

      {onClose && (
        <div className="shrink-0 px-4 pb-4">
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
        boundExternalRefs={externalRefs}
        onSuccess={handleBindSuccess}
        onExternalSuccess={handleExternalBindSuccess}
        internalLimitReached={internalKnowledgeBases.length >= maxInternalLimit}
      />
    </div>
  )
}
