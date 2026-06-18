// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react'
import { Database, Table2, MessageSquareText } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { tableApi, TableDocument } from '@/apis/table'
import type { ContextItem, ContextType, TableContext } from '@/types/context'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { getRuntimeConfigSync } from '@/lib/runtime-config'
import { getDingTalkSelectedIds, DingTalkDocContextSelector } from './DingTalkDocContextSelector'
import { KnowledgeBaseContextTab } from './KnowledgeBaseContextTab'
import { TableContextTab } from './TableContextTab'
import {
  useKnowledgeBaseContextSelector,
  type KnowledgeBaseContextSource,
} from './useKnowledgeBaseContextSelector'

function getDefaultAllowedContextTypes(): ContextType[] {
  return getRuntimeConfigSync().enableDingTalkContext
    ? ['knowledge_base', 'table', 'external_document']
    : ['knowledge_base', 'table']
}
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
  children: React.ReactNode
  /** Task ID for group chat mode - if provided, shows bound knowledge bases */
  taskId?: number
  /** Whether this is a group chat - if true, shows bound knowledge bases section */
  isGroupChat?: boolean
  /** Knowledge base ID to exclude from the list (used in notebook mode to hide current KB) */
  excludeKnowledgeBaseId?: number
  /** Restrict selectable context types. Defaults to all chat context types. */
  allowedContextTypes?: ContextType[]
  /** Restrict selectable knowledge base sources. Defaults to all sources. */
  allowedKnowledgeBaseSources?: KnowledgeBaseContextSource[]
  /** Restrict selectable group knowledge bases to these namespaces. */
  allowedGroupNamespaces?: string[]
}

