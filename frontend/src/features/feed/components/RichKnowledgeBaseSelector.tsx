'use client'

// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * RichKnowledgeBaseSelector - A rich knowledge base selector with Popover dropdown
 * Similar to RichSkillSelector for consistent UI
 * Groups knowledge bases by scope: personal, group, organization
 */

import React, { useMemo, useState, useRef, useEffect } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { useOrganizationNamespace } from '@/hooks/useOrganizationNamespace'
import { Database, Plus, Loader2, User, Users, Building2 } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { knowledgeBaseApi } from '@/apis/knowledge-base'
import type { KnowledgeBase } from '@/types/api'
import type { SubscriptionKnowledgeBaseRef } from '@/types/subscription'
import { formatDocumentCount } from '@/lib/i18n-helpers'
import { getKnowledgeBaseGroup, type KnowledgeBaseGroup } from '@/utils/knowledge-base-grouping'

interface RichKnowledgeBaseSelectorProps {
  /** Currently selected knowledge base refs */
  selectedKnowledgeBases: SubscriptionKnowledgeBaseRef[]
  /** Callback when a knowledge base is selected */
  onSelectKnowledgeBase: (kb: SubscriptionKnowledgeBaseRef) => void
  /** Placeholder text for the trigger */
  placeholder?: string
  /** Whether the selector is disabled */
  disabled?: boolean
}

interface GroupedKnowledgeBases {
  personal: KnowledgeBase[]
  group: KnowledgeBase[]
  organization: KnowledgeBase[]
}

/**
 * RichKnowledgeBaseSelector Component
 *
 * A rich knowledge base selector with detailed information display including:
 * - Knowledge base name
 * - Document count
 * - Description
 * - Grouped by scope (personal, group, organization)
 */
