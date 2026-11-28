// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useState, useMemo, useCallback } from 'react'
import { X } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Drawer, DrawerContent, DrawerTitle, DrawerTrigger } from '@/components/ui/drawer'
import { Button } from '@/components/ui/button'
import { knowledgeBaseApi } from '@/apis/knowledge-base'
import { taskKnowledgeBaseApi } from '@/apis/task-knowledge-base'
import type { KnowledgeBase } from '@/types/api'
import type { AllGroupedKnowledgeResponse, KnowledgeBaseWithGroupInfo } from '@/types/knowledge'
import type { BoundKnowledgeBaseDetail } from '@/types/task-knowledge-base'
import type { ContextItem } from '@/types/context'
import { useExternalKnowledgeSources } from '@/features/knowledge/externalKnowledgeSourceRegistry'
import { useUser } from '@/features/common/UserContext'
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
 * Currently supports: knowledge_base
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
  const { t, i18n } = useTranslation()
  const { user } = useUser()
  const [groupedSnapshot, setGroupedSnapshot] = useState<{
    userId: number | undefined
    data: AllGroupedKnowledgeResponse
  } | null>(null)
  const [needsGroupNames, setNeedsGroupNames] = useState(false)
  const [groupRequest, setGroupRequest] = useState(0)
  const accountId = user?.id
  const allGroupedKnowledge =
    groupedSnapshot?.userId === accountId ? groupedSnapshot?.data : undefined
  const [boundKnowledgeBases, setBoundKnowledgeBases] = useState<BoundKnowledgeBaseDetail[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searchValue, setSearchValue] = useState('')
  const knowledgeBaseError = error
  const isMobile = useIsMobile()

  useEffect(() => {
    if (!open || (accountId !== undefined && !needsGroupNames)) return
    let cancelled = false
    setLoading(true)
    setError(null)
    knowledgeBaseApi
      .getAllGrouped()
      .then(data => {
        if (!cancelled) setGroupedSnapshot({ userId: accountId, data })
      })
      .catch(() => {
        if (!cancelled) setError(t('knowledge:fetch_error'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [accountId, groupRequest, needsGroupNames, open, t])

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

  // Fetch bound knowledge bases when taskId or isGroupChat changes
  useEffect(() => {
    if (open) void fetchBoundKnowledgeBases()
  }, [open, fetchBoundKnowledgeBases])

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

  const handleKnowledgeBaseRetry = () => {
    setGroupRequest(value => value + 1)
  }

  const externalSources = useExternalKnowledgeSources()

  // Reset search when popover closes
  useEffect(() => {
    if (!open) {
      setSearchValue('')
      setNeedsGroupNames(false)
    }
  }, [open])

  let libraries = 0
  let folders = 0
  let documents = 0
  for (const context of new Map(selectedContexts.map(item => [item.id, item])).values()) {
    if (context.type === 'knowledge_base') {
      if (context.scope_restricted) {
        folders += new Set(context.folder_ids).size
        documents += new Set(context.document_ids).size
      } else {
        libraries += 1
      }
    } else if (context.type === 'dingtalk_doc') {
      if (context.source === 'wikispace' && context.dingtalk_node_id === context.workspace_id) {
        libraries += 1
      } else if (context.node_type === 'folder') {
        folders += 1
      } else {
        documents += 1
      }
    } else if (context.type === 'external_knowledge') {
      if (context.ref.target_type === 'folder') folders += 1
      else if (context.ref.target_type === 'document') documents += 1
      else libraries += 1
    }
  }
  const selectionParts = [
    libraries ? t('knowledge:picker.selectedLibraries', { count: libraries }) : '',
    folders ? t('knowledge:picker.selectedFolders', { count: folders }) : '',
    documents ? t('knowledge:picker.selectedDocuments', { count: documents }) : '',
  ].filter(Boolean)

  const selectorContent = (
    <div className="flex min-h-0 flex-1 flex-col">
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

      <div className="flex h-full min-h-0 flex-1 flex-col">
        <KnowledgeSourcePicker
          groupedKnowledgeBases={groupedKnowledgeBases}
          catalogAccountId={open ? user?.id : undefined}
          onOpenGroupSources={() => setNeedsGroupNames(true)}
          excludeKnowledgeBaseId={excludeKnowledgeBaseId}
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

      <div className="flex min-h-16 shrink-0 items-center justify-between border-t border-border px-4 lg:hidden">
        <span className="text-sm text-text-primary" data-testid="context-selector-selected-count">
          {selectionParts.length
            ? new Intl.ListFormat(i18n?.language, { type: 'conjunction' }).format(selectionParts)
            : t('knowledge:picker.selectedCount', { count: 0 })}
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
    </div>
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
