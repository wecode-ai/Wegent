// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * KnowledgeGroupListPage - Displays knowledge bases in a table format.
 *
 * Shows a table of knowledge bases with search, sort, and create actions.
 * Supports two modes:
 * - Group mode: Shows KBs in a specific group
 * - All mode: Shows all KBs with group info column
 */

'use client'

import { useState, useMemo, useCallback } from 'react'
import {
  ArrowLeft,
  Plus,
  BookOpen,
  Database,
  FolderOpen,
  Star,
  ChevronDown,
  ChevronUp,
  Pencil,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type {
  KnowledgeBase,
  KnowledgeBaseType,
  KnowledgeBaseWithGroupInfo,
  KnowledgeGroupType,
} from '@/types/knowledge'

/** Group info for display */
export interface KbGroupInfo {
  groupId: string
  groupName: string
  groupType: KnowledgeGroupType
}

/** Union type for KB data that can be either KnowledgeBase or KnowledgeBaseWithGroupInfo */
export type KbDataItem = KnowledgeBase | KnowledgeBaseWithGroupInfo

export interface KnowledgeGroupListPageProps {
  /** Group ID (null for "All" mode) */
  groupId: string | null
  /** Group display name */
  groupName: string
  /** Knowledge bases in this group */
  knowledgeBases: KnowledgeBase[]
  /** Knowledge bases with group info (for "All" mode) */
  knowledgeBasesWithGroupInfo?: KnowledgeBaseWithGroupInfo[]
  /** Whether data is loading */
  isLoading: boolean
  /** Go back handler (optional, hidden in "All" mode) */
  onBack?: () => void
  /** Select a knowledge base */
  onSelectKb: (kb: KbDataItem) => void
  /** Create a new knowledge base */
  onCreateKb: (kbType: KnowledgeBaseType) => void
  /** Edit a knowledge base */
  onEditKb?: (kb: KbDataItem) => void
  /** Delete a knowledge base */
  onDeleteKb?: (kb: KbDataItem) => void
  /** Toggle favorite */
  onToggleFavorite?: (kbId: number, isFavorite: boolean) => void
  /** Check if KB is favorite */
  isFavorite?: (kbId: number) => boolean
  /** Get group info for a KB (for "All" mode) */
  getKbGroupInfo?: (kb: KbDataItem) => KbGroupInfo
  /** Whether this is "All" mode */
  isAllMode?: boolean
  /** Filter by group ID (for "All" mode) */
  filterGroupId?: string | null
  /** Set filter group ID (for "All" mode) */
  onFilterGroupChange?: (groupId: string | null) => void
  /** Available groups for filter (for "All" mode) */
  availableGroups?: Array<{ id: string; name: string; displayName: string }>
}

type SortBy = 'name' | 'updated' | 'group'
type SortOrder = 'asc' | 'desc'

/** Format relative time */
function formatRelativeTime(
  dateStr: string | undefined,
  tFunc: ReturnType<typeof useTranslation>['t']
): string {
  if (!dateStr) return '--'

  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMinutes = Math.floor(diffMs / (1000 * 60))
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (diffMinutes < 1) {
    return tFunc('document.sidebar.justNow', '刚刚')
  } else if (diffMinutes < 60) {
    return `${diffMinutes} ${tFunc('document.table.minutesAgo', '分钟前')}`
  } else if (diffHours < 24) {
    // Show time like "12:30"
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  } else if (diffDays === 1) {
    return tFunc('document.sidebar.yesterday', '昨天')
  } else if (diffDays < 7) {
    return `${diffDays} ${tFunc('document.table.daysAgo', '天前')}`
  } else {
    // Show date like "2月02日 16:08"
    return date.toLocaleDateString('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }
}

/** Get icon for KB type */
/** Get icon for KB type */
function KbTypeIcon({ kbType, className }: { kbType?: string; className?: string }) {
  const isClassic = kbType === 'classic'
  if (isClassic) {
    return <Database className={cn('text-text-secondary', className)} />
  }
  return <BookOpen className={cn('text-primary', className)} />
}
export function KnowledgeGroupListPage({
  groupId: _groupId,
  groupName,
  knowledgeBases,
  knowledgeBasesWithGroupInfo,
  isLoading,
  onBack,
  onSelectKb,
  onCreateKb,
  onEditKb,
  onDeleteKb,
  onToggleFavorite,
  isFavorite,
  getKbGroupInfo,
  isAllMode = false,
  filterGroupId,
  onFilterGroupChange: _onFilterGroupChange,
  availableGroups: _availableGroups,
}: KnowledgeGroupListPageProps) {
  const { t } = useTranslation('knowledge')
  const [sortBy, setSortBy] = useState<SortBy>('updated')
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc')

  // Determine which data source to use
  const dataSource = useMemo(() => {
    if (isAllMode && knowledgeBasesWithGroupInfo) {
      return knowledgeBasesWithGroupInfo
    }
    return knowledgeBases
  }, [isAllMode, knowledgeBasesWithGroupInfo, knowledgeBases])

  // Filter and sort knowledge bases
  const filteredKbs = useMemo(() => {
    let result = [...dataSource]

    // Filter by group (for "All" mode)
    if (isAllMode && filterGroupId) {
      result = result.filter(kb => {
        if (getKbGroupInfo) {
          const groupInfo = getKbGroupInfo(kb)
          return groupInfo.groupId === filterGroupId
        }
        return true
      })
    }

    // Sort
    result.sort((a, b) => {
      let comparison = 0
      switch (sortBy) {
        case 'name':
          comparison = a.name.localeCompare(b.name)
          break
        case 'updated':
          comparison = new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime()
          break
        case 'group':
          if (getKbGroupInfo) {
            const groupA = getKbGroupInfo(a).groupName
            const groupB = getKbGroupInfo(b).groupName
            comparison = groupA.localeCompare(groupB)
          }
          break
        default:
          comparison = 0
      }
      return sortOrder === 'asc' ? comparison : -comparison
    })

    return result
  }, [dataSource, sortBy, sortOrder, isAllMode, filterGroupId, getKbGroupInfo])

  const handleToggleFavorite = useCallback(
    (e: React.MouseEvent, kb: KbDataItem) => {
      e.stopPropagation()
      if (onToggleFavorite && isFavorite) {
        onToggleFavorite(kb.id, !isFavorite(kb.id))
      }
    },
    [onToggleFavorite, isFavorite]
  )

  const handleSort = useCallback(
    (column: SortBy) => {
      if (sortBy === column) {
        setSortOrder(prev => (prev === 'asc' ? 'desc' : 'asc'))
      } else {
        setSortBy(column)
        setSortOrder('desc')
      }
    },
    [sortBy]
  )

  const SortIcon = ({ column }: { column: SortBy }) => {
    if (sortBy !== column) return null
    return sortOrder === 'asc' ? (
      <ChevronUp className="w-3.5 h-3.5 ml-1" />
    ) : (
      <ChevronDown className="w-3.5 h-3.5 ml-1" />
    )
  }

  return (
    <div
      className="flex flex-col h-full overflow-hidden pl-4"
      data-testid="knowledge-group-list-page"
    >
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4 border-b border-border ml-2">
        {/* Back button - only show in group mode */}
        {!isAllMode && onBack && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onBack}
            className="flex-shrink-0"
            data-testid="back-button"
          >
            <ArrowLeft className="w-4 h-4" />
          </Button>
        )}
        <h2 className="text-lg font-semibold flex-1 truncate">
          {isAllMode ? t('document.allKnowledgeBases', '全部知识库') : groupName}
        </h2>
        <Button
          variant="primary"
          size="sm"
          onClick={() => onCreateKb('notebook')}
          data-testid="create-kb-button"
        >
          <Plus className="w-4 h-4 mr-1" />
          {t('document.knowledgeBase.create', '新建知识库')}
        </Button>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden min-w-0">
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Spinner />
          </div>
        ) : filteredKbs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <FolderOpen className="w-12 h-12 text-text-muted mb-4" />
            <h3 className="text-lg font-medium text-text-primary mb-2">
              {t('document.knowledgeBase.empty', '暂无知识库')}
            </h3>
            <p className="text-sm text-text-muted mb-4">
              {t('document.knowledgeBase.createDesc', '点击上方按钮创建第一个知识库')}
            </p>
          </div>
        ) : (
          <table className="w-full table-fixed min-w-0">
            <thead className="sticky top-0 bg-surface border-b border-border">
              <tr className="text-left text-sm text-text-secondary">
                <th className="px-6 py-3 font-medium w-[40%]">
                  <button
                    className="flex items-center hover:text-text-primary transition-colors"
                    onClick={() => handleSort('name')}
                  >
                    {t('document.table.name', '名称')}
                    <SortIcon column="name" />
                  </button>
                </th>
                {isAllMode && (
                  <th className="px-6 py-3 font-medium w-[25%]">
                    <button
                      className="flex items-center hover:text-text-primary transition-colors"
                      onClick={() => handleSort('group')}
                    >
                      {t('document.table.group', '归属小组')}
                      <SortIcon column="group" />
                    </button>
                  </th>
                )}
                <th className="px-6 py-3 font-medium w-[20%]">
                  <button
                    className="flex items-center hover:text-text-primary transition-colors"
                    onClick={() => handleSort('updated')}
                  >
                    {t('document.table.lastAccess', '最近访问')}
                    <SortIcon column="updated" />
                  </button>
                </th>
                <th className="px-6 py-3 font-medium w-[15%] text-right">
                  {t('document.table.actions', '操作')}
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredKbs.map(kb => (
                <KnowledgeBaseRow
                  key={kb.id}
                  kb={kb}
                  onClick={() => onSelectKb(kb)}
                  onEdit={onEditKb ? () => onEditKb(kb) : undefined}
                  onDelete={onDeleteKb ? () => onDeleteKb(kb) : undefined}
                  onToggleFavorite={onToggleFavorite ? e => handleToggleFavorite(e, kb) : undefined}
                  isFavorite={isFavorite?.(kb.id)}
                  showGroupInfo={isAllMode}
                  groupInfo={getKbGroupInfo?.(kb)}
                  tFunc={t}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// Knowledge base table row component
interface KnowledgeBaseRowProps {
  kb: KbDataItem
  onClick: () => void
  onEdit?: () => void
  onDelete?: () => void
  onToggleFavorite?: (e: React.MouseEvent) => void
  isFavorite?: boolean
  showGroupInfo?: boolean
  groupInfo?: KbGroupInfo
  tFunc: ReturnType<typeof useTranslation>['t']
}

function KnowledgeBaseRow({
  kb,
  onClick,
  onEdit,
  onDelete,
  onToggleFavorite: _onToggleFavorite,
  isFavorite,
  showGroupInfo,
  groupInfo,
  tFunc,
}: KnowledgeBaseRowProps) {
  return (
    <tr
      className="border-b border-border hover:bg-surface-hover cursor-pointer transition-colors"
      onClick={onClick}
      data-testid={`kb-row-${kb.id}`}
    >
      {/* Name column */}
      <td className="px-6 py-3 overflow-hidden">
        <div className="flex items-center gap-3 min-w-0">
          <KbTypeIcon kbType={kb.kb_type} className="w-5 h-5 flex-shrink-0" />
          <span className="font-medium text-text-primary truncate">{kb.name}</span>
          {isFavorite && <Star className="w-4 h-4 text-yellow-500 fill-yellow-500 flex-shrink-0" />}
        </div>
      </td>

      {/* Group column - only in "All" mode */}
      {showGroupInfo && (
        <td className="px-6 py-3 text-text-secondary overflow-hidden">
          <span className="truncate block">{groupInfo ? groupInfo.groupName : '--'}</span>
        </td>
      )}

      {/* Last access column */}
      <td className="px-6 py-3 text-text-secondary whitespace-nowrap">
        {formatRelativeTime(kb.updated_at, tFunc)}
      </td>

      {/* Actions column - Edit and Delete only */}
      <td className="px-6 py-3">
        <div className="flex items-center justify-end gap-1">
          {onEdit && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={e => {
                e.stopPropagation()
                onEdit()
              }}
              title={tFunc('document.table.edit', '编辑')}
              data-testid={`edit-kb-${kb.id}`}
            >
              <Pencil className="w-4 h-4 text-text-muted" />
            </Button>
          )}
          {onDelete && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={e => {
                e.stopPropagation()
                onDelete()
              }}
              title={tFunc('document.table.delete', '删除')}
              data-testid={`delete-kb-${kb.id}`}
            >
              <Trash2 className="w-4 h-4 text-text-muted hover:text-error" />
            </Button>
          )}
        </div>
      </td>
    </tr>
  )
}

export default KnowledgeGroupListPage
