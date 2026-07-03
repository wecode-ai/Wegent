// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useState, useMemo, useCallback } from 'react'
import { Check, Database, Table2 } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { knowledgeBaseApi } from '@/apis/knowledge-base'
import { taskKnowledgeBaseApi } from '@/apis/task-knowledge-base'
import { tableApi, TableDocument } from '@/apis/table'
import type { KnowledgeBase } from '@/types/api'
import type { AllGroupedKnowledgeResponse, KnowledgeBaseWithGroupInfo } from '@/types/knowledge'
import type { BoundKnowledgeBaseDetail } from '@/types/task-knowledge-base'
import type { ContextItem, TableContext } from '@/types/context'
import { useExternalKnowledgeSources } from '@/features/knowledge/externalKnowledgeSourceRegistry'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { KnowledgeSourcePicker, type GroupedKnowledgeBases } from './KnowledgeSourcePicker'

interface ContextSelectorProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  selectedContexts: ContextItem[]
  onSelect: (context: ContextItem) => void
  onDeselect: (id: number | string) => void
  /** Batch selection callback for selecting multiple contexts at once (e.g., group selection) */
  onSelectMultiple?: (contexts: ContextItem[]) => void
  /** Batch deselection callback for deselecting multiple contexts at once */
  onDeselectMultiple?: (ids: (number | string)[]) => void
  /** Atomic replacement callback for updating scoped knowledge selections. */
  onReplaceContexts?: (idsToRemove: (number | string)[], contextsToAdd: ContextItem[]) => void
  children: React.ReactNode
  /** Task ID for group chat mode - if provided, shows bound knowledge bases */
  taskId?: number
  /** Whether this is a group chat - if true, shows bound knowledge bases section */
  isGroupChat?: boolean
  /** Knowledge base ID to exclude from the list (used in notebook mode to hide current KB) */
  excludeKnowledgeBaseId?: number
}

function toKnowledgeBase(kb: KnowledgeBaseWithGroupInfo): KnowledgeBase {
  return {
    id: kb.id,
    name: kb.name,
    description: kb.description,
    user_id: kb.user_id,
    namespace: kb.namespace,
    document_count: kb.document_count,
    is_active: true,
    summary_enabled: false,
    kb_type: kb.kb_type || 'notebook',
    max_calls_per_conversation: 10,
    exempt_calls_before_check: 5,
    created_at: kb.created_at,
    updated_at: kb.updated_at,
  }
}

