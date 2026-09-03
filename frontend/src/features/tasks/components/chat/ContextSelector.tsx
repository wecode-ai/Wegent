// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useState, useMemo, useCallback } from 'react'
import { BookOpen, Check, Table2, X } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Drawer, DrawerContent, DrawerTitle, DrawerTrigger } from '@/components/ui/drawer'
import { Button } from '@/components/ui/button'
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
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
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
  onReplaceContexts: (idsToRemove: (number | string)[], contextsToAdd: ContextItem[]) => void
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
  const isMobile = useIsMobile()

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

  const selectedContextCount = selectedContexts.filter(context =>
    ['knowledge_base', 'table', 'dingtalk_doc', 'external_knowledge'].includes(context.type)
  ).length

  const selectorContent = (
    <Tabs
      value={activeTab}
      onValueChange={handleTabChange}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex min-h-11 shrink-0 items-center justify-between border-b border-border px-4 lg:hidden">
        <h2 className="text-base font-semibold text-text-primary">
          {t('knowledge:picker.selectContent')}
        </h2>
        <button
          type="button"
          aria-label={t('common:actions.close')}
          className="flex h-11 w-11 items-center justify-center rounded-md text-text-muted hover:bg-surface hover:text-text-primary"
          onClick={() => onOpenChange(false)}
          data-testid="context-selector-close-button"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <TabsList className="h-11 w-full shrink-0 rounded-none border-b border-border bg-transparent p-0 lg:h-9">
        <TabsTrigger
          value="knowledge"
          className={cn(
            'h-full flex-1 rounded-none border-b-2 border-transparent text-sm font-medium',
            'data-[state=active]:border-primary data-[state=active]:text-primary',
            'data-[state=inactive]:text-text-muted hover:text-text-primary'
          )}
          data-testid="context-selector-knowledge-tab"
        >
          <BookOpen className="mr-1.5 h-3.5 w-3.5" />
          {t('knowledge:title')}
        </TabsTrigger>
        <TabsTrigger
          value="table"
          className={cn(
            'h-full flex-1 rounded-none border-b-2 border-transparent text-sm font-medium',
            'data-[state=active]:border-blue-500 data-[state=active]:text-blue-600',
            'data-[state=inactive]:text-text-muted hover:text-text-primary'
          )}
          data-testid="context-selector-table-tab"
        >
          <Table2 className="mr-1.5 h-3.5 w-3.5" />
          {t('knowledge:table.title')}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="knowledge" className="m-0 min-h-0 flex-1 overflow-hidden">
        <div className="flex h-full min-h-0 flex-1 flex-col">
          <Input
            placeholder={t('knowledge:search_placeholder')}
            value={searchValue}
            onChange={event => setSearchValue(event.target.value)}
            className={cn(
              'h-11 shrink-0 rounded-none border-b border-border text-sm lg:h-9',
              'placeholder:text-text-muted'
            )}
            data-testid="context-selector-knowledge-search-input"
          />
          <KnowledgeSourcePicker
            groupedKnowledgeBases={groupedKnowledgeBases}
            boundKnowledgeBases={boundKnowledgeBases}
            externalSources={externalSources}
            selectedContexts={selectedContexts}
            searchValue={searchValue}
            onSearchValueChange={setSearchValue}
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

      <TabsContent value="table" className="m-0 min-h-0 flex-1 overflow-hidden">
        <Command className="flex min-h-0 flex-1 flex-col border-0">
          <CommandInput
            placeholder={t('knowledge:search_placeholder')}
            value={searchValue}
            onValueChange={setSearchValue}
            className={cn(
              'h-11 shrink-0 rounded-none border-b border-border text-sm lg:h-9',
              'placeholder:text-text-muted'
            )}
          />
          <CommandList className="min-h-0 max-h-none flex-1 overflow-y-auto lg:max-h-[calc(var(--radix-popover-content-available-height)-72px)]">
            {tableLoading ? (
              <div className="px-3 py-4 text-center text-sm text-text-muted">
                {t('common:actions.loading')}
              </div>
            ) : tableError ? (
              <div className="px-3 py-4 text-center">
                <p className="mb-2 text-sm text-red-500">{tableError}</p>
                <button onClick={fetchTables} className="text-xs text-primary hover:underline">
                  {t('common:actions.retry')}
                </button>
              </div>
            ) : tables.length === 0 ? (
              <div className="px-4 py-6 text-center">
                <p className="mb-2 text-sm text-text-muted">{t('knowledge:table.empty')}</p>
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
                          'group mx-1 my-[2px] cursor-pointer select-none rounded-md',
                          'max-lg:min-h-11 px-3 py-2 text-sm text-text-primary',
                          'data-[selected=true]:bg-blue-500/10 data-[selected=true]:text-blue-600',
                          'aria-selected:bg-hover',
                          '!flex !flex-row !items-start !justify-between !gap-2'
                        )}
                      >
                        <div className="flex min-w-0 flex-1 items-start gap-2">
                          <Table2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-blue-500" />
                          <div className="flex min-w-0 flex-1 flex-col">
                            <span
                              className="truncate text-sm font-medium text-text-primary"
                              title={doc.name}
                            >
                              {doc.name}
                            </span>
                            {doc.source_config?.url && (
                              <span
                                className="truncate text-xs text-text-muted"
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
                            'mt-0.5 h-3.5 w-3.5 shrink-0',
                            selected ? 'text-blue-500 opacity-100' : 'opacity-0'
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

      <div className="flex min-h-16 shrink-0 items-center justify-between border-t border-border px-4 lg:hidden">
        <span className="text-sm text-text-primary" data-testid="context-selector-selected-count">
          {t('knowledge:picker.selectedCount', { count: selectedContextCount })}
        </span>
        <Button
          type="button"
          variant="primary"
          className="min-h-11 min-w-24"
          onClick={() => onOpenChange(false)}
          data-testid="context-selector-done-button"
        >
          {t('common:actions.done')}
        </Button>
      </div>
    </Tabs>
  )

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange} shouldScaleBackground={false}>
        <DrawerTrigger asChild>{children}</DrawerTrigger>
        <DrawerContent
          className="h-[82dvh] max-h-[680px] overflow-hidden rounded-t-2xl border-border bg-base p-0"
          handleClassName="mt-2 h-1 w-9 bg-text-muted/30"
          overlayClassName="bg-black/45"
          data-testid="context-selector-drawer"
        >
          <DrawerTitle className="sr-only">{t('knowledge:picker.selectContent')}</DrawerTitle>
          {selectorContent}
        </DrawerContent>
      </Drawer>
    )
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        className={cn(
          'flex w-[760px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-xl border border-border bg-base p-0 shadow-xl',
          'max-h-[var(--radix-popover-content-available-height)]',
          'md:h-[min(680px,var(--radix-popover-content-available-height))] lg:h-auto'
        )}
        align="start"
        side="top"
        sideOffset={4}
        collisionPadding={8}
        avoidCollisions={true}
        sticky="partial"
        data-testid="context-selector-popover"
      >
        {selectorContent}
      </PopoverContent>
    </Popover>
  )
}
