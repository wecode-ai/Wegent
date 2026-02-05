'use client'

// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Knowledge Base Selector component for Subscription form.
 * Allows selecting one or more knowledge bases to bind to a subscription.
 */
import { useState, useEffect, useMemo } from 'react'
import { Database, X, Plus, Loader2, Search } from 'lucide-react'
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
import type { KnowledgeBase } from '@/types/api'
import type { SubscriptionKnowledgeBaseRef } from '@/types/subscription'
import { cn } from '@/lib/utils'
import { formatDocumentCount } from '@/lib/i18n-helpers'

interface KnowledgeBaseSelectorProps {
  selectedKnowledgeBases: SubscriptionKnowledgeBaseRef[]
  onChange: (knowledgeBases: SubscriptionKnowledgeBaseRef[]) => void
  disabled?: boolean
}

interface KnowledgeBaseSelectorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  selectedKnowledgeBases: SubscriptionKnowledgeBaseRef[]
  onSelect: (kb: SubscriptionKnowledgeBaseRef) => void
}

/**
 * Dialog for selecting knowledge bases
 */
function KnowledgeBaseSelectorDialog({
  open,
  onOpenChange,
  selectedKnowledgeBases,
  onSelect,
}: KnowledgeBaseSelectorDialogProps) {
  const { t } = useTranslation('feed')
  const { t: tKnowledge } = useTranslation('knowledge')
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')

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
        setError(tKnowledge('fetch_error'))
      } finally {
        setLoading(false)
      }
    }

    fetchKnowledgeBases()
  }, [open, tKnowledge])

  // Reset search when dialog closes
  useEffect(() => {
    if (!open) {
      setSearchQuery('')
    }
  }, [open])

  // Filter knowledge bases: exclude already selected ones and apply search
  const availableKnowledgeBases = useMemo(() => {
    const selectedKeys = new Set(selectedKnowledgeBases.map(kb => `${kb.name}:${kb.namespace}`))

    return knowledgeBases
      .filter(kb => {
        // Exclude already selected knowledge bases
        const kbKey = `${kb.name}:${kb.namespace || 'default'}`
        if (selectedKeys.has(kbKey)) return false

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
  }, [knowledgeBases, selectedKnowledgeBases, searchQuery])

  const handleSelect = (kb: KnowledgeBase) => {
    onSelect({
      name: kb.name,
      namespace: kb.namespace || 'default',
    })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Database className="w-5 h-5" />
            {t('select_knowledge_base')}
          </DialogTitle>
          <DialogDescription>{t('select_knowledge_base_desc')}</DialogDescription>
        </DialogHeader>

        <div className="flex-1 flex flex-col min-h-0 space-y-4">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-text-muted" />
            <Input
              placeholder={tKnowledge('search_placeholder')}
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>

          {/* List */}
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-text-muted" />
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <p className="text-sm text-red-500">{error}</p>
            </div>
          ) : availableKnowledgeBases.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <Database className="h-10 w-10 text-text-muted/50 mb-2" />
              <p className="text-sm text-text-muted">
                {searchQuery ? t('no_knowledge_bases_match') : t('no_knowledge_bases_available')}
              </p>
            </div>
          ) : (
            <div className="space-y-2 max-h-64 overflow-y-auto flex-1">
              {availableKnowledgeBases.map(kb => {
                const documentCount = kb.document_count || 0
                const documentText = formatDocumentCount(documentCount, tKnowledge)

                return (
                  <div
                    key={kb.id}
                    className={cn(
                      'flex items-center justify-between p-3 rounded-lg cursor-pointer transition-colors',
                      'bg-muted hover:bg-muted/80'
                    )}
                    onClick={() => handleSelect(kb)}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      {/* Icon */}
                      <div className="w-8 h-8 rounded-full flex items-center justify-center bg-primary/10">
                        <Database className="h-4 w-4 text-primary/70" />
                      </div>

                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm truncate text-text-primary">
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
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Knowledge Base Selector component for Subscription form
 */
export function KnowledgeBaseSelector({
  selectedKnowledgeBases,
  onChange,
  disabled = false,
}: KnowledgeBaseSelectorProps) {
  const { t } = useTranslation('feed')
  const [dialogOpen, setDialogOpen] = useState(false)

  const handleAdd = (kb: SubscriptionKnowledgeBaseRef) => {
    onChange([...selectedKnowledgeBases, kb])
  }

  const handleRemove = (index: number) => {
    const newKbs = [...selectedKnowledgeBases]
    newKbs.splice(index, 1)
    onChange(newKbs)
  }

  return (
    <div className="space-y-3">
      {/* Selected Knowledge Bases */}
      {selectedKnowledgeBases.length > 0 && (
        <div className="space-y-2">
          {selectedKnowledgeBases.map((kb, index) => (
            <div
              key={`${kb.name}:${kb.namespace}`}
              className={cn(
                'flex items-center justify-between p-2 rounded-lg',
                'bg-primary/5 border border-primary/10'
              )}
            >
              <div className="flex items-center gap-2 min-w-0">
                <Database className="h-4 w-4 text-primary flex-shrink-0" />
                <span className="text-sm font-medium truncate">{kb.name}</span>
                <span className="text-xs text-text-muted">({kb.namespace || 'default'})</span>
              </div>
              {!disabled && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 flex-shrink-0"
                  onClick={() => handleRemove(index)}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Add Button */}
      {!disabled && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full"
          onClick={() => setDialogOpen(true)}
        >
          <Plus className="h-4 w-4 mr-1.5" />
          {t('add_knowledge_base')}
        </Button>
      )}

      {/* Selector Dialog */}
      <KnowledgeBaseSelectorDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        selectedKnowledgeBases={selectedKnowledgeBases}
        onSelect={handleAdd}
      />
    </div>
  )
}
