// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useState, useMemo, useCallback } from 'react'
import {
  Check,
  Database,
  ArrowRight,
  Users,
  Table2,
  User,
  Building2,
  MessageSquareText,
  RefreshCw,
  Search,
} from 'lucide-react'
import { dingtalkDocApi } from '@/apis/dingtalk-doc'
import type { DingtalkDocNode } from '@/types/dingtalk-doc'
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
import type {
  ContextItem,
  KnowledgeBaseContext,
  TableContext,
  DingTalkDocContext,
} from '@/types/context'
import { useTranslation } from '@/hooks/useTranslation'
import { useOrganizationNamespace } from '@/hooks/useOrganizationNamespace'
import { cn } from '@/lib/utils'
import { formatDocumentCount } from '@/lib/i18n-helpers'
import { getKnowledgeBaseGroup } from '@/utils/knowledge-base-grouping'
import {
  getDingTalkSelectedIds,
  DingtalkContextTreeNode,
  collectDescendants,
  isNodeFullySelected,
} from './DingTalkDocContextSelector'

interface GroupedKnowledgeBases {
  personal: KnowledgeBase[]
  group: Map<string, KnowledgeBase[]> // namespace -> knowledge bases
  organization: KnowledgeBase[]
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
  onSelectMultiple,
  onDeselectMultiple,
  children,
  taskId,
  isGroupChat,
  excludeKnowledgeBaseId,
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
  const [dingtalkNodes, setDingtalkNodes] = useState<DingtalkDocNode[]>([])
  const [hasFetchedDingtalk, setHasFetchedDingtalk] = useState(false)
  const [dingtalkLoading, setDingtalkLoading] = useState(false)
  const [dingtalkSyncing, setDingtalkSyncing] = useState(false)
  const [dingtalkError, setDingtalkError] = useState<string | null>(null)
  const [dingtalkConfigured, setDingtalkConfigured] = useState(true)
  const [dingtalkLastSyncedAt, setDingtalkLastSyncedAt] = useState<string | null>(null)
  const [dingtalkSearchQuery, setDingtalkSearchQuery] = useState('')
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

  // Fetch DingTalk docs
  const fetchDingtalkDocs = useCallback(async () => {
    setDingtalkLoading(true)
    setDingtalkError(null)
    try {
      const [tree, status] = await Promise.all([
        dingtalkDocApi.getDocs(),
        dingtalkDocApi.getSyncStatus(),
      ])
      setDingtalkNodes(tree.nodes)
      setDingtalkConfigured(status.is_configured)
      setDingtalkLastSyncedAt(status.last_synced_at)
    } catch {
      setDingtalkError(t('chat:dingtalkDocs.loadFailed'))
    } finally {
      setDingtalkLoading(false)
    }
  }, [t])

  const handleDingtalkSync = useCallback(async () => {
    setDingtalkSyncing(true)
    setDingtalkError(null)
    try {
      await dingtalkDocApi.syncDocs()
      await fetchDingtalkDocs()
    } catch {
      setDingtalkError(t('chat:dingtalkDocs.syncFailed'))
    } finally {
      setDingtalkSyncing(false)
    }
  }, [fetchDingtalkDocs, t])

  const handleTabChange = useCallback(
    (value: string) => {
      setActiveTab(value)
      if (value === 'dingtalk' && !hasFetchedDingtalk) {
        fetchDingtalkDocs()
        setHasFetchedDingtalk(true)
      }
    },
    [fetchDingtalkDocs, hasFetchedDingtalk]
  )

  // Group knowledge bases by category (personal, group, organization)
  // and exclude bound ones and current notebook KB from user list
  const groupedKnowledgeBases = useMemo((): GroupedKnowledgeBases => {
    const boundIds = new Set(boundKnowledgeBases.map(kb => kb.id))
    const filtered = knowledgeBases
      .filter(kb => !boundIds.has(kb.id))
      .filter(kb => excludeKnowledgeBaseId === undefined || kb.id !== excludeKnowledgeBaseId)

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
  }, [knowledgeBases, boundKnowledgeBases, excludeKnowledgeBaseId, organizationNamespace])

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

