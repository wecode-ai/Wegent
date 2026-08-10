// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useMemo } from 'react'
import { Cloud, Database, Check, Loader2, Search } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useTranslation } from '@/hooks/useTranslation'
import { knowledgeBaseApi } from '@/apis/knowledge-base'
import { taskKnowledgeBaseApi } from '@/apis/task-knowledge-base'
import type { KnowledgeBase } from '@/types/api'
import type { BoundKnowledgeBaseDetail } from '@/types/task-knowledge-base'
import type { ExternalKnowledgeRef } from '@/types/context'
import type { ExternalKnowledgeBase } from '@/types/external-knowledge'
import { loadKBExtensions } from '@/features/knowledge/document/extension-loader'
import {
  useExternalKnowledgeSources,
  type ExternalKnowledgeSource,
} from '@/features/knowledge/externalKnowledgeSourceRegistry'
import { listAllExternalKnowledgeBases } from '@/features/knowledge/externalKnowledgePagination'
import { cn } from '@/lib/utils'
import { toast } from '@/hooks/use-toast'
import { formatDocumentCount } from '@/lib/i18n-helpers'

interface BindKnowledgeBaseDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  taskId: number
  boundKnowledgeBases: BoundKnowledgeBaseDetail[]
  boundExternalRefs: ExternalKnowledgeRef[]
  onSuccess: (kb: BoundKnowledgeBaseDetail) => void
  onExternalSuccess?: (refs: ExternalKnowledgeRef[]) => void
  internalLimitReached?: boolean
}

interface ExternalKnowledgeOption {
  key: string
  providerLabel: string
  knowledgeBase: ExternalKnowledgeBase
  ref: ExternalKnowledgeRef
}

