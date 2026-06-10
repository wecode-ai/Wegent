// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useState, useMemo, useCallback } from 'react'
import { Check, Database, Table2, MessageSquareText } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
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
import type { BoundKnowledgeBaseDetail } from '@/types/task-knowledge-base'
import type { ContextItem, TableContext } from '@/types/context'
import { useIsMobile, useMediaQuery } from '@/features/layout/hooks/useMediaQuery'
import { useTranslation } from '@/hooks/useTranslation'
import { useOrganizationNamespace } from '@/hooks/useOrganizationNamespace'
import { cn } from '@/lib/utils'
import { getDingTalkSelectedIds, DingTalkDocContextSelector } from './DingTalkDocContextSelector'
import { KnowledgeContextSelector } from './knowledge-context/KnowledgeContextSelector'

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

const DESKTOP_PANEL_TARGET_HEIGHT = 430
const DESKTOP_PANEL_SIDE_OFFSET = 4
const DESKTOP_PANEL_VIEWPORT_PADDING = 8
const DESKTOP_PANEL_DIALOG_THRESHOLD = 280
type DesktopPanelSide = 'top' | 'bottom'

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
  const isMobile = useIsMobile()
  const isShortViewport = useMediaQuery('(max-height: 559px)')
  const triggerRef = React.useRef<HTMLButtonElement | null>(null)
  const desktopPanelSideRef = React.useRef<DesktopPanelSide>('top')
  const [desktopPanelHeight, setDesktopPanelHeight] = useState(DESKTOP_PANEL_TARGET_HEIGHT)
  const [desktopPanelSide, setDesktopPanelSide] = useState<DesktopPanelSide>('top')
  const [useMeasuredDialogLayout, setUseMeasuredDialogLayout] = useState(false)
  const useDialogLayout = isMobile || isShortViewport || useMeasuredDialogLayout
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([])
  const [boundKnowledgeBases, setBoundKnowledgeBases] = useState<BoundKnowledgeBaseDetail[]>([])
  const [tables, setTables] = useState<TableDocument[]>([])
  const [loading, setLoading] = useState(false)
  const [tableLoading, setTableLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tableError, setTableError] = useState<string | null>(null)
  const [searchValue, setSearchValue] = useState('')
  const [activeTab, setActiveTab] = useState('knowledge')
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

  const handleTabChange = useCallback((value: string) => {
    setActiveTab(value)
  }, [])

  // Check if a context item is selected
  const isSelected = (id: number | string) => {
    return selectedContexts.some(ctx => ctx.id === id)
  }

  const handleKnowledgeBaseRetry = () => {
    reloadOrganizationNamespace()
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
      setActiveTab('knowledge')
      setUseMeasuredDialogLayout(false)
      setDesktopPanelSide('top')
      desktopPanelSideRef.current = 'top'
    }
  }, [open])

  const updateDesktopPanelLayout = useCallback(
    (lockSide: boolean) => {
      if (typeof window === 'undefined' || isMobile || isShortViewport) return

      const triggerRect = triggerRef.current?.getBoundingClientRect()
      if (!triggerRect) {
        setUseMeasuredDialogLayout(false)
        setDesktopPanelSide('top')
        desktopPanelSideRef.current = 'top'
        setDesktopPanelHeight(DESKTOP_PANEL_TARGET_HEIGHT)
        return
      }

      const availableTop = Math.floor(
        triggerRect.top - DESKTOP_PANEL_SIDE_OFFSET - DESKTOP_PANEL_VIEWPORT_PADDING
      )
      const availableBottom = Math.floor(
        window.innerHeight -
          triggerRect.bottom -
          DESKTOP_PANEL_SIDE_OFFSET -
          DESKTOP_PANEL_VIEWPORT_PADDING
      )
      const maxAvailableHeight = Math.max(availableTop, availableBottom)

      if (maxAvailableHeight < DESKTOP_PANEL_DIALOG_THRESHOLD) {
        setUseMeasuredDialogLayout(true)
        return
      }

      const nextSide = lockSide
        ? desktopPanelSideRef.current
        : availableTop >= DESKTOP_PANEL_DIALOG_THRESHOLD ||
            (availableTop >= availableBottom && availableBottom < DESKTOP_PANEL_TARGET_HEIGHT)
          ? 'top'
          : 'bottom'
      const availableHeight = nextSide === 'top' ? availableTop : availableBottom

      if (availableHeight < DESKTOP_PANEL_DIALOG_THRESHOLD) {
        setUseMeasuredDialogLayout(true)
        return
      }

      setUseMeasuredDialogLayout(false)
      setDesktopPanelSide(nextSide)
      desktopPanelSideRef.current = nextSide
      setDesktopPanelHeight(Math.min(DESKTOP_PANEL_TARGET_HEIGHT, availableHeight))
    },
    [isMobile, isShortViewport]
  )

  React.useLayoutEffect(() => {
    if (!open || isMobile || isShortViewport) return

    updateDesktopPanelLayout(false)
    const updateLockedDesktopPanelLayout = () => updateDesktopPanelLayout(true)

    window.addEventListener('resize', updateLockedDesktopPanelLayout)
    window.addEventListener('scroll', updateLockedDesktopPanelLayout, true)

    return () => {
      window.removeEventListener('resize', updateLockedDesktopPanelLayout)
      window.removeEventListener('scroll', updateLockedDesktopPanelLayout, true)
    }
  }, [isMobile, isShortViewport, open, updateDesktopPanelLayout])

  const panel = (
    <Tabs
      value={activeTab}
      onValueChange={handleTabChange}
      className="flex h-full min-h-0 flex-col"
    >
      {/* Tab list: Knowledge | Table | DingTalk — fixed height, no flex tricks needed */}
      <TabsList
        className={cn(
          'w-full rounded-none border-b border-border bg-transparent h-9 p-0 flex-shrink-0',
          useDialogLayout && 'pr-10'
        )}
      >
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
      <TabsContent value="knowledge" className="m-0 min-h-0 flex-1 overflow-hidden">
        <KnowledgeContextSelector
          knowledgeBases={knowledgeBases}
          boundKnowledgeBases={boundKnowledgeBases}
          selectedContexts={selectedContexts}
          onSelect={onSelect}
          onDeselect={onDeselect}
          onOpenChange={onOpenChange}
          excludeKnowledgeBaseId={excludeKnowledgeBaseId}
          organizationNamespace={organizationNamespace}
          isLoading={loading || organizationNamespaceLoading}
          error={knowledgeBaseError}
          onRetry={handleKnowledgeBaseRetry}
        />
      </TabsContent>

      {/* Table Tab */}
      <TabsContent value="table" className="m-0 min-h-0 flex-1 overflow-hidden">
        <Command className="flex h-full min-h-0 flex-col border-0">
          <CommandInput
            placeholder={t('knowledge:search_placeholder')}
            value={searchValue}
            onValueChange={setSearchValue}
            className={cn(
              'h-9 shrink-0 rounded-none border-b border-border',
              'placeholder:text-text-muted text-sm'
            )}
          />
          <CommandList className="min-h-0 flex-1 max-h-none overflow-y-auto">
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
              <div className="flex h-full flex-col items-center justify-center px-4 py-6 text-center">
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

      {/* DingTalk Docs Tab — delegates rendering to the shared DingTalkDocContextSelector */}
      <TabsContent value="dingtalk" className="m-0 min-h-0 flex-1 overflow-hidden">
        {activeTab === 'dingtalk' && (
          <div className="flex h-full min-h-0 overflow-hidden">
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
            />
          </div>
        )}
      </TabsContent>
    </Tabs>
  )

  if (useDialogLayout) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogTrigger asChild ref={triggerRef}>
          {children}
        </DialogTrigger>
        <DialogContent
          className={cn(
            'h-[85dvh] w-[calc(100vw-16px)] max-w-[620px] p-0 overflow-hidden gap-0',
            isMobile &&
              'left-1/2 top-auto bottom-0 max-w-none translate-x-[-50%] translate-y-0 rounded-t-xl rounded-b-none'
          )}
        >
          <DialogTitle className="sr-only">{t('knowledge:title')}</DialogTitle>
          {panel}
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild ref={triggerRef}>
        {children}
      </PopoverTrigger>
      <PopoverContent
        className={cn(
          'p-0 w-[min(620px,calc(100vw-16px))] border border-border bg-base',
          'shadow-xl rounded-xl overflow-hidden',
          'flex flex-col'
        )}
        style={{ height: desktopPanelHeight }}
        align="start"
        side={desktopPanelSide}
        sideOffset={4}
        avoidCollisions={false}
      >
        {panel}
      </PopoverContent>
    </Popover>
  )
}
