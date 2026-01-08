// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useState, useMemo, useCallback } from 'react'
import { Check, Database, ArrowRight, Users, Table2 } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import Link from 'next/link'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { knowledgeBaseApi } from '@/apis/knowledge-base'
import { taskKnowledgeBaseApi } from '@/apis/task-knowledge-base'
import { tableApi, TableDocument } from '@/apis/table'
import type { KnowledgeBase } from '@/types/api'
import type { BoundKnowledgeBaseDetail } from '@/types/task-knowledge-base'
import type { ContextItem, KnowledgeBaseContext, TableContext } from '@/types/context'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { formatDocumentCount } from '@/lib/i18n-helpers'

interface ContextSelectorProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  selectedContexts: ContextItem[]
  onSelect: (context: ContextItem) => void
  onDeselect: (id: number | string) => void
  children: React.ReactNode
  /** Task ID for group chat mode - if provided, shows bound knowledge bases */
  taskId?: number
  /** Whether this is a group chat - if true, shows bound knowledge bases section */
  isGroupChat?: boolean
}

interface KnowledgeBaseItemProps {
  kb: KnowledgeBase
  isSelected: boolean
  onSelect: () => void
}

/**
 * Knowledge base item component for the selector list
 */
function KnowledgeBaseItem({ kb, isSelected, onSelect }: KnowledgeBaseItemProps) {
  const { t } = useTranslation('knowledge')
  const documentCount = kb.document_count || 0
  const documentText = formatDocumentCount(documentCount, t)

  return (
    <CommandItem
      key={kb.id}
      value={`${kb.name} ${kb.description || ''} ${kb.id}`}
      onSelect={onSelect}
      className={cn(
        'group cursor-pointer select-none',
        'px-3 py-2 text-sm text-text-primary',
        'rounded-md mx-1 my-[2px]',
        'data-[selected=true]:bg-primary/10 data-[selected=true]:text-primary',
        'aria-selected:bg-hover',
        '!flex !flex-row !items-start !justify-between !gap-2'
      )}
    >
      <div className="flex items-start gap-2 min-w-0 flex-1">
        <Database className="w-4 h-4 text-text-muted flex-shrink-0 mt-0.5" />
        <div className="flex flex-col min-w-0 flex-1">
          <span className="font-medium text-sm text-text-primary truncate" title={kb.name}>
            {kb.name}
          </span>
          {kb.description && (
            <span className="text-xs text-text-muted truncate" title={kb.description}>
              {kb.description}
            </span>
          )}
          <span className="text-xs text-text-muted mt-0.5">{documentText}</span>
        </div>
      </div>
      <Check
        className={cn(
          'h-3.5 w-3.5 shrink-0 mt-0.5',
          isSelected ? 'opacity-100 text-primary' : 'opacity-0'
        )}
      />
    </CommandItem>
  )
}

/**
 * Generic context selector component
 * Currently supports: knowledge_base, table
 * Future: person, bot, team
 *
 * For group chat mode (taskId + isGroupChat), shows bound knowledge bases
 * as a separate section that are selected by default.
 */