  // Compute the set of selected DingTalk node IDs
  const selectedDingTalkIds = useMemo(
    () => getDingTalkSelectedIds(selectedContexts),
    [selectedContexts]
  )

  /** Build a DingTalkDocContext from a DingtalkDocNode. */
  const buildDingtalkContext = useCallback(
    (node: DingtalkDocNode): DingTalkDocContext => ({
      id: node.dingtalk_node_id,
      name: node.name,
      type: 'dingtalk_doc',
      doc_url: node.doc_url,
      node_type: node.node_type as 'folder' | 'doc' | 'file',
      dingtalk_node_id: node.dingtalk_node_id,
    }),
    []
  )

  /** Handle DingTalk node toggle: folder selects/deselects all descendants, doc/file toggles individually. */
  const handleDingtalkToggle = useCallback(
    (node: DingtalkDocNode) => {
      if (node.node_type === 'folder') {
        const allIds = collectDescendants(node)
        const allSelected = isNodeFullySelected(node, selectedDingTalkIds)

        if (allSelected) {
          if (onDeselectMultiple) {
            onDeselectMultiple(allIds)
          } else {
            allIds.forEach(id => onDeselect(id))
          }
        } else {
          const toAdd: DingTalkDocContext[] = []
          const addNode = (n: DingtalkDocNode) => {
            if (!selectedDingTalkIds.has(n.dingtalk_node_id)) {
              toAdd.push(buildDingtalkContext(n))
            }
            if (n.children) {
              n.children.forEach(addNode)
            }
          }
          addNode(node)
          if (toAdd.length > 0) {
            if (onSelectMultiple) {
              onSelectMultiple(toAdd)
            } else {
              toAdd.forEach(ctx => onSelect(ctx))
            }
          }
        }
      } else {
        if (selectedDingTalkIds.has(node.dingtalk_node_id)) {
          onDeselect(node.dingtalk_node_id)
        } else {
          onSelect(buildDingtalkContext(node))
        }
      }
    },
    [
      selectedDingTalkIds,
      buildDingtalkContext,
      onSelect,
      onDeselect,
      onSelectMultiple,
      onDeselectMultiple,
    ]
  )

  // Reset search when popover closes
  useEffect(() => {
    if (!open) {
      setSearchValue('')
      setDingtalkSearchQuery('')
      setActiveTab('knowledge')
    }
  }, [open])

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
          {/* Tab list: Knowledge | Table | DingTalk — fixed height, no flex tricks needed */}
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
          </TabsList>

          {/* Knowledge Base Tab */}
          <TabsContent value="knowledge" className="m-0">
            <Command className="border-0 flex flex-col">
              <CommandInput
                placeholder={t('knowledge:search_placeholder')}
                value={searchValue}
                onValueChange={setSearchValue}
                className={cn(
                  'h-9 rounded-none border-b border-border flex-shrink-0',
                  'placeholder:text-text-muted text-sm'
                )}
              />
              <CommandList className="max-h-[300px] overflow-y-auto">
                {loading || organizationNamespaceLoading ? (
                  <div className="py-4 px-3 text-center text-sm text-text-muted">
                    {t('common:actions.loading')}
                  </div>
                ) : knowledgeBaseError ? (
                  <div className="py-4 px-3 text-center">
                    <p className="text-sm text-red-500 mb-2">{knowledgeBaseError}</p>
                    <button
                      onClick={handleKnowledgeBaseRetry}
                      className="text-xs text-primary hover:underline"
                    >
                      {t('common:actions.retry')}
                    </button>
                  </div>
                ) : !hasKnowledgeBases && boundKnowledgeBases.length === 0 ? (
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
                        {hasKnowledgeBases && <CommandSeparator />}
                      </>
                    )}