export function RichKnowledgeBaseSelector({
  selectedKnowledgeBases,
  onSelectKnowledgeBase,
  placeholder,
  disabled = false,
}: RichKnowledgeBaseSelectorProps) {
  const { t } = useTranslation('feed')
  const { t: tKnowledge } = useTranslation('knowledge')
  const [open, setOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [triggerWidth, setTriggerWidth] = useState<number>(0)
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const {
    organizationNamespace,
    loading: organizationNamespaceLoading,
    error: organizationNamespaceError,
  } = useOrganizationNamespace({ enabled: open })
  const knowledgeBaseError =
    error || (organizationNamespaceError ? tKnowledge('fetch_error') : null)

  // Measure trigger width when open changes
  useEffect(() => {
    if (open && triggerRef.current) {
      setTriggerWidth(triggerRef.current.offsetWidth)
    }
  }, [open])

  // Fetch knowledge bases when popover opens
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

  // Reset search when popover closes
  useEffect(() => {
    if (!open) {
      setSearchQuery('')
    }
  }, [open])

  // Filter and group knowledge bases
  const groupedKnowledgeBases = useMemo(() => {
    const selectedKeys = new Set(selectedKnowledgeBases.map(kb => `${kb.name}:${kb.namespace}`))

    const filtered = knowledgeBases.filter(kb => {
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

    // Group by scope
    const grouped: GroupedKnowledgeBases = {
      personal: [],
      group: [],
      organization: [],
    }

    filtered.forEach(kb => {
      const group = getKnowledgeBaseGroup(kb.namespace, organizationNamespace)
      grouped[group].push(kb)
    })

    // Sort each group by name
    Object.keys(grouped).forEach(key => {
      grouped[key as KnowledgeBaseGroup].sort((a, b) => a.name.localeCompare(b.name))
    })

    return grouped
  }, [knowledgeBases, organizationNamespace, searchQuery, selectedKnowledgeBases])

  // Check if there are any available knowledge bases
  const hasAvailableKnowledgeBases =
    groupedKnowledgeBases.personal.length > 0 ||
    groupedKnowledgeBases.group.length > 0 ||
    groupedKnowledgeBases.organization.length > 0

  // Handle knowledge base selection
  const handleSelect = (kb: KnowledgeBase) => {
    onSelectKnowledgeBase({
      name: kb.name,
      namespace: kb.namespace || 'default',
    })
    setOpen(false)
    setSearchQuery('')
  }

  // Handle wheel event manually to ensure scrolling works
  const handleWheel = (e: React.WheelEvent) => {
    const list = listRef.current
    if (!list) return

    // Prevent parent scrolling when scrolling within the list
    const isScrollingUp = e.deltaY < 0
    const isScrollingDown = e.deltaY > 0
    const isAtTop = list.scrollTop <= 0
    const isAtBottom = list.scrollTop + list.clientHeight >= list.scrollHeight

    if ((isScrollingUp && isAtTop) || (isScrollingDown && isAtBottom)) {
      // Allow event to propagate to parent when at boundaries
      return
    }

    // Prevent default to stop parent scrolling
    e.stopPropagation()
  }

  // Get group icon
  const getGroupIcon = (group: KnowledgeBaseGroup) => {
    switch (group) {
      case 'personal':
        return <User className="h-3.5 w-3.5" />
      case 'group':
        return <Users className="h-3.5 w-3.5" />
      case 'organization':
        return <Building2 className="h-3.5 w-3.5" />
    }
  }

  // Get group label
  const getGroupLabel = (group: KnowledgeBaseGroup) => {
    switch (group) {
      case 'personal':
        return t('knowledge_base_personal') || '个人知识库'
      case 'group':
        return t('knowledge_base_group') || '群组知识库'
      case 'organization':
        return t('knowledge_base_organization') || '公司知识库'
    }
  }

  // Render a single knowledge base item
  const renderKnowledgeBaseItem = (kb: KnowledgeBase) => {
    const documentCount = kb.document_count || 0
    const documentText = formatDocumentCount(documentCount, tKnowledge)

    return (
      <div
        key={kb.id}
        className="px-4 py-2.5 cursor-pointer hover:bg-muted transition-colors"
        onClick={() => handleSelect(kb)}
        role="button"
        tabIndex={0}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            handleSelect(kb)
          }
        }}
      >
        {/* Header row: Icon + Name + Document Count */}
        <div className="flex flex-col w-full gap-0.5">
          <div className="flex items-center gap-2 flex-wrap">
            <Database className="h-3.5 w-3.5 text-primary flex-shrink-0" />
            <span className="font-medium text-text-primary text-sm">{kb.name}</span>
            <span className="text-xs text-text-muted bg-surface px-1.5 py-0.5 rounded">
              {documentText}
            </span>
          </div>

          {/* Description */}
          {kb.description && (
            <div className="text-xs text-text-secondary line-clamp-1 pl-5">{kb.description}</div>
          )}
        </div>
      </div>
    )
  }

  // Render a group section
  const renderGroupSection = (group: KnowledgeBaseGroup, items: KnowledgeBase[]) => {
    if (items.length === 0) return null

    return (
      <div key={group} className="border-b border-border last:border-b-0">
        {/* Group header */}
        <div className="px-4 py-2 bg-surface/50 flex items-center gap-2 sticky top-0">
          <span className="text-text-muted">{getGroupIcon(group)}</span>
          <span className="text-xs font-medium text-text-secondary">{getGroupLabel(group)}</span>
          <span className="text-xs text-text-muted">({items.length})</span>
        </div>
        {/* Group items */}
        {items.map(kb => renderKnowledgeBaseItem(kb))}
      </div>
    )
  }

  // Render knowledge bases list
  const renderKnowledgeBasesList = () => {
    if (loading || organizationNamespaceLoading) {
      return (
        <div className="py-8 flex items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-text-muted" />
        </div>
      )
    }

    if (knowledgeBaseError) {
      return <div className="py-8 text-center text-sm text-destructive">{knowledgeBaseError}</div>
    }

    if (!hasAvailableKnowledgeBases) {
      return (
        <div className="py-8 text-center text-sm text-text-muted">
          {searchQuery ? t('no_knowledge_bases_match') : t('no_knowledge_bases_available')}
        </div>
      )
    }

    return (
      <>
        {renderGroupSection('personal', groupedKnowledgeBases.personal)}
        {renderGroupSection('group', groupedKnowledgeBases.group)}
        {renderGroupSection('organization', groupedKnowledgeBases.organization)}
      </>
    )
  }

  return (
    <Popover open={open && !disabled} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          className="flex w-full h-9 items-center justify-between rounded-md border border-border/50 bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={disabled}
        >
          <div className="flex items-center gap-2 text-text-muted">
            <Database className="h-4 w-4 text-primary" />
            <span>{placeholder || t('add_knowledge_base')}</span>
          </div>
          <Plus className="h-4 w-4 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className={cn('p-0 border border-border', 'overflow-hidden', 'flex flex-col')}
        style={{ width: triggerWidth > 0 ? triggerWidth : '100%' }}
        align="start"
        side="bottom"
        sideOffset={4}
      >
        {/* Search input */}
        <div className="border-b p-3 shrink-0">
          <Input
            placeholder={tKnowledge('search_placeholder')}
            value={searchQuery}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearchQuery(e.target.value)}
          />
        </div>

        {/* Knowledge bases list - scrollable */}
        <div
          ref={listRef}
          className="max-h-[350px] overflow-y-auto overflow-x-hidden"
          onWheel={handleWheel}
          style={{
            maxHeight: '350px',
            overscrollBehavior: 'contain',
          }}
        >
          {renderKnowledgeBasesList()}
        </div>
      </PopoverContent>
    </Popover>
  )
}