export default function ContextSelector({
  open,
  onOpenChange,
  selectedContexts,
  onSelect,
  onDeselect,
  children,
  taskId,
  isGroupChat,
}: ContextSelectorProps) {
  const { t } = useTranslation()
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([])
  const [boundKnowledgeBases, setBoundKnowledgeBases] = useState<BoundKnowledgeBaseDetail[]>([])
  const [tables, setTables] = useState<TableDocument[]>([])
  const [loading, setLoading] = useState(false)
  const [tableLoading, setTableLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tableError, setTableError] = useState<string | null>(null)
  const [searchValue, setSearchValue] = useState('')
  const [activeTab, setActiveTab] = useState('knowledge')

  const fetchKnowledgeBases = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await knowledgeBaseApi.list({ scope: 'all' })
      setKnowledgeBases(response.items)
    } catch (error) {
      console.error('Failed to fetch knowledge bases:', error)
      setError(t('knowledge:fetch_error'))
    } finally {
      setLoading(false)
    }
  }, [t])

  // Fetch bound knowledge bases for group chat
  const fetchBoundKnowledgeBases = useCallback(async () => {
    if (!taskId || !isGroupChat) {
      setBoundKnowledgeBases([])
      return
    }
    try {
      const response = await taskKnowledgeBaseApi.getBoundKnowledgeBases(taskId)
      setBoundKnowledgeBases(response.items)
    } catch (error) {
      console.error('Failed to fetch bound knowledge bases:', error)
      // Don't show error - just hide the section
      setBoundKnowledgeBases([])
    }
  }, [taskId, isGroupChat])

  // Fetch table documents
  const fetchTables = useCallback(async () => {
    setTableLoading(true)
    setTableError(null)
    try {
      const response = await tableApi.list()
      setTables(response.items)
    } catch (error) {
      console.error('Failed to fetch tables:', error)
      setTableError(t('knowledge:table.error.loadFailed'))
    } finally {
      setTableLoading(false)
    }
  }, [t])

  // Fetch knowledge bases on mount (not on every open) - like ModelSelector
  useEffect(() => {
    fetchKnowledgeBases()
  }, [fetchKnowledgeBases])

  // Fetch bound knowledge bases when taskId or isGroupChat changes
  useEffect(() => {
    fetchBoundKnowledgeBases()
  }, [fetchBoundKnowledgeBases])

  // Fetch tables on mount
  useEffect(() => {
    fetchTables()
  }, [fetchTables])

  // Sort knowledge bases by name and exclude bound ones from user list
  const sortedKnowledgeBases = useMemo(() => {
    const boundIds = new Set(boundKnowledgeBases.map(kb => kb.id))
    return [...knowledgeBases]
      .filter(kb => !boundIds.has(kb.id))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [knowledgeBases, boundKnowledgeBases])

  // Check if a context item is selected
  const isSelected = (id: number | string) => {
    return selectedContexts.some(ctx => ctx.id === id)
  }

  // Handle knowledge base selection
  // Handle knowledge base selection
  const handleSelect = (kb: KnowledgeBase) => {
    if (isSelected(kb.id)) {
      onDeselect(kb.id)
    } else {
      // Convert KnowledgeBase to KnowledgeBaseContext
      const context: KnowledgeBaseContext = {
        id: kb.id,
        name: kb.name,
        type: 'knowledge_base',
        description: kb.description ?? undefined,
        retriever_name: kb.retrieval_config?.retriever_name,
        retriever_namespace: kb.retrieval_config?.retriever_namespace,
        document_count: kb.document_count,
      }
      onSelect(context)
    }
  }

  // Handle bound knowledge base selection (from group chat)
  const handleSelectBound = (kb: BoundKnowledgeBaseDetail) => {
    if (isSelected(kb.id)) {
      onDeselect(kb.id)
    } else {
      const context: KnowledgeBaseContext = {
        id: kb.id,
        name: kb.name,
        type: 'knowledge_base',
        description: kb.description ?? undefined,
        document_count: kb.document_count,
      }
      onSelect(context)
    }
  }

  // Handle table selection (multi-select support like knowledge base)
  const handleTableSelect = (doc: TableDocument) => {
    // Check if table is already selected
    const tableContextId = `table-${doc.id}`
    if (isSelected(tableContextId)) {
      onDeselect(tableContextId)
    } else {
      // Create context and select
      const context: TableContext = {
        id: tableContextId,
        name: doc.name,
        type: 'table',
        document_id: doc.id,
        source_config: doc.source_config,
      }
      onSelect(context)
    }
  }

  // Reset search when popover closes
  useEffect(() => {
    if (!open) {
      setSearchValue('')
      setActiveTab('knowledge')
    }
  }, [open])

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        className={cn(
          'p-0 w-auto min-w-[320px] max-w-[400px] border border-border bg-base',
          'shadow-xl rounded-xl overflow-hidden',
          'max-h-[var(--radix-popover-content-available-height,400px)]',
          'flex flex-col'
        )}
        align="start"
        sideOffset={4}
        collisionPadding={8}
        avoidCollisions={true}
        sticky="partial"
      >
        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
          className="flex flex-col flex-1 min-h-0"
        >
          <TabsList className="w-full rounded-none border-b border-border bg-transparent h-9 p-0 flex-shrink-0">
            <TabsTrigger
              value="knowledge"
              className={cn(
                'flex-1 rounded-none border-b-2 border-transparent h-full text-sm font-medium',
                'data-[state=active]:border-primary data-[state=active]:text-primary',
                'data-[state=inactive]:text-text-muted hover:text-text-primary'
              )}
            >
              <Database className="w-3.5 h-3.5 mr-1.5" />
              {t('knowledge:title')}
            </TabsTrigger>
            <TabsTrigger
              value="table"
              className={cn(
                'flex-1 rounded-none border-b-2 border-transparent h-full text-sm font-medium',
                'data-[state=active]:border-blue-500 data-[state=active]:text-blue-600',
                'data-[state=inactive]:text-text-muted hover:text-text-primary'
              )}
            >
              <Table2 className="w-3.5 h-3.5 mr-1.5 data-[state=active]:text-blue-500" />
              {t('knowledge:table.title')}
            </TabsTrigger>
          </TabsList>

          {/* Knowledge Base Tab */}
          <TabsContent value="knowledge" className="flex-1 min-h-0 overflow-hidden m-0">
            <Command className="border-0 flex flex-col flex-1 min-h-0 overflow-hidden">
              <CommandInput
                placeholder={t('knowledge:search_placeholder')}
                value={searchValue}
                onValueChange={setSearchValue}
                className={cn(
                  'h-9 rounded-none border-b border-border flex-shrink-0',
                  'placeholder:text-text-muted text-sm'
                )}
              />
              <CommandList className="min-h-[36px] max-h-[300px] overflow-y-auto flex-1">
                {loading ? (
                  <div className="py-4 px-3 text-center text-sm text-text-muted">
                    {t('common:actions.loading')}
                  </div>
                ) : error ? (
                  <div className="py-4 px-3 text-center">
                    <p className="text-sm text-red-500 mb-2">{error}</p>
                    <button
                      onClick={fetchKnowledgeBases}
                      className="text-xs text-primary hover:underline"
                    >
                      {t('common:actions.retry')}
                    </button>
                  </div>
                ) : sortedKnowledgeBases.length === 0 && boundKnowledgeBases.length === 0 ? (
                  <div className="py-6 px-4 text-center">
                    <p className="text-sm text-text-muted mb-3">
                      {t('knowledge:no_knowledge_bases')}
                    </p>
                    <Link
                      href="/knowledge"
                      onClick={() => onOpenChange(false)}
                      className="inline-flex items-center gap-1.5 text-sm text-primary hover:text-primary/80 font-medium transition-colors"
                    >
                      {t('knowledge:go_to_create')}
                      <ArrowRight className="w-3.5 h-3.5" />
                    </Link>
                  </div>
                ) : (
                  <>
                    <CommandEmpty className="py-4 text-center text-sm text-text-muted">
                      {t('common:branches.no_match')}
                    </CommandEmpty>

                    {/* Group Chat Bound Knowledge Bases */}
                    {boundKnowledgeBases.length > 0 && (
                      <>
                        <CommandGroup
                          heading={
                            <div className="flex items-center gap-1.5 text-xs font-medium text-text-muted">
                              <Users className="w-3 h-3" />
                              {t('chat:groupChat.knowledge.groupKnowledgeBases')}
                            </div>
                          }
                        >
                          {boundKnowledgeBases.map(kb => {
                            const documentCount = kb.document_count || 0
                            const documentText = formatDocumentCount(documentCount, t)
                            const selected = isSelected(kb.id)

                            return (
                              <CommandItem
                                key={`bound-${kb.id}`}
                                value={`${kb.display_name} ${kb.description || ''} ${kb.id}`}
                                onSelect={() => handleSelectBound(kb)}
                                className={cn(
                                  'group cursor-pointer select-none',
                                  'px-3 py-2 text-sm text-text-primary',
                                  'rounded-md mx-1 my-[2px]',
                                  'data-[selected=true]:bg-primary/10 data-[selected=true]:text-primary',
                                  'aria-selected:bg-hover',
                                  '!flex !flex-row !items-start !justify-between !gap-2'
                                )}
                              >
                                <div className="flex items-start gap-2 min-w-0 flex-1">
                                  <Database className="w-4 h-4 text-primary flex-shrink-0 mt-0.5" />
                                  <div className="flex flex-col min-w-0 flex-1">
                                    <span
                                      className="font-medium text-sm text-text-primary truncate"
                                      title={kb.display_name}
                                    >
                                      {kb.display_name}
                                    </span>
                                    {kb.description && (
                                      <span
                                        className="text-xs text-text-muted truncate"
                                        title={kb.description}
                                      >
                                        {kb.description}
                                      </span>
                                    )}
                                    <span className="text-xs text-text-muted mt-0.5">
                                      {documentText}
                                    </span>
                                  </div>
                                </div>
                                <Check
                                  className={cn(
                                    'h-3.5 w-3.5 shrink-0 mt-0.5',
                                    selected ? 'opacity-100 text-primary' : 'opacity-0'
                                  )}
                                />
                              </CommandItem>
                            )
                          })}
                        </CommandGroup>
                        {sortedKnowledgeBases.length > 0 && <CommandSeparator />}
                      </>
                    )}

                    {/* User's Knowledge Bases */}
                    {sortedKnowledgeBases.length > 0 && (
                      <CommandGroup
                        heading={
                          boundKnowledgeBases.length > 0 ? (
                            <span className="text-xs font-medium text-text-muted">
                              {t('chat:groupChat.knowledge.otherKnowledgeBases')}
                            </span>
                          ) : undefined
                        }
                      >
                        {sortedKnowledgeBases.map(kb => (
                          <KnowledgeBaseItem
                            key={kb.id}
                            kb={kb}
                            isSelected={isSelected(kb.id)}
                            onSelect={() => handleSelect(kb)}
                          />
                        ))}
                      </CommandGroup>
                    )}
                  </>
                )}
              </CommandList>
            </Command>
          </TabsContent>

          {/* Table Tab */}
          <TabsContent value="table" className="flex-1 min-h-0 overflow-hidden m-0">
            <Command className="border-0 flex flex-col flex-1 min-h-0 overflow-hidden">
              <CommandInput
                placeholder={t('knowledge:search_placeholder')}
                value={searchValue}
                onValueChange={setSearchValue}
                className={cn(
                  'h-9 rounded-none border-b border-border flex-shrink-0',
                  'placeholder:text-text-muted text-sm'
                )}
              />
              <CommandList className="min-h-[36px] max-h-[300px] overflow-y-auto flex-1">
                {tableLoading ? (
                  <div className="py-4 px-3 text-center text-sm text-text-muted">
                    {t('common:actions.loading')}
                  </div>
                ) : tableError ? (
                  <div className="py-4 px-3 text-center">
                    <p className="text-sm text-red-500 mb-2">{tableError}</p>
                    <button onClick={fetchTables} className="text-xs text-primary hover:underline">
                      {t('common:actions.retry')}
                    </button>
                  </div>
                ) : tables.length === 0 ? (
                  <div className="py-6 px-4 text-center">
                    <p className="text-sm text-text-muted mb-2">{t('knowledge:table.empty')}</p>
                    <p className="text-xs text-text-muted">{t('knowledge:table.emptyHint')}</p>
                  </div>
                ) : (
                  <>
                    <CommandEmpty className="py-4 text-center text-sm text-text-muted">
                      {t('common:branches.no_match')}
                    </CommandEmpty>

                    <CommandGroup>
                      {tables.map(doc => {
                        const tableContextId = `table-${doc.id}`
                        const selected = isSelected(tableContextId)

                        return (
                          <CommandItem
                            key={`table-${doc.id}`}
                            value={`${doc.name} ${doc.id}`}
                            onSelect={() => handleTableSelect(doc)}
                            className={cn(
                              'group cursor-pointer select-none',
                              'px-3 py-2 text-sm text-text-primary',
                              'rounded-md mx-1 my-[2px]',
                              'data-[selected=true]:bg-blue-500/10 data-[selected=true]:text-blue-600',
                              'aria-selected:bg-hover',
                              '!flex !flex-row !items-start !justify-between !gap-2'
                            )}
                          >
                            <div className="flex items-start gap-2 min-w-0 flex-1">
                              <Table2 className="w-4 h-4 text-blue-500 flex-shrink-0 mt-0.5" />
                              <div className="flex flex-col min-w-0 flex-1">
                                <span
                                  className="font-medium text-sm text-text-primary truncate"
                                  title={doc.name}
                                >
                                  {doc.name}
                                </span>
                                {doc.source_config?.url && (
                                  <span
                                    className="text-xs text-text-muted truncate"
                                    title={doc.source_config.url}
                                  >
                                    {(() => {
                                      try {
                                        const url = new URL(doc.source_config.url)
                                        return url.hostname
                                      } catch {
                                        return doc.source_config.url
                                      }
                                    })()}
                                  </span>
                                )}
                              </div>
                            </div>
                            <Check
                              className={cn(
                                'h-3.5 w-3.5 shrink-0 mt-0.5',
                                selected ? 'opacity-100 text-blue-500' : 'opacity-0'
                              )}
                            />
                          </CommandItem>
                        )
                      })}
                    </CommandGroup>
                  </>
                )}
              </CommandList>
            </Command>
          </TabsContent>
        </Tabs>
      </PopoverContent>
    </Popover>
  )
}