                    {/* Personal Knowledge Bases */}
                    {groupedKnowledgeBases.personal.length > 0 && (
                      <CommandGroup
                        heading={
                          <div className="flex items-center gap-1.5 text-xs font-medium text-text-muted">
                            <User className="w-3 h-3" />
                            {t('knowledge:document.tabs.personal')}
                          </div>
                        }
                      >
                        {groupedKnowledgeBases.personal.map(kb => (
                          <KnowledgeBaseItem
                            key={kb.id}
                            kb={kb}
                            isSelected={isSelected(kb.id)}
                            onSelect={() => handleSelect(kb)}
                          />
                        ))}
                      </CommandGroup>
                    )}
                    {/* Group Knowledge Bases - grouped by namespace with nested style */}
                    {groupedKnowledgeBases.group.size > 0 && (
                      <>
                        {groupedKnowledgeBases.personal.length > 0 && <CommandSeparator />}
                        <CommandGroup
                          heading={
                            <div className="flex items-center gap-1.5 text-xs font-medium text-text-muted">
                              <Users className="w-3 h-3" />
                              {t('knowledge:document.tabs.group')}
                            </div>
                          }
                        >
                          {Array.from(groupedKnowledgeBases.group.entries()).map(
                            ([namespace, kbs]) => {
                              const groupFullySelected = isGroupFullySelected(kbs)
                              const groupPartiallySelected = isGroupPartiallySelected(kbs)
                              return (
                                <React.Fragment key={namespace}>
                                  {/* Group name as clickable sub-heading */}
                                  <CommandItem
                                    value={`group:${namespace}`}
                                    onSelect={() => handleGroupSelect(namespace, kbs)}
                                    className={cn(
                                      'group cursor-pointer select-none',
                                      'px-3 py-1.5 text-xs font-medium text-text-secondary',
                                      'bg-muted/50 rounded-md mx-1 my-1',
                                      'data-[selected=true]:bg-primary/10 data-[selected=true]:text-primary',
                                      'aria-selected:bg-hover',
                                      '!flex !flex-row !items-center !justify-between !gap-2'
                                    )}
                                  >
                                    <span>{namespace}</span>
                                    <Check
                                      className={cn(
                                        'h-3.5 w-3.5 shrink-0',
                                        groupFullySelected
                                          ? 'opacity-100 text-primary'
                                          : groupPartiallySelected
                                            ? 'opacity-100 text-primary/50'
                                            : 'opacity-0'
                                      )}
                                    />
                                  </CommandItem>
                                  {/* Knowledge bases under this group */}
                                  {kbs.map(kb => (
                                    <KnowledgeBaseItem
                                      key={kb.id}
                                      kb={kb}
                                      isSelected={isSelected(kb.id)}
                                      onSelect={() => handleSelect(kb)}
                                    />
                                  ))}
                                </React.Fragment>
                              )
                            }
                          )}
                        </CommandGroup>
                      </>
                    )}