function filterKnowledgeBases(
  items: KnowledgeBaseWithGroupInfo[],
  boundIds: Set<number>,
  excludeKnowledgeBaseId?: number
): KnowledgeBase[] {
  return items
    .filter(kb => !boundIds.has(kb.id))
    .filter(kb => excludeKnowledgeBaseId === undefined || kb.id !== excludeKnowledgeBaseId)
    .map(toKnowledgeBase)
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
  onSelectMultiple,
  onDeselectMultiple,
  onReplaceContexts,
  children,
  taskId,
  isGroupChat,
  excludeKnowledgeBaseId,
}: ContextSelectorProps) {
  const { t } = useTranslation()
  const [allGroupedKnowledge, setAllGroupedKnowledge] =
    useState<AllGroupedKnowledgeResponse | null>(null)
  const [boundKnowledgeBases, setBoundKnowledgeBases] = useState<BoundKnowledgeBaseDetail[]>([])
  const [tables, setTables] = useState<TableDocument[]>([])
  const [loading, setLoading] = useState(false)
  const [tableLoading, setTableLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tableError, setTableError] = useState<string | null>(null)
  const [searchValue, setSearchValue] = useState('')
  const [activeTab, setActiveTab] = useState('knowledge')
  const knowledgeBaseError = error

  const fetchKnowledgeBases = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await knowledgeBaseApi.getAllGrouped()
      setAllGroupedKnowledge(response)
    } catch (error) {
      console.error('Failed to fetch knowledge bases:', error)
      setError(t('knowledge:fetch_error'))
      setAllGroupedKnowledge(null)
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

  const handleTabChange = useCallback((value: string) => {
    setActiveTab(value)
  }, [])

  // Group knowledge bases by category (personal, group, organization)
  // and exclude bound ones and current notebook KB from user list
  const groupedKnowledgeBases = useMemo((): GroupedKnowledgeBases => {
    const boundIds = new Set(boundKnowledgeBases.map(kb => kb.id))
    const groups: GroupedKnowledgeBases = {
      personal: [],
      group: new Map(),
      organization: [],
    }

    if (!allGroupedKnowledge) {
      return groups
    }

    groups.personal = filterKnowledgeBases(
      [
        ...allGroupedKnowledge.personal.created_by_me,
        ...allGroupedKnowledge.personal.shared_with_me,
      ],
      boundIds,
      excludeKnowledgeBaseId
    )

    groups.organization = filterKnowledgeBases(
      allGroupedKnowledge.organization.knowledge_bases,
      boundIds,
      excludeKnowledgeBaseId
    )

    for (const group of allGroupedKnowledge.groups) {
      const items = filterKnowledgeBases(group.knowledge_bases, boundIds, excludeKnowledgeBaseId)
      groups.group.set(group.group_name, {
        name: group.group_name,
        displayName: group.group_display_name || group.group_name,
        items,
      })
    }

    // Sort personal and organization by name
    groups.personal.sort((a, b) => a.name.localeCompare(b.name))
    groups.organization.sort((a, b) => a.name.localeCompare(b.name))

    // Sort each group's knowledge bases by name
    for (const group of groups.group.values()) {
      group.items.sort((a, b) => a.name.localeCompare(b.name))
    }

    // Sort group display names while keeping namespace as the stable key.
    const sortedGroupEntries = Array.from(groups.group.entries()).sort(
      (a, b) => a[1].displayName.localeCompare(b[1].displayName) || a[0].localeCompare(b[0])
    )
    groups.group = new Map(sortedGroupEntries)

    return groups
  }, [allGroupedKnowledge, boundKnowledgeBases, excludeKnowledgeBaseId])

  // Check if a context item is selected
  const isSelected = (id: number | string) => {
    return selectedContexts.some(ctx => ctx.id === id)
  }

  const handleKnowledgeBaseRetry = () => {
    fetchKnowledgeBases()
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

  const externalSources = useExternalKnowledgeSources()

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
          'p-0 w-[760px] max-w-[calc(100vw-24px)] border border-border bg-base',
          'max-h-[var(--radix-popover-content-available-height)] shadow-xl rounded-xl overflow-hidden',
          'flex flex-col'
        )}
        align="start"
        side="top"
        sideOffset={4}
        collisionPadding={8}
        avoidCollisions={true}
        sticky="partial"
        data-testid="context-selector-popover"
      >
        <Tabs
          value={activeTab}
          onValueChange={handleTabChange}
          className="flex flex-col flex-1 min-h-0"
        >
          {/* Tab list: Knowledge | Table — fixed height, no flex tricks needed */}
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
              <Table2 className="w-3.5 h-3.5 mr-1.5" />
              {t('knowledge:table.title')}
            </TabsTrigger>
          </TabsList>

          {/* Knowledge Base Tab */}
          <TabsContent value="knowledge" className="m-0 min-h-0 flex-1 overflow-hidden">
            <div className="flex min-h-0 flex-1 flex-col">
              <Input
                placeholder={t('knowledge:search_placeholder')}
                value={searchValue}
                onChange={event => setSearchValue(event.target.value)}
                className={cn(
                  'h-9 rounded-none border-b border-border flex-shrink-0',
                  'placeholder:text-text-muted text-sm'
                )}
                data-testid="context-selector-knowledge-search-input"
              />
              <KnowledgeSourcePicker
                groupedKnowledgeBases={groupedKnowledgeBases}
                boundKnowledgeBases={boundKnowledgeBases}
                externalSources={externalSources}
                selectedContexts={selectedContexts}
                searchValue={searchValue}
                loading={loading}
                error={knowledgeBaseError}
                onRetry={handleKnowledgeBaseRetry}
                onSelect={onSelect}
                onDeselect={onDeselect}
                onSelectMultiple={onSelectMultiple}
                onDeselectMultiple={onDeselectMultiple}
                onReplaceContexts={onReplaceContexts}
              />
            </div>
          </TabsContent>

          {/* Table Tab */}
          <TabsContent value="table" className="m-0 min-h-0 flex-1 overflow-hidden">
            <Command className="border-0 flex min-h-0 flex-1 flex-col">
              <CommandInput
                placeholder={t('knowledge:search_placeholder')}
                value={searchValue}
                onValueChange={setSearchValue}
                className={cn(
                  'h-9 rounded-none border-b border-border flex-shrink-0',
                  'placeholder:text-text-muted text-sm'
                )}
              />
              <CommandList className="min-h-0 max-h-[calc(var(--radix-popover-content-available-height)-72px)] flex-1 overflow-y-auto">
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