/**
 * Generic context selector component
 * Currently supports: knowledge_base, table, external_document
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
  children,
  taskId,
  isGroupChat,
  excludeKnowledgeBaseId,
  allowedContextTypes,
  allowedKnowledgeBaseSources,
  allowedGroupNamespaces,
}: ContextSelectorProps) {
  const { t } = useTranslation()
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [t])
  const allowedTypes = useMemo(
    () =>
      new Set<ContextType>(
        allowedContextTypes && allowedContextTypes.length > 0
          ? allowedContextTypes
          : getDefaultAllowedContextTypes()
      ),
    [allowedContextTypes]
  )
  const canSelectKnowledgeBase = allowedTypes.has('knowledge_base')
  const canSelectTable = allowedTypes.has('table')
  const canSelectDingTalk = allowedTypes.has('external_document')
  const firstAllowedTab = canSelectKnowledgeBase
    ? 'knowledge'
    : canSelectTable
      ? 'table'
      : 'dingtalk'
  const [tables, setTables] = useState<TableDocument[]>([])
  const [tableLoading, setTableLoading] = useState(false)
  const [tableError, setTableError] = useState<string | null>(null)
  const [searchValue, setSearchValue] = useState('')
  const [activeTab, setActiveTab] = useState(firstAllowedTab)
  const knowledgeBaseSelector = useKnowledgeBaseContextSelector({
    enabled: canSelectKnowledgeBase,
    selectedContexts,
    onSelect,
    onDeselect,
    onSelectMultiple,
    onDeselectMultiple,
    taskId,
    isGroupChat,
    excludeKnowledgeBaseId,
    allowedKnowledgeBaseSources,
    allowedGroupNamespaces,
  })

  // Fetch table documents
  const fetchTables = useCallback(async () => {
    setTableLoading(true)
    setTableError(null)
    try {
      const response = await tableApi.list()
      setTables(response.items)
    } catch (error) {
      console.error('Failed to fetch tables:', error)
      setTableError(tRef.current('knowledge:table.error.loadFailed'))
    } finally {
      setTableLoading(false)
    }
  }, [])

  // Fetch tables on mount
  useEffect(() => {
    if (!canSelectTable) {
      setTables([])
      return
    }
    fetchTables()
  }, [canSelectTable, fetchTables])

  const handleTabChange = useCallback((value: string) => {
    setActiveTab(value)
  }, [])

  useEffect(() => {
    const activeType =
      activeTab === 'knowledge'
        ? 'knowledge_base'
        : activeTab === 'table'
          ? 'table'
          : 'external_document'
    if (!allowedTypes.has(activeType)) {
      setActiveTab(firstAllowedTab)
    }
  }, [activeTab, allowedTypes, firstAllowedTab])

  // Handle table selection (multi-select support like knowledge base)
  const handleTableSelect = (doc: TableDocument) => {
    // Check if table is already selected
    const tableContextId = `table-${doc.id}`
    if (knowledgeBaseSelector.isSelected(tableContextId)) {
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

  const handleScrollableWheel = useCallback((event: React.WheelEvent<HTMLElement>) => {
    const list = event.currentTarget
    const isScrollingUp = event.deltaY < 0
    const isScrollingDown = event.deltaY > 0
    const isAtTop = list.scrollTop <= 0
    const isAtBottom = list.scrollTop + list.clientHeight >= list.scrollHeight

    if ((isScrollingUp && isAtTop) || (isScrollingDown && isAtBottom)) {
      return
    }

    event.stopPropagation()
  }, [])

  // Compute the set of selected DingTalk node IDs, bridging ContextItem[] to Set<string>
  // for the DingTalkDocContextSelector component.
  const selectedDingTalkIds = useMemo(
    () => getDingTalkSelectedIds(selectedContexts),
    [selectedContexts]
  )

  // Reset search when popover closes
  useEffect(() => {
    if (!open) {
      setSearchValue('')
      setActiveTab(firstAllowedTab)
    }
  }, [firstAllowedTab, open])

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        className={cn(
          'p-0 w-[340px] border border-border bg-base',
          'shadow-xl rounded-xl overflow-hidden',
          'flex flex-col'
        )}
        align="start"
        side="top"
        sideOffset={4}
        collisionPadding={8}
        avoidCollisions={true}
        sticky="partial"
      >
        <Tabs
          value={activeTab}
          onValueChange={handleTabChange}
          className="flex flex-col flex-1 min-h-0"
        >
          <TabsList className="w-full rounded-none border-b border-border bg-transparent h-9 p-0 flex-shrink-0">
            {canSelectKnowledgeBase && (
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
            )}
            {canSelectTable && (
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
            )}
            {canSelectDingTalk && (
              <TabsTrigger
                value="dingtalk"
                className={cn(
                  'flex-1 rounded-none border-b-2 border-transparent h-full text-sm font-medium',
                  'data-[state=active]:border-orange-500 data-[state=active]:text-orange-600',
                  'data-[state=inactive]:text-text-muted hover:text-text-primary'
                )}
                data-testid="context-selector-dingtalk-tab"
              >
                <MessageSquareText className="w-3.5 h-3.5 mr-1.5" />
                {t('chat:dingtalkDocs.tabTitle')}
              </TabsTrigger>
            )}
          </TabsList>

          {/* Knowledge Base Tab */}
          {canSelectKnowledgeBase && (
            <TabsContent value="knowledge" className="m-0">
              <KnowledgeBaseContextTab
                groupedKnowledgeBases={knowledgeBaseSelector.groupedKnowledgeBases}
                boundKnowledgeBases={knowledgeBaseSelector.boundKnowledgeBases}
                hasKnowledgeBases={knowledgeBaseSelector.hasKnowledgeBases}
                loading={knowledgeBaseSelector.loading}
                error={knowledgeBaseSelector.error}
                searchValue={searchValue}
                organizationNamespaceLoading={knowledgeBaseSelector.organizationNamespaceLoading}
                onSearchValueChange={setSearchValue}
                onRetry={knowledgeBaseSelector.onRetry}
                onOpenChange={onOpenChange}
                onSelectKnowledgeBase={knowledgeBaseSelector.onSelectKnowledgeBase}
                onSelectBoundKnowledgeBase={knowledgeBaseSelector.onSelectBoundKnowledgeBase}
                onSelectGroup={knowledgeBaseSelector.onSelectGroup}
                isSelected={knowledgeBaseSelector.isSelected}
                isGroupFullySelected={knowledgeBaseSelector.isGroupFullySelected}
                isGroupPartiallySelected={knowledgeBaseSelector.isGroupPartiallySelected}
                onWheel={handleScrollableWheel}
              />
            </TabsContent>
          )}

          {/* Table Tab */}
          {canSelectTable && (
            <TabsContent value="table" className="m-0">
              <TableContextTab
                tables={tables}
                loading={tableLoading}
                error={tableError}
                searchValue={searchValue}
                onSearchValueChange={setSearchValue}
                onRetry={fetchTables}
                onSelectTable={handleTableSelect}
                isSelected={knowledgeBaseSelector.isSelected}
                onWheel={handleScrollableWheel}
              />
            </TabsContent>
          )}

          {/* DingTalk Docs Tab — delegates rendering to the shared DingTalkDocContextSelector */}
          {canSelectDingTalk && (
            <TabsContent value="dingtalk" className="m-0 flex flex-col">
              {activeTab === 'dingtalk' && (
                <DingTalkDocContextSelector
                  selectedContexts={selectedDingTalkIds}
                  onSelect={ctx => onSelect(ctx)}
                  onDeselect={id => onDeselect(id)}
                  onSelectMultiple={ctxs => {
                    if (onSelectMultiple) onSelectMultiple(ctxs)
                  }}
                  onDeselectMultiple={ids => {
                    if (onDeselectMultiple) onDeselectMultiple(ids)
                  }}
                  onScrollableWheel={handleScrollableWheel}
                />
              )}
            </TabsContent>
          )}
        </Tabs>
      </PopoverContent>
    </Popover>
  )
}