                    {/* Organization Knowledge Bases */}
                    {groupedKnowledgeBases.organization.length > 0 && (
                      <>
                        {(groupedKnowledgeBases.personal.length > 0 ||
                          groupedKnowledgeBases.group.size > 0) && <CommandSeparator />}
                        <CommandGroup
                          heading={
                            <div className="flex items-center gap-1.5 text-xs font-medium text-text-muted">
                              <Building2 className="w-3 h-3" />
                              {t('knowledge:document.tabs.organization')}
                            </div>
                          }
                        >
                          {groupedKnowledgeBases.organization.map(kb => (
                            <KnowledgeBaseItem
                              key={kb.id}
                              kb={kb}
                              isSelected={isSelected(kb.id)}
                              onSelect={() => handleSelect(kb)}
                            />
                          ))}
                        </CommandGroup>
                      </>
                    )}
                  </>
                )}
              </CommandList>
            </Command>
          </TabsContent>

          {/* Table Tab */}
          <TabsContent value="table" className="m-0">
            <Command className="border-0 flex flex-col">
              <CommandInput
                placeholder={t('knowledge:search_placeholder')}
                value={searchValue}
                onValueChange={setSearchValue}
                className={cn(
                  'h-9 rounded-none border-b border-border flex-shrink-0',
                  'placeholder:text-text-muted text-sm'
                )}
              />
              <CommandList className="max-h-[300px] overflow-y-auto">
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

          {/* DingTalk Docs Tab */}
          <TabsContent value="dingtalk" className="m-0">
            {/* Search input */}
            <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
              <Search className="w-3.5 h-3.5 text-text-muted flex-shrink-0" />
              <input
                type="text"
                value={dingtalkSearchQuery}
                onChange={event => setDingtalkSearchQuery(event.target.value)}
                placeholder={t('chat:dingtalkDocs.searchPlaceholder')}
                className="flex-1 text-sm bg-transparent outline-none text-text-primary placeholder:text-text-muted"
                data-testid="context-selector-dingtalk-search-input"
              />
            </div>

            {/* Sync toolbar */}
            <div className="flex items-center justify-between px-3 h-9 border-b border-border">
              <span className="text-xs text-text-muted">
                {dingtalkConfigured && dingtalkLastSyncedAt
                  ? t('chat:dingtalkDocs.lastSynced', {
                      time: new Date(dingtalkLastSyncedAt).toLocaleString(),
                    })
                  : null}
              </span>
              {dingtalkConfigured && (
                <button
                  type="button"
                  onClick={handleDingtalkSync}
                  disabled={dingtalkSyncing}
                  className={cn(
                    'flex items-center gap-1 text-xs text-primary hover:text-primary/80 transition-colors',
                    dingtalkSyncing && 'opacity-50 cursor-not-allowed'
                  )}
                  data-testid="context-selector-dingtalk-sync"
                >
                  <RefreshCw className={cn('w-3 h-3', dingtalkSyncing && 'animate-spin')} />
                  {dingtalkSyncing ? t('chat:dingtalkDocs.syncing') : t('chat:dingtalkDocs.sync')}
                </button>
              )}
            </div>

            {/* DingTalk content */}
            <div className="max-h-[300px] overflow-y-auto">
              {dingtalkLoading ? (
                <div className="py-6 px-4 text-center text-sm text-text-muted">
                  {t('common:actions.loading')}
                </div>
              ) : !dingtalkConfigured ? (
                <div className="py-6 px-4 text-center space-y-3">
                  <p className="text-sm text-text-muted">{t('chat:dingtalkDocs.notConfigured')}</p>
                  <Link
                    href="/settings/integrations"
                    className="inline-flex items-center gap-1.5 text-sm text-primary hover:text-primary/80 font-medium transition-colors"
                  >
                    {t('chat:dingtalkDocs.goToConfigure')}
                  </Link>
                </div>
              ) : dingtalkError ? (
                <div className="py-6 px-4 text-center space-y-2">
                  <p className="text-sm text-red-500">{dingtalkError}</p>
                  <button
                    onClick={fetchDingtalkDocs}
                    className="text-xs text-primary hover:underline"
                  >
                    {t('common:actions.retry')}
                  </button>
                </div>
              ) : dingtalkNodes.length === 0 ? (
                <div className="py-6 px-4 text-center space-y-3">
                  <p className="text-sm text-text-muted">{t('chat:dingtalkDocs.empty')}</p>
                  <button
                    type="button"
                    onClick={handleDingtalkSync}
                    disabled={dingtalkSyncing}
                    className="inline-flex items-center gap-1.5 text-sm text-primary hover:text-primary/80 font-medium transition-colors disabled:opacity-50"
                  >
                    <RefreshCw className={cn('w-3.5 h-3.5', dingtalkSyncing && 'animate-spin')} />
                    {dingtalkSyncing
                      ? t('chat:dingtalkDocs.syncing')
                      : t('chat:dingtalkDocs.syncNow')}
                  </button>
                </div>
              ) : (
                <div className="py-1 px-1">
                  {dingtalkNodes.map(node => (
                    <DingtalkContextTreeNode
                      key={node.dingtalk_node_id}
                      node={node}
                      level={0}
                      selectedIds={selectedDingTalkIds}
                      onToggle={handleDingtalkToggle}
                      searchQuery={dingtalkSearchQuery}
                    />
                  ))}
                </div>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </PopoverContent>
    </Popover>
  )
}
