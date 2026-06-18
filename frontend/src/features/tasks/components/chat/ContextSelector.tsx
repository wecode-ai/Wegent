// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react'
import { Database, Table2, MessageSquareText } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { knowledgeBaseApi } from '@/apis/knowledge-base'
import { taskKnowledgeBaseApi } from '@/apis/task-knowledge-base'
import { tableApi, TableDocument } from '@/apis/table'
import type { KnowledgeBase } from '@/types/api'
import type { BoundKnowledgeBaseDetail } from '@/types/task-knowledge-base'
import type { ContextItem, ContextType, KnowledgeBaseContext, TableContext } from '@/types/context'
import { useTranslation } from '@/hooks/useTranslation'
import { useOrganizationNamespace } from '@/hooks/useOrganizationNamespace'
import { cn } from '@/lib/utils'
import { getKnowledgeBaseGroup } from '@/utils/knowledge-base-grouping'
import { getRuntimeConfigSync } from '@/lib/runtime-config'
import { getDingTalkSelectedIds, DingTalkDocContextSelector } from './DingTalkDocContextSelector'
import { KnowledgeBaseContextTab } from './KnowledgeBaseContextTab'
import type { GroupedKnowledgeBases } from './KnowledgeBaseContextTab'
import { TableContextTab } from './TableContextTab'