export default function BindKnowledgeBaseDialog({
  open,
  onOpenChange,
  taskId,
  boundKnowledgeBases,
  boundExternalRefs,
  onSuccess,
  onExternalSuccess,
  internalLimitReached = false,
}: BindKnowledgeBaseDialogProps) {
  const { t } = useTranslation('chat')
  const externalSources = useExternalKnowledgeSources()
  const [mode, setMode] = useState<'internal' | 'external'>('internal')
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [externalOptions, setExternalOptions] = useState<ExternalKnowledgeOption[]>([])
  const [externalLoading, setExternalLoading] = useState(false)
  const [externalError, setExternalError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedKb, setSelectedKb] = useState<KnowledgeBase | null>(null)
  const [selectedExternal, setSelectedExternal] = useState<ExternalKnowledgeOption | null>(null)
  const [binding, setBinding] = useState(false)

  useEffect(() => {
    loadKBExtensions().catch((err: unknown) => {
      console.warn('Failed to load external knowledge extensions for task binding', err)
    })
  }, [])

  useEffect(() => {
    if (open && internalLimitReached) {
      setMode('external')
    }
  }, [internalLimitReached, open])

  // Fetch available knowledge bases
  useEffect(() => {
    if (!open) return

    const fetchKnowledgeBases = async () => {
      setLoading(true)
      setError(null)
      try {
        const response = await knowledgeBaseApi.list({ scope: 'all' })
        setKnowledgeBases(response.items)
      } catch (err) {
        console.error('Failed to fetch knowledge bases:', err)
        setError(t('knowledge:fetch_error'))
      } finally {
        setLoading(false)
      }
    }

    fetchKnowledgeBases()
  }, [open, t])

  useEffect(() => {
    if (!open) return

    const fetchExternalKnowledge = async () => {
      setExternalLoading(true)
      setExternalError(null)
      try {
        const optionGroups = await Promise.all(
          externalSources
            .filter(source => source.capabilities?.supportsKnowledgeBaseSelection === true)
            .map(async source => {
              const knowledgeBases = await listAllExternalKnowledgeBases(source, { scope: 'all' })
              return knowledgeBases.map(kb => toExternalOption(source, kb))
            })
        )
        setExternalOptions(optionGroups.flat())
      } catch (err) {
        console.error('Failed to fetch external knowledge bases:', err)
        setExternalError(t('knowledgeBinding.externalLoadFailed'))
      } finally {
        setExternalLoading(false)
      }
    }

    fetchExternalKnowledge()
  }, [externalSources, open, t])

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setSearchQuery('')
      setSelectedKb(null)
      setSelectedExternal(null)
      setMode('internal')
    }
  }, [open])

  // Filter knowledge bases: exclude already bound ones and apply search
  const availableKnowledgeBases = useMemo(() => {
    const boundIds = new Set(boundKnowledgeBases.map(kb => kb.id))

    return knowledgeBases
      .filter(kb => {
        // Exclude already bound knowledge bases by stable ID.
        if (boundIds.has(kb.id)) return false

        // Apply search filter
        if (searchQuery) {
          const query = searchQuery.toLowerCase()
          return (
            kb.name.toLowerCase().includes(query) ||
            (kb.description && kb.description.toLowerCase().includes(query))
          )
        }
        return true
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [knowledgeBases, boundKnowledgeBases, searchQuery])

  const availableExternalOptions = useMemo(() => {
    const boundKeys = new Set(boundExternalRefs.map(externalRefKey))
    return externalOptions
      .filter(option => !boundKeys.has(externalRefKey(option.ref)))
      .filter(option => {
        if (!searchQuery) return true
        const query = searchQuery.toLowerCase()
        return (
          option.knowledgeBase.knowledge_base_name.toLowerCase().includes(query) ||
          option.providerLabel.toLowerCase().includes(query)
        )
      })
      .sort((a, b) =>
        `${a.providerLabel}/${a.knowledgeBase.knowledge_base_name}`.localeCompare(
          `${b.providerLabel}/${b.knowledgeBase.knowledge_base_name}`
        )
      )
  }, [boundExternalRefs, externalOptions, searchQuery])

  const handleBind = async () => {
    if (mode === 'internal' && !selectedKb) return
    if (mode === 'external' && !selectedExternal) return

    setBinding(true)
    try {
      if (mode === 'external' && selectedExternal) {
        const result = await taskKnowledgeBaseApi.bindExternalKnowledgeRefs(taskId, [
          selectedExternal.ref,
        ])
        toast({
          description: t('groupChat.knowledge.bindSuccess', {
            name: selectedExternal.knowledgeBase.knowledge_base_name,
          }),
        })
        onExternalSuccess?.(result.items)
        return
      }
      if (!selectedKb) return
      const result = await taskKnowledgeBaseApi.bindKnowledgeBase(
        taskId,
        selectedKb.name,
        selectedKb.namespace || 'default'
      )
      toast({
        description: t('groupChat.knowledge.bindSuccess', { name: selectedKb.name }),
      })
      onSuccess(result)
    } catch (err: unknown) {
      console.error('Failed to bind knowledge base:', err)
      const errorMessage = err instanceof Error ? err.message : t('groupChat.knowledge.bindFailed')
      toast({
        variant: 'destructive',
        description: errorMessage,
      })
    } finally {
      setBinding(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Database className="w-5 h-5" />
            {t('groupChat.knowledge.addTitle')}
          </DialogTitle>
          <DialogDescription>{t('groupChat.knowledge.addDescription')}</DialogDescription>
        </DialogHeader>

        <div className="flex-1 flex flex-col min-h-0 space-y-4">
          <div className="grid grid-cols-2 gap-1 rounded-md bg-muted p-1">
            <Button
              type="button"
              variant={mode === 'internal' ? 'primary' : 'ghost'}
              size="sm"
              className="h-8"
              disabled={internalLimitReached}
              onClick={() => setMode('internal')}
              data-testid="task-knowledge-bind-internal-tab"
            >
              <Database className="mr-1.5 h-4 w-4" />
              {t('knowledgeBinding.internalKnowledge')}
            </Button>
            <Button
              type="button"
              variant={mode === 'external' ? 'primary' : 'ghost'}
              size="sm"
              className="h-8"
              onClick={() => setMode('external')}
              data-testid="task-knowledge-bind-external-tab"
            >
              <Cloud className="mr-1.5 h-4 w-4" />
              {t('knowledgeBinding.externalKnowledge')}
            </Button>
          </div>

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-text-muted" />
            <Input
              placeholder={t('knowledge:search_placeholder')}
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>

          {/* List */}
          {mode === 'internal' && loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-text-muted" />
            </div>
          ) : mode === 'internal' && error ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <p className="text-sm text-red-500">{error}</p>
            </div>
          ) : mode === 'internal' && availableKnowledgeBases.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <Database className="h-10 w-10 text-text-muted/50 mb-2" />
              <p className="text-sm text-text-muted">
                {searchQuery ? t('common:branches.no_match') : t('groupChat.knowledge.noAvailable')}
              </p>
            </div>
          ) : mode === 'internal' ? (
            <div className="space-y-2 max-h-64 overflow-y-auto flex-1">
              {availableKnowledgeBases.map(kb => {
                const isSelected =
                  selectedKb?.id === kb.id ||
                  (selectedKb?.name === kb.name && selectedKb?.namespace === kb.namespace)
                const documentCount = kb.document_count || 0
                const documentText = formatDocumentCount(documentCount, t)

                return (
                  <div
                    key={kb.id}
                    className={cn(
                      'flex items-center justify-between p-3 rounded-lg cursor-pointer transition-colors',
                      isSelected
                        ? 'bg-primary/10 ring-1 ring-primary'
                        : 'bg-muted hover:bg-muted/80'
                    )}
                    onClick={() => setSelectedKb(kb)}
                  >
                    <div className="flex items-center gap-3">
                      {/* Icon */}
                      <div
                        className={cn(
                          'w-8 h-8 rounded-full flex items-center justify-center',
                          isSelected ? 'bg-primary/20' : 'bg-primary/10'
                        )}
                      >
                        <Database
                          className={cn('h-4 w-4', isSelected ? 'text-primary' : 'text-primary/70')}
                        />
                      </div>

                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span
                            className={cn(
                              'font-medium text-sm truncate',
                              isSelected ? 'text-primary' : 'text-text-primary'
                            )}
                          >
                            {kb.name}
                          </span>
                          <span className="text-xs text-text-muted bg-surface px-1.5 py-0.5 rounded">
                            {documentText}
                          </span>
                        </div>
                        {kb.description && (
                          <p className="text-xs text-text-muted mt-0.5 truncate max-w-[250px]">
                            {kb.description}
                          </p>
                        )}
                      </div>
                    </div>
                    {isSelected && <Check className="h-5 w-5 text-primary flex-shrink-0" />}
                  </div>
                )
              })}
            </div>
          ) : externalLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-text-muted" />
            </div>
          ) : externalError ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <p className="text-sm text-red-500">{externalError}</p>
            </div>
          ) : availableExternalOptions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <Cloud className="h-10 w-10 text-text-muted/50 mb-2" />
              <p className="text-sm text-text-muted">
                {searchQuery
                  ? t('common:branches.no_match')
                  : t('knowledgeBinding.noAvailableExternal')}
              </p>
            </div>
          ) : (
            <div className="space-y-2 max-h-64 overflow-y-auto flex-1">
              {availableExternalOptions.map(option => {
                const isSelected = selectedExternal?.key === option.key
                const documentText = formatDocumentCount(
                  option.knowledgeBase.document_count || 0,
                  t
                )

                return (
                  <div
                    key={option.key}
                    className={cn(
                      'flex items-center justify-between p-3 rounded-lg cursor-pointer transition-colors',
                      isSelected
                        ? 'bg-primary/10 ring-1 ring-primary'
                        : 'bg-muted hover:bg-muted/80'
                    )}
                    onClick={() => setSelectedExternal(option)}
                    data-testid={`task-knowledge-bind-external-option-${option.key}`}
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <div
                        className={cn(
                          'w-8 h-8 rounded-full flex items-center justify-center',
                          isSelected ? 'bg-primary/20' : 'bg-primary/10'
                        )}
                      >
                        <Cloud
                          className={cn('h-4 w-4', isSelected ? 'text-primary' : 'text-primary/70')}
                        />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-text-muted">{option.providerLabel}</span>
                          <span
                            className={cn(
                              'font-medium text-sm truncate',
                              isSelected ? 'text-primary' : 'text-text-primary'
                            )}
                          >
                            {option.knowledgeBase.knowledge_base_name}
                          </span>
                          <span className="text-xs text-text-muted bg-surface px-1.5 py-0.5 rounded">
                            {documentText}
                          </span>
                        </div>
                      </div>
                    </div>
                    {isSelected && <Check className="h-5 w-5 text-primary flex-shrink-0" />}
                  </div>
                )
              })}
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common:actions.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={handleBind}
              disabled={
                binding ||
                (mode === 'internal' && !selectedKb) ||
                (mode === 'external' && !selectedExternal)
              }
            >
              {binding && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('groupChat.knowledge.add')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function externalRefKey(ref: ExternalKnowledgeRef): string {
  return [
    ref.provider,
    ref.mode,
    ref.id ?? 'all',
    ref.target_type ?? 'knowledge_base',
    ref.node_id ?? ref.document_id ?? '',
  ].join(':')
}

function toExternalOption(
  source: ExternalKnowledgeSource,
  knowledgeBase: ExternalKnowledgeBase
): ExternalKnowledgeOption {
  const ref = source.toRef?.(knowledgeBase) ?? {
    provider: source.providerId,
    mode: 'explicit' as const,
    id: knowledgeBase.knowledge_base_id,
    name: knowledgeBase.knowledge_base_name,
    scope: knowledgeBase.scope ?? undefined,
    target_type: 'knowledge_base' as const,
  }
  return {
    key: externalRefKey(ref),
    providerLabel: source.shortLabel || source.label || source.providerId,
    knowledgeBase,
    ref: {
      ...ref,
      target_type: ref.target_type ?? 'knowledge_base',
      target_name: ref.target_name ?? knowledgeBase.knowledge_base_name,
    },
  }
}