function getDefaultAllowedContextTypes(): ContextType[] {
  return getRuntimeConfigSync().enableDingTalkContext
    ? ['knowledge_base', 'table', 'external_document']
    : ['knowledge_base', 'table']
}
type KnowledgeBaseContextSource = 'personal' | 'group' | 'organization'

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
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([])
  const [boundKnowledgeBases, setBoundKnowledgeBases] = useState<BoundKnowledgeBaseDetail[]>([])
  const [tables, setTables] = useState<TableDocument[]>([])
  const [loading, setLoading] = useState(false)
  const [tableLoading, setTableLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tableError, setTableError] = useState<string | null>(null)
  const [searchValue, setSearchValue] = useState('')
  const [activeTab, setActiveTab] = useState(firstAllowedTab)
  const {
    organizationNamespace,
    loading: organizationNamespaceLoading,
    error: organizationNamespaceError,
    reload: reloadOrganizationNamespace,
  } = useOrganizationNamespace()
  const knowledgeBaseError =
    error || (organizationNamespaceError ? t('knowledge:fetch_error') : null)

  const fetchKnowledgeBases = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await knowledgeBaseApi.list({ scope: 'all' })
      setKnowledgeBases(response.items)
    } catch (error) {
      console.error('Failed to fetch knowledge bases:', error)
      setError(tRef.current('knowledge:fetch_error'))
    } finally {
      setLoading(false)
    }
  }, [])

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
      setTableError(tRef.current('knowledge:table.error.loadFailed'))
    } finally {
      setTableLoading(false)
    }
  }, [])

  // Fetch knowledge bases on mount (not on every open) - like ModelSelector
  useEffect(() => {
    if (!canSelectKnowledgeBase) {
      setKnowledgeBases([])
      return
    }
    fetchKnowledgeBases()
  }, [canSelectKnowledgeBase, fetchKnowledgeBases])

  // Fetch bound knowledge bases when taskId or isGroupChat changes
  useEffect(() => {
    if (!canSelectKnowledgeBase) {
      setBoundKnowledgeBases([])
      return
    }
    fetchBoundKnowledgeBases()
  }, [canSelectKnowledgeBase, fetchBoundKnowledgeBases])

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

  // Group knowledge bases by category (personal, group, organization)
  // and exclude bound ones and current notebook KB from user list
  const groupedKnowledgeBases = useMemo((): GroupedKnowledgeBases => {
    const boundIds = new Set(boundKnowledgeBases.map(kb => kb.id))
    const filtered = knowledgeBases
      .filter(kb => !boundIds.has(kb.id))
      .filter(kb => excludeKnowledgeBaseId === undefined || kb.id !== excludeKnowledgeBaseId)
      .filter(kb => {
        const source = getKnowledgeBaseGroup(kb.namespace, organizationNamespace)
        if (
          allowedKnowledgeBaseSources &&
          allowedKnowledgeBaseSources.length > 0 &&
          !allowedKnowledgeBaseSources.includes(source)
        ) {
          return false
        }
        if (
          source === 'group' &&
          allowedGroupNamespaces &&
          allowedGroupNamespaces.length > 0 &&
          !allowedGroupNamespaces.includes(kb.namespace)
        ) {
          return false
        }
        return true
      })

    const groups: GroupedKnowledgeBases = {
      personal: [],
      group: new Map(),
      organization: [],
    }

    for (const kb of filtered) {
      const category = getKnowledgeBaseGroup(kb.namespace, organizationNamespace)
      if (category === 'group') {
        // Group by namespace (group name)
        const existing = groups.group.get(kb.namespace) || []
        existing.push(kb)
        groups.group.set(kb.namespace, existing)
      } else {
        groups[category].push(kb)
      }
    }

    // Sort personal and organization by name
    groups.personal.sort((a, b) => a.name.localeCompare(b.name))
    groups.organization.sort((a, b) => a.name.localeCompare(b.name))

    // Sort each group's knowledge bases by name
    for (const kbs of groups.group.values()) {
      kbs.sort((a, b) => a.name.localeCompare(b.name))
    }

    // Sort group namespaces
    const sortedGroupEntries = Array.from(groups.group.entries()).sort((a, b) =>
      a[0].localeCompare(b[0])
    )
    groups.group = new Map(sortedGroupEntries)

    return groups
  }, [
    allowedGroupNamespaces,
    allowedKnowledgeBaseSources,
    knowledgeBases,
    boundKnowledgeBases,
    excludeKnowledgeBaseId,
    organizationNamespace,
  ])

  // Check if there are any knowledge bases to show
  const hasKnowledgeBases =
    groupedKnowledgeBases.personal.length > 0 ||
    groupedKnowledgeBases.group.size > 0 ||
    groupedKnowledgeBases.organization.length > 0

  // Check if a context item is selected
  const isSelected = (id: number | string) => {
    return selectedContexts.some(ctx => ctx.id === id)
  }

  // Check if all knowledge bases in a group are selected
  const isGroupFullySelected = (kbs: KnowledgeBase[]) => {
    return kbs.every(kb => isSelected(kb.id))
  }

  // Check if some (but not all) knowledge bases in a group are selected
  const isGroupPartiallySelected = (kbs: KnowledgeBase[]) => {
    const selectedCount = kbs.filter(kb => isSelected(kb.id)).length
    return selectedCount > 0 && selectedCount < kbs.length
  }

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

  // Handle group selection - select/deselect all knowledge bases in the group
  const handleGroupSelect = (_namespace: string, kbs: KnowledgeBase[]) => {
    const isFullySelected = isGroupFullySelected(kbs)

    if (isFullySelected) {
      // Deselect all knowledge bases in the group
      // Use batch deselect if available to avoid closure issues
      const idsToDeselect = kbs.filter(kb => isSelected(kb.id)).map(kb => kb.id)
      if (onDeselectMultiple && idsToDeselect.length > 0) {
        onDeselectMultiple(idsToDeselect)
      } else {
        // Fallback to individual deselect
        kbs.forEach(kb => {
          if (isSelected(kb.id)) {
            onDeselect(kb.id)
          }
        })
      }
    } else {
      // Select all unselected knowledge bases in the group
      // Use batch select if available to avoid closure issues
      const contextsToAdd: KnowledgeBaseContext[] = kbs
        .filter(kb => !isSelected(kb.id))
        .map(kb => ({
          id: kb.id,
          name: kb.name,
          type: 'knowledge_base' as const,
          description: kb.description ?? undefined,
          retriever_name: kb.retrieval_config?.retriever_name,
          retriever_namespace: kb.retrieval_config?.retriever_namespace,
          document_count: kb.document_count,
        }))

      if (onSelectMultiple && contextsToAdd.length > 0) {
        onSelectMultiple(contextsToAdd)
      } else {
        // Fallback to individual select
        contextsToAdd.forEach(context => {
          onSelect(context)
        })
      }
    }
  }

  const handleKnowledgeBaseRetry = () => {
    reloadOrganizationNamespace()
    fetchKnowledgeBases()
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
                groupedKnowledgeBases={groupedKnowledgeBases}
                boundKnowledgeBases={boundKnowledgeBases}
                hasKnowledgeBases={hasKnowledgeBases}
                loading={loading}
                error={knowledgeBaseError}
                searchValue={searchValue}
                organizationNamespaceLoading={organizationNamespaceLoading}
                onSearchValueChange={setSearchValue}
                onRetry={handleKnowledgeBaseRetry}
                onOpenChange={onOpenChange}
                onSelectKnowledgeBase={handleSelect}
                onSelectBoundKnowledgeBase={handleSelectBound}
                onSelectGroup={handleGroupSelect}
                isSelected={isSelected}
                isGroupFullySelected={isGroupFullySelected}
                isGroupPartiallySelected={isGroupPartiallySelected}
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
                isSelected={isSelected}
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
